---
name: dailies-verify
description: Turn a code change into a prioritized browser-QA plan with Dailies — read the git diff, infer which user-facing workflows it touches, suggest the concrete flows and the checks that must hold, then optionally record those flows as a session with a report.html. Use when the user has changed code and asks what to test, wants to QA a diff, branch, or PR, or wants a focused regression plan before merging. Trigger phrases — "what should I test for this change", "QA my diff", "verify this PR", "I changed X, what flows might break", "regression plan for this branch", "what should I QA before merging".
allowed-tools:
  - Bash(dailies:*)
  - Bash(npx dailies-cli:*)
license: MIT
metadata:
  author: dailies
  version: 0.5.0
  category: workflow
  tags:
    - dailies
    - qa
    - testing
    - regression
    - planning
---

# Dailies verify (change → QA plan)

Read a code change, infer the **user-facing workflows** it affects, and suggest a **prioritized QA
plan** — the concrete Dailies flows that verify them. Then optionally hand off to **dailies-session** to
record those flows and produce `report.html`.

<!-- dailies:snippet rule-drive-with-dailies cli=npx-cli -->
- Drive the browser only through Dailies — the `npx dailies-cli` CLI and the scripts it runs. Do NOT use
  Claude in Chrome, a computer-use / screenshot tool, or any other browser automation to navigate,
  click, fill, or read a page, even for a single step. Those bypass Dailies's sandbox, the on-screen
  cursor, and the trace / video / HAR capture, so nothing is recorded or verifiable. If a step
  tempts you toward another browser tool, write a Dailies script instead.
<!-- dailies:end rule-drive-with-dailies -->

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

<!-- dailies:snippet rule-scripting-reference cli=npx-cli -->
- The dailies-scripting skill is the full scripting reference — the custom page and locator API, the
  observe-first and human-interaction rules, and the sandbox limits. Load it and read it in full
  before your first command — not just before writing a script (a `session start` counts).
- Need a specific flag and aren't sure of it? Check `npx dailies-cli <command> --help` rather than guessing
  — but don't run `--help` routinely or to explore; the skills already give you the commands. And
  --help only covers syntax: it omits the agent rules (observe-first, the human-interaction helpers,
  pass/fail), so read the dailies-scripting skill for those.
<!-- dailies:end rule-scripting-reference -->

## When to use

- The user changed code and asks **what to test** or what might regress.
- QA-ing a **diff, branch, or PR** before merging.
- Building a focused **regression plan** scoped to the change — not a full re-test.
- Only need the suggestion? Stop at the plan. Need evidence? Hand off to **dailies-session**. Driving a
  browser once with no plan? Use **dailies-automate**.

## Examples

### Example 1: verify the working tree
User says: "what should I QA for these changes?" or "verify my diff"
Read the working-tree diff, map changed files to affected routes/flows, and present a ranked plan
(P0/P1/P2). Offer to record the P0 flows as a session.

### Example 2: verify a branch or PR before merge
User says: "regression plan for feature/checkout" or "QA this PR"
Diff the branch against its base, group the touched workflows, suggest the steps per flow, and hand
the approved flows to **dailies-session** for a report.

## Workflow

1. **Get the diff.** Working tree: `git diff` and `git diff --staged`. A branch/PR:
   `git diff <base>...HEAD` (list files with `git diff --name-status <base>...HEAD`). Or reason
   straight from a prose description ("I changed the login redirect") — skip git.
2. **Infer affected workflows.** For each changed file, decide whether it touches a user-facing
   route/page/flow, and group by **workflow** (sign-up, checkout, …), not by file. File→workflow
   heuristics are in [`references/REFERENCE.md`](references/REFERENCE.md).
3. **Suggest a prioritized plan.** For each workflow: a one-line intent, a **P0/P1/P2** priority, the
   entry URL, the **checks that must hold** (visible text / URL / state that proves the change works),
   the likely phases as a guide — not a pre-written script — and which changed files put it at risk.
   Tie checks to the change under test, not incidental noise (see *Hard rules*). Use the plan template
   in [`references/REFERENCE.md`](references/REFERENCE.md).
