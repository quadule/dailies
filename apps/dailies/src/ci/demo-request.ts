// Decide whether — and how — to record a demo for a pull request, for the
// nightly demo workflow (.github/workflows/dailies-demo.yml).
//
// Two layers, so a repo configures once and a PR only says what's different:
//
//   .dailies/config.json   repo defaults — the target url, which changed paths
//                          are worth demoing, the default cinematic direction
//   the PR body            per-PR overrides (below)
//
// PR-body conventions (case-insensitive, value runs to end of line):
//   dailies-url: / dailies-target: / Demo URL: / Demo target:   → the app to drive
//   dailies-theme: / dailies-prompt: / Theme:                   → cinematic direction
//   "plain demo" / "no cinematic" / "plain video" / "no narration" → force plain
//   "as a song" / "sing it" / "musical" / dailies-song             → force song
// Target precedence, highest first:
//   1. an explicit `dailies-url:` marker in the PR body
//   2. a deploy comment matching `demo.targetComment` — for review apps, whose
//      URL only exists once a deploy succeeds and is posted by a bot
//   3. the repo default (`url` in .dailies/config.json)
//   4. the first standalone http(s) URL in the body
// (4) is a convenience for repos with no config at all; it must not outrank one,
// because a real PR description opens with a ticket link, and scavenging that
// would point the run at the tracker instead of the app. It is DROPPED entirely
// when `demo.targetComment` is set: an unmatched targetComment means the deploy
// hasn't posted a URL (pending or failed), and (4) would then drive the ticket.
//
// Kept as pure, unit-tested functions with a thin JSON CLI — bash `grep` in a
// YAML `run:` block is where this kind of logic rots.

import { createLogger } from "dailies-logger";
import { generateJson } from "../llm/index.js";
import { tryParseJson } from "../llm/json.js";
import {
  type DemoMode,
  type DemoVerdict,
  isWorthDemoing,
  loadProject,
  type ProjectConfig,
  type TargetCommentConfig,
} from "../project/config.js";
import { deserializeMetrics, type Metric } from "../session/metrics.js";
import { readComments, readTextInput } from "./inputs.js";

// The commit each existing demo comment was recorded at, newest last.
//
// The workflow stamps `<!-- dailies-demo: <sha> -->` into its own PR comment so a
// later run can tell whether the PR has moved since its last demo. An HTML
// comment keeps it invisible in the rendered comment, and reading it back needs
// no state outside the PR itself.
// Matches both marker forms: the original sha-only one and the current
// `<sha> name=value …`, so a PR whose history predates metrics still parses.
const MARKER_RE = /<!--\s*dailies-demo:\s*([0-9a-f]{7,40})([^>]*?)-->/i;

export function demoedShas(comments: string[]): string[] {
  return comments
    .map((c) => c.match(MARKER_RE)?.[1])
    .filter((sha): sha is string => Boolean(sha));
}

// The metrics recorded by the most recent demo comment, for comparison against
// this run. Newest wins: comments arrive oldest-first from `gh`. Pure →
// unit-tested.
export function previousMetrics(comments: string[]): Metric[] {
  for (const comment of [...comments].reverse()) {
    const match = comment.match(MARKER_RE);
    if (match?.[2]) {
      const metrics = deserializeMetrics(match[2]);
      if (metrics.length > 0) {
        return metrics;
      }
    }
  }
  return [];
}

// Whether this PR head has already been demoed. Compared by prefix so a short
// sha in a comment still matches the full head sha (and vice versa). Pure →
// unit-tested.
export function isAlreadyDemoed(headSha: string, comments: string[]): boolean {
  const head = headSha.trim().toLowerCase();
  if (!head) {
    return false;
  }
  return demoedShas(comments).some((sha) => {
    const s = sha.toLowerCase();
    return head.startsWith(s) || s.startsWith(head);
  });
}

export const DECISION_SCHEMA = {
  additionalProperties: false,
  properties: {
    flow: {
      description:
        "The single user-facing flow to demo, in one sentence an operator could follow. Empty when not worth demoing.",
      type: "string",
    },
    mode: {
      description:
        'How to finish the cut. "cinematic" — spoken narration over the run, the default and right for most changes. "song" — one sung song instead of narration; pick it for a light or celebratory change, or a flow with little to explain, where a sung cut is more watchable than commentary. "plain" — no narration at all; pick it only when narration would obscure the change, e.g. a demo that is itself about audio or timing.',
      enum: ["plain", "cinematic", "song"],
      type: "string",
    },
    reason: {
      description: "One short sentence explaining the verdict.",
      type: "string",
    },
    worth: {
      description: "true when this change is worth recording a demo of",
      type: "boolean",
    },
  },
  required: ["worth", "reason"],
  type: "object",
} as const;

