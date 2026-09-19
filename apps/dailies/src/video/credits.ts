// A scrolling end-credits clip for the cinematic video pipeline (narrate.ts).
// It lists who authored the commits on the current branch that aren't yet in
// main, scrolls them bottom-to-top, and is encoded to EXACTLY match narrate's
// other segments (libvpx/webm, source geometry, CFR) so the concat demuxer can
// stream-copy it onto the end of the cinematic cut without re-encoding or
// corrupting the picture.
//
// Subprocess style mirrors narrate.ts / condense.ts: a single promisified
// `execFile` (node:child_process, not execa) with a bumped maxBuffer and a hard
// timeout. Reading contributors is best-effort — any git failure yields [] —
// but the encode itself may throw (the caller wraps it, exactly as narrate's
// stages run inside cinematicProcess's try/catch).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENCODE_TIMEOUT_MS, type ProbedVideo } from "./ffmpeg.js";

export type { ProbedVideo } from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

// macOS ffmpeg is usually built without fontconfig, so drawtext needs an
// explicit font file rather than a font name (mirrors narrate's TITLE_FONT_FILE).
const TITLE_FONT_FILE = "/System/Library/Fonts/Helvetica.ttc";

// git log is fast, but bound it like narrate's other probes so a wedged repo
// can't hang the pipeline.
const GIT_TIMEOUT_MS = 30_000;

// Roll pacing. Each line holds the screen for ~LINE_SEC; the whole crawl is
// clamped to [MIN_SEC, MAX_SEC] so a huge repo can't tack on a multi-minute
// scroll onto the end of every video.
const LINE_SEC = 0.7;
const MIN_SEC = 4;
const MAX_SEC = 20;

// Cap the named contributors so the block stays legible (and bounded); the rest
// collapse into a single "and N more" line that still scrolls past.
const MAX_NAMED = 20;

export interface Contributor {
  commits: number;
  name: string;
}

// A titled block in the credits roll (e.g. "Featuring", "Music", "Made with").
export interface CreditSection {
  entries: string[];
  title?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested). No I/O, no subprocesses.
// ---------------------------------------------------------------------------

// Parse `git log --format=%an` output (one author per line) into contributors,
// sorted by commit count desc then name asc. Trims each line, ignores blanks,
// dedupes by exact name.
export function parseContributors(gitLogStdout: string): Contributor[] {
  const counts = new Map<string, number>();
  for (const raw of gitLogStdout.split("\n")) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, commits]) => ({ name, commits }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

// Vertical distance (px) the text block must travel so it enters from below the
// frame and fully exits past the top: the frame height plus the block's own
// height. lineCount counts every rendered line (body + any heading lines).
function scrollTravelPx(lineCount: number, geometryHeight: number): number {
  const lineHeight = creditsLineHeight(geometryHeight);
  return geometryHeight + lineCount * lineHeight;
}

// Per-line height (px), derived from the frame so the roll scales with
// resolution; floored so tiny frames still render readable text.
function creditsLineHeight(geometryHeight: number): number {
  return Math.max(24, Math.round(geometryHeight / 16));
}

// Total roll duration (seconds) for `lineCount` rendered lines, clamped to
// [MIN_SEC, MAX_SEC]. Scales with the line count between the bounds so more
// names take (a little) longer, but a huge repo never exceeds MAX_SEC. The
// geometryHeight participates only via the unclamped pacing target; the clamp
// is what guarantees the bound. buildCreditsRoll derives the scroll SPEED from
// THIS duration (travel / duration) so all lines pass through regardless of the
// clamp.
export function creditsDurationSec(
  lineCount: number,
  geometryHeight: number
): number {
  // A short pad so the first line isn't already mid-frame at t=0 and the frame
  // height itself contributes some travel time at the chosen pace.
  const heightPad = geometryHeight / scrollTravelPx(lineCount, geometryHeight);
  const target = (lineCount + heightPad) * LINE_SEC;
  return Math.min(MAX_SEC, Math.max(MIN_SEC, target));
}

// drawtext is sensitive to colons, single quotes, backslashes and percent;
// newlines would split the arg, so collapse them. Names are git-derived and may
// contain any of these.
function escapeDrawText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

// Assemble the credit sections shown in the roll, in order: the people, the
// music, then the tools. Caps the named contributors (the rest collapse into an
// "and N more" line) and drops empty sections. Pure → unit-tested.
export function buildCreditSections(args: {
  contributors: Contributor[];
  music?: string;
  models: string[];
}): CreditSection[] {
  const sections: CreditSection[] = [];
  if (args.contributors.length > 0) {
    const named = args.contributors.slice(0, MAX_NAMED).map((c) => c.name);
    const extra = args.contributors.length - named.length;
    if (extra > 0) {
      named.push(`and ${extra} more`);
    }
    sections.push({ title: "Featuring", entries: named });
  }
  if (args.music?.trim()) {
    sections.push({ title: "Music", entries: [args.music.trim()] });
  }
  if (args.models.length > 0) {
    sections.push({ title: "Made with", entries: args.models });
  }
  return sections;
}

// The roll's raw (unescaped, unwrapped) text lines: an optional heading (the film
// title), then each non-empty section separated by a blank line, its title (when
// set) above its entries. buildCreditsRoll word-wraps these to the frame and
// escapes them before drawing. Pure → unit-tested.
export function creditsLines(
  sections: CreditSection[],
  heading: string | undefined
): string[] {
  const lines: string[] = [];
  const headingText = heading?.trim();
  if (headingText) {
    lines.push(headingText);
  }
  for (const section of sections) {
    if (section.entries.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push(""); // blank separator between blocks
    }
    if (section.title?.trim()) {
      lines.push(section.title.trim());
    }
    lines.push(...section.entries);
  }
  return lines;
}

// Greedy word-wrap to `maxChars`, keeping an over-long single token whole. Keeps
// a long heading (e.g. the film title) from overflowing the frame width.
function wrapLine(line: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const out: string[] = [];
  let current = "";
  for (const word of line.trim().split(/\s+/).filter(Boolean)) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current !== "") {
    out.push(current);
  }
  return out.length > 0 ? out : [line];
}

