// Help prose for the `dailies` orchestrator, shown via commander's
// `.addHelpText()` / `.description()`. Mirrors the dailies-browser engine's
// rich `--help` (a long-about + an after-help usage guide + per-command detail).
// The sandbox rules, script API, and scripting guide come from
// dailies-cli-kit — the single source of truth shared with dailies-browser —
// so `dailies --help` is fully self-contained for writing step scripts even
// when the engine CLI is not installed.
import {
  buildScriptingGuide,
  execExample,
  indent,
  RULE_DATA_PASSING,
  RULE_FAIL_FAST,
  RULE_SCREENSHOT,
  sandboxReference,
  sessionExample,
} from "dailies-cli-kit";

// Shown at the top of `dailies --help`.
export const CLI_LONG_ABOUT = `Dailies records capture-enabled QA sessions. It drives a real browser with
scripts run as ordered steps, captures a Playwright trace, video, network HAR,
and console for each run, and renders a self-contained report.html you can open
in any browser. A background daemon (Playwright + a QuickJS sandbox) starts
automatically when needed.

THE SESSION LIFECYCLE:
  1. start   dailies session start --name "checkout"        -> prints a session id
  2. run     dailies run step.js --session <id> --step open    (one script per step)
  3. end     dailies session end <id>                        -> writes report.html
  4. view    open ~/.dailies/sessions/<id>/report.html      -> the self-contained report

WHAT IS CAPTURED (per session; toggle on \`session start\`):
  trace        Playwright trace — DOM snapshots + actions, one group per step
  video        WebM recording of the run
  har          network request/response log
  console      console output + page errors
  screenshots  one per step, auto-captured from the step's last-opened page

Artifacts live under ~/.dailies/sessions/<id>/ (session.json, results.json, report.html, trace.zip, …).
Scripts run in a QuickJS sandbox (not Node.js) with a pre-connected \`browser\` global — the API
reference follows; \`dailies run --help\` has the scripting guide and worked examples.

${sandboxReference()}`;

// Shown after the options in `dailies --help`. The screenshot rule, data
// passing, and step discipline come from the shared doc snippets so this help
// cannot drift from the skills/REFERENCE.md versions of the same rules.
export const USAGE_GUIDE = `SESSION WORKFLOW GUIDE:
  Structure a session as a sequence of small steps — one script per step (open, act, assert).
  Each \`dailies run --step <name>\` is one step in the report, with its own trace group and ONE
  auto-captured screenshot.

${indent(RULE_SCREENSHOT, "  ")}

  Passing data between steps:
${indent(RULE_DATA_PASSING, "    ")}

  Reading results:
    dailies session list                       List sessions (table; --json for machine output)
    dailies status --session <id>              One session's status
    open ~/.dailies/sessions/<id>/report.html  The self-contained report

  Step discipline:
${indent(RULE_FAIL_FAST, "    ")}

  Tips:
    - \`--json\` (global) emits machine-readable JSON on stdout; \`-v\`/\`--verbose\` raises stderr logging.
    - \`dailies session end --stop-daemon\` shuts the daemon down if nothing else is using it.
    - Need a quick one-off with NO recording? Use \`dailies-browser run\` instead of a session.
    - Writing step scripts? \`dailies run --help\` has the full SCRIPTING GUIDE — snapshotForAI, humanClick/humanFill, waiting patterns, and worked examples.`;

// Per-command long help (shown before that command's own --help body).
export const SESSION_START_LONG_ABOUT = `Start a capture-enabled session and print its id.

Capture is on by default — disable per stream with --no-trace / --no-video / --no-har / --no-console.
Use --headless for unattended runs; omit it to watch the browser window.
The page records at a fixed 1280x720 desktop viewport — override with --viewport WxH.
A virtual cursor + click animation is drawn into the recording so interactions are visible
in video and screenshots; disable it with --no-cursor.
Pass --url <url> to open (and settle) a page at session start, so the recording begins on a
loaded page instead of the initial blank one — the pre-load blank is trimmed off the video head
at \`session end\`. Your first step then acts on the already-loaded page.
Planning a cinematic edit? Pass --cinematic so page.showCaption overlays are suppressed (their
text still feeds the narration) and won't double up with the captions burned in by
\`session end --cinematic\`.

  id=$(dailies session start --name "checkout" --url https://shop.example.com/cart)
  id=$(dailies session start --name "smoke" --headless --no-video)
  id=$(dailies session start --name "demo" --cinematic)`;

