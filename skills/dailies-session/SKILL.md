---
name: dailies-session
description: Record a verifiable QA session with Dailies — explore a flow step by step against one persistent browser, each script a recorded step that captures a Playwright trace, video, network HAR, and console, then render a self-contained report.html. Use when the user wants to verify or QA a flow, produce evidence or a report, or capture a trace/video of a browser run. Trigger phrases — "record a session", "QA this flow", "verify the checkout", "capture a trace", "give me a report of this run".
allowed-tools:
  - Bash(dailies:*)
  - Bash(npx dailies-cli:*)
license: MIT
metadata:
  author: dailies
  version: 0.6.0
  category: workflow
  tags:
    - dailies
    - qa
    - testing
    - report
---

# Dailies session (recorded QA)

Work the flow like a tester — observe, act, adapt — not as a pre-written script. Every script runs
as a **step** against one persistent browser; Dailies records trace / video / HAR / console and
renders a self-contained `report.html`.

## Start here — read before your first command

<!-- dailies:snippet rule-start-here cli=npx-cli -->
- STOP — before your FIRST `npx dailies-cli` command (a `session start` counts), read the
  **dailies-scripting** skill in full: invoke it (in this repo you can also open
  `skills/dailies-scripting/SKILL.md`). It holds the script API and the observe-first and
  human-interaction rules this skill relies on, and this skill does not repeat them. Don't start a
  session without it.
- Follow the workflow's commands as written — don't run `--help` to explore. Only when you need a
  specific flag and aren't sure of it, check `npx dailies-cli <command> --help` instead of guessing.
- Drive every recorded click and text entry with `page.humanClick` / `page.humanFill`, never raw
  `click` / `fill`. This is not optional.
- Reach a page by clicking the control a real user sees (e.g. the login button on the main login
  page), not by brute-forcing a hidden widget. If a step times out, STOP and take the obvious path
  instead of retrying the same dead end.
- `humanClick` returns BEFORE a navigation commits, so don't read `page.url()` or `snapshotForAI()`
  on the next line — you'll get the OLD page. Make the navigating click the step's last action and
  look with a peek (`npx dailies-cli run --session <id> --peek`), or use `page.humanClickAndWaitForURL(link)`
  for a click that really navigates. `npx dailies-cli session url <id>` prints the live URL.
- A click returning is NOT success. Before you submit, confirm the submit control is enabled and
  every required field / checkbox is satisfied; afterward, verify the change actually persisted. A
  disabled or validation-blocked submit saved nothing — never report that run as passed.
<!-- dailies:end rule-start-here -->

<!-- dailies:snippet rule-test-as-user -->
- Drive the real user flow in the browser FIRST. Do NOT change the environment to set up or "fix" a
  precondition before you've tried the flow as a user — no Rails/DB console, env vars, feature-flag
  flips, seed scripts, or API calls to manufacture state. The thing you were asked to verify is
  sacred: never reset, clear, bypass, or fake it. (Asked to show a Terms-of-Service prompt appears?
  Do NOT clear the user's ToS acceptance — that prompt IS the point, and the environment was likely
  prepared so it shows.) Reading the code or inspecting state to understand the flow is fine, but
  only AFTER you've attempted to drive it from the browser, and strictly read-only — never mutate.
- Weigh what you were asked. Verifying a change or feature → be conservative: the setup IS the test,
  so touch nothing and drive exactly what a real user would. Only performing or recording a workflow
  (no pass/fail claim) → more leeway to arrange incidental preconditions, but still drive as a real
  user and never mutate what the run is meant to show.
<!-- dailies:end rule-test-as-user -->

<!-- dailies:snippet rule-blocked-autonomous -->
- No live user to ask here. Blocked by something only an operator can do (no login credentials, a
  feature flag, a settings change, manual setup)? Do NOT brute-force it, manufacture it (console /
  DB / API / seed), fake it, or silently skip it — that defeats the test. End the session so the
  report still captures what you got, then report exactly what blocked you, with the evidence — never
  fabricate a pass. If a human could unblock it, say the flow needs the interactive variant
  (dailies-session-interactive), where someone can take over the live browser.
