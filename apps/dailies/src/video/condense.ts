// Post-process session videos so reviewers don't scrub through dead air:
// drop the leading still segment (white frames before the first page paints)
// and cap every other motionless stretch at MAX_STILL_SEC seconds.
//
// Two ffmpeg passes over each *.webm:
//   1. A per-frame MOTION TIMELINE (analysis only): the temporal difference of
//      each frame against the one before it, reduced to the LARGEST per-pixel
//      change in that difference (signalstats YMAX). Printed per frame by the
//      metadata filter, parsed into still spans here.
//   2. select/setpts re-encode keeping only the computed segments — decodes
//      every frame and filters by timestamp, so cuts are frame-accurate. A
//      Playwright VP8 screencast emits a single keyframe at t=0, so a
//      keyframe-bound stream copy would silently drop any kept segment that
//      doesn't start at one (e.g. a cursor glide / click after a >1s dwell).
//
// Why a per-pixel measure and not ffmpeg's own freezedetect, which this pass
// replaced: freezedetect thresholds the MEAN absolute difference over the whole
// frame, and the virtual cursor is ~28px on a 1440x900 frame — about 0.06% of
// the picture. A glide moves it well under freezedetect's noise floor, so
// freezedetect reported a park-glide-click-react stretch as ONE long freeze and
// the editor could not tell a cursor crossing the screen from a dead page.
// Measured on a real 51s session: 43.9s of it read as "frozen", the trim floor
// (MAX_STILL_SEC plus a lead-out reserved to protect those invisible glides)
// meant almost no freeze was individually trimmable, and the pass removed 1.3s
// of 51.1s while still cutting through glides it could not see.
//
// Counting CHANGED PIXELS instead sees the cursor clearly, and because a still
// span is then motionless by definition, any cut inside one joins
// pixel-identical frames. On the same session that took 51.1s to 28.0s with
// every one of its 224 frames of real motion intact.
//
// ffmpeg is an OPTIONAL dependency: resolved from $DAILIES_FFMPEG, then PATH.
// It must be a FULL build — Playwright ships its own ffmpeg alongside Chromium
// and we deliberately don't fall back to it: that binary is compiled with
// --disable-everything plus pad/crop/scale, so it has none of the filters this
// pipeline needs (tblend/lutyuv/signalstats/metadata/select here; adelay/amix/
// drawtext/subtitles in the cinematic pass). Using it only turned a clear
// "ffmpeg not found" into an opaque "Command failed" several stages later.
// When ffmpeg is unavailable — or when either pass fails — the original video is
// kept untouched and the report still renders.
import { execFile } from "node:child_process";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Logger } from "dailies-logger";

const execFileAsync = promisify(execFile);

// Collapse any still stretch to at most this many seconds. 0 removes dead air
// entirely: the frame-accurate re-encode means we don't need a keyframe cushion,
// and the animated cursor keeps real interactions moving, so a motionless
// stretch carries no information worth keeping. (Overlays that must survive — a
// held caption — animate continuously so their frames never read as "still".)
export const MAX_STILL_SEC = 1;

// A still span starting within this many seconds of t=0 counts as the pre-load
// segment and is dropped entirely instead of capped.
const LEADING_STILL_SEC = 1;

// A pixel counts as CHANGED when it moves by more than this between frames
// (8-bit luma, so 0-255). The analysis pass thresholds each difference frame
// at this value and then reports what FRACTION of the picture changed, so this
// constant lives inside MOTION_FILTER rather than being applied here.
//
// Measured on a real session: a statically-held page is byte-identical frame to
// frame on a first-generation Playwright screencast, and re-encoding it lifts
// the quietest pixels only as far as 8. 16 clears that noise with room to spare
// while still catching the faintest thing a viewer can see.
const MOTION_DELTA_THRESHOLD = 16;

