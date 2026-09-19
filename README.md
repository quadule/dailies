<div align="center">
  <h1>Dailies</h1>
  <p><strong>Watch your change work.</strong></p>

  <p>
    <sub>
      Built on <a href="https://github.com/wizenheimer/canary"><b>Canary</b></a>, the
      agent QA harness this began as — its sandbox, session recording and report are
      Canary's, and they are still the foundation everything here stands on. MIT, with
      thanks. See <a href="LICENSE">LICENSE</a> for full provenance.
    </sub>
  </p>

  https://github.com/user-attachments/assets/53d10b52-35cf-496a-a342-e8719574a000
</div>

In film production, **dailies** are the footage the crew reviews at the end of the day to confirm
that what they shot actually works. This does that for software changes.

An agent drives a real browser through the flow your change touches. What comes back is something
you can *watch* — a narrated, captioned short of the run, scored and titled — and underneath it the
evidence: a Playwright trace, video, network HAR, console log, a screenshot of every step, and a
reusable Playwright script you can replay in CI for free.

The point is the gap it closes. A diff tells you what changed; a green test tells you nothing
broke. Neither shows you the thing a person will actually see. Dailies does, in a form you can drop
into a pull request and hand to someone who will never open your editor.

And it is deliberately a little fun. Reviewing pull requests is repetitive work, so every cut draws
a **random theme** from 300+ of them — your migration might arrive as a noir detective short, a
nature documentary, or a sung power ballad. That is not a gimmick bolted on the side; it is the
reason people actually watch the thing. Pin a house style with `--prompt` when you want one, but
leaving it off is the default on purpose.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/8ad76566-542e-43b0-a9f2-0220f819710b" />

Most tools make you pick one:

- An opaque agent run you can't reproduce.
- Raw Playwright scripts you write and maintain by hand.

Dailies doesn't make you choose. The agent discovers the flow once; you keep the film, the evidence,
and the script.

## Features

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/145916b9-80ed-4154-858f-256d84783d19" />

