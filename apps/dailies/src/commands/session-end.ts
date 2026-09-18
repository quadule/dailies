import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatDurationMs, requestId } from "dailies-cli-kit";
import {
  sendRequest,
  sessionReportPath,
  sessionResultsPath,
} from "dailies-daemon-client";
import {
  type ArtifactInfo,
  type CaptionEvent,
  CaptionEventSchema,
  SESSION_CAPTIONS_FILE,
  type SessionEndRequest,
  type SessionEndResult,
} from "dailies-protocol";
import { logger } from "../logger.js";
import { writeSessionReport } from "../report/load-and-render.js";
import { endResultFromDisk } from "../session/artifacts.js";
import { attachFiles } from "../session/attach.js";
import { type Metric, parseMetrics } from "../session/metrics.js";
import {
  readSessionRecord,
  type SessionRecord,
  type SessionStep,
  updateSessionRecord,
  writeSessionRecord,
} from "../session/registry.js";
import { scrubHarFile } from "../session/scrub-har.js";
import {
  condenseVideo,
  findFfmpeg,
  remapToCondensed,
  type Segment,
} from "../video/condense.js";
import { probeDurationSec, probeVideo } from "../video/ffmpeg.js";
import {
  burnCaptionBand,
  type CinematicStep,
  cinematicProcess,
  precinematicVideoPath,
} from "../video/narrate.js";
import { buildSrt, captionLineMax } from "../video/srt.js";
import { stopDaemonIfIdle } from "./daemon-stop.js";

interface SessionEndOpts {
  // External files to copy into the session's attachments/ before the report is
  // built — a coverage report, an audit, anything Dailies didn't produce.
  attach?: string[];
  captions?: boolean;
  cinematic?: boolean;
  condense?: boolean;
  // `name=value` measurements this run produced, recorded verbatim. Dailies
  // never interprets them — see session/metrics.ts.
  metric?: string[];
  open?: boolean;
  prompt?: string;
  // Replace credential header values in network.har (default on). --no-scrub-har
  // keeps them, for a HAR that has to be replayed against the same session.
  scrubHar?: boolean;
  // Song mode: score the whole video with one LLM-written, model-sung song
  // instead of per-step spoken narration. A flavor of the cinematic pass.
  song?: boolean;
  stopDaemon?: boolean;
  // The agent's explicit run verdict (session end --pass/--fail). Stamped on the
  // record so the report's pass/fail reflects the agent's judgment, not just the
  // per-step exit codes.
  verdict?: { status: "pass" | "fail"; reason?: string };
  // Which recording to finish, when the session drove more than one page: a page
  // name from the script, or a video filename. Whoever drove the session knows
  // which page was the subject; without this the finalizer has to guess.
  video?: string;
}

// Open a file/URL in the OS default app, detached and best-effort: opening the
// report is a convenience, so a missing opener or headless host must never fail
// `session end`.
function openInOSDefault(target: string): void {
  let command = "xdg-open";
  let args = [target];
  if (process.platform === "darwin") {
    command = "open";
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", target];
  }
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // no opener on this host — ignore
    });
    child.unref();
  } catch {
    // ignore — best effort
  }
}

// How much to keep around each step's script execution. The browser is driven
// during a step; the long idle gaps BETWEEN steps (the agent reasoning) plus the
// leading page load and the trailing tail are the dead air worth trimming.
export const STEP_PAD_BEFORE_SEC = 0.6;
// Generous tail: an action's visual effect (a navigation, a re-render) often
// lands just AFTER the step's script returns, and the video clock can begin a
// touch before createdAt — both must stay inside the kept window.
export const STEP_PAD_AFTER_SEC = 1.5;

// Map each recorded step to a keep-window in video time. The video starts at the
// session's createdAt, and each step is stamped with the same wall clock, so
// (step.startedAt - createdAt) is the step's offset into the recording.
//
// Failed steps (ok === false) are left out. A step that timed out or errored —
// e.g. an agent stuck retrying the login page — records as a long, mostly frozen
// stretch whose only value (the failure) is already captured in the report and
// results.json. Keeping its window would pad the condensed cut (and the cinematic
// demo) with dead air from attempts that didn't work; dropping it trims those
// stuck retries out. If every step failed we return no windows and condenseVideo
// falls back to the whole-video motion pass, so a wholly-failed run still trims.
export function stepKeepWindows(record: SessionRecord): Segment[] {
  const t0 = Date.parse(record.createdAt);
  if (!Number.isFinite(t0)) {
    return [];
  }
  const windows: Segment[] = [];
  for (const step of record.steps) {
    if (!step.ok) {
      continue;
    }
    const startMs = Date.parse(step.startedAt);
    if (!Number.isFinite(startMs)) {
      continue;
    }
    const start = (startMs - t0) / 1000;
    windows.push({
      start: Math.max(0, start - STEP_PAD_BEFORE_SEC),
      end: start + step.durationMs / 1000 + STEP_PAD_AFTER_SEC,
    });
  }
  return windows;
}

