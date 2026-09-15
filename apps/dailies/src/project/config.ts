// The `.dailies/` project convention.
//
// A repo that Dailies drives can commit what Dailies needs to know about it:
//
//   .dailies/flows.md     app-specific knowledge for driving THIS app — how to
//                         sign in, which routes matter, the selectors that break
//                         naive Playwright. Dailies never parses it; the agent
//                         reads it before writing step scripts (see the
//                         `dailies-session` skill).
//   .dailies/config.json  machine-readable defaults for Dailies itself: the
//                         target URL, and which changed paths are worth demoing.
//
// Both are optional — Dailies works with neither. This lives in the repo under
// test rather than in an agent skill so it travels with the app, versions with
// it, and works for any harness (Claude Code, Codex, Cursor) rather than only
// the one whose skill format it was written in.
//
// TRUST: `flows.md` becomes agent instructions, so it is only as trustworthy as
// the repo it came from. Don't run Dailies with a project config from a repo you
// don't control (the demo workflow deliberately skips fork PRs).

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECT_DIR = ".dailies";
export const FLOWS_FILE = "flows.md";
export const CONFIG_FILE = "config.json";

// A flows file is a context budget: the agent reads it in full, every session.
// Past this it has almost certainly accumulated generic Playwright lessons (which
// belong in the `dailies-scripting` skill) or stale notes nobody pruned, so
// `session start` says so rather than letting it grow unbounded.
export const FLOWS_LINE_BUDGET = 250;

// How to decide whether a change is worth demoing.
//   agent   an LLM reads the diff, the PR, and the hints below and decides.
//           The default, because a path list can't see that a background job
//           changes what a user eventually sees in the app.
//   paths   match `paths` only — deterministic, no model call.
//   always  demo every change.
export type DecideMode = "agent" | "always" | "paths";

export interface DemoConfig {
  // Produce the cinematic cut by default.
  cinematic: boolean;
  decide: DecideMode;
  // Free-text steer for the agent decision: what this app considers
  // demo-worthy, which flows matter, what to ignore.
  hint: string | null;
  // Glob patterns marking changes worth demoing. Under `agent` these are a
  // HINT, not a gate — and the fallback when no LLM provider is available.
  // Empty = every change qualifies.
  paths: string[];
  // Default cinematic direction (theme/tone/style). Leave it UNSET in most
  // repos: unset draws a fresh random theme per run from 300+ of them, which is
  // deliberate — a nightly demo of a PR is repetitive work, and the randomness
  // is what makes it worth opening. Set it only for a consistent house style.
  prompt: string | null;
  // Where to find a per-PR target that only exists once something is deployed.
  // Many setups post the review-app URL as a bot comment when the deploy
  // succeeds, so it is knowable per PR but not from config or the PR body.
  //
  // TRUST: a comment is written by a person, not by the repo. Only comments
  // carrying `marker` are considered, the extracted value must be an https URL,
  // and fork PRs are already excluded before this runs. On a PUBLIC repo,
  // anyone who can comment can forge a marker — do not enable it there without
  // also restricting by comment author.
  targetComment: TargetCommentConfig | null;
}

export interface TargetCommentConfig {
  // Substring identifying the deploy comment — ideally the bot's own HTML
  // marker, e.g. "review-app-deploy::pr-commenter-buildkite-plugin". Null
  // considers every comment, which is looser than you usually want.
  marker: string | null;
  // Regex (as a string) matching the URL inside that comment. The first match
  // in the most recent matching comment wins.
  pattern: string;
}

export interface ProjectConfig {
  demo: DemoConfig;
  // Default target the demo/session drives.
  url: string | null;
}

