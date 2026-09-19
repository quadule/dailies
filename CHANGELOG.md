# Changelog

## Unreleased

### Changed

- **Current browser and build dependencies.** Playwright/Chromium move to **1.63.0**,
  with the sandbox bridge adapted to the new protocol. The CLI now requires **Node 22.12.0+**;
  development uses **Node 24 LTS** (minimum **22.22.1**) and **pnpm 12.4.2**. Updated
  TypeScript, Vitest, Zod, Commander, logging, build tools, and CI actions to their current stable
  releases. After upgrading the CLI, run `dailies install` to refresh its embedded runtime;
  an incompatible installed runtime is detected before daemon startup.

- **Renamed: Canary is now Dailies.** The project forked from
  [Canary](https://github.com/wizenheimer/canary) as a QA harness, but its center of gravity moved
  to turning a recorded browser run into something you can *watch* — narration, an original score,
  captions, a title card and credits. In film production, dailies are the footage the crew reviews
  to confirm what was shot actually works, which is this tool's job.

  What changed for you:

  - The CLI is `dailies`, published as the single npm package `dailies-cli` (the `@usecanary`
    scope is gone).
  - Skills, subagents and slash commands are `dailies-*` and `/dailies:*`.
  - Environment variables are `DAILIES_*`.
  - State lives in `~/.dailies`.

  This is a **breaking rename with no compatibility path**: old package names, binaries, env vars
  and paths are simply gone. To carry an existing install over, move the sessions across rather
  than the whole directory — `dailies install` (and any `dailies` command) creates `~/.dailies`, so
  a plain `mv ~/.canary ~/.dailies` would nest the old tree *inside* the new one instead of
  replacing it:

  ```bash
  mkdir -p ~/.dailies/sessions && mv ~/.canary/sessions/* ~/.dailies/sessions/
  rm -rf ~/.canary   # the daemon runtime is rebuilt by `dailies install`
  ```

  Historical entries below predate the rename and are left as they were written.

### Added

- **ElevenLabs as a media provider.** Set `ELEVENLABS_API_KEY` and the cinematic cut is narrated
  by an ElevenLabs voice (`eleven_multilingual_v2`; one of your voices is drawn per run, or pin one
  with `$DAILIES_ELEVENLABS_VOICE`) and scored by Eleven Music (`music_v2_5`), which also sings the
  lyrics in `--song` mode. The key is validated once up front — a rejected key disables the provider
  with a note instead of failing every clip — and every call is echoed as a redacted curl. Its image
  flow (`--image elevenlabs`) is opt-in because it needs a Pro plan. Between hosted keys ElevenLabs
  is tried before Gemini; local servers (oMLX, ACE-Step) still come first.
- **Pin the narrator, the music, or the title art.** `session end --narrator <elevenlabs|gemini|
  omlx|say>`, `--music <elevenlabs|gemini|acestep|archive|none>` and `--image <elevenlabs|gemini|
  local|wikimedia|gradient|none>` (or `$DAILIES_NARRATOR` / `$DAILIES_MUSIC` / `$DAILIES_IMAGE`)
  choose the provider for one slot when several are configured. A pin follows the `$DAILIES_LLM`
  rule — the named provider or a loud degradation, never a silent switch: a pinned narrator (or
  singer) that isn't set up skips the pass with the reason; pinned music or title art falls back
  with a note. Common spellings ("Lyria", "ACE-Step", "archive.org", "off") are accepted, and the
  skills tell an agent to pass a user's named provider through rather than pick one for them.
- **`session end --attach <file>` and `--metric name=value`.** Attach copies any external file into
  the session's `attachments/`, which surfaces in `results.json` and the report next to the trace
  and video — a coverage report, a Lighthouse score, an accessibility audit. It copies *before* the
  session-end RPC, which is the point: both the daemon and the on-disk fallback build their artifact
  list as the session ends, so a file copied afterwards was silently missing from the report. Metric
  records a named number, persisted in `results.json`, for comparing runs over time. Re-running
  `session end` on an already-ended session re-renders with the new attachments and keeps the
  verdict. Metric values are stored at full precision and displayed to four decimals — on a large
  codebase a single line is ~0.0002% of the total, so a coarser display would report every run as
  unchanged. Neither knows anything about coverage — the README documents that recipe generically for
  Ruby, Node and Python, and the orchestration belongs in the app's own repo.
- **Demo PR comments now carry the commit and the numbers.** The comment links the short sha it was
  recorded from and says later commits aren't in the recording (the PR may have moved since the run
  started), and prints each `--metric` with its change since the previous demo — "coverage 42.5
  (+3.2 since 39.3)". The previous values ride in the comment's own hidden marker, so the comparison
  needs no state outside the PR; the marker's older sha-only form still parses.
