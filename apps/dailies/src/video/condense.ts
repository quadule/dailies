// Post-process session videos so reviewers don't scrub through dead air:
// drop the leading still segment (white frames before the first page paints)
// and cap every other motionless stretch at MAX_STILL_SEC seconds.
//
// Two ffmpeg passes over each *.webm:
//   1. freezedetect (analysis only) → freeze_start/freeze_end timestamps on
//      stderr, total decoded duration via -progress on stdout.
//   2. select/setpts re-encode keeping only the computed segments — decodes
//      every frame and filters by timestamp, so cuts are frame-accurate. A
//      Playwright VP8 screencast emits a single keyframe at t=0, so a
//      keyframe-bound stream copy would silently drop any kept segment that
//      doesn't start at one (e.g. a cursor glide / click after a >1s dwell).
//
// ffmpeg is an OPTIONAL dependency: resolved from $DAILIES_FFMPEG, then PATH,
// then Playwright's browser cache (Playwright installs its own ffmpeg build
// alongside Chromium for screencasts). When unavailable — or when either pass
// fails — the original video is kept untouched and the report still renders.
import { execFile } from "node:child_process";
import { access, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "dailies-logger";

const execFileAsync = promisify(execFile);

// Collapse any still stretch to at most this many seconds. 0 removes dead air
// entirely: the frame-accurate re-encode means we don't need a keyframe cushion,
// and the animated cursor keeps real interactions moving, so a motionless
// stretch carries no information worth keeping. (Overlays that must survive — a
// held caption — animate continuously so their frames never read as "still".)
export const MAX_STILL_SEC = 1;

// A freeze starting within this many seconds of t=0 counts as the pre-load
// segment and is dropped entirely instead of capped.
const LEADING_FREEZE_SEC = 1;

// Lead-out kept at the END of every trimmed freeze. The virtual cursor glides to
// its next target over up to GLIDE_MAX_MS (~1.1s in session-cursor.ts) plus a
// short settle before it clicks — and that glide is only ~28px on screen, far
// below FREEZE_NOISE, so freezedetect reports the whole park-idle-then-glide
// stretch as ONE freeze that ends when the click's reaction paints. Capping such
// a freeze to its first MAX_STILL_SEC would trim the glide and the cursor would
// snap to position. Instead we cut only the MIDDLE of a long freeze and keep this
// tail: the cut then lands inside pure idle (cursor parked at the same spot on
// both sides → a seamless join) while the glide→click→reaction survives at the
// end. A freeze shorter than MAX_STILL_SEC + this is kept whole.
//
// Limitation: a slow reaction (glide → click → multi-second wait → render) puts
// the glide far from the freeze end, so it's still trimmed and that one snaps —
// rare, and masked by the page changing anyway. Strictly better than trimming
// every glide.
const GLIDE_LEADOUT_SEC = 1.5;

// freezedetect noise tolerance (0-1 mean-absolute-difference ratio). Decoded
// static segments of a Playwright screencast are byte-identical (diff 0), so
// this sits very low: real interaction motion — a typed word, the cursor
// gliding to its target, the click ripple, a held caption's gentle breathing —
// clears it and is kept, while a genuinely motionless stretch falls below it
// and is trimmed.
const FREEZE_NOISE = "0.0003";

// freezedetect's own minimum freeze duration (its `d`). Kept a small positive
// value, decoupled from MAX_STILL_SEC: at d=0 freezedetect reports the whole
// clip as one freeze and never marks where motion resumes, so everything gets
// cut. A small floor lets it emit freeze_start/end around real motion while
// MAX_STILL_SEC=0 still trims each detected still to nothing. Stills shorter
// than this are imperceptible and left alone.
const FREEZE_MIN_SEC = 0.4;

// Don't bother re-encoding to save less than this many seconds.
const MIN_SAVINGS_SEC = 1;

// Max `between(t,…)` terms in a single `select` expression. ffmpeg's expression
// evaluator fails to parse/allocate past ~100 terms ("Error while parsing
// expression" / "Cannot allocate memory"), which aborts the whole encode — so a
// long session with many kept segments would silently keep its raw video. When
// keeps exceed this, we encode in batches and concat them. Kept well under the
// observed ~100 ceiling: it varies by ffmpeg build, and the extra decode pass is
// cheap insurance.
export const MAX_SELECT_TERMS = 50;

const ANALYZE_TIMEOUT_MS = 60_000;
const ENCODE_TIMEOUT_MS = 300_000;

export interface Segment {
  end: number;
  start: number;
}

export interface FreezeAnalysis {
  durationSec: number;
  freezes: Segment[];
}

// Parse one freezedetect run: freeze_start/freeze_end pairs from stderr and
// the total decoded duration from `-progress` key=value output. A freeze that
// never ends (still at EOF) is closed at the total duration.
export function parseFreezeOutput(
  stderr: string,
  progress: string
): FreezeAnalysis {
  let durationSec = 0;
  // -progress emits cumulative out_time_us (older builds: out_time_ms) lines;
  // the largest one is the total decoded duration.
  for (const match of progress.matchAll(/out_time_us=(\d+)/g)) {
    durationSec = Math.max(durationSec, Number(match[1]) / 1_000_000);
  }
  if (durationSec === 0) {
    for (const match of progress.matchAll(/out_time_ms=(\d+)/g)) {
      durationSec = Math.max(durationSec, Number(match[1]) / 1_000_000);
    }
  }

  const freezes: Segment[] = [];
  let open: number | undefined;
  const events = stderr.matchAll(
    /lavfi\.freezedetect\.freeze_(start|end):\s*([\d.]+)/g
  );
  for (const [, kind, value] of events) {
    const t = Number(value);
    if (!Number.isFinite(t)) {
      continue;
    }
    if (kind === "start") {
      open = t;
    } else if (open !== undefined) {
      if (t > open) {
        freezes.push({ start: open, end: t });
      }
      open = undefined;
    }
  }
  if (open !== undefined && durationSec > open) {
    freezes.push({ start: open, end: durationSec });
  }
  return { durationSec, freezes };
}

// Given the detected freezes, compute the segments to KEEP. A reported freeze is
// capped to its first maxStillSec PLUS a GLIDE_LEADOUT_SEC tail (so a cursor
// glide leading into the next action survives — see GLIDE_LEADOUT_SEC), by
// trimming only the middle. A leading freeze (the pre-page-load white frames) is
// dropped entirely, and a freeze too short to have a trimmable middle is kept
// whole.
export function computeKeepSegments(
  analysis: FreezeAnalysis,
  maxStillSec: number = MAX_STILL_SEC
): Segment[] {
  const { durationSec, freezes } = analysis;
  if (durationSec <= 0) {
    return [];
  }
  const cuts: Segment[] = [];
  for (const freeze of freezes) {
    if (freeze.start <= LEADING_FREEZE_SEC && cuts.length === 0) {
      cuts.push({ start: 0, end: freeze.end });
    } else {
      const cutStart = Math.min(freeze.start + maxStillSec, durationSec);
      // Keep a glide lead-out only when motion RESUMES after this freeze (an
      // action follows). A trailing freeze that runs to EOF has no next action,
      // so trim it fully — a 1.5s still tail at the end is just dead air.
      const resumes = freeze.end < durationSec;
      const cutEnd = resumes ? freeze.end - GLIDE_LEADOUT_SEC : freeze.end;
      // Only trim when there's a middle to remove; else keep the freeze whole so
      // the cursor's glide (in the tail) is never cut.
      if (cutEnd > cutStart) {
        cuts.push({ start: cutStart, end: cutEnd });
      }
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
  // Degenerate case (e.g. the whole video is one leading freeze): keep the
  // freeze's first maxStillSec rather than producing an empty file.
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

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function findFfmpegInCacheRoot(
  root: string
): Promise<string | undefined> {
  const entries = (await listDir(root))
    .filter((entry) => entry.startsWith("ffmpeg-"))
    .sort()
    .reverse();
  for (const entry of entries) {
    for (const binary of await listDir(path.join(root, entry))) {
      const candidate = path.join(root, entry, binary);
      if (binary.startsWith("ffmpeg") && (await isExecutableFile(candidate))) {
        return candidate;
      }
    }
  }
  return;
}

// Playwright keeps its ffmpeg build in the browsers cache as
// <cache>/ffmpeg-<rev>/ffmpeg-<platform>[.exe].
async function findPlaywrightFfmpeg(): Promise<string | undefined> {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const found = await findFfmpegInCacheRoot(root);
    if (found) {
      return found;
    }
  }
  return;
}

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
  return findPlaywrightFfmpeg();
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

// Subtract detected freezes from interaction-aware keep windows so that dead
// waits inside a step (e.g. a 30-second login response within one action) are
// trimmed even when the caller supplies explicit keepWindows.
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

export function subtractFreezesFromWindows(
  keeps: Segment[],
  freezes: Segment[],
  maxStillSec: number = MAX_STILL_SEC,
  // Stretches that must survive even though they are motionless — a caption
  // shown over a static page. Without this a caption's own video is trimmed and
  // it flashes past unreadably, which is why showCaption used to animate a
  // "breathing" opacity purely to defeat the freeze detector.
  protect: Segment[] = []
): Segment[] {
  const cuts = freezes
    // Keep a GLIDE_LEADOUT_SEC tail (cut only the middle) so a cursor glide into
    // the next action survives — same reasoning as computeKeepSegments.
    .map((f) => ({
      start: f.start + maxStillSec,
      end: f.end - GLIDE_LEADOUT_SEC,
    }))
    .filter((c) => c.end > c.start);

  // Protecting a span in the MIDDLE of a long freeze splits that freeze's cut
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
  // steps, and the trailing tail. When omitted, fall back to freezedetect.
  keepWindows?: Segment[];
  // Windows that must survive even when motionless — caption spans. See
  // subtractFreezesFromWindows.
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

    let durationSec: number;
    let keeps: Segment[];
    const keepWindows = options.keepWindows;
    if (keepWindows && keepWindows.length > 0) {
      // Interaction-aware: keep the step windows, trim everything else. Also
      // run freeze-detect to cut dead waits that fall inside a step window —
      // a long server response (login, heavy query) is indistinguishable from
      // real work at the keepWindows level but is pixel-identical on camera.
      const windowAnalyze = await runFfmpeg(
        ffmpeg,
        [
          "-hide_banner",
          "-nostats",
          "-i",
          videoPath,
          "-vf",
          `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_SEC}`,
          "-map",
          "0:v:0",
          "-an",
          "-progress",
          "pipe:1",
          "-f",
          "null",
          "-",
        ],
        ANALYZE_TIMEOUT_MS
      );
      const windowAnalysis = parseFreezeOutput(
        windowAnalyze.stderr,
        windowAnalyze.stdout
      );
      durationSec = windowAnalysis.durationSec;
      if (durationSec <= 0) {
        return { condensed: false, reason: "could not determine duration" };
      }
      keeps = subtractFreezesFromWindows(
        mergeWindows(keepWindows, durationSec),
        windowAnalysis.freezes,
        MAX_STILL_SEC,
        options.protectWindows ?? []
      );
    } else {
      const analyze = await runFfmpeg(
        ffmpeg,
        [
          "-hide_banner",
          "-nostats",
          "-i",
          videoPath,
          "-vf",
          `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_SEC}`,
          "-map",
          "0:v:0",
          "-an",
          "-progress",
          "pipe:1",
          "-f",
          "null",
          "-",
        ],
        ANALYZE_TIMEOUT_MS
      );
      const analysis = parseFreezeOutput(analyze.stderr, analyze.stdout);
      durationSec = analysis.durationSec;
      if (durationSec <= 0) {
        return { condensed: false, reason: "could not determine duration" };
      }
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
