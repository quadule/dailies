import { describe, expect, it, vi } from "vitest";
import { type Cut, type CutLine, planCut } from "../../cut.js";
import { previewModel } from "./preview.js";
import {
  type AttachedTake,
  findLine,
  levelOf,
  type MediaRecorderClass,
  MIME_TYPES,
  MicCapture,
  meterIntervalMs,
  meterLevel,
  micMessage,
  micProblem,
  type NarrationHooks,
  NarrationRecorder,
  nextPhase,
  pickMimeType,
  placeTake,
  type RecordTarget,
  recordStart,
} from "./recorder.js";

// ----- fakes: a microphone stream and a MediaRecorder -----

interface FakeTrack {
  readyState: "live" | "ended";
  stop(): void;
}

function fakeStream(): MediaStream & { tracks: FakeTrack[] } {
  const track: FakeTrack = {
    readyState: "live",
    stop() {
      track.readyState = "ended";
    },
  };
  const tracks = [track];
  return {
    tracks,
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream & { tracks: FakeTrack[] };
}

function dataEvent(data: Blob): Event {
  return Object.assign(new Event("dataavailable"), { data });
}

// A MediaRecorder that "records" one chunk per stop, of the type it was
// asked for. Every instance is kept for the test to look at.
function fakeRecorderClass(supported: readonly string[] = MIME_TYPES) {
  const made: FakeRecorder[] = [];
  class FakeRecorder extends EventTarget {
    static isTypeSupported(type: string): boolean {
      return supported.includes(type);
    }
    readonly mimeType: string;
    readonly options: MediaRecorderOptions | undefined;
    state: "inactive" | "recording" | "paused" = "inactive";
    readonly stream: MediaStream;

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.stream = stream;
      this.options = options;
      this.mimeType = options?.mimeType ?? "audio/webm";
      made.push(this);
    }

    start(): void {
      this.state = "recording";
      queueMicrotask(() => this.dispatchEvent(new Event("start")));
    }

    stop(): void {
      this.state = "inactive";
      queueMicrotask(() => {
        this.dispatchEvent(
          dataEvent(new Blob(["voice"], { type: this.mimeType }))
        );
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  return {
    Recorder: FakeRecorder as unknown as MediaRecorderClass,
    made,
  };
}

function seed(): Cut {
  return {
    version: 1,
    video: "page.webm",
    voice: {},
    steps: [],
    cuts: [{ start: 2, end: 4 }],
    holds: [],
    speedups: [],
    captions: [],
    narration: [{ at: 1, text: "hello" }],
  };
}

// ----- pure helpers -----

describe("pickMimeType", () => {
  it("takes the first supported type in order", () => {
    expect(pickMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/webm" || t === "audio/mp4")).toBe(
      "audio/webm"
    );
    expect(pickMimeType((t) => t.startsWith("audio/ogg"))).toBe(
      "audio/ogg;codecs=opus"
    );
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });

  it("leaves the browser's default when nothing fits or it can't ask", () => {
    expect(pickMimeType(() => false)).toBeUndefined();
    expect(pickMimeType(undefined)).toBeUndefined();
    expect(
      pickMimeType(() => {
        throw new Error("no");
      })
    ).toBeUndefined();
  });
});

describe("micProblem", () => {
  it("reads getUserMedia's error names", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    expect(micProblem(named("NotAllowedError"))).toBe("denied");
    expect(micProblem(named("SecurityError"))).toBe("denied");
    expect(micProblem(named("NotFoundError"))).toBe("missing");
    expect(micProblem(named("NotReadableError"))).toBe("busy");
    expect(micProblem(named("NotSupportedError"))).toBe("unsupported");
    expect(micProblem(new Error("boom"))).toBe("failed");
    expect(micProblem("boom")).toBe("failed");
  });

  it("says what happened", () => {
    expect(micMessage("denied")).toMatch(/blocked/);
    expect(micMessage("missing")).toMatch(/No microphone/);
    expect(micMessage("failed", "it broke")).toMatch(/it broke/);
  });
});

describe("the level meter", () => {
  it("maps loudness onto 0..1 in decibels", () => {
    expect(levelOf([])).toBe(0);
    expect(levelOf(new Float32Array(64))).toBe(0);
    expect(levelOf([1, -1, 1, -1])).toBe(1);
    // -20 dBFS sits two thirds of the way up a 60 dB meter.
    expect(levelOf([0.1, -0.1, 0.1, -0.1])).toBeCloseTo(2 / 3, 5);
    const quiet = levelOf([0.01, -0.01]);
    const loud = levelOf([0.5, -0.5]);
    expect(quiet).toBeLessThan(loud);
  });

  it("rises at once and falls gently", () => {
    expect(meterLevel(0.2, 0.8, 0.016)).toBe(0.8);
    expect(meterLevel(0.8, 0, 0.1)).toBeCloseTo(0.65, 5);
    expect(meterLevel(0.8, 0.7, 1)).toBe(0.7);
  });

  it("slows down, without stopping, for reduced motion", () => {
    expect(meterIntervalMs(false)).toBe(0);
    expect(meterIntervalMs(true)).toBeGreaterThan(0);
  });
});

describe("nextPhase", () => {
  it("runs idle → requesting → recording → uploading → idle", () => {
    expect(nextPhase("idle", "start")).toBe("requesting");
    expect(nextPhase("requesting", "granted")).toBe("recording");
    expect(nextPhase("recording", "stop")).toBe("uploading");
    expect(nextPhase("uploading", "uploaded")).toBe("idle");
  });

  it("goes back to idle on a refusal, a cancel or a failure", () => {
    expect(nextPhase("requesting", "refused")).toBe("idle");
    expect(nextPhase("requesting", "cancel")).toBe("idle");
    expect(nextPhase("recording", "cancel")).toBe("idle");
    expect(nextPhase("uploading", "failed")).toBe("idle");
  });

  it("refuses what can't happen", () => {
    expect(nextPhase("idle", "stop")).toBeUndefined();
    expect(nextPhase("recording", "start")).toBeUndefined();
    expect(nextPhase("uploading", "cancel")).toBeUndefined();
  });
});

describe("where a take lands", () => {
  function lines(): Cut {
    return {
      ...seed(),
      narration: [
        { at: 1, text: "A" },
        { at: 5, text: "B", audio: "recordings/b-old.webm" },
        { at: 8, text: "C", audio: "recordings/c.webm" },
      ],
    };
  }

  it("finds a line by itself, wherever it moved", () => {
    const cut = lines();
    const b = cut.narration[1] as CutLine;
    expect(findLine(cut.narration, b)).toBe(1);
    cut.narration.splice(0, 1);
    expect(findLine(cut.narration, b)).toBe(0);
    b.text = "B, edited while recording";
    expect(findLine(cut.narration, b)).toBe(0);
  });

  it("finds a line an undo rebuilt from a snapshot by what it says", () => {
    const cut = lines();
    const b = cut.narration[1] as CutLine;
    const rebuilt = JSON.parse(JSON.stringify(cut)) as Cut;
    expect(findLine(rebuilt.narration, b)).toBe(1);
  });

  it("doesn't mistake the next line for one that was deleted", () => {
    const cut = lines();
    const b = cut.narration[1] as CutLine;
    cut.narration.splice(1, 1);
    expect(findLine(cut.narration, b)).toBeUndefined();
  });

  it("attaches a take to its line after an earlier line was deleted", () => {
    const cut = lines();
    const b = cut.narration[1] as CutLine;
    cut.narration.splice(0, 1);
    expect(placeTake(cut, "recordings/take.webm", 5, b)).toEqual({
      index: 0,
      gone: false,
    });
    expect(cut.narration.map((l) => l.audio)).toEqual([
      "recordings/take.webm",
      "recordings/c.webm",
    ]);
  });

  it("keeps a take whose line was deleted as a new line at its time, not on the next line", () => {
    // Lines [A, B, C]; Record on B; B is deleted while it records.
    const cut = lines();
    const b = cut.narration[1] as CutLine;
    cut.narration.splice(1, 1);
    expect(placeTake(cut, "recordings/take.webm", 5, b)).toEqual({
      index: 2,
      gone: true,
    });
    expect(cut.narration).toEqual([
      { at: 1, text: "A" },
      { at: 8, text: "C", audio: "recordings/c.webm" },
      { at: 5, text: "", audio: "recordings/take.webm" },
    ]);
  });

  it("adds a take recorded for no line as a new line", () => {
    const cut = lines();
    expect(placeTake(cut, "recordings/take.webm", 3)).toEqual({
      index: 3,
      gone: false,
    });
  });
});

describe("recordStart", () => {
  const model = previewModel(planCut(seed(), { durationSec: 10, fps: 25 }));

  it("starts where asked on kept footage", () => {
    expect(recordStart(model, 1)).toBe(1);
  });

  it("starts at the next kept frame inside a cut", () => {
    expect(recordStart(model, 3)).toBe(4);
  });

  it("refuses the end, where there is nothing to narrate over", () => {
    expect(recordStart(model, 10)).toBeUndefined();
    expect(recordStart(model, 9.99)).toBeUndefined();
  });
});

// ----- the capture -----

describe("MicCapture", () => {
  it("asks for the microphone once and keeps it", async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const { Recorder } = fakeRecorderClass();
    const capture = new MicCapture({ getUserMedia, MediaRecorder: Recorder });
    expect(await capture.open()).toBe(stream);
    expect(await capture.open()).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("asks again once the track has ended", async () => {
    const streams = [fakeStream(), fakeStream()];
    const getUserMedia = vi.fn(async () => streams.shift() as MediaStream);
    const capture = new MicCapture({ getUserMedia });
    const first = (await capture.open()) as ReturnType<typeof fakeStream>;
    (first.tracks[0] as FakeTrack).readyState = "ended";
    expect(await capture.open()).not.toBe(first);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("records in the best format the recorder supports", async () => {
    const { Recorder, made } = fakeRecorderClass(["audio/ogg;codecs=opus"]);
    const capture = new MicCapture({
      getUserMedia: async () => fakeStream(),
      MediaRecorder: Recorder,
    });
    await capture.begin(await capture.open());
    expect(made[0]?.options).toEqual({ mimeType: "audio/ogg;codecs=opus" });
    const blob = await capture.finish();
    expect(blob.type).toBe("audio/ogg;codecs=opus");
    expect(await blob.text()).toBe("voice");
  });

  it("uses the default format when none is supported", async () => {
    const { Recorder, made } = fakeRecorderClass([]);
    const capture = new MicCapture({
      getUserMedia: async () => fakeStream(),
      MediaRecorder: Recorder,
    });
    await capture.begin(await capture.open());
    expect(made[0]?.options).toEqual({});
  });

  it("throws a discarded take away", async () => {
    const { Recorder } = fakeRecorderClass();
    const capture = new MicCapture({
      getUserMedia: async () => fakeStream(),
      MediaRecorder: Recorder,
    });
    await capture.begin(await capture.open());
    capture.discard();
    await expect(capture.finish()).rejects.toThrow(/nothing is being recorded/);
  });

  it("says the microphone is unsupported without a MediaRecorder", async () => {
    const capture = new MicCapture({
      getUserMedia: async () => fakeStream(),
      MediaRecorder: undefined,
    });
    const stream = await capture.open();
    const missing = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    expect(missing).toBeUndefined();
    const err = await capture.begin(stream).catch((e: unknown) => e);
    expect(micProblem(err)).toBe("unsupported");
  });

  it("lets go of the microphone", async () => {
    const stream = fakeStream();
    const capture = new MicCapture({ getUserMedia: async () => stream });
    await capture.open();
    capture.release();
    expect(stream.tracks[0]?.readyState).toBe("ended");
    expect(capture.current).toBeUndefined();
  });
});

// ----- the state machine -----

function harness(getUserMedia: () => Promise<MediaStream>) {
  const { Recorder } = fakeRecorderClass();
  const calls: string[] = [];
  const attached: { blob: Blob; target: RecordTarget }[] = [];
  const phases: string[] = [];
  let rec: NarrationRecorder | undefined;
  const hooks: NarrationHooks = {
    attach: async (blob, target) => {
      attached.push({ blob, target });
      return { file: "recordings/rec-1.webm", durationSec: 2, index: 0 };
    },
    attached: (saved: AttachedTake) => calls.push(`attached ${saved.file}`),
    changed: () => phases.push(rec?.phase ?? ""),
    now: () => 1000,
    pause: () => {
      calls.push("pause");
      rec?.playbackStopped();
    },
    play: (sec) => calls.push(`play ${sec}`),
    status: () => undefined,
  };
  rec = new NarrationRecorder(
    new MicCapture({ getUserMedia, MediaRecorder: Recorder }),
    hooks
  );
  return { rec, calls, attached, phases };
}

describe("NarrationRecorder", () => {
  it("records over the preview and attaches the take where it started", async () => {
    const { rec, calls, attached, phases } = harness(async () => fakeStream());
    const line = { at: 3, text: "hello" };
    await rec.start({ at: 3, line });
    expect(rec.phase).toBe("recording");
    expect(rec.startedAt).toBe(1000);
    expect(calls).toEqual(["play 3"]);
    const saved = await rec.stop();
    expect(saved?.file).toBe("recordings/rec-1.webm");
    expect(attached).toHaveLength(1);
    expect(attached[0]?.target.at).toBe(3);
    expect(attached[0]?.target.line).toBe(line);
    expect(await attached[0]?.blob.text()).toBe("voice");
    expect(calls).toEqual([
      "play 3",
      "pause",
      "attached recordings/rec-1.webm",
    ]);
    expect(phases).toEqual(["requesting", "recording", "uploading", "idle"]);
    expect(rec.phase).toBe("idle");
  });

  it("stops when the playback does", async () => {
    const { rec, attached } = harness(async () => fakeStream());
    await rec.start({ at: 1 });
    rec.playbackStopped();
    await vi.waitFor(() => expect(rec.phase).toBe("idle"));
    expect(attached).toHaveLength(1);
  });

  it("throws a cancelled take away and uploads nothing", async () => {
    const { rec, attached, calls } = harness(async () => fakeStream());
    await rec.start({ at: 1 });
    expect(rec.cancel()).toBe(true);
    expect(rec.phase).toBe("idle");
    expect(calls).toEqual(["play 1", "pause"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attached).toHaveLength(0);
    expect(rec.cancel()).toBe(false);
  });

  it("doesn't start when cancelled while asking for the microphone", async () => {
    let grant: (stream: MediaStream) => void = () => undefined;
    const { rec, calls } = harness(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        })
    );
    const started = rec.start({ at: 1 });
    expect(rec.phase).toBe("requesting");
    expect(rec.cancel()).toBe(true);
    grant(fakeStream());
    await started;
    expect(rec.phase).toBe("idle");
    expect(calls).toEqual([]);
  });

  it("reports a denied microphone where Record was pressed", async () => {
    const { rec, calls } = harness(async () => {
      throw Object.assign(new Error("Permission denied"), {
        name: "NotAllowedError",
      });
    });
    const line = { at: 1, text: "third" };
    await rec.start({ at: 1, line });
    expect(rec.phase).toBe("idle");
    expect(rec.problem?.where).toBe(line);
    expect(rec.problem?.mic).toBe(true);
    expect(rec.problem?.message).toMatch(/blocked/);
    expect(calls).toEqual([]);
    await rec.start({ at: 1 });
    expect(rec.problem?.where).toBe("new");
  });

  it("ignores a second start while busy", async () => {
    const { rec, calls } = harness(async () => fakeStream());
    await rec.start({ at: 1 });
    await rec.start({ at: 5 });
    expect(calls).toEqual(["play 1"]);
    expect(rec.target).toEqual({ at: 1 });
  });
});
