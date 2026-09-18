// Subprocess helpers (generalized from condense's runFfmpeg) plus the ffmpeg /
// ffprobe primitives used across the cinematic pipeline: probing geometry and
// duration, discovering available filters, and the low-level encode/concat/trim
// building blocks. `run` is also used by the speech and LLM/git helpers, so it
// (and the shared consts/types) are exported.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { formatCommand } from "./shell.js";

// `execFile`/`promisify(execFile)` always leaves the child's stdin open as an
// unconnected pipe — there's no option to close it. That's harmless for ffmpeg,
// but `claude -p` probes stdin for piped input, stalls for 3s waiting on that
// dangling pipe, emits a "no stdin data received" warning, and then fails the
// whole invocation. Spawning directly lets us set stdin to "ignore" so the
// child sees EOF immediately, matching how these commands are meant to be run
// (never fed via stdin here).
function execFileWithClosedStdin(
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(
          Object.assign(new Error(`${cmd} timed out after ${opts.timeout}ms`), {
            stderr,
          })
        );
      });
    }, opts.timeout);

    const onOverflow = () =>
      finish(() => {
        child.kill("SIGKILL");
        reject(
          Object.assign(new Error(`${cmd} output exceeded maxBuffer`), {
            stderr,
          })
        );
      });

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > opts.maxBuffer) {
        return onOverflow();
      }
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes > opts.maxBuffer) {
        return onOverflow();
      }
      stderr += d;
    });
    child.on("error", (err) => {
      finish(() => reject(Object.assign(err, { stderr, stdout })));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            Object.assign(new Error(`Command failed: ${cmd}`), {
              stderr,
              stdout,
            })
          );
        }
      });
    });
  });
}

// Timeouts (ms). The version/filter probes are quick; file probes get a little
// longer; encodes/muxes are bounded like condense's encode pass.
export const VERSION_PROBE_TIMEOUT_MS = 10_000;
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

// A user-facing line emitter (routed to onProgress → stderr). Optional so probes
// stay silent; generation sites pass one so the exact command is shown.
export type Echo = (line: string) => void;

// Run a command and return its stdout/stderr. Bumped maxBuffer and a hard
// timeout, like condense's runFfmpeg. Throws on non-zero exit / timeout — every
// caller is inside cinematicProcess's try/catch. When `echo` is supplied the
// exact command is printed first (copy-paste reproduction); probes omit it so
// version checks (`say -v ?`, `ffmpeg -version`, `git …`) don't spam the output.
export async function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  echo?: Echo
): Promise<{ stdout: string; stderr: string }> {
  echo?.(`$ ${formatCommand(cmd, args)}`);
  try {
    const { stdout, stderr } = await execFileWithClosedStdin(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    // execFile's error message is just "Command failed: <cmd>"; append the tail of
    // the tool's own stderr so failures (esp. ffmpeg filtergraph errors) are
    // diagnosable instead of opaque. `claude -p` reports its errors as JSON on
    // stdout even on non-zero exit (e.g. "Not logged in"), leaving stderr
    // empty — fall back to stdout's tail in that case rather than the bare
    // "Command failed" message.
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const source = (e.stderr ?? "").trim() || (e.stdout ?? "").trim();
    const tail = source.split("\n").slice(-4).join("\n");
    throw new Error(
      `${cmd} failed${tail ? `:\n${tail}` : `: ${e.message ?? String(err)}`}`
    );
  }
}

// Run `task` over every item with at most `limit` of them in flight, returning
// the results in INPUT order (not completion order) so a caller can keep its
// arrays in lockstep. Used to overlap independent subprocess work — the spawns
// are the slow part and they don't depend on each other.
//
// On a rejection: no further items are started, the in-flight ones are allowed to
// settle (so nothing rejects after this resolves), and the LOWEST-index failure is
// rethrown — deterministic regardless of which one landed first, so a caller that
// lets errors through fails the same way a serial loop would.
// Pure control flow → unit-tested.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const errors = new Map<number, unknown>();
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && errors.size === 0) {
      const index = next;
      next++;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      try {
        results[index] = await task(item, index);
      } catch (err) {
        errors.set(index, err);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  if (errors.size > 0) {
    throw errors.get(Math.min(...errors.keys()));
  }
  return results;
}

// Is a binary callable on PATH? Best-effort probe used for preconditions.
export async function isOnPath(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, VERSION_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
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
        filePath,
      ],
      PROBE_TIMEOUT_MS
    );
    const value = Number(stdout.trim());
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  } catch {
    // ffprobe missing or failed — fall through to ffmpeg stderr.
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
  const dir = path.dirname(ffmpeg);
  const base = path.basename(ffmpeg);
  if (base.startsWith("ffmpeg")) {
    return path.join(dir, base.replace("ffmpeg", "ffprobe"));
  }
  return "ffprobe";
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
  videoPath: string
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
      PROBE_TIMEOUT_MS
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    // No ffprobe — the caller falls back to comparing file sizes.
    return;
  }
}

// The set of filters this ffmpeg build supports. Minimal builds — notably
// Playwright's bundled ffmpeg — omit drawtext (title card) and subtitles
// (caption burn); even some Homebrew builds lack drawtext when compiled without
// freetype. We probe so the pipeline can do as much as the build allows instead
// of failing wholesale.
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
