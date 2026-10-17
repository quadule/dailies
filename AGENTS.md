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

1. **`dailies` (CLI, `dailies-cli`)** — the single user-facing CLI. Records capture-enabled QA sessions (trace/video/HAR/console) as a series of script steps and renders a self-contained report; `dailies exec` runs a one-off script unrecorded, outside any session (persistent named pages, sandboxed JavaScript, headless or headed).
2. **`dailies-daemon`** — a long-running Node process owning Playwright + a QuickJS sandbox. Embedded into the CLI at build time. Speaks line-delimited JSON over a named pipe / Unix socket.

The CLI reaches the browser like this:

```
dailies run … --session …   /   dailies exec …   →   daemon RPC   →   Playwright
```

**Drive browsers only through this CLI.** All browser work in this repo — navigating, clicking,
filling, scraping, viewing a recorded run — goes through the `dailies` CLI and the scripts it runs.
Do not use Claude in Chrome, a computer-use tool, or any other browser automation: they skip
Dailies's sandbox, on-screen cursor, and trace/video/HAR/report capture, so the run isn't recorded
or verifiable.

## Apps + packages

| Workspace                | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/dailies`            | The CLI (`dailies`) — records QA sessions, renders reports, and runs one-offs via `dailies exec`. |
| `apps/dailies-daemon`     | Internal Playwright host + QuickJS sandbox. Built standalone, embedded into the CLI             |
| `packages/protocol`      | Zod IPC schemas. Single source of truth — daemon validates, CLIs infer types                    |
| `packages/runtime`       | Shared filesystem paths, IPC endpoint naming, and session artifact discovery for CLI + daemon |
| `packages/config`        | Shared tsconfig bases (`base`, `node-app`)                                                       |
| `packages/logger`        | Shared pino-backed structured logger (source-distributed)                                       |
| `packages/cli-kit`       | Shared CLI helpers (request ids, formatting, logger factory)                                    |
| `packages/daemon-client` | Daemon transport + lifecycle + paths; embeds the daemon bundle for the CLIs                     |

## Build flow

`turbo run build` topo-sorts via `^build`:

1. `dailies-protocol` + `dailies-config` + `dailies-logger` + `dailies-runtime` (no build, source-distributed)
2. `dailies-daemon` builds → emits `dist/daemon.bundle.mjs` + `dist/sandbox-client.js`
3. `dailies-cli` embeds its assets (the daemon bundle via `dailies-daemon-client`, and its own browser editor client via `scripts/embed-editor.mjs`), then bundles with esbuild

## Shared docs (skills + CLI help + README)

LLM-facing doc content that appears on more than one surface — the sandbox/scripting API and the
workflow rules — is single-sourced in `docs/snippets/` and stitched by `scripts/stitch-docs.mjs`:

- Edit the snippet, then run `make docs` (`--write`). CI fails on drift via `pnpm check` (`--check`).
- Never hand-edit `packages/cli-kit/src/snippets.generated.ts` or the content between
  `<!-- dailies:snippet … -->` markers in `skills/`, `agents/`, or `README.md`.
- Each rule loads once per agent. Every workflow skill tells the agent to read `dailies-scripting`
  first, so the scripting rules (`rule-observe-first`, `rule-visible-interaction`, `api-snapshot`,
  `rule-drive-with-dailies`, `rule-project-flows`) live only there, and the workflow skills point to
  it. `dailies-verify` points to `dailies-session` for the recording rules. The subagents in
  `agents/` preload their skills through `skills:` frontmatter, so their bodies hold only what is
  specific to the agent. `references/REFERENCE.md` holds API detail, not the rules in its SKILL.md.
  Before embedding a snippet, check it isn't already on that load path.
- Skill text is read in full every session, so it is a token budget: say each instruction once and
  briefly. CLI help (`dailies run --help`) renders the scripting snippets too.
- `skills/` is the skill pack consumed verbatim by Claude Code (`.claude-plugin/`), Cursor
  (`.cursor-plugin/`), and Codex (`plugins/dailies/`, whose `skills` is a symlink here) — keep
  SKILL.md frontmatter (`name`, `description`) intact and marker-free.

## Attachments are the extension point

`session end --attach <file>` copies a file into the session's `attachments/`, which surfaces in
`results.json` and the report next to the trace and video. Implemented in
`apps/dailies/src/session/attach.ts`; the copy happens BEFORE the session-end RPC, deliberately —
both the daemon (`session-manager.ts`) and the on-disk fallback (`session/artifacts.ts`) use the
shared scanner in `packages/runtime/src/artifacts.ts` as the session ends, so a file copied
afterwards is silently missing from the report. The daemon supplies capture flags; recovery scans
every surviving artifact. Filesystem policy belongs in `dailies-runtime`, while IPC schemas stay
in `dailies-protocol`.

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

## Shared execution and installation

General CLI subprocess handling lives in `apps/dailies/src/util/process.ts`, and shell preview
formatting in `util/shell.ts`. Keep media probes in `video/ffmpeg.ts`; text providers should not
import video utilities. The shared runner closes supplied stdin and waits for process termination
before rejecting, so callers can safely clean temporary files.

The CLI install command and legacy daemon install RPC both use `dailies-runtime/install`. Keep
bundle extraction in the caller, preserve the RPC's framed/drained output, and retire only an idle
daemon after a CLI upgrade. Guest JavaScript lives in `apps/dailies-daemon/src/sandbox/guest/` as
explicit source strings; host orchestration and capabilities remain in `quickjs-sandbox.ts`.

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
- The cinematic pass checks `resolveProviders` (any usable backend), never the `claude` binary,
  and the end credits name whichever provider actually wrote the narration or lyrics
  (`writerCredit`) — don't reintroduce a hardcoded "Claude" there.
- **Providers are not interchangeable across roles.** Narration has no wrong answer, so the
  on-device Apple provider is a good narrator. The demo decision is a gate, and measured on the
  borderline cases (a copy-only edit, a 2px margin nudge, 5 samples each) it got 5/10 where the
  `claude` CLI got 12/12 across the same suite. The resolve order puts Apple last for this reason,
  and `decideDemoWithAgent` warns when it was the decider. Don't reorder that without re-measuring.

## Media providers (`apps/dailies/src/video/`)

The cinematic cut has three media slots beside the text provider — the **narrator** (TTS), the
**music** (the score; in `--song` mode, the singer), and the **title-card image**. Each provider is
one module with the same contract (`providers.ts`: write a finished, ffmpeg-decodable file to
`outPath` or throw), and the caller wraps every call so a failure degrades to the next local
fallback with a note instead of failing the run:

- `omlx.ts` (local TTS), `acestep.ts` (local music), `local-image.ts` (a local image server) —
  probed, on when reachable.
- `elevenlabs.ts` (TTS + Eleven Music; the image flow is opt-in) and `providers.ts` (Gemini via an
  AI Studio key or a Vertex service account) — on when their key is set.
- `archive.ts` (Creative-Commons music) and `wikimedia.ts` (openly-licensed photos) — free stock
  fallbacks that switch on automatically when no model covers the slot; `local-background.ts` is
  the always-available themed gradient.

`narrate.ts` gathers the candidates and `selectMediaProviders` (pure, unit-tested) picks per slot:
local first, then hosted keys, then stock. A user can **pin** a slot — `session end
--narrator/--music/--image <provider>` or `$DAILIES_NARRATOR/$DAILIES_MUSIC/$DAILIES_IMAGE`, parsed
in `media-preferences.ts` — and a pin follows the same rule as `$DAILIES_LLM`: the named provider
or a loud degradation, never a silent switch (the narrator, or the singer in song mode, skips the
pass; music and title art fall back with a note). The skills tell the agent to pass a user's named
provider through and otherwise leave the flags off. Adding a provider means: a module with the
contract above, a candidate entry in `resolveMedia`, a choice in `media-preferences.ts`, a credit
line in `narrate.ts` (`voiceCredit` / `musicToolName` / `titleArtToolName`), and the help text.

## Editing a finished recording (`apps/dailies/src/edit/`)

A plain `session end` writes `cut.json` beside the session — an edit decision list seeded with the
run's captions, step positions and speed-ups — and renders it; `dailies cut render <id>` rebuilds
the video from it again after edits. Both go through `renderCutVideo` (`edit/render.ts`), so a plain
finalize and a render of the untouched seed are the same video.

- **Every time in a cut is source time**: seconds into the clean condensed cut (the
  `*.precinematic.webm` sidecar). Cuts and holds move everything after them in the output, so
  edits stored in output time would drift. `planCut`/`mapTime` (pure, `cut.ts`) map source →
  output on each render; the edits never move.
- **The seed is written only by the `session end` that condensed.** Caption cues exist in
  condensed time only inside the condense pass; a re-finalize has none, so it keeps the existing
  cut rather than writing an empty one. No cut file means the session can't be edited — there is
  no back-fill for older sessions.
- **`precinematicVideoTime` means "position in the clean source" everywhere.** A render stamps it
  before overwriting `videoTime` with the output position, so re-renders and a later cinematic
  pass still find each step.
- **Generation is cached, assembly is not.** Voiced lines live in the session's `cut/` folder,
  keyed by text + voice + speed (recordings by file size + mtime); the first render pins the
  resolved voice into `cut.json` so later lines can't come out in a different voice. There is no
  silent fallback to a second voice.
- **Speed-ups are whole-number strides**: a `speedups` range at rate k keeps every k-th frame,
  and `planCut`/`mapTime` count kept frames exactly. A fractional rate would round differently per
  range and drift across hundreds of them. The seed (`seedSpeedups`) speeds up runs of steps
  recorded with `run --skim`, plus — only when the run showed any captions — uncaptioned stretches
  of 5s or more. A caption over sped-up footage keeps its own length (`outputCaptions`).
- **A render is one ffmpeg pass**: `cutVideoFilter` keeps frames with `select` on frame numbers,
  freezes with `loop=size=1` (applied last-frame-first so indices stay valid), then the caption
  burn and voice mix ride in the same filter graph. `select` terms are joined by `selectTree` as a
  balanced tree: ffmpeg's parser fails on a flat sum past ~100 terms, and the tree nests only
  log2(n) deep (2,000 terms measured fine). Condensing uses the same tree, so a long session is one
  decode of the source, not one per batch. Don't go back to encoding pieces and
  concatenating — a separate trim pass plus a burn/mix pass measured ~3 min vs ~17 s for 29 s of
  1440x900 footage. Holds are snapped to whole frames so the frame-based freeze matches `mapTime`.
  Every encode in the pipeline uses `VP8_ENCODE_ARGS` (`video/ffmpeg.ts`): libvpx at
  `-cpu-used 3`, measured 1.6–2.5× faster than the default at matching quality. `-cpu-used 2`
  measured worse than both, so re-measure before changing it.
- Spoken lines are loudness-normalized (−16 LUFS) so TTS and a laptop-mic recording match. A line
  that runs past the picture extends the last frame; lines that overlap only warn.

## Editing in the browser (`apps/dailies/src/edit/editor/`)

`dailies cut edit <id>` (`commands/cut-edit.ts`) serves an editor for one session from a local
`node:http` server, prints its URL on stdout, opens it unless `--no-open`, and runs until Ctrl-C
(`--port <n>` picks the port; default a free one). It is the human path to `cut.json`; agents
still edit the file. It refuses the sessions `loadCutSource` (`edit/render.ts`) refuses — still
recording, no `cut.json`, no ffmpeg — and, like a render, copies the video to the
`*.precinematic.webm` source when that sidecar doesn't exist yet.

- `server.ts` — `startEditorServer({ sessionId, port? })` → `{ url, close(), rendering() }`. It
  goes through `readCut`/`writeCut` and runs `renderCut` in-process, so a save here is the same
  edit as one made by hand and a render is `dailies cut render`. It writes only `cut.json` and
  `recordings/` itself. `close()` waits for a render it started, so the render's cleanup runs.
- `contract.ts` — the request and response types plus the shared constants. Imported by the
  server and the client, so it stays browser-safe.
- `page.ts` — the HTML shell; the client renders everything into `#app`.
- `client/main.ts` + `client/style.css` — the browser client. `scripts/embed-editor.mjs` bundles
  it with esbuild (iife, platform browser, es2022, unminified) and writes the gitignored
  `client.generated.ts` (`EDITOR_CLIENT_JS`, `EDITOR_CLIENT_CSS`). It is the CLI's `prebuild`,
  run before `build`, `compile`, `test`, `dev` and `prepack`. The CLI's tsconfig includes the DOM
  libs for it.
