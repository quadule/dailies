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
// A running app can also SERVE these two files outside production, which is what
// makes Dailies usable by someone with no checkout — see `fetchProject` below.
//
// TRUST: `flows.md` becomes agent instructions, so it is only as trustworthy as
// the repo it came from. Don't run Dailies with a project config from a repo you
// don't control (the demo workflow deliberately skips fork PRs).

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
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

// How a demo is finished.
//   plain      the recording as captured — no narration, no title card.
//   cinematic  spoken narration, a title card, burned captions.
//   song       one sung song scored over the whole cut, instead of narration.
export type DemoMode = "plain" | "cinematic" | "song";

export interface DemoConfig {
  decide: DecideMode;
  // Free-text steer for the agent decision: what this app considers
  // demo-worthy, which flows matter, what to ignore.
  hint: string | null;
  // How to finish the cut. NULL — the default — means the agent picks between
  // `cinematic` and `song` from the change itself, which is what makes a
  // nightly demo worth opening. Set it to pin every run to one mode.
  mode: DemoMode | null;
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
    decide: "agent",
    mode: null,
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

// An unset or unrecognized mode means "let the agent choose" rather than a
// hardcoded default, so a config typo doesn't silently pin every demo to plain.
function parseDemoMode(value: unknown): DemoMode | null {
  return value === "plain" || value === "cinematic" || value === "song"
    ? value
    : null;
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
      decide: parseDecideMode(demo.decide),
      hint: stringOrNull(demo.hint),
      mode: parseDemoMode(demo.mode),
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
  // Where this came from: a checkout, an app that serves it, or nowhere. Worth
  // saying out loud — "the agent has app knowledge" and "the agent has app
  // knowledge THIS ENVIRONMENT handed us" are different claims.
  source: ProjectSource;
}

export type ProjectSource = "local" | "remote" | "none";

const NO_PROJECT: LoadedProject = {
  config: EMPTY_CONFIG,
  flowsLines: 0,
  flowsPath: null,
  root: null,
  source: "none",
};

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

// ---------------------------------------------------------------------------
// `.dailies/` served by the app itself.
// ---------------------------------------------------------------------------

// Outside production, an app can serve its own `.dailies/` over HTTP — a route gated to
// non-production environments, serving those two files and nothing else. That is what
// lets someone with NO checkout record against staging or a review app: the thing that
// stops non-engineers recording their own flows is not installing Dailies, it is that
// Dailies then knows nothing about the app.
//
// TRUST, and why this is not simply "fetch from the target": `flows.md` becomes agent
// instructions the moment a session starts. So a URL is only ever fetched when the
// PERSON named it (`--project-url`, `$DAILIES_PROJECT_URL`) — never one lifted from a
// PR body, a redirect, or the page under test. Redirects are refused rather than
// followed for the same reason: the host someone approved must be the host that answers.
export const REMOTE_TIMEOUT_MS = 10_000;
// flows.md lives under a 250-line budget and config.json is a handful of keys, so this
// is far past any honest version of either — it exists so a misconfigured URL streams a
// video into the cache instead of the cache swallowing it.
export const REMOTE_MAX_BYTES = 512 * 1024;

// Cache root for a fetched project. The agent READS flows.md, so a fetch has to land on
// disk somewhere stable and outside the session, not in memory.
export function remoteCacheDir(
  url: string,
  home: string = os.homedir()
): string {
  const slug = url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^a-zA-Z0-9.-]+/g, "-");
  return path.join(home, ".dailies", "environments", slug.replace(/-+$/, ""));
}

async function fetchProjectFile(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > REMOTE_MAX_BYTES) {
      return null;
    }
    const body = await response.text();
    return Buffer.byteLength(body, "utf8") > REMOTE_MAX_BYTES ? null : body;
  } catch {
    // Unreachable, redirected, timed out, TLS refused — the caller falls back to
    // running with no app knowledge, which is worse but never fatal.
    return null;
  }
}

// Fetch `<base>/.dailies/{config.json,flows.md}` into `cacheDir` and load it. Never
// throws, for the same reason `loadProject` doesn't: not knowing the app must not stop
// someone recording. Returns source "none" when the environment served neither file.
export async function fetchProject(
  baseUrl: string,
  cacheDir: string = remoteCacheDir(baseUrl)
): Promise<LoadedProject> {
  let base: URL;
  try {
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return NO_PROJECT;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return NO_PROJECT;
  }

  const [rawConfig, rawFlows] = await Promise.all([
    fetchProjectFile(new URL(`${PROJECT_DIR}/${CONFIG_FILE}`, base).href),
    fetchProjectFile(new URL(`${PROJECT_DIR}/${FLOWS_FILE}`, base).href),
  ]);
  if (rawConfig === null && rawFlows === null) {
    return NO_PROJECT;
  }

  const root = path.join(cacheDir, PROJECT_DIR);
  try {
    await mkdir(root, { recursive: true });
  } catch {
    return NO_PROJECT;
  }

  let config = EMPTY_CONFIG;
  if (rawConfig !== null) {
    try {
      config = parseProjectConfig(JSON.parse(rawConfig));
      await writeFile(path.join(root, CONFIG_FILE), rawConfig, "utf8");
    } catch {
      // Served but not valid JSON — defaults stand, exactly as for a local file.
    }
  }
  // An environment that serves `.dailies/` knows its own address better than the person
  // typing it, but it does NOT get to redirect the run somewhere else: the URL that
  // answered is the URL we drive.
  config = { ...config, url: base.href.replace(/\/$/, "") };

  if (rawFlows === null) {
    return { config, flowsLines: 0, flowsPath: null, root, source: "remote" };
  }
  const flowsPath = path.join(root, FLOWS_FILE);
  try {
    await writeFile(flowsPath, rawFlows, "utf8");
  } catch {
    return { config, flowsLines: 0, flowsPath: null, root, source: "remote" };
  }
  return {
    config,
    flowsLines: rawFlows.split(/\r?\n/).length,
    flowsPath,
    root,
    source: "remote",
  };
}

// Load the project convention for `cwd`. Never throws: a missing directory,
// unreadable file or malformed JSON yields defaults, because a bad project config
// must not be able to stop someone recording a session.
//
// A checkout always wins over a served copy: if you are standing in the repo, the repo
// is the truth — and a `flows.md` you are editing must be the one the agent reads.
// `url` is only consulted when there is no `.dailies/` to be found.
export async function loadProject(
  cwd: string,
  options: { cacheDir?: string; url?: string | null } = {}
): Promise<LoadedProject> {
  const root = await findProjectDir(cwd);
  if (!root) {
    return options.url
      ? await fetchProject(
          options.url,
          options.cacheDir ?? remoteCacheDir(options.url)
        )
      : NO_PROJECT;
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
    return { config, flowsLines: 0, flowsPath: null, root, source: "local" };
  }
  return { config, flowsLines, flowsPath, root, source: "local" };
}
