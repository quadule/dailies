// The edit file for a finished recording: `cut.json` in the session directory.
//
// A plain `session end` writes a seed cut (the run's own captions and step
// markers) beside the condensed recording. Editing the cut — by hand, through an
// agent, or later through an editor UI — and running `dailies cut render`
// rebuilds the session video from the clean condensed source plus these edits.
//
// Every time in a cut is SOURCE time: seconds into the clean condensed cut (the
// `*.precinematic.webm` sidecar), never into the rendered output. A cut range or
// a hold moves everything after it in the output, so edits stored in output time
// would drift the moment another edit landed before them. The renderer maps
// source → output on every render; the edits themselves never move.
//
// This module is pure: parsing, validation, the seed, and the timeline plan.
// Rendering (ffmpeg, TTS) lives in render.ts.

import {
  mergeWindows,
  type Segment,
  selectTree,
  subtractSpans,
} from "../video/condense.js";
import {
  NARRATOR_CHOICES,
  type NarratorChoice,
} from "../video/media-preferences.js";

export const CUT_FILE = "cut.json";
export const CUT_VERSION = 1;

// A recorded step's position, for orientation only. The renderer re-times steps
// from the session record, so editing these changes nothing.
export interface CutStep {
  at: number;
  name: string;
}

// A range of source footage to remove.
export interface CutRange {
  end: number;
  start: number;
}

// Freeze the frame at `at` for `seconds`. Everything after it plays later.
export interface CutHold {
  at: number;
  seconds: number;
}

// Play a range of source footage `rate` times faster, for a stretch a viewer
// only needs to see happen. The rate is a whole number because the renderer
// keeps every rate-th frame: a fractional stride would round differently on
// each range, and across hundreds of ranges the planned times would drift from
// the frames actually kept.
export interface CutSpeedup {
  end: number;
  rate: number;
  start: number;
}

// Fastest a speed-up may play. Past this a form being filled is a blur.
export const MAX_SPEEDUP_RATE = 8;

// Text in the caption band, with no voice.
export interface CutCaption {
  end: number;
  start: number;
  text: string;
}

// A spoken line starting at `at`. Voiced by TTS unless `audio` names a recorded
// file (relative to the session directory). The caption shows the spoken text
// while it plays; `caption` replaces that text, and "" shows no caption.
export interface CutLine {
  at: number;
  audio?: string;
  caption?: string;
  text: string;
}

// Who voices the TTS lines. `speed` scales the speaking pace (1 = normal).
export interface CutVoice {
  name?: string;
  narrator?: NarratorChoice;
  speed?: number;
}

export interface Cut {
  captions: CutCaption[];
  cuts: CutRange[];
  holds: CutHold[];
  narration: CutLine[];
  speedups: CutSpeedup[];
  steps: CutStep[];
  version: typeof CUT_VERSION;
  // The recording this cut finishes: its filename in the session's video/ dir.
  video: string;
  voice: CutVoice;
}

// ---------------------------------------------------------------------------
// Parsing. Hand-rolled rather than a schema library: the CLI has no zod
// dependency, and the errors need to read well to someone editing by hand.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class CutError extends Error {}

function num(o: Obj, key: string, where: string, min = 0): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new CutError(
      `${where}.${key} must be a number${min === 0 ? " ≥ 0" : ` ≥ ${min}`} (seconds)`
    );
  }
  return value;
}

function str(o: Obj, key: string, where: string): string {
  const value = o[key];
  if (typeof value !== "string") {
    throw new CutError(`${where}.${key} must be a string`);
  }
  return value;
}

function optStr(o: Obj, key: string, where: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, where);
}

// Refuse keys the renderer doesn't read. A misspelled key ("hold" for "holds",
// a per-line "voice") would otherwise parse cleanly and silently do nothing —
// exactly the mistake an editor, human or agent, can't see in the output.
function onlyKeys(o: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(o)) {
    if (allowed.includes(key)) {
      continue;
    }
    const guess = allowed.find(
      (a) => a === `${key}s` || `${a}s` === key || a === key.toLowerCase()
    );
    const prefix = where ? `${where}: ` : "";
    throw new CutError(
      `${prefix}unknown key "${key}"${guess ? ` — did you mean "${guess}"?` : ` (expected ${allowed.join(", ")})`}`
    );
  }
}