export interface DemoDecisionFromAgent {
  flow: string | null;
  // The mode the model picked, or null when it didn't answer or the repo
  // pinned one (then it is never asked).
  mode: DemoMode | null;
  reason: string;
  worth: boolean;
}

// Ask the model to judge demo-worthiness from the change itself, not a path
// list. Deliberately tells it that a non-UI change CAN be worth demoing by its
// visible effect — that case (a data migration, a background job) is the whole
// reason this isn't a glob match. Pure → unit-tested.
export function buildDecisionPrompt(args: {
  body: string;
  changedPaths: string[];
  hint: string | null;
  paths: string[];
}): string {
  const { body, changedPaths, hint, paths } = args;
  const shown = changedPaths.slice(0, 60);
  const more =
    changedPaths.length > shown.length
      ? `\n…and ${changedPaths.length - shown.length} more files`
      : "";
  return [
    "You decide whether a pull request is worth recording a short browser demo of.",
    "",
    "The test is not whether a person COULD see the change — it is whether WATCHING it would",
    "tell someone something the diff does not already. A recording costs real time and money,",
    "so it earns its place only when behavior has to be exercised to be believed.",
    "",
    "Work through these in order.",
    "",
    "STEP 1 — exclusions. If ANY of these describes the change, answer worth=false and stop.",
    "They override every reason to say yes below, including a change being user-visible:",
    "  a. Only displayed text changes — copy edits, labels, wording, translations, help text,",
    "     error messages. The diff already shows the exact words a person will read, so a video",
    "     adds nothing. This is true even on the most customer-facing screen in the product.",
    "  b. No behavior change at all — refactors, renames, extractions, tests, CI config,",
    "     dependency bumps, comments, developer tooling.",
    "  c. A minor style tweak — a spacing nudge, one color, a single margin.",
    "",
    "STEP 2 — otherwise, is there behavior a person has to exercise to believe? A form, a",
    "screen, a flow, a calculated value, a validation message. This includes changes with NO UI",
    "code at all, when the effect surfaces somewhere a person visits: a data migration that",
    "fills in a blank field, a background job that advances a checklist, a calculation that",
    "alters an amount. A substantial visual change counts too, even a style-only one.",
    "",
    "When it is worth recording, name the ONE most important flow, as a single sentence an",
    "operator could follow. If the change sits behind a flag or a setting, say to enable it",
    "first — otherwise the recording shows the old behavior and proves nothing.",
    hint ? `\nWhat this project considers demo-worthy:\n${hint}` : "",
    paths.length > 0
      ? `\nPaths this project treats as user-facing (a hint, not a rule):\n${paths.join(", ")}`
      : "",
    "",
    "Pull request:",
    body.trim() || "(no description)",
    "",
    `Changed files (${changedPaths.length}):`,
    shown.join("\n") + more,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// Read the model's verdict. Returns null when the reply isn't usable, which
// makes the caller fall back to path matching. Pure → unit-tested.
export function parseDecision(raw: string): DemoDecisionFromAgent | null {
  const parsed = tryParseJson(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed.worth !== "boolean") {
    return null;
  }
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : "no reason given";
  // A flow only means something for a demo that will actually be recorded. The
  // model tends to fill the field in either way, and carrying "record this
  // flow" alongside "not worth recording" is just misleading downstream.
  const flow =
    parsed.worth && typeof parsed.flow === "string" && parsed.flow.trim()
      ? parsed.flow.trim()
      : null;
  // Same reasoning as `flow`: a mode is only meaningful for a demo that will be
  // recorded, and an unrecognized value falls back rather than failing the run.
  const mode =
    parsed.worth &&
    (parsed.mode === "plain" ||
      parsed.mode === "cinematic" ||
      parsed.mode === "song")
      ? parsed.mode
      : null;
  return { flow, mode, reason, worth: parsed.worth };
}

export interface DemoRequest {
  // The mode this PR body asked for, or null when it didn't say — then the
  // repo config, and failing that the agent, decides.
  mode: DemoMode | null;
  // Verbatim cinematic direction for `session end --prompt`, or null for a
  // random theme.
  prompt: string | null;
  // The running app to drive. Null → nothing to record against.
  target: string | null;
  // Whether `target` came from an explicit marker rather than being scavenged
  // out of the body's prose. Only a marked target may outrank the repo default.
  targetIsExplicit: boolean;
}

// `targetIsExplicit` is deliberately dropped: it is how the target was chosen,
// not part of the verdict, and this interface is the CLI's JSON output. `mode`
// is narrowed — the request's is nullable ("the body didn't say"), the
// decision's is always resolved.
export interface DemoDecision
  extends Omit<DemoRequest, "mode" | "targetIsExplicit"> {
  // How the verdict was reached, for the log: "agent", "paths", "always", or
  // "paths (agent unavailable)".
  decidedBy: string;
  // The flow the model suggests recording, when it named one. Handed to the
  // recording agent so it doesn't have to re-derive it from the diff.
  flow: string | null;
  mode: DemoMode;
  // One line explaining the decision, for the workflow log and the PR comment.
  reason: string;
  // Whether to actually record.
  run: boolean;
}

const TARGET_MARKERS = [
  "dailies-url",
  "dailies-target",
  "demo url",
  "demo target",
];
const THEME_MARKERS = ["dailies-theme", "dailies-prompt", "theme"];
const PLAIN_RE = /\b(plain demo|no cinematic|plain video|no narration)\b/i;
const SONG_RE = /\b(as a song|sing it|musical|dailies-song)\b/i;
// A demo target can be a remote URL, a file:// URL, or a local .html path (so a
// static HTML file checked into the repo works as a target too).
const URL_RE = /(?:https?|file):\/\/[^\s<>()[\]]+/i;
const HTML_PATH_RE = /[^\s<>()[\]]+\.html?(?=[\s)>.,;]|$)/i;
const TARGET_RE = new RegExp(`${URL_RE.source}|${HTML_PATH_RE.source}`, "i");

// A target is valid if it's an http(s)/file URL or a path to an .html/.htm file.
function isValidTarget(value: string): boolean {
  return /^(?:https?|file):\/\//i.test(value) || /\.html?$/i.test(value);
}

// Value of the first `marker: value` line (case-insensitive), trimmed, or null.
function markerValue(body: string, markers: string[]): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z][a-z0-9 _-]*?)\s*:\s*(.+?)\s*$/i);
    if (!(match?.[1] && match[2])) {
      continue;
    }
    if (markers.includes(match[1].trim().toLowerCase())) {
      return match[2].trim();
    }
  }
  return null;
}