- The client imports the cut model straight from `edit/cut.ts` so a preview computes output
  times exactly as the render will (the placeholder uses `planCut` and `mapTime`; `outputCaptions`
  and `layoutLines` are there for a caption and narration preview). That makes `cut.ts` and
  everything it imports (`video/segments.ts`, `video/media-preferences.ts`) browser code: no
  Node imports, nothing Node-only at module scope. The browser-platform bundle fails the build on
  a Node import.
- Recordings live in the session's `recordings/` (`rec-<UTC timestamp>.<ext>`), never in `cut/`
  or `video/`: the artifact scanner (`packages/runtime/src/artifacts.ts`) doesn't read it, and
  the render's cache prune removes only its own `tts-*` / `rec-*` clips from `cut/`.
- A browser's MediaRecorder writes webm with no duration in its header; `audioDurationSec`
  decodes such a file to measure it.

**Security model.** The server binds 127.0.0.1 only. A request whose `Host` is not
`127.0.0.1:<port>` or `localhost:<port>` gets 403, which defeats DNS rebinding. Every `/api/*`
request must carry `X-Dailies-Editor: 1`; a cross-site page can't send a custom header without a
CORS preflight, and every `OPTIONS` request gets 403 with no CORS headers. File routes take one
bare file name (`[A-Za-z0-9][A-Za-z0-9._-]*`, checked after percent-decoding) and serve it only if
its real path (symlinks resolved) is inside the session directory. Every response carries
`Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`; the page adds a CSP that allows only
its own script and `blob:` media (for playing a recording before it is uploaded).

