import { describe, expect, it } from "vitest";
import {
  type Cut,
  type CutVoice,
  mapTime,
  planCut,
  TAIL_PAD_SEC,
} from "../../cut.js";
import {
  analyze,
  captionAtSource,
  captionLines,
  clipVoice,
  cueAt,
  type EngineState,
  estimateSpeechSec,
  lineDuration,
  linesAt,
  linesStarting,
  outputAt,
  type PlacedLine,
  type PreviewModel,
  previewModel,
  rateAt,
  sourceTime,
  tick,
  type VoicedClip,
  voicedClip,
} from "./preview.js";

// 10s of footage at 10 fps, so a frame is 0.1s and the arithmetic is plain.
const source = { durationSec: 10, fps: 10 };

function cutOf(parts: Partial<Cut>): Cut {
  return {
    version: 1,
    video: "page.webm",
    voice: {},
    steps: [],
    cuts: [],
    holds: [],
    speedups: [],
    captions: [],
    narration: [],
    ...parts,
  };
}

// A cut, a hold and a speed-up:
//   source 0–2 plays, 2–4 is cut, 4–6 plays, holds 1.5s at 6, 6–7 plays,
//   7–9 plays at 2x (1s), 9–10 plays. Output: 2 + 2 + 1.5 + 1 + 1 + 1 = 8.5s.
const mixed = cutOf({
  cuts: [{ start: 2, end: 4 }],
  holds: [{ at: 6, seconds: 1.5 }],
  speedups: [{ start: 7, end: 9, rate: 2 }],
});

interface Frame {
  action: string;
  now: number;
  out: number;
  wall: number;
}

// Play the preview the way stage.ts does, against a simulated <video>: tick
// every `dt` of wall time, apply seeks, advance the source by dt * rate while
// playing, freeze it while holding.
function simulate(
  model: PreviewModel,
  opts: { from?: number; dt?: number; limit?: number } = {}
): Frame[] {
  const dt = opts.dt ?? 1 / 60;
  const end = model.plan.sourceDurationSec;
  let now = opts.from ?? 0;
  let since = now - 2e-6;
  let state: EngineState = {};
  let elapsed = 0;
  let wall = 0;
  const frames: Frame[] = [];
  for (let i = 0; i < (opts.limit ?? 60) / dt; i++) {
    const step = tick(model, state, { now, since, dt: elapsed });
    if (step.seekTo !== undefined) {
      now = step.seekTo;
    }
    frames.push({ action: step.action, now, out: step.out, wall });
    if (step.action === "end") {
      break;
    }
    state = step.state;
    since = step.since;
    wall += dt;
    elapsed = dt;
    if (step.action === "play") {
      now = Math.min(now + dt * step.rate, end);
    }
  }
  return frames;
}

describe("previewModel", () => {
  it("lists the removed footage, the holds and the fast stretches", () => {
    const model = previewModel(planCut(mixed, source));
    expect(model.gaps).toEqual([{ start: 2, end: 4 }]);
    // The hold ends the piece 4–6, so the render freezes its last frame.
    expect(model.holds).toEqual([
      { at: 6, frame: 5.9, seconds: 1.5, side: "end" },
    ]);
    expect(model.fast).toEqual([{ start: 7, end: 9, rate: 2 }]);
    expect(model.plan.outDurationSec).toBeCloseTo(8.5);
  });

  it("sees removed footage at both ends", () => {
    const model = previewModel(
      planCut(
        cutOf({
          cuts: [
            { start: 0, end: 1 },
            { start: 9, end: 10 },
          ],
        }),
        source
      )
    );
    expect(model.gaps).toEqual([
      { start: 0, end: 1 },
      { start: 9, end: 10 },
    ]);
  });

  it("gives the rate inside a speed-up and 1 outside", () => {
    const model = previewModel(planCut(mixed, source));
    expect(rateAt(model, 8)).toBe(2);
    expect(rateAt(model, 9)).toBe(1);
    expect(rateAt(model, 1)).toBe(1);
  });
});

