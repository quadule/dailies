// ffmpeg/ffprobe primitives for probing media, filters, encoding and trimming.

import { writeFile } from "node:fs/promises";
import { type Echo, run, VERSION_PROBE_TIMEOUT_MS } from "../util/process.js";

// Compatibility exports while callers migrate to the general utility module.
// biome-ignore lint/performance/noBarrelFile: temporary compatibility for callers migrating to util/process.
export {
  type Echo,
  isOnPath,
  mapLimit,
  run,
  VERSION_PROBE_TIMEOUT_MS,
} from "../util/process.js";

// Timeouts (ms). The version/filter probes are quick; file probes get a little
// longer; encodes/muxes are bounded like condense's encode pass.
const PROBE_TIMEOUT_MS = 30_000;
export const ENCODE_TIMEOUT_MS = 300_000;

// Flags every ffmpeg encode/mux/concat here starts with: no banner, no stats
// spam, overwrite the output. (Probe calls that only read a file omit -y.)
export const FFMPEG_BASE_ARGS = ["-hide_banner", "-nostats", "-y"] as const;

export interface ProbedVideo {
  frameRate: number;
  height: number;
  width: number;
}

// Parse a "Duration: HH:MM:SS.ms" line out of ffmpeg's `-i` stderr.
export function parseDurationFromStderr(stderr: string): number | undefined {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) {
    return;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (
    !(
      Number.isFinite(hours) &&
      Number.isFinite(minutes) &&
      Number.isFinite(seconds)
    )
  ) {
    return;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

// Measure an audio clip's duration in seconds: ffprobe if present, else the
// ffmpeg `-i` stderr Duration line (mirrors condense relying on ffmpeg for
// timing when a dedicated probe isn't available).
export async function audioDurationSec(
  ffmpeg: string,
  filePath: string
): Promise<number | undefined> {
  const duration = await probeDurationSec(ffmpeg, filePath);
  if (duration !== undefined) {
    return duration;
  }
  try {
    const { stderr } = await run(
      ffmpeg,
      ["-hide_banner", "-i", filePath],
      PROBE_TIMEOUT_MS
    );
    return parseDurationFromStderr(stderr);
  } catch (err) {
    // `ffmpeg -i` with no output exits non-zero but still prints Duration.
    if (err instanceof Error && "stderr" in err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return parseDurationFromStderr(stderr);
    }
    return;
  }
}

// ffprobe normally sits beside ffmpeg with the same name suffix.
export function ffprobeFor(ffmpeg: string): string {
  const slash = Math.max(ffmpeg.lastIndexOf("/"), ffmpeg.lastIndexOf("\\"));
  const dir = slash >= 0 ? ffmpeg.slice(0, slash + 1) : "";
  const base = slash >= 0 ? ffmpeg.slice(slash + 1) : ffmpeg;
  return base.startsWith("ffmpeg")
    ? dir + base.replace("ffmpeg", "ffprobe")
    : "ffprobe";
}

// Probe the source video's geometry so the title card can be encoded to match
// (so the concat demuxer can stream-copy). r_frame_rate comes back as a
// fraction like "30/1".
export async function probeVideo(
  ffmpeg: string,
  videoPath: string
): Promise<ProbedVideo | undefined> {
  const ffprobe = ffprobeFor(ffmpeg);
  try {
    const { stdout } = await run(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate",
        "-of",
        "default=noprint_wrappers=1",
        videoPath,
      ],
      PROBE_TIMEOUT_MS
    );
    const width = Number(stdout.match(/width=(\d+)/)?.[1]);
    const height = Number(stdout.match(/height=(\d+)/)?.[1]);
    const frameRate = parseFrameRate(
      stdout.match(/r_frame_rate=([\d/]+)/)?.[1]
    );
    if (width > 0 && height > 0 && frameRate > 0) {
      return { width, height, frameRate };
    }
  } catch {
    // no ffprobe — caller falls back to a default geometry.
  }
  return;
}

// How long a video runs, in seconds. After condensing, a recording's length IS how
// much of the session happened on that page, which is how the finalizer decides
// which page to finish when a run recorded more than one.
export async function probeDurationSec(
  ffmpeg: string,
  videoPath: string,
  options: { timeoutMs?: number } = {}
): Promise<number | undefined> {
  const ffprobe = ffprobeFor(ffmpeg);
  try {
    const { stdout } = await run(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      options.timeoutMs ?? PROBE_TIMEOUT_MS
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    // No ffprobe — the caller falls back to comparing file sizes.
    return;
  }
}

// The set of filters this ffmpeg build supports. Stripped-down builds omit
// drawtext (title card) and subtitles (caption burn) — even some Homebrew builds
// lack drawtext when compiled without freetype. We probe so the pipeline can do
// as much as the build allows instead of failing wholesale. (Playwright's
// bundled ffmpeg is far below that floor and findFfmpeg no longer offers it; see
// the note at the top of condense.ts.)
export function parseFilterNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Filter rows look like " T. adelay   A->A   Delay…"; the I/O column
    // ("A->A", "N->N", "VV->V") marks a real row. The name is the 2nd token.
    if (!line.includes("->")) {
      continue;
    }
    const name = line.trim().split(/\s+/)[1];
    if (name && /^[a-z0-9_]+$/i.test(name)) {
      names.add(name);
    }
  }
  return names;
}

