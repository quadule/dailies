// Cinematic post-processing for session videos (opt-in via `dailies session end
// --cinematic`). After condensing, this turns a silent screen recording into a
// narrated short: an LLM (`claude -p`) writes themed narration for each step,
// macOS `say` reads it aloud, and ffmpeg re-times the video so each step holds
// its frame long enough for its narration (clips never overlap), prepends an
// opening title card, mixes the narration in, and (optionally) burns matching
// captions. A sibling `.srt` is always written for soft-sub players.
//
// Everything here is best-effort and gated: the pipeline only runs on macOS
// (it needs `say`), only when `claude` and `say` are on PATH, and any failure
// — a missing binary, an ffmpeg error, malformed LLM output — leaves the
// original video untouched and returns { applied:false }. Non-cinematic output
// is therefore byte-identical to before.
//
// Subprocess style mirrors condense.ts: a single promisified `execFile`
// (`node:child_process`, NOT execa — not a dependency) with a bumped maxBuffer
// and a timeout on every spawn. Temp files are siblings of the video and are
// all cleaned up in a finally, even on partial failure.
import { existsSync } from "node:fs";
import {
  access,
  copyFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "dailies-logger";
import { resolveAceStepMusic } from "./acestep.js";
import { songStepOnsets } from "./align.js";
import { pickLoudestOffset, resolveArchiveMusic } from "./archive.js";
import {
  branchContributors,
  buildCreditSections,
  buildCreditsRoll,
  type Contributor,
  type CreditSection,
} from "./credits.js";
import {
  audioDurationSec,
  availableFilters,
  concatSegments,
  type Echo,
  ENCODE_TIMEOUT_MS,
  encodeSlice,
  FFMPEG_BASE_ARGS,
  isOnPath,
  mapLimit,
  type ProbedVideo,
  probeVideo,
  run,
  trimAudio,
} from "./ffmpeg.js";
import { createLocalTitleBackground } from "./local-background.js";
import { resolveLocalImage } from "./local-image.js";
import { resolveOmlxProviders } from "./omlx.js";
import {
  type MediaProviders,
  type MusicProvider,
  resolveMediaProviders,
  type TitleBackgroundProvider,
  type TtsProvider,
} from "./providers.js";
import {
  buildLyricsPrompt,
  buildNarrationPrompt,
  describeChange,
  LYRICS_SCHEMA,
  type Lyrics,
  NARRATION_SCHEMA,
  type Narration,
  parseLyricsJson,
  parseNarrationJson,
  resolveBase,
  resolveDirection,
  runLlmJson,
} from "./script-llm.js";
import { selectSongCaptions } from "./song-captions.js";
import { resolveSpeech, type SpeechSynth, speechText } from "./speech.js";
import { buildSrt, captionLineMax } from "./srt.js";
import type { ThemeCategory } from "./themes.js";
import { transcribeSong } from "./transcribe.js";
import { resolveWikimediaImage } from "./wikimedia.js";

// Opening title-card length, prepended to the front of the video. Every
// narration/caption offset is shifted by this so the on-screen step still lines
// up with its audio. The caller adds it to each step's report timeline too.
export const TITLE_SEC = 2.5;

// macOS ffmpeg is usually built without fontconfig, so drawtext needs an
// explicit font file rather than a font name.
const TITLE_FONT_FILE = "/System/Library/Fonts/Helvetica.ttc";

// Default font candidates, in order, across platforms — so the title card works
// on a Linux CI runner (with fonts-dejavu/liberation installed), not just macOS.
const DEFAULT_FONTS = [
  TITLE_FONT_FILE,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

// First existing font among the preferred one then the cross-platform defaults,
// or undefined when nothing is installed (caller then skips the styled text).
function resolveFont(preferred?: string): string | undefined {
  const candidates = preferred ? [preferred, ...DEFAULT_FONTS] : DEFAULT_FONTS;
  return candidates.find((f) => existsSync(f));
}

// A small, curated title-card look per theme category: a font that fits the genre
// and a high-contrast color (always rendered over a dark scrim, so brights read).
// Not a font-discovery engine — just enough to make the card feel intentional.
// Unknown/missing fonts fall back to Helvetica/white via titleStyle().
const TITLE_STYLES: Record<ThemeCategory, { font: string; color: string }> = {
  movie: { font: "/System/Library/Fonts/Times.ttc", color: "white" },
  tv: { font: "/System/Library/Fonts/Supplemental/Futura.ttc", color: "white" },
  documentary: {
    font: "/System/Library/Fonts/Helvetica.ttc",
    color: "0xF5F5F0",
  },
  commercial: {
    font: "/System/Library/Fonts/Supplemental/Impact.ttf",
    color: "0xFFD400",
  },
  training: { font: "/System/Library/Fonts/Helvetica.ttc", color: "0x7FE0FF" },
  radio: {
    font: "/System/Library/Fonts/Supplemental/Courier New.ttf",
    color: "0xFFB347",
  },
  sports: {
    font: "/System/Library/Fonts/Supplemental/Impact.ttf",
    color: "white",
  },
  game_show: {
    font: "/System/Library/Fonts/Supplemental/Impact.ttf",
    color: "0xFFD400",
  },
  soap: {
    font: "/System/Library/Fonts/Supplemental/Georgia.ttf",
    color: "0xFFE9F0",
  },
  news: { font: "/System/Library/Fonts/Helvetica.ttc", color: "white" },
  kids: { font: "/System/Library/Fonts/SFNSRounded.ttf", color: "0xFF7AD9" },
};

const DEFAULT_TITLE_STYLE = { font: TITLE_FONT_FILE, color: "white" };

// Resolve the title-card font+color for a category. The font is the category's
// preferred face if installed, else the first available cross-platform default,
// else undefined (no usable font on this host → the caller skips the title card).
export function titleStyle(category: ThemeCategory | undefined): {
  font: string | undefined;
  color: string;
} {
  const pref = (category && TITLE_STYLES[category]) || DEFAULT_TITLE_STYLE;
  return { font: resolveFont(pref.font), color: pref.color };
}

// Score gains: the single cinematic-mode song sits low under the spoken
// narration, then swells to (near-)full for the credits roll. The ramp is the
// cross-fade length in seconds between the two.
const NARRATION_MUSIC_GAIN = 0.16;
const CREDITS_MUSIC_GAIN = 0.6;
const MUSIC_SWELL_RAMP_SEC = 1.5;

export interface CinematicStep {
  durationMs: number;
  name: string;
  script?: string;
  // Step position in the CONDENSED video, seconds (before the title card is
  // prepended).
  videoTime: number;
}

export interface CinematicOptions {
  // false when --no-captions: the .srt is still written, only the burn is
  // skipped.
  captions: boolean;
  ffmpegPath: string;
  log: Logger;
  // Called as each stage starts so the caller can show the user live progress
  // (this pass takes a while — LLM call, TTS, several encodes).
  onProgress?: (message: string) => void;
  // Verbatim user steer (--prompt) for theme/tone/style; when set, the random
  // theme + style draw is skipped and this drives the narration.
  prompt?: string;
  // Directory of the project under review — its branch (vs configured base) sets
  // the contributor credits and scales the narration. Defaults to process.cwd().
  repoDir?: string;
  // Song mode: replace per-step spoken narration with ONE sung song (LLM-written
  // themed lyrics performed by a singing music model over the whole video). No TTS;
  // the video is re-timed so each step's footage lands while its lyric line is sung,
  // and captions (timed to the vocals) are burned in. Needs a lyrics-capable music
  // provider (ACE-Step or Gemini Lyria).
  song?: boolean;
}

export interface CinematicMeta {
  // Human-readable creative direction (the random theme+style, or the --prompt),
  // surfaced so a good run can be reproduced.
  direction: string;
  music?: string;
  // Narration mode: the speaking rate (wpm) and the chosen voice.
  rate: number;
  // Song mode: true, with `music` naming the model that sang the lyrics. (voice/
  // rate don't apply and are left empty/zero.)
  song?: boolean;
  voice: string;
}

export interface CinematicResult {
  applied: boolean;
  // The chosen creative direction + voice/rate, surfaced so a good run can be
  // reproduced. Present only when applied.
  meta?: CinematicMeta;
  // User-facing degradation notes when the pass applied but this ffmpeg build
  // couldn't do everything (e.g. no drawtext → no title card; no subtitles →
  // soft-sub .srt only). The caller surfaces these so the user isn't left
  // wondering where the title card / captions went.
  notes?: string[];
  // Why it was skipped, for logging.
  reason?: string;
  // Each input step's NEW position (seconds) in the cinematic video, including
  // the title-card offset. Re-timing (per-step freezes) moves the steps, so the
  // caller REPLACES step.videoTime with these rather than adding an offset.
  // Same order/length as the `steps` passed in. Present only when applied.
  stepTimes?: number[];
  // Seconds prepended at the front of the video by the title card (0 when the
  // card was skipped). Informational; stepTimes already includes it.
  titleOffsetSec: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested). No I/O, no subprocesses.
// ---------------------------------------------------------------------------

// How long to hold a step's frame for its sung lyric line (song-mode re-timing).
// ~2.5 words/sec singing plus a beat to read, floored so every line gets a
// readable hold and the body stays long enough to clear the song's intro, capped
// so one wordy line doesn't dominate. Pure → unit-tested.
export function songHoldSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(6.5, Math.max(3.5, words / 2.5 + 1));
}

// Minimum on-screen span a single sung lyric line should cover. Short QA steps
// otherwise get one frantic line each; grouping consecutive steps up to this
// span lets one verse breathe across 2+ steps.
const GROUP_MIN_SEC = 7;

// The longest a single sung lyric line may hold on screen — and the cap on how
// far one cue can extend the kept vocal region. ACE-Step loops/sustains its final
// line to fill a long generation; without this cap that one line's cue stretches
// across the whole tail (minutes), dragging both the caption and the trimmed body
// out into droning dead air. 8s comfortably covers any real sung line.
const MAX_CUE_SEC = 8;

// Each step's on-screen footage length in the condensed video, from the gaps
// between successive step positions (the last step has no following boundary, so
// fall back to its recorded duration). Pure → unit-tested.
export function stepFootageSec(
  steps: { videoTime: number; durationMs: number }[]
): number[] {
  return steps.map((s, i) => {
    const next = steps[i + 1];
    if (next) {
      return Math.max(0.1, next.videoTime - s.videoTime);
    }
    return Math.max(0.1, s.durationMs / 1000);
  });
}

// Group CONSECUTIVE steps so each group's footage totals at least `minSec` — so
// one sung lyric line can cover 2+ short steps instead of one line per step. A
// lone trailing step folds into the previous group (no stray one-step final
// verse); a multi-step remainder keeps its own line. Returns arrays of step
// indices, in order, partitioning every step exactly once. Pure → unit-tested.
export function groupStepsForLyrics(
  footageSec: number[],
  minSec: number
): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let acc = 0;
  for (let i = 0; i < footageSec.length; i++) {
    current.push(i);
    acc += footageSec[i] ?? 0;
    if (acc >= minSec) {
      groups.push(current);
      current = [];
      acc = 0;
    }
  }
  if (current.length > 0) {
    const last = groups.at(-1);
    // Fold a LONE trailing step into the previous group (no stray one-step final
    // verse); a multi-step remainder is substantial enough to keep its own line.
    if (last && current.length < 2) {
      last.push(...current);
    } else {
      groups.push(current);
    }
  }
  return groups;
}

// Collapse grouped steps into ONE lyric-prompt entry per group: the members'
// names joined, and their scripts concatenated so every member's captions/intent
// feed the single line. `index` is the GROUP ordinal — i.e. the lyric line index
// the model returns. Pure → unit-tested.
export function groupedLyricSteps(
  steps: { name: string; script?: string }[],
  groups: number[][]
): { index: number; name: string; script?: string }[] {
  return groups.map((members, g) => ({
    index: g,
    name: members
      .map((i) => steps[i]?.name ?? "")
      .filter(Boolean)
      .join(" → "),
    script: members
      .map((i) => steps[i]?.script)
      .filter((s): s is string => Boolean(s))
      .join("\n"),
  }));
}