describe("tick", () => {
  const model = previewModel(planCut(mixed, source));
  const frames = simulate(model);

  it("never shows a frame of removed footage", () => {
    const shown = frames.filter((f) => f.action !== "end");
    expect(shown.some((f) => f.now > 2 + 1e-6 && f.now < 4 - 1e-6)).toBe(false);
  });

  it("freezes on the frame the render freezes, for the hold's length", () => {
    const held = frames.filter((f) => f.action === "hold");
    expect(held.every((f) => Math.abs(f.now - 5.9) < 1e-9)).toBe(true);
    const lasted = (held.at(-1)?.wall ?? 0) - (held[0]?.wall ?? 0);
    expect(lasted).toBeGreaterThan(1.5 - 2 / 60);
    expect(lasted).toBeLessThan(1.5 + 2 / 60);
  });

  it("keeps the output clock in step with the wall clock", () => {
    // The output clock is what a viewer of the render would see: it runs at
    // real time through cuts, holds and speed-ups alike.
    for (const f of frames) {
      expect(Math.abs(f.out - f.wall)).toBeLessThan(0.1 + 1 / 60 + 1e-9);
    }
    const outs = frames.map((f) => f.out);
    expect(outs).toEqual([...outs].sort((a, b) => a - b));
  });

  it("ends at the plan's output length", () => {
    const last = frames.at(-1);
    expect(last?.action).toBe("end");
    expect(last?.out).toBeCloseTo(8.5);
    expect(last?.wall).toBeCloseTo(8.5, 1);
  });

  it("plays a hold that playback starts on", () => {
    const [first] = simulate(model, { from: 6 });
    expect(first?.action).toBe("hold");
  });

  it("does not hold again once the hold has played", () => {
    const held = simulate(model, { from: 5.5 }).filter(
      (f) => f.action === "hold"
    );
    const lasted = (held.at(-1)?.wall ?? 0) - (held[0]?.wall ?? 0);
    expect(lasted).toBeLessThan(1.5 + 2 / 60);
  });

  it("skips to the next kept frame when it starts inside a cut", () => {
    const [first] = simulate(model, { from: 3 });
    expect(first?.now).toBe(4);
    expect(first?.action).toBe("play");
    expect(first?.out).toBeCloseTo(2);
  });

  it("holds on a cut's edge, then skips the cut", () => {
    const edge = previewModel(
      planCut(
        cutOf({ cuts: [{ start: 2, end: 4 }], holds: [{ at: 2, seconds: 1 }] }),
        source
      )
    );
    const run = simulate(edge, { from: 1.5 });
    const firstHold = run.findIndex((f) => f.action === "hold");
    expect(run[firstHold]?.now).toBeCloseTo(1.9, 9);
    const after = run.slice(firstHold).find((f) => f.action === "play");
    expect(after?.now).toBe(4);
    expect(after?.out).toBeCloseTo(3);
  });

  it("adds up holds on the same frame", () => {
    const twice = previewModel(
      planCut(
        cutOf({
          holds: [
            { at: 5, seconds: 1 },
            { at: 5, seconds: 2 },
          ],
        }),
        source
      )
    );
    expect(twice.holds).toEqual([
      { at: 5, frame: 4.9, seconds: 3, side: "end" },
    ]);
    const held = simulate(twice, { from: 4.5 }).filter(
      (f) => f.action === "hold"
    );
    const lasted = (held.at(-1)?.wall ?? 0) - (held[0]?.wall ?? 0);
    expect(lasted).toBeGreaterThan(3 - 2 / 60);
  });

  it("holds the last frame, then ends", () => {
    const tail = previewModel(
      planCut(cutOf({ holds: [{ at: 10, seconds: 1 }] }), source)
    );
    const run = simulate(tail, { from: 9.5 });
    expect(
      run.some((f) => f.action === "hold" && Math.abs(f.now - 9.9) < 1e-9)
    ).toBe(true);
    expect(run.at(-1)?.action).toBe("end");
    expect(run.at(-1)?.out).toBeCloseTo(11);
  });

  it("ends at once when everything is cut", () => {
    const none = previewModel(
      planCut(cutOf({ cuts: [{ start: 0, end: 10 }] }), source)
    );
    expect(simulate(none)[0]?.action).toBe("end");
  });

  it("counts a finished hold in the output clock, and plays on from its place", () => {
    const step = tick(
      model,
      {
        hold: { at: 6, frame: 5.9, seconds: 1.5, side: "end", elapsed: 1.49 },
      },
      {
        now: 5.9,
        since: 6,
        dt: 0.02,
      }
    );
    expect(step.action).toBe("play");
    expect(step.seekTo).toBe(6);
    expect(step.out).toBeCloseTo(5.5);
    expect(step.state.after).toEqual({ at: 6, seconds: 1.5 });
  });

  it("holds a piece's first frame for a hold at its start", () => {
    const start = previewModel(
      planCut(
        cutOf({ cuts: [{ start: 2, end: 4 }], holds: [{ at: 4, seconds: 1 }] }),
        source
      )
    );
    expect(start.holds).toEqual([
      { at: 4, frame: 4, seconds: 1, side: "start" },
    ]);
    const held = simulate(start, { from: 1.5 }).filter(
      (f) => f.action === "hold"
    );
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((f) => f.now === 4)).toBe(true);
  });
});