export const RUN_LONG_ABOUT = `Run a script as one step inside a session.

RECORDED: the step is captured into the session's trace, video, HAR and console, and appears
in report.html. --session is REQUIRED — for a one-off with no session and no recording, use
\`dailies exec\` instead.

The script (a FILE, or stdin if omitted) executes as top-level JavaScript with \`await\` in a
sandboxed QuickJS runtime — full reference below. The step's name labels it in the report and
owns ONE auto-captured screenshot (taken from the LAST page opened during the step). Named
pages persist across steps within the session, so each step picks up where the last left off;
pass values between steps with writeFile/readFile.

${sandboxReference()}

Examples:
  dailies run open.js --session "$id" --step open
  echo 'const p = await browser.getPage("home"); await p.goto("https://example.com");' \\
    | dailies run --session "$id" --step home --timeout 30`;

// The scripting guide — best practices + worked examples in dailies's own
// invocation style — shown after `dailies run --help`, where step scripts are
// actually written. Kept off the top-level `dailies --help` to keep it scannable;
// the top level points here instead.
export const RUN_SCRIPTING_GUIDE = buildScriptingGuide({
  example: sessionExample,
  heading: "SCRIPTING GUIDE:",
});

// `dailies exec` runs the same sandbox but outside a session, and owns the
// browser-targeting flags (--browser/--connect/--headless) that `run` doesn't —
// so its guide carries the extras `run`'s deliberately omits.
export const EXEC_SCRIPTING_GUIDE = buildScriptingGuide({
  example: execExample,
  execExtras: true,
  heading: "SCRIPTING GUIDE:",
});