**HTTP contract.** Types are in `contract.ts`. Every `/api/*` error is JSON `{ "error": string }`.
All times are SOURCE seconds, as in `cut.json`.

| Route | Answer |
| --- | --- |
| `GET /` | The HTML shell, `Cache-Control: no-store`. `GET /editor.js`, `GET /editor.css`: the bundle and stylesheet. |
| `GET /api/session` | 200 `EditorSession`: `{ id, name?, cut, source: { durationSec, fps, width, height }, caption: { bandPx, fontPx, lineMax }, steps: [{ name, at, ok, skim?, error?, durationMs, screenshot? }], narrators, video: { url, path }, recordings: [{ file, durationSec }] }`. `steps` come from the session record in order (`at` = `precinematicVideoTime ?? videoTime`, else the same-named `cut.steps` entry by occurrence); a step with no time is left out. `screenshot` is `/screenshots/<sessionStepSlug(name)>.png` when that file exists. `video.url` is `/video.webm?v=<mtimeMs>` and changes after every render; `video.path` is `cut.video`. `recordings` lists `recordings/` files with a known audio extension and a readable duration. 409 if `cut.json` on disk doesn't parse. |
| `PUT /api/cut` | Body: a `Cut` as JSON (5 MB cap → 413). Parsed with `parseCut`: 400 with the parser's message, or for bad JSON. 400 if `video` differs from the cut on disk (`version` must be 1, the parser's rule). 409 while a render runs (the render pins the voice into `cut.json` when it finishes). Otherwise writes `formatCut` and answers 200 `{ cut }`, normalized as written (times rounded to the millisecond). |
| `POST /api/render` | Starts `renderCut` in-process; 202 with the `RenderStatus`. 409 if one is running. |
| `GET /api/render` | 200 `RenderStatus`: `{ state: "idle" \| "running" \| "done" \| "error", progress: string[], result?, error? }`. `progress` is the current or last render's messages; `result` is the last successful `CutRenderResult`, kept while the next render runs; `error` is set when `state` is `"error"`. |
| `POST /api/recordings` | Body: raw audio with `Content-Type` `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`, `audio/wav` or `audio/x-wav` (parameters ignored; else 415). Saved as `recordings/rec-<timestamp>.<webm\|ogg\|m4a\|mp3\|wav>`. 201 `{ file: "recordings/rec-….webm", durationSec }`. 413 past 200 MB, 400 when empty, 422 when ffmpeg can't read a duration (the file is removed). |
| `DELETE /api/recordings/<name>` | 204. 400 unless `<name>` is a bare file name, 404 if missing, 409 while a narration line's `audio` names it. |
| `GET /source.webm` | The clean condensed source every cut time points into. |
| `GET /video.webm` | The rendered output, `video/<cut.video>`. |
| `GET /recordings/<name>`, `GET /screenshots/<name>` | Those files. |

