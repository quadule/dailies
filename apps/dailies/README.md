# dailies-cli

> `dailies` — the session orchestrator for [Dailies](https://github.com/quadule/dailies). Drive a real
> browser, record capture-enabled QA sessions (Playwright trace, video, network HAR, console, per-step
> screenshots), and render a self-contained `report.html` you can open, commit, or browse in a local UI.

[![npm](https://img.shields.io/npm/v/dailies-cli.svg)](https://www.npmjs.com/package/dailies-cli)
[![license](https://img.shields.io/npm/l/dailies-cli.svg)](https://github.com/quadule/dailies)

Dailies is built for **AI agents and developers who need verifiable, reproducible browser QA**. Every
run captures a trace, a video, a network log, console output, and per-step screenshots — and decodes
back to a reproducible Playwright script — with no instrumentation of your app. Scripts are plain
async JavaScript run in a sandboxed QuickJS runtime; a background daemon (Playwright + sandbox) starts
automatically when needed.

## How it works

You drive the daemon through a four-step session lifecycle:

| Step | Command | Result |
| --- | --- | --- |
| 1. start | `dailies session start --name "checkout"` | prints a session id |
| 2. run | `dailies run step.js --session <id> --step open` | one script per step |
| 3. end | `dailies session end <id>` | writes `report.html` |
| 4. view | `dailies ui` | browse every session |

Mid-session you can hand the live (headed) browser to a human and capture what they do as a step:
`dailies session takeover <id>` starts recording their actions, `--stop` ends it and saves the
generated Playwright code (`--cancel` discards). Handy for logins, feature flags, or anything off
the happy path — it pairs with the `/dailies:session-interactive` flow in the Claude Code plugin.

## Install

```bash
npm i -g dailies-cli     # adds the `dailies` command
dailies install              # one-time: download Chromium + runtime (~150 MB) into ~/.dailies
```

Prefer not to install globally? Prefix anything with `npx`:

```bash
npx dailies-cli install
```

Or set everything up interactively with the guided wizard — `npm create dailies`.

## Quickstart

```bash
# 1. start a capture-enabled session (prints an id)
id=$(dailies session start --name "checkout")

# 2. run scripts as ordered steps — one script per step (open → act → assert)
dailies run ./open.js   --session "$id" --step "open"
dailies run ./submit.js --session "$id" --step "submit"

# inline scripts work too (read from stdin):
echo 'const p = await browser.getPage("home");
await p.goto("https://example.com");
console.log(await p.title());' | dailies run --session "$id" --step "home"

# 3. finish — collects artifacts and renders the report
dailies session end "$id"            # -> ~/.dailies/sessions/<id>/report.html

# 4. browse, search, and replay every session in a local viewer
dailies ui
```

Each `--step` is one entry in the report, with its own trace group and **one** auto-captured
screenshot (taken from the last page opened during that step). So use **one primary named page per
step**, and reuse the same page name across steps to "click through" like a user — named pages persist
across steps within a session.

## Commands

| Command | What it does |
| --- | --- |
| `dailies init` | One-shot setup: install the runtime, then print next steps. The friendlier wizard is `npm create dailies`. |
| `dailies install` | Install the embedded runtime (Chromium + Playwright + QuickJS) into `~/.dailies`. |
| `dailies session start` | Start a capture-enabled session; prints its id. Toggle capture with `--no-trace` / `--no-video` / `--no-har` / `--no-console`; `--headless` for unattended runs. |
| `dailies run [FILE]` | Run a script (a file, or stdin if omitted) as one step. Requires `--session <id>`; label it with `--step <name>`; bound it with `--timeout <seconds>`. |
| `dailies session end <id>` | Stop recording, collect artifacts, render `report.html` + `results.json`. `--stop-daemon` shuts the daemon down afterward if nothing else needs it. |
| `dailies session abort <id>` | Best-effort teardown of a session — salvage a wedged run from whatever artifacts survived. |
| `dailies session list` | List recorded sessions (table; `--json` for machine output). |
| `dailies status [--session <id>]` | Daemon status, or one session's status. |
| `dailies ui` | Launch the local session viewer. Options: `--dir <path>`, `--port`, `--host`, `--no-open`. |
| `dailies stop` | Stop the background daemon and every browser/session it's running (alias: `dailies daemon stop`). |

Global flags: `--json` (machine-readable output on stdout), `-v` / `--verbose` (more logging on
stderr). Run `dailies --help` or `dailies <command> --help` for the full reference.

> **Lifecycle tip:** `dailies stop` aborts any live session and skips its `report.html`. For a clean
> report, always `dailies session end <id>` **first**, then `dailies stop`.

## Writing scripts

Scripts are plain **async JavaScript** in a QuickJS sandbox with a Playwright-like API — no `require`,
`process`, `fs`, or `fetch`; just a pre-connected `browser`, `console`, and a few file helpers.
Top-level `await` works.

```js
const page = await browser.getPage("home");          // named, persistent page
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());

await page.locator("text=Sign in").click();
await saveScreenshot(await page.screenshot(), "signed-in.png");   // saveScreenshot(buffer, name)
```

- **Pages** — `browser.getPage(name)`, `browser.newPage()`, `browser.listPages()`,
  `browser.closePage(name)`. Pages are full Playwright `Page`s (`goto`, `click`, `fill`, `locator`,
  `evaluate`, `getByRole`, `waitForSelector`, …).
- **Files** (sandboxed to `~/.dailies/tmp/`) — `saveScreenshot(buffer, name)`, `writeFile(name, data)`,
  `readFile(name)` to pass values between steps.

The full reference is built into this CLI — run `dailies --help` or `dailies run --help`
(`dailies exec --help` documents the same API), or read the
[dailies-scripting reference](https://github.com/quadule/dailies/blob/main/skills/dailies-scripting/references/REFERENCE.md).

## Artifacts

Everything for a run lands under `~/.dailies/sessions/<id>/`:

```
session.json   session metadata + per-step record
results.json   decoded results (steps, summary, artifact paths)
report.html    self-contained report — open it anywhere, commit it, share it
trace.zip      Playwright trace (DOM snapshots + actions, one group per step)
```

…plus the WebM video, the network HAR, the console log, and one screenshot per step.

## Use it from an AI agent

Dailies ships skills, subagents, and `/dailies:*` slash commands for Claude Code, Cursor, and Codex, so
an agent can plan and record QA for you:

```bash
# Claude Code: /plugin marketplace add quadule/dailies  then  /plugin install dailies@dailies-marketplace
```

## Related packages

- [`dailies-ui`](https://www.npmjs.com/package/dailies-ui) — the `dailies-viewer` session browser.
- [`create-dailies`](https://www.npmjs.com/package/create-dailies) — `npm create dailies` guided setup.

MIT · [source](https://github.com/quadule/dailies)