// The frame on screen during a hold must be the one the render freezes:
// cutVideoFilter loops a piece's first kept frame for a start hold and its
// last KEPT frame for an end hold (loop … start=out+length-1). And the output
// clock must run as before: never backwards, never jumping, in step with the
// wall clock.
describe("tick, on the frame the render freezes", () => {
  function expectSteadyClock(frames: Frame[], dt = 1 / 60): void {
    for (let i = 1; i < frames.length; i++) {
      const step = (frames[i]?.out ?? 0) - (frames[i - 1]?.out ?? 0);
      expect(step).toBeGreaterThanOrEqual(-1e-9);
      expect(step).toBeLessThan(dt + 0.1 + 1e-9);
    }
  }

  it.each([25, 30_000 / 1001])(
    "freezes the frame before a cut for a hold on the cut's start (%d fps)",
    (fps) => {
      // Cuts [10,12] and a hold at 10. At 25 fps the render freezes frame 249
      // (9.96s); 10.0 is frame 250, the first removed one.
      const grid = { durationSec: 20, fps };
      const model = previewModel(
        planCut(
          cutOf({
            cuts: [{ start: 10, end: 12 }],
            holds: [{ at: 10, seconds: 1 }],
          }),
          grid
        )
      );
      const at = Math.round(10 * fps) / fps;
      const frame = (Math.round(10 * fps) - 1) / fps;
      expect(model.holds).toHaveLength(1);
      expect(model.holds[0]).toMatchObject({ at, frame, side: "end" });
      if (fps === 25) {
        expect(frame).toBeCloseTo(9.96, 9);
      }
      const frames = simulate(model, { from: 9.5 });
      const held = frames.filter((f) => f.action === "hold");
      expect(held.length).toBeGreaterThan(50);
      expect(held.every((f) => Math.abs(f.now - frame) < 1e-9)).toBe(true);
      // Then on past the cut, where the render goes next.
      const resumeAt = Math.round(12 * fps) / fps;
      const next = frames.at(frames.indexOf(held.at(-1) as Frame) + 1);
      expect(next?.now).toBeCloseTo(resumeAt, 9);
      expect(next?.out).toBeCloseTo(mapTime(model.plan, resumeAt).out, 9);
      expectSteadyClock(frames);
    }
  );

  it("freezes the last frame kept when the tail is extended for the last line", () => {
    // The last line overruns the picture, which ends at a cut: the render
    // holds the frame before the cut, never the trimmed tail after it.
    const words =
      "one two three four five six seven eight nine ten eleven twelve thirteen";
    const { plan } = analyze(
      cutOf({
        cuts: [{ start: 9, end: 10 }],
        narration: [{ at: 7, text: words }],
      }),
      { source, lineMax: 20, recordings: [], rendered: [] }
    );
    const model = previewModel(plan);
    expect(model.holds).toHaveLength(1);
    expect(model.holds[0]).toMatchObject({ at: 9, side: "end" });
    expect(model.holds[0]?.frame).toBeCloseTo(8.9, 9);
    const frames = simulate(model, { from: 8 });
    const held = frames.filter((f) => f.action === "hold");
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((f) => Math.abs(f.now - 8.9) < 1e-9)).toBe(true);
    expect(frames.at(-1)?.action).toBe("end");
    expect(frames.at(-1)?.out).toBeCloseTo(plan.outDurationSec, 9);
    expectSteadyClock(frames);
  });

  it("freezes the stride's last kept frame at the end of a sped-up piece", () => {
    // 2–4 at 3x keeps frames 20, 23, … 38; the render freezes 38 (3.8s), not
    // 39 (3.9s, never shown) or 40 (4.0s, the next piece).
    const model = previewModel(
      planCut(
        cutOf({
          speedups: [{ start: 2, end: 4, rate: 3 }],
          holds: [{ at: 4, seconds: 1 }],
        }),
        source
      )
    );
    expect(model.holds).toHaveLength(1);
    expect(model.holds[0]?.frame).toBeCloseTo(3.8, 9);
    const frames = simulate(model, { from: 1.5 });
    const held = frames.filter((f) => f.action === "hold");
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((f) => Math.abs(f.now - 3.8) < 1e-9)).toBe(true);
    const next = frames.at(frames.indexOf(held.at(-1) as Frame) + 1);
    expect(next?.now).toBe(4);
    expectSteadyClock(frames);
  });
});

