---
description: Automate a one-off browser task with Dailies — navigate, click, scrape, screenshot — and return the result.
argument-hint: "<what to automate>"
---

Delegate to the `automate-agent` subagent. Give it the task: **$ARGUMENTS**.

Ask it to write a Dailies script (using the `dailies-scripting` API), run it with
`npx dailies-cli exec`, and report the result. For a *recorded* run with a report instead of a
one-off, use `/dailies:session`.
