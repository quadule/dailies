# Changelog

## Unreleased

### Changed

- **Renamed: Canary is now Dailies.** The project forked from
  [Canary](https://github.com/wizenheimer/canary) as a QA harness, but its center of gravity moved
  to turning a recorded browser run into something you can *watch* — narration, an original score,
  captions, a title card and credits. In film production, dailies are the footage the crew reviews
  to confirm what was shot actually works, which is this tool's job.

  What changed for you:

  - The CLIs are `dailies`, `dailies-browser` and `dailies-viewer`.
  - Packages publish unscoped: `dailies-cli`, `dailies-browser`, `dailies-ui`, `create-dailies`
    (the `@usecanary` scope is gone).
  - Skills, subagents and slash commands are `dailies-*` and `/dailies:*`.
  - Environment variables are `DAILIES_*`.
  - State lives in `~/.dailies`, and the viewer's per-root organization sidecar is
    `.dailies-ui.json`.

  This is a **breaking rename with no compatibility path**: old package names, binaries, env vars
  and paths are simply gone. To carry an existing install over, move the sessions across rather
  than the whole directory — `dailies install` (and any `dailies` command) creates `~/.dailies`, so
  a plain `mv ~/.canary ~/.dailies` would nest the old tree *inside* the new one instead of
  replacing it:

  ```bash
  mkdir -p ~/.dailies/sessions && mv ~/.canary/sessions/* ~/.dailies/sessions/
  mv ~/.canary/browsers/* ~/.dailies/browsers/ 2>/dev/null || true
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