export const SESSION_END_LONG_ABOUT = `Stop recording, collect artifacts, and render the report.

Writes ~/.dailies/sessions/<id>/report.html (self-contained) plus results.json. Pass --stop-daemon to
shut the daemon down afterward if no other sessions or browsers remain.

RUN VERDICT: declare the outcome against the flow's success criteria — --pass, or --fail "<reason>".
Your verdict decides the report's PASS/FAIL, so a failed INTERMEDIATE step (a timed-out click, a
dead end you recovered from, an abandoned retry) is kept as honest evidence but doesn't fail the run.
Declare neither and the run falls back to "failed if any step exited non-zero".

  --pass              mark the run PASSED — the workflow met its criteria (recovered step failures ok)
  --fail "<reason>"   mark the run FAILED with a reason — the workflow did not meet its criteria

ATTACHMENTS: --attach <file> copies a file into the session's attachments/ so it shows up in
results.json and the report next to the trace and video — a coverage report, a Lighthouse score,
an accessibility audit, anything Dailies didn't produce. Repeatable. It runs BEFORE the report is
built, which is the whole point: a file copied into attachments/ after 'session end' never makes
it in. A bad path warns and is skipped rather than failing the run.

  dailies session end "$id" --attach tmp/coverage.md --attach tmp/coverage-report.zip

CREDENTIALS: a recorded session is driven against a logged-in app, so Playwright captures live
\`Cookie\` / \`Authorization\` headers. At \`session end\` those header VALUES are replaced in
network.har (the names stay, so you can still see a request carried a cookie). This is NOT a
full sanitize: trace.zip holds the same traffic, response bodies can carry tokens of their own,
and profile/ is a real Chrome cookie database. Treat report.html as the shareable artifact and
the session DIRECTORY as sensitive.

  --no-scrub-har      keep the real credential values in network.har (for replaying it against
                      the same live session)

Videos are condensed when ffmpeg is available (PATH, $DAILIES_FFMPEG, or Playwright's bundled
copy): the pre-page-load segment is dropped and motionless stretches are trimmed out with a
frame-accurate re-encode that keeps real motion (cursor, typing, captions). Pass --no-condense
to keep the raw recordings.

CINEMATIC MODE (--cinematic): turn the silent recording into a narrated short.
An LLM writes themed narration per step, a voice reads it, and each step's frame is held just
long enough for its line; an opening title card and burned-in captions are added, plus a sibling
.srt. A single background song plays quietly under the narration and swells to full for the
credits. Requires the 'claude' CLI; voicing uses a local oMLX TTS model if available, else macOS
'say', else a Gemini key (so it can run off macOS with oMLX or a key). The title card needs an
ffmpeg built with drawtext and burned captions need the subtitles filter (otherwise it writes a
soft-sub .srt and tells you). Every generation command (say/ffmpeg/claude, and a redacted curl
for HTTP TTS) is printed so a run is easy to reproduce and tweak. Re-running --cinematic on an
already-condensed session reuses the preserved pre-cinematic cut (it won't re-condense).

SONG MODE (--song): score the whole video with ONE original song instead of spoken narration.
An LLM writes ONE short, singable lyric line per SECTION (consecutive short steps are grouped so a
verse spans a few seconds, not one frantic line per step) and a music model sings them. Like
narration, each frame is held for a readable beat (re-timing) so the body outlasts the song's short
instrumental intro and the vocals play across it; an opening title card and credits are added.
Captions are burned in (and a sibling .srt + .lyrics.txt are written). When a transcriber is found
on PATH (autodetected, English-only, in order: whisperx → mlx_whisper → whisper.cpp's whisper-cli;
models are pulled from the HuggingFace cache), the song is transcribed and the captions are timed to
the ACTUAL singing — the instrumental intro is trimmed off and the clean lyric lines are placed at
the vocals (only the lines the model actually sang). Without one, captions fall back to step times.
Use --no-captions to skip them. Needs the
'claude' CLI plus a lyrics-capable music model: the local ACE-Step server (see $DAILIES_ACESTEP_URL)
or a Gemini key (Lyria). Combine with --prompt to steer the genre — that override is yours to ask
for; an agent running the session should leave it off and let the theme be drawn.

  --song              score the video with a sung song instead of narration (implies --cinematic)
  --prompt "<text>"   steer theme/tone/style in your own words (implies --cinematic);
                      omit for a random theme. e.g. --prompt "noir detective, as a haiku"
                      Re-run --cinematic with a new --prompt anytime: the pre-cinematic cut is
                      preserved beside the video, so a re-theme is fast and needs no re-recording.
  --no-captions       skip burning subtitles into the video (the .srt is still written)
  $DAILIES_LLM        pin the text provider: claude (default, needs the claude CLI),
                      openai (needs $DAILIES_LLM_URL), or apple (Apple Intelligence,
                      on-device, macOS 26+). Unset tries each in that order and skips
                      whatever isn't available.
  $DAILIES_LLM_URL / $DAILIES_LLM_API_KEY / $DAILIES_LLM_MODEL   an OpenAI-compatible
                      /v1/chat/completions endpoint for narration/lyrics — OpenAI,
                      OpenRouter, LM Studio, Ollama, vLLM
  $DAILIES_CLAUDE_MODEL   override the model the claude CLI provider pins
  $DAILIES_SAY_VOICE / $DAILIES_SAY_RATE   pin the voice / words-per-minute
  $DAILIES_SAY_COMMAND   replace 'say' with your own TTS command (run via the shell, so it may
                        include args). It receives the text to speak as its only argument and must
                        write audio to $DAILIES_SAY_OUTPUT; $DAILIES_SAY_VOICE is passed in the
                        environment. Use it for a non-macOS tool, or a wrapper that voices a macOS
                        Personal Voice (e.g. DYLD_INSERT_LIBRARIES=…/mysay.dylib say -v
                        "$DAILIES_SAY_VOICE" -o "$DAILIES_SAY_OUTPUT" "$1")
  $DAILIES_TTS_CONCURRENCY   how many narration lines to voice at once (default 4, capped by your
                        core count). Set 1 to voice them one at a time, or raise it if your TTS
                        server is happy being pushed harder
  $DAILIES_OMLX_URL / $DAILIES_OMLX_API_KEY / $DAILIES_OMLX_TTS_MODEL   use a local oMLX server for
                        TTS (narration stays on your machine); key also read from ~/.omlx
  $DAILIES_ARCHIVE_MUSIC   free Creative-Commons music from archive.org (attribution added to the
                        run notes; needs ffmpeg, no model download). Used AUTOMATICALLY when no
                        music model is configured; =1 forces it on (over any model), =0 off
  $DAILIES_ACESTEP_URL / $DAILIES_ACESTEP_API_KEY / $DAILIES_ACESTEP_MODEL   point at an ACE-Step server
                        (local default :8001, or a remote box with a better GPU) for generated music —
                        the bed, and the sung song in --song mode (a remote URL sends lyrics there)
  $DAILIES_TRANSCRIBER / $DAILIES_WHISPER_CLI / $DAILIES_WHISPER_MODEL   override caption transcription:
                        force a backend (whisperx | mlx-whisper | whisper-cpp), its binary, or its
                        model (a size/HF repo for whisperx/mlx, a ggml path for whisper.cpp)
  $DAILIES_TRANSCRIBE_URL / $DAILIES_TRANSCRIBE_MODEL / $DAILIES_TRANSCRIBE_API_KEY   transcribe song
                        captions with an OpenAI-compatible server (POST /v1/audio/transcriptions) —
                        e.g. a local Whisper-Large-v3-Turbo. Wins over the CLI backends and gives the
                        tightest caption timing. URL is the host root; model defaults to whisper-1
  $DAILIES_IMAGE_URL / $DAILIES_IMAGE_API_KEY / $DAILIES_IMAGE_MODEL   generate the title-card background
                        with a local OpenAI-images-compatible server (POST /v1/images/generations)
  $DAILIES_WIKIMEDIA_IMAGES   a real, openly-licensed photo from Wikimedia Commons for the title card
                        (permissive licenses only; attribution added to the run notes). Used
                        AUTOMATICALLY when no image model is configured; =1 forces on, =0 off.
                        Title-background order: local image server, then Gemini (Nano Banana), then
                        Wikimedia, then a themed local gradient (always available, no key/network)

  dailies session end "$id"
  dailies session end "$id" --cinematic
  dailies session end "$id" --song
  dailies session end "$id" --song --prompt "80s power ballad"`;