// Strip wrapping <…> / trailing sentence punctuation a URL often picks up in prose.
function cleanUrl(url: string): string {
  return url.replace(/^[<(]+/, "").replace(/[>).,;]+$/, "");
}

// Pull a per-PR target out of the PR's comments — for setups where the app to
// drive only exists once a deploy succeeds and a bot posts its URL. Comments are
// searched NEWEST first, so a redeploy after a failed one wins.
//
// Only comments carrying the configured `marker` count, and the match must be an
// https URL: a comment is untrusted text, and this value becomes the URL a
// browser drives and an agent is told about. See the TRUST note on
// TargetCommentConfig. Pure → unit-tested.
export function targetFromComments(
  comments: string[],
  config: TargetCommentConfig | null
): string | null {
  if (!config) {
    return null;
  }
  const re = new RegExp(config.pattern);
  for (const body of [...comments].reverse()) {
    if (typeof body !== "string") {
      continue;
    }
    if (config.marker && !body.includes(config.marker)) {
      continue;
    }
    const found = body.match(re)?.[0];
    if (!found) {
      continue;
    }
    const url = cleanUrl(found);
    // https only — not http, not file://, not a repo-relative .html path. Those
    // are fine from trusted config; they are not fine from a comment.
    if (/^https:\/\/\S+$/i.test(url)) {
      return url;
    }
  }
  return null;
}

// The mode a PR body asked for, or null when it said nothing. Plain wins over
// song when a body somehow says both: "no narration" is the more emphatic
// instruction, and a song is narration.
function bodyMode(text: string): DemoMode | null {
  if (PLAIN_RE.test(text)) {
    return "plain";
  }
  return SONG_RE.test(text) ? "song" : null;
}

// Read just the per-PR overrides out of a body. Pure → unit-tested.
export function parseDemoRequest(body: string): DemoRequest {
  const text = body ?? "";
  const marked = markerValue(text, TARGET_MARKERS);
  const candidate = marked
    ? cleanUrl(marked)
    : (text.match(TARGET_RE)?.[0] ?? null);
  const target = candidate ? cleanUrl(candidate) : null;
  const valid = target && isValidTarget(target) ? target : null;
  return {
    mode: bodyMode(text),
    prompt: markerValue(text, THEME_MARKERS),
    target: valid,
    targetIsExplicit: valid !== null && marked !== null,
  };
}