// Lay out song-mode caption cues so they never overlap. Each lyric line wants to
// appear at its step's time, but condense can bunch several steps into the same
// instant (a static stretch trimmed to one point), which would stack captions on
// top of each other. This walks the lines in order and pushes each start to at
// least the previous cue's end, giving every line a readable minimum on screen;
// a line whose step has real spacing keeps its natural time (no-op for a flow
// whose steps are already spread out). The last line holds `tailSec`. Cues are
// clamped to end by `videoEndSec`. Pure → unit-tested.
export function layoutSongCues(
  items: { start: number; text: string }[],
  videoEndSec: number,
  opts: { minDurSec?: number; maxDurSec?: number; tailSec?: number } = {}
): { start: number; end: number; text: string }[] {
  const minDur = opts.minDurSec ?? 1.4;
  const maxDur = opts.maxDurSec ?? 5;
  const tail = opts.tailSec ?? 3;
  const cues: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const start = Math.max(item.start, cursor);
    if (videoEndSec > 0 && start >= videoEndSec) {
      break; // no room left on the timeline
    }
    const nextRaw = items[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    const isLast = i === items.length - 1;
    // Hold until the next line wants to start, bounded by [minDur, maxDur]; the
    // last line gets the tail hold.
    let end = isLast
      ? start + tail
      : Math.min(Math.max(nextRaw, start + minDur), start + maxDur);
    if (!isLast) {
      end = Math.max(end, start + minDur);
    }
    if (videoEndSec > 0) {
      end = Math.min(end, videoEndSec);
    }
    if (end <= start) {
      continue; // clamped to nothing at the very end of the video
    }
    cues.push({ start, end, text: item.text });
    cursor = end;
  }
  return cues;
}

// One audio input to the mix: where it starts (ms) and an optional volume scale
// (narration plays at 1.0; a music bed sits low, e.g. 0.18).
export interface AudioTrack {
  delayMs: number;
  // Optional linear fades on the GLOBAL timeline (seconds — the same clock as
  // delayMs, since adelay shifts the stream so its t matches video time). Used
  // to cross the single score track from its quiet narration level into the full
  // credits level without a second download or a volume-step pop.
  fadeInAtSec?: number;
  fadeInDurSec?: number;
  fadeOutAtSec?: number;
  fadeOutDurSec?: number;
  volume?: number;
}

// Build the ffmpeg `filter_complex` that delays each audio input to its place on
// the timeline (and scales its volume) and mixes them into one stereo track
// [aout]. Inputs are ffmpeg indices 1..N (input 0 is the video), in the SAME
// order as `tracks`. Returns "" for no tracks (caller then skips the mix).
export function buildAudioMix(tracks: AudioTrack[]): string {
  if (tracks.length === 0) {
    return "";
  }
  const chains = tracks
    .map((t, i) => {
      const vol =
        t.volume === undefined ? "" : `,volume=${t.volume.toFixed(3)}`;
      const fadeOut =
        t.fadeOutAtSec === undefined
          ? ""
          : `,afade=t=out:st=${t.fadeOutAtSec.toFixed(3)}:d=${(t.fadeOutDurSec ?? 1).toFixed(3)}`;
      const fadeIn =
        t.fadeInAtSec === undefined
          ? ""
          : `,afade=t=in:st=${t.fadeInAtSec.toFixed(3)}:d=${(t.fadeInDurSec ?? 1).toFixed(3)}`;
      return `[${i + 1}:a]adelay=${t.delayMs}|${t.delayMs}${vol}${fadeOut}${fadeIn}[a${i}]`;
    })
    .join(";");
  const labels = tracks.map((_, i) => `[a${i}]`).join("");
  // normalize=0 keeps each track at its set level; dropout_transition=0 stops
  // amix from ducking when a track ends (so the bed doesn't swell between lines).
  return `${chains};${labels}amix=inputs=${tracks.length}:normalize=0:dropout_transition=0[aout]`;
}

// How many characters fit on one title-card line. drawtext has no measuring API,
// so this estimates from the font size — and two things made the old estimate
// overshoot, which rendered a long line past the frame edge and clipped it:
//
//   - It ignored the scrim's `boxborderw`, which eats fontSize*0.6 on EACH side
//     of the text — 72px at 720p, more than a quarter of the whole margin.
//   - 0.52 is the average glyph width for MIXED-case text. Models like to hand
//     back an all-caps title, and caps run ~20% wider, so a line that measured
//     as "just fits" actually didn't.
//
// Deliberately conservative: wrapping a line early is invisible, and a clipped
// title is not. Pure → unit-tested.
export function titleMaxChars(
  title: string,
  frameWidth: number,
  fontSize: number
): number {
  const letters = title.replace(/\s/g, "");
  const upperShare = letters
    ? (letters.match(/\p{Lu}/gu)?.length ?? 0) / letters.length
    : 0;
  const glyphRatio = 0.52 + 0.13 * upperShare;
  const usableWidth = frameWidth * 0.82 - fontSize * 1.2;
  return Math.max(8, Math.floor(usableWidth / (fontSize * glyphRatio)));
}

// Wrap a title into lines of at most `maxChars`, honoring any explicit newlines
// the model included (so it can force a layout) and greedily word-wrapping the
// rest. A single word longer than the limit is kept whole rather than split.
// Pure → unit-tested.
export function wrapTitle(title: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const lines: string[] = [];
  for (const rawLine of title.split("\n")) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= limit) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") {
      lines.push(current);
    }
  }
  return lines.length > 0 ? lines : [""];
}

// Resolve the creative direction (+ change-scale cue) and generate the narration.
// Returns the direction (for title styling + reproducibility) and the narration,
// or null if generation failed.
async function planNarration(args: {
  options: CinematicOptions;
  narratableSteps: CinematicStep[];
  log: Logger;
  echo?: Echo;
}): Promise<
  | {
      direction: ReturnType<typeof resolveDirection>;
      narration: Narration;
      repoDir: string;
      base: string;
    }
  | { error: string }
> {
  const { options, narratableSteps, log, echo } = args;
  const direction = resolveDirection(options.prompt);
  const repoDir = options.repoDir ?? process.cwd();
  const base = await resolveBase(repoDir);
  const change = (await describeChange(repoDir, base)) ?? undefined;
  const prompt = buildNarrationPrompt({
    direction: direction.text,
    change,
    steps: narratableSteps.map((step, index) => ({
      index,
      name: step.name,
      script: step.script,
    })),
  });
  const result = await runLlmJson({
    label: "narration",
    prompt,
    schema: NARRATION_SCHEMA,
    parse: parseNarrationJson,
    log,
    echo,
  });
  if ("error" in result) {
    return { error: result.error };
  }
  return { direction, narration: result.value, repoDir, base };
}

// Song-mode counterpart of planNarration: resolve the creative direction (theme
// as genre) and generate the lyrics. Returns the direction (for title styling +
// reproducibility) and the lyrics, or a reason generation failed.
async function planSong(args: {
  options: CinematicOptions;
  narratableSteps: CinematicStep[];
  groups: number[][];
  videoSeconds: number;
  log: Logger;
  echo?: Echo;
}): Promise<
  | {
      direction: ReturnType<typeof resolveDirection>;
      lyrics: Lyrics;
      repoDir: string;
      base: string;
    }
  | { error: string }
> {
  const { options, narratableSteps, groups, videoSeconds, log, echo } = args;
  const direction = resolveDirection(options.prompt, { song: true });
  const repoDir = options.repoDir ?? process.cwd();
  const base = await resolveBase(repoDir);
  const change = (await describeChange(repoDir, base)) ?? undefined;
  // One prompt entry (and one lyric line) PER GROUP, not per step.
  const prompt = buildLyricsPrompt({
    direction: direction.text,
    change,
    videoSeconds,
    steps: groupedLyricSteps(narratableSteps, groups),
  });
  const result = await runLlmJson({
    label: "lyrics",
    prompt,
    schema: LYRICS_SCHEMA,
    parse: parseLyricsJson,
    log,
    echo,
  });
  if ("error" in result) {
    return { error: result.error };
  }
  return { direction, lyrics: result.value, repoDir, base };
}

// A friendly source name for the music provider, for the "Made with" block.
function musicToolName(id: string | undefined): string | undefined {
  switch (id) {
    case "archive-music":
      return "Music — archive.org (Creative Commons)";
    case "acestep-music":
      return "Music — ACE-Step 1.5 (local)";
    case "gemini-music":
      return "Music — Lyria (Google Gemini)";
    default:
      return;
  }
}

// A friendly voice credit from the TTS provider id + its reproducibility label
// (the label already encodes the model/voice, e.g. "omlx:<model>" or a `say`
// voice like "Ava (Premium)" or "<command>:<voice>"). Pure → unit-tested.
export function voiceCredit(
  ttsId: string | undefined,
  voiceLabel: string
): string {
  const label = voiceLabel.trim();
  if (ttsId === "omlx-tts") {
    return `Voice — oMLX ${label.replace(/^omlx:/, "")}`.trim();
  }
  if (ttsId === "gemini-tts") {
    return `Voice — ${label.replace(/^gemini:/, "")} (Google Gemini)`;
  }
  // macOS `say` (or a $DAILIES_SAY_COMMAND override): the label is the voice/command.
  return label ? `Voice — ${label}` : "Voice — system speech";
}

// The "Made with" tool credits actually used this run. The `claude` CLI always
// writes the words (narration, or lyrics in song mode); voice/music/title-art
// depend on what was resolved. In song mode there's no spoken voice, so the voice
// line is dropped and the music (the sung song) is primary. Pure → unit-tested.
//
// `hasMusicCredit` is set when a dedicated "Music" credit section already names
// the score (the provider's credit() line — a specific archive.org track, or the
// model name for ACE-Step/Lyria). In that case the generic "Music — <tool>" line
// here is redundant (it was crediting ACE-Step/Lyria a second time), so it's
// dropped and the richer section stands alone.
export function buildModelCredits(args: {
  voiceLabel: string;
  ttsId: string | undefined;
  musicId: string | undefined;
  // The title-background provider id when a background was actually rendered
  // (undefined for the solid-color fallback). Only a GENERATED image earns a
  // credit; the built-in local gradient is a fallback, not a tool, so it's not
  // credited (like the drawtext/solid card it replaces).
  titleArtId: string | undefined;
  // A specific credit for the image actually used (provider.credit()), which
  // supersedes the generic tool line — same pattern as `hasMusicCredit`. A
  // stock photo must name its creator, not just the platform it came from.
  titleArtCredit?: string | undefined;
  song?: boolean;
  hasMusicCredit?: boolean;
}): string[] {
  const models = [
    args.song
      ? "Lyrics — Claude (Anthropic)"
      : "Narration — Claude (Anthropic)",
  ];
  if (!args.song) {
    models.push(voiceCredit(args.ttsId, args.voiceLabel));
  }
  const music = args.hasMusicCredit ? undefined : musicToolName(args.musicId);
  if (music) {
    models.push(music);
  }
  const titleArt =
    args.titleArtCredit?.trim() || titleArtToolName(args.titleArtId);
  if (titleArt) {
    models.push(titleArt);
  }
  return models;
}

// A friendly credit for the title-background source, for the "Made with" block.
// Generated (Gemini/local model) and stock (Wikimedia) sources are credited; the
// built-in local gradient and the solid fallback are not tools. Pure → tested.
export function titleArtToolName(id: string | undefined): string | undefined {
  switch (id) {
    case "gemini-image":
      return "Title art — Nano Banana (Google Gemini)";
    case "local-image":
      return "Title art — local image model";
    case "wikimedia-image":
      return "Title art — Wikimedia Commons (CC)";
    default:
      return;
  }
}

// Render the scrolling end-credits roll as its OWN segment, for the caller to
// concatenate after the body. The caller assembles the sections (contributors +
// music + tools), so this just renders. Best-effort: returns undefined when
// there's nothing to credit or the render fails, and the caller then simply
// leaves it out of the concat. Credits sit at the very end, so they never shift
// a step's videoTime.
async function renderCreditsSegment(args: {
  ffmpeg: string;
  videoPath: string;
  heading: string;
  sections: CreditSection[];
  geometry: ProbedVideo;
  temps: string[];
  log: Logger;
}): Promise<string | undefined> {
  const { ffmpeg, videoPath, heading, sections, geometry, temps, log } = args;
  if (!sections.some((s) => s.entries.length > 0)) {
    return;
  }
  const creditsPath = `${videoPath}.credits.webm`;
  temps.push(creditsPath);
  try {
    await buildCreditsRoll({
      ffmpeg,
      sections,
      heading,
      geometry,
      outPath: creditsPath,
    });
    return creditsPath;
  } catch (err) {
    log.debug({ err }, "cinematic: credits roll failed; skipping it");
    return;
  }
}