export const EMPTY_CONFIG: ProjectConfig = {
  demo: {
    cinematic: true,
    decide: "agent",
    hint: null,
    paths: [],
    prompt: null,
    targetComment: null,
  },
  url: null,
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDecideMode(value: unknown): DecideMode {
  return value === "paths" || value === "always" || value === "agent"
    ? value
    : "agent";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

// Parse a `.dailies/config.json` payload. Tolerant by design: an unknown or
// malformed key falls back to the default rather than failing a whole run over a
// config typo. Pure → unit-tested.
export function parseProjectConfig(raw: unknown): ProjectConfig {
  const root = (raw ?? {}) as Record<string, unknown>;
  const demo = (root.demo ?? {}) as Record<string, unknown>;
  return {
    demo: {
      cinematic: demo.cinematic === undefined ? true : demo.cinematic !== false,
      decide: parseDecideMode(demo.decide),
      hint: stringOrNull(demo.hint),
      paths: stringArray(demo.paths),
      prompt: stringOrNull(demo.prompt),
      targetComment: parseTargetComment(demo.targetComment),
    },
    url: stringOrNull(root.url),
  };
}

// A `targetComment` is only usable with a pattern, and an invalid regex is a
// config typo — both fall back to null rather than failing the run, matching
// how the rest of this parser treats malformed keys.
function parseTargetComment(value: unknown): TargetCommentConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const pattern = stringOrNull(raw.pattern);
  if (!pattern) {
    return null;
  }
  try {
    new RegExp(pattern);
  } catch {
    return null;
  }
  return { marker: stringOrNull(raw.marker), pattern };
}

// Translate one glob to a regex. Supports `**` (any depth, including none),
// `*` (anything but a path separator) and a trailing `/` meaning "this
// directory and everything under it". Everything else is literal.
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "");
  const withDirSuffix = normalized.endsWith("/")
    ? `${normalized}**`
    : normalized;
  const chars = [...withDirSuffix];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? "";
    if (char !== "*") {
      out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (chars[i + 1] !== "*") {
      out += "[^/]*";
      continue;
    }
    // `**/` should also match zero segments, so `app/**/x.rb` matches `app/x.rb`.
    if (chars[i + 2] === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else {
      out += ".*";
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export interface DemoVerdict {
  // Why, in one line, suitable for a workflow log or a PR comment.
  reason: string;
  worth: boolean;
}

// Decide whether a change is worth demoing. With no configured patterns every
// change qualifies, so the demo workflow is useful before anyone writes a config;
// a repo narrows it by listing the paths that actually affect what a user sees.
// Pure → unit-tested.
export function isWorthDemoing(
  changedPaths: string[],
  patterns: string[]
): DemoVerdict {
  const changed = changedPaths.filter((p) => p.trim() !== "");
  if (changed.length === 0) {
    return { reason: "no files changed", worth: false };
  }
  if (patterns.length === 0) {
    return {
      reason: `${changed.length} file(s) changed and no demo.paths configured — demoing anything`,
      worth: true,
    };
  }
  const matchers = patterns.map(globToRegExp);
  const hits = changed.filter((p) =>
    matchers.some((re) => re.test(p.replace(/^\.\//, "")))
  );
  if (hits.length === 0) {
    return {
      reason: `none of ${changed.length} changed file(s) match demo.paths`,
      worth: false,
    };
  }
  const shown = hits.slice(0, 3).join(", ");
  return {
    reason: `${hits.length} user-facing file(s) changed (${shown}${hits.length > 3 ? ", …" : ""})`,
    worth: true,
  };
}

export interface LoadedProject {
  config: ProjectConfig;
  // Line count of flows.md, for the budget warning.
  flowsLines: number;
  // Absolute path to flows.md, when the repo has one.
  flowsPath: string | null;
  // Absolute path to the `.dailies` directory, when one was found.
  root: string | null;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

// Find the nearest `.dailies/` directory at or above `from`, stopping at the
// filesystem root. Walking up means a session started in a subdirectory of the
// app still finds the repo's config.
export async function findProjectDir(from: string): Promise<string | null> {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, PROJECT_DIR);
    if (await isDirectory(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// Load the project convention for `cwd`. Never throws: a missing directory,
// unreadable file or malformed JSON yields defaults, because a bad project config
// must not be able to stop someone recording a session.
export async function loadProject(cwd: string): Promise<LoadedProject> {
  const root = await findProjectDir(cwd);
  if (!root) {
    return { config: EMPTY_CONFIG, flowsLines: 0, flowsPath: null, root: null };
  }
  let config = EMPTY_CONFIG;
  try {
    const raw = await readFile(path.join(root, CONFIG_FILE), "utf8");
    config = parseProjectConfig(JSON.parse(raw));
  } catch {
    // No config.json, or it isn't valid JSON — defaults stand.
  }
  const flowsPath = path.join(root, FLOWS_FILE);
  let flowsLines = 0;
  try {
    flowsLines = (await readFile(flowsPath, "utf8")).split(/\r?\n/).length;
  } catch {
    return { config, flowsLines: 0, flowsPath: null, root };
  }
  return { config, flowsLines, flowsPath, root };
}