<!-- dailies:end rule-blocked-autonomous -->

## When to use

- Verifying or QA-ing a user flow and producing shareable evidence.
- Capturing a Playwright trace, video, or network HAR of a run.
- Any run where "what happened?" needs a report (for a quick one-off, use **dailies-automate**).

## Examples

### Example 1: verify a flow
User says: "QA the checkout flow and give me a report" or "verify login works"
Start a session, explore-and-record the flow step by step, end it, point to `report.html`.

### Example 2: capture a trace
User says: "record a trace of the signup" or "I need a video of this bug"
One session, small steps that reproduce it, `session end` — the report bundles trace, video, HAR, console.

## Workflow (the explore-and-record loop)

1. Runtime: if `dailies` (or `npx dailies-cli`) already runs, it's installed — don't reinstall.
   Only run `npx dailies-cli install` if a command reports the runtime/browser is missing.
2. Start: `id=$(npx dailies-cli session start --name "<flow>")`
3. **LOOK** — read the page with a peek, which records nothing (the first page load is a step, or
   pass `--url` to `session start`):
   ```sh
   npx dailies-cli run --session "$id" --peek <<'EOF'
   const page = await browser.getPage("main");
   console.log(page.url(), await page.title());
   console.log((await page.snapshotForAI()).full); // aria outline — pick selectors from this
   EOF
   ```
4. **DECIDE** the next thing a viewer would name — "sign in", "fill in the W-4" — from stdout.
5. **ACT** — run it as one intent-named step, the whole form and its submit together:
   `npx dailies-cli run --session "$id" --step submit-login-form <<'EOF' …` (a `./step.js` file works
   too). Add `--skim` when it's setup or a detour rather than the thing under test. Reuse the same
   named page so each step picks up where the last left off, and end the script by logging what the
   next decision needs.
6. **READ** stdout + exit code. Failed? Peek at where the page is, then retry as a NEW step —
   duplicates are honest evidence, and a failed step does not end the session.
7. Repeat 3–6 until the flow is done; finish with explicit assertion step(s): expected text / URL /
   state, logging `PASS`/`FAIL`.
8. End + render, declaring your verdict: `npx dailies-cli session end "$id" --pass` (or
   `--fail "<reason>"`) → `~/.dailies/sessions/<id>/report.html`. Your verdict sets the report's
   PASS/FAIL; a recovered/retried step failure stays as evidence but won't fail the run.
   One video is recorded per page, and only one gets finished: the page your LAST step ended
   on, which is normally the one you were demonstrating. Override with `--video <page name>`
   when it isn't — e.g. you finished on a settings page after the flow you actually want.
9. Report the `report.html` path and the video path so the user can open them.
10. Done? Leave the daemon running for the next session, or `npx dailies-cli stop` to shut it
    (and every browser) down — or pass `--stop-daemon` to step 8 (`session end --stop-daemon`).

## Explore vs batch

- Unknown UI → peek before acting, selectors picked from snapshots. Peeks cost nothing in the
  report, so look as often as you need — but still act in viewer-sized steps.
- Known flow (user gave exact steps, or you already verified the UI) → skip the peeking and
  batch the flow into a few named steps. Re-checking what you already know just costs time.

## Hard rules

<!-- dailies:snippet rule-steps cli=npx-cli -->
- LOOK with a peek, not a step: `npx dailies-cli run --session "$id" --peek` runs a script against the live
  page and records nothing — no step, no screenshot, no report entry. Snapshots, `page.url()`,
  `evaluate` and locator reads all work; clicks, typing, navigation, scrolling, captions and
  effects are refused, because footage between steps is cut from the film. A step is something a
  viewer watches happen; a peek is you reading the screen.
- Size steps the way a viewer would name them: "fill in the W-4", "sign Section 1", "invite the
  worker" — not one step per radio button or field. A step can fill a whole form and submit it.
  Five steps for five answers on one page is five rows a reviewer scrolls past, and five more
  model round trips. Split only where you need to read the result before deciding what to do.
