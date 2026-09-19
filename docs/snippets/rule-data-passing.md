- Browser state persists across steps: named pages (and their cookies) stay open between scripts
  within a session — reuse the same page name so each step picks up where the last left off.
- Anonymous `newPage()` tabs are closed when each script ends.
- To pass values between steps: `writeFile("state.json", JSON.stringify(x))` in one step,
  `JSON.parse(await readFile("state.json"))` in the next.
- Keep credentials OUT of step scripts. Every step's script text is stored verbatim in the
  session's `results.json` and `report.html` — the shareable artifacts — so a password typed as a
  literal (`humanFill(field, "hunter2")`) ships with the report. Only a fill on a password-looking
  field is redacted automatically. Put secrets in a file the run reads instead
  (`JSON.parse(await readFile("creds.json"))` after the user places it in `~/.dailies/tmp/`), or
  hand the sign-in to the user via takeover, and never echo a secret with `console.log`.
