---
name: dailies-automate
description: Drive a real browser for a one-off task with Dailies — navigate, click, fill, scrape, screenshot — and return the result. Nothing is recorded. Use when the user asks to automate a browser task, scrape a page, fill a form, or check something on a site without needing a report. Trigger phrases — "go to X and get Y", "scrape this page", "automate this browser task", "log in and check", "take a screenshot of".
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
    - browser-automation
    - scraping
---

# Dailies automate (one-off)

Run a script against a real browser and return the result — ephemeral, nothing recorded.

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

- A quick, one-shot browser task: navigate, extract, fill, screenshot.
- Scraping or checking a page where you don't need a trace / video / report.
- For a recorded, verifiable run **with** a report, use **dailies-session** instead.

## Examples

### Example 1: scrape
User says: "get the top 10 Hacker News titles" or "scrape the headlines"
Write a script that opens the page and `evaluate`s the data, run it, return the JSON it logs.

### Example 2: check
User says: "is the pricing page up and what's the headline?" or "screenshot the homepage"
`goto`, read the element (or `screenshot`), report.

## Workflow

1. If the runtime isn't installed: `npx dailies-cli install` (one-time; downloads Chromium).
2. Write a short, focused script with the dailies-scripting API (`browser.getPage`, `page.goto`,
   `locator`/`evaluate`, `console.log` the result), observing first on unknown pages (see *Hard
   rules*).
3. Run it: `npx dailies-cli exec ./script.js` (or pipe the script via stdin).
4. If the result is empty or a selector missed, **observe and retry**: run a second short script that
   logs `page.url()`, `page.title()`, and `(await page.snapshotForAI()).full` (or a targeted
   `locator(...).count()`), pick a better selector, re-run. Named pages persist between runs, so
   state carries over.
5. Report the script's stdout. On optional extractions, degrade gracefully (log a `WARN`, don't
   crash) — but don't paper over a miss you can fix by observing.
6. Cleanup (optional): the run leaves a shared background daemon up for reuse. To shut it (and any
   browser) down, run `npx dailies-cli stop` (alias of `dailies daemon stop`).

## Hard rules

- Follow the observe-first and human-interaction rules in **dailies-scripting** for every script —
  this skill doesn't repeat them.
