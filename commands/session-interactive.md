---
description: Record a Dailies QA session collaboratively in this conversation (no subagent).
argument-hint: "[flow to record]"
allowed-tools:
  - Bash(dailies:*)
  - Bash(npx dailies-cli:*)
---

Your FIRST action is to load the **dailies-session-interactive** skill with the Skill tool and
follow it. Do not run any `dailies` command or take any other action before it is loaded — it holds
the full workflow and the non-negotiable rules below. Unlike the other Dailies commands this one
does NOT delegate to a subagent: run it in THIS conversation, so the user can take over the live
headed browser for steps you can't do (logging in, enabling a feature flag, changing settings) and
you capture what they do as recorded steps.

The non-negotiables (the skill has the detail — these are here so they bind even before it loads):

<!-- dailies:snippet rule-start-here cli=npx-cli -->
- STOP — before your FIRST `npx dailies-cli` command (not just before writing a script), read the
  **dailies-scripting** skill in full: invoke the dailies-scripting skill (in this repo you can also
  open `skills/dailies-scripting/SKILL.md`). It holds the script API and the interaction rules the
  rest of this skill relies on. Don't start a session without it.
- Follow the workflow's commands as written — don't run `--help` just to explore. Only when you
  need a specific flag and aren't sure of it, check `npx dailies-cli <command> --help` instead of guessing.
- Drive every recorded click and text entry with `page.humanClick` / `page.humanFill`, never raw
  `click` / `fill`. This is not optional.
- Reach a page by clicking the control a real user sees (e.g. the login button on the main login
  page), not by brute-forcing a hidden widget. If a step times out, STOP and take the obvious path
  instead of retrying the same dead end — and use `--timeout 10` so a wrong turn fails fast instead
  of burning 30s.
- A click that navigates (Turbo / SPA especially) finishes asynchronously — `humanClick` returns
  BEFORE the navigation commits, so do NOT read `page.url()` or `snapshotForAI()` on the next line
  (you'll get the OLD page; `page.url()` is also client-cached and lags a Turbo nav). Two correct
  options: (1) make the navigating click the LAST action of the step and observe at the start of the
  next — Dailies settles the page at each step boundary, so it's already on the committed destination;
  or (2) to stay in the same step, `const href = await page.humanClickAndWaitForURL(link)`. To check
  where you landed between steps without a recorded run, `npx dailies-cli session url <id>` prints the live
  committed URL (read-only, fast).
- A click returning is NOT success. Before you submit, confirm the submit control is enabled and
  every required field / checkbox is satisfied; afterward, verify the change actually persisted. A
  disabled or validation-blocked submit saved nothing — never report that run as passed.
<!-- dailies:end rule-start-here -->

If the user described a flow ("$ARGUMENTS"), record that; otherwise ask what to record.
