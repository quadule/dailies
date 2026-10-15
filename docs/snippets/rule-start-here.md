- STOP — before your FIRST `{{cli}}` command (not just before writing a script), read the
  **dailies-scripting** skill in full: invoke the dailies-scripting skill (in this repo you can also
  open `skills/dailies-scripting/SKILL.md`). It holds the script API and the interaction rules the
  rest of this skill relies on. Don't start a session without it.
- Follow the workflow's commands as written — don't run `--help` just to explore. Only when you
  need a specific flag and aren't sure of it, check `{{cli}} <command> --help` instead of guessing.
- Drive every recorded click and text entry with `page.humanClick` / `page.humanFill`, never raw
  `click` / `fill`. This is not optional.
- Reach a page by clicking the control a real user sees (e.g. the login button on the main login
  page), not by brute-forcing a hidden widget. If a step times out, STOP and take the obvious path
  instead of retrying the same dead end. A locator action that can't find its element fails after
  10s; pass `{ timeout }` only to a wait you know is slow.
- A click that navigates (Turbo / SPA especially) finishes asynchronously — `humanClick` returns
  BEFORE the navigation commits, so do NOT read `page.url()` or `snapshotForAI()` on the next line
  (you'll get the OLD page; `page.url()` is also client-cached and lags a Turbo nav). Two correct
  options: (1) make the navigating click the LAST action of the step and look with a peek (`{{cli}}
  run --session <id> --peek`) — Dailies settles the page at each step boundary, so it's already on
  the committed destination; or (2) to stay in the same step, `const href = await
  page.humanClickAndWaitForURL(link)` — only for a click that really navigates; on a drawer, a
  modal or a form that may re-render it waits out its whole timeout. `{{cli}} session url <id>`
  prints the live committed URL (read-only, fast).
- A click returning is NOT success. Before you submit, confirm the submit control is enabled and
  every required field / checkbox is satisfied; afterward, verify the change actually persisted. A
  disabled or validation-blocked submit saved nothing — never report that run as passed.
