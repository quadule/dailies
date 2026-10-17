// Voice recordings for narration lines. A recording comes from the microphone
// (Record) or from a file (Attach / Replace from file…); either way it is
// uploaded to the session's recordings/ and attached to a line by
// attachRecording.
//
// Recording from the microphone is a small state machine, idle → requesting
// (asking for the microphone) → recording → uploading → idle, run by
// NarrationRecorder. While it records, the stage plays the preview from the
// line's start with the video and every recorded line muted, so the speaker
// narrates to the picture as the render will cut it — and nothing from the
// speakers bleeds into the microphone. Stopping (the button, R, or the
// playback stopping, as it does at the end of the video) uploads the take at
// the SOURCE time it started; Escape throws it away.
//
// MicCapture holds the stream and the MediaRecorder. It takes getUserMedia and
// the MediaRecorder constructor from its caller, defaulting to the browser's
// (looked up when called, so a page can swap them), which lets
// recorder.test.ts drive the capture and the state machine under node.

import { RECORDING_TYPES, type UploadRecordingResponse } from "../contract.js";
import { api } from "./api.js";
import type { EditorContext } from "./context.js";
import { button, h, icon, setIcon } from "./dom.js";
import { clock, snapTime } from "./format.js";
import { type PreviewModel, previewModel } from "./preview.js";

// ---------------------------------------------------------------------------
// Pure helpers. Exported for tests.
// ---------------------------------------------------------------------------

// The MediaRecorder formats to ask for, best first: Opus in WebM (Chrome,
// Firefox), Opus in Ogg (older Firefox), AAC in MP4 (Safari). The server takes
// all of them. When none is supported the browser's default is used.
export const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

export function pickMimeType(
  isTypeSupported: ((type: string) => boolean) | undefined
): string | undefined {
  if (!isTypeSupported) {
    return;
  }
  return MIME_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

// Why the microphone didn't start, from the error getUserMedia or the
// MediaRecorder threw (a DOMException, matched by name).
export type MicProblem =
  | "unsupported"
  | "denied"
  | "missing"
  | "busy"
  | "failed";

export function micProblem(err: unknown): MicProblem {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotSupportedError":
      return "unsupported";
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "missing";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "failed";
  }
}

// What happened, in a sentence, for the inline message.
export function micMessage(problem: MicProblem, detail = ""): string {
  switch (problem) {
    case "unsupported":
      return "This browser can't record from a microphone on this page.";
    case "denied":
      return "Microphone access is blocked. Allow it for this page in the browser's site settings to record.";
    case "missing":
      return "No microphone was found. Connect one to record.";
    case "busy":
      return "The microphone couldn't be started — another app may be using it.";
    default:
      return detail
        ? `The microphone couldn't be started: ${detail}`
        : "The microphone couldn't be started.";
  }
}

// The level meter runs from FLOOR_DB (empty) to 0 dBFS (full).
const FLOOR_DB = -60;