// The captions this session showed, as timed data. Read from disk rather than
// held from the run so a re-finalize (re-rendering a report, re-cutting a video)
// sees exactly what the original run did. Missing or malformed is not an error:
// a session that never called showCaption has no file, and a caption is
// presentation — it must never be the reason a report fails to build.
async function readCaptions(artifactsDir: string): Promise<CaptionEvent[]> {
  try {
    const raw = await readFile(
      path.join(artifactsDir, SESSION_CAPTIONS_FILE),
      "utf8"
    );
    const parsed = CaptionEventSchema.array().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

// Reading speed used to guarantee a caption stays on screen long enough to be
// read. 200 wpm is a conservative subtitle-industry figure — deliberately slower
// than silent reading, because the viewer is also watching the app — plus a
// second of fixation time to find the text and look back at the page.
const CAPTION_WPM = 200;
const CAPTION_FIXATION_MS = 1000;
// The on-page overlay clamped to two lines and the SRT writer wraps to two, so
// no caption is ever a wall of text; this bounds the floor for a long one.
const CAPTION_MAX_READ_MS = 8000;

// How long a caption must stay on screen to be readable. The requested duration
// is a floor, not a ceiling: `showCaption(text, { durationMs: 500 })` on a long
// sentence is unreadable no matter what the caller asked for. Pure → tested.
export function captionReadMs(text: string, requestedMs: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const read = CAPTION_FIXATION_MS + (words / CAPTION_WPM) * 60_000;
  return Math.min(CAPTION_MAX_READ_MS, Math.max(requestedMs, Math.round(read)));
}

// Video-time windows that must survive condensing, one per caption. A caption is
// usually shown over a page that is doing nothing — which is exactly what the
// freeze detector trims — so without these the caption's own frames are cut and
// it flashes past. Same clock basis as stepKeepWindows: wall-clock minus the
// session's createdAt. Pure → unit-tested.
export function captionKeepWindows(
  record: SessionRecord,
  captions: CaptionEvent[]
): Segment[] {
  const t0 = Date.parse(record.createdAt);
  if (!Number.isFinite(t0)) {
    return [];
  }
  const windows: Segment[] = [];
  for (const caption of captions) {
    const atMs = Date.parse(caption.at);
    if (!Number.isFinite(atMs)) {
      continue;
    }
    const start = (atMs - t0) / 1000;
    windows.push({
      start: Math.max(0, start),
      end: start + captionReadMs(caption.text, caption.durationMs) / 1000,
    });
  }
  return windows;
}

// Seconds into the recording where real content began — a session start --url's
// settle time, relative to the video start (createdAt, same clock). 0 when no
// start URL was used (no head trim). Exported for testing.
export function contentStartFloorSec(record: SessionRecord): number {
  if (!record.contentStartedAt) {
    return 0;
  }
  const t0 = Date.parse(record.createdAt);
  const content = Date.parse(record.contentStartedAt);
  if (!(Number.isFinite(t0) && Number.isFinite(content))) {
    return 0;
  }
  return Math.max(0, (content - t0) / 1000);
}

// Whether this `session end` had to fall back to on-disk artifacts because
// something went WRONG, as opposed to being a deliberate re-run.
//
// Re-running `session end` on an already-ended record is supported — it is how a
// report is re-rendered and a video re-cut — and the daemon has necessarily
// dropped the session by then, so it answers "Session not found". Treating that
// as degraded exited non-zero on a run that fully succeeded, which fails a CI
// step for doing the right thing. Exported for testing.
export function isDegradedEnd(args: {
  daemonCode: number;
  hasResult: boolean;
  wasAlreadyEnded: boolean;
}): boolean {
  if (args.wasAlreadyEnded) {
    return false;
  }
  return args.daemonCode !== 0 || !args.hasResult;
}

// Trim dead air from the recorded videos before the report is rendered,
// refreshing each artifact's byte size so the manifest reflects the condensed
// file. Interaction-aware when the session has timed steps: keep the step
// windows, trim the idle gaps / leading load / trailing tail. Otherwise fall
// back to the motion pass alone. Best-effort: without ffmpeg or on failure, originals
// are kept and the report renders unchanged.
export interface CaptionCue {
  endSec: number;
  startSec: number;
  text: string;
}

// A session records ONE VIDEO PER PAGE, and everything downstream — the cinematic
// pass, burnt captions, the video the report shows, the path `--json` reports for CI
// to attach — takes "the" session video as the first video artifact. With more than
// one page that was whatever order the daemon happened to return, and it picked wrong
// in the way that matters: a run that opened a feature-flag page in a second tab got
// its song burnt into 40 seconds of an unstyled toggle page, while the 67 seconds
// actually demonstrating the feature was left silent and unreported.
//
// So order them by how much footage survived condensing. Condensing trims idle around
// the recorded steps, which makes kept time a direct measure of how much of the
// session happened on that page — the page you drove keeps its minutes, a page you
// passed through to flip a switch keeps seconds. Bytes are the fallback when there is
// nothing to trim or no ffmpeg to trim with: more pixels changed, more happened.
//
// Pure → unit-tested. Returns the indices of `videos` in primary-first order.
export function videosByPrimacy(
  videos: { bytes: number; keptSec?: number }[]
): number[] {
  return videos
    .map((video, index) => ({ index, video }))
    .sort((a, b) => {
      const kept = (b.video.keptSec ?? -1) - (a.video.keptSec ?? -1);
      // Ties include "neither was condensed", where both are undefined.
      return kept === 0 ? b.video.bytes - a.video.bytes : kept;
    })
    .map((entry) => entry.index);
}

// Put the page the session actually happened on first, so every later
// `find(kind === "video")` — cinematic, captions, report, `--json` — means the same
// video, and it is the right one. Reordered in place: the artifact list is the
// session's own record of what it produced, and its order is now meaningful.
//
// Measured from the CONDENSED cut, which trims idle around the recorded steps: its
// length is how much of the session happened on that page. The `.precinematic`
// sidecar is that cut, and preferring it matters on a re-finalize — the video
// itself may already carry a song from a previous run, while the sidecar is clean.
//
// Deliberately NOT inside the condense pass: a re-finalize skips condensing
// entirely (the sidecars are already there), which is exactly when a wrong pick
// gets cemented — it is how a demo ended up with its song over a feature-flag page
// twice.
// The recording the run's own steps point at: the page the LAST step to name one
// ended on. Recency rather than a tally on purpose — a run that gets stuck racks up
// steps on the page it is stuck on, and the take worth keeping is the one it
// finished on. Returns undefined when no step named a page that matches a
// recording, which is when the caller falls back to measuring footage. Pure →
// unit-tested.
export function pageFromSteps<T extends { pageName?: string }>(
  stepPages: { page?: string; step: string }[] | undefined,
  videos: T[]
): T | undefined {
  for (const { page } of [...(stepPages ?? [])].reverse()) {
    if (!page) {
      continue;
    }
    const match = videos.find((video) => video.pageName === page);
    if (match) {
      return match;
    }
  }
  return;
}

// Name a video artifact the way a person would: the page name the script gave it,
// falling back to the file's own name when the page went unlabelled. Pure →
// unit-tested.
export function videoLabel(video: { pageName?: string; path: string }): string {
  return video.pageName ?? path.basename(video.path);
}

// Find the recording the caller asked for by `--video`. Matches a page name or a
// filename, exactly first and then case-insensitively by substring, so `--video
// checkout` finds the page named "checkout" without anyone typing a hash. Returns
// the matches so the caller can refuse an ambiguous one rather than guess — the
// whole point of the flag is to stop guessing. Pure → unit-tested.
export function matchRequestedVideo<
  T extends { pageName?: string; path: string },
>(videos: T[], requested: string): T[] {
  const wanted = requested.trim().toLowerCase();
  const exact = videos.filter(
    (video) =>
      video.pageName?.toLowerCase() === wanted ||
      path.basename(video.path).toLowerCase() === wanted
  );
  if (exact.length > 0) {
    return exact;
  }
  return videos.filter((video) =>
    `${video.pageName ?? ""} ${video.path}`.toLowerCase().includes(wanted)
  );
}

export async function promotePrimaryVideo(
  result: SessionEndResult,
  requested?: string
): Promise<void> {
  const videos = result.artifacts.filter((a) => a.kind === "video");
  if (videos.length < 2) {
    return;
  }
  if (requested) {
    const matches = matchRequestedVideo(videos, requested);
    const choices = videos.map((v) => videoLabel(v)).join(", ");
    if (matches.length !== 1) {
      throw new Error(
        `--video "${requested}" ${matches.length === 0 ? "matched no recording" : `is ambiguous (matched ${matches.length})`}. This session recorded: ${choices}`
      );
    }
    reorderVideos(result, [
      matches[0] as ArtifactInfo,
      ...videos.filter((v) => v !== matches[0]),
    ]);
    logger.info(
      { video: matches[0]?.path },
      `finishing ${videoLabel(matches[0] as ArtifactInfo)}, as asked`
    );
    return;
  }
  // What the run itself says: the page its steps ended on. A session records one
  // video per page, and the page the session FINISHED on is the one it was about —
  // which is right in the case footage gets wrong, where an agent flailed on one
  // page, gave up, and re-ran the flow clean on another. The good take is the
  // short one there, and only the step history knows it.
  const fromSteps = pageFromSteps(result.stepPages, videos);
  if (fromSteps) {
    reorderVideos(result, [
      fromSteps,
      ...videos.filter((v) => v !== fromSteps),
    ]);
    logger.info(
      { video: fromSteps.path },
      `finishing ${videoLabel(fromSteps)} — the page the run's steps ended on`
    );
    return;
  }

  const ffmpeg = await findFfmpeg();
  const measured = await Promise.all(
    videos.map(async (video) => {
      const condensed = precinematicVideoPath(video.path);
      const source = existsSync(condensed) ? condensed : video.path;
      return {
        bytes: video.bytes,
        keptSec: ffmpeg ? await probeDurationSec(ffmpeg, source) : undefined,
      };
    })
  );
  const ordered = videosByPrimacy(measured).map(
    (index) => videos[index] as ArtifactInfo
  );
  reorderVideos(result, ordered);
  // Reached only when the steps named no page Dailies can match — an older
  // session, or a run that drove anonymous tabs. Said as a guess, because it is.
  logger.info(
    {
      others: ordered.slice(1).map((v) => videoLabel(v)),
      video: ordered[0]?.path,
    },
    `${videos.length} pages recorded; guessing ${videoLabel(ordered[0] as ArtifactInfo)} (most footage). Pass --video <page> to choose.`
  );
}

// Move `ordered` into the artifact list's video slots, leaving every other
// artifact where it was.
function reorderVideos(
  result: SessionEndResult,
  ordered: ArtifactInfo[]
): void {
  let slot = 0;
  for (const [index, artifact] of result.artifacts.entries()) {
    if (artifact.kind === "video") {
      result.artifacts[index] = ordered[slot] as ArtifactInfo;
      slot += 1;
    }
  }
}

async function condenseSessionVideos(
  result: SessionEndResult,
  record: SessionRecord,
  captions: CaptionEvent[]
): Promise<CaptionCue[]> {
  const videos = result.artifacts.filter((a) => a.kind === "video");
  if (videos.length === 0) {
    return [];
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    logger.info("ffmpeg not found; keeping raw session videos");
    return [];
  }
  const keepWindows = stepKeepWindows(record);
  // A caption is normally shown over a page that is doing nothing, which is
  // exactly what the freeze trim removes. These windows keep each caption on
  // screen long enough to read while the idle around it is still trimmed.
  const protectWindows = captionKeepWindows(record, captions);
  // A session start --url stamped when its page finished settling; trim the video
  // head to that (same clock basis as createdAt) so the pre-load about:blank is
  // dropped even in the no-windows / near-t0-first-step cases.
  const headTrimSec = contentStartFloorSec(record);
  // Re-encoding can take a few seconds per video; without feedback the command
  // looks hung. Progress goes to stderr (stdout stays machine-readable).
  const label = videos.length === 1 ? "recording" : "recordings";
  process.stderr.write(`Condensing ${videos.length} ${label}…\n`);
  // All videos share the same step keep-windows, so any condensed video's kept
  // segments give the same original→condensed time remap. Capture the first to
  // stamp each step's position in the trimmed video for the timeline.
  let mappingKeeps: Segment[] | undefined;
  for (const video of videos) {
    const outcome = await condenseVideo(video.path, logger, {
      ffmpegPath: ffmpeg,
      headTrimSec,
      keepWindows,
      protectWindows,
    });
    if (outcome.condensed) {
      mappingKeeps ??= outcome.keeps;
      video.bytes = await stat(video.path)
        .then((s) => s.size)
        .catch(() => video.bytes);
      const from = formatDurationMs(
        Math.round((outcome.durationSec ?? 0) * 1000)
      );
      const to = formatDurationMs(Math.round((outcome.keptSec ?? 0) * 1000));
      process.stderr.write(`  ✓ ${from} → ${to}\n`);
      logger.info({ video: video.path }, `condensed video: ${from} → ${to}`);
      // Preserve the condensed cut as the pre-cinematic source. Condensing is
      // destructive + in-place, so this sidecar also MARKS the video as
      // already-condensed: a later `session end` (especially --cinematic) reuses
      // it instead of condensing the already-condensed file again — which would
      // shrink it further and desync the stamped step times from the pixels.
      await copyFile(video.path, precinematicVideoPath(video.path)).catch(
        (err) =>
          logger.warn(
            { err, video: video.path },
            "could not preserve condensed cut"
          )
      );
    } else if (outcome.reason === "nothing to trim") {
      logger.debug(
        { video: video.path, reason: outcome.reason },
        "video left unchanged"
      );
    } else {
      // An actual failure (e.g. the encode threw) silently keeps the raw video,
      // which reads as "condense didn't help". Surface it so a regression shows.
      logger.warn(
        { video: video.path, reason: outcome.reason },
        "could not condense video; keeping the original"
      );
    }
  }

  // Stamp each step's position in the condensed video so the report/viewer
  // timeline can sync to it. Mutating record.steps here flows into the manifest
  // (built from the record just after this).
  const t0 = Date.parse(record.createdAt);
  if (!Number.isFinite(t0)) {
    return [];
  }
  if (mappingKeeps) {
    for (const step of record.steps) {
      const startMs = Date.parse(step.startedAt);
      if (Number.isFinite(startMs)) {
        step.videoTime = remapToCondensed((startMs - t0) / 1000, mappingKeeps);
      }
    }
  }
  // Caption cues in CONDENSED time, remapped exactly like step times. Their
  // windows were protected above, so the stretch each one covers survived the
  // trim and these land on the frames the caption was shown over.
  // No keeps means nothing was trimmed (a short recording with no dead air), so
  // caption times need no remapping — they are already video time. Returning []
  // here would silently drop every caption from such a run.
  return captionCues(record, captions, mappingKeeps);
}

// Caption cues in condensed video time. Pure → unit-tested.
export function captionCues(
  record: SessionRecord,
  captions: CaptionEvent[],
  // Undefined when the video wasn't condensed — then caption times ARE video
  // times and pass through unmapped.
  keeps: Segment[] | undefined
): CaptionCue[] {
  const t0 = Date.parse(record.createdAt);
  if (!Number.isFinite(t0)) {
    return [];
  }
  const cues: CaptionCue[] = [];
  for (const caption of captions) {
    const atMs = Date.parse(caption.at);
    if (!Number.isFinite(atMs)) {
      continue;
    }
    const startSec = (atMs - t0) / 1000;
    const holdSec = captionReadMs(caption.text, caption.durationMs) / 1000;
    const start = keeps ? remapToCondensed(startSec, keeps) : startSec;
    const end = keeps
      ? remapToCondensed(startSec + holdSec, keeps)
      : startSec + holdSec;
    if (end > start) {
      cues.push({ endSec: end, startSec: start, text: caption.text });
    }
  }
  // A caption's read-time floor can run past the next one's start. Two captions
  // on screen at once stack on top of each other, so an earlier one always
  // yields to the next: showCaption replaces the caption showing, and the
  // rendered version has to behave the same way.
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1];
    const cue = cues[i];
    if (cue && next && cue.endSec > next.startSec) {
      cue.endSec = next.startSec;
    }
  }
  return cues.filter((c) => c.endSec > c.startSec);
}