- **Pluggable text generation — `claude` is no longer the only option.** Narration, lyrics and the
  demo decision all go through one `generateJson` seam with three backends: the **`claude` CLI**
  (still the default — no API key, no local model), any **OpenAI-compatible** `/v1/chat/completions`
  endpoint (`$DAILIES_LLM_URL` — OpenAI, OpenRouter, LM Studio, Ollama, vLLM), and **Apple
  Intelligence** on-device via a small Swift helper (macOS 26+, no key, no network — it honors the
  JSON schema at runtime through `DynamicGenerationSchema`, so it needs no per-schema Swift; a
  30-step narration measured ~7s). `$DAILIES_LLM` pins one; otherwise an unavailable or failing
  provider falls through to the next, and if all decline the run notes name each one and why.
- **The nightly demo decision is made by a model, not a glob.** `demo.decide` defaults to `"agent"`:
  an LLM reads the diff, the PR description and the repo's `demo.hint` together and decides — so a
  data backfill or a background job that changes what a user eventually sees gets demoed, which a
  path list could never tell. It also names the flow to record, which the recording agent starts
  from. `"paths"` keeps the deterministic match and `"always"` demos everything; under `"agent"`,
  `demo.paths` becomes a hint and the fallback when no provider is available. Freshness and a
  missing target are still settled without a model call, so an already-demoed PR costs nothing.