4. **Confirm, then hand off.** Present the plan and ask which flows to record. For approved flows,
   follow **dailies-session**'s explore-and-record loop (one session per flow: observe the live page,
   small intent-named steps, assertion steps for the checks) → `report.html`; offer **dailies-review**
   to open it. Don't record flows the user didn't approve.

## Hard rules

- **Suggest first, record second** — the default output is the plan; only record after the user confirms.
- Map to **user-facing workflows**, not files. Call out non-UI changes (pure refactors, types,
  config/build, docs) as **no browser QA needed** rather than inventing a flow.
- **Read-only on the repo** — inspect the diff and code; never stage, commit, or modify source.
- Recording reuses **dailies-session** — don't reinvent `session start` / `run` / `session end` here.
- No diff (or all non-UI)? Say so plainly and stop — don't fabricate a plan.

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

<!-- dailies:snippet rule-caption -->
- Captions carry the narration the video can't: WHY you're doing something, what a viewer should
  watch for, or why a result matters. Reach for `await page.showCaption("…")` generously to explain
  intent — open each meaningful step or section with a one-line "why" rather than saving captions
  only for detours. The bar is "would a viewer understand the reason without me here?", not "is this
  strictly necessary?".
- Don't echo the screen, though: a caption that restates an action ("Click Submit") or repeats the
  step name is noise. Caption the reasoning, the precondition, or what to watch for — never the
  click itself.
- Always caption a deviation from what was asked — when you improvise a workaround, set up a
  precondition, or take an unrequested path to reach the feature under test. In a non-interactive
  run no one is watching live, so a one-line "doing X because Y" is what tells a later viewer the
  detour was deliberate, not a mistake.
- Keep each caption to ONE short sentence — it must fit two lines on screen (~100 characters);
  anything longer is clamped and the overflow is lost. Split a longer thought across captions on
  successive steps. They fade after a few seconds (pass `{ durationMs }` to adjust).
- Recording for a cinematic edit? Start with `dailies session start --cinematic`. The overlay is
  then suppressed (the themed captions burned in by `session end --cinematic` replace it), but the
  text you pass still feeds the narration as your stated intent — so keep writing captions exactly
  as you would otherwise; they're the clearest signal of WHY each step matters.
- Want a music video instead of spoken narration? `session end --song` scores the whole run with
  one AI-generated song whose lyrics are written about the steps, captions timed to the singing
  (still record with `session start --cinematic` to suppress overlays). The random theme is the
  point, so do NOT pass `--prompt` on your own initiative — omit it and let it draw. Pass
  `--prompt "<their words>"` only when the user asked for a specific genre or vibe, and pass their
  words through rather than inventing a theme for them. `--no-captions` drops the burned lyric
  subtitles. Needs the `claude`
  CLI plus a lyrics-capable music model — a local/remote ACE-Step server (`$DAILIES_ACESTEP_URL`) or
  a Gemini key. Captions are timed to the actual vocals when a transcriber is found on PATH
  (autodetected, English-only: `whisperx` → `mlx_whisper` → whisper.cpp `whisper-cli`; models come
  from the HuggingFace cache); override with `$DAILIES_TRANSCRIBER`, `$DAILIES_WHISPER_CLI`,
  `$DAILIES_WHISPER_MODEL`. For the tightest timing, point `$DAILIES_TRANSCRIBE_URL` at an
  OpenAI-compatible server (e.g. a local Whisper-Large-v3-Turbo; `$DAILIES_TRANSCRIBE_MODEL` /
  `$DAILIES_TRANSCRIBE_API_KEY`) — it wins over the CLI backends. `$DAILIES_SONG_FILE` reuses a generated song. The voice/music env vars ($DAILIES_SAY_COMMAND, $DAILIES_OMLX_URL, …) are listed in
  `dailies session end --help`.
<!-- dailies:end rule-caption -->
- In a verify recording, lean especially hard on captions to explain the **why relative to the
  change under test** — "checking the redirect the PR changed lands on /dashboard", "this is the
  validation the change adds". The recording is evidence for a reviewer who knows the diff, so each
  captured moment should say which part of the change it proves.