describe("sourceTime", () => {
  const plan = planCut(mixed, source);

  it("inverts mapTime on real-speed footage", () => {
    for (const t of [0, 0.5, 1.9, 4, 4.5, 5.9, 6.5, 9.5]) {
      expect(sourceTime(plan, mapTime(plan, t).out), String(t)).toBeCloseTo(t);
    }
  });

  it("inverts mapTime inside a speed-up, to the frame stride", () => {
    for (const t of [7.2, 8, 8.6]) {
      const back = sourceTime(plan, mapTime(plan, t).out);
      expect(back).toBeGreaterThanOrEqual(t - 1e-9);
      expect(back - t).toBeLessThan(2 / 10 + 1e-9);
    }
  });

  it("maps a freeze to its held frame", () => {
    expect(sourceTime(plan, 4.2)).toBe(6);
    expect(sourceTime(plan, 5.4)).toBe(6);
  });

  it("maps the moment after a cut to the footage after it", () => {
    expect(sourceTime(plan, 2)).toBe(4);
  });

  it("clamps past either end", () => {
    expect(sourceTime(plan, -1)).toBe(0);
    expect(sourceTime(plan, 99)).toBe(10);
  });

  it("maps an extended tail to the last frame", () => {
    const tail = planCut(cutOf({ holds: [{ at: 10, seconds: 2 }] }), source);
    expect(sourceTime(tail, 11)).toBe(10);
  });
});

describe("outputAt", () => {
  it("is undefined for removed footage", () => {
    const plan = planCut(mixed, source);
    expect(outputAt(plan, 3)).toBeUndefined();
    expect(outputAt(plan, 5)).toBeCloseTo(3);
  });
});

describe("captions", () => {
  it("wraps like the burn: balanced, two lines at most", () => {
    const lines = captionLines(
      "Add the studio address on the way down to the shop",
      30
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.length <= 30)).toBe(true);
    const [a = "", b = ""] = lines;
    expect(Math.abs(a.length - b.length)).toBeLessThan(10);
  });

  it("keeps a short caption on one line", () => {
    expect(captionLines("Fill in the contact fields", 40)).toEqual([
      "Fill in the contact fields",
    ]);
  });

  it("cuts a caption that won't fit two lines with an ellipsis", () => {
    const lines = captionLines("word ".repeat(40), 20);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  it("shows nothing for empty text", () => {
    expect(captionLines("  ", 30)).toEqual([]);
  });

  it("finds the cue on screen in output time", () => {
    const cues = [
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "b" },
    ];
    expect(cueAt(cues, 0.5)?.text).toBe("a");
    expect(cueAt(cues, 1.5)).toBeUndefined();
    expect(cueAt(cues, 2)?.text).toBe("b");
  });

  it("finds the free-standing caption at a source time", () => {
    const captions = [{ start: 1, end: 2, text: "x" }];
    expect(captionAtSource(captions, 1.5)?.text).toBe("x");
    expect(captionAtSource(captions, 2)).toBeUndefined();
  });
});