function list<T>(
  o: Obj,
  key: string,
  keys: readonly string[],
  each: (item: Obj, where: string) => T
): T[] {
  const value = o[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CutError(`${key} must be a list`);
  }
  return value.map((item, i) => {
    const where = `${key}[${i}]`;
    if (!isObj(item)) {
      throw new CutError(`${where} must be an object`);
    }
    onlyKeys(item, keys, where);
    return each(item, where);
  });
}

function parseVoice(value: unknown): CutVoice {
  if (value === undefined) {
    return {};
  }
  if (!isObj(value)) {
    throw new CutError("voice must be an object");
  }
  onlyKeys(value, ["narrator", "name", "speed"], "voice");
  const voice: CutVoice = {};
  if (value.narrator !== undefined) {
    const narrator = str(value, "narrator", "voice");
    if (!(NARRATOR_CHOICES as readonly string[]).includes(narrator)) {
      throw new CutError(
        `voice.narrator must be one of ${NARRATOR_CHOICES.join(", ")}`
      );
    }
    voice.narrator = narrator as NarratorChoice;
  }
  voice.name = optStr(value, "name", "voice");
  if (voice.name !== undefined && voice.narrator === undefined) {
    // A voice name only means something to one provider ("Ava (Premium)" is a
    // macOS voice, "Charon" a Gemini one), so it can't stand alone.
    throw new CutError(
      "voice.name needs voice.narrator to say whose voice it is"
    );
  }
  if (value.speed !== undefined) {
    const speed = num(value, "speed", "voice");
    if (speed < 0.5 || speed > 2) {
      throw new CutError("voice.speed must be between 0.5 and 2");
    }
    voice.speed = speed;
  }
  return voice;
}

function parseSpeedups(raw: Obj): CutSpeedup[] {
  const speedups = list(raw, "speedups", ["start", "end", "rate"], (o, w) => {
    const speedup = {
      start: num(o, "start", w),
      end: num(o, "end", w),
      rate: o.rate as number,
    };
    if (speedup.end <= speedup.start) {
      throw new CutError(`${w}.end must be after its start`);
    }
    if (
      !Number.isInteger(speedup.rate) ||
      speedup.rate < 2 ||
      speedup.rate > MAX_SPEEDUP_RATE
    ) {
      throw new CutError(
        `${w}.rate must be a whole number from 2 to ${MAX_SPEEDUP_RATE}`
      );
    }
    return speedup;
  });
  const sorted = [...speedups].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as CutSpeedup;
    const cur = sorted[i] as CutSpeedup;
    if (cur.start < prev.end) {
      throw new CutError(
        `speedups overlap at ${fmt(cur.start)} — merge them or pick one rate`
      );
    }
  }
  return sorted;
}

// Parse a cut.json document. Returns a readable error instead of throwing.
export function parseCut(raw: unknown): { cut: Cut } | { error: string } {
  try {
    if (!isObj(raw)) {
      throw new CutError("the cut must be a JSON object");
    }
    onlyKeys(
      raw,
      [
        "version",
        "video",
        "voice",
        "steps",
        "cuts",
        "holds",
        "speedups",
        "captions",
        "narration",
      ],
      ""
    );
    if (raw.version !== CUT_VERSION) {
      throw new CutError(`version must be ${CUT_VERSION}`);
    }
    const cut: Cut = {
      version: CUT_VERSION,
      video: str(raw, "video", "cut"),
      steps: list(raw, "steps", ["name", "at"], (o, w) => ({
        name: str(o, "name", w),
        at: num(o, "at", w),
      })),
      cuts: list(raw, "cuts", ["start", "end"], (o, w) => {
        const range = { start: num(o, "start", w), end: num(o, "end", w) };
        if (range.end <= range.start) {
          throw new CutError(`${w}.end must be after its start`);
        }
        return range;
      }),
      holds: list(raw, "holds", ["at", "seconds"], (o, w) => ({
        at: num(o, "at", w),
        seconds: num(o, "seconds", w),
      })),
      speedups: parseSpeedups(raw),
      captions: list(raw, "captions", ["start", "end", "text"], (o, w) => {
        const caption = {
          start: num(o, "start", w),
          end: num(o, "end", w),
          text: str(o, "text", w),
        };
        if (caption.end <= caption.start) {
          throw new CutError(`${w}.end must be after its start`);
        }
        return caption;
      }),
      narration: list(
        raw,
        "narration",
        ["at", "text", "audio", "caption"],
        (o, w) => {
          const line: CutLine = {
            at: num(o, "at", w),
            text: str(o, "text", w),
          };
          const audio = optStr(o, "audio", w);
          const caption = optStr(o, "caption", w);
          if (audio !== undefined) {
            line.audio = audio;
          }
          if (caption !== undefined) {
            line.caption = caption;
          }
          if (!(line.text.trim() || line.audio)) {
            throw new CutError(`${w} needs text to speak or an audio file`);
          }
          return line;
        }
      ),
      voice: parseVoice(raw.voice),
    };
    return { cut };
  } catch (err) {
    if (err instanceof CutError) {
      return { error: err.message };
    }
    throw err;
  }
}