// A BLINKING TEXT CARET is the one thing that can defeat this pass, and it is
// handled in the RECORDING rather than here: the session init script paints the
// caret transparent, so it never reaches the video. The reason it cannot be
// filtered out at this stage is worth recording, because the obvious fix does
// not work.
//
// A caret left in a focused field toggles about twice a second, and since the
// signal is a frame-to-frame difference each toggle is exactly ONE changed
// frame. Those single frames chop a long dead wait into ~0.46s stills, each too
// short to trim, so a page doing nothing but blinking survives in full. The
// tempting guard is to ignore bursts that are brief AND small — but measured
// against real footage the areas overlap the wrong way round:
//
//   typing one character   0.00003 - 0.00009 of the frame, one frame per key
//   a 2x18px caret toggle  0.000028                     , one frame per toggle
//   a checkbox ticking     0.00015
//   a menu opening         0.046
//
// A typed character changes FEWER pixels than a caret and arrives the same way
// — alone, between stills — so every bound that absorbs the caret also absorbs
// typing, and text would appear in a field instantly instead of being typed.
// (Spacing does separate them: keystrokes land ~0.08s apart, a caret ~0.5s. A
// periodicity test would work and is not worth the complexity while the
// recording can simply not blink.)
//
// What remains unhandled by either fix is a genuine LOOPING ANIMATION — a
// spinner on a slow page, a marquee. It reads as continuous real motion, so its
// stretch is kept whole. The interaction-aware branch bounds that case by step
// window; outside one, a long spinner will not be trimmed.

// Shortest still span worth trimming. Below this the saving is imperceptible
// and the cut only risks chopping the tail of an animation, so a shorter still
// is left alone.
const MIN_STILL_SEC = 0.4;

// The motion pass analyses at HALF resolution with nearest-neighbour scaling —
// 3.4x cheaper than full res on the measured session (3.0s vs 9.9s for 51s of
// 1440x900) with no meaningful loss. Nearest-neighbour matters: an averaging
// filter would dilute a small high-contrast mover (the cursor) into the
// surrounding pixels, which is exactly the signal this pass exists to see.
//
// `lutyuv` binarises the difference at MOTION_DELTA_THRESHOLD, so signalstats'
// YAVG comes back as 255 x (fraction of pixels that changed) — one number per
// frame carrying both WHETHER anything moved and HOW MUCH of the picture did.
const MOTION_FILTER = `format=gray,scale=iw/2:ih/2:flags=neighbor,tblend=all_mode=difference,lutyuv=y='if(gt(val,${MOTION_DELTA_THRESHOLD}),255,0)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`;

// Fallback frame interval when the timeline is too short to measure one.
const FALLBACK_FRAME_INTERVAL_SEC = 0.04;

// Don't bother re-encoding to save less than this many seconds.
const MIN_SAVINGS_SEC = 1;

// Shortest individual cut worth making. A still only a few frames longer than
// MAX_STILL_SEC would otherwise be "trimmed" by one or two frames — which saves
// nothing, spends two `select` terms (they are capped, see MAX_SELECT_TERMS) and
// risks a single-frame judder at the join. So a still has to run this much past
// the cap before its middle is cut.
const MIN_CUT_SEC = 0.25;

// Max `between(t,…)` terms in a single `select` expression. ffmpeg's expression
// evaluator fails to parse/allocate past ~100 terms ("Error while parsing
// expression" / "Cannot allocate memory"), which aborts the whole encode — so a
// long session with many kept segments would silently keep its raw video. When
// keeps exceed this, we encode in batches and concat them. Kept well under the
// observed ~100 ceiling: it varies by ffmpeg build, and the extra decode pass is
// cheap insurance.
export const MAX_SELECT_TERMS = 50;

// The motion pass decodes every frame and runs signalstats over it, so it is
// far heavier than the freezedetect pass it replaced (~3s per minute of
// 1440x900 video, measured) — generous enough for a long session.
const ANALYZE_TIMEOUT_MS = 300_000;
const ENCODE_TIMEOUT_MS = 300_000;

export interface Segment {
  end: number;
  start: number;
}

// One analysed frame: its presentation time and the fraction of the picture
// (0-1) that changed between it and the frame before it.
export interface MotionFrame {
  area: number;
  t: number;
}

export interface MotionTimeline {
  durationSec: number;
  frames: MotionFrame[];
  // Measured seconds per frame — the width of the interval each frame's area
  // describes, and the granularity of every span derived from it.
  intervalSec: number;
}

// A run of consecutive frames in which something changed.
export interface MotionBurst {
  end: number;
  // How many frames the burst spans.
  frameCount: number;
  // Largest single-frame change in the burst, as a fraction of the picture.
  maxArea: number;
  start: number;
}