export const STOP_LONG_ABOUT = `Stop the background daemon and everything it is running (all browsers and sessions).

This is the same graceful shutdown as \`dailies daemon stop\`. Any still-active session is
aborted — its artifacts are flushed, but its report.html is NOT regenerated. For a clean
report, run \`dailies session end <id>\` first, then \`dailies stop\`.

  dailies stop`;

export const EXEC_LONG_ABOUT = `Run a script once, outside any session.

NOT RECORDED: nothing is captured and no report is written — this is the quick one-off for
driving a browser, scraping a page, or poking at an unknown page before you record it. For a
step that lands in a session's trace/video/HAR and its report, use \`dailies run --session\`.

The script (a FILE, or stdin if omitted) executes as top-level JavaScript with \`await\` in the
same sandboxed QuickJS runtime as \`dailies run\` — full reference below. Named pages persist on
the daemon between exec calls, so successive one-offs pick up where the last left off.

Results come back on stdout via \`console.log\` — a script's return value is NOT emitted.

Examples:
  dailies exec scrape.js
  dailies exec scrape.js --headless --timeout 60
  echo 'const p = await browser.getPage("x"); await p.goto("https://example.com"); console.log(await p.title());' \\
    | dailies exec

Stop the browser and daemon when you're done: \`dailies stop\`.`;

export const CI_LONG_ABOUT = `Pieces a CI pipeline needs, exposed so it does not need a checkout.

The nightly demo workflow is meant to be COPIED into an app repo. Two steps used to import this
project's TypeScript directly, which only works from a source checkout — these are those steps.

  decide    Should this PR be demoed, and how? Merges .dailies/config.json with the PR body's
            overrides and asks the agent on the borderline cases. One line of JSON, for \`jq\`.
  metrics   Render the metric lines for a PR comment, each against the previous demo's value.
            The same formatter that wrote the marker being compared against, so they cannot drift.
  previous-metrics
            Read the last demo comment's metrics back out, to feed in as --previous.

Examples:
  dailies ci decide --cwd . --body-file pr.md --changed-file changed.txt --head-sha "$SHA"
  dailies ci metrics --current "$(cat metrics.txt)" --previous "$PREV" --prefix "- "`;

export const INSTALL_LONG_ABOUT = `Install the embedded daemon runtime: Chromium plus the Playwright + QuickJS
sandbox, into ~/.dailies. Run once before your first session (downloads ~150 MB).`;

export const INIT_LONG_ABOUT = `One-shot setup: install the browser runtime, then print next steps (add the
agent plugin, install skills, open the viewer). The friendlier Ink version is \`npm create dailies\`.`;