// How loud a block of samples (floats in [-1, 1]) is, as a position on the
// meter from 0 to 1: its RMS level on a decibel scale.
export function levelOf(samples: Iterable<number>): number {
  let sum = 0;
  let count = 0;
  for (const s of samples) {
    sum += s * s;
    count++;
  }
  if (count === 0) {
    return 0;
  }
  const rms = Math.sqrt(sum / count);
  if (rms <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

// How fast the meter falls back, in meter lengths per second. It rises at
// once: a meter that drops as fast as it rises flickers.
const FALL_PER_SEC = 1.5;

export function meterLevel(
  shown: number,
  measured: number,
  dtSec: number
): number {
  if (measured >= shown) {
    return measured;
  }
  return Math.max(measured, shown - FALL_PER_SEC * Math.max(0, dtSec));
}

// How often the clock and the meter redraw while recording: every frame, or —
// when the user asks for reduced motion — four times a second. Still live,
// just not animating.
export function meterIntervalMs(reducedMotion: boolean): number {
  return reducedMotion ? 250 : 0;
}

export type RecorderPhase = "idle" | "requesting" | "recording" | "uploading";

export type RecorderEvent =
  | "start"
  | "granted"
  | "refused"
  | "stop"
  | "cancel"
  | "uploaded"
  | "failed";

const TRANSITIONS: Record<
  RecorderPhase,
  Partial<Record<RecorderEvent, RecorderPhase>>
> = {
  idle: { start: "requesting" },
  requesting: { granted: "recording", refused: "idle", cancel: "idle" },
  recording: { stop: "uploading", cancel: "idle", failed: "idle" },
  uploading: { uploaded: "idle", failed: "idle" },
};

// The phase after `event`, or undefined when it can't happen in `phase`.
export function nextPhase(
  phase: RecorderPhase,
  event: RecorderEvent
): RecorderPhase | undefined {
  return TRANSITIONS[phase][event];
}

const EPS = 1e-6;

// Where a recording made from `sec` (source seconds) starts. Inside removed
// footage that is the next kept frame, which is where the preview starts
// playing; undefined when there is no footage left to narrate over.
export function recordStart(
  model: PreviewModel,
  sec: number
): number | undefined {
  const end = model.plan.sourceDurationSec;
  const gap = model.gaps.find((g) => sec >= g.start - EPS && sec < g.end - EPS);
  const at = gap ? gap.end : sec;
  return at < end - model.frame + EPS ? at : undefined;
}

// ---------------------------------------------------------------------------
// The capture: the microphone stream and a MediaRecorder on it.
// ---------------------------------------------------------------------------

// The part of MediaRecorder the capture uses.
export interface MediaRecorderLike {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions
  ): void;
  readonly mimeType: string;
  start(timeslice?: number): void;
  readonly state: "inactive" | "recording" | "paused";
  stop(): void;
}

export interface MediaRecorderClass {
  isTypeSupported?(type: string): boolean;
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorderLike;
}

export interface CaptureDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: MediaRecorderClass;
}

// getUserMedia threw this name when there is no navigator.mediaDevices (an
// insecure page, an old browser) or no MediaRecorder.
class MicUnavailable extends Error {
  override readonly name = "NotSupportedError";
}

function browserGetUserMedia(
  constraints: MediaStreamConstraints
): Promise<MediaStream> {
  const devices =
    typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    return Promise.reject(new MicUnavailable("no navigator.mediaDevices"));
  }
  return devices.getUserMedia(constraints);
}

function browserMediaRecorder(): MediaRecorderClass | undefined {
  return (globalThis as { MediaRecorder?: MediaRecorderClass }).MediaRecorder;
}

// A recorder's data arrives in pieces this long, so a stop loses little.
const CHUNK_MS = 1000;

function recorderError(event: Event): Error {
  const err = (event as Event & { error?: unknown }).error;
  return err instanceof Error ? err : new Error("the recorder failed");
}

export class MicCapture {
  private chunks: Blob[] = [];
  private readonly getUserMedia: (
    constraints: MediaStreamConstraints
  ) => Promise<MediaStream>;
  private readonly recorderClass: () => MediaRecorderClass | undefined;
  private recorder: MediaRecorderLike | undefined;
  private stream: MediaStream | undefined;

  constructor(deps: CaptureDeps = {}) {
    this.getUserMedia = deps.getUserMedia ?? browserGetUserMedia;
    const given = deps.MediaRecorder;
    this.recorderClass = () => given ?? browserMediaRecorder();
  }

  // The open stream, while there is one.
  get current(): MediaStream | undefined {
    return this.stream;
  }

  // The microphone, asked for once and kept for later recordings (asked for
  // again only if its track ended, as when the device is unplugged).
  async open(): Promise<MediaStream> {
    const live = this.stream
      ?.getAudioTracks()
      .some((track) => track.readyState === "live");
    if (this.stream && live) {
      return this.stream;
    }
    this.stream = await this.getUserMedia({ audio: true });
    return this.stream;
  }