describe("narration timing", () => {
  const placed: PlacedLine[] = [
    { index: 0, line: { at: 1, text: "one" }, outStart: 1, durationSec: 2 },
    { index: 1, line: { at: 5, text: "two" }, outStart: 4, durationSec: 1 },
  ];

  it("starts the lines the output clock crossed", () => {
    expect(linesStarting(placed, 0.9, 1.1).map((p) => p.index)).toEqual([0]);
    expect(linesStarting(placed, 1, 1.1)).toEqual([]);
    expect(linesStarting(placed, 3.9, 4).map((p) => p.index)).toEqual([1]);
  });

  it("finds a line speaking mid-way", () => {
    expect(linesAt(placed, 2.5).map((p) => p.index)).toEqual([0]);
    expect(linesAt(placed, 3.5)).toEqual([]);
  });

  it("estimates speech at 2.6 words a second", () => {
    expect(
      estimateSpeechSec(
        "one two three four five six seven eight nine ten eleven twelve thirteen"
      )
    ).toBeCloseTo(5);
    expect(estimateSpeechSec("")).toBeCloseTo(1 / 2.6);
  });

  it("prefers a recording's length, then the last render's, then an estimate", () => {
    const known = {
      recordings: [{ file: "recordings/a.wav", durationSec: 1.25 }],
      rendered: [{ text: "hello there", durationSec: 0.9 }],
    };
    expect(
      lineDuration(
        { at: 0, text: "hello there", audio: "recordings/a.wav" },
        known
      )
    ).toEqual({
      sec: 1.25,
      source: "recording",
    });
    expect(lineDuration({ at: 0, text: "hello there" }, known)).toEqual({
      sec: 0.9,
      source: "render",
    });
    expect(lineDuration({ at: 0, text: "hello" }, known).source).toBe(
      "estimate"
    );
  });
});

describe("voiced clips", () => {
  const say: CutVoice = { narrator: "say" };
  const clip = (
    text: string,
    voice: CutVoice = say,
    durationSec = 1.5
  ): VoicedClip => ({
    text,
    voice: clipVoice(voice),
    file: `cut/tts-${text.length.toString(16).padStart(16, "0")}.m4a`,
    durationSec,
  });

  it("prefers a recording, then a voiced clip, then the last render, then an estimate", () => {
    const voiced = clip("hello there");
    const known = {
      recordings: [{ file: "recordings/a.wav", durationSec: 1.25 }],
      rendered: [{ text: "hello there", durationSec: 0.9 }],
      voiced: [voiced],
    };
    expect(
      lineDuration(
        { at: 0, text: "hello there", audio: "recordings/a.wav" },
        known,
        say
      )
    ).toEqual({ sec: 1.25, source: "recording" });
    expect(lineDuration({ at: 0, text: "hello there" }, known, say)).toEqual({
      sec: 1.5,
      source: "voiced",
      clip: voiced.file,
    });
    // No narrator pinned: the next voicing resolves a voice afresh, so no
    // clip applies yet — the last render's length does.
    expect(lineDuration({ at: 0, text: "hello there" }, known, {})).toEqual({
      sec: 0.9,
      source: "render",
    });
    expect(lineDuration({ at: 0, text: "hello" }, known, say)).toEqual({
      sec: estimateSpeechSec("hello"),
      source: "estimate",
    });
  });

  it("stops applying when the words, narrator, voice name or speed change, and applies again when they change back", () => {
    const voice: CutVoice = { narrator: "say", name: "Ava", speed: 1.25 };
    const clips = [clip("Open the form", voice)];
    const line = { at: 1, text: "Open the form" };
    expect(voicedClip(line, voice, clips)?.durationSec).toBe(1.5);
    expect(
      voicedClip({ ...line, text: "Open the form." }, voice, clips)
    ).toBeUndefined();
    expect(
      voicedClip(line, { ...voice, narrator: "gemini" }, clips)
    ).toBeUndefined();
    expect(voicedClip(line, { ...voice, name: "Zoe" }, clips)).toBeUndefined();
    expect(voicedClip(line, { ...voice, speed: 1.5 }, clips)).toBeUndefined();
    expect(voicedClip(line, { ...voice }, clips)).toBe(clips[0]);
  });

  it("keys a voice the way the render's cache does: no name is none, no speed is 1", () => {
    const clips = [clip("hi")];
    const line = { at: 0, text: "hi" };
    expect(voicedClip(line, { narrator: "say", speed: 1 }, clips)).toBe(
      clips[0]
    );
    expect(
      voicedClip(line, { narrator: "say", name: "Ava" }, clips)
    ).toBeUndefined();
    // A recorded line plays its recording, never a clip.
    expect(
      voicedClip({ ...line, audio: "recordings/hi.wav" }, say, clips)
    ).toBeUndefined();
  });

  it("lays a voiced line out at its clip's length", () => {
    const words = "one two three four five six seven eight";
    const cut = cutOf({ voice: say, narration: [{ at: 1, text: words }] });
    const ctx = { source, lineMax: 20, recordings: [], rendered: [] };
    const estimated = analyze(cut, ctx);
    expect(estimated.durations[0]?.source).toBe("estimate");
    expect(estimated.placed[0]?.durationSec).toBeCloseTo(8 / 2.6);
    const voiced = analyze(cut, { ...ctx, voiced: [clip(words, say, 1.5)] });
    expect(voiced.durations[0]).toMatchObject({ sec: 1.5, source: "voiced" });
    expect(voiced.placed[0]?.durationSec).toBe(1.5);
  });
});