export interface MotionAnalysis {
  durationSec: number;
  // Spans with no visible change. Sorted, disjoint.
  stills: Segment[];
}

// signalstats reports the mean of the binarised difference plane, where a
// changed pixel is 255 — so dividing by 255 gives the fraction that changed.
const SIGNALSTATS_FULL_SCALE = 255;

// Parse the motion pass's per-frame metadata. The metadata filter prints two
// lines per frame — `frame:N pts:… pts_time:T` then `lavfi.signalstats.YAVG=A`
// — so they are read as pairs.
//
// `tblend` emits one frame per INPUT PAIR, so the first source frame has no
// entry and the timeline starts one interval in; a frame timed T describes the
// interval (T - intervalSec, T]. The total duration is the last frame's time
// plus one interval, which is why no separate -progress pass is needed.
// Pure → unit-tested.
export function parseMotionOutput(metadata: string): MotionTimeline {
  const frames: MotionFrame[] = [];
  const events = metadata.matchAll(
    /pts_time:([\d.]+)\s*\r?\n\s*lavfi\.signalstats\.YAVG=([\d.eE+-]+)/g
  );
  for (const [, time, mean] of events) {
    const t = Number(time);
    const scaled = Number(mean);
    if (Number.isFinite(t) && Number.isFinite(scaled)) {
      frames.push({ area: scaled / SIGNALSTATS_FULL_SCALE, t });
    }
  }
  const intervalSec = medianInterval(frames);
  const last = frames.at(-1)?.t;
  return {
    durationSec: last === undefined ? 0 : last + intervalSec,
    frames,
    intervalSec,
  };
}