// Combine repo defaults, the PR body, and the change set into one decision.
// The PR body wins over repo defaults for every field it specifies; the change
// set only ever decides whether to run at all. Pure → unit-tested.
export function decideDemo(args: {
  body: string;
  changedPaths: string[];
  // Existing PR comments — for the "already demoed this commit" check, and for
  // a deploy comment carrying this PR's target (see demo.targetComment).
  comments?: string[];
  config: ProjectConfig;
  // Re-demo this commit even though a demo comment already names it. Only the
  // freshness check is skipped — the comments still carry the deploy target and
  // the previous run's metrics, so they must NOT be blanked out to force a run.
  force?: boolean;
  // The PR head this run would demo.
  headSha?: string;
}): DemoDecision {
  const {
    body,
    changedPaths,
    comments = [],
    config,
    force = false,
    headSha = "",
  } = args;
  const override = parseDemoRequest(body);
  // An explicit `dailies-url:` beats everything; then a deploy comment, which is
  // the freshest per-PR fact (and the only one that knows the app is actually
  // up); then the repo default; and last a URL merely scavenged from the body's
  // prose. See the precedence note at the top of this file.
  //
  // That last resort is DROPPED when the repo declares a `demo.targetComment`:
  // there the app URL comes from a deploy bot, so an unmatched targetComment means
  // the deploy hasn't posted a URL yet or failed — and a stray link in the body (a
  // Linear/GitHub issue) is never the app. Falling through to it drove demos at
  // linear.app. Fail closed instead: no target → the run skips with a clear reason.
  const target = override.targetIsExplicit
    ? override.target
    : (targetFromComments(comments, config.demo.targetComment) ??
      config.url ??
      (config.demo.targetComment ? null : override.target));
  // The body wins, then a pinned repo mode. Null here means neither said, and
  // the agent path below chooses; the deterministic paths fall back to
  // `cinematic`, which is what a demo was before modes existed.
  const mode = override.mode ?? config.demo.mode;
  const prompt = override.prompt ?? config.demo.prompt;
  const worth: DemoVerdict =
    config.demo.decide === "always"
      ? {
          reason: `${changedPaths.filter((c) => c.trim()).length} file(s) changed and demo.decide is "always"`,
          worth: changedPaths.some((c) => c.trim() !== ""),
        }
      : isWorthDemoing(changedPaths, config.demo.paths);

  // Nothing new to show: this exact commit already has a demo. Checked before
  // the target, so a re-run of an already-demoed PR is quiet rather than
  // complaining about configuration.
  if (!force && isAlreadyDemoed(headSha, comments)) {
    return {
      decidedBy: "freshness",
      mode: mode ?? "cinematic",
      flow: null,
      prompt,
      reason: `already demoed at ${headSha.slice(0, 7)}`,
      run: false,
      target,
    };
  }

  if (!target) {
    return {
      decidedBy: "config",
      mode: mode ?? "cinematic",
      flow: null,
      prompt,
      reason: config.demo.targetComment
        ? "no demo target — no deploy comment matching demo.targetComment carries a URL yet (deploy pending or failed); not scavenging one from the PR body"
        : "no demo target — set `url` in .dailies/config.json or add `dailies-url: <url>` to the PR body",
      run: false,
      target: null,
    };
  }
  return {
    decidedBy: config.demo.decide === "always" ? "always" : "paths",
    mode: mode ?? "cinematic",
    flow: null,
    prompt,
    reason: worth.reason,
    run: worth.worth,
    target,
  };
}

