// Pure caption/SRT helpers: SRT timestamp + document building, and the
// burned-caption word-wrap / truncation logic. No external dependencies.

// Burned-caption layout. Every caption occupies a fixed box of CAPTION_MAX_LINES
// lines: `wrapCaption` never produces more (narration that doesn't fit is
// truncated with an ellipsis on screen — the audio still speaks it in full), and
// `padCaptionBox` pads a shorter cue back up to it.
//
// That fixed line count is load-bearing, not cosmetic. The burn style is
// bottom-anchored with a margin sized for the full box (see `subtitleStyle` in
// narrate.ts), so a cue rendering FEWER lines than the box floats downward.
// Measured at 1440x900: a one-line cue's first line started 62px below the band
// top while a two-line cue's started at 20px. That is the whole "song captions
// look vertically centred, cinematic ones don't" report — song lyrics are short
// enough to always be one line. Padding removes the difference (both 20px).
const CAPTION_MAX_LINES = 2;

// The pad character is U+00A0. A plain ASCII space does NOT work: measured,
// ffmpeg's SRT decoder drops a whitespace-only trailing line and the cue renders
// at its unpadded height. (ASS's `\h` hard space also works, but it would show up
// literally in the .srt sidecar that soft-sub players read.) The pad line is
// invisible in the burn — BorderStyle=3 paints an opaque black box behind it, and
// the band is black.
const CAPTION_PAD_CHAR = "\u00A0";

// Upper bound on one caption line however wide the frame is. Two lines of this
// hold the ~95-character maximum the narration prompt asks for (script-llm.ts)
// with room to spare, and a longer single line stops being readable.
const CAPTION_LINE_CAP = 60;

// Floored so a tiny frame still shows a few words instead of an ellipsis, even
// though at that size the text genuinely cannot fit (a 390px-wide portrait
// capture computes 16).
const CAPTION_LINE_MIN = 12;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// Format seconds as an SRT timestamp "HH:MM:SS,mmm" (comma before the
// milliseconds, all fields zero-padded). Handles sub-second and >1h values;
// negatives clamp to zero.
export function secToSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const seconds = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const minutes = totalMin % 60;
  const hours = Math.floor(totalMin / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(ms, 3)}`;
}

// Build a valid multi-cue SRT document from timed cues. Cue numbers are
// 1-based; each cue is "<n>\n<start> --> <end>\n<text>\n\n".
export function buildSrt(
  cues: { start: number; end: number; text: string }[],
  maxCharsPerLine = CAPTION_LINE_CAP
): string {
  return cues
    .map((cue, i) => {
      const start = secToSrtTimestamp(cue.start);
      const end = secToSrtTimestamp(cue.end);
      const text = padCaptionBox(wrapCaption(cue.text, maxCharsPerLine));
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join("\n");
}

// Pad a wrapped caption out to `maxLines` rendered lines, so every cue occupies
// the same box and the burn's bottom-anchored margin puts the first line at the
// top of the band for all of them. See CAPTION_PAD_CHAR for why it's a U+00A0
// and not a space. Pure → unit-tested.
export function padCaptionBox(
  wrapped: string,
  maxLines = CAPTION_MAX_LINES
): string {
  // A cue with no words stays empty — padding it would put a lone invisible
  // character on screen and make an empty cue look like a caption.
  if (!wrapped) {
    return wrapped;
  }
  const lines = wrapped.split("\n");
  while (lines.length < maxLines) {
    lines.push(CAPTION_PAD_CHAR);
  }
  return lines.join("\n");
}

// Caption chars-per-line for a frame `widthPx` wide whose captions render at
// `fontSizePx` (narrate.ts `captionFontPx`).
//
// Re-derived from burned frames (ffmpeg 9.0.1, libass 0.17.5). This used to be
// `width * 0.0375`, a function of the frame WIDTH alone, which can't be right:
// how many characters fit depends on the font, and the font is sized from the
// caption band, which is sized from the frame HEIGHT. So a width-only budget is
// miscalibrated on every aspect but the one it was measured at (1280x720) — it
// left a 1440x900 frame using ~55% of its width, which is the "captions should
// use more of the width" report, and it would have overflowed a 1440x1080 one.
//
// Measured ink width per character as a multiple of FontSize, and identical at
// 1280x720 (FontSize 34) and 1440x900 (FontSize 42) — so this is a property of
// the font, not the frame:
//
//   mixed-case prose 0.393   all-caps prose 0.528
//   digits           0.474   narrow ("illicit if it") 0.259
//
// Budgeting for the widest PROSE (all-caps) at CAPTION_WIDTH_SAFETY of the frame
// keeps the worst case clear of the edge: measured, an all-caps line at the
// resulting budget fills 89% of a 1440x900 frame, against a libass auto-wrap
// threshold of ~98% (87 chars filling 1406 of 1440px stayed on one line; 92
// chars wrapped). Text wider than all-caps prose — CJK, or a line of nothing but
// M and W — still exceeds this; `WrapStyle=2` in the burn style is what keeps
// that from becoming a third line.
const CAPTION_WIDEST_PROSE_RATIO = 0.53;
const CAPTION_WIDTH_SAFETY = 0.9;

export function captionLineMax(
  widthPx: number | undefined,
  fontSizePx: number | undefined
): number {
  if (!(widthPx && widthPx > 0 && fontSizePx && fontSizePx > 0)) {
    // Probe failed, so there is nothing to compute from. The cap is safe here
    // rather than merely a guess: the same failed probe drops the band to its
    // 96px minimum (captionBandPx) and the burn falls back to a 1280px width, so
    // the caption renders at FontSize 25 — smaller than any real capture — and
    // the cap's 60 chars of all-caps fill 795 of those 1280px (62%). The formula
    // would have allowed 86.
    return CAPTION_LINE_CAP;
  }
  const pxPerChar = CAPTION_WIDEST_PROSE_RATIO * fontSizePx;
  const fits = Math.floor((widthPx * CAPTION_WIDTH_SAFETY) / pxPerChar);
  return Math.max(CAPTION_LINE_MIN, Math.min(CAPTION_LINE_CAP, fits));
}

function truncateWithEllipsis(line: string, limit: number): string {
  if (line.length + 1 <= limit) {
    return `${line}…`;
  }
  return `${line.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// Wrap caption text for burn-in so it never shows more than `maxLines` lines.
// Greedy word wrap at `maxCharsPerLine`; if the text needs more lines than that,
// the last line is truncated with an ellipsis. The explicit line breaks become
// libass `\N`, and `WrapStyle=2` in the burn style means they are the ONLY thing
// that starts a line — libass can't add a surprise extra one on top.
export function wrapCaption(
  text: string,
  maxCharsPerLine = CAPTION_LINE_CAP,
  maxLines = CAPTION_MAX_LINES
): string {
  const limit = Math.max(1, maxCharsPerLine);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    // `word` won't fit on the current line. If a new line would exceed the
    // budget, stop here — the leftover words get folded into an ellipsis.
    if (lines.length + 1 >= maxLines) {
      truncated = true;
      break;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  if (truncated) {
    lines[lines.length - 1] = truncateWithEllipsis(lines.at(-1) ?? "", limit);
  }
  return lines.join("\n");
}

// Strip inline caption override tags (`{...}`) from narration text before it's
// spoken or written to the report, leaving the plain words.
export function stripOverrideTags(text: string): string {
  return text.replace(/\{[^}]*\}/g, "").replace(/[{}]/g, "");
}