// Serialize a cut the way it is written to disk: stable key order, two-space
// indent, trailing newline — so a hand edit diffs cleanly against a re-write.
export function formatCut(cut: Cut): string {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const ordered = {
    version: cut.version,
    video: cut.video,
    voice: cut.voice,
    steps: cut.steps.map((s) => ({ name: s.name, at: round(s.at) })),
    cuts: cut.cuts.map((c) => ({ start: round(c.start), end: round(c.end) })),
    holds: cut.holds.map((h) => ({ at: round(h.at), seconds: h.seconds })),
    speedups: cut.speedups.map((v) => ({
      start: round(v.start),
      end: round(v.end),
      rate: v.rate,
    })),
    captions: cut.captions.map((c) => ({
      start: round(c.start),
      end: round(c.end),
      text: c.text,
    })),
    narration: cut.narration.map((l) => ({ ...l, at: round(l.at) })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// The cut `session end` writes: the run's own captions and step markers, plus
// speed-ups for the footage nobody needs to watch in real time (see
// seedSpeedups). Rendering it reproduces the plain finalize.
export function seedCut(args: {
  video: string;
  steps: { name: string; videoTime?: number; skim?: boolean }[];
  captions: { startSec: number; endSec: number; text: string }[];
  // Length of the condensed source. Without it the stretch after the last
  // caption has no end, so no speed-up is seeded there.
  durationSec?: number;
}): Cut {
  return {
    version: CUT_VERSION,
    video: args.video,
    voice: {},
    steps: args.steps.flatMap((s) =>
      s.videoTime === undefined ? [] : [{ name: s.name, at: s.videoTime }]
    ),
    cuts: [],
    holds: [],
    speedups: seedSpeedups(args),
    captions: args.captions.map((c) => ({
      start: c.startSec,
      end: c.endSec,
      text: c.text,
    })),
    narration: [],
  };
}

// A stretch the agent marked with `run --skim` (setup, a detour, a form that
// has to be filled to get somewhere) aims to play in about this long, up to
// MAX_SPEEDUP_RATE.
const SKIM_TARGET_SEC = 8;

// Uncaptioned footage this long or longer plays fast. A caption is how a run
// says what matters; a long stretch with none is the run getting somewhere.
const QUIET_MIN_SEC = 5;
// …aiming for about this long, no faster than QUIET_MAX_RATE. Same target and
// ceiling as the cinematic pass's un-narrated footage (narrate.ts).
const QUIET_TARGET_SEC = 4;
const QUIET_MAX_RATE = 4;

// A caption plays at real speed from a beat before it appears to a beat after
// it goes: the action it explains usually lands while it is on screen.
const CAPTION_LEAD_SEC = 0.5;
const CAPTION_TAIL_SEC = 1;

function rateFor(
  lengthSec: number,
  targetSec: number,
  maxRate: number
): number {
  return Math.min(maxRate, Math.max(2, Math.ceil(lengthSec / targetSec)));
}

// The speed-ups a fresh cut starts with. Two sources, in this order:
//
// 1. Skimmed steps. A run of consecutive steps recorded with `run --skim`,
//    from the first one's start to the next unskimmed step. Captions inside
//    keep showing for their full reading time while the footage runs fast
//    under them (outputCaptions), because a detour is exactly where a run
//    explains itself most.
// 2. Quiet stretches, as a fallback for runs that marked nothing: footage
//    outside every caption, QUIET_MIN_SEC or longer. Only when the run showed
//    captions at all — with none there is no signal for what matters, and the
//    whole film playing at 4x is not a safe guess.
//
// Pure → unit-tested.
export function seedSpeedups(args: {
  steps: { videoTime?: number; skim?: boolean }[];
  captions: { startSec: number; endSec: number }[];
  durationSec?: number;
}): CutSpeedup[] {
  const end = args.durationSec ?? Number.POSITIVE_INFINITY;
  const timed = args.steps.filter(
    (s): s is { videoTime: number; skim?: boolean } => s.videoTime !== undefined
  );
  const skims: Segment[] = [];
  for (let i = 0; i < timed.length; i++) {
    const first = timed[i] as { videoTime: number; skim?: boolean };
    if (!first.skim) {
      continue;
    }
    let j = i;
    while (j < timed.length && timed[j]?.skim) {
      j++;
    }
    const stop = timed[j]?.videoTime ?? end;
    if (Number.isFinite(stop) && stop > first.videoTime) {
      skims.push({ start: first.videoTime, end: Math.min(stop, end) });
    }
    i = j - 1;
  }
  const speedups: CutSpeedup[] = mergeWindows(skims, end).map((w) => ({
    ...w,
    rate: rateFor(w.end - w.start, SKIM_TARGET_SEC, MAX_SPEEDUP_RATE),
  }));

  if (args.captions.length > 0 && Number.isFinite(end)) {
    const spoken = args.captions.map((c) => ({
      start: c.startSec - CAPTION_LEAD_SEC,
      end: c.endSec + CAPTION_TAIL_SEC,
    }));
    const quiet = subtractSpans([{ start: 0, end }], [...spoken, ...skims]);
    for (const span of quiet) {
      const length = span.end - span.start;
      if (length >= QUIET_MIN_SEC) {
        speedups.push({
          ...span,
          rate: rateFor(length, QUIET_TARGET_SEC, QUIET_MAX_RATE),
        });
      }
    }
  }
  return speedups.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Timeline plan. Pure → unit-tested.
// ---------------------------------------------------------------------------

// One contiguous stretch of source footage in the output, with optional frozen
// frames before and after it. `outStart` is where the piece (its start hold
// included) begins in the output.
export interface CutPiece {
  endHoldSec: number;
  outStart: number;
  // Present when the piece plays fast: every rate-th frame is kept.
  rate?: number;
  srcEnd: number;
  srcStart: number;
  startHoldSec: number;
}

export interface CutPlan {
  fps: number;
  // True when the plan is the source unchanged — nothing cut, nothing held — so
  // the renderer can skip re-encoding the footage.
  identity: boolean;
  outDurationSec: number;
  pieces: CutPiece[];
  sourceDurationSec: number;
  warnings: string[];
}

// Snap to the frame grid. Every slice boundary is a whole frame, so a slice is
// either empty or at least one frame long, and the planned output length is the
// length the encoder actually produces.
function snapper(fps: number): (t: number) => number {
  return (t) => Math.round(t * fps) / fps;
}

function fmt(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

// Source frames a piece spans, and how many of them it keeps.
function pieceFrames(p: CutPiece, fps: number): { span: number; kept: number } {
  const span = Math.round(p.srcEnd * fps) - Math.round(p.srcStart * fps);
  return { span, kept: Math.ceil(span / (p.rate ?? 1)) };
}

// Output seconds of a piece's footage, holds excluded.
function footageSec(p: CutPiece, fps: number): number {
  return p.rate ? pieceFrames(p, fps).kept / fps : p.srcEnd - p.srcStart;
}

function pieceSec(p: CutPiece, fps: number): number {
  return p.startHoldSec + footageSec(p, fps) + p.endHoldSec;
}

function restack(pieces: CutPiece[], fps: number): number {
  let out = 0;
  for (const piece of pieces) {
    piece.outStart = out;
    out += pieceSec(piece, fps);
  }
  return out;
}

// Split pieces where a speed-up starts or ends, and give each the rate of the
// speed-up it falls in. A piece's holds stay on its outer ends.
function applySpeedups(pieces: CutPiece[], speedups: CutSpeedup[]): CutPiece[] {
  if (speedups.length === 0) {
    return pieces;
  }
  const bounds = speedups.flatMap((v) => [v.start, v.end]);
  const out: CutPiece[] = [];
  for (const piece of pieces) {
    const inside = [
      ...new Set(bounds.filter((b) => b > piece.srcStart && b < piece.srcEnd)),
    ].sort((a, b) => a - b);
    const edges = [piece.srcStart, ...inside, piece.srcEnd];
    for (let i = 0; i < edges.length - 1; i++) {
      const srcStart = edges[i] as number;
      const srcEnd = edges[i + 1] as number;
      const mid = (srcStart + srcEnd) / 2;
      const rate = speedups.find((v) => mid > v.start && mid < v.end)?.rate;
      out.push({
        srcStart,
        srcEnd,
        startHoldSec: i === 0 ? piece.startHoldSec : 0,
        endHoldSec: i === edges.length - 2 ? piece.endHoldSec : 0,
        outStart: 0,
        ...(rate && rate > 1 ? { rate } : {}),
      });
    }
  }
  return out;
}

export function planCut(
  cut: Pick<Cut, "cuts" | "holds"> & Partial<Pick<Cut, "speedups">>,
  source: { durationSec: number; fps: number }
): CutPlan {
  const fps = source.fps > 0 ? source.fps : 30;
  const snap = snapper(fps);
  const duration = snap(source.durationSec);
  const warnings: string[] = [];

  const removed = mergeWindows(
    cut.cuts.map((c) => ({ start: snap(c.start), end: snap(c.end) })),
    duration
  );
  const keeps = subtractSpans([{ start: 0, end: duration }], removed).filter(
    (k) => k.end - k.start > 0
  );

  // Group holds by their snapped frame; drop the ones that land in removed
  // footage (there is no frame there to freeze).
  const holdAt = new Map<number, number>();
  for (const hold of cut.holds) {
    if (hold.seconds <= 0) {
      continue;
    }
    const at = snap(Math.min(hold.at, duration));
    const kept = keeps.some((k) => at >= k.start && at <= k.end);
    if (!kept) {
      warnings.push(
        `hold at ${fmt(hold.at)} is inside cut footage and was skipped`
      );
      continue;
    }
    // Held in whole frames too: the renderer freezes by repeating frames, so a
    // hold that isn't a frame multiple would drift the planned times.
    holdAt.set(at, snap((holdAt.get(at) ?? 0) + hold.seconds));
  }
  // A hold on a boundary shared by two keeps can't happen (mergeWindows joins
  // touching cuts, so keeps never touch), so each point belongs to one keep.
  const points = [...holdAt.keys()].sort((a, b) => a - b);

  const pieces: CutPiece[] = [];
  for (const keep of keeps) {
    let cursor = keep.start;
    let startHold = holdAt.get(keep.start) ?? 0;
    for (const p of points) {
      if (p <= keep.start || p > keep.end) {
        continue;
      }
      pieces.push({
        srcStart: cursor,
        srcEnd: p,
        startHoldSec: startHold,
        endHoldSec: holdAt.get(p) ?? 0,
        outStart: 0,
      });
      startHold = 0;
      cursor = p;
    }
    if (cursor < keep.end) {
      pieces.push({
        srcStart: cursor,
        srcEnd: keep.end,
        startHoldSec: startHold,
        endHoldSec: 0,
        outStart: 0,
      });
    }
  }
  const speedups = (cut.speedups ?? [])
    .map((v) => ({
      start: snap(v.start),
      end: snap(Math.min(v.end, duration)),
      rate: v.rate,
    }))
    .filter((v) => v.end > v.start && v.rate > 1);
  const timed = applySpeedups(pieces, speedups);
  const outDurationSec = restack(timed, fps);
  return {
    fps,
    identity:
      removed.length === 0 && points.length === 0 && speedups.length === 0,
    outDurationSec,
    pieces: timed,
    sourceDurationSec: duration,
    warnings,
  };
}

// Extend the final frame by `seconds` — used when a spoken line would otherwise
// run past the end of the picture and be cut off.
export function extendTail(plan: CutPlan, seconds: number): CutPlan {
  if (seconds <= 0 || plan.pieces.length === 0) {
    return plan;
  }
  const pieces = plan.pieces.map((p) => ({ ...p }));
  const last = pieces.at(-1) as CutPiece;
  last.endHoldSec = snapper(plan.fps)(last.endHoldSec + seconds);
  return {
    ...plan,
    pieces,
    identity: false,
    outDurationSec: restack(pieces, plan.fps),
  };
}

// The ffmpeg video filter that turns the source into the planned footage, in
// one pass: keep the pieces' frames (`select` by frame number on a constant-rate
// stream; a sped-up piece keeps every rate-th one), renumber them, then repeat a
// frame wherever a hold freezes it (`loop` with size=1). Returns "" for the
// identity plan.
//
// One stream, no `split`: trimming each piece separately and concatenating
// would make ffmpeg buffer decoded frames for every later piece until the
// earlier ones are consumed. The loops are applied from the last frame back so
// each one's index is still the post-select index — inserting frames only
// shifts what comes after. The select terms are joined as a balanced tree
// (selectTree), so there is no cap on how many stretches a cut keeps.
// Pure → unit-tested.
export function cutVideoFilter(plan: CutPlan): string {
  if (plan.identity) {
    return "";
  }
  const fps = plan.fps;
  const frame = (sec: number) => Math.round(sec * fps);
  // Contiguous real-speed pieces (split only by a hold) are one kept range of
  // frames. A sped-up piece is its own range: its stride starts on its first
  // frame, which is what pieceFrames counted.
  const ranges: { start: number; end: number; rate: number }[] = [];
  const loops: { at: number; count: number }[] = [];
  let out = 0;
  for (const piece of plan.pieces) {
    const start = frame(piece.srcStart);
    const end = frame(piece.srcEnd);
    const rate = piece.rate ?? 1;
    const prev = ranges.at(-1);
    if (prev && prev.end === start && prev.rate === 1 && rate === 1) {
      prev.end = end;
    } else {
      ranges.push({ start, end, rate });
    }
    const length = pieceFrames(piece, fps).kept;
    if (piece.startHoldSec > 0) {
      loops.push({ at: out, count: frame(piece.startHoldSec) });
    }
    if (piece.endHoldSec > 0) {
      loops.push({ at: out + length - 1, count: frame(piece.endHoldSec) });
    }
    out += length;
  }
  const select = selectTree(
    ranges
      .filter((r) => r.end > r.start)
      .map((r) =>
        r.rate === 1
          ? `between(n,${r.start},${r.end - 1})`
          : `between(n,${r.start},${r.end - 1})*not(mod(n-${r.start},${r.rate}))`
      )
  );
  const chain = [
    `fps=${fps}`,
    `select='${select}'`,
    "setpts=N/FRAME_RATE/TB",
    ...loops
      .filter((l) => l.count > 0)
      .sort((a, b) => b.at - a.at)
      .map((l) => `loop=loop=${l.count}:size=1:start=${l.at}`),
  ];
  if (loops.length > 0) {
    chain.push("setpts=N/FRAME_RATE/TB");
  }
  return chain.join(",");
}

// Where a source time lands in the output. A time inside removed footage maps
// to where the footage after the cut begins, flagged `removed`. A time that is
// exactly at a hold maps to the START of the freeze, so a caption or line placed
// on a hold plays over it rather than after it. Inside a sped-up piece a time
// maps to the first kept frame at or after it.
export function mapTime(
  plan: CutPlan,
  t: number
): { out: number; removed: boolean } {
  const fps = plan.fps;
  const at = snapper(fps)(t);
  const eps = 1e-6;
  const into = (p: CutPiece, src: number) =>
    p.rate
      ? Math.ceil(
          (Math.round(src * fps) - Math.round(p.srcStart * fps)) / p.rate
        ) / fps
      : src - p.srcStart;
  for (const p of plan.pieces) {
    if (at < p.srcStart - eps) {
      return { out: p.outStart, removed: true };
    }
    if (Math.abs(at - p.srcStart) <= eps) {
      return { out: p.outStart, removed: false };
    }
    if (at < p.srcEnd - eps) {
      return {
        out: p.outStart + p.startHoldSec + into(p, at),
        removed: false,
      };
    }
    if (Math.abs(at - p.srcEnd) <= eps && p.endHoldSec > 0) {
      return {
        out: p.outStart + p.startHoldSec + footageSec(p, fps),
        removed: false,
      };
    }
  }
  const last = plan.pieces.at(-1);
  return {
    out: plan.outDurationSec,
    removed: !last || at > last.srcEnd + eps,
  };
}

// Shortest caption worth keeping once cuts have eaten into it.
const MIN_CAPTION_SEC = 0.3;

export interface OutputCue {
  end: number;
  start: number;
  text: string;
}

// Captions in output time: the free-standing captions plus each spoken line's
// caption over its clip. When two overlap, the earlier yields to the next — two
// cues on screen at once would stack in the band. Pure → unit-tested.
export function outputCaptions(args: {
  plan: CutPlan;
  captions: CutCaption[];
  lines: { line: CutLine; outStart: number; durationSec: number }[];
  warnings: string[];
}): OutputCue[] {
  const { plan, captions, lines, warnings } = args;
  const cues: OutputCue[] = [];
  for (const caption of captions) {
    const start = mapTime(plan, caption.start);
    const end = mapTime(plan, caption.end);
    // Over sped-up footage a caption keeps its own length, holding while the
    // picture runs fast underneath — its source span was sized to be read. A
    // cut through either end is an edit to the caption, so that one shrinks.
    const shown =
      start.removed || end.removed
        ? end.out - start.out
        : Math.max(end.out - start.out, caption.end - caption.start);
    if (shown < MIN_CAPTION_SEC) {
      warnings.push(
        `caption "${caption.text}" is inside cut footage and was dropped`
      );
      continue;
    }
    cues.push({ start: start.out, end: start.out + shown, text: caption.text });
  }
  for (const { line, outStart, durationSec } of lines) {
    const text = line.caption ?? line.text;
    if (text.trim()) {
      cues.push({ start: outStart, end: outStart + durationSec, text });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    const cue = cues[i] as OutputCue;
    const next = cues[i + 1] as OutputCue;
    if (cue.end > next.start) {
      cue.end = next.start;
    }
  }
  return cues.filter((c) => c.end - c.start > 0);
}

// Spoken lines in output time, in order, with what's wrong with them: a line in
// cut footage is dropped; one that runs into the next is flagged with the hold
// that would fix it. Returns how far the last line runs past the picture, so the
// caller can extend the tail instead of cutting the voice off. Pure → tested.
export function layoutLines(args: {
  plan: CutPlan;
  lines: { line: CutLine; durationSec: number }[];
  warnings: string[];
}): {
  placed: { line: CutLine; outStart: number; durationSec: number }[];
  overrunSec: number;
} {
  const { plan, warnings } = args;
  const placed: { line: CutLine; outStart: number; durationSec: number }[] = [];
  for (const { line, durationSec } of args.lines) {
    const mapped = mapTime(plan, line.at);
    if (mapped.removed) {
      warnings.push(
        `line at ${fmt(line.at)} ("${line.text}") is inside cut footage and was dropped`
      );
      continue;
    }
    placed.push({ line, outStart: mapped.out, durationSec });
  }
  placed.sort((a, b) => a.outStart - b.outStart);
  for (let i = 0; i < placed.length - 1; i++) {
    const cur = placed[i] as (typeof placed)[number];
    const next = placed[i + 1] as (typeof placed)[number];
    const overlap = cur.outStart + cur.durationSec - next.outStart;
    if (overlap > 0.05) {
      warnings.push(
        `line at ${fmt(cur.line.at)} runs ${fmt(overlap)} into the line at ${fmt(next.line.at)} — add a hold of about ${Math.ceil(overlap * 10) / 10}s at ${fmt(next.line.at)}, or move a line`
      );
    }
  }
  const last = placed.at(-1);
  const overrunSec = last
    ? Math.max(0, last.outStart + last.durationSec - plan.outDurationSec)
    : 0;
  return { placed, overrunSec };
}