// Median gap between consecutive frame times. The median (not the mean) so a
// single dropped frame — a screencast stalls while the page is busy — doesn't
// stretch the interval every span is measured against.
function medianInterval(frames: MotionFrame[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const gap = (frames[i]?.t ?? 0) - (frames[i - 1]?.t ?? 0);
    if (gap > 0) {
      gaps.push(gap);
    }
  }
  if (gaps.length === 0) {
    return FALLBACK_FRAME_INTERVAL_SEC;
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? FALLBACK_FRAME_INTERVAL_SEC;
}

// Group the timeline's changed frames into runs. A frame's area describes the
// interval ENDING at its time, so a run covers from one interval before its
// first frame to the time of its last. Pure → unit-tested.
export function motionBursts(timeline: MotionTimeline): MotionBurst[] {
  const { frames, intervalSec } = timeline;
  const bursts: MotionBurst[] = [];
  let open: MotionBurst | undefined;
  for (const frame of frames) {
    if (frame.area <= 0) {
      open = undefined;
      continue;
    }
    if (open) {
      open.end = frame.t;
      open.frameCount += 1;
      open.maxArea = Math.max(open.maxArea, frame.area);
      continue;
    }
    open = {
      start: Math.max(0, frame.t - intervalSec),
      end: frame.t,
      frameCount: 1,
      maxArea: frame.area,
    };
    bursts.push(open);
  }
  return bursts;
}

// Reduce a motion timeline to the spans where nothing changed: the gaps between
// its motion bursts. Runs shorter than `minStillSec` are dropped as not worth
// cutting. Pure → unit-tested.
export function stillSpans(
  timeline: MotionTimeline,
  minStillSec: number = MIN_STILL_SEC
): Segment[] {
  const spans: Segment[] = [];
  let cursor = 0;
  for (const burst of motionBursts(timeline)) {
    if (burst.start > cursor) {
      spans.push({ start: cursor, end: burst.start });
    }
    cursor = Math.max(cursor, burst.end);
  }
  if (cursor < timeline.durationSec) {
    spans.push({ start: cursor, end: timeline.durationSec });
  }
  return spans.filter((s) => s.end - s.start >= minStillSec);
}

export function analyzeMotion(
  metadata: string,
  minStillSec: number = MIN_STILL_SEC
): MotionAnalysis {
  const timeline = parseMotionOutput(metadata);
  return {
    durationSec: timeline.durationSec,
    stills: stillSpans(timeline, minStillSec),
  };
}

// Given the detected still spans, compute the segments to KEEP. Each still is
// capped to its first `maxStillSec` — the beat that lets a viewer read what
// just happened — and the rest is cut. A leading still (the pre-page-load
// blank) is dropped entirely.
//
// Every cut lies strictly INSIDE one still span, and a still span is by
// definition free of visible change, so the frames either side of a cut are
// identical and the join is invisible. That is the whole reason the motion
// signal has to see the cursor: when the detector was blind to a glide, a
// "still" could contain real movement and cutting its middle made the cursor
// teleport. Nothing here needs a lead-out any more.
//
// A corollary worth keeping in mind: each distinct visual state on screen
// survives for at least `maxStillSec`, so a run of quick changes can no longer
// flicker past. Two stills separated by a single changed frame stay separate
// spans and each keeps its own beat.
export function computeKeepSegments(
  analysis: MotionAnalysis,
  maxStillSec: number = MAX_STILL_SEC
): Segment[] {
  const { durationSec, stills } = analysis;
  if (durationSec <= 0) {
    return [];
  }
  const cuts: Segment[] = [];
  for (const still of stills) {
    if (still.start <= LEADING_STILL_SEC && cuts.length === 0) {
      cuts.push({ start: 0, end: still.end });
      continue;
    }
    const cutStart = Math.min(still.start + maxStillSec, durationSec);
    if (still.end - cutStart >= MIN_CUT_SEC) {
      cuts.push({ start: cutStart, end: still.end });
    }
  }

  const keeps: Segment[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      keeps.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < durationSec) {
    keeps.push({ start: cursor, end: durationSec });
  }
  // Degenerate case (e.g. the whole video is one leading still): keep the
  // still's first maxStillSec rather than producing an empty file.
  if (keeps.length === 0) {
    return [{ start: 0, end: Math.min(maxStillSec, durationSec) }];
  }
  return keeps;
}

export function keptSeconds(keeps: Segment[]): number {
  return keeps.reduce((sum, k) => sum + (k.end - k.start), 0);
}

// Map a timestamp in the ORIGINAL video to its position in the CONDENSED video
// — the sum of kept-segment durations before it. A time that fell inside a
// trimmed gap maps to the boundary of the surrounding kept content. `keeps`
// must be sorted and disjoint (as mergeWindows / computeKeepSegments return).
export function remapToCondensed(
  originalSec: number,
  keeps: Segment[]
): number {
  let condensed = 0;
  for (const k of keeps) {
    if (originalSec >= k.end) {
      condensed += k.end - k.start;
    } else if (originalSec > k.start) {
      return condensed + (originalSec - k.start);
    } else {
      return condensed;
    }
  }
  return condensed;
}

function selectExpression(keeps: Segment[]): string {
  return keeps
    .map((k) => `between(t,${k.start.toFixed(3)},${k.end.toFixed(3)})`)
    .join("+");
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// Re-encode the kept segments to `output`. Decodes every frame and filters by
// timestamp (a Playwright VP8 screencast has a single keyframe at t=0, so seek-
// based trimming would drop keyframe-less segments) — frame-accurate.
async function encodeKeeps(
  ffmpeg: string,
  input: string,
  keeps: Segment[],
  output: string
): Promise<void> {
  await runFfmpeg(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      input,
      "-vf",
      `select='${selectExpression(keeps)}',setpts=N/FRAME_RATE/TB`,
      "-an",
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      output,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// Produce the condensed video at `tmpPath`. Under MAX_SELECT_TERMS kept segments
// it's a single `select` pass; beyond that the expression would overflow
// ffmpeg's parser, so encode each batch to its own segment file and concat them.
// Every temp it creates is pushed to `temps` so the caller can clean up even on
// a partial failure. Each batch is a full decode of the source.
async function buildCondensed(
  ffmpeg: string,
  videoPath: string,
  keeps: Segment[],
  tmpPath: string,
  temps: string[]
): Promise<void> {
  if (keeps.length <= MAX_SELECT_TERMS) {
    await encodeKeeps(ffmpeg, videoPath, keeps, tmpPath);
    return;
  }

  const segmentPaths: string[] = [];
  const batches = chunk(keeps, MAX_SELECT_TERMS);
  for (let i = 0; i < batches.length; i++) {
    const segmentPath = `${videoPath}.seg${i}.webm`;
    temps.push(segmentPath);
    segmentPaths.push(segmentPath);
    await encodeKeeps(ffmpeg, videoPath, batches[i] ?? [], segmentPath);
  }

  const listPath = `${videoPath}.concat.txt`;
  temps.push(listPath);
  // concat demuxer escapes a single quote as '\'' inside the quoted path.
  const list = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listPath, `${list}\n`);

  // The batches share identical codec/timebase, so the concat demuxer can copy
  // streams without another decode/encode.
  await runFfmpeg(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      tmpPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

// $DAILIES_FFMPEG, then PATH — and nothing else. See the note at the top of the
// file for why Playwright's bundled build is not a fallback.
export async function findFfmpeg(): Promise<string | undefined> {
  const override = process.env.DAILIES_FFMPEG;
  if (override) {
    return (await isExecutableFile(override)) ? override : undefined;
  }
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(probe, ["ffmpeg"]);
    const found = stdout.split(/\r?\n/)[0]?.trim();
    if (found) {
      return found;
    }
  } catch {
    // not on PATH
  }
  return;
}

async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  timeoutMs: number
): Promise<{ stderr: string; stdout: string }> {
  const { stdout, stderr } = await execFileAsync(ffmpeg, args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

// Run the analysis pass and hand back its per-frame metadata. The metadata
// filter's `file=-` writes to STDOUT while ffmpeg's own logging goes to stderr,
// so stdout is the timeline and nothing else.
async function runMotionPass(
  ffmpeg: string,
  videoPath: string
): Promise<string> {
  const { stdout } = await runFfmpeg(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      videoPath,
      "-vf",
      MOTION_FILTER,
      "-map",
      "0:v:0",
      "-an",
      "-f",
      "null",
      "-",
    ],
    ANALYZE_TIMEOUT_MS
  );
  return stdout;
}

// Clamp each window to [0, durationSec], drop empties, and merge overlapping or
// touching windows into a sorted, disjoint keep list.
export function mergeWindows(
  windows: Segment[],
  durationSec: number
): Segment[] {
  const clamped = windows
    .map((w) => ({
      start: Math.max(0, Math.min(w.start, durationSec)),
      end: Math.max(0, Math.min(w.end, durationSec)),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const w of clamped) {
    const last = merged.at(-1);
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// Subtract detected still spans from interaction-aware keep windows so that
// dead waits inside a step (e.g. a 30-second login response within one action)
// are trimmed even when the caller supplies explicit keepWindows.
// Remove `remove` from `spans`, splitting a span in two when a removal falls in
// its middle. Pure → unit-tested.
export function subtractSpans(spans: Segment[], remove: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const span of spans) {
    let parts: Segment[] = [{ start: span.start, end: span.end }];
    for (const cut of remove) {
      const cs = Math.max(cut.start, span.start);
      const ce = Math.min(cut.end, span.end);
      if (ce <= cs) {
        continue;
      }
      parts = parts.flatMap((seg) => {
        if (ce <= seg.start || cs >= seg.end) {
          return [seg];
        }
        const out: Segment[] = [];
        if (seg.start < cs) {
          out.push({ start: seg.start, end: cs });
        }
        if (seg.end > ce) {
          out.push({ start: ce, end: seg.end });
        }
        return out;
      });
    }
    result.push(...parts);
  }
  return result.filter((s) => s.end > s.start);
}

export function subtractStillsFromWindows(
  keeps: Segment[],
  stills: Segment[],
  maxStillSec: number = MAX_STILL_SEC,
  // Stretches that must survive even though they are motionless — a caption
  // shown over a static page. Without this a caption's own video is trimmed and
  // it flashes past unreadably, which is why showCaption used to animate a
  // "breathing" opacity purely to defeat the freeze detector.
  protect: Segment[] = []
): Segment[] {
  // Keep the first maxStillSec of each still (the beat that lets the result
  // land) and cut clean through to where motion resumes — same reasoning as
  // computeKeepSegments, including why no lead-out is needed.
  const cuts = stills
    .map((s) => ({
      start: s.start + maxStillSec,
      end: s.end,
    }))
    .filter((c) => c.end - c.start >= MIN_CUT_SEC);

  // Protecting a span in the MIDDLE of a long still splits that still's cut
  // in two rather than cancelling it, so the idle either side of the caption is
  // still trimmed. Falls out of the same subtraction.
  return subtractSpans(keeps, subtractSpans(cuts, protect));
}

export interface CondenseResult {
  condensed: boolean;
  durationSec?: number;
  // Kept segments in ORIGINAL video time. With these a consumer can remap any
  // original timestamp to its position in the condensed video (the report
  // timeline syncs steps to the trimmed video this way).
  keeps?: Segment[];
  keptSec?: number;
  reason?: string;
}

export interface CondenseOptions {
  ffmpegPath?: string;
  // Hard floor (original video seconds) to trim off the HEAD regardless of the
  // keep/freeze branch — e.g. the pre-load blank up to a session start URL's
  // settle. Keeps entirely before it are dropped; one spanning it is clamped.
  headTrimSec?: number;
  // Interaction-aware mode: keep exactly these windows (in original video
  // seconds) and trim everything else — the leading load, the idle gaps between
  // steps, and the trailing tail. When omitted, the motion pass alone decides.
  keepWindows?: Segment[];
  // Windows that must survive even when motionless — caption spans. See
  // subtractStillsFromWindows.
  protectWindows?: Segment[];
}

// Drop the part of `keeps` before `floorSec` (sorted, disjoint in → out).
// Pure → unit-tested.
export function clampKeepsToFloor(
  keeps: Segment[],
  floorSec: number
): Segment[] {
  if (!(floorSec > 0)) {
    return keeps;
  }
  const out: Segment[] = [];
  for (const k of keeps) {
    if (k.end <= floorSec) {
      continue; // entirely in the trimmed head
    }
    out.push({ start: Math.max(k.start, floorSec), end: k.end });
  }
  return out;
}

// Condense one video in place (write to a sibling tmp file, then rename over
// the original). Never throws — a failure keeps the original and reports why.
export async function condenseVideo(
  videoPath: string,
  log: Logger,
  options: CondenseOptions = {}
): Promise<CondenseResult> {
  const tmpPath = `${videoPath}.condensed.webm`;
  // Every temp file created below (the output, plus per-batch segments and the
  // concat list) so the finally block can remove them all, including on a
  // partial failure — otherwise a long session leaks .webm files into its dir.
  const temps: string[] = [tmpPath];
  try {
    const ffmpeg = options.ffmpegPath ?? (await findFfmpeg());
    if (!ffmpeg) {
      return { condensed: false, reason: "ffmpeg not found" };
    }
    await access(videoPath);

    // One motion pass serves both branches: the step windows below still need
    // it to trim dead waits INSIDE a step, and without windows it is the only
    // signal there is.
    const analysis = analyzeMotion(await runMotionPass(ffmpeg, videoPath));
    const durationSec = analysis.durationSec;
    if (durationSec <= 0) {
      return { condensed: false, reason: "could not determine duration" };
    }

    const keepWindows = options.keepWindows;
    let keeps: Segment[];
    if (keepWindows && keepWindows.length > 0) {
      // Interaction-aware: keep the step windows, trim everything else. The
      // motion pass still applies within a window — a long server response
      // (login, heavy query) is indistinguishable from real work at the
      // keepWindows level but is pixel-identical on camera.
      keeps = subtractStillsFromWindows(
        mergeWindows(keepWindows, durationSec),
        analysis.stills,
        MAX_STILL_SEC,
        options.protectWindows ?? []
      );
    } else {
      keeps = computeKeepSegments(analysis);
    }

    // Trim the pre-load blank head (e.g. up to a session start URL's settle),
    // regardless of which branch produced `keeps`.
    if (options.headTrimSec) {
      keeps = clampKeepsToFloor(keeps, options.headTrimSec);
    }

    const keptSec = keptSeconds(keeps);
    if (keeps.length === 0 || durationSec - keptSec < MIN_SAVINGS_SEC) {
      return {
        condensed: false,
        durationSec,
        keeps,
        keptSec,
        reason: "nothing to trim",
      };
    }

    await buildCondensed(ffmpeg, videoPath, keeps, tmpPath, temps);
    const produced = await stat(tmpPath);
    if (produced.size === 0) {
      return { condensed: false, reason: "encoder produced an empty file" };
    }
    await rename(tmpPath, videoPath);
    return { condensed: true, durationSec, keeps, keptSec };
  } catch (err) {
    log.debug({ err, videoPath }, "video condense failed; keeping original");
    return {
      condensed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }
}