export async function availableFilters(ffmpeg: string): Promise<Set<string>> {
  try {
    const { stdout } = await run(
      ffmpeg,
      ["-hide_banner", "-filters"],
      VERSION_PROBE_TIMEOUT_MS
    );
    return parseFilterNames(stdout);
  } catch {
    return new Set();
  }
}

export function parseFrameRate(fraction: string | undefined): number {
  if (!fraction) {
    return 0;
  }
  const parts = fraction.split("/").map(Number);
  const num = parts[0] ?? 0;
  if (!(Number.isFinite(num) && num > 0)) {
    return 0;
  }
  const den = parts[1];
  if (den === undefined) {
    return num;
  }
  if (!(Number.isFinite(den) && den > 0)) {
    return 0;
  }
  return num / den;
}

export async function encodeSlice(args: {
  ffmpeg: string;
  src: string;
  startSec: number;
  durSec: number;
  holdSec: number;
  frameRate: number;
  outPath: string;
  // Optional: freeze the FIRST frame for this long before the footage plays (a
  // "beat" before the action — frames both narration and song steps).
  startHoldSec?: number;
  // Optional: play the footage this many times faster, so `durSec` of source
  // occupies durSec/speed of the output. Used to fast-forward the stretches of a
  // demo nobody narrates (see planRetime). Only the FOOTAGE is compressed, never
  // a hold — the caller guarantees a sped slice has none.
  speed?: number;
}): Promise<void> {
  const { ffmpeg, src, startSec, durSec, holdSec, frameRate, outPath } = args;
  const startHold = args.startHoldSec ?? 0;
  const speed = args.speed && args.speed > 1 ? args.speed : 1;
  // Force constant frame rate the way condense.ts does (fps + setpts), so each
  // slice's actual duration matches `-t`/`tpad` exactly. Without this, libvpx
  // slices come up tens of ms short and the per-segment error ACCUMULATES across
  // the concat, drifting narration/captions off the picture on long sessions.
  const fps = frameRate > 0 ? frameRate : 30;
  const chain: string[] = [];
  // Pin CFR, then pad with frozen frames at the head/tail, then reset PTS for an
  // exact-duration segment.
  chain.push(`fps=${fps}`);
  if (speed !== 1) {
    // setpts compresses the timeline; the fps that follows drops the frames that
    // compression made surplus, so the final CFR renumbering below lands on an
    // exact durSec/speed. Doing it in one step (a lone fps=rate/speed) does NOT
    // work: the closing setpts reads FRAME_RATE from the chain, so it would
    // renumber at the reduced rate and undo the speed-up.
    //
    // This sits BEFORE tpad deliberately: only the FOOTAGE is meant to speed up.
    // A hold is a freeze measured in OUTPUT seconds, so cloning it after the
    // compression keeps it the length the caller planned.
    chain.push(`setpts=PTS/${speed.toFixed(4)}`, `fps=${fps}`);
  }
  if (startHold > 0 || holdSec > 0) {
    const opts: string[] = [];
    if (startHold > 0) {
      opts.push(`start_mode=clone:start_duration=${startHold.toFixed(3)}`);
    }
    if (holdSec > 0) {
      opts.push(`stop_mode=clone:stop_duration=${holdSec.toFixed(3)}`);
    }
    // Filter args: name=opt1:opt2 (the FIRST separator is '=', not ':').
    chain.push(`tpad=${opts.join(":")}`);
  }
  chain.push("setpts=N/FRAME_RATE/TB");
  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
      "-ss",
      startSec.toFixed(3),
      "-t",
      durSec.toFixed(3),
      "-i",
      src,
      "-vf",
      chain.join(","),
      "-r",
      String(fps),
      "-an",
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// Concat N stream-copyable segments (all libvpx/webm here) in order.
export async function concatSegments(
  ffmpeg: string,
  paths: string[],
  outPath: string,
  listPath: string
): Promise<void> {
  const list = paths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listPath, `${list}\n`);
  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

export async function trimAudio(args: {
  ffmpeg: string;
  src: string;
  startSec: number;
  outPath: string;
  echo?: Echo;
}): Promise<void> {
  const { ffmpeg, src, startSec, outPath, echo } = args;
  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
      ...(startSec > 0.05 ? ["-ss", startSec.toFixed(3)] : []),
      "-i",
      src,
      "-ac",
      "2",
      "-ar",
      "44100",
      outPath,
    ],
    ENCODE_TIMEOUT_MS,
    echo
  );
}