- **Demo videos are attached to the PR comment** with `gh pr comment --attach`, so they play inline
  instead of only being a downloadable run artifact. The step probes for the flag (it is newer than
  some runners' preinstalled `gh`) and checks GitHub's size cap, falling back to linking the
  artifact.
- **A `.dailies/` project convention.** A repo Dailies drives can commit what Dailies needs to know
  about it: `.dailies/flows.md` (app-specific knowledge — how to sign in, which routes matter, the
  selectors that break naive Playwright) and `.dailies/config.json` (defaults: `url`, `demo.paths`,
  `demo.prompt`). The agent is told to read `flows.md` before writing a step script, to correct it
  in place when it's wrong, and to **say what it changed** — so app knowledge accumulates instead of
  being rediscovered every run. `session start` reports the file and warns when it outgrows a
  250-line budget, since it's read in full every session. Plain files rather than a per-app agent
  skill: skill loading depends on a model matching a `description` and only works in one harness,
  while a committed file loads deterministically and works for Claude Code, Codex and Cursor alike.
- **Nightly PR demos.** `.github/workflows/dailies-demo.yml` (was `autodemo.yml`) now runs on a
  nightly schedule over every open PR labeled **`dailies`**, and demos one only when its head has
  moved since its last demo (tracked by a marker in the workflow's own PR comment) and its changed
  files match `demo.paths`. Labeling a PR still demos it immediately; `workflow_dispatch` takes a PR
  number and a `force` flag. PR-body keys are `dailies-url:` / `dailies-theme:` and now override
  repo config rather than being the only way to configure anything. Fork PRs are skipped — they get
  no secrets, and their `.dailies/` would be untrusted input that becomes agent instructions.
- **HAR credential scrubbing, on by default.** A session is driven against a logged-in app, so
  Playwright recorded live `Cookie` / `set-cookie` / `Authorization` headers into `network.har` —
  a file inside a directory people are encouraged to share. `session end` now replaces those
  header values (names kept, so a reader can still see a request carried a cookie), atomically,
  leaving the original untouched and warning loudly if the pass fails. `--no-scrub-har` keeps the
  real values for replaying a HAR against the same live session. Response bodies, `trace.zip` and
  `profile/` are **not** scrubbed — the README now says which artifacts are safe to share.
- **Fixed-viewport recordings with an animated virtual cursor.** Sessions record at a fixed desktop
  viewport, and a synthetic cursor is drawn into the video (the OS pointer never appears under
  CDP-driven input): it glides to each target, shows a click ripple, and switches glyph
  (arrow / hand / I-beam) to match the element under it. Purely cosmetic — `pointer-events:none`,
  `aria-hidden`, invisible to `snapshotForAI`. Disable with `--no-cursor`.
- **Human-like interaction helpers** on the sandbox page — `page.humanClick(target)` and
  `page.humanFill(target, text)` (`target` is a selector or a locator). They reveal the element,
  glide the cursor onto it and let it settle, then act through real input (a true click; for fills,
  focus-then-type with real key events), so recordings read like a real user.
- **Video captions** — `page.showCaption(text, opts?)` overlays a short caption on the recording to
  label a moment for a human viewer.
- **Automatic per-step settle + `page.humanClickAndWaitForURL(target, opts?)`.** Canary settles the
  page at the end of every session step (bounded document-load + network-idle + DOM-mutation
  quiescence, daemon-side), so each step's screenshot and the next step's fresh page start committed
  and quiet without any in-script wait. For a navigation you need to resolve within a step,
  `humanClickAndWaitForURL` captures the URL before the click and waits race-free for the new page.
  Settling is no longer an agent-facing call.
- **Interactive session mode** — the `canary-session-interactive` skill and `/canary:session-interactive`
  command run a recorded session in the main conversation (no subagent): the agent drives
  autonomously but can pause to ask for direction, and can hand you the live headed browser for
  steps it can't do. `canary session takeover <id>` captures your manual actions via Playwright's
  recorder (api mode) as a step's generated Playwright source (`--stop` to record, `--cancel` to
  discard).
- **Condensed session videos** — when ffmpeg is available (PATH, `$CANARY_FFMPEG`, or Playwright's
  bundled copy) the pre-page-load segment is dropped and motionless stretches are trimmed via a
  frame-accurate re-encode, so reviewers don't scrub through dead air. `--no-condense` keeps raw
  recordings.
- **Unified steps panel** in the report — each step's screenshot is linked to and navigable from
  the step.
- `make install-local` — build, globally link the CLIs, and install the Claude Code plugin from a
  working checkout (for local development and dogfooding).
- Initial canary monorepo scaffold (pnpm + Turborepo).
- Bootstrapped from MIT-licensed upstream work by Sawyer Hood (see `LICENSE`). Migrated:
  - `cli-ts/` → `apps/canary-browser/` (browser engine CLI, bin: `canary-browser`)
  - `daemon/` → `apps/canary-daemon/` (internal Playwright host + QuickJS sandbox)
  - `daemon/src/protocol.ts` → `packages/protocol/` (Zod schemas, single source of truth)
- Shared `@usecanary/config` package (tsconfig bases).
- `@usecanary/logger` — shared pino-backed structured logging, used by the daemon
  (writes to `~/.canary/daemon.log`) and the CLI (stderr; `--verbose` /
  `CANARY_LOG_LEVEL`).
- [Ultracite](https://docs.ultracite.ai/) (Biome) for linting + formatting,
  enforced in CI; replaced Prettier and removed the unused eslint-config package.
- Dropped the Rust and Go CLI implementations and their docs entirely.

### Changed

- **Silent stretches fast-forward.** Footage nobody narrates — a run of consecutive un-narrated
  steps, typically signing in — plays as a fast-forward toward a four-second target instead of in
  real time, so a sign-in that took 17 of a film's 51 seconds no longer plays out in silence. Every
  action stays on camera; nothing is cut. Narration itself is never sped up and song mode is
  untouched. `$DAILIES_SILENT_FOOTAGE_SEC` sets the target; `0` restores real-time playback.
- **Narration and lyrics aim at the feature under test.** A run of setup/auth steps collapses into
  one section before the lines are written, so signing in costs at most one line, and both prompts
  open with what is being tested. Steering is limited to what the lines are *about* — the random
  theme draw is untouched. A `$DAILIES_SONG_FILE` sidecar generated before this has one line too
  many and should be regenerated.
- **Hosted narration reads at voiceover pace.** Gemini TTS has no rate control and read at a
  talking-head pace, so the prompt asks for a brisk delivery and the rendered audio is sped up
  1.2× with pitch preserved (ffmpeg `atempo`). `$DAILIES_TTS_TEMPO` overrides it; `1` disables.
- **The cursor, typing and caret read as a person.** After a click the cursor drifts from where the
  click actually landed instead of snapping to the field's corner, glide targets get bounded
  jitter, typing cadence is planned to a 4.5 s budget (193 characters in 7.9 s, still one key at a
  time), and the text caret is painted transparent in the recording — its 1 Hz blink defeated the
  dead-air trimming. `--no-cursor` disables all of it.
- **Condensing cuts on changed pixels, not the frame-mean freeze.** The virtual cursor is 0.06% of
  the frame, far under `freezedetect`'s noise floor, so a glide read as a freeze and the pass had
  to keep a 1.5 s lead-out around every cut. Counting changed pixels sees the cursor; on a real
  51 s session the trim went from removing 1.3 s to cutting the film to 28 s with every motion
  frame intact.
- **Burned captions anchor to the top of their band** and use the frame's real width (58
  characters at 1440 px, up from 48), so one-line and two-line cues start at the same height.
- **`dailies install` on Linux** prints the one-line hint about Chromium's system libraries
  (`sudo npx playwright install-deps chromium`) instead of declaring success and failing at the
  first launch.
- Agent guidance (skills, subagents, and the scripting reference) now mandates the human helpers
  for recorded clicks and text entry; directs clicking labels for checkboxes/radios (the real
  input is often hidden behind a custom control); checking for overlays/modals before interacting;
  settling and checking for changes (validation, new fields) before submitting a form; captioning
  only when it helps a viewer; and waiting for the page to settle after a navigation rather than
  acting on stale content.

### Fixed

- **`--cinematic` no longer demands the `claude` binary.** The pass gated on `claude --version`
  even though narration can come from an OpenAI-compatible endpoint or Apple Intelligence
  (`$DAILIES_LLM`), so a Linux box with only `$DAILIES_LLM_URL` set was told the CLI was missing. It
  now checks for any usable text provider and names the same fix `generateJson` would.
- Releases publish from a **manual workflow run** instead of on any `v*` tag push, so tagging a
  release and publishing it are separate decisions and an accidental `git push --tags` can't reach
  the registry. The run refuses to continue unless the version typed matches the workspace.
- `page.showCaption` never actually clamped: the overlay set `display:-webkit-box` and
  `overflow:hidden` but the `-webkit-line-clamp` declaration was missing, so a long caption grew
  into a wall of text over the page.
- `claude -p` invocations no longer stall and fail: `execFile` leaves the child an unconnected
  stdin pipe, which `claude` waits ~3s on before erroring out, taking narration and lyric
  generation with it. The child now sees EOF immediately.
- Viewer: a `--dir` (or `CANARY_UI_ROOT`) pointed at a single session directory now roots at its
  parent sessions folder instead of selecting an empty source — so opening a specific session from
  the review flow shows the sessions list rather than nothing.
- **The credits name who wrote the words.** They always said "Narration — Claude (Anthropic)",
  even for a cut written by an OpenAI-compatible model or Apple Intelligence. The end credits now
  name the text provider that produced the narration or lyrics (and a pinned song's sidecar keeps
  it); the `claude` CLI's label is unchanged.
- **A pinned media provider that is configured but unusable** — an ElevenLabs key the API
  rejected, an ACE-Step URL nobody answers, an oMLX server with no TTS model — fails with that
  reason instead of "set ELEVENLABS_API_KEY" when the variable is already set.
- **The score swell landed 2.5 s late.** The music tracks were timed against the title-prefixed
  video and then shifted by the title offset a second time; the credits swell now starts on the
  credits' first frame. In song mode the instrumental intro no longer replays the first step's
  footage before the step itself. When a hosted narrator fails mid-run the note names the provider
  and its error instead of claiming macOS `say` took over, and the "no vocal timing" note names the
  real remedies (a transcriber on PATH, or `$DAILIES_TRANSCRIBE_URL`) rather than a variable that
  forces the wrong backend.
- **A daemon left over from the previous install is retired.** `dailies install` now stops the
  running daemon when it is idle, so an upgrade takes effect on the next command instead of the
  old build serving until the machine restarts; a daemon with an open session is left alone and
  says so. A daemon that dies on startup now shows the tail of its stderr
  (`~/.dailies/daemon.stderr.log`) and where to look next, runs on the same Node binary as the
  CLI rather than whatever `node` is on PATH, and a `session end` can no longer hang forever on a
  wedged browser close. The step barrier settles the page the step drove rather than the newest
  tab, caption writes are serialized so back-to-back `showCaption` calls can't corrupt
  `captions.json`, a `stop` during an in-flight `session end` joins it instead of finalizing the
  session twice, the IPC frame cap is per message rather than per connection, `--connect`
  auto-discovery finds Chrome under `$XDG_CONFIG_HOME`, snap and Flatpak on Linux, and
  `~/.dailies` and the daemon socket are created owner-only.
- **CLI corrections.** A bare `dailies exec --connect` now auto-discovers the running Chrome (it
  used to send commander's `true` and be rejected). `dailies status` no longer starts a daemon as a
  side effect of asking whether one is running, and honors `--json` (`{"running":false}`, or
  `{"running":true,…}` with the summary). `dailies exec --json` emits strict JSON like `run`. A
  re-run of `session end --json` reports the metrics on the record, not only the ones passed that
  time. A malformed `.dailies/config.json` (local or served) is reported by `session start` and in
  the demo decision instead of being silently replaced by defaults. An unknown flag after a global
  one (`dailies --json session end … --bogus`) names the right command's flags. Missing ffmpeg and a
  session recorded without video now say so on stderr instead of silently skipping condensing or
  the cinematic pass — and Playwright's bundled ffmpeg is no longer tried as a fallback, since it
  can't do anything the pipeline needs.
- **Credentials in artifacts.** `session abort` scrubs `network.har` like `session end` does;
  request bodies are scrubbed by credential-looking field name (form fields and JSON keys — a
  login POST no longer carries the password); the Playwright code a `session takeover` captures
  and the trace's fill/type entries have values on credential-named fields replaced with
  `[redacted]`. The oMLX key read from the local app's config is never sent to a remote
  `$DAILIES_OMLX_URL`, and Wikimedia/archive.org requests carry a real user agent naming this
  repository.
- **Release tooling.** `scripts/release.sh` matches trusted publishing (no `NPM_TOKEN`, publish is
  a manual dispatch on the tag, which `release.yml` now verifies); the CLI build cleans `dist/`
  and the tarball lists only `cli.js` and its map, so a stale bundle can't ship; the demo
  workflow's discover job can actually make the model decision (it installs Claude Code and gets
  the key) and the demo job no longer assumes a pnpm workspace; the Node floor is `20.11` and the
  daemon build no longer uses a newer-Node-only API. Dead Makefile viewer targets, stale turbo
  outputs and gitignore lines, the Codex manifest's non-existent "review" skill, and the npm
  package README (which never mentioned the film) are fixed.
