// The LLM plumbing for cinematic scripting: resolving the creative direction and
// change-scale cue, building the narration/lyrics prompts, forcing + parsing the
// structured `claude -p` JSON, and the small pure text helpers those need. The
// plan orchestration (planNarration/planSong) stays in narrate.ts and imports
// what it needs from here.

import type { Logger } from "dailies-logger";
import { generateJson, LLM_TIMEOUT_MS, writerCredit } from "../llm/index.js";
import { tryParseJson } from "../llm/json.js";
import { type Echo, run, VERSION_PROBE_TIMEOUT_MS } from "./ffmpeg.js";
import { stripOverrideTags } from "./srt.js";
import {
  type StyleId,
  selectStyle,
  selectThemes,
  type ThemeCategory,
} from "./themes.js";

// The LLM call is generous.

// Max characters of a step's script we feed the LLM — enough for context
// without bloating the prompt.
const SCRIPT_SLICE_CHARS = 200;

interface NarrationStep {
  index: number;
  narration: string;
}

export interface Narration {
  steps: NarrationStep[];
  title: string;
}

// Song-mode plan: one short, singable lyric line per GROUP of steps (consecutive
// short steps are grouped so one verse spans them — see groupStepsForLyrics; a run
// of setup/auth steps collapses into ONE group — see planLyricGroups) plus an
// opening title. Each line is later timed to where it's actually SUNG (the model's
// LRC timestamps and/or whisper word-onsets), and the video is re-timed so each
// group's footage is on screen while its line plays.
interface LyricLine {
  index: number;
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
  title: string;
}

export interface ChangeContext {
  // Stats line for the prompt, e.g. "45 commits, 71 files, +7386/-402".
  label: string;
  // A nudge toward the right production scale for the LLM to match.
  scaleHint: string;
}

// The model — especially through structured output (--json-schema) — often writes
// a two-line title as a LITERAL backslash-n instead of a real newline. Convert it
// to a real newline so wrapTitle splits it into two title-card lines and the
// credits roll collapses it to a space (instead of showing "\n" / a stray "n").
// Pure → unit-tested.
export function normalizeTitle(title: string): string {
  return title.replace(/\\r\\n|\\n|\\r/g, "\n").trim();
}

