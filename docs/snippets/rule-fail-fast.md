- End each script by logging the state you need for the next decision — stdout is your
  observation channel.
- A missing element fails its action after 10s, not Playwright's 30s. Don't raise that globally;
  pass `{ timeout }` to the one wait you know is slow (a long server job). `run --timeout` caps
  the whole step, which a long `humanFill` can legitimately need.
- In assertion / extraction steps, degrade gracefully — log a `WARN` / `FAIL` line instead of
  crashing, so the step still records its evidence. While exploring, a missed selector means
  look again (peek, fix, retry as a new step), not a silent fallback.
- End before you stop: `{{cli}} stop` shuts the daemon down and aborts any live session,
  skipping its report.html — always `{{cli}} session end <id>` first.
