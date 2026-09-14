# Agent Orientation

This file is the entry point for AI agents (and humans new to the repo).

## What Dailies is

Dailies drives a real browser through a flow and produces **watchable proof it works**: a narrated,
captioned short of the run, plus the evidence underneath it (Playwright trace, video, network HAR,
console, a screenshot of every step) and a replayable Playwright script.

It began as a fork of [Canary](https://github.com/wizenheimer/canary), an agent QA harness, and
Canary's sandbox, session recording and report are still the foundation. The divergence is the
video pipeline (`apps/dailies/src/video/`, the largest subsystem here), the on-screen cursor and
human-like interaction helpers that make a recording read like a person, and the nightly PR demo
workflow. The QA evidence is still underneath — it is what makes the film trustworthy rather than a
marketing artifact.

The pieces:

1. **`dailies` (orchestrator CLI, `dailies-cli`)** — records capture-enabled QA sessions (trace/video/HAR/console) as a series of script steps and renders a self-contained report. The primary, user-facing CLI.
2. **`dailies-browser` (engine CLI, `dailies-browser`)** — one-off browser automation: persistent named pages, sandboxed JavaScript, headless or headed. Embeds and supervises the daemon.
3. **`dailies-daemon`** — a long-running Node process owning Playwright + a QuickJS sandbox. Embedded into the CLIs at build time. Speaks line-delimited JSON over a named pipe / Unix socket.

Both CLIs reach the browser the same way:

```
dailies run … --session …   /   dailies-browser run …   →   daemon RPC   →   Playwright
```

**Drive browsers only through these CLIs.** All browser work in this repo — navigating, clicking,
filling, scraping, viewing a recorded run — goes through the `dailies` / `dailies-browser` CLIs and
the scripts they run. Do not use Claude in Chrome, a computer-use tool, or any other browser
automation: they skip Dailies's sandbox, on-screen cursor, and trace/video/HAR/report capture, so
the run isn't recorded or verifiable.

## Apps + packages

| Workspace                | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/dailies`            | Session orchestrator CLI (`dailies`) — records QA sessions, renders reports. The primary CLI.    |
| `apps/dailies-browser`    | Browser-automation engine CLI (`dailies-browser`) — owns the daemon lifecycle, embeds the daemon |
| `apps/dailies-daemon`     | Internal Playwright host + QuickJS sandbox. Built standalone, embedded into the CLIs            |
| `packages/protocol`      | Zod IPC schemas. Single source of truth — daemon validates, CLIs infer types                    |
| `packages/config`        | Shared tsconfig bases (`base`, `node-app`)                                                       |
| `packages/logger`        | Shared pino-backed structured logger (source-distributed)                                       |
| `packages/cli-kit`       | Shared CLI helpers (request ids, formatting, logger factory)                                    |
| `packages/daemon-client` | Daemon transport + lifecycle + paths; embeds the daemon bundle for the CLIs                     |

## Build flow

`turbo run build` topo-sorts via `^build`:

1. `dailies-protocol` + `dailies-config` + `dailies-logger` (no build, source-distributed)
2. `dailies-daemon` builds → emits `dist/daemon.bundle.mjs` + `dist/sandbox-client.js`
3. `dailies-browser` + `dailies-cli` embed their assets (the daemon bundle via `dailies-daemon-client`), then bundle with esbuild

## Shared docs (skills + CLI help + README)

LLM-facing doc content that appears on more than one surface — the sandbox/scripting API and the
workflow rules — is single-sourced in `docs/snippets/` and stitched by `scripts/stitch-docs.mjs`:

- Edit the snippet, then run `make docs` (`--write`). CI fails on drift via `pnpm check` (`--check`).
- Never hand-edit `packages/cli-kit/src/snippets.generated.ts` or the content between
  `<!-- dailies:snippet … -->` markers in `skills/`, `agents/`, or `README.md`.
- `skills/` is the skill pack consumed verbatim by Claude Code (`.claude-plugin/`), Cursor
  (`.cursor-plugin/`), and Codex (`plugins/dailies/`, whose `skills` is a symlink here) — keep
  SKILL.md frontmatter (`name`, `description`) intact and marker-free.

## Attachments are the extension point

`session end --attach <file>` copies a file into the session's `attachments/`, which surfaces in
`results.json` and the report next to the trace and video. Implemented in
`apps/dailies/src/session/attach.ts`; the copy happens BEFORE the session-end RPC, deliberately —
both the daemon (`session-manager.ts`) and the on-disk fallback (`session/artifacts.ts`) build
their artifact list as the session ends, so a file copied afterwards is silently missing from the
report. That was a documented hazard every external tool had to work around; it is the command's
problem now.

This is how anything Dailies doesn't produce gets into a report: a coverage report, a Lighthouse
score, an accessibility audit, a database diff. **Resist adding features for those.** Coverage in
particular is language- and framework-specific and belongs in the app's own repo (a script plus a
skill beside `.dailies/flows.md`); the README documents the generic recipe. If you find yourself
adding a `--coverage` flag here, that is the line.

## A project goal: the randomness is a feature

Reviewing pull requests is repetitive, and a demo nobody chose to watch has to earn attention. So
omitting `--prompt` draws 1-2 random themes plus a weighted style from the 300+ in
`apps/dailies/src/video/themes.ts`, and that is the intended default — including, especially, in CI.

Do not "helpfully" pin a static `demo.prompt` in a repo's config, or replace the random draw with a
fixed tone to make output more predictable. A consistent house style is an opt-in, not a default.
Repeatability for a *specific* run is already covered: the drawn direction is printed with every
run, so any cut can be reproduced by passing it back as `--prompt`.

## The `.dailies/` project convention

A repo that Dailies drives can commit what Dailies needs to know about it. Implemented in
`apps/dailies/src/project/config.ts`:

- `.dailies/flows.md` — app-specific knowledge for driving that app. Dailies never parses it; the
  **agent** reads it, because the `dailies-session` / `dailies-scripting` skills tell it to (see
  `docs/snippets/rule-project-flows.md`). That instruction is why this is a plain file rather than
  a per-app skill: skill loading depends on the model matching a `description`, and it only works
  in one harness. `session start` reports the file and warns past `FLOWS_LINE_BUDGET`.
- `.dailies/config.json` — machine-readable defaults (`url`, `demo.paths`, `demo.prompt`) consumed
  by `apps/dailies/src/ci/demo-request.ts`, which merges them with per-PR overrides from the PR body.

Both are optional and both fail open: a missing or malformed file yields defaults rather than
failing a run. `flows.md` becomes agent instructions, so treat it as untrusted when it comes from a
repo you don't control.

## Text generation (`apps/dailies/src/llm/`)

Every LLM call in the project goes through `generateJson` — narration, lyrics, and the nightly demo
decision. One contract: return an object matching a JSON schema.

- Providers live in `llm/providers/`: `claude-cli` (default, no key), `openai-compat` (any
  `/v1/chat/completions`), `apple` (on-device Foundation Models via a Swift helper shipped as
  source in `apple-source.ts` and compiled into `~/.dailies/bin`, keyed by source hash).
- `$DAILIES_LLM` pins one provider and disables fallthrough. Otherwise availability is probed and
  failures fall through to the next.
- **`generateJson` never throws.** It returns `{provider, value}` or `{error}`, where the error
  names every provider that declined and why — the cinematic pass surfaces that string in its run
  notes, so a swallowed reason is a regression.
- Tolerant JSON reading (`llm/json.ts`) is shared, not per-provider: the CLI can wrap its reply in
  prose, an OpenAI endpoint returns clean JSON, Apple returns a serialized `GeneratedContent`.
- Tests inject fake providers via `generateJson`'s `providers` argument — the suite must never make
  a real model call.
- **Providers are not interchangeable across roles.** Narration has no wrong answer, so the
  on-device Apple provider is a good narrator. The demo decision is a gate, and measured on the
  borderline cases (a copy-only edit, a 2px margin nudge, 5 samples each) it got 5/10 where the
  `claude` CLI got 12/12 across the same suite. The resolve order puts Apple last for this reason,
  and `decideDemoWithAgent` warns when it was the decider. Don't reorder that without re-measuring.

## Artifact sensitivity

A recorded session runs against a logged-in app, so its artifacts are not uniformly shareable:

- `report.html` and `results.json` are the shareable ones — no request headers in them.
- `network.har` has `Cookie` / `set-cookie` / `Authorization` **values** replaced at `session end`
  (see `apps/dailies/src/session/scrub-har.ts`; `--no-scrub-har` opts out). Response bodies are
  **not** scrubbed.
- `trace.zip` carries the same traffic unscrubbed, and `profile/` is a real Chrome cookie database.

So: attach or link `report.html`, never zip a whole session directory into a PR or a chat. Sessions
recorded before scrubbing landed still hold credentials in their HAR.

## Code style & logging

- **Linting/formatting:** [Ultracite](https://docs.ultracite.ai/) over Biome — config in `biome.jsonc` (extends `ultracite/biome/core`). `pnpm lint` checks; `pnpm format` autofixes; the pre-commit hook runs `ultracite fix` on staged files. Don't reintroduce ESLint/Prettier.
- **Logging:** use `dailies-logger` (`createLogger`, pino-backed, structured) for diagnostics — never `console.*` in app code (Biome's `noConsole` is an error). Reserve `process.stdout` for machine-readable CLI output. Level via `DAILIES_LOG_LEVEL` (trace|debug|info|warn|error|silent); the daemon logs to `~/.dailies/daemon.log`, the CLI to stderr (raise with `--verbose`).
- The vendored Playwright fork at `apps/dailies-daemon/src/sandbox/forked-client/` is excluded from lint/format — keep it diffable against upstream.

## Validation

Before committing:

```bash
pnpm install
pnpm check     # ultracite lint + turbo compile + test
```

Per-workspace:

```bash
pnpm --filter dailies-daemon test
pnpm --filter dailies-browser test
```

## Viewing sessions

A session's `report.html` is self-contained — open it directly. `dailies session list` lists
every recorded session and `dailies status --session <id>` reports one. The video is the
shareable deliverable; see **Artifact sensitivity** above for what isn't.

## Provenance

Dailies began as a fork of [Canary](https://github.com/wizenheimer/canary), the agent QA harness —
its sandbox, session recording and report are Canary's and remain the foundation here. Canary is
MIT-licensed, and in turn derives from MIT-licensed work by Sawyer Hood. Both are credited in
`LICENSE`, which ships inside the published npm tarball. Keep that attribution intact in `LICENSE`,
the root `README.md`, and `apps/dailies/README.md` — the last is what npm renders on the package
page, so it is the one that silently goes stale.