// Pull the text out of any page.showCaption("…") calls in a step's script.
// In a cinematic recording these overlays aren't drawn (the burned captions
// replace them), but the operator's own caption is the clearest statement of
// what the step is about — so it's fed to the narration LLM as intent context,
// in full (captions are short) rather than risking the truncated script slice.
// Handles single, double, and template-literal quotes and basic escapes.
export function extractCaptions(script: string | undefined): string[] {
  if (!script) {
    return [];
  }
  const captions: string[] = [];
  const re = /showCaption\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null = re.exec(script);
  while (match !== null) {
    const text = (match[2] ?? "").replace(/\\(["'`\\])/g, "$1").trim();
    if (text) {
      captions.push(text);
    }
    match = re.exec(script);
  }
  return captions;
}

// Getting into the app is not what the film is about.
//
// Measured on a real run: a 14-step session whose first three steps (goto-root →
// click-developer-login → choose-company-admin-and-sign-in, ~19s of footage) spent
// TWO of the song's seven lines on logging in, leaving five for the feature
// actually under test (which columns a table header shows). Song mode demands
// exactly one line per section, so an auth section is FORCED to earn a line —
// prompt wording alone cannot fix that. So the SECTIONS collapse: a run of setup
// steps becomes one section, and one section can only ever cost one line.

// camelCase hump + word-boundary splits for stepNameTokens.
const CAMEL_HUMP_RE = /([a-z0-9])([A-Z])/g;
const NON_WORD_RE = /[^a-z0-9]+/;
// A bare count or duration token ("2", "500ms", "3x") — never product content.
const COUNT_TOKEN_RE = /^\d+(ms|s|sec|secs|x)?$/;

// Tokens that MARK a step name as plumbing. Matched as whole TOKENS, never as
// substrings: "check-logo-visible" must not read as a login and "waiting-list"
// must not read as a wait.
const SETUP_MARKERS = new Set([
  // reaching the app at all
  "goto",
  "navigate",
  "visit",
  // authenticating
  "auth",
  "authenticate",
  "login",
  "logon",
  "signin",
  // giving the app a moment
  "retries",
  "retry",
  "settle",
  "settles",
  "sleep",
  "wait",
  "waiting",
  "waits",
  // the automation looking at the page instead of using it
  "debug",
  "dump",
  "inspect",
  "probe",
  "screenshot",
  "snapshot",
]);

// Multi-token markers, tested against the "-"-joined tokens padded on both sides
// so they can only match on token boundaries ("log-in", never "audit-log-invoices").
const SETUP_PHRASES = ["log-in", "logged-in", "log-on", "sign-in", "signed-in"];

// Picking who you are is plumbing only as a PAIR — one of these verbs with one of
// these nouns. Either half alone is far too weak: "verify-admin-can-delete-row"
// and "switch-the-invoice-view" are real beats.
const IDENTITY_VERBS = new Set([
  "choose",
  "chooses",
  "pick",
  "picks",
  "select",
  "selects",
  "switch",
  "switches",
]);
const IDENTITY_NOUNS = new Set([
  "account",
  "companies",
  "company",
  "org",
  "organization",
  "persona",
  "role",
  "roles",
  "tenant",
  "workspace",
]);

// Tokens allowed to APPEAR in a plumbing name without being evidence of one:
// connectives, the generic verbs of arriving somewhere, the generic words for
// "the first screen", and the identity/wait/inspect nouns those markers take.
// This list is the actual safety mechanism — a token outside it (plus the marker
// sets above) names something in the PRODUCT, and that makes the step a beat.
const SETUP_QUALIFIERS = new Set([
  // connectives
  "a",
  "an",
  "and",
  "as",
  "at",
  "back",
  "first",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "then",
  "to",
  "up",
  "with",
  // generic verbs of getting somewhere / getting in
  "click",
  "clicks",
  "enter",
  "enters",
  "fill",
  "fills",
  "go",
  "goes",
  "land",
  "lands",
  "load",
  "loads",
  "open",
  "opens",
  "press",
  "presses",
  "reload",
  "reloads",
  "start",
  "type",
  "types",
  // the generic "first screen", never a named product surface
  "app",
  "application",
  "base",
  "home",
  "homepage",
  "index",
  "landing",
  "page",
  "pages",
  "root",
  "screen",
  "site",
  "url",
  // who you sign in as
  "admin",
  "admins",
  "creds",
  "credentials",
  "demo",
  "dev",
  "developer",
  "email",
  "log",
  "logged",
  "password",
  "sandbox",
  "session",
  "sign",
  "signed",
  "superadmin",
  "test",
  "user",
  "username",
  // what a wait waits on
  "idle",
  "loadstate",
  "network",
  "ready",
  "sec",
  "second",
  "seconds",
  "secs",
  "state",
  // what an inspection inspects
  "dom",
  "element",
  "elements",
  "html",
  "node",
  "nodes",
  "selector",
  "selectors",
]);

// Split a step name into lowercase word tokens. kebab-case, snake_case, dotted,
// spaced and camelCase names all reduce to the same token list, so the pattern
// sets above don't have to care how the operator writes step names.
// Pure → unit-tested.
export function stepNameTokens(name: string): string[] {
  return name
    .replace(CAMEL_HUMP_RE, "$1-$2")
    .toLowerCase()
    .split(NON_WORD_RE)
    .filter(Boolean);
}

// True when a step is PLUMBING rather than a beat of the product story: reaching
// the app, signing in, picking a company/role, waiting or retrying, or the
// automation inspecting the page.
//
// BOTH conditions are required, deliberately — a false positive silently deletes
// a real beat from the film, while a false negative only costs one extra line:
//
//  1. the name carries a setup marker (a token, a phrase, or an identity
//     verb+noun pair), AND
//  2. every OTHER token is a qualifier/connective. One unrecognized token means
//     the name names something in the product, so the step keeps its own line:
//     "waiting-list-signup" has a wait marker but "list"/"signup" are product,
//     "navigate-to-column-settings" has a nav marker but "column"/"settings" are.
//
// The step's SCRIPT is deliberately NOT consulted. A product beat's script also
// calls page.goto and fills fields, so script text can only promote false
// positives; the name is the operator's own label for the moment and the safer
// signal. It stays in the parameter type so callers pass steps through as-is.
// Pure → unit-tested.
export function isSetupStep(step: { name: string; script?: string }): boolean {
  const tokens = stepNameTokens(step.name);
  if (tokens.length === 0) {
    return false;
  }
  const known = tokens.every(
    (t) =>
      SETUP_MARKERS.has(t) ||
      SETUP_QUALIFIERS.has(t) ||
      IDENTITY_VERBS.has(t) ||
      IDENTITY_NOUNS.has(t) ||
      COUNT_TOKEN_RE.test(t)
  );
  if (!known) {
    return false;
  }
  const joined = `-${tokens.join("-")}-`;
  return (
    tokens.some((t) => SETUP_MARKERS.has(t)) ||
    SETUP_PHRASES.some((phrase) => joined.includes(`-${phrase}-`)) ||
    (tokens.some((t) => IDENTITY_VERBS.has(t)) &&
      tokens.some((t) => IDENTITY_NOUNS.has(t)))
  );
}

// The song-mode sections: the footage grouping, with every RUN of 2+ consecutive
// setup steps pre-collapsed into a single section so the whole "get into the app"
// stretch can only earn ONE lyric line. The non-setup stretches around those runs
// are grouped by footage exactly as before, each starting a fresh accumulation —
// which is what stops the run's last step (say the sign-in) from being swept into
// the first product section and costing that beat its line.
//
// A LONE setup step is left alone on purpose: on its own it already costs at most
// one line, and giving it its own section would sometimes cost MORE (the footage
// grouper would otherwise have folded it in with the first real beat). That also
// makes a single misclassified step a no-op — it takes two adjacent false
// positives to lose a beat.
//
// `group` is narrate.ts's groupStepsForLyrics, injected rather than imported: it
// owns GROUP_MIN_SEC and the condensed timeline, and narrate.ts already imports
// this module. The result partitions [0, steps.length) in order, exactly like the
// grouper alone — song re-timing indexes holds/onsets by step, so a dropped or
// reordered index would silently desync the video from the vocals.
// Pure → unit-tested.
export function planLyricGroups(args: {
  footageSec: number[];
  group: (footageSec: number[], minSec: number) => number[][];
  minSec: number;
  steps: { name: string; script?: string }[];
}): number[][] {
  const { footageSec, group, minSec, steps } = args;
  // Normalize to one footage entry per step so every branch below partitions the
  // same index range.
  const footage = steps.map((_, i) => footageSec[i] ?? 0);
  const setup = steps.map(isSetupStep);
  const runs: { end: number; start: number }[] = [];
  let i = 0;
  while (i < steps.length) {
    if (!setup[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < steps.length && setup[j]) {
      j += 1;
    }
    if (j - i >= 2) {
      runs.push({ start: i, end: j });
    }
    i = j;
  }
  const collapsed = runs.reduce((n, r) => n + (r.end - r.start), 0);
  // Nothing to collapse, or the session is nothing BUT plumbing (a login-only
  // recording) — collapsing that would leave a one-line song, so leave the
  // footage grouping alone.
  if (runs.length === 0 || collapsed >= steps.length) {
    return group(footage, minSec);
  }
  const groups: number[][] = [];
  let cursor = 0;
  const flushProduct = (end: number) => {
    if (end <= cursor) {
      return;
    }
    const at = cursor;
    for (const local of group(footage.slice(at, end), minSec)) {
      groups.push(local.map((k) => at + k));
    }
  };
  for (const run of runs) {
    flushProduct(run.start);
    groups.push(
      Array.from({ length: run.end - run.start }, (_, k) => run.start + k)
    );
    cursor = run.end;
  }
  flushProduct(steps.length);
  return groups;
}

// Build the `claude -p` prompt: the creative direction, the step list, and a
// strict-JSON output contract. The `direction` is the already-composed steering
// text (a random theme+style draw, or the user's verbatim --prompt). Deterministic
// given its inputs (testable).
export function buildNarrationPrompt(args: {
  direction: string;
  change?: ChangeContext;
  steps: { index: number; name: string; script?: string }[];
}): string {
  const { direction, change, steps } = args;
  const stepLines = steps
    .map((step) => {
      const slice = step.script?.slice(0, SCRIPT_SLICE_CHARS).trim();
      const scriptPart = slice ? ` — does: ${slice}` : "";
      const captions = extractCaptions(step.script);
      const intentPart = captions.length
        ? ` — intent: ${captions.map((c) => `"${c}"`).join(" ")}`
        : "";
      return `  ${step.index}. ${step.name}${scriptPart}${intentPart}`;
    })
    .join("\n");

  const changeLines = change
    ? [
        `Sense of scale (SECONDARY to the creative direction — use it only to size the length and energy, never to override the theme or its format): the change under review is ${change.label}, so ${change.scaleHint}.`,
        "",
      ]
    : [];

  return [
    "You are scripting voiceover narration for a screen-recording of an automated browser QA session.",
    "Narrate it as a short cinematic piece, fully in character for the creative direction below.",
    "",
    `Creative direction: ${direction}`,
    "",
    ...changeLines,
    "Steps (each is one moment in the video, in order):",
    stepLines,
    "",
    "Rules:",
    '- OPEN by saying what is being tested. The very FIRST line must orient the viewer: in ONE short clause, the feature or behaviour this run exercises. Put it on the first step, keep it under ~12 words, and stay in character — "today we see whether X holds up", not a summary paragraph. Someone who watches only the opening should know what they are about to watch.',
    "- Do NOT leave a long stretch with no voice at all. A silent step still plays its footage in full, so several empty narrations in a row read as dead air rather than restraint. If three or more consecutive steps would be empty, give the FIRST of them a short line.",
    '- NOT every step needs narration. Narrate only the beats a viewer actually cares about — a real action taken, a screen or result reached, a meaningful change. For steps that are setup, waiting, retries, scrolling, or the automation inspecting the page (snapshots, DOM/selector probing, debug pokes), emit an EMPTY narration string "" so that moment plays with no voice-over. A few well-placed lines over a quiet score beat a wall-to-wall play-by-play.',
    "- Getting INTO the app is never the point: loading the first page, signing in, choosing a company or role. That whole stretch gets ONE line — the orienting line above — plus at most ONE more, and only if it runs long enough that it would otherwise fall silent. Never a line per step.",
    "- Spend the lines you do write on the FEATURE being exercised: what the person changes in the product, and what a viewer can SEE change on screen because of it (a menu opening, a column disappearing, a total updating, a message appearing).",
    '- Narrate the USER-FACING story: what a person is doing and what they see happen — the goal, the screen, the result. NEVER narrate the automation mechanics. The "does:" note is the under-the-hood script, given ONLY so you understand the step; never mention selectors, DOM nodes, ts-control / Select2 / TomSelect, clicks, typing, snapshots, waits, or how an element was located.',
    "- Keep each narrated line SHORT and PUNCHY — ideally ONE sentence, never more than two, and at most ~18 words / ~95 characters so it fits two on-screen caption lines and reads aloud within the step's brief window. A longer line is truncated on screen. Favor brevity over flourish.",
    "- Stay in character for the creative direction throughout; commit to the bit.",
    "- Never repeat the literal step name.",
    '- A step may carry an "intent:" note — the operator\'s own caption for that moment, the clearest signal of WHY it matters. Prefer it as your guide, but rewrite it fully in character; never quote it verbatim.',
    "- If the direction calls for a verse form (poem/limerick/haiku/song), write the narrated lines in that form.",
    '- Provide a punchy, dramatic, mostly-uppercase "title" for an opening title card. You may use a newline in the title to force a two-line layout.',
    "",
    'Respond with STRICT JSON only — no prose, no markdown fences — exactly: {"title": string, "steps": [{"index": number, "narration": string}]}. Include every step index in order; give any step you choose not to voice an empty "narration".',
  ].join("\n");
}

// Build the `claude -p` prompt for SONG mode: themed, singable lyrics ABOUT the
// QA session (the comedic payoff — a checkout flow sung as a power ballad), ONE
// short line per step plus a title. The line count and per-line length are scaled
// to the video so the whole song fits (a short session got only its first line
// sung before — now the lyrics are sized to the runtime). Deterministic given its
// inputs (testable).
export function buildLyricsPrompt(args: {
  direction: string;
  change?: ChangeContext;
  steps: { index: number; name: string; script?: string }[];
  videoSeconds: number;
}): string {
  const { direction, change, steps, videoSeconds } = args;
  const stepCount = Math.max(1, steps.length);
  // Keep every line SHORT and singable — ACE-Step aligns syllables to beats, so a
  // ~6–10-syllable line (one breath) sings cleanly while a long line ("no
  // breathing room") comes out sparse or makes the model loop/hold notes (the
  // official ACE-Step lyric guidance, and the failure mode we saw with long
  // lines). Crucially, the line length does NOT scale with how long a section is
  // on screen: a long section just holds its frame longer; its lyric line stays
  // short. Range kept tight and uniform so successive lines share a rhythm.
  const wordsPerLine = 8;
  const stepLines = steps
    .map((step) => {
      const slice = step.script?.slice(0, SCRIPT_SLICE_CHARS).trim();
      const scriptPart = slice ? ` — does: ${slice}` : "";
      const captions = extractCaptions(step.script);
      const intentPart = captions.length
        ? ` — intent: ${captions.map((c) => `"${c}"`).join(" ")}`
        : "";
      return `  ${step.index}. ${step.name}${scriptPart}${intentPart}`;
    })
    .join("\n");

  const changeLines = change
    ? [
        `Sense of scale (use it only for energy/tone, never to override the genre): the change under review is ${change.label}, so ${change.scaleHint}.`,
        "",
      ]
    : [];

  return [
    "You are writing the lyrics for a short original SONG that scores a screen-recording of an automated browser QA session.",
    "The whole video is set to this one song — there is no spoken narration. Write lyrics that tell the story of the session, fully in character for the creative direction below.",
    "",
    `Creative direction (the song's genre, mood, and voice): ${direction}`,
    "",
    ...changeLines,
    `The video is about ${Math.round(videoSeconds)} seconds long. Write EXACTLY ONE singable lyric line for each section below — ${stepCount} line${stepCount === 1 ? "" : "s"} total, in order — so the song tells the whole story. A section may span a few moments of the session (its steps are joined with →); write one line that covers the whole section.`,
    "Each section (one line of the song lands on each):",
    stepLines,
    "",
    "Rules:",
    "- OPEN by naming what is being tested. The FIRST line must orient the listener: in one short, singable clause, the feature or behaviour this run exercises — in character, but unmistakable. Someone who hears only the opening line should know what the song is about.",
    `- Write exactly one line per section (${stepCount} total). Each line must be SHORT and singable — about 6–10 syllables, roughly ${wordsPerLine} words or fewer, sung comfortably in ONE breath. This matters: a long, wordy line comes out sparse or makes the singer stumble. Keep the lines' lengths similar so they share a rhythm.`,
    "- Do NOT make a line longer just because its section is long — a longer section simply lingers on screen; its line stays short.",
    '- Use plain, singable words with open vowels. AVOID proper nouns, product/UI names, technical jargon, acronyms, and abbreviations — the singer garbles them. Rephrase the idea in everyday language (e.g. not "the Super Admin approaches the file" but "she steps up to the case").',
    "- Write the words as they should be SUNG: no em-dashes, colons, semicolons, slashes, parentheses, or ellipses inside a line. A comma or nothing is fine; keep punctuation minimal.",
    "- Getting INTO the app is never the point: loading the first page, signing in, choosing a company or role, waiting and retrying. Exactly ONE line covers that whole stretch, and it is the opening line above — never a line each.",
    "- Spend the rest of the lines on the FEATURE being exercised: what the person changes in the product, and what a viewer can SEE change on screen because of it (a menu opening, a column disappearing, a total updating, a message appearing). That is what the film is about.",
    "- Each line is ABOUT its section (use its intent/what it does), but commit hard to the genre — be playful and vivid, never a dry play-by-play.",
    "- Together the lines should read as one coherent song with a through-line; rhyme or repetition across lines is welcome, but keep the one-line-per-section mapping.",
    "- Do NOT include section tags, chord names, timestamps, or stage directions — just the words to sing for each step.",
    '- Provide a punchy, dramatic, mostly-uppercase "title" for an opening title card. You may use a newline in the title to force a two-line layout.',
    "",
    'Respond with STRICT JSON only — no prose, no markdown fences — exactly: {"title": string, "steps": [{"index": number, "lyric": string}]}',
  ].join("\n");
}

const STYLE_DIRECTIVES: Record<StyleId, string> = {
  prose: "natural prose narration.",
  poem: "write the narration as short free-verse poetry.",
  limerick: "write the narration as limericks (AABBA).",
  haiku: "write the narration as haiku (5-7-5 syllables).",
  song_verse: "write the narration as sung verse, like song lyrics.",
};

// Parse the LLM response into a validated Narration, or null on any problem.
// Strips ```json fences, JSON.parses, and checks the shape defensively so a
// malformed reply degrades to "skip" rather than throwing.
export function parseNarrationJson(raw: string): Narration | null {
  const parsed = tryParseJson(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== "string" || !Array.isArray(record.steps)) {
    return null;
  }
  const steps: NarrationStep[] = [];
  for (const entry of record.steps) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const stepRecord = entry as Record<string, unknown>;
    if (
      typeof stepRecord.index !== "number" ||
      typeof stepRecord.narration !== "string"
    ) {
      return null;
    }
    steps.push({
      index: stepRecord.index,
      // Strip `{...}` runs: burned into the SRT they'd be parsed by libass as
      // style-override tags (reposition/recolor/hide). The narration is prose,
      // never tags.
      narration: stripOverrideTags(stepRecord.narration),
    });
  }
  return { title: normalizeTitle(record.title), steps };
}

// Parse the SONG-mode LLM response into a validated Lyrics, or null on any
// problem. Same lenient JSON handling as parseNarrationJson (strips fences, falls
// back to brace extraction). Shape: {title, steps:[{index, lyric}]} — one sung
// line per step. Empty-text lines are dropped; null only if the whole reply is
// malformed or no usable line survives.
export function parseLyricsJson(raw: string): Lyrics | null {
  const parsed = tryParseJson(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.title !== "string" ||
    record.title.trim() === "" ||
    !Array.isArray(record.steps)
  ) {
    return null;
  }
  const lines: LyricLine[] = [];
  for (const entry of record.steps) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.index !== "number" || typeof e.lyric !== "string") {
      return null;
    }
    const text = e.lyric.trim();
    if (text) {
      lines.push({ index: e.index, text });
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return { title: normalizeTitle(record.title), lines };
}

// Resolve the creative direction: the user's verbatim --prompt wins; otherwise
// draw ONE or TWO random themes (per the request — a focused draw the LLM can
// commit to, then adapt to the change's scale) + a weighted style. Returns the
// text injected into the prompt, a short reproducibility label, and the dominant
// theme category (drives the title-card font/color).
//
// In SONG mode the theme stands in for "a random style" (its genre/mood drives
// the music) and the prose/poem/haiku style draw is skipped — the piece is always
// a sung song, so a "render it as a haiku" suffix would just confuse the lyricist
// and the music model.
export function resolveDirection(
  userPrompt: string | undefined,
  opts: { song?: boolean } = {}
): {
  text: string;
  // The clean SUBJECT — the theme label(s) only, without the narration-style
  // directive ("Render it as natural prose narration.") OR the multi-theme blend
  // scaffolding ("commit to X as the dominant voice…"). The music and title-art
  // providers (incl. the Wikimedia keyword search) get this, so they key off the
  // actual themes rather than styling/blend words. Equals `text` for a --prompt
  // (the user's own words are the subject).
  theme: string;
  label: string;
  category?: ThemeCategory;
} {
  if (userPrompt?.trim()) {
    const text = userPrompt.trim();
    return { text, theme: text, label: `prompt: "${text}"` };
  }
  const count = Math.random() < 0.5 ? 1 : 2;
  const drawn = selectThemes(count);
  const themes = drawn.map((theme) => theme.label);
  // `subject` is the clean theme label(s) — what the score and the title imagery
  // (incl. the Wikimedia keyword search) should key off. The blend scaffolding
  // ("commit to X as the dominant voice…") is GUIDANCE for the narration/lyrics
  // LLM only; leaving it in `theme` made an image search hunt for "commit" /
  // "dominant" instead of the actual themes.
  const subject = themes.filter(Boolean).join(", ");
  const blend =
    themes.length === 1
      ? (themes[0] ?? "")
      : `commit to "${themes[0]}" as the dominant voice, optionally borrowing a flourish from "${themes[1]}"`;
  if (opts.song) {
    return {
      text: blend,
      theme: subject,
      label: `theme: ${themes.join(" + ")} · song`,
      category: drawn[0]?.category,
    };
  }
  const style = selectStyle();
  const text = `${blend}. Render it as ${STYLE_DIRECTIVES[style]}`;
  return {
    text,
    theme: subject,
    label: `theme: ${themes.join(" + ")} · style: ${style}`,
    category: drawn[0]?.category,
  };
}

// The branch's review base — its configured upstream (what it'll merge back
// into), NOT a hardcoded "main". Falls back to origin's default branch, then
// "main". Used for both the change-scale cue and the contributor credits so they
// count only this branch's own commits.
export async function resolveBase(repoDir: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        repoDir,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ],
      VERSION_PROBE_TIMEOUT_MS
    );
    const upstream = stdout.trim();
    if (upstream) {
      return upstream;
    }
  } catch {
    // no configured upstream — fall through
  }
  try {
    const { stdout } = await run(
      "git",
      ["-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      VERSION_PROBE_TIMEOUT_MS
    );
    const def = stdout.trim();
    if (def) {
      return def;
    }
  } catch {
    // no origin/HEAD — fall through
  }
  return "main";
}

// Describe the change under review (branch vs base) so the narration can scale
// its production to match — a sweeping feature film for a big branch, a 30-second
// trailer for a tiny prep change. Best-effort: returns null off a git repo / with
// no diff, and the narration simply omits the scale cue.
export async function describeChange(
  repoDir: string,
  base: string
): Promise<ChangeContext | null> {
  try {
    const { stdout: countOut } = await run(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${base}..HEAD`],
      VERSION_PROBE_TIMEOUT_MS
    );
    const commits = Number(countOut.trim());
    const { stdout: statOut } = await run(
      "git",
      ["-C", repoDir, "diff", "--shortstat", `${base}...HEAD`],
      VERSION_PROBE_TIMEOUT_MS
    );
    const files = Number(statOut.match(/(\d+) files? changed/)?.[1] ?? 0);
    const ins = Number(statOut.match(/(\d+) insertions?/)?.[1] ?? 0);
    const del = Number(statOut.match(/(\d+) deletions?/)?.[1] ?? 0);
    if (!(Number.isFinite(commits) && commits > 0) && files === 0) {
      return null;
    }
    const churn = ins + del;
    const scaleHint = changeScaleHint(commits, churn);
    return {
      label: `${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}, +${ins}/-${del}`,
      scaleHint,
    };
  } catch {
    return null;
  }
}

// Map change size to a sense of LENGTH/ENERGY only — deliberately format-agnostic
// so it never fights the random theme (an "epic film" cue would clash with a game
// show or a cooking-show theme). The theme leads; this just sizes the piece.
// Pure → testable.
export function changeScaleHint(commits: number, churn: number): string {
  if (commits <= 1 && churn < 60) {
    return "very small — keep it short and punchy, a beat or two";
  }
  if (commits <= 3 && churn < 250) {
    return "small — short and snappy";
  }
  if (commits <= 10 && churn < 1000) {
    return "medium — room for a full little arc";
  }
  return "large — go expansive; give it weight and a few more beats";
}

// JSON Schemas passed to `claude --json-schema` to FORCE a conforming reply.
// They mirror what parseNarrationJson / parseLyricsJson validate (title + one
// entry per step/section); parse still runs afterward for the exact checks and
// narration sanitizing.
export const NARRATION_SCHEMA = {
  additionalProperties: false,
  properties: {
    steps: {
      items: {
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          narration: { type: "string" },
        },
        required: ["index", "narration"],
        type: "object",
      },
      type: "array",
    },
    title: { type: "string" },
  },
  required: ["title", "steps"],
  type: "object",
};

export const LYRICS_SCHEMA = {
  additionalProperties: false,
  properties: {
    steps: {
      items: {
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          lyric: { type: "string" },
        },
        required: ["index", "lyric"],
        type: "object",
      },
      type: "array",
    },
    title: { type: "string" },
  },
  required: ["title", "steps"],
  type: "object",
};

// Pull the schema-forced object out of the `--output-format json` envelope. The
// CLI emits a wrapper whose `structured_output` is the already-validated object
// (from the forced tool call) and whose `result` is the same as a JSON string —
// prefer the former, fall back to parsing the latter, then to treating stdout as
// the bare object (older CLI). Returns undefined on an errored/empty envelope.

// Generate an object matching `schema` through whichever text provider is
// configured — the `claude` CLI by default, an OpenAI-compatible endpoint, or
// Apple Intelligence on-device (see ../llm). Returns the value, or a
// human-readable REASON the caller surfaces instead of a bare "generation
// failed": every provider that declined and why.
//
// Named for its callers rather than its backend now; the CLI is one provider
// among three.
export async function runLlmJson<T>(args: {
  echo?: Echo;
  label: string;
  log: Logger;
  parse: (raw: string) => T | null;
  prompt: string;
  schema: unknown;
}): Promise<{ value: T; writer: string } | { error: string }> {
  const result = await generateJson<T>({ ...args, timeoutMs: LLM_TIMEOUT_MS });
  if ("error" in result) {
    return { error: result.error };
  }
  // Who actually wrote the words, for the end credits — the provider that
  // produced the value, not an assumed default.
  return {
    value: result.value,
    writer: writerCredit(result.provider, result.model),
  };
}