  // Start recording `stream`; resolves once the recorder has started.
  begin(stream: MediaStream): Promise<void> {
    const Recorder = this.recorderClass();
    if (!Recorder) {
      return Promise.reject(new MicUnavailable("no MediaRecorder"));
    }
    const mimeType = pickMimeType((type) =>
      typeof Recorder.isTypeSupported === "function"
        ? Recorder.isTypeSupported(type)
        : false
    );
    let recorder: MediaRecorderLike;
    try {
      recorder = new Recorder(stream, mimeType ? { mimeType } : {});
    } catch (err) {
      return Promise.reject(err);
    }
    this.recorder = recorder;
    this.chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      const data = (event as Event & { data?: Blob }).data;
      // A discarded recorder's last piece arrives after it was let go.
      if (this.recorder === recorder && data && data.size > 0) {
        this.chunks.push(data);
      }
    });
    return new Promise((resolve, reject) => {
      recorder.addEventListener("start", () => resolve(), { once: true });
      recorder.addEventListener(
        "error",
        (event) => reject(recorderError(event)),
        { once: true }
      );
      try {
        recorder.start(CHUNK_MS);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Stop recording and hand back what was recorded.
  finish(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) {
      return Promise.reject(new Error("nothing is being recorded"));
    }
    return new Promise((resolve, reject) => {
      const done = () => {
        const type = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        this.recorder = undefined;
        this.chunks = [];
        resolve(blob);
      };
      if (recorder.state === "inactive") {
        done();
        return;
      }
      recorder.addEventListener("stop", done, { once: true });
      recorder.addEventListener(
        "error",
        (event) => reject(recorderError(event)),
        { once: true }
      );
      recorder.stop();
    });
  }

  // Stop recording and throw the take away.
  discard(): void {
    const recorder = this.recorder;
    this.recorder = undefined;
    this.chunks = [];
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  // Let go of the microphone (the page is going away).
  release(): void {
    this.discard();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = undefined;
  }
}

// ---------------------------------------------------------------------------
// One recording at a time: the state machine.
// ---------------------------------------------------------------------------

export interface RecordTarget {
  // Source seconds the recording starts at.
  at: number;
  // The narration line whose audio it replaces; a new line when absent.
  lineIndex?: number;
}

// Why the last Record press didn't record, shown where it was pressed: a
// narration line's audio box, or the Add section ("new").
export interface RecorderProblem {
  message: string;
  // A microphone problem, so the message adds that a file still works.
  mic: boolean;
  where: number | "new";
}

export interface NarrationHooks {
  attach(blob: Blob, target: RecordTarget): Promise<UploadRecordingResponse>;
  // A take was attached: show it.
  attached(saved: UploadRecordingResponse, target: RecordTarget): void;
  // The phase, target or problem changed: redraw.
  changed(): void;
  // Milliseconds, for the elapsed clock.
  now(): number;
  pause(): void;
  // Play the preview from `sec` with every voice and the video muted.
  play(sec: number): void;
  status(message: string, tone?: "error"): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class NarrationRecorder {
  phase: RecorderPhase = "idle";
  problem: RecorderProblem | undefined;
  // hooks.now() when the take started.
  startedAt = 0;
  target: RecordTarget | undefined;

  // Bumped by a cancel, so a microphone that answers after it is ignored.
  private attempt = 0;
  private readonly capture: MicCapture;
  private readonly hooks: NarrationHooks;

  constructor(capture: MicCapture, hooks: NarrationHooks) {
    this.capture = capture;
    this.hooks = hooks;
  }

  get busy(): boolean {
    return this.phase !== "idle";
  }

  get stream(): MediaStream | undefined {
    return this.capture.current;
  }

  // Record a take for `target`. Resolves once it is recording, or didn't.
  async start(target: RecordTarget): Promise<void> {
    if (!this.move("start")) {
      return;
    }
    const attempt = ++this.attempt;
    this.target = target;
    this.problem = undefined;
    this.hooks.changed();
    try {
      const stream = await this.capture.open();
      if (attempt !== this.attempt) {
        return;
      }
      await this.capture.begin(stream);
    } catch (err) {
      if (attempt === this.attempt) {
        this.move("refused");
        this.target = undefined;
        this.problem = {
          where: target.lineIndex ?? "new",
          message: micMessage(micProblem(err), errorText(err)),
          mic: true,
        };
        this.hooks.status(this.problem.message, "error");
        this.hooks.changed();
      }
      return;
    }
    if (attempt !== this.attempt) {
      this.capture.discard();
      return;
    }
    // Playback first: switching the stage into preview pauses it, and a
    // pause while recording would end the take.
    this.hooks.play(target.at);
    this.startedAt = this.hooks.now();
    this.move("granted");
    this.hooks.status(
      `Recording from ${clock(target.at)} — narrate over the picture. R or Stop to finish, Esc to cancel.`
    );
    this.hooks.changed();
  }

  // Stop and attach the take. Resolves with the saved file, or undefined
  // when there was nothing to stop or the upload failed.
  async stop(): Promise<UploadRecordingResponse | undefined> {
    const target = this.target;
    if (!(target && this.move("stop"))) {
      return;
    }
    this.hooks.pause();
    this.hooks.status("Saving the recording…");
    this.hooks.changed();
    try {
      const blob = await this.capture.finish();
      const saved = await this.hooks.attach(blob, target);
      this.move("uploaded");
      this.target = undefined;
      this.hooks.changed();
      this.hooks.attached(saved, target);
      return saved;
    } catch (err) {
      this.capture.discard();
      this.move("failed");
      this.target = undefined;
      this.hooks.status(
        `The recording wasn't saved: ${errorText(err)}`,
        "error"
      );
      this.hooks.changed();
      return;
    }
  }

  // Throw the take away (or stop waiting for the microphone). False when
  // there was nothing to cancel.
  cancel(): boolean {
    const recording = this.phase === "recording";
    if (recording) {
      this.capture.discard();
    } else if (this.phase === "requesting") {
      this.attempt++;
    } else {
      return false;
    }
    this.move("cancel");
    this.target = undefined;
    if (recording) {
      this.hooks.pause();
    }
    this.hooks.status("Recording cancelled — nothing was saved");
    this.hooks.changed();
    return true;
  }

  // The preview stopped playing (it reached the end, or something paused
  // it): the take ends with it.
  playbackStopped(): void {
    if (this.phase === "recording") {
      void this.stop();
    }
  }

  // Report why a Record press couldn't start, where it was pressed.
  refuse(problem: RecorderProblem): void {
    this.problem = problem;
    this.hooks.status(problem.message, "error");
    this.hooks.changed();
  }

  clearProblem(): void {
    this.problem = undefined;
  }

  release(): void {
    this.capture.release();
  }

  private move(event: RecorderEvent): boolean {
    const next = nextPhase(this.phase, event);
    if (next === undefined) {
      return false;
    }
    this.phase = next;
    return true;
  }
}

// ---------------------------------------------------------------------------
// The editor's recorder: bound to the editor's context once main.ts has one.
// ---------------------------------------------------------------------------

let bound: EditorContext | undefined;
let active: NarrationRecorder | undefined;

export interface RecorderUi {
  // A take was attached to line `lineIndex` (selected now): show it.
  attached(saved: UploadRecordingResponse, lineIndex: number | undefined): void;
  changed(): void;
  pause(): void;
  play(sec: number): void;
}

export function bindRecorder(
  ctx: EditorContext,
  ui: RecorderUi,
  deps: CaptureDeps = {}
): NarrationRecorder {
  bound = ctx;
  active?.release();
  active = new NarrationRecorder(new MicCapture(deps), {
    attach: (blob, target) =>
      attachRecording(blob, target.at, target.lineIndex),
    attached: (saved) => {
      const sel = ctx.state.selection;
      ui.attached(saved, sel?.kind === "line" ? sel.index : undefined);
    },
    changed: () => ui.changed(),
    now: () => performance.now(),
    pause: () => ui.pause(),
    play: (sec) => ui.play(sec),
    status: (message, tone) => ctx.status(message, tone),
  });
  return active;
}

function context(): EditorContext {
  if (!bound) {
    throw new Error("the recorder isn't bound to the editor yet");
  }
  return bound;
}

function recorder(): NarrationRecorder {
  if (!active) {
    throw new Error("the recorder isn't bound to the editor yet");
  }
  return active;
}

// Record (or stop recording) narration: line `lineIndex` from its start, or a
// new line at the playhead. What the Record buttons and R do.
export function pressRecord(lineIndex?: number): void {
  const rec = recorder();
  if (rec.phase === "recording") {
    void rec.stop();
    return;
  }
  if (rec.phase === "requesting") {
    rec.cancel();
    return;
  }
  if (rec.busy) {
    return;
  }
  const ctx = context();
  const model = previewModel(ctx.analysis.plan);
  const where = lineIndex ?? "new";
  const line =
    lineIndex === undefined ? undefined : ctx.state.cut.narration[lineIndex];
  if (line) {
    if (recordStart(model, line.at) !== line.at) {
      rec.refuse({
        where,
        mic: false,
        message:
          "This line is in cut footage or at the very end, so there is no picture to narrate over — move it first.",
      });
      return;
    }
    void rec.start({ at: line.at, lineIndex });
    return;
  }
  const at = recordStart(model, snapTime(ctx.playhead(), ctx.grid));
  if (at === undefined) {
    rec.refuse({
      where,
      mic: false,
      message:
        "There's no footage after the playhead to narrate over — move the playhead back.",
    });
    return;
  }
  void rec.start({ at });
}

// Cancel a recording in progress. False when there was none.
export function cancelRecording(): boolean {
  return active?.cancel() ?? false;
}

// ---------------------------------------------------------------------------
// Uploading and attaching.
// ---------------------------------------------------------------------------

// Types a browser gives audio files that the server knows by another name.
const ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/aac": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "video/webm": "audio/webm",
  "application/ogg": "audio/ogg",
};

const BY_EXTENSION: Record<string, string> = {
  webm: "audio/webm",
  weba: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

// The Content-Type to upload audio as (one of RECORDING_TYPES), from the
// blob's own type or, failing that, its file name. Undefined when the server
// won't take it. Pure.
export function uploadType(type: string, name = ""): string | undefined {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = ALIASES[base] ?? base;
  if (known in RECORDING_TYPES) {
    return known;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return name.includes(".") ? BY_EXTENSION[ext] : undefined;
}

// Upload `blob` and attach it: to narration line `lineIndex` when given (its
// text stays, as the caption and the record of what it says), else as a new
// line at `atSec` (source seconds). One undo step; the new or changed line is
// selected. Resolves with the saved file and its length.
export async function attachRecording(
  blob: Blob,
  atSec: number,
  lineIndex?: number
): Promise<UploadRecordingResponse> {
  const ctx = context();
  const name = blob instanceof File ? blob.name : "";
  const type = uploadType(blob.type, name);
  if (!type) {
    throw new Error(
      `${name || "that audio"} is ${blob.type || "of an unknown type"} — a recording must be WebM, Ogg, M4A, MP3 or WAV`
    );
  }
  const saved = await api.uploadRecording(blob, type);
  // A file got in after all: the last Record press's problem is moot.
  active?.clearProblem();
  ctx.session.recordings = [
    ...ctx.session.recordings.filter((r) => r.file !== saved.file),
    saved,
  ];
  ctx.state.edit((cut) => {
    const line = lineIndex === undefined ? undefined : cut.narration[lineIndex];
    if (line && lineIndex !== undefined) {
      line.audio = saved.file;
      return { kind: "line", index: lineIndex };
    }
    cut.narration.push({
      at: snapTime(atSec, ctx.grid),
      text: "",
      audio: saved.file,
    });
    return { kind: "line", index: cut.narration.length - 1 };
  });
  return saved;
}

// ---------------------------------------------------------------------------
// The views: Record buttons, the file picker, and the recording banner. Each
// view's update() is called whenever the recorder or the cut changes.
// ---------------------------------------------------------------------------

export interface RecorderView {
  update(): void;
}

// Pick an audio file and attach it, reporting the outcome in the status line.
async function attachPicked(
  input: HTMLInputElement,
  lineIndex: number | undefined
): Promise<void> {
  const ctx = context();
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  ctx.status(`Uploading ${file.name}…`);
  try {
    const saved = await attachRecording(file, ctx.playhead(), lineIndex);
    ctx.status(
      `Attached ${saved.file} (${saved.durationSec.toFixed(1)}s) — save to keep it`
    );
  } catch (err) {
    ctx.status(`Couldn't attach ${file.name}: ${errorText(err)}`, "error");
  }
}

// What the inline message adds after a microphone problem: the other way in.
function fallbackFor(lineIndex: number | undefined, hasAudio: boolean): string {
  if (lineIndex === undefined) {
    return "Add a narration line and use “Attach file…” instead.";
  }
  return hasAudio
    ? "“Replace from file…” still works."
    : "“Attach file…” still works.";
}

// How a Record button looks for line `lineIndex` (undefined: the new-line
// button) while the recorder is in `rec`'s state.
function recordLook(
  rec: NarrationRecorder,
  lineIndex: number | undefined,
  idle: string
): { disabled: boolean; live: boolean; text: string } {
  const mine = rec.target !== undefined && rec.target.lineIndex === lineIndex;
  if (!mine) {
    return { text: idle, live: false, disabled: rec.busy };
  }
  const text = {
    idle,
    requesting: "Waiting for the microphone…",
    recording: "Stop",
    uploading: "Saving…",
  }[rec.phase];
  return {
    text,
    live: rec.phase === "recording",
    disabled: rec.phase === "uploading",
  };
}

// The inline message under a Record button: the last press's problem, when
// it was this button's and nothing is being recorded now.
function problemText(
  rec: NarrationRecorder,
  lineIndex: number | undefined,
  hasAudio: boolean
): string {
  const problem = rec.problem;
  if (!problem || rec.busy || problem.where !== (lineIndex ?? "new")) {
    return "";
  }
  return problem.mic
    ? `${problem.message} ${fallbackFor(lineIndex, hasAudio)}`
    : problem.message;
}

// A Record button and the inline message for its problems: for line
// `lineIndex` (recording over its start) or, without one, a new line at the
// playhead.
export function recordButton(
  lineIndex: number | undefined,
  hasAudio: boolean
): RecorderView & { button: HTMLButtonElement; message: HTMLElement } {
  const isNew = lineIndex === undefined;
  const idle = isNew ? "Record narration" : "Record";
  const node = button(idle, () => pressRecord(lineIndex), {
    class: isNew ? "btn rec-btn" : "btn sm rec-btn",
    icon: "record",
    title: isNew
      ? "Record a new line from the microphone, starting at the playhead (R)"
      : "Record this line from the microphone, from its start (R)",
  });
  const message = h("p", {
    class: "mic-problem",
    hidden: true,
    attrs: { role: "alert" },
  });
  const label = node.querySelector("span");
  return {
    button: node,
    message,
    update() {
      const rec = recorder();
      const look = recordLook(rec, lineIndex, idle);
      if (label && label.textContent !== look.text) {
        label.textContent = look.text;
      }
      setIcon(node, look.live ? "stop" : "record");
      node.classList.toggle("live", look.live);
      node.disabled = look.disabled;
      const text = problemText(rec, lineIndex, hasAudio);
      message.hidden = text === "";
      if (message.textContent !== text) {
        message.textContent = text;
      }
    },
  };
}

// The controls that bring audio into a narration line: Record (from the
// microphone) and a file picker. For a line that already has audio both
// replace it.
export function recordingControls(
  lineIndex: number,
  hasAudio: boolean
): RecorderView & { buttons: HTMLElement[]; message: HTMLElement } {
  const record = recordButton(lineIndex, hasAudio);
  const input = h("input", {
    type: "file",
    accept: "audio/*",
    class: "file-input",
    on: {
      change: () => {
        void attachPicked(input, lineIndex);
      },
    },
  });
  const label = h(
    "label",
    { class: "btn file-btn" },
    input,
    icon("upload"),
    h("span", { text: hasAudio ? "Replace from file…" : "Attach file…" })
  );
  return {
    buttons: [record.button, label],
    message: record.message,
    update() {
      record.update();
      input.disabled = recorder().busy;
    },
  };
}

interface LevelMeter {
  close(): void;
  read(): number;
  stream: MediaStream;
}

// An AnalyserNode on the microphone, for the level meter. Never connected to
// the speakers.
function openMeter(stream: MediaStream): LevelMeter | undefined {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Context) {
    return;
  }
  try {
    const audio = new Context();
    void audio.resume().catch(() => undefined);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      stream,
      read() {
        analyser.getFloatTimeDomainData(samples);
        return levelOf(samples);
      },
      close() {
        void audio.close().catch(() => undefined);
      },
    };
  } catch {
    return;
  }
}

// The banner over the picture while a recording is on: a red dot, the
// elapsed time, the microphone level, and Stop and Cancel.
export function recordingBanner(): RecorderView & { element: HTMLElement } {
  const label = h("span", { class: "rec-label" });
  const elapsed = h("span", {
    class: "rec-clock",
    attrs: { "aria-label": "Recording time" },
  });
  const fill = h("span", { class: "rec-meter-fill" });
  const meterNode = h(
    "span",
    {
      class: "rec-meter",
      attrs: {
        role: "meter",
        "aria-label": "Microphone level",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "0",
      },
    },
    fill
  );
  const stop = button("Stop", () => void recorder().stop(), {
    class: "btn sm",
    icon: "stop",
    title: "Stop and keep the recording (R)",
  });
  const cancel = button("Cancel", () => recorder().cancel(), {
    class: "btn sm ghost",
    title: "Throw the recording away (Esc)",
  });
  const element = h(
    "div",
    { class: "rec-banner", hidden: true },
    h("span", { class: "rec-dot", attrs: { "aria-hidden": "true" } }),
    label,
    elapsed,
    meterNode,
    stop,
    cancel
  );

  let meter: LevelMeter | undefined;
  let shown = 0;
  let last = 0;
  let lastAria = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;

  function reducedMotion(): boolean {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function draw(now: number): void {
    const rec = recorder();
    elapsed.textContent = clock((now - rec.startedAt) / 1000);
    const level = meter ? meter.read() : 0;
    shown = meterLevel(shown, level, last ? (now - last) / 1000 : 0);
    last = now;
    fill.style.transform = `scaleX(${shown.toFixed(3)})`;
    // A screen reader hears the value only now and then.
    if (now - lastAria > 500) {
      lastAria = now;
      meterNode.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
    }
  }

  function schedule(): void {
    const interval = meterIntervalMs(reducedMotion());
    const tick = () => {
      frame = undefined;
      timer = undefined;
      if (recorder().phase !== "recording") {
        return;
      }
      draw(performance.now());
      schedule();
    };
    if (interval > 0) {
      timer = setTimeout(tick, interval);
    } else {
      frame = requestAnimationFrame(tick);
    }
  }

  function halt(): void {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    element,
    update() {
      const rec = recorder();
      element.hidden = !rec.busy;
      element.dataset.phase = rec.phase;
      stop.disabled = rec.phase !== "recording";
      cancel.disabled = rec.phase === "uploading";
      const text = {
        idle: "",
        requesting: "Waiting for the microphone…",
        recording: "Recording",
        uploading: "Saving the recording…",
      }[rec.phase];
      if (label.textContent !== text) {
        label.textContent = text;
      }
      const recording = rec.phase === "recording";
      elapsed.hidden = !recording;
      meterNode.hidden = !recording;
      if (!recording) {
        halt();
        return;
      }
      const stream = rec.stream;
      if (stream && meter?.stream !== stream) {
        meter?.close();
        meter = openMeter(stream);
      }
      if (frame === undefined && timer === undefined) {
        shown = 0;
        last = 0;
        draw(performance.now());
        schedule();
      }
    },
  };
}
