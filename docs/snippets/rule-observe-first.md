- Unknown page? Snapshot first, then act: read `(await page.snapshotForAI()).full`, pick a
  semantic selector from it (`getByRole`, `getByText`), then interact. Never guess selectors blind.
  Known page or selectors? Skip the snapshot and use them directly — faster and more reliable.
- On a long or dynamic form, list EVERY required field in ONE pass before you fill anything —
  don't discover requirements one failed submit at a time. They show in the snapshot as an asterisk
  or "required" in a field's accessible name; confirm with one DOM sweep, e.g.
  `page.$$eval("[required], [aria-required='true']", els => els.map(e => e.name || e.id))`. Fill
  all of it, THEN submit. Choosing an option (employment type, a guild) can rebuild the form with a
  NEW required section, so list again after any interaction that rebuilds it.
- A new page often renders asynchronously (client-side routing swaps content without a document
  load), so don't snapshot or assert the instant a click returns. Act on or wait for a KNOWN
  element of the destination (`getByRole`/`getByText`) — Playwright auto-waits for it. Need the
  result in the SAME step? `await page.humanClickAndWaitForURL(link)` waits for the URL and load in
  one call — only for a click that really navigates; on a drawer, a modal or a form that may
  re-render in place it waits out its whole timeout. Otherwise don't wait at all: Dailies settles
  the page (load, network idle, DOM quiet) at the END of every step, so end the step and look at
  the start of the next. Avoid fixed `waitForTimeout`. `waitForLoadState("load")` /
  `"domcontentloaded"` are fine; `"networkidle"` can hang on apps with long-lived HTTP (SSE,
  long-polling, heartbeats) — an open WebSocket alone does not block it.
- `page.url()` is cached and lags a client-side navigation — a Turbo/SPA visit changes it only once
  its fetch lands (the next step's page reads it correctly). For the post-navigation URL within a
  step, use what reads the live `location.href`: `page.humanClickAndWaitForURL(link)` (returns the
  new href), `page.waitForURLChange({ from })`, `page.waitForURL(<url|regex|fn>)` for a known
  destination, or `await page.evaluate(() => location.href)`.