- End a step by logging only what the next decision needs — the URL, a heading, a `{ track }` diff,
  or a scoped `ariaSnapshot()` of what you will act on next — so the next look is often
  unnecessary. Don't end steps with a whole-page outline out of habit: after a navigation `{ track
  }` resets and returns the whole page again, and each outline is tens of thousands of characters
  you then read.
- Mark setup and detours with `--skim`: signing in, flipping a setting, finishing unrelated
  onboarding to reach the feature, filling a form only because the flow demands it. The finished
  video fast-forwards through a run of skimmed steps, captions and all. Leave it off the steps
  that show the thing under test. Uncaptioned stretches are sped up too, so caption the moments
  that matter.
<!-- dailies:end rule-steps -->

<!-- dailies:snippet rule-screenshot cli=npx-cli -->
After each `npx dailies-cli run --step`, the daemon auto-captures ONE screenshot of the step's
last-opened tab and binds it to that step in the report. So:

- Keep one primary named page per step — the report screenshot is always the page you mean.
- If a step opens several tabs, open the one you want featured last.
- `saveScreenshot(...)` images land in `~/.dailies/tmp/` and are NOT in the report — they're
  extras for debugging.
<!-- dailies:end rule-screenshot -->

<!-- dailies:snippet rule-caption -->
- Captions carry the narration the video can't: WHY you're doing something, what to watch for, or
  why a result matters. Use `await page.showCaption("…")` generously — open each meaningful step or
  section with a one-line "why". The bar is "would a viewer understand the reason without me
  here?", not "is this strictly necessary?".
- Don't echo the screen: a caption that restates an action ("Click Submit") or the step name is
  noise. Caption the reasoning, the precondition, or what to watch for — never the click itself.
- Always caption a deviation from what was asked — a workaround, a precondition you set up, an
  unrequested path to the feature. No one is watching live, so a one-line "doing X because Y" tells
  a later viewer the detour was deliberate.
- Keep each caption to ONE short sentence that fits two lines on screen (~100 characters); split a
  longer thought across successive steps. `{ durationMs }` is a FLOOR, not a cap: a caption always
  gets time to be read, and the video under it is never trimmed away.
- Nothing is drawn into the page while recording. Captions are stored as timed data and rendered at
  `session end`, so one recording can be finished plain, cinematic or song — and in a cinematic cut
  your text also feeds the narration. Write captions the same way whatever the run will become.
- `session end --song` scores the run with one AI-generated song whose lyrics are about the steps,
  captions timed to the singing. The random theme is the point: do NOT pass `--prompt` on your own
  initiative. Pass `--prompt "<their words>"` only when the user asked for a genre or vibe, using
  their words rather than a theme you invent. `--no-captions` drops the burned lyric subtitles. It
  needs a text provider and a lyrics-capable music model; `session end --help` lists the providers,
  transcribers and environment variables.
- Dailies picks who voices, scores and paints the cut from what's configured. When the user names a
  provider for a slot, pass it through on `session end`: `--narrator
  <elevenlabs|gemini|omlx|piper|say>`, `--music <elevenlabs|gemini|acestep|archive|none>` (also the
  singer with `--song`), `--image <elevenlabs|gemini|local|wikimedia|gradient|none>`. Each pins
  that slot (names like "Lyria" or "ACE-Step" work as aliases) and implies `--cinematic`. Leave off
  any provider the user didn't mention — a pinned provider that isn't set up fails loudly.
<!-- dailies:end rule-caption -->

<!-- dailies:snippet rule-effects -->
- Direction is a budget. The camera helpers — `page.showSpotlight`, `page.circle`,
  `page.underline`, `page.pointAt`, `page.highlightText`, `page.lookAt` — each cost real seconds of
  film, and they only work by CONTRAST: once a step they tell a viewer where to look; on every
  interaction they tell them nothing. Budget about ONE emphasis per step, on its most important
  moment. A step with no subtle moment needs none — `humanClick` / `humanFill` already glide the
  cursor, settle and ripple.
- Use an effect only when the thing would otherwise be MISSED: it is small (a 14px validation
  message), off to one side (a badge in a table row), one of many alike (the third row's toggle), or
  it CHANGED rather than appeared (a total recalculating, a button turning enabled). If the eye is
  already on it — the only thing on screen, or what you just clicked — skip it.
- Pick by what the thing IS:
  - `showSpotlight(target)` — the surroundings are the problem (a dense page, a busy table, a
    twelve-field form): the surround darkens and only the target stays. The default and strongest
    choice, and the closest Dailies gets to a zoom (a real zoom would move where clicks land).
  - `highlightText(target)` — the WORDS matter: an error message, an amount, an ID, a status. Use
    it instead of a spotlight whenever the thing to read is a phrase.
  - `circle(target)` — the shape or position matters: an icon, an avatar, a chart region, an
    unlabeled control.
  - `underline(target)` — the lightest: a heading or label you are about to talk about.
  - `pointAt(target)` — a quick "there" when the eye needs moving but nothing held.
  - `lookAt(target)` — no emphasis, just the cursor resting a beat longer. The right choice far
    more often than the others.
- Hold before you act, not after: spotlight the field, THEN fill it; highlight the error, THEN
  explain it. An effect after the interaction it should set up just delays the run.
- Pair one effect with one caption saying DIFFERENT things: the effect says where to look, the
  caption why it matters. A caption that just names the spotlighted thing says it twice.
- A hold is the cheapest effect. When a result lands — a success flash, a total updating, a new
  row — rest on it with `lookAt` on what changed, or a caption (its span is never trimmed), rather
  than a bare `waitForTimeout`: a still page with nothing pointed at is dead footage that `session
  end` condenses away.
- Don't direct a failure. When a step fails or an assertion doesn't hold, caption what went wrong
  and leave effects off — a flourish over a broken flow reads as celebrating it.
<!-- dailies:end rule-effects -->

<!-- dailies:snippet rule-pass-fail -->
- Decide pass/fail ONLY against the flow's stated success criteria — the behavior you set out to
  verify. YOU own the run's verdict: declare it when you finish with `session end --pass` or
  `session end --fail "<reason>"`. A failed INTERMEDIATE step is not a failed run — a click that
  timed out, a dead end you backed out of, or a retry you abandoned are honest evidence in the
  report but do NOT decide the outcome; only your declared verdict does. So don't contort the flow
  to keep every step green — take the obvious path, and if a step fails, recover and carry on, then
  judge the whole run at the end. (Declare no verdict and the run falls back to "failed if any step
  exited non-zero" — fine for a quick human run, but as the agent you should almost always declare.)
- Console and page errors are captured as evidence, not verdicts. They DON'T by themselves fail a
  run — most are pre-existing noise (third-party scripts, analytics, unrelated warnings). Treat an
  error as a failure only when it IS the thing under test or actually blocks the flow.
- Same for the network: a non-2xx response (e.g. a 422 from form validation) is not a failure
  unless it's the behavior you're verifying. Expected validation, or an error on a field unrelated
  to the change, is not a regression — note it (`WARN`) and move on.
- When unsure, judge against intent — "did the thing I'm testing work?", not "did anything on the
  page emit an error?". Record incidental issues so a human can see them; don't fail the run on them.
<!-- dailies:end rule-pass-fail -->

<!-- dailies:snippet rule-fail-fast cli=npx-cli -->
- End each script by logging the state you need for the next decision — stdout is your
  observation channel.
- A missing element fails its action after 10s, not Playwright's 30s. Don't raise that globally;
  pass `{ timeout }` to the one wait you know is slow (a long server job). `run --timeout` caps
  the whole step, which a long `humanFill` can legitimately need.
- In assertion / extraction steps, degrade gracefully — log a `WARN` / `FAIL` line instead of
  crashing, so the step still records its evidence. While exploring, a missed selector means
  look again (peek, fix, retry as a new step), not a silent fallback.
- End before you stop: `npx dailies-cli stop` shuts the daemon down and aborts any live session,
  skipping its report.html — always `npx dailies-cli session end <id>` first.
<!-- dailies:end rule-fail-fast -->

- **Name every step by intent** (`fill-shipping-address`, `submit-login-form`), not mechanics
  (`step-3`) — the report timeline should read as a QA narrative.
- Don't invent API shapes; use the dailies-scripting reference.
- Use `session abort <id>` only to salvage a broken run.