describe("analyze", () => {
  const ctx = { source, lineMax: 20, recordings: [], rendered: [] };

  it("passes a valid cut and plans it", () => {
    const result = analyze(mixed, ctx);
    expect(result.error).toBeUndefined();
    expect(result.plan.outDurationSec).toBeCloseTo(8.5);
  });

  it("reports the parser's error", () => {
    const result = analyze(cutOf({ narration: [{ at: 1, text: " " }] }), ctx);
    expect(result.error).toMatch(/needs text to speak or an audio file/);
  });

  it("flags a caption too long for two lines, and an empty one", () => {
    const result = analyze(
      cutOf({
        captions: [
          { start: 0, end: 1, text: "x".repeat(41) },
          { start: 2, end: 3, text: "" },
        ],
      }),
      ctx
    );
    expect(result.hints.some((h) => h.includes("41 characters"))).toBe(true);
    expect(result.hints.some((h) => h.includes("has no text"))).toBe(true);
  });

  it("flags a caption inside cut footage", () => {
    const result = analyze(
      cutOf({
        cuts: [{ start: 1, end: 3 }],
        captions: [{ start: 1.5, end: 2.5, text: "gone" }],
      }),
      ctx
    );
    expect(result.hints.some((h) => h.includes("inside cut footage"))).toBe(
      true
    );
    expect(result.cues).toEqual([]);
  });

  it("flags lines that run into each other with the hold that fixes it", () => {
    const words =
      "one two three four five six seven eight nine ten eleven twelve thirteen";
    const result = analyze(
      cutOf({
        narration: [
          { at: 1, text: words },
          { at: 3, text: "next" },
        ],
      }),
      ctx
    );
    expect(
      result.hints.some((h) => /add a hold of about 3s at 3\.00s/.test(h))
    ).toBe(true);
    expect(result.placed.map((p) => p.index)).toEqual([0, 1]);
  });

  it("extends the tail for a last line that runs past the picture, as the render does", () => {
    const words =
      "one two three four five six seven eight nine ten eleven twelve thirteen";
    const result = analyze(cutOf({ narration: [{ at: 8, text: words }] }), ctx);
    expect(result.plan.outDurationSec).toBeCloseTo(8 + 5 + TAIL_PAD_SEC);
    expect(result.hints.some((h) => h.includes("past the picture"))).toBe(true);
  });

  it("gives each line's duration and leaves a line in cut footage unplaced", () => {
    const result = analyze(
      cutOf({
        cuts: [{ start: 4, end: 6 }],
        narration: [
          { at: 1, text: "hi" },
          { at: 5, text: "gone" },
        ],
      }),
      ctx
    );
    expect(result.durations).toHaveLength(2);
    expect(result.placed.map((p) => p.index)).toEqual([0]);
  });

  it("flags a line whose recording is gone from recordings/", () => {
    const cut = cutOf({
      narration: [
        { at: 1, text: "", audio: "recordings/rec-gone.webm" },
        { at: 3, text: "", audio: "recordings/rec-here.webm" },
        { at: 5, text: "", audio: "voice/elsewhere.wav" },
      ],
    });
    const result = analyze(cut, {
      ...ctx,
      recordings: [{ file: "recordings/rec-here.webm", durationSec: 1 }],
    });
    const gone = result.hints.filter((h) => h.includes("is gone"));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatch(
      /line at 1\.00s: its recording recordings\/rec-gone\.webm/
    );
  });
});
