- `page.snapshotForAI()` returns `{ full, incremental?, chars, hint? }`. `full` is a deep aria
  outline of the WHOLE page, whatever the scroll position: roles, accessible names, and `[ref=eN]`
  markers on actionable nodes. Read it to pick a semantic selector — `page.getByRole("button", {
  name: "Continue" })`, `page.getByText("Sign in")` — then act.
- `chars` is the size of `full`; `hint` appears when it is 40,000 chars or more (never on a `{ track
  }` call). Log both with the outline — `console.log(snap.hint ?? "", snap.full)`. A whole-page
  outline on a real app runs tens of thousands of characters and you read every one, so it is the
  most expensive thing a step can print. Take one for a first look; don't end every step with one.
- Never `.slice()` / truncate `full`. A window still pays for the whole walk and hides late-page
  fields (a required field just above the submit), which you then rediscover through failed
  submits. To get a smaller result, change the call instead — with one of these (passing both
  rejects):
  - `{ selector }` scopes the outline to one element. If your first full snapshot of an app shows
    its pages are mostly repeated nav/sidebar chrome, scope later snapshots in the session to the
    content — `{ selector: "main" }`, the form, the active dialog — once per app, not once per page.
    The selector must match exactly ONE element (Playwright strict mode): a comma list like `"nav,
    aside"` or a tag that recurs throws "strict mode violation: resolved to N elements" and wastes a
    round trip. Use an id, a `data-testid`, or `.first()`/`.nth()`; unsure it's unique? Don't scope.
  - `{ track }` returns only what CHANGED since your last snapshot with the same key —
    `page.snapshotForAI({ track: "main" })` after an interaction. The first tracked call returns the
    full tree as a baseline; later calls (this step or a later one) return just the diff, in both
    `full` and `incremental`. Tracking resets on a full page load, so right after a navigation it
    returns the whole page again.
- `timeout` bounds the walk. Don't pass `depth` — a shallow snapshot silently omits elements, which
  means missed controls and extra round trips.
- `page.locator("aria-ref=e12")` works only for an immediate action in the same script — refs go
  stale across steps and navigations. Prefer a semantic selector.
- For a TARGETED re-check, use a scoped `locator.ariaSnapshot()` instead of another whole-page
  snapshot: `await page.getByRole("dialog").ariaSnapshot()`, `await
  page.locator("#new-worker-form").ariaSnapshot()`. It returns a compact YAML aria tree of just that
  element, without `[ref=eN]` markers. Rule of thumb: first look → `snapshotForAI()`; re-check →
  scoped `ariaSnapshot()` or `snapshotForAI({ track })`.
- `{ track }` is the default answer to "did my last click do anything?" After a NON-navigating click
  — a menu item, a disclosure, a radio, a select — an empty diff proves nothing changed (wrong
  target, or a menu that had already closed); a non-empty diff shows exactly what appeared.