// Burn the run's own showCaption cues into the video, for a plain (non-cinematic)
// finalize. Best-effort throughout: captions are presentation, and a session's
// evidence must never be lost because ffmpeg could not draw text.
async function burnPlainCaptions(
  result: SessionEndResult,
  cues: CaptionCue[]
): Promise<void> {
  const video = result.artifacts.find((a) => a.kind === "video");
  const ffmpeg = await findFfmpeg();
  if (!(video && ffmpeg)) {
    return;
  }
  try {
    // Burn from the clean condensed cut, never from a video that may already
    // carry a band. `session end` is re-runnable, and without this a second run
    // padded the padded video and stacked a second band under the first.
    const clean = precinematicVideoPath(video.path);
    if (existsSync(clean)) {
      await copyFile(clean, video.path);
    } else {
      await copyFile(video.path, clean);
    }
    const probed = await probeVideo(ffmpeg, video.path);
    const srtPath = `${video.path}.captions.srt`;
    await writeFile(
      srtPath,
      buildSrt(
        cues.map((c) => ({ start: c.startSec, end: c.endSec, text: c.text })),
        captionLineMax(probed?.width)
      ),
      "utf8"
    );
    const outPath = `${video.path}.captioned.webm`;
    const burned = await burnCaptionBand({
      ffmpeg,
      videoPath: video.path,
      srtPath,
      outPath,
      echo: (line) => process.stderr.write(`  · ${line}\n`),
    });
    if (!burned) {
      process.stderr.write(
        "  ⚠ captions not burned — this ffmpeg has no `subtitles` filter; the .srt is written alongside the video\n"
      );
      return;
    }
    await rename(outPath, video.path);
    video.bytes = await stat(video.path)
      .then((st) => st.size)
      .catch(() => video.bytes);
    process.stderr.write(`  ✓ ${cues.length} caption(s) burned\n`);
  } catch (err) {
    logger.warn({ err }, "could not burn showCaption captions");
  }
}