// The full decision, including the agent path. Everything deterministic
// (freshness, target, "always") is settled by `decideDemo` first — an
// already-demoed or target-less PR must not cost a model call. Only then does
// the agent judge worthiness, and if no provider is available it falls back to
// path matching rather than demoing everything or nothing.
export async function decideDemoWithAgent(args: {
  body: string;
  changedPaths: string[];
  comments?: string[];
  config: ProjectConfig;
  force?: boolean;
  headSha?: string;
}): Promise<DemoDecision> {
  const base = decideDemo(args);
  if (args.config.demo.decide !== "agent") {
    return base;
  }
  // Not run: no target, or already demoed. Neither is the agent's call.
  if (base.decidedBy === "freshness" || base.decidedBy === "config") {
    return base;
  }
  const result = await generateJson<DemoDecisionFromAgent>({
    label: "demo decision",
    log: createLogger({ name: "dailies-demo" }),
    parse: parseDecision,
    prompt: buildDecisionPrompt({
      body: args.body,
      changedPaths: args.changedPaths.filter((c) => c.trim() !== ""),
      hint: args.config.demo.hint,
      paths: args.config.demo.paths,
    }),
    schema: DECISION_SCHEMA,
  });
  if ("error" in result) {
    return {
      ...base,
      decidedBy: "paths (agent unavailable)",
      reason: `${base.reason} — the agent decision was unavailable (${result.error})`,
    };
  }
  // Name the provider in the log line: which model judged is the first thing
  // you want to know when a verdict looks wrong.
  if (result.provider === "apple") {
    // Measured on the borderline cases (a copy-only edit, a 2px margin nudge),
    // 5 samples each: the on-device model got the copy edit right 4/5 and the
    // margin nudge 1/5, where the `claude` provider was 12/12 across the same
    // suite. It is a fine narrator — there is no wrong answer in narration —
    // but a weak gate. The resolve order already puts it last, so this only
    // happens when it is pinned or is the only provider available.
    createLogger({ name: "dailies-demo" }).warn(
      "the demo decision was made by Apple Intelligence on-device, which is unreliable on borderline changes — prefer the claude CLI or an OpenAI-compatible endpoint for this call"
    );
  }
  // The agent only gets to pick the mode when nothing more specific already
  // did. A `plain demo` in the PR body or a pinned `demo.mode` is an
  // instruction, not a suggestion — `base.mode` already carries it, and asking
  // the model to reconsider would let it override a human.
  const pinned = parseDemoRequest(args.body).mode ?? args.config.demo.mode;
  return {
    ...base,
    decidedBy: `agent (${result.provider}/${result.model})`,
    flow: result.value.flow,
    mode: pinned ?? result.value.mode ?? base.mode,
    reason: result.value.reason,
    run: result.value.worth,
  };
}

// Legacy direct entry: `tsx demo-request.ts --head-sha <sha> [--body-file <p>]
// [--changed-file <p>] [--comments-file <p>] [--cwd <dir>]` → JSON on stdout.
// The SUPPORTED entry is `dailies ci decide`, which takes the same flags through
// commander and works from the published binary with no source checkout; this
// one survives for running the decision straight out of a checkout.
//
// The bulky, arbitrary inputs come from FILES, not argv or env. PR bodies and
// comments can contain anything — newlines, quotes, NUL bytes — and a shell
// cannot carry that through `$(...)` (command substitution truncates at a NUL),
// while argv and env are both visible in the process table. `--comments-file`
// is a JSON array of comment bodies, exactly what `gh pr view --json comments`
// produces; `--changed-file` is one path per line, as `gh pr diff --name-only`
// produces.
//
// Exported for the unit test. Pure.
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag?.startsWith("--")) {
      continue;
    }
    // A boolean flag must not swallow the next one as its value: `--force
    // --head-sha abc` set force="--head-sha" and dropped the sha entirely, so
    // the run re-demoed a commit it had already demoed.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[flag.slice(2)] = "";
    } else {
      out[flag.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

// The decision as the CLI exposes it (`dailies ci decide`), reading the same
// file inputs the direct `tsx src/ci/demo-request.ts` invocation took. Exported
// so a pipeline outside this repo can reach it through the published binary
// instead of needing a source checkout.
export async function runDecide(args: {
  bodyFile?: string;
  changedFile?: string;
  commentsFile?: string;
  cwd?: string;
  force?: boolean;
  headSha?: string;
}): Promise<string> {
  const [body, changed, comments] = await Promise.all([
    readTextInput(args.bodyFile),
    readTextInput(args.changedFile),
    readComments(args.commentsFile),
  ]);
  const { config, configError } = await loadProject(args.cwd ?? process.cwd());
  const decision = await decideDemoWithAgent({
    body,
    changedPaths: changed.split(/\r?\n/),
    comments,
    config,
    force: args.force ?? false,
    headSha: args.headSha ?? "",
  });
  // A scheduled run has nobody watching stderr, and the decision's `reason` is
  // what reaches the workflow log and the PR comment. Say there that the repo's
  // config was ignored — otherwise "no demo target" reads as "you forgot to set
  // a url" for a repo that set one in a file with a stray comma in it.
  if (configError) {
    return JSON.stringify({
      ...decision,
      reason: `${configError}. ${decision.reason}`,
    });
  }
  return JSON.stringify(decision);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const json = await runDecide({
    bodyFile: args["body-file"],
    changedFile: args["changed-file"],
    commentsFile: args["comments-file"],
    cwd: args.cwd || undefined,
    force: args.force !== undefined,
    headSha: args["head-sha"],
  });
  process.stdout.write(`${json}\n`);
}

// Keep this source-only entry filename-specific: esbuild merges this module
// into cli.js, where import.meta.url is also the main CLI's URL.
if (process.argv[1]?.endsWith("demo-request.ts")) {
  await main();
}