// ---------------------------------------------------------------------------
// Subprocess helpers.
// ---------------------------------------------------------------------------

// cwd matters for `git log` (it must run inside the repo); ffmpeg doesn't care,
// so it's optional.
async function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

// Run `git log <base>..HEAD --format=%an` in repoDir and parse it into
// contributors. Best-effort: returns [] on any git failure (not a repo,
// detached HEAD, unknown base, no commits ahead of base).
export async function branchContributors(
  repoDir: string,
  base = "main"
): Promise<Contributor[]> {
  try {
    const { stdout } = await run(
      "git",
      ["log", `${base}..HEAD`, "--format=%an"],
      GIT_TIMEOUT_MS,
      repoDir
    );
    return parseContributors(stdout);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Encode.
// ---------------------------------------------------------------------------

// Build the scrolling-credits webm at EXACTLY geometry.width×height, CFR
// (fps + setpts), libvpx, yuv420p, silent — matching narrate's encodeSlice /
// buildTitleCard output so the concat demuxer can stream-copy it onto the end of
// the cinematic cut. Returns the clip's duration in seconds.
//
// Layout: one multi-line drawtext, centered horizontally, white, in the explicit
// title font. The block's top starts just below the frame and its `y` decreases
// linearly with `t` (y = base - t*SPEED) so the whole block scrolls up and fully
// exits. SPEED is derived from the (clamped) duration and the total travel so
// every line passes through regardless of how many names there are.
export async function buildCreditsRoll(args: {
  ffmpeg: string;
  sections: CreditSection[];
  heading?: string;
  geometry: ProbedVideo;
  outPath: string;
}): Promise<number> {
  const { ffmpeg, sections, heading, geometry, outPath } = args;
  const fontSize = creditsLineHeight(geometry.height);
  // Wrap each raw line to the frame width (so a long heading/name doesn't spill
  // off both edges), THEN escape for drawtext. Wrapping before escaping keeps a
  // split from landing inside an escape sequence.
  const maxChars = Math.max(
    8,
    Math.floor((geometry.width * 0.85) / (fontSize * 0.52))
  );
  const rawLines = creditsLines(sections, heading).flatMap((line) =>
    wrapLine(line, maxChars)
  );
  // Always render at least one line so a contributor-less branch still produces
  // a valid (brief) clip rather than an empty drawtext.
  const renderLines = (rawLines.length > 0 ? rawLines : ["—"]).map(
    escapeDrawText
  );

  const lineCount = renderLines.length;
  const durationSec = creditsDurationSec(lineCount, geometry.height);

  const lineSpacing = Math.round(fontSize / 2);
  // Join the (escaped) lines with literal newlines for drawtext's multi-line
  // layout. Do NOT re-escape — escapeDrawText collapses newlines to spaces.
  const text = renderLines.join("\n");

  const drawtext = [
    `fontfile=${TITLE_FONT_FILE}`,
    `text='${text}'`,
    "fontcolor=white",
    `fontsize=${fontSize}`,
    `line_spacing=${lineSpacing}`,
    "text_align=center",
    "x=(w-text_w)/2",
    // The block's top starts at the bottom edge (y=h) and rises so that over
    // `durationSec` it travels the full frame height PLUS the block's own
    // rendered height (text_h, which drawtext measures including line_spacing) —
    // so the last line clears the top edge exactly as the clip ends.
    `y=h-t*(h+text_h)/${durationSec.toFixed(3)}`,
  ].join(":");

  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${geometry.width}x${geometry.height}:r=${geometry.frameRate}:d=${durationSec.toFixed(3)}`,
      // Match encodeSlice's CFR pinning (fps + setpts) so this segment's exact
      // duration and timebase line up with the rest before the concat-copy.
      "-vf",
      `drawtext=${drawtext},fps=${geometry.frameRate},setpts=N/FRAME_RATE/TB`,
      "-r",
      String(geometry.frameRate),
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      outPath,
    ],
    // The encode failing is an infrastructure error, not a content one — let it
    // throw so the caller (which wraps this) treats it like narrate's stages.
    ENCODE_TIMEOUT_MS
  );

  return durationSec;
}