interface CinematicOpts {
  captions: boolean;
  prompt?: string;
  // Song mode: replace narration with one sung song (see narrate.ts).
  song?: boolean;
}

// Apply the opt-in cinematic pass (LLM narration + macOS TTS + burned captions +
// an opening title card) to the primary recording, AFTER condensing has stamped
// each step's position in the trimmed video. The pass re-times the video (it
// freezes each step's frame so its narration fits, then prepends a title card),
// which MOVES every step — so we replace each step.videoTime with the returned
// cinematic positions to keep the report/viewer timeline synced. Best-effort: on
// a non-macOS host, a missing `claude`/`say`, or any failure, the video is left
// as the plain condensed cut and the timeline is unchanged.
async function cinematizeSessionVideo(
  result: SessionEndResult,
  record: SessionRecord,
  opts: CinematicOpts
): Promise<void> {
  const video = result.artifacts.find((a) => a.kind === "video");
  if (!video) {
    return;
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    logger.info("ffmpeg not found; skipping cinematic pass");
    return;
  }
  // Keep references to the record steps we pass through, so the re-timed
  // positions can be written straight back onto them in order. Use the SAME
  // finiteness predicate cinematicProcess uses internally, so the returned
  // stepTimes line up index-for-index with timedSteps (no off-by-one).
  // Source each step's position from the preserved condensed time when present —
  // a cinematic re-run reads the clean condensed cut, and videoTime has by then
  // been overwritten with cinematic positions (precinematicVideoTime has not).
  const sourceTimeOf = (s: SessionStep): number | undefined =>
    s.precinematicVideoTime ?? s.videoTime;
  const timedSteps = record.steps.filter((s) =>
    Number.isFinite(sourceTimeOf(s))
  );
  const steps: CinematicStep[] = timedSteps.map((s) => ({
    name: s.name,
    script: s.script,
    durationMs: s.durationMs,
    videoTime: sourceTimeOf(s) as number,
  }));
  if (steps.length === 0) {
    // Steps are only timed when the video was condensed; --no-condense leaves
    // them untimed. Tell the user why their requested cinematic pass did nothing.
    process.stderr.write(
      "  ⚠ cinematic pass skipped: no timed steps (did you pass --no-condense?)\n"
    );
    logger.warn("no timed steps; skipping cinematic pass");
    return;
  }
  process.stderr.write(
    opts.song ? "Scoring a cinematic song…\n" : "Adding cinematic narration…\n"
  );
  const outcome = await cinematicProcess(video.path, steps, {
    ffmpegPath: ffmpeg,
    prompt: opts.prompt,
    captions: opts.captions,
    song: opts.song,
    log: logger,
    onProgress: (message) => process.stderr.write(`  · ${message}\n`),
  });
  if (!outcome.applied) {
    process.stderr.write(`  ⚠ cinematic pass skipped: ${outcome.reason}\n`);
    logger.warn({ reason: outcome.reason }, "cinematic pass not applied");
    return;
  }
  // Re-timing moved every step (per-step freezes + the title card), so REPLACE
  // each step's position with the cinematic one — keeping click-to-seek and the
  // playhead highlight aligned to the narrated cut.
  outcome.stepTimes?.forEach((t, i) => {
    const step = timedSteps[i];
    if (step) {
      // Persist the condensed source position on the first cinematic run (before
      // videoTime is overwritten) so future --cinematic re-runs reuse it.
      if (step.precinematicVideoTime === undefined) {
        step.precinematicVideoTime = steps[i]?.videoTime;
      }
      step.videoTime = t;
    }
  });
  video.bytes = await stat(video.path)
    .then((s) => s.size)
    .catch(() => video.bytes);
  process.stderr.write(
    opts.song ? "  ✓ song added\n" : "  ✓ narration added\n"
  );
  // Surface the chosen parameters so a delightful random run can be reproduced
  // (pin via --prompt and, for narration, $DAILIES_SAY_VOICE / $DAILIES_SAY_RATE).
  if (outcome.meta) {
    const { direction, voice, rate, song, music } = outcome.meta;
    process.stderr.write(
      song
        ? `  🎵 ${direction} · song: ${music}\n`
        : `  🎬 ${direction} · voice: ${voice} @ ${rate} wpm\n`
    );
  }
  // Surface any degradation (e.g. this ffmpeg lacks drawtext/subtitles) so the
  // user isn't left wondering where the title card or burned captions went.
  for (const note of outcome.notes ?? []) {
    process.stderr.write(`  ⚠ ${note}\n`);
  }
  logger.info({ video: video.path }, "cinematic pass applied");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the `session end` orchestrator — collect artifacts, resolve the verdict, condense, optionally run the cinematic pass, render the report; each stage is independently switchable by flag.
export async function sessionEnd(
  id: string,
  json: boolean,
  opts: SessionEndOpts = {}
): Promise<number> {
  const record0 = await readSessionRecord(id); // friendly "No such session" if unknown

  // Attach FIRST. Both the daemon and the on-disk fallback build their artifact
  // list as the session ends, so a file copied after that point never reaches
  // the report. Doing it here means a caller can't get the order wrong.
  if (opts.attach && opts.attach.length > 0) {
    const outcome = await attachFiles({
      files: opts.attach,
      log: logger,
      sessionDir: record0.artifactsDir,
    });
    if (outcome.attached.length > 0) {
      logger.info(
        { attached: outcome.attached },
        `attached ${outcome.attached.length} file(s): ${outcome.attached.join(", ")}`
      );
    }
    for (const failure of outcome.failures) {
      // Loudly, but never fatally: a bad path must not cost the whole report.
      logger.warn({ failure }, `could not attach ${failure}`);
    }
  }

  // Parsed early so a typo is reported before the session is torn down, when
  // the caller can still fix and re-run.
  let metrics: Metric[] = [];
  if (opts.metric && opts.metric.length > 0) {
    const parsed = parseMetrics(opts.metric);
    metrics = parsed.metrics;
    for (const bad of parsed.invalid) {
      logger.warn(
        { metric: bad },
        `ignoring --metric ${bad}: expected name=<number>, e.g. coverage=42.5`
      );
    }
  }

  const request: SessionEndRequest = {
    id: requestId("session-end"),
    type: "session-end",
    sessionId: id,
    reason: "end",
  };
  let result: SessionEndResult | undefined;
  let code = 1;
  try {
    code = await sendRequest(request, (data) => {
      result = data as SessionEndResult;
    });
  } catch (err) {
    // Daemon unreachable (e.g. it was stopped). Fall through to reconcile the
    // record and finalize a report from whatever artifacts are on disk.
    logger.warn(
      { err, sessionId: id },
      "daemon unreachable; finalizing from on-disk artifacts"
    );
  }

  // Was this session already ended before this call? Then the daemon has long
  // since dropped it, and its "Session not found" is the expected answer to a
  // deliberate re-finalize — not a failure. See the `degraded` note below.
  let wasAlreadyEnded = false;

  // Reconcile the on-disk record regardless of the daemon outcome: if the daemon
  // restarted / lost the session, never leave a zombie "active" record behind.
  const record = await updateSessionRecord(id, (r) => {
    wasAlreadyEnded = r.status !== "active";
    if (metrics.length > 0) {
      r.metrics = metrics;
    }
    if (r.status === "active") {
      r.status = "ended";
    }
    r.endedAt = new Date(result?.session.endedAt ?? Date.now()).toISOString();
    // Record the agent's explicit verdict (if given) so it drives the report's
    // pass/fail and survives a later re-render.
    if (opts.verdict) {
      r.verdict = opts.verdict;
    }
  });

  // Degraded = the daemon did not cleanly finalize a LIVE session (it was
  // unreachable, restarted, or returned an error), so the report is rebuilt
  // from whatever artifacts were already flushed to disk and may be partial.
  //
  // Re-running on an ALREADY-ended record is not that. It is the supported way
  // to re-render a report or re-cut a video (see the idempotence note further
  // down), and the daemon necessarily no longer holds the session — so its
  // "not found" is the expected answer, and exiting non-zero for it failed a CI
  // step that had just succeeded.
  let degraded = isDegradedEnd({
    daemonCode: code,
    hasResult: Boolean(result),
    wasAlreadyEnded,
  });
  if (wasAlreadyEnded) {
    logger.info(
      { sessionId: id },
      "session was already ended; re-finalizing from on-disk artifacts"
    );
  } else if (degraded) {
    logger.warn(
      { sessionId: id },
      "daemon could not finalize the session; building the report from on-disk artifacts"
    );
  }
  const endResult =
    code === 0 && result ? result : await endResultFromDisk(record);

  // The daemon stamps contentStartedAt when real content first painted (the first
  // non-about:blank load). For a normal session that happens DURING step 1 —
  // after session start already wrote the record — so it isn't on the record yet;
  // pull it from the end result now (a --url session already has it from start).
  // condense's head-trim uses it to drop the pre-content blank.
  if (
    !record.contentStartedAt &&
    typeof endResult.session.contentStartedAt === "number"
  ) {
    record.contentStartedAt = new Date(
      endResult.session.contentStartedAt
    ).toISOString();
  }

  // Scrub credentials out of the HAR before anything else can copy or share it.
  // Playwright records `Cookie` / `Authorization` verbatim, and a session
  // directory is meant to be handed to someone else.
  if (opts.scrubHar !== false) {
    const harArtifact = endResult.artifacts.find((a) => a.kind === "har");
    if (harArtifact) {
      const outcome = await scrubHarFile(harArtifact.path, logger);
      if (outcome.scrubbed) {
        if (outcome.replaced > 0) {
          logger.info(
            { har: harArtifact.path, replaced: outcome.replaced },
            `scrubbed ${outcome.replaced} credential value(s) from network.har`
          );
        }
      } else {
        // Loudly: the artifact is still on disk WITH its credentials, and the
        // whole point of the pass is that someone is about to share it.
        logger.warn(
          { har: harArtifact.path, reason: outcome.reason },
          "could not scrub network.har — it still contains credential headers; do not share this session directory"
        );
      }
    }
  }

  // The preserved condensed cut (written by a prior condense) marks the video as
  // already-condensed. Skip condensing then: it's destructive + in-place, so
  // re-condensing an already-condensed video would shrink it again and desync the
  // stamped step times. A later cinematic pass sources from the preserved cut and
  // its stamped timings instead. First runs (raw video) condense normally.
  const videoArtifact = endResult.artifacts.find((a) => a.kind === "video");
  const cinematicRequested = opts.cinematic === true || opts.song === true;
  // page.showCaption cues, in condensed time. Burned below in plain mode; the
  // cinematic pass writes its own captions from the narration instead.
  let cues: CaptionCue[] = [];
  const alreadyCondensed =
    videoArtifact !== undefined &&
    existsSync(precinematicVideoPath(videoArtifact.path));
  if (opts.condense !== false && !alreadyCondensed) {
    cues = await condenseSessionVideos(
      endResult,
      record,
      await readCaptions(endResult.session.artifactsDir)
    );
    // Persist the stamped step videoTimes now (not just in the cinematic branch)
    // so a LATER `session end --cinematic` on this already-condensed session can
    // source them without re-condensing.
    await writeSessionRecord(record).catch((err) =>
      logger.warn(
        { err, sessionId: id },
        "could not persist condensed step timings"
      )
    );
  } else if (alreadyCondensed && cinematicRequested) {
    process.stderr.write(
      "  ↻ re-running cinematic from the preserved condensed cut\n"
    );
  }

  // Decide WHICH recording gets finished before anything finishes one. Runs on
  // every path, including the re-finalize above that skips condensing — that is
  // the path where picking the wrong page would otherwise be permanent.
  await promotePrimaryVideo(endResult, opts.video);

  // Cinematic narration (or a cinematic song) is opt-in and runs after condensing
  // (it keys off the stamped step.videoTime and the trimmed video). Default output
  // is unchanged.
  if (cinematicRequested) {
    await cinematizeSessionVideo(endResult, record, {
      prompt: opts.prompt,
      captions: opts.captions !== false,
      song: opts.song,
    });
    // Persist the step timings the cinematic pass stamped — notably
    // precinematicVideoTime (the condensed source positions). Step times are
    // otherwise only in-memory at session end; without this a re-run would have
    // no preserved timings to source from after we skip re-condensing.
    await writeSessionRecord(record).catch((err) => {
      logger.warn(
        { err, sessionId: id },
        "could not persist cinematic timings"
      );
    });
  }

  // Plain mode: the captions the run showed are burned from the recorded data,
  // into the same band the cinematic pass uses. Nothing was painted during
  // recording, so this is the only thing that puts them on screen — and it runs
  // here, at finalize, which is what lets one recording be finished in any mode.
  if (!cinematicRequested && opts.captions !== false && cues.length > 0) {
    await burnPlainCaptions(endResult, cues);
  }

  // Resilient like `session abort`: a report-write failure must not crash the
  // command after the record was already flipped to "ended" (it can be rebuilt
  // by re-running `session end`, which is idempotent on an ended record).
  // Capture the run's verdict from the manifest so CI can gate on it.
  let runStatus: "passed" | "failed" | "aborted" | undefined;
  let verdictReason: string | undefined;
  try {
    const manifest = await writeSessionReport(id, record, endResult);
    runStatus = manifest.status;
    verdictReason = manifest.verdictReason;
  } catch (err) {
    degraded = true;
    logger.warn({ err, sessionId: id }, "failed to write the session report");
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          artifactsDir: endResult.session.artifactsDir,
          artifacts: endResult.artifacts,
          reportPath: sessionReportPath(id),
          resultsPath: sessionResultsPath(id),
          // The run verdict (agent-declared or the fallback tally) + any reason,
          // so a CI job can fail the build on a failed session.
          // Named numbers this run produced (--metric), for a caller that
          // wants to report or compare them.
          metrics,
          status: runStatus,
          verdictReason,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(
      `Session ${id} ended.\nArtifacts: ${endResult.session.artifactsDir}\nReport:    ${sessionReportPath(id)}\n${runStatus ? `Result:    ${runStatus.toUpperCase()}${verdictReason ? ` — ${verdictReason}` : ""}\n` : ""}`
    );
  }

  // Open the rendered report in the OS default browser when asked (the
  // interactive flow passes --open so the user sees it without an extra step).
  if (opts.open) {
    const reportPath = sessionReportPath(id);
    if (!json) {
      process.stdout.write(`Opening ${reportPath}…\n`);
    }
    openInOSDefault(reportPath);
  }

  if (opts.stopDaemon) {
    await stopDaemonIfIdle(id, json);
  }
  // Surface a non-zero exit when the daemon could not cleanly finalize the
  // session (or the report failed to write), so a CI wrapper can distinguish a
  // clean end from a degraded reconcile. The report is still written either way.
  if (degraded) {
    return code === 0 ? 1 : code;
  }
  return 0;
}