- **A film, not a log.** `--cinematic` turns a silent recording into a narrated short: an LLM writes the voice-over, a voice reads it, each step holds long enough to follow, with a title card, burned-in captions and credits. `--song` scores the whole thing with one original sung track instead.
- **A different theme every time.** Omit `--prompt` and each cut draws from 300+ themes and styles, so a repetitive review job stays worth opening. `--prompt "1970s heist film, as a limerick"` when you want to choose.
- **See exactly what happened.** Trace, video, network, console, and a screenshot of every step — captured automatically, with an on-screen cursor so you can see where the agent actually clicked.
- **Reproducible by default.** Dailies turns each run into a real Playwright script. Let your agent discover a flow once; re-run it forever.
- **One file, zero setup.** Every session renders a self-contained `report.html` — open it, commit it, send it. No server, no build. (That file is the shareable one; the session directory beside it holds the raw trace and cookies — see [what's safe to share](#whats-safe-to-share).)
- **Nightly demos of your pull requests.** Label a PR and wake up to a video on it. A model reads the diff and decides whether the change is even worth filming.
- **Teach it your app once.** Commit a `.dailies/flows.md` and every run starts knowing how to sign in and where things are, instead of rediscovering it.
- **Bring your own model.** The `claude` CLI by default, any OpenAI-compatible endpoint, or Apple Intelligence fully on-device.
- **Bring your own voice, score and title art.** Narration, music and the title card come from whatever you have — a local oMLX or ACE-Step server, an ElevenLabs or Gemini key, free Creative-Commons stock — picked automatically, or pinned per slot with `--narrator` / `--music` / `--image`.
- **Built for agents.** Drop-in plugins for Claude Code, Cursor, and Codex.
- **Sandboxed.** Scripts run in a QuickJS WASM sandbox with the full Playwright `Page` API — no Node, no host access.


## Who it's for

https://github.com/user-attachments/assets/8459994a-b43c-4483-bb4a-00522d1d03fe

You describe the flow in plain language. Your agent drives a real browser and hands back something
to watch, the evidence behind it, and the exact Playwright script that produced it.

| You are a…        | Instead of…                                              | Dailies gives you…                                                                      |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Developer**     | Writing and maintaining Playwright/E2E scripts by hand   | A reusable script captured from every run — re-run it in CI, no agent cost on replay     |
| **QA engineer**   | Clicking through flows manually to repro and verify      | Evidence by default — trace, video, network, console, and a screenshot of every step     |
| **Reviewer**      | Reading a diff and imagining what it looks like          | A demo video on the PR, filmed from the branch, before you open the code                 |
| **PM / designer** | Waiting on a build or trusting "works on my machine"     | A short you can actually watch, plus a self-contained `report.html` you open and read    |
| **Whoever demos** | Re-recording the same walkthrough by hand every sprint   | A narrated cut regenerated from the real app on every change, with no screen-recording   |

## Get started

```bash
npm i -g dailies-cli                     # puts `dailies` on your PATH
dailies install                          # one-time: Chromium + the runtime into ~/.dailies (~150 MB)
```

…or run the guided setup, which offers to install all of the above for you:

```bash
npx dailies-cli init                     # guided setup
```

Record a session and open the report:

```bash
id=$(dailies session start --name "checkout")
dailies run ./open.js   --session "$id" --step open
dailies run ./submit.js --session "$id" --step submit
dailies session end "$id"                # -> ~/.dailies/sessions/<id>/report.html

dailies session list                     # every recorded session
dailies stop                             # shut the background daemon down when you're done
```

Just need a quick one-off with no recording? Run a script straight through with `dailies exec`
(a file path, or piped on stdin):

```bash
echo 'const p = await browser.getPage("main");
await p.goto("https://example.com");
console.log(await p.title());' | dailies exec
```

Or attach to a Chrome you already have open — launch it with `--remote-debugging-port=9222`, then
`dailies exec --connect` (it auto-discovers the port, or pass the URL explicitly). Handy for driving
a browser that's already logged in:

```bash
dailies exec --connect http://localhost:9222 <<'EOF'
const page = await browser.getPage("main");
console.log(await page.title());
EOF
```

> Prefer not to install? Every command also runs one-off via npx, e.g.
> `npx dailies-cli session start …`.

## Everything your agent does, on the record

Open any session and Dailies replays the whole thing — the page, the script, every Playwright call, the
console, the network, the full trace. Nothing summarized, nothing reconstructed: it's the actual run.
(Every screenshot below is real output.) Capture is on by default; switch any stream off with
`--no-trace` / `--no-video` / `--no-har` / `--no-console`.

### The session at a glance

Status, a per-step timeline, the exact environment, and a full **video replay** of the run — with
an animated cursor that shows exactly where the agent acted and dead air trimmed out — plus a
filmstrip of per-step screenshots to scrub straight to the moment something happened.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/c538d7a3-5e03-4aa1-9412-3ae43cac4f34" />


### Step by step

Each step, pass or fail, with its exit code, duration, and how many Playwright actions it ran.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/ade23da1-451b-41b3-b8b8-720f27352734" />


### Reproducible Playwright scripts

This is the one that matters. Let your agent figure a flow out **once** — Dailies keeps the script
behind every step **and** decodes the full Playwright trace into the exact calls it made (`goto`,
`waitForSelector`, `evaluate`, `screenshot`), with params and timing. What you get back is a real,
reusable script. Next time you don't pay an agent to rediscover the page — you just re-run it.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/8ef300ef-ee0b-4382-8ff0-a78bce88d09f" />


<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/249051ec-5543-4ab0-9f2f-48533817bbca" />


### Console and page errors

Every console message and uncaught page error, filterable by level — errors, warnings, info, logs —
with the source URL. Errors flagged in red.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/ad25e190-4123-43ab-9b74-15644a6fd3c3" />


### Network, request by request

Every request with status, type, size, and timing. Filter by kind, then click any row to inspect its
headers, payload, and response — like a devtools network panel, frozen at the moment it ran.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/a9ea5f94-ba31-480b-abee-bf0350bb4735" />


### The full trace, and every artifact

The raw Playwright `trace.zip`, the network HAR, the console log, the machine-readable `results.json`,
and the self-contained `report.html` — all under `~/.dailies/sessions/<id>/`, all one click away. Open
the trace in Playwright's own viewer with `npx playwright show-trace`.

#### What's safe to share

A session is recorded against a logged-in app, so some artifacts hold real credentials. `report.html`
is the one built to be handed around; the session **directory** is not.

| Artifact | Safe to share | What's in it |
| --- | --- | --- |
| `report.html` | **Yes** — this is the shareable one | Steps, screenshots, video, script, console. No request headers. |
| `results.json` | Yes | Step outcomes, timings, artifact paths. |
| `network.har` | **Scrubbed, but check** | Full traffic. `Cookie` / `set-cookie` / `Authorization` **values are replaced at `session end`** (names kept). Response **bodies are not** — a login response can still hold a token. |
| `trace.zip` | **No** | The same traffic as the HAR, unscrubbed. |
| `profile/` | **No** | A real Chrome profile — an actual cookie database and `Login Data`. |

`--no-scrub-har` keeps the real header values, for when you need to replay the HAR against the same
live session. Nothing is scrubbed retroactively, so sessions recorded before this landed still have
their credentials in `network.har`.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/fdb5efbc-a92d-4eb6-b64c-0f7efb8977a7" />


## Claude Code, natively

In [Claude Code](https://claude.com/claude-code), Dailies is a first-class plugin — skills, subagents,
and `/dailies:*` slash commands. Tell Claude what you changed or what to check; it plans the QA, drives
a real browser, and hands back the report.

```
/dailies:verify              # what changed? → a prioritized QA plan, then record it
/dailies:session             # record a flow end to end and render report.html
/dailies:session-interactive # record collaboratively — the agent asks you, or hands you the browser
/dailies:run                 # drive the browser once, nothing recorded
```

Or skip the slash and just say *"QA the checkout flow and give me a report"* — Dailies's subagents pick
it up. Install the plugin below.

## Use it with your coding agent

Dailies is built for agents — and it explains itself to them. Install it, then **tell your agent to run
`dailies --help`** (and `dailies exec --help` for one-offs): each output is a complete, self-contained
usage guide — sandbox API, worked examples, a Playwright cheat sheet — written for an LLM to read.
No plugin required.

For deeper integration (slash commands, subagents, and skills), install the plugin pack. Dailies ships
as a Claude Code plugin, a Cursor plugin, and a Codex plugin — all pointing at the same `skills/` +
`agents/` + `commands/`. There's no bespoke installer; each agent's own mechanism does the work.

```bash
# Claude Code
/plugin marketplace add quadule/dailies
/plugin install dailies@dailies-marketplace

# Cursor — install "dailies" from the Marketplace, or symlink for local dev:
ln -sfn "$(pwd)" ~/.cursor/plugins/local/dailies

# Codex
codex marketplace add quadule/dailies        # then /plugins → install "dailies"
```

You get **`dailies-scripting`** (the sandbox API, with `references/REFERENCE.md`) plus the workflow
skills **`dailies-verify`**, **`dailies-automate`**, and **`dailies-session`** — each paired with a
subagent and a slash command: `/dailies:verify`, `/dailies:run` (automate), and `/dailies:session`.
There's also **`dailies-session-interactive`** (`/dailies:session-interactive`), which records a
session collaboratively in the main conversation — no subagent — so the agent can pause to ask you,
or hand you the live browser mid-flow (its actions captured as a step).

## Teach it your app

The slowest part of any agent-driven browser run is rediscovering the app: where the login form is,
which routes matter, which selector the framework quietly breaks. Commit that knowledge once, in the
repo the app lives in, and every run starts with it:

```
your-app/
└── .dailies/
    ├── flows.md      how to drive THIS app — read by the agent before it writes a step
    └── config.json   defaults for Dailies itself (optional)
```

`flows.md` is plain markdown with no required structure — sign-in, the routes worth testing, the
selectors that break naive Playwright. Dailies never parses it; the agent reads it. When it turns
out to be wrong, the agent corrects it in place and **tells you what it changed**, so the file gets
better as you use it. Keep it app-specific and short: it's read in full every session, and Dailies
warns when it outgrows a 250-line budget. Generic Playwright or Dailies lessons don't belong there —
those go to the `dailies-scripting` skill.

`config.json` sets defaults so a PR doesn't have to:

```json
{
  "url": "http://localhost:3000",
  "demo": {
    "paths": ["app/views/**", "app/components/**", "app/javascript/**"],
    "prompt": "workshop documentary, dry and factual"
  }
}
```

By default an **LLM decides** whether a change is worth demoing, reading the diff, the PR
description and these hints together — because a path list can't tell that a data backfill or a
background job changes what someone eventually sees on a screen. It also names the flow to record,
which the recording agent uses as its starting point. Set `demo.decide` to `"paths"` for a
deterministic glob match instead, or `"always"` to demo every change; under `"agent"`,
`demo.paths` is a hint, and the fallback when no model provider is available.

Leave `demo.prompt` **unset** unless you specifically want one house style: unset means every
nightly cut draws its own random theme, which is the point of a demo nobody chose to sit down and
watch.

> This file becomes agent instructions, so it's only as trustworthy as the repo it came from. Don't
> point Dailies at a project config from a repo you don't control; the demo workflow deliberately
> skips fork PRs for the same reason.

### Proving which code the demo actually ran

A demo shows a flow working. Coverage answers a different question: *did this session actually
exercise the lines this PR changed?* Dailies has no coverage feature and shouldn't — coverage is
language- and framework-specific, and a browser recorder has no business knowing about your
instrumentation. What it has is the seam: `--attach` puts any external file into the session's
report.

The recipe is the same in every language:

```bash
# 1. Boot the app with coverage instrumentation, exposing a snapshot endpoint.
# 2. Snapshot before — this is your baseline, boot-time coverage included.
your-coverage-tool snapshot > before.json

# 3. Record the session as usual.
id=$(dailies session start --name "checkout" --url http://localhost:3000)
dailies run ./open.js --session "$id" --step open
# …more steps…

# 4. Snapshot after. The DELTA is what this session exercised.
your-coverage-tool snapshot > after.json

# 5. Diff them, and scope the result to the PR's changed lines.
your-coverage-tool report --before before.json --after after.json \
  --base origin/main --out ./cov

# 6. Attach it, and record the headline number so runs can be compared.
dailies session end "$id" --pass \
  --attach ./cov/coverage.md --attach ./cov/report.zip \
  --metric coverage=61.2346
```

The attached files show up in `results.json` and in `report.html` beside the trace and video, so
the recording and the proof travel together. `--metric name=value` records any number you want to
watch over time — Dailies never interprets it. The nightly workflow prints each metric in the PR
comment **with the change since the last run**, which is where the signal is: one coverage number
is weak, the same number dropping from 61 to 3 usually means the recording broke rather than the
code getting worse.

Values are stored at full precision and displayed to four decimals, which is deliberate: on an
application with a few hundred thousand executable lines a single line is ~0.0002% of the total, so
a whole-app coverage number moves by hundredths at most. Rounding it to one decimal would report
every run as unchanged.

Re-running `session end` on an already-ended session is safe — it re-renders with the new
attachments and keeps the verdict — so the recording and the coverage pass don't have to be
interleaved.

Step 1 and 5 are the only language-specific parts:

| Stack | Instrument | Snapshot / report |
| --- | --- | --- |
| Ruby / Rails | Ruby's `Coverage` started before boot, behind an env flag | `Coverage.peek_result` from a dev-only endpoint; render the delta with SimpleCov |
| Node | `c8` / `nyc`, or V8's inspector coverage | `v8.takeCoverage()` or the `c8` JSON output |
| Python | `coverage.py` started in the app's entrypoint | `coverage json` before and after |

Keep that orchestration in the app's own repo — a script plus an agent skill next to
`.dailies/flows.md`, where the app-specific knowledge already lives. That way Dailies stays
language-agnostic and your instrumentation stays where someone can maintain it.

### Nightly demos of your pull requests

Copy [`.github/workflows/dailies-demo.yml`](.github/workflows/dailies-demo.yml) into your repo, add
`ANTHROPIC_API_KEY` plus a voice key (`ELEVENLABS_API_KEY` or `GEMINI_API_KEY`) as repo secrets, and label a
PR **`dailies`**. Each night
it records a demo of every labeled PR whose head has moved since its last demo and whose change a
model (or `demo.paths`) judges worth filming, then posts the video and the full report back to the
PR. Want one now? Comment **`/dailies`** on the PR — anything after it steers the run
(`/dailies record the vendor payment flow`, or a `dailies-theme:` marker), and it's restricted to
commenters with write access. `dailies-url:` / `dailies-theme:` / "plain demo" in a PR body override
the repo defaults for that PR.

## Which model runs it

Narration, song lyrics and the demo decision all ask for the same thing — an object matching a JSON
schema — so any backend that can be talked into schema-shaped JSON qualifies. Three ship, tried in
this order and skipping whatever isn't there:

| Provider | Needs | Notes |
| --- | --- | --- |
| **`claude` CLI** | Claude Code installed | The default. No API key, no local model — if you have Claude Code, it already works. |
| **OpenAI-compatible** | `$DAILIES_LLM_URL` | Any `/v1/chat/completions` endpoint: OpenAI, OpenRouter, LM Studio, Ollama, vLLM, llama.cpp. `$DAILIES_LLM_API_KEY`, `$DAILIES_LLM_MODEL`. |
| **Apple Intelligence** | macOS 26+, Xcode CLT | Fully on-device — no key, no network, nothing leaves the machine. A small Swift helper compiles once into `~/.dailies/bin`. |

Pin one with `$DAILIES_LLM=claude|openai|apple` (pinning disables fallthrough — a silent switch is
worse than a clear failure). Otherwise a provider that fails is skipped and the next one tries; if
they all decline, the run notes name each one and why, and the pass degrades instead of throwing.

Apple Intelligence honors your JSON schema at runtime through `DynamicGenerationSchema`, so it needs
no per-schema Swift. Measured on an M-series Mac: a 30-step narration in ~7s.

**Pick the provider for the job.** On-device is a fine *narrator* — narration has no wrong answer,
and staying local is worth a lot. It is a weaker *judge*: on the borderline demo decisions (a
copy-only edit, a 2px margin nudge) it got 5 of 10 samples right where the `claude` CLI was 12 for
12 on the same suite. The resolve order already puts Apple last, so this only bites if you pin it;
Dailies warns in the log when the demo decision was made on-device.

The Anthropic Messages API isn't a fourth provider — the `claude` CLI already covers Claude, and
this package deliberately ships no runtime dependencies. It would slot in behind the same interface.

## Voices, music and title art

The text provider writes the words; three more slots turn them into a film — a **narrator** to
read them, **music** under the narration (or, with `--song`, the model that sings the lyrics),
and a **title-card image**. Each slot is filled by the first thing that's configured, local
first, then hosted keys, then free stock sources, so a bare install still produces a complete cut:

| Slot | Order | Needs |
| --- | --- | --- |
| **Narrator** | oMLX → ElevenLabs → Gemini → macOS `say` | `$DAILIES_OMLX_URL` (+ key) · `$ELEVENLABS_API_KEY` · `$GEMINI_API_KEY` or `$GOOGLE_APPLICATION_CREDENTIALS` · a Mac (or `$DAILIES_SAY_COMMAND`) |
| **Music** | ACE-Step → ElevenLabs → Gemini (Lyria) → archive.org | `$DAILIES_ACESTEP_URL` · `$ELEVENLABS_API_KEY` · a Gemini key · nothing (free, Creative Commons, attribution in the credits) |
| **Title art** | local image server → Gemini (Nano Banana) → Wikimedia Commons → themed gradient | `$DAILIES_IMAGE_URL` · a Gemini key · nothing · nothing |

**ElevenLabs** switches on narration and music with one key; its image flow (`--image elevenlabs`,
any of the models it relays such as `gemini-3.1-flash-image`) is opt-in because it needs a Pro
plan. `$DAILIES_ELEVENLABS_VOICE` pins a voice by name or id — otherwise one of your voices is
drawn per run, like the theme. `$DAILIES_ELEVENLABS_MODEL`, `_MUSIC_MODEL` and `_IMAGE_MODEL`
override the models (`eleven_multilingual_v2`, `music_v2_5`, `gemini-3.1-flash-image`).

**Pin a slot** when you want a specific one — on the command line, or in a prompt to your agent
("narrate it with ElevenLabs, no music"), which passes it through:

```bash
dailies session end "$id" --cinematic --narrator elevenlabs --music none
dailies session end "$id" --song --music gemini            # Lyria sings the lyrics
DAILIES_NARRATOR=say dailies session end "$id" --cinematic  # the same pins, from the environment
```

A pin is exact, like `$DAILIES_LLM`: the named provider is used, or the slot degrades with a note
— and the narrator (or the singer, with `--song`) skips the pass rather than being quietly voiced
by something else. `dailies session end --help` lists every provider's variables.

## One CLI, one runtime

`dailies-cli` puts a single command on your PATH — **`dailies`**:

| Command | Use it to |
| --- | --- |
| `dailies session …` | Record capture-enabled QA sessions and render reports — the main, user-facing flow. |
| `dailies run` | Run a script as a recorded step inside a session. |
| `dailies exec` | Run a script once — unrecorded, outside any session — for quick one-offs (a file or stdin; `--connect` attaches to a Chrome you already have open). |

Behind them is one background daemon (Playwright + a QuickJS sandbox) that starts automatically when
needed. Stop it anytime with **`dailies stop`** (alias: `dailies daemon stop`) — it shuts down every
browser and session it's running. You can also pass `--stop-daemon` to `dailies session end` to tear
it down as soon as nothing else needs it.

## Scripting

Scripts are plain async JavaScript with top-level `await`.

<!-- dailies:snippet api-sandbox-env -->
Scripts execute inside a QuickJS WASM sandbox with no arbitrary access to the host system.
This is NOT Node.js — there is no module system and no Node API:

- `require()` / `import()` — no module loading; inline any helpers in the script
- `process`, `fs` / `path` / `os` — no process or direct filesystem access (use the file helpers)
- `fetch` / `WebSocket` — no direct network access (the page does the networking)
- `__dirname` / `__filename` — no path globals

Memory and CPU limits are enforced, and both CPU time and wall-clock time are bounded — infinite
loops or never-settling promises abort the script. Values crossing `evaluate` / `$eval` must be
JSON-serializable.
<!-- dailies:end api-sandbox-env -->

<!-- dailies:snippet ex-quickstart fenced=js -->
```js
const page = await browser.getPage("main");          // named, persistent page
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());

const headings = await page.evaluate(() =>
  [...document.querySelectorAll("h1, h2")].map((h) => h.textContent.trim())
);
console.log(JSON.stringify(headings));

// The link navigates — wait for the new page before reading, so the screenshot
// (and any later read) lands on the destination, not the old/half-loaded page.
const href = await page.humanClickAndWaitForURL(
  page.getByRole("link", { name: "More information" })
);
console.log(href);
const buf = await page.screenshot({ fullPage: false });
await saveScreenshot(buf, "page.png");               // saveScreenshot(buffer, name)
```
<!-- dailies:end ex-quickstart -->

**Browser**

<!-- dailies:snippet api-browser -->
- `browser.getPage(nameOrId)` — get-or-create a named page, or attach to an existing tab by the
  `id` from `listPages()`. Named pages persist across steps in a session — call with the same
  name to reuse the tab.
- `browser.newPage()` — an anonymous page, auto-closed when the script ends; does not persist.
- `browser.listPages()` — list every open tab: `[{ id, url, title, name }]` (`name` is `null`
  for tabs you never named).
- `browser.closePage(name)` — close and forget a named page.
<!-- dailies:end api-browser -->

**Files**

<!-- dailies:snippet api-file-helpers -->
All file I/O is async (await it), sandboxed to `~/.dailies/tmp/` (no filesystem escape), and
returns the full path to the file:

- `saveScreenshot(buffer, name)` — persist a screenshot buffer; buffer first:
  `const path = await saveScreenshot(await page.screenshot(), "home.png");`
- `writeFile(name, data)` — write a small file (e.g. JSON state):
  `await writeFile("results.json", JSON.stringify(data));`
- `readFile(name)` — read it back (returns the contents as a string):
  `const data = JSON.parse(await readFile("results.json"));`
<!-- dailies:end api-file-helpers -->

**Output**

<!-- dailies:snippet api-console -->
- `console.log` / `console.info` write to stdout; `console.warn` / `console.error` write to
  stderr. Top-level `console.log` is your script's output channel.
- `console.log` inside `page.evaluate(() => …)` runs in the page and is captured into the
  session's console artifact instead.
<!-- dailies:end api-console -->

<!-- dailies:snippet api-playwright-note -->
Pages returned by `browser.getPage()` and `browser.newPage()` are full Playwright Page objects —
the same API (`goto`, `click`, `fill`, `locator`, `evaluate`, `getByRole`, `waitForSelector`, …):
https://playwright.dev/docs/api/class-page
<!-- dailies:end api-playwright-note -->

**Human interaction & captions.** In recorded sessions, prefer `page.humanClick(target)` and
`page.humanFill(target, text)` over raw `click` / `fill`: they reveal the element, glide the
on-screen cursor onto it, and act through real input (typed text, a true click) so the video reads
like a real user. `page.showCaption(text)` overlays a short caption to label a moment. For a click
that navigates, use `page.humanClickAndWaitForURL(target)` — it captures the URL before the click
and waits race-free for the new page (`page.url()` is client-cached and lags a Turbo/SPA nav).
Settling is otherwise automatic: Dailies settles the page at the end of every step.

For element discovery, `await page.snapshotForAI()` returns an LLM-friendly outline of the page —
the `dailies-scripting` skill and its `references/REFERENCE.md` carry the full API.

## Updating

Already installed? Grab the latest CLIs from npm, then refresh the runtime:

```bash
npm i -g dailies-cli@latest                     # update dailies
dailies install                                 # refresh the runtime (Chromium + Playwright)
```

`dailies install` is safe to re-run — it pulls the browser/runtime versions the new CLI pins. Running
via npx instead of a global install? `npx dailies-cli@latest …` always fetches the newest release.

**Agent integrations** update through each agent's own mechanism:

```bash
# Claude Code — refresh the marketplace catalog, then update from /plugin:
/plugin marketplace update dailies-marketplace
# or turn on auto-update: /plugin → Marketplaces → dailies-marketplace → Enable auto-update
# (third-party marketplaces ship with auto-update OFF)

# Cursor / Codex — update "dailies" from each marketplace UI.
```

Claude Code detects plugin updates by comparing manifest **versions** (bumped every release); Cursor
and Codex do the same against their plugin manifests, so every release makes the latest `skills/`
update-visible.

## Contributing & development

Dailies is a pnpm + Turborepo monorepo: two apps and five packages cooperate to make agent-driven
browser automation reproducible.

<details>
<summary><strong>Repo layout</strong></summary>

```
dailies/
├── apps/
│   ├── dailies/             # dailies-cli      bin: dailies   — the CLI: record QA sessions, render reports, one-off `exec`
│   └── dailies-daemon/      # dailies-daemon   no bin         — Playwright + QuickJS runtime (embedded into the CLI)
├── packages/
│   ├── protocol/           # dailies-protocol         IPC schemas (Zod), single source of truth
│   ├── config/             # dailies-config           shared tsconfig bases
│   ├── logger/             # dailies-logger           pino-backed structured logger
│   ├── cli-kit/            # dailies-cli-kit          shared CLI helpers
│   └── daemon-client/      # dailies-daemon-client    daemon transport + lifecycle; embeds the daemon bundle
├── skills/                 # agent skills: dailies-scripting (+references), -verify, -automate, -session, -session-interactive
├── agents/                 # JTBD subagents: verify-agent, automate-agent, session-agent
├── commands/               # slash commands: /dailies:verify, :run, :session, :session-interactive
├── .claude-plugin/         # Claude Code plugin + marketplace manifests
├── .cursor-plugin/         # Cursor plugin manifest (pairs with rules/)
├── plugins/dailies/         # Codex plugin wrapper (.codex-plugin → canonical skills/)
├── .agents/                # Codex / agents marketplace manifest
├── rules/                  # Cursor rules (dailies-workflows.mdc)
├── examples/               # dev-only demo scripts (Hacker News, Product Hunt, GitHub Trending, Wikipedia)
└── .github/                # CI
```

The `dailies` CLI embeds and supervises `dailies-daemon` (the long-running Playwright host).

</details>

<details>
<summary><strong>Build, test &amp; conventions</strong></summary>

```bash
make install   # pnpm install across the workspace
make build     # build everything in topo order
make test      # run all tests
make check     # compile + lint + test (what CI runs)
```

Run `make` with no args to see all targets.

- **Conventional Commits** enforced via `commitlint` + a husky `commit-msg` hook.
- **Linting & formatting** via [Ultracite](https://docs.ultracite.ai/) (Biome) — `pnpm lint` checks, `pnpm format` autofixes; pre-commit runs `lint-staged` → `ultracite fix` on staged files.
- **Logging** via `dailies-logger` (pino, structured). Set `DAILIES_LOG_LEVEL` (trace|debug|info|warn|error|silent); the CLI also accepts `--verbose`/`-v`.
- **Node 20+** and **pnpm 9.15.0** (see `.nvmrc` and `packageManager`).
- **Turbo** orchestrates builds (`turbo run build`, `dev`, `test`, `compile`); lint/format run via Ultracite at the root.

</details>

See [`AGENTS.md`](AGENTS.md) for architecture and orientation, [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the contribution flow, and [`RELEASING.md`](RELEASING.md) for the publish pipeline.

## License

MIT. Dailies's daemon and CLIs are derived in part from MIT-licensed work by
[Sawyer Hood](https://github.com/SawyerHood) — see [`LICENSE`](LICENSE).