// Generate a themed title-card background image, or undefined if unavailable.
// Best-effort: a provider failure falls back to the solid-color card + a note.
async function renderTitleBackground(args: {
  provider: TitleBackgroundProvider | undefined;
  directionText: string;
  geometry: ProbedVideo;
  videoPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<string | undefined> {
  const { provider, directionText, geometry, videoPath, temps, notes, log } =
    args;
  if (!provider) {
    return;
  }
  args.progress("generating a title background…");
  const bgPath = `${videoPath}.titlebg.png`;
  temps.push(bgPath);
  try {
    await provider.render(
      directionText,
      geometry.width,
      geometry.height,
      bgPath
    );
    return bgPath;
  } catch (err) {
    log.debug({ err }, "cinematic: title background failed; using solid card");
    notes.push("title background unavailable — used a solid card");
    return;
  }
}

// Push music tracks past the opening title card: the score is timed against the
// body, but it's mixed onto the title-prefixed final video, so add the title
// offset to each track's delay and its fade envelope. Pure.
function shiftMusic(tracks: MusicTrack[], leadSec: number): MusicTrack[] {
  if (leadSec <= 0) {
    return tracks;
  }
  const add = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : v + leadSec;
  return tracks.map((t) => ({
    ...t,
    delaySec: t.delaySec + leadSec,
    fadeInAtSec: add(t.fadeInAtSec),
    fadeOutAtSec: add(t.fadeOutAtSec),
  }));
}

// Generate music tracks for the mix: a low instrumental bed under the whole
// video, and a fuller song over the credits region. Best-effort per track; a
// failure (e.g. Lyria unavailable on this API) just drops that track + notes it.
async function generateMusic(args: {
  ffmpeg: string;
  provider: MusicProvider | undefined;
  directionText: string;
  // The credits-roll segment sitting at the END of finalBodyPath, or undefined
  // when there's no roll. Its own measured length gives the credits region — the
  // single flat concat no longer produces a title+body intermediate to subtract
  // from the total, and summing the re-time plan instead would trade a measured
  // value for a computed one.
  creditsPath: string | undefined;
  finalBodyPath: string;
  videoPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<MusicTrack[]> {
  const {
    ffmpeg,
    provider,
    directionText,
    creditsPath,
    finalBodyPath,
    videoPath,
    temps,
    notes,
    log,
  } = args;
  if (!provider) {
    return [];
  }
  const total = await audioDurationSec(ffmpeg, finalBodyPath);
  if (!total) {
    return [];
  }
  args.progress("composing the score…");
  // ONE song for the whole video (no second download): fetch a single bed, play
  // it quietly UNDER the narration, then swell to full volume for the credits.
  const bedPath = `${videoPath}.bed.wav`;
  temps.push(bedPath);
  try {
    await provider.bed(directionText, total, bedPath);
  } catch (err) {
    log.debug({ err }, "cinematic: instrumental score unavailable");
    notes.push("instrumental score unavailable");
    return [];
  }
  const creditsLen = creditsPath
    ? ((await audioDurationSec(ffmpeg, creditsPath)) ?? 0)
    : 0;
  if (creditsLen <= 1) {
    // No credits region — just the quiet bed under the whole thing.
    return [{ path: bedPath, delaySec: 0, volume: NARRATION_MUSIC_GAIN }];
  }
  // Where the credits open: the roll is the tail of the final body.
  const cs = Math.max(0, total - creditsLen);
  const ramp = MUSIC_SWELL_RAMP_SEC;
  // Narration bed: quiet, faded out just before the credits so it doesn't stack
  // with the swell below it.
  const tracks: MusicTrack[] = [
    {
      path: bedPath,
      delaySec: 0,
      volume: NARRATION_MUSIC_GAIN,
      fadeOutAtSec: Math.max(0, cs - ramp),
      fadeOutDurSec: ramp,
    },
  ];
  // Credits swell: the SAME song, seeked to its loudest (≈ highest-energy)
  // window so the credits open on a strong section, at full volume, fading in at
  // the credits start. One download → quiet bed + a full-energy credits swell.
  try {
    const loudOff = await pickLoudestOffset(ffmpeg, bedPath, creditsLen);
    const creditsClip = `${videoPath}.credits.wav`;
    temps.push(creditsClip);
    await trimAudio({
      ffmpeg,
      src: bedPath,
      startSec: loudOff,
      outPath: creditsClip,
      echo: args.progress,
    });
    tracks.push({
      path: creditsClip,
      delaySec: cs,
      volume: CREDITS_MUSIC_GAIN,
      fadeInAtSec: cs,
      fadeInDurSec: ramp,
    });
  } catch (err) {
    // Couldn't make the swell — let the quiet bed carry the credits too (drop
    // its fade-out so it doesn't cut to silence).
    log.debug({ err }, "cinematic: credits swell unavailable; bed continues");
    tracks[0] = { path: bedPath, delaySec: 0, volume: NARRATION_MUSIC_GAIN };
  }
  return tracks;
}

// The credits roll's non-footage inputs: the branch contributors (a `git log`)
// and the score's credit line, resolved WITHOUT generating audio (the provider
// caches its pick, so generateMusic later reuses the credited track). Fetched
// together, and started before the re-time so both overlap its ffmpeg encodes —
// neither is CPU-bound, so they don't contend with libvpx.
async function resolveCreditInputs(args: {
  repoDir: string;
  base: string;
  provider: MusicProvider | undefined;
  directionText: string;
}): Promise<{ contributors: Contributor[]; musicCredit: string | undefined }> {
  const [contributors, musicCredit] = await Promise.all([
    branchContributors(args.repoDir, args.base),
    args.provider?.credit?.(args.directionText).catch(() => undefined),
  ]);
  return { contributors, musicCredit };
}

// Turn the condensed body + narration clips into the final cinematic video:
// re-time so each step holds for its line, render the title card (optionally over
// a generated background) and the credits roll, join all three in one concat, and
// generate any music. Returns the final body, where each step/clip lands, and the
// music tracks — or null if the source duration can't be probed for re-timing.
async function assembleVideo(args: {
  ffmpeg: string;
  videoPath: string;
  narratableSteps: CinematicStep[];
  clips: RenderedClip[];
  title: string;
  category: ThemeCategory | undefined;
  directionText: string;
  providers: MediaProviders;
  voiceLabel: string;
  hasDrawtext: boolean;
  repoDir: string;
  base: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<{
  finalBody: string;
  // The probed source geometry, handed back so the caller can size its captions
  // to the real frame width without probing the same file a second time.
  geometry: ProbedVideo | undefined;
  stepTimes: number[];
  clipOffsetsSec: number[];
  titleOffsetSec: number;
  music: MusicTrack[];
} | null> {
  const {
    ffmpeg,
    videoPath,
    narratableSteps,
    clips,
    title,
    category,
    directionText,
    providers,
    voiceLabel,
    hasDrawtext,
    repoDir,
    base,
    temps,
    notes,
    log,
    progress,
  } = args;

  // Probe geometry once: frame rate drives CFR re-encoding (exact slice
  // durations); width/height let the title card match the body. A failed probe
  // (no ffprobe) keeps a default frame rate but MUST skip the title/credits —
  // guessing geometry corrupts the concat.
  const geometry = await probeVideo(ffmpeg, videoPath);
  const frameRate = geometry?.frameRate ?? 30;
  // The title card and the credits roll both need the exact source geometry, so
  // a failed probe (no ffprobe) skips them rather than guessing — narrowing them
  // behind one binding keeps that gate in a single place.
  const extrasGeometry = hasDrawtext ? geometry : undefined;

  // Start the non-footage work — the title-background provider (network/GPU) and
  // the credit lookups (`git log` + a track search) — BEFORE the re-time, so it
  // overlaps the per-step encodes instead of queueing behind them. Gated exactly
  // as before: without drawtext/geometry there's no card or roll to feed.
  const backgroundJob = extrasGeometry
    ? renderTitleBackground({
        provider: providers.titleBackground,
        directionText,
        geometry: extrasGeometry,
        videoPath,
        temps,
        notes,
        log,
        progress,
      })
    : Promise.resolve(undefined);
  const creditInputsJob = extrasGeometry
    ? resolveCreditInputs({
        repoDir,
        base,
        provider: providers.music,
        directionText,
      })
    : Promise.resolve({ contributors: [], musicCredit: undefined });

  progress("re-timing the video to fit the narration…");
  const clipDurSec = narratableSteps.map(
    (step) => clips.find((c) => c.step === step)?.durationSec ?? 0
  );
  const retimed = await retimeSegments({
    ffmpeg,
    videoPath,
    steps: narratableSteps,
    clipDurSec,
    frameRate,
    temps,
    gapSec: narrationGapSec(process.env),
  });
  if (!retimed) {
    // Drain the in-flight jobs before bailing so neither can settle after we've
    // returned (and so their temps are on the cleanup list).
    await Promise.allSettled([backgroundJob, creditInputsJob]);
    return null;
  }
  const background = await backgroundJob;

  progress("painting the title card…");
  const titleCard = await renderTitleSegment({
    ffmpeg,
    videoPath,
    title,
    style: titleStyle(category),
    background,
    // The local gradient is already dark by design; only dim external photos.
    dimBackground: providers.titleBackground?.id !== "local-gradient",
    hasDrawtext,
    geometry,
    temps,
    notes,
    log,
  });
  const { titleOffsetSec } = titleCard;

  const stepTimes = retimed.starts.map((s) => s + titleOffsetSec);
  const clipOffsetsSec = clips.map((clip) => {
    const idx = narratableSteps.indexOf(clip.step);
    return (idx >= 0 ? (retimed.starts[idx] ?? 0) : 0) + titleOffsetSec;
  });

  let creditsPath: string | undefined;
  if (extrasGeometry) {
    progress("rolling the credits…");
    const { contributors, musicCredit } = await creditInputsJob;
    creditsPath = await renderCreditsSegment({
      ffmpeg,
      videoPath,
      heading: title,
      // People, music, and the tools actually used this run.
      sections: buildCreditSections({
        contributors,
        music: musicCredit,
        models: buildModelCredits({
          voiceLabel,
          ttsId: providers.tts?.id,
          musicId: providers.music?.id,
          titleArtId: background ? providers.titleBackground?.id : undefined,
          titleArtCredit: background
            ? providers.titleBackground?.credit?.()
            : undefined,
          hasMusicCredit: Boolean(musicCredit),
        }),
      }),
      geometry: extrasGeometry,
      temps,
      log,
    });
  }

  const finalBody = await assembleBody({
    ffmpeg,
    videoPath,
    pieces: [titleCard.path, ...retimed.segs, creditsPath],
    temps,
  });

  const music = await generateMusic({
    ffmpeg,
    provider: providers.music,
    directionText,
    creditsPath,
    finalBodyPath: finalBody,
    videoPath,
    temps,
    notes,
    log,
    progress,
  });

  return {
    finalBody,
    geometry,
    stepTimes,
    clipOffsetsSec,
    titleOffsetSec,
    music,
  };
}

// The minimum a generated song should run — 1:30. A short session still gets a
// full-length piece rather than a song that ends early.
export const MIN_SONG_SEC = 90;

// The maximum song length to REQUEST. The model honors the duration exactly, so an
// unbounded request would literally generate that many seconds (a long session ×
// ~5s/step reaches minutes) only for the caller to trim most of it to the sung
// region. Cap it: the distinct written lines are exhausted within ~1–2 minutes
// regardless (the rest repeats), so a longer request buys nothing but generation
// time. 2:45 leaves comfortable headroom over MIN_SONG_SEC.
export const MAX_SONG_SEC = 165;

// Song length to request from the music provider. Honored exactly by ACE-Step
// (and used as the target by Gemini Lyria), so it sets the real generated length.
// Scaled to the LYRIC-LINE count (not the step count): the lines are the actual
// sung content — a title lead-in + ~9s of singing per line + an outro — clamped to
// [MIN_SONG_SEC, MAX_SONG_SEC]. Sizing off steps overshot badly (a 26-step / 11-line
// session asked for 148s but the 11 lines were sung by ~93s, leaving a dead
// instrumental tail); sizing off lines keeps the song about as long as there are
// words to sing. The caller still trims any residual tail to the last sung line.
// Pure → unit-tested.
export function songTargetSec(lineCount: number): number {
  const scaled = Math.round(TITLE_SEC + Math.max(0, lineCount) * 9 + 12);
  return Math.min(MAX_SONG_SEC, Math.max(MIN_SONG_SEC, scaled));
}

// Generate the raw SONG file (the model SINGS the supplied lyrics). Returns its
// path, or null on failure. The length is what we REQUEST (`targetSec`) — ACE-Step
// honors the duration exactly and still sings — so the file is that long, singing
// the lyrics and then repeating to fill any remainder; the caller transcribes and
// trims that tail back to the last distinct sung line.
async function generateRawSong(args: {
  provider: MusicProvider | undefined;
  directionText: string;
  lyrics: string;
  targetSec: number;
  outPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
}): Promise<{ path: string; lrcText?: string } | null> {
  const {
    provider,
    directionText,
    lyrics,
    targetSec,
    outPath,
    temps,
    notes,
    log,
  } = args;
  if (!provider) {
    return null;
  }
  temps.push(outPath);
  try {
    // The length is what we request (honored exactly by ACE-Step); the model sings
    // the lyrics then repeats to fill, and the caller trims the tail. The provider
    // may also hand back its OWN per-line lyric timestamps (LRC) — the ideal caption
    // source; the caller uses them when present, else transcribes.
    const result = await provider.song(
      directionText,
      targetSec,
      outPath,
      lyrics
    );
    return { path: outPath, lrcText: result?.lrcText };
  } catch (err) {
    log.debug({ err }, "cinematic: song generation failed");
    notes.push("song unavailable — generation failed");
    return null;
  }
}

// Song-mode counterpart of assembleVideo. RE-TIMES the body like narration — each
// step's frame holds for `holdDurSec[i]` — so the body is long enough for the
// song's vocals to play across it and the captions get readable spacing. Then
// prepend the title and append the credits. The SONG itself is generated, timed,
// and mixed by the caller (it needs the song's transcript first); this just builds
// the silent video. Returns the final body, each step's new position, and the
// title offset — or null if the source can't be probed/re-timed.
async function assembleSongVideo(args: {
  ffmpeg: string;
  videoPath: string;
  narratableSteps: CinematicStep[];
  holdDurSec: number[];
  // Song step-sync: per-step onset (output start, = when each step's line is sung)
  // and the body end — the body is onset-anchored so each step's footage is on screen
  // while its lyric line is sung.
  onsets?: number[];
  bodyEnd?: number;
  title: string;
  category: ThemeCategory | undefined;
  directionText: string;
  providers: MediaProviders;
  hasDrawtext: boolean;
  repoDir: string;
  base: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<{
  finalBody: string;
  // The probed source geometry, handed back so the caller can size its captions
  // to the real frame width without probing the same file a second time.
  geometry: ProbedVideo | undefined;
  stepTimes: number[];
  titleOffsetSec: number;
} | null> {
  const {
    ffmpeg,
    videoPath,
    narratableSteps,
    holdDurSec,
    onsets,
    bodyEnd,
    title,
    category,
    directionText,
    providers,
    hasDrawtext,
    repoDir,
    base,
    temps,
    notes,
    log,
    progress,
  } = args;

  const geometry = await probeVideo(ffmpeg, videoPath);
  const frameRate = geometry?.frameRate ?? 30;
  // The title card and the credits roll both need the exact source geometry, so
  // a failed probe (no ffprobe) skips them rather than guessing — narrowing them
  // behind one binding keeps that gate in a single place.
  const extrasGeometry = hasDrawtext ? geometry : undefined;

  // Same overlap as the narration path: the title-background provider and the
  // credit lookups start before the re-time's encodes rather than behind them.
  const backgroundJob = extrasGeometry
    ? renderTitleBackground({
        provider: providers.titleBackground,
        directionText,
        geometry: extrasGeometry,
        videoPath,
        temps,
        notes,
        log,
        progress,
      })
    : Promise.resolve(undefined);
  const creditInputsJob = extrasGeometry
    ? resolveCreditInputs({
        repoDir,
        base,
        provider: providers.music,
        directionText,
      })
    : Promise.resolve({ contributors: [], musicCredit: undefined });

  // Re-time the body: each step plays at natural speed then freezes its last frame to
  // fill its budget (preserving motion + quality). When `onsets` are given (the
  // transcribed path) the body is ANCHORED to each line's sung moment (hard-cut) so
  // the on-screen step tracks what's being sung — the song-mode analog of narration's
  // per-step hold; otherwise it falls back to the even `holdDurSec` split.
  progress("re-timing the video to the song…");
  const retimed = await retimeSegments({
    ffmpeg,
    videoPath,
    steps: narratableSteps,
    clipDurSec: holdDurSec,
    frameRate,
    temps,
    onsets,
    bodyEnd,
  });
  if (!retimed) {
    await Promise.allSettled([backgroundJob, creditInputsJob]);
    return null;
  }
  const background = await backgroundJob;

  progress("painting the title card…");
  const titleCard = await renderTitleSegment({
    ffmpeg,
    videoPath,
    title,
    style: titleStyle(category),
    background,
    // The local gradient is already dark by design; only dim external photos.
    dimBackground: providers.titleBackground?.id !== "local-gradient",
    hasDrawtext,
    geometry,
    temps,
    notes,
    log,
  });
  const { titleOffsetSec } = titleCard;
  const stepTimes = retimed.starts.map((s) => s + titleOffsetSec);

  let creditsPath: string | undefined;
  if (extrasGeometry) {
    progress("rolling the credits…");
    const { contributors, musicCredit } = await creditInputsJob;
    creditsPath = await renderCreditsSegment({
      ffmpeg,
      videoPath,
      heading: title,
      sections: buildCreditSections({
        contributors,
        music: musicCredit,
        models: buildModelCredits({
          voiceLabel: "",
          ttsId: undefined,
          musicId: providers.music?.id,
          titleArtId: background ? providers.titleBackground?.id : undefined,
          titleArtCredit: background
            ? providers.titleBackground?.credit?.()
            : undefined,
          song: true,
          hasMusicCredit: Boolean(musicCredit),
        }),
      }),
      geometry: extrasGeometry,
      temps,
      log,
    });
  }

  const finalBody = await assembleBody({
    ffmpeg,
    videoPath,
    pieces: [titleCard.path, ...retimed.segs, creditsPath],
    temps,
  });

  return { finalBody, geometry, stepTimes, titleOffsetSec };
}

interface RenderedClip {
  durationSec: number;
  m4aPath: string;
  narration: string;
  step: CinematicStep;
}

// A generated music input for the final mix: an audio file, when it starts, and
// its (low) gain under the narration.
interface MusicTrack {
  delaySec: number;
  // Optional cross-fade envelope (see AudioTrack), on the global timeline.
  fadeInAtSec?: number;
  fadeInDurSec?: number;
  fadeOutAtSec?: number;
  fadeOutDurSec?: number;
  path: string;
  volume: number;
}

// Synthesize one narration clip with `synth`, transcode to AAC/m4a, and probe its
// duration (for caption end-times). Pushes its temps for cleanup. Returns null
// if the clip can't be produced. Throws if `synth.run` throws (caller may retry
// with a fallback synth).
async function renderClip(args: {
  ffmpeg: string;
  synth: SpeechSynth;
  step: CinematicStep;
  narration: string;
  videoPath: string;
  index: number;
  temps: string[];
  echo?: Echo;
}): Promise<RenderedClip | null> {
  const { ffmpeg, synth, step, narration, videoPath, index, temps, echo } =
    args;
  const rawPath = `${videoPath}.step${index}.${synth.ext}`;
  const m4aPath = `${videoPath}.step${index}.m4a`;
  temps.push(rawPath, m4aPath);

  // Speak a for-the-ear rewrite; the caption/return value keeps the original.
  await synth.run(speechText(narration), rawPath);
  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
      "-i",
      rawPath,
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "aac",
      m4aPath,
    ],
    ENCODE_TIMEOUT_MS,
    echo
  );
  const durationSec = await audioDurationSec(ffmpeg, m4aPath);
  if (durationSec === undefined || durationSec <= 0) {
    return null;
  }
  return { step, narration, m4aPath, durationSec };
}

// How many narration clips to synthesize at once. Each clip is one independent
// TTS call (a local `say`, or one HTTP request) plus a short ffmpeg transcode, so
// overlapping them is pure wall-clock savings: 8 concurrent macOS `say -o`
// renders were measured producing BYTE-IDENTICAL audio to the same lines rendered
// serially, in 4s instead of 11s. Kept modest — a hosted TTS shouldn't be hit
// with a whole session at once — and bounded by the machine's own parallelism.
// Override with $DAILIES_TTS_CONCURRENCY (1 restores the old serial pass).
const DEFAULT_TTS_CONCURRENCY = 4;
export function ttsConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.DAILIES_TTS_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) {
    return Math.trunc(override);
  }
  return Math.max(
    1,
    Math.min(DEFAULT_TTS_CONCURRENCY, os.availableParallelism())
  );
}

// The steps the LLM actually wrote narration for, each carrying its ENUMERATED
// step index — that's the key the narration map uses (the same indexing the prompt
// used) and the suffix each clip's temp files get. Pure → unit-tested.
export function narrationJobs(
  steps: CinematicStep[],
  byIndex: Map<number, string>
): { index: number; step: CinematicStep; text: string }[] {
  const jobs: { index: number; step: CinematicStep; text: string }[] = [];
  for (const [index, step] of steps.entries()) {
    const text = byIndex.get(index)?.trim();
    if (text) {
      jobs.push({ index, step, text });
    }
  }
  return jobs;
}

// Synthesize a clip for every step that the LLM gave narration text, several in
// flight (see ttsConcurrency). Prefers the TTS provider when present; its FIRST
// failure latches the provider off, so the lines still queued go straight to
// `say` instead of each paying another failing call/timeout — then a second pass
// voices everything the provider didn't with `say`. A `say` failure is NOT caught
// (as before): it throws through to cinematicProcess, which skips the pass.
// Returns clips in step order, so the caller's cue/offset arrays stay in lockstep.
async function synthesizeClips(args: {
  ffmpeg: string;
  say?: SpeechSynth;
  tts?: TtsProvider;
  steps: CinematicStep[];
  byIndex: Map<number, string>;
  videoPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
  echo?: Echo;
}): Promise<RenderedClip[]> {
  const {
    ffmpeg,
    say,
    tts,
    steps,
    byIndex,
    videoPath,
    temps,
    notes,
    log,
    echo,
  } = args;
  const jobs = narrationJobs(steps, byIndex);
  const limit = ttsConcurrency();
  const clipArgs = (job: {
    index: number;
    step: CinematicStep;
    text: string;
  }) => ({
    ffmpeg,
    step: job.step,
    narration: job.text,
    videoPath,
    index: job.index,
    temps,
    echo,
  });

  // Pass 1: the TTS provider. `down` latches on the first failure so queued lines
  // skip the provider entirely rather than each paying its own failing call.
  const rendered: (RenderedClip | null)[] = jobs.map(() => null);
  if (tts) {
    const synth: SpeechSynth = {
      ext: "wav",
      run: (t, o) => tts.synthesize(t, o),
    };
    let down = false;
    const voiced = await mapLimit(jobs, limit, async (job) => {
      if (down) {
        return null;
      }
      try {
        return await renderClip({ ...clipArgs(job), synth });
      } catch (err) {
        down = true;
        log.debug({ err }, "cinematic: TTS provider failed; using `say`");
        return null;
      }
    });
    voiced.forEach((clip, slot) => {
      rendered[slot] = clip;
    });
    if (down) {
      notes.push(
        `narration voiced by macOS \`say\` — the TTS provider (${tts.id}) failed`
      );
    }
  }

  // Pass 2: everything the provider didn't voice falls back to `say`.
  if (say) {
    const pending = jobs
      .map((job, slot) => ({ job, slot }))
      .filter((p) => rendered[p.slot] === null);
    const spoken = await mapLimit(pending, limit, (p) =>
      renderClip({ ...clipArgs(p.job), synth: say })
    );
    pending.forEach((p, k) => {
      rendered[p.slot] = spoken[k] ?? null;
    });
  }
  return rendered.filter((clip): clip is RenderedClip => clip !== null);
}

// Render a 2.5s title card matching the source geometry, encoded to webm
// (libvpx) so the concat demuxer can stream-copy it ahead of the body. The
// title is wrapped to fit the frame (honoring any model-supplied line breaks),
// drawn in the category's font/color over a dark scrim, on either a solid black
// base or a provided background image (scaled+cropped to fill, then darkened).
async function buildTitleCard(args: {
  ffmpeg: string;
  title: string;
  style: { font: string; color: string };
  geometry: ProbedVideo;
  background?: string;
  // Darken the background before overlaying text. On by default for arbitrary
  // (often bright) generated photos; skipped for the local gradient, which is
  // already dark by design — dimming it further just muddies the card.
  dimBackground?: boolean;
  temps: string[];
  outPath: string;
}): Promise<void> {
  const {
    ffmpeg,
    title,
    style,
    geometry,
    background,
    dimBackground = true,
    temps,
    outPath,
  } = args;
  // Size text to the frame, then word-wrap; shrink a touch when it spills past
  // ~3 lines so a long title still fits without overflowing the card.
  const baseSize = Math.max(24, Math.round(geometry.height / 12));
  const maxChars = titleMaxChars(title, geometry.width, baseSize);
  const lines = wrapTitle(title, maxChars);
  const fontSize = lines.length > 3 ? Math.round(baseSize * 0.8) : baseSize;
  const lineSpacing = Math.round(fontSize * 0.35);

  // drawtext reads the text from a file (expansion=none) so newlines and any
  // %, :, \ in the title render literally — no filtergraph-escaping minefield.
  const textFile = `${outPath}.txt`;
  temps.push(textFile);
  await writeFile(textFile, lines.join("\n"));

  const drawtext = [
    `fontfile=${style.font}`,
    `textfile=${textFile}`,
    "expansion=none",
    `fontcolor=${style.color}`,
    `fontsize=${fontSize}`,
    "text_align=C",
    `line_spacing=${lineSpacing}`,
    "x=(w-text_w)/2",
    "y=(h-text_h)/2",
    // Dark scrim behind the text so it stays legible over any background image.
    "box=1",
    "boxcolor=black@0.45",
    `boxborderw=${Math.round(fontSize * 0.6)}`,
  ].join(":");

  // Base layer: a provided background image (scaled to fill, darkened when it's
  // an arbitrary photo so white text reads), else a solid black frame.
  const dim = dimBackground ? "eq=brightness=-0.25," : "";
  const filter = background
    ? `scale=${geometry.width}:${geometry.height}:force_original_aspect_ratio=increase,crop=${geometry.width}:${geometry.height},${dim}drawtext=${drawtext},fps=${geometry.frameRate},setpts=N/FRAME_RATE/TB`
    : `drawtext=${drawtext}`;
  const input = background
    ? ["-loop", "1", "-t", String(TITLE_SEC), "-i", background]
    : [
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${geometry.width}x${geometry.height}:r=${geometry.frameRate}:d=${TITLE_SEC}`,
      ];

  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
      ...input,
      "-vf",
      filter,
      "-r",
      String(geometry.frameRate),
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// Compute, for each step (sorted by videoTime), where its footage now begins in
// the re-timed video and how long to freeze its tail. A step's natural footage
// is [videoTime, nextVideoTime) (last step runs to the end); when its narration
// is longer than that, the difference is added as a freeze hold so narration
// never bleeds into the next step. `startPadSec` freezes the first frame for a
// beat BEFORE each step's footage (so the action doesn't start cold); the
// returned `starts` point at the action (after that pad), where narration/captions
// land.
//
// `gapSec` guarantees a MINIMUM silent beat between consecutive narration clips:
// without it, a step whose line runs longer than its footage holds only exactly
// long enough for the line, so the next line starts the instant this one ends and
// the narration sounds breathless. Adding `gapSec` to each non-last step's hold
// floors the inter-clip gap at `gapSec` (and adds nothing when the footage already
// leaves that much slack — `clipDur − f + gapSec` goes ≤ 0, so the hold stays 0
// and the natural gap already covers it). The last step gets no trailing gap.
// Pure → unit-tested.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-step hold arithmetic with its documented edge cases (last step, slack already in the footage) kept inline, where the comment above explains them against the formula.
export function planRetime(args: {
  stepTimes: number[];
  clipDurSec: number[];
  totalSec: number;
  startPadSec?: number;
  gapSec?: number;
  // ONSET-ANCHORED mode (song step-sync): the output time each step must START at
  // (the moment its lyric line is sung). When given, each step plays its natural
  // footage from `stepTimes[i]` but is HARD-CUT at the next onset — clipping the
  // footage tail if it overran the window, freeze-padding if it underran — so the
  // step is on screen exactly while its line is sung. Every step re-anchors to an
  // absolute onset, so timing error is bounded per step (no cumulative drift).
  // `bodyEnd` closes the last step's window. Overrides the narration hold logic.
  onsets?: number[];
  bodyEnd?: number;
}): { starts: number[]; footage: number[]; holds: number[]; leadSec: number } {
  const { stepTimes, clipDurSec, totalSec, onsets, bodyEnd } = args;
  const startPad = Math.max(0, args.startPadSec ?? 0);
  const gap = Math.max(0, args.gapSec ?? 0);
  const n = stepTimes.length;
  const starts: number[] = [];
  const footage: number[] = [];
  const holds: number[] = [];

  if (onsets && onsets.length === n) {
    // Onset-anchored hard-cut. The lead is the instrumental run before the first
    // line; each step fills [onset_i, onset_{i+1}) by playing min(footage, window)
    // then freezing the remainder.
    const leadSec = Math.max(0, onsets[0] ?? 0);
    const end = bodyEnd ?? totalSec;
    for (let i = 0; i < n; i++) {
      const src = stepTimes[i] ?? 0;
      const srcNext = i < n - 1 ? (stepTimes[i + 1] ?? totalSec) : totalSec;
      const natural = Math.max(0.1, srcNext - src);
      const winStart = onsets[i] ?? 0;
      const winEnd = i < n - 1 ? (onsets[i + 1] ?? end) : end;
      const slot = Math.max(0.1, winEnd - winStart);
      const play = Math.min(natural, slot); // clip the tail on overrun
      starts.push(winStart);
      footage.push(play);
      holds.push(Math.max(0, slot - play)); // freeze-pad on underrun
    }
    return { starts, footage, holds, leadSec };
  }

  const leadSec = n > 0 ? Math.max(0, stepTimes[0] ?? 0) : 0;
  let acc = leadSec;
  for (let i = 0; i < n; i++) {
    const start = stepTimes[i] ?? 0;
    const next = i < n - 1 ? (stepTimes[i + 1] ?? totalSec) : totalSec;
    const f = Math.max(0.1, next - start);
    // No trailing gap after the final clip (nothing follows it to breathe from).
    const isLast = i === n - 1;
    const hold = Math.max(0, (clipDurSec[i] ?? 0) - f + (isLast ? 0 : gap));
    // The action (and its narration) starts after the leading still.
    starts.push(acc + startPad);
    footage.push(f);
    holds.push(hold);
    acc += startPad + f + hold;
  }
  return { starts, footage, holds, leadSec };
}

// Leading still pad before each step's action. DISABLED (0): freezing the first
// frame of a step froze a mid-typing frame ("one character, then a pause"), since
// a step's window often opens partway into its own keystrokes. End-freeze only —
// exactly like cinematic/narration mode — keeps the motion clean.
const STEP_START_PAD_SEC = 0;

// Minimum silent beat held between consecutive narration lines so they don't run
// together (a short step's line used to end and the next begin in the same frame).
// A freeze on the current step's last frame fills the gap. Override with
// $DAILIES_NARRATION_GAP_SEC (0 restores the old back-to-back pacing).
const DEFAULT_NARRATION_GAP_SEC = 0.6;
export function narrationGapSec(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.DAILIES_NARRATION_GAP_SEC);
  return Number.isFinite(override) && override >= 0
    ? override
    : DEFAULT_NARRATION_GAP_SEC;
}

// Re-time the video so each step holds its frame long enough for its narration.
// Returns the per-step SEGMENTS (in order, ready to concatenate) and each step's
// new start (pre-title-card). Null if the source duration can't be probed.
//
// The segments are deliberately NOT concatenated here: the title card and the
// credits roll are separate segments too, and assembleBody joins all of them in
// ONE concat-copy pass. Concatenating here as well would rewrite the whole body
// an extra time (it used to be rewritten three times: retime, title, credits).
async function retimeSegments(args: {
  ffmpeg: string;
  videoPath: string;
  steps: CinematicStep[];
  clipDurSec: number[];
  frameRate: number;
  temps: string[];
  // Minimum silent beat between consecutive lines (narration mode passes a value;
  // song mode leaves it 0 — the song's own pacing carries the gaps).
  gapSec?: number;
  // Song step-sync: per-step onset (where each step must start in the output) and
  // the body end. When given, planRetime hard-cuts each step to its onset window.
  onsets?: number[];
  bodyEnd?: number;
}): Promise<{ segs: string[]; starts: number[] } | null> {
  const { ffmpeg, videoPath, steps, clipDurSec, frameRate, temps } = args;
  const totalSec = await audioDurationSec(ffmpeg, videoPath);
  if (totalSec === undefined || totalSec <= 0) {
    return null;
  }
  const plan = planRetime({
    stepTimes: steps.map((s) => s.videoTime),
    clipDurSec,
    totalSec,
    startPadSec: STEP_START_PAD_SEC,
    gapSec: args.gapSec,
    onsets: args.onsets,
    bodyEnd: args.bodyEnd,
  });
  const segs: string[] = [];
  if (plan.leadSec > 0.01) {
    const leadPath = `${videoPath}.lead.webm`;
    temps.push(leadPath);
    await encodeSlice({
      ffmpeg,
      src: videoPath,
      startSec: 0,
      durSec: plan.leadSec,
      holdSec: 0,
      frameRate,
      outPath: leadPath,
    });
    segs.push(leadPath);
  }
  for (let i = 0; i < steps.length; i++) {
    const segPath = `${videoPath}.rseg${i}.webm`;
    temps.push(segPath);
    await encodeSlice({
      ffmpeg,
      src: videoPath,
      startSec: steps[i]?.videoTime ?? 0,
      durSec: plan.footage[i] ?? 0.1,
      holdSec: plan.holds[i] ?? 0,
      startHoldSec: STEP_START_PAD_SEC,
      frameRate,
      outPath: segPath,
    });
    segs.push(segPath);
  }
  return { segs, starts: plan.starts };
}

// Join the title card, the re-timed body segments and the credits roll into the
// final body in ONE concat-copy pass. Every piece is already libvpx/webm at the
// source geometry and CFR-pinned, so the demuxer stream-copies them — but each
// pass still rewrites the whole file, which is why there is exactly one.
async function assembleBody(args: {
  ffmpeg: string;
  videoPath: string;
  pieces: (string | undefined)[];
  temps: string[];
}): Promise<string> {
  const { ffmpeg, videoPath, pieces, temps } = args;
  const outPath = `${videoPath}.body.webm`;
  const listPath = `${videoPath}.body.txt`;
  temps.push(outPath, listPath);
  await concatSegments(
    ffmpeg,
    pieces.filter((p): p is string => Boolean(p)),
    outPath,
    listPath
  );
  return outPath;
}

// Render the opening title card as its own segment (for assembleBody to put in
// front of the body), plus the timeline offset it introduces. Skips it — path
// undefined, offset 0, and a note — when drawtext is unavailable, no font is
// installed, or the geometry couldn't be probed: the title MUST match the body's
// exact geometry or the concat-copy silently locks the body into the title's
// resolution and corrupts the picture, so guessing is not an option.
async function renderTitleSegment(args: {
  ffmpeg: string;
  videoPath: string;
  title: string;
  style: { font: string | undefined; color: string };
  background?: string;
  dimBackground?: boolean;
  hasDrawtext: boolean;
  geometry: ProbedVideo | undefined;
  temps: string[];
  notes: string[];
  log: Logger;
}): Promise<{ path: string | undefined; titleOffsetSec: number }> {
  const {
    ffmpeg,
    videoPath,
    title,
    style,
    background,
    dimBackground,
    hasDrawtext,
    geometry,
    temps,
    notes,
    log,
  } = args;
  if (hasDrawtext && geometry && style.font) {
    const titlePath = `${videoPath}.title.webm`;
    temps.push(titlePath);
    await buildTitleCard({
      ffmpeg,
      title,
      style: { font: style.font, color: style.color },
      background,
      dimBackground,
      geometry,
      temps,
      outPath: titlePath,
    });
    return { path: titlePath, titleOffsetSec: TITLE_SEC };
  }
  let note = "title card skipped — this ffmpeg has no `drawtext` filter";
  if (hasDrawtext && !geometry) {
    note =
      "title card skipped — couldn't probe the video geometry (no ffprobe?)";
  } else if (hasDrawtext && !style.font) {
    note = "title card skipped — no usable font installed";
  }
  notes.push(note);
  log.warn({ ffmpeg }, `cinematic: ${note}`);
  return { path: undefined, titleOffsetSec: 0 };
}

// Final pass: mix the delayed narration clips onto the concatenated video and
// optionally burn captions. Captions force a video re-encode (libass), so the
// no-caption branch can stream-copy the video track.
async function mixAudioAndCaptions(args: {
  ffmpeg: string;
  videoPath: string;
  clips: RenderedClip[];
  offsetsSec: number[];
  music: MusicTrack[];
  srtPath: string;
  burnCaptions: boolean;
  outPath: string;
  echo?: Echo;
}): Promise<void> {
  const {
    ffmpeg,
    videoPath,
    clips,
    offsetsSec,
    music,
    srtPath,
    burnCaptions,
    outPath,
    echo,
  } = args;
  // Audio inputs (and their mix tracks) in lockstep: narration clips at full
  // volume first, then any music underneath at its set gain.
  const tracks: AudioTrack[] = [
    ...offsetsSec.map((s) => ({ delayMs: Math.round(s * 1000) })),
    ...music.map((m) => ({
      delayMs: Math.round(m.delaySec * 1000),
      volume: m.volume,
      fadeInAtSec: m.fadeInAtSec,
      fadeInDurSec: m.fadeInDurSec,
      fadeOutAtSec: m.fadeOutAtSec,
      fadeOutDurSec: m.fadeOutDurSec,
    })),
  ];
  const filter = buildAudioMix(tracks);

  const inputs = ["-i", videoPath];
  for (const clip of clips) {
    inputs.push("-i", clip.m4aPath);
  }
  for (const track of music) {
    inputs.push("-i", track.path);
  }

  // Captions go in a band ADDED BELOW the frame, never on top of the recording.
  // A caption laid over the video covers exactly what the viewer was told to
  // look at — on a real demo the line "the date field springs free" sat over the
  // table containing the date field. Padding keeps the app pixels untouched and
  // 1:1 (no rescale, no blur) and gives the text a dedicated strip.
  const probed = burnCaptions ? await probeVideo(ffmpeg, videoPath) : undefined;
  const band = captionBandPx(probed?.height);
  const filterComplex = burnCaptions
    ? `${filter};[0:v]pad=iw:ih+${band}:0:0:color=black,subtitles='${escapeSubtitlesPath(srtPath)}':force_style='${SUBTITLE_STYLE}'[vout]`
    : filter;

  const videoMap = burnCaptions ? "[vout]" : "0:v";
  const videoCodec = burnCaptions
    ? ["-c:v", "libvpx", "-b:v", "1M"]
    : ["-c:v", "copy"];

  // Bound the output to the video's length. amix uses duration=longest, and a
  // music provider may return a track far longer than the video (e.g. ACE-Step
  // ignores the requested duration and returns minutes of audio) — without this
  // cap that music keeps playing for minutes after the credits end.
  const videoDurSec = await audioDurationSec(ffmpeg, videoPath);
  const durationCap = videoDurSec ? ["-t", videoDurSec.toFixed(3)] : [];

  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      videoMap,
      "-map",
      "[aout]",
      ...videoCodec,
      // The output container is WebM, whose muxer accepts only Opus/Vorbis
      // audio (it hard-rejects AAC) — so the mixed track is encoded to Opus
      // here. The per-step .m4a transcode stays AAC: that's an MP4 container.
      "-c:a",
      "libopus",
      ...durationCap,
      outPath,
    ],
    ENCODE_TIMEOUT_MS,
    echo
  );
}

// Height of the caption band added below the frame, in pixels. Sized to hold two
// rendered caption lines with breathing room — the SRT writer wraps to two — and
// proportional so it holds at any capture size. Pure → unit-tested.
export function captionBandPx(videoHeightPx: number | undefined): number {
  if (!(videoHeightPx && Number.isFinite(videoHeightPx) && videoHeightPx > 0)) {
    // Probe failed — fall back to the 720p band rather than padding by 0, which
    // would silently put captions back over the recording.
    return MIN_CAPTION_BAND_PX;
  }
  return Math.max(MIN_CAPTION_BAND_PX, Math.round(videoHeightPx * 0.18));
}

const MIN_CAPTION_BAND_PX = 96;

// libass force_style: white text on black, centered in the band added beneath
// the video. BorderStyle=3 is libass's opaque-box mode (1=outline, 3=box); only
// 3 paints BackColour as a box behind the text. The box is fully opaque here
// because it sits on the black band rather than over the recording, so there is
// nothing to see through. MarginV lifts the text off the bottom edge to sit
// roughly centered in the band.
const SUBTITLE_STYLE =
  "FontSize=18,PrimaryColour=&H00FFFFFF,BorderStyle=3,BackColour=&HFF000000,Alignment=2,MarginV=8";

// Escape the subtitles path for the filtergraph. The caller wraps it in single
// quotes, so filtergraph metacharacters (, ; [ ]) are already literal; we escape
// the quote and libass-significant backslash/colon for safety inside the quotes.
function escapeSubtitlesPath(srtPath: string): string {
  return srtPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function srtPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.srt`;
}

// Sidecar path for the song-mode lyrics, beside the video. In song mode the
// generated vocals carry no alignment data, so rather than fake time-synced
// captions we write the lyrics here as the honest text artifact.
export function lyricsPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.lyrics.txt`;
}

// Sidecar path holding the pre-cinematic (condensed) cut, beside the video. The
// cinematic pass preserves the condensed video here on its first run so it can be
// re-run with a different prompt/theme from the clean source — never stacking a
// title card / captions on a previous cinematic cut. Not a recorded artifact, so
// condense (which works off the artifact list) never touches it.
export function precinematicVideoPath(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.precinematic${ext}`;
}

function notApplied(reason: string): CinematicResult {
  return { applied: false, titleOffsetSec: 0, reason };
}

// A stage declining to proceed. Every stage in this pipeline degrades instead of
// throwing, so a stage that can't do its job hands the orchestrator the reason
// and the orchestrator turns it into notApplied() verbatim — the `reason` strings
// ARE the user-facing degrade contract.
interface Skip {
  skip: string;
}

// ---------------------------------------------------------------------------
// Stage 1: preconditions + media providers.
// ---------------------------------------------------------------------------

// Everything both passes (narration and song) need, resolved once: the source to
// read from, what this ffmpeg build can do, the providers, and the shared
// notes/temps/progress channels. Built by prepareCinematic.
interface CinematicContext {
  echo: Echo;
  ffmpeg: string;
  hasDrawtext: boolean;
  hasSubtitles: boolean;
  // The clean source to READ from: the .precinematic sidecar on a re-run, else
  // the (condensed) videoPath itself. Output always overwrites videoPath.
  input: string;
  log: Logger;
  narratableSteps: CinematicStep[];
  // Degradation notes, appended to by reference all the way down (providers push
  // per-track attribution into it at fetch time).
  notes: string[];
  options: CinematicOptions;
  progress: (message: string) => void;
  providers: MediaProviders;
  // A music model that actually SINGS supplied lyrics (ACE-Step / Lyria) — song
  // mode's requirement. Undefined when none is configured; stock music
  // (archive.org) is never eligible even when it won the normal chain.
  singingMusic: MusicProvider | undefined;
  // Sibling temp files, removed by cinematicProcess's finally even on a partial
  // failure. Every stage appends to this SAME array by reference.
  temps: string[];
  videoPath: string;
}

// Preserve the pre-cinematic (condensed) cut so this pass can be re-run with a
// different prompt/theme without re-recording, and return the path to read FROM.
// First run: copy the condensed videoPath to the sidecar and read the original.
// Re-run: the sidecar already exists, so read it — never stacking a title card /
// captions on a prior cinematic cut. The sidecar stays pristine either way.
async function resolvePrecinematicSource(videoPath: string): Promise<string> {
  const preserved = precinematicVideoPath(videoPath);
  try {
    await access(preserved);
    return preserved;
  } catch {
    await copyFile(videoPath, preserved);
    return videoPath;
  }
}

// Resolve the media providers, preferred local-first: oMLX (on-machine MLX
// models) wins per capability, then Gemini (if a key is set), then the local
// say/drawtext fallbacks. Each is best-effort — a failure degrades to the next.
// oMLX is probed (it lists its loaded models) only when it's configured.
async function resolveMedia(args: {
  ffmpeg: string;
  log: Logger;
  echo: Echo;
  notes: string[];
}): Promise<{
  providers: MediaProviders;
  singingMusic: MusicProvider | undefined;
}> {
  const { ffmpeg, log, echo, notes } = args;
  const omlx = await resolveOmlxProviders({ env: process.env, log, echo });
  const acestep = await resolveAceStepMusic({ env: process.env, log, echo });
  const gemini = resolveMediaProviders({ env: process.env, log });
  // Title-background sources: a configured local image server ($DAILIES_IMAGE_URL)
  // wins (explicit user config), then Gemini (Nano Banana), then Wikimedia
  // Commons real imagery; the always-available local gradient is added later
  // (once the theme is known) as the final fallback.
  const localImage = resolveLocalImage({ env: process.env, log, echo });
  // Stock/free fallbacks: archive.org music and Wikimedia images turn ON
  // automatically when no corresponding AI MODEL is configured, so a plain
  // `--cinematic` run still gets a score + real title imagery with no key/GPU.
  // An explicit $DAILIES_ARCHIVE_MUSIC/$DAILIES_WIKIMEDIA_IMAGES=1 forces them on
  // (and, for music, takes precedence over the models); =0 forces them off.
  // Both push per-track attribution into `notes` at fetch time by reference.
  const archive = resolveArchiveMusic({
    env: process.env,
    ffmpeg,
    log,
    notes,
    echo,
    allowFallback: !(acestep.music || gemini.music),
  });
  const wikimedia = resolveWikimediaImage({
    env: process.env,
    notes,
    log,
    echo,
    allowFallback: !(localImage.titleBackground || gemini.titleBackground),
  });
  const providers: MediaProviders = {
    tts: omlx.tts ?? gemini.tts,
    // Prefer stock (archive.org) when opted in, then generated (ACE-Step),
    // then Gemini Lyria.
    music: archive.music ?? acestep.music ?? gemini.music,
    titleBackground:
      localImage.titleBackground ??
      gemini.titleBackground ??
      wikimedia.titleBackground,
    notes: [],
  };
  notes.push(...omlx.notes, ...acestep.notes);
  // Surface Gemini's notes only when Gemini is actually active, or when there's
  // genuinely no local alternative — otherwise its "no key → using say … and no
  // music" note contradicts the oMLX/ACE-Step/archive providers above.
  if (gemini.tts || !(omlx.tts || providers.music)) {
    notes.push(...gemini.notes);
  }
  return {
    providers,
    // Song mode needs a model that sings OUR words; stock music can't, so it's
    // excluded here even though it may have won `providers.music` above.
    singingMusic: [acestep.music, gemini.music].find((m) => m?.singsLyrics),
  };
}

// Check every precondition and resolve the shared context, or hand back the
// reason this run can't proceed. Preconditions in cost order: cheap step/file
// checks, then the `claude` probe, then the ffmpeg filter probe.
async function prepareCinematic(args: {
  videoPath: string;
  steps: CinematicStep[];
  options: CinematicOptions;
  temps: string[];
}): Promise<CinematicContext | Skip> {
  const { videoPath, steps, options, temps } = args;
  const { ffmpegPath, log } = options;
  const narratableSteps = steps.filter((step) =>
    Number.isFinite(step.videoTime)
  );
  if (narratableSteps.length === 0) {
    return { skip: "no steps with a known video position" };
  }
  await access(videoPath);
  const input = await resolvePrecinematicSource(videoPath);
  if (!(await isOnPath("claude", ["--version"]))) {
    return { skip: "`claude` CLI not found on PATH" };
  }
  // Narration mixing is the irreducible core; the title card and burned captions
  // degrade gracefully when this build lacks their filters.
  const filters = await availableFilters(ffmpegPath);
  if (!(filters.has("adelay") && filters.has("amix"))) {
    return { skip: "ffmpeg lacks the adelay/amix filters for narration" };
  }
  const notes: string[] = [];
  const progress = options.onProgress ?? (() => undefined);
  // Echo each generation command (say/ffmpeg/claude, and a redacted curl for
  // HTTP providers) so a run is easy to reproduce and tweak — the user can copy
  // a line, change the voice/model, and re-run it by hand. `progress` already
  // matches the Echo shape, so commands ride the same stderr channel.
  const echo: Echo = progress;
  const media = await resolveMedia({ ffmpeg: ffmpegPath, log, echo, notes });
  return {
    echo,
    ffmpeg: ffmpegPath,
    hasDrawtext: filters.has("drawtext"),
    hasSubtitles: filters.has("subtitles"),
    input,
    log,
    narratableSteps,
    notes,
    options,
    progress,
    providers: media.providers,
    singingMusic: media.singingMusic,
    temps,
    videoPath,
  };
}

// ---------------------------------------------------------------------------
// Shared final stages: captions on disk, then the mix + in-place swap.
// ---------------------------------------------------------------------------

// Write the sibling .srt. It's needed on disk before the burn pass reads it, and
// it's tracked as a temp so a later failure cleans it up — a stale .srt with
// cinematic timings beside an un-processed video would mis-caption every soft-sub
// player. finalizeCinematic promotes it to a deliverable after the rename.
async function writeCaptionSrt(args: {
  videoPath: string;
  cues: { start: number; end: number; text: string }[];
  geometry: ProbedVideo | undefined;
  temps: string[];
}): Promise<string> {
  const srtPath = srtPathFor(args.videoPath);
  args.temps.push(srtPath);
  // Size each caption line to the actual video width so it holds to two lines on
  // a narrow custom --viewport, not just the 1280px default.
  await writeFile(
    srtPath,
    buildSrt(args.cues, captionLineMax(args.geometry?.width))
  );
  return srtPath;
}

// Burn captions only when asked AND supported; otherwise the .srt sidecar is the
// caption track (soft subs) and the degradation is noted so the user isn't left
// wondering where the burned captions went.
function resolveBurnCaptions(args: {
  want: boolean;
  hasSubtitles: boolean;
  ffmpeg: string;
  notes: string[];
  log: Logger;
}): boolean {
  const { want, hasSubtitles, ffmpeg, notes, log } = args;
  if (!want) {
    return false;
  }
  if (hasSubtitles) {
    return true;
  }
  const note =
    "captions not burned — this ffmpeg has no `subtitles` filter; wrote a soft-sub .srt instead";
  notes.push(note);
  log.warn({ ffmpeg }, `cinematic: ${note}`);
  return false;
}

// Mix the audio onto the assembled body (burning captions when asked), verify the
// encoder produced something, and atomically replace the original video (like
// condense). Returns a skip reason on an empty encode, else undefined — and on
// success drops the output plus every `deliverables` sidecar from the cleanup
// list, since those survive the run.
async function finalizeCinematic(args: {
  ffmpeg: string;
  videoPath: string;
  finalBody: string;
  clips: RenderedClip[];
  offsetsSec: number[];
  music: MusicTrack[];
  srtPath: string;
  burnCaptions: boolean;
  deliverables: string[];
  temps: string[];
  echo?: Echo;
}): Promise<string | undefined> {
  const {
    ffmpeg,
    videoPath,
    finalBody,
    clips,
    offsetsSec,
    music,
    srtPath,
    burnCaptions,
    deliverables,
    temps,
    echo,
  } = args;
  const finalPath = `${videoPath}.cinematic.webm`;
  temps.push(finalPath);
  await mixAudioAndCaptions({
    ffmpeg,
    videoPath: finalBody,
    clips,
    offsetsSec,
    music,
    srtPath: burnCaptions ? srtPath : "",
    burnCaptions,
    outPath: finalPath,
    echo,
  });
  const produced = await stat(finalPath);
  if (produced.size === 0) {
    return "encoder produced an empty file";
  }
  await rename(finalPath, videoPath);
  // The final video is the original path now, and each deliverable beside it (the
  // .srt, the lyrics sidecar) is kept — drop them from the cleanup list. Guarded
  // by indexOf so a deliverable that was never tracked (e.g. no .srt was written)
  // can't splice the last temp off the end.
  for (const keep of [finalPath, ...deliverables]) {
    const at = temps.indexOf(keep);
    if (at >= 0) {
      temps.splice(at, 1);
    }
  }
  return;
}

// ---------------------------------------------------------------------------
// Narration pass.
// ---------------------------------------------------------------------------

// The default cinematic pass: the LLM writes a line per step, TTS (or macOS
// `say`) voices each one, the body is re-timed so every step holds long enough
// for its line, and the narration is mixed in over an optional score.
async function runNarrationPass(
  ctx: CinematicContext
): Promise<CinematicResult> {
  const {
    echo,
    ffmpeg,
    input,
    log,
    narratableSteps,
    notes,
    options,
    progress,
    providers,
    temps,
    videoPath,
  } = ctx;
  // Voicing: a TTS provider, or macOS `say`. With a provider this runs on any
  // platform; without one it needs macOS.
  const speech = await resolveSpeech(providers, notes, echo);
  if (!speech) {
    return notApplied(
      "cinematic narration needs macOS `say` or a TTS provider (set GEMINI_API_KEY)"
    );
  }

  // Resolve the creative direction (+ change scale) and get the narration.
  progress("writing narration…");
  const planned = await planNarration({ options, narratableSteps, log, echo });
  if ("error" in planned) {
    return notApplied(`narration generation failed: ${planned.error}`);
  }
  const { direction, narration, repoDir, base } = planned;

  // Default the title-card background to a local themed gradient when no
  // generated-image provider (Gemini) is configured — network-free and always
  // available, so a plain install still gets an intentional card. The palette
  // follows the resolved theme, so this waits until `direction` is known.
  providers.titleBackground ??= createLocalTitleBackground(
    ffmpeg,
    direction.category
  );

  // Voice + TTS: one clip per step that got narration text. The provider voices
  // it when available (else macOS `say`). Surface the chosen direction/voice/rate
  // so a delightful run can be reproduced (pin via --prompt and
  // $DAILIES_SAY_VOICE / $DAILIES_SAY_RATE).
  const meta: CinematicMeta = {
    direction: direction.label,
    voice: speech.label,
    rate: speech.rate,
  };
  log.info(meta, "cinematic: narration parameters");
  progress(`voicing ${narration.steps.length} lines (${meta.voice})…`);
  const clips = await synthesizeClips({
    ffmpeg,
    say: speech.say,
    tts: providers.tts,
    steps: narratableSteps,
    byIndex: new Map(narration.steps.map((s) => [s.index, s.narration])),
    videoPath,
    temps,
    notes,
    log,
    echo,
  });
  if (clips.length === 0) {
    return notApplied("no narration audio could be synthesized");
  }

  // Re-time the video, prepend the title card (optionally over a generated
  // background), append the credits, and generate any music bed — producing the
  // final body, each step's/clip's position, and the music tracks for the mix.
  const assembled = await assembleVideo({
    ffmpeg,
    videoPath: input,
    narratableSteps,
    clips,
    title: narration.title,
    category: direction.category,
    // Theme only — the narration style ("…as natural prose narration") must not
    // reach the music/title-art providers (it made the score spoken-word).
    directionText: direction.theme,
    providers,
    voiceLabel: speech.label,
    hasDrawtext: ctx.hasDrawtext,
    repoDir,
    base,
    temps,
    notes,
    log,
    progress,
  });
  if (!assembled) {
    return notApplied("could not probe the video to re-time it");
  }
  const {
    finalBody,
    geometry,
    stepTimes,
    clipOffsetsSec,
    titleOffsetSec,
    music,
  } = assembled;

  const cues = clips.map((clip, k) => {
    const start = clipOffsetsSec[k] ?? 0;
    return { start, end: start + clip.durationSec, text: clip.narration };
  });
  const srtPath = await writeCaptionSrt({ videoPath, cues, geometry, temps });
  const burnCaptions = resolveBurnCaptions({
    want: options.captions,
    hasSubtitles: ctx.hasSubtitles,
    ffmpeg,
    notes,
    log,
  });

  progress(
    burnCaptions ? "mixing audio and burning captions…" : "mixing audio…"
  );
  const failed = await finalizeCinematic({
    ffmpeg,
    videoPath,
    finalBody,
    clips,
    offsetsSec: clipOffsetsSec,
    // The music is timed against the body; shift it past the title card so the
    // score doesn't play over the opening title (clips/captions are already
    // offset by titleOffsetSec).
    music: shiftMusic(music, titleOffsetSec),
    srtPath,
    burnCaptions,
    deliverables: [srtPath],
    temps,
    echo,
  });
  if (failed) {
    return notApplied(failed);
  }
  return { applied: true, titleOffsetSec, stepTimes, notes, meta };
}

// ---------------------------------------------------------------------------
// Song pass.
// ---------------------------------------------------------------------------

// One group's sung line: the steps it spans and the step its caption anchors on.
export interface GroupedLyricLine {
  firstStep: number;
  stepIdxs: number[];
  text: string;
}

// Match the model's lyric lines back onto the step groups that prompted them —
// the lyric `index` IS the group ordinal. Returns the by-group lookup plus the
// ordered lines the model actually wrote (groups it left blank are dropped).
// Pure → unit-tested.
export function orderGroupLyrics(
  groups: number[][],
  lines: { index: number; text: string }[]
): { lineByGroup: Map<number, string>; ordered: GroupedLyricLine[] } {
  const lineByGroup = new Map(lines.map((l) => [l.index, l.text]));
  const ordered = groups
    .map((stepIdxs, g) => ({
      firstStep: stepIdxs[0] ?? 0,
      stepIdxs,
      text: lineByGroup.get(g),
    }))
    .filter((x): x is GroupedLyricLine => Boolean(x.text));
  return { lineByGroup, ordered };
}

// The song-mode re-timing plan: where to trim the song, the caption cues rebased
// to that trim, and how long to hold each step's frame.
export interface SongTiming {
  // Cues in the TRIMMED-song timebase (0-based), each capped at maxCueSec. Empty
  // when no vocal region was detected.
  alignedCues: { start: number; end: number; text: string }[];
  // Just past the last sung line — where the body ends, dropping the instrumental
  // outro. Undefined when there's nothing to anchor to.
  bodyEnd?: number;
  // Per-step frame hold; one entry per step.
  holdDurSec: number[];
  // The user-facing note naming which timing source won.
  note: string;
  // Per-step output onset for the onset-anchored hard-cut re-time, or undefined to
  // fall back to the even holdDurSec split.
  onsets?: number[];
  // Seconds to cut off the song's head so the first sung line lands at 0. The
  // caller only actually trims when this clears ffmpeg's seek threshold.
  trimStartSec: number;
}

// Plan song-mode timing from the detected vocal region and the aligned cues.
//
// With a region: rebase the cues to the trim by a pure time shift (the song plays
// at delay 0, so clip time maps to final-video time before the title shift) and
// cap each at `maxCueSec`. The cap matters most for LRC/segment cues, whose end is
// the NEXT line's start: when the model leaves a long instrumental gap between sung
// lines, an uncapped cue would linger ~20s on screen — cap it so the line shows,
// then clears (the word path is already capped). Steps then split the vocal region
// evenly, and when cues survive the rebase each group is ANCHORED to the moment
// its line is actually sung (walking groups against the cues, which are a
// subsequence of the group lines, in order) so the re-time can hold each step's
// footage on screen exactly while its line plays.
//
// Without a region: keep the raw song (capped by the mix) and hold each GROUP long
// enough to sing its line (at least the group minimum), split across the group's
// steps. Steps in a group with no line keep a small default.
//
// Pure → unit-tested.
export function planSongTiming(args: {
  clipCues: { start: number; end: number; text: string }[];
  groups: number[][];
  // The lyric line each group sings, by group ordinal; groups the model left
  // blank are absent.
  lineByGroup: Map<number, string>;
  // How many lines the model wrote, for the note's "n/total lines sung" tally.
  lineCount: number;
  maxCueSec: number;
  region: { start: number; end: number } | null;
  sourceLabel: string;
  stepCount: number;
}): SongTiming {
  const {
    clipCues,
    groups,
    lineByGroup,
    lineCount,
    maxCueSec,
    region,
    sourceLabel,
    stepCount,
  } = args;
  if (!region) {
    const holdDurSec = Array.from({ length: stepCount }, () => 3.5);
    for (const [g, stepIdxs] of groups.entries()) {
      const text = lineByGroup.get(g);
      if (text) {
        const per =
          Math.max(GROUP_MIN_SEC, songHoldSec(text)) / stepIdxs.length;
        for (const i of stepIdxs) {
          holdDurSec[i] = per;
        }
      }
    }
    return {
      alignedCues: [],
      holdDurSec,
      trimStartSec: 0,
      note: "vocal timing not detected (no whisper model) — captions placed at step times; set $DAILIES_WHISPER_MODEL to align them to the singing",
    };
  }

  const trimStartSec = region.start;
  const alignedCues = clipCues
    .map((c) => {
      const start = c.start - trimStartSec;
      const end = Math.min(c.end - trimStartSec, start + maxCueSec);
      return { start, end, text: c.text };
    })
    .filter((c) => c.end > 0)
    .map((c) => ({ start: Math.max(0, c.start), end: c.end, text: c.text }));
  const bodyLen = Math.max(6, region.end - region.start);
  const timing: SongTiming = {
    alignedCues,
    holdDurSec: Array.from({ length: stepCount }, () => bodyLen / stepCount),
    trimStartSec,
    note: `captions aligned to ${sourceLabel} (${alignedCues.length}/${lineCount} lines sung)`,
  };
  if (alignedCues.length === 0) {
    return timing;
  }
  const groupSungStart: (number | null)[] = groups.map(() => null);
  let ci = 0;
  for (let g = 0; g < groups.length; g++) {
    const text = lineByGroup.get(g);
    if (text && alignedCues[ci]?.text === text) {
      groupSungStart[g] = alignedCues[ci]?.start ?? null;
      ci++;
    }
  }
  timing.bodyEnd = Math.max(...alignedCues.map((c) => c.end)) + 2;
  timing.onsets = songStepOnsets(groups, groupSungStart, timing.bodyEnd);
  return timing;
}

// The lyrics + creative direction for one song run, plus where a pinned song is
// cached. `reusing` means the pinned audio AND its saved lyrics/LRC are being
// replayed verbatim, so nothing is generated.
interface SongScript {
  base: string;
  direction: ReturnType<typeof resolveDirection>;
  lrcText?: string;
  lyrics: Lyrics;
  // $DAILIES_SONG_FILE, or "" when not pinning.
  pinnedSong: string;
  repoDir: string;
  reusing: boolean;
  // The pinned song's sidecar holding {direction, lyrics, lrcText}.
  songCache: string;
}

// Lyrics + direction for the song pass: reuse a pinned song's saved lyrics when
// $DAILIES_SONG_FILE points at an existing song (+ its .json), else plan fresh.
// Pinning lets an A/B reuse the SAME song + lyrics and vary only the re-timing
// (and avoids regenerating while iterating).
async function resolveSongScript(
  ctx: CinematicContext,
  groups: number[][]
): Promise<SongScript | Skip> {
  const { echo, log, narratableSteps, notes, options, progress } = ctx;
  const pinnedSong = process.env.DAILIES_SONG_FILE?.trim() ?? "";
  const songCache = pinnedSong ? `${pinnedSong}.json` : "";
  if (pinnedSong && existsSync(pinnedSong) && existsSync(songCache)) {
    const saved = JSON.parse(await readFile(songCache, "utf8")) as {
      direction: ReturnType<typeof resolveDirection>;
      lyrics: Lyrics;
      lrcText?: string;
    };
    const repoDir = options.repoDir ?? process.cwd();
    notes.push(`reusing pinned song (${pinnedSong})`);
    return {
      base: await resolveBase(repoDir),
      direction: saved.direction,
      lrcText: saved.lrcText,
      lyrics: saved.lyrics,
      pinnedSong,
      repoDir,
      reusing: true,
      songCache,
    };
  }
  // Size the lyric word-budget to the re-timed body length (one line per GROUP,
  // ~GROUP_MIN_SEC each), not the (often tiny) condensed input.
  progress("writing the lyrics…");
  const planned = await planSong({
    options,
    narratableSteps,
    groups,
    videoSeconds: Math.max(8, groups.length * GROUP_MIN_SEC),
    log,
    echo,
  });
  if ("error" in planned) {
    return { skip: `song lyrics generation failed: ${planned.error}` };
  }
  return {
    base: planned.base,
    direction: planned.direction,
    lyrics: planned.lyrics,
    pinnedSong,
    repoDir: planned.repoDir,
    reusing: false,
    songCache,
  };
}

// The song audio to score the video with: the pinned file when reusing, else a
// fresh generation (persisted alongside its lyrics/LRC when pinning, so the next
// run can replay it). No audio means song mode produced nothing, so we skip and
// keep the plain condensed cut rather than ship a silent "song" video.
async function resolveSongAudio(args: {
  ctx: CinematicContext;
  script: SongScript;
  songMusic: MusicProvider;
  lyricBlock: string;
  lineCount: number;
}): Promise<{ path: string; lrcText?: string } | Skip> {
  const { ctx, script, songMusic, lyricBlock, lineCount } = args;
  if (script.reusing && script.pinnedSong) {
    return { path: script.pinnedSong, lrcText: script.lrcText };
  }
  ctx.progress("composing the song…");
  const generated = await generateRawSong({
    provider: songMusic,
    directionText: script.direction.theme,
    lyrics: lyricBlock,
    // Size the song to the LYRIC LINES (the sung content), not the step count.
    targetSec: songTargetSec(lineCount),
    outPath: `${ctx.videoPath}.rawsong.wav`,
    temps: ctx.temps,
    notes: ctx.notes,
    log: ctx.log,
  });
  if (!generated) {
    return { skip: "song audio could not be generated" };
  }
  if (!script.pinnedSong) {
    return generated;
  }
  await copyFile(generated.path, script.pinnedSong);
  await writeFile(
    script.songCache,
    JSON.stringify({
      direction: script.direction,
      lyrics: script.lyrics,
      lrcText: generated.lrcText,
    })
  );
  return { path: script.pinnedSong, lrcText: generated.lrcText };
}

// The song-mode caption cues on the FINAL timeline: the vocal-aligned cues when we
// matched some (they're song-relative, and the song is delayed past the title card,
// so shift them by the same offset), otherwise step-timed — e.g. whisper found no
// usable lyrics in an instrumental-leaning song. (The step-timed fallback already
// uses stepTimes, which include the offset.) The body is probed only on that
// fallback, which is the only branch that needs the timeline's end.
async function songCaptionCues(args: {
  alignedCues: { start: number; end: number; text: string }[];
  ordered: GroupedLyricLine[];
  stepTimes: number[];
  titleOffsetSec: number;
  ffmpeg: string;
  finalBody: string;
}): Promise<{ start: number; end: number; text: string }[]> {
  const { alignedCues, ordered, stepTimes, titleOffsetSec, ffmpeg, finalBody } =
    args;
  if (alignedCues.length > 0) {
    return alignedCues.map((c) => ({
      start: c.start + titleOffsetSec,
      end: c.end + titleOffsetSec,
      text: c.text,
    }));
  }
  return layoutSongCues(
    ordered.map((x) => ({ start: stepTimes[x.firstStep] ?? 0, text: x.text })),
    (await audioDurationSec(ffmpeg, finalBody)) ?? 0
  );
}

// Song mode: instead of per-step spoken narration, the LLM writes one short themed
// lyric line per step-GROUP and a singing music model (ACE-Step, with LM planning
// on for adherence) performs them as the whole soundtrack. We find where each line
// is actually sung (the model's LRC timestamps floored by whisper word-onsets, else
// word/segment alignment), burn captions at those times, and onset-anchor the body
// so each group's footage is on screen while its line plays.
async function runSongPass(ctx: CinematicContext): Promise<CinematicResult> {
  const {
    echo,
    ffmpeg,
    input,
    log,
    narratableSteps,
    notes,
    options,
    progress,
    providers,
    singingMusic,
    temps,
    videoPath,
  } = ctx;
  if (!singingMusic) {
    return notApplied(
      "song mode needs a lyrics-capable music model — start the ACE-Step server (set DAILIES_ACESTEP_URL for a non-default port) or set GEMINI_API_KEY"
    );
  }

  // Group short consecutive steps so one sung line spans >= GROUP_MIN_SEC — fewer,
  // longer verses instead of a frantic line per tiny step. Grouping is
  // deterministic for a recording, so a pinned-song reuse maps back the same way.
  const groups = groupStepsForLyrics(
    stepFootageSec(narratableSteps),
    GROUP_MIN_SEC
  );

  const script = await resolveSongScript(ctx, groups);
  if ("skip" in script) {
    return notApplied(script.skip);
  }
  const { direction, lyrics } = script;
  const { lineByGroup, ordered } = orderGroupLyrics(groups, lyrics.lines);
  const orderedTexts = ordered.map((x) => x.text);
  // The lyric block the model sings is these group lines in order (a [verse] tag
  // helps the model).
  const lyricBlock = `[verse]\n${orderedTexts.join("\n")}`;

  const meta: CinematicMeta = {
    direction: direction.label,
    voice: "",
    rate: 0,
    song: true,
    music:
      (await singingMusic.credit?.(direction.theme).catch(() => undefined)) ??
      singingMusic.id,
  };
  log.info(meta, "cinematic: song parameters");

  const audio = await resolveSongAudio({
    ctx,
    script,
    songMusic: singingMusic,
    lyricBlock,
    lineCount: orderedTexts.length,
  });
  if ("skip" in audio) {
    return notApplied(audio.skip);
  }

  // Caption source + vocal region. Transcribe (best-effort), then pick the best
  // timing source (LRC → word → segment) — see selectSongCaptions.
  progress("listening for the vocals…");
  const transcript = await transcribeSong({
    audioPath: audio.path,
    ffmpeg,
    env: process.env,
    echo,
  });
  // $DAILIES_ACESTEP_LRC=0 forces the transcribe path even when LRC is present.
  const { region, clipCues, sourceLabel } = selectSongCaptions({
    orderedTexts,
    lrcText: audio.lrcText,
    useLrc: process.env.DAILIES_ACESTEP_LRC?.trim() !== "0",
    segments: transcript?.segments ?? [],
    words: transcript?.words ?? [],
    leadSec: TITLE_SEC + 0.5,
    maxCueSec: MAX_CUE_SEC,
  });

  const timing = planSongTiming({
    clipCues,
    groups,
    lineByGroup,
    lineCount: orderedTexts.length,
    maxCueSec: MAX_CUE_SEC,
    region,
    sourceLabel,
    stepCount: Math.max(1, narratableSteps.length),
  });
  notes.push(timing.note);
  let songClip = audio.path;
  if (timing.trimStartSec > 0.05) {
    songClip = `${videoPath}.song.wav`;
    temps.push(songClip);
    await trimAudio({
      ffmpeg,
      src: audio.path,
      startSec: timing.trimStartSec,
      outPath: songClip,
      echo,
    });
  }

  // Build the (silent) video around the song: re-time, title, credits. Same
  // local-gradient default as the narration path.
  providers.titleBackground ??= createLocalTitleBackground(
    ffmpeg,
    direction.category
  );
  const assembled = await assembleSongVideo({
    ffmpeg,
    videoPath: input,
    narratableSteps,
    holdDurSec: timing.holdDurSec,
    onsets: timing.onsets,
    bodyEnd: timing.bodyEnd,
    title: lyrics.title,
    category: direction.category,
    directionText: direction.theme,
    providers: {
      music: singingMusic,
      titleBackground: providers.titleBackground,
      notes: [],
    },
    hasDrawtext: ctx.hasDrawtext,
    repoDir: script.repoDir,
    base: script.base,
    temps,
    notes,
    log,
    progress,
  });
  if (!assembled) {
    return notApplied("could not probe the video to build the song cut");
  }
  const { finalBody, geometry, stepTimes, titleOffsetSec } = assembled;

  // Captions. The sibling .srt is ALWAYS written beside the video (a deliverable
  // for editing / soft-sub players) — this is the documented contract.
  // --no-captions only skips BURNING the captions into the pixels, not the .srt.
  // We also BURN them (when this ffmpeg can) so they're visible in any player,
  // since a sibling .srt isn't loaded by QuickTime or the report viewer.
  const cues = await songCaptionCues({
    alignedCues: timing.alignedCues,
    ordered,
    stepTimes,
    titleOffsetSec,
    ffmpeg,
    finalBody,
  });
  const srtPath = srtPathFor(videoPath);
  const wroteSrt = cues.length > 0;
  if (wroteSrt) {
    await writeCaptionSrt({ videoPath, cues, geometry, temps });
  } else {
    // Nothing to caption — drop any stale .srt from a prior run.
    await rm(srtPath, { force: true });
  }
  const burnCaptions =
    wroteSrt &&
    resolveBurnCaptions({
      want: options.captions !== false,
      hasSubtitles: ctx.hasSubtitles,
      ffmpeg,
      notes,
      log,
    });

  // The full lyrics sidecar (one line per group, in order).
  const lyricsPath = lyricsPathFor(videoPath);
  temps.push(lyricsPath);
  await writeFile(
    lyricsPath,
    `${lyrics.title}\n\n${orderedTexts.join("\n")}\n`
  );

  // Mix the song under the video and burn the captions. The mix's -t cap trims the
  // long song down to the video length.
  progress(
    burnCaptions ? "mixing the song and burning captions…" : "mixing the song…"
  );
  const failed = await finalizeCinematic({
    ffmpeg,
    videoPath,
    finalBody,
    clips: [],
    offsetsSec: [],
    // Start the song after the title card, not under it.
    music: [{ path: songClip, delaySec: titleOffsetSec, volume: 0.9 }],
    srtPath,
    burnCaptions,
    deliverables: [srtPath, lyricsPath],
    temps,
    echo,
  });
  if (failed) {
    return notApplied(failed);
  }
  return { applied: true, titleOffsetSec, stepTimes, notes, meta };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

// Overwrites `videoPath` IN PLACE with the cinematic cut (title card prepended,
// narration or a sung song mixed in, captions optionally burned, credits rolled).
// Always writes a sibling `.srt`. Never throws: any failure leaves the original
// video untouched and returns { applied:false, titleOffsetSec:0, reason }.
//
// The pipeline is a sequence of stages, every one of them optional and degrading
// instead of throwing:
//
//   prepareCinematic  preconditions + media providers → context, or a skip reason
//   runNarrationPass  plan → voice → re-time → title/credits → mix
//   runSongPass       lyrics → sing → align → onset-anchored re-time → mix
//
// The `temps` array and the try/catch/finally live HERE so a partial failure
// still cleans up every sibling temp: each stage appends to that same array by
// reference, and every thrown error lands in the one catch as a skip reason.
export async function cinematicProcess(
  videoPath: string,
  steps: CinematicStep[],
  options: CinematicOptions
): Promise<CinematicResult> {
  // Temps are all siblings of videoPath; the finally removes them even on a
  // partial failure (mirrors condense.ts).
  const temps: string[] = [];
  try {
    const ctx = await prepareCinematic({ videoPath, steps, options, temps });
    if ("skip" in ctx) {
      return notApplied(ctx.skip);
    }
    return options.song ? await runSongPass(ctx) : await runNarrationPass(ctx);
  } catch (err) {
    options.log.debug(
      { err, videoPath },
      "cinematic processing failed; keeping original"
    );
    return notApplied(err instanceof Error ? err.message : String(err));
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }
}