File routes answer `GET` and `HEAD` with `Accept-Ranges: bytes`, a single `Range` (206 +
`Content-Range`, 416 past the end; a multi-range gets the whole file), `ETag`/`If-None-Match`
and `Cache-Control: no-cache`; a bad file name is 400. Other methods on non-API paths are 405;
unknown routes are 404.

## Artifact sensitivity

A recorded session runs against a logged-in app, so its artifacts are not uniformly shareable:

- `report.html` and `results.json` are the shareable ones — no request headers in them. They DO
  carry every step's script text verbatim (and a takeover's captured Playwright code), because
  the replayable script is the point. A `fill`/`type` on a password-looking field is redacted
  (`apps/dailies/src/session/redact.ts`, applied to takeover captures and to the trace's action
  params); any other secret typed into a step script is in the report. The skills tell the agent
  to keep credentials in a file read with `readFile` rather than in the script.
- `network.har` has `Cookie` / `set-cookie` / `Authorization` **values** replaced when the session
  is finalized — `session end` (`--no-scrub-har` opts out) and `session abort` alike (see
  `apps/dailies/src/session/scrub-har.ts`). Request bodies are scrubbed by credential-looking
  field name (`password`, `token`, …); response bodies are **not** scrubbed, so a login response
  can still hold a token.
- `trace.zip` carries every Playwright call's parameters unscrubbed (and, under
  `--full-capture`, the same traffic as the HAR), and `profile/` is a real Chrome cookie database.
- Capture is lean by default (`CaptureOptionsSchema.full`): the trace has no DOM snapshots or
  screencast frames, and the HAR has no response bodies and no static assets (`LEAN_HAR_URLS`).
  The report reads only the trace's action log and the HAR's method/url/status/time, and on a
  50-minute run against a dev server full capture wrote a 1.5 GB trace and a 780 MB HAR.
- A HAR over `STREAM_SCRUB_BYTES` is scrubbed one entry at a time (`scrubHarStreaming`). Reading it
  whole fails past V8's ~512 MB string limit, and before the streaming path that failure left
  every cookie in place behind a warning.

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
pnpm --filter dailies-cli test
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
