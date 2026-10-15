- Every recorded click and text entry goes through `page.humanClick(target)` /
  `page.humanFill(target, text)` (`target` is a selector string or a locator) — the default, not an
  option. Never raw `page.click` / `locator.click` / `page.fill` for a recorded action. The helpers
  scroll the element into view, glide the on-screen cursor onto it and let it settle, then act
  through real input (a fill focuses, then types real key events). A bare `locator.click()` moves
  and presses in the same instant, so on camera the click lands before the cursor arrives.
- Gestures the helpers don't cover — `hover`, keyboard `press`, `selectOption`, `check`/`uncheck`,
  drag — use the normal locator methods, still on a revealed element.
- ALWAYS reveal an element before interacting. The helpers scroll to it but can't open collapsed UI:
  if it lives in a closed menu, dropdown, accordion, tab or unopened modal, open that first, in the
  SAME step. A toggle-opened menu STAYS open across steps — if an earlier step opened it, just click
  the item; clicking the toggle again closes it. Fold `scrollIntoViewIfNeeded` / `isVisible` checks
  into the interaction's own script, not separate steps.
- To bring something into view only to SHOW it, use `page.reveal(target)` — never
  `window.scrollTo` or `page.evaluate(() => scrollTo(...))`, which the camera can't see. Observing
  needs no scrolling: `snapshotForAI` reads the whole page.
- Toggle a checkbox or radio with `humanClick`, targeted by role and name (`getByRole("checkbox",
  { name })`) or its label text. When the app hides the real `<input>` behind a CSS-drawn control,
  `humanClick` clicks its `<label>` for you — don't reach past it to a raw click on the input.
- An overlay — cookie banner, dialog, toast, loading spinner — blocks clicks. "intercepts pointer
  events" / "not clickable" means something is on top: deal with it (act in the modal, close the
  banner, wait out the spinner), then retry — never `{ force: true }`. Check for overlays right
  after a navigation, before starting the main flow.
- When several `<dialog>` elements coexist, don't trust `isVisible()` / `isHidden()` to find the
  active one — apps often hide a `<dialog>` with CSS while it stays `open`. Pick it by content
  (`page.locator("dialog", { hasText: "…" })`, `page.getByRole("dialog", { name: "…" })`) or scope
  to a known descendant.
- A menu item can open an INLINE section or a drawer/modal, and that differs per item and between
  releases. After EACH click in such a chain, observe with `snapshotForAI({ track: "main" })` (an
  empty diff means the click did nothing) instead of assuming a `<dialog>` opened, then wait on the
  concrete new element (`getByRole`/`getByText` for its heading or first field), not a fixed sleep.
- Move between pages the way a user does — click links and buttons. Only the flow's first
  navigation is a `page.goto(...)`; never `goto` an internal URL after that.
- Find elements the way a user reads them: `getByRole(role, { name })`, `getByText`, `getByLabel`.
  CSS selectors and `page.evaluate(...)` are fine for EXAMINING the page; when a recorded action
  needs a selector, prefer `data-testid` / `data-test-id`, never presentational class names.
- Never bypass real input: no `{ force: true }`, no `page.evaluate(el => el.click())`, no atomic
  `page.fill` on a field the user types into (it shows no typing on camera). If a real user couldn't
  see and do it, the run verified nothing.
- Don't submit the instant you finish an input. Checking a box, choosing a radio or option, or
  filling a field can trigger async work — inline validation, a new required field, a dependent
  control, the submit button enabling. Wait on that concrete result (Playwright auto-waits when you
  act on it), and re-check the submit control is enabled right before submitting. A submit fired
  mid-validation records a failure that isn't the app's.
- Some interactions rebuild part of the DOM and detach the elements they replace ("Element is not
  attached to the DOM"). `humanClick`, `humanFill`, `setInputFiles` and `Locator` `check` /
  `uncheck` / `selectOption` / `dragTo` settle the page after acting (bounded network idle plus DOM
  quiet), so back-to-back interactions are safe — no need to sniff `data-action` /
  `data-controller` or split steps. Still: `hover` and `press` are NOT settled, so if
  `press("Enter")` submits, wait on the result; for a rebuild slower than that settle, make it the
  step's last action and act on its dependents in the next step (the step-end settle waits longer);
  and never reuse a handle grabbed before a rebuild.
- A submit that fails validation usually returns 422 and re-renders the form — in Rails/Turbo as a
  turbo-stream rebuild, not a navigation. For a submit that MIGHT fail, `humanClick` it and wait for
  EITHER the URL to change or an error/flash to appear; `humanClickAndWaitForURL` would hang to its
  timeout on failure.
- To find the errors, don't assume a class name or ARIA: the snapshot shows accessibility, not CSS,
  and many design systems mark errors with neither `aria-invalid` nor `role="alert"`. Search the
  snapshot for the message TEXT, or read the app's real error class from the DOM (`page.$$eval(
  ".<app-error-class>", els => els.map(e => e.textContent))`, found once from a failing field's
  `outerHTML`). `[aria-invalid]`, `.is-invalid` and `.field_with_errors` usually match nothing. An
  error on an association or the record's base renders nowhere inline; a flash banner is then the
  only signal.
- Verify through what a SHIPPED user sees — the flash and inline messages. Never click dev-only
  diagnostics (a "View Submitted Errors" button, a debug drawer, a `?debug=` panel); they don't
  exist in production.
- A click timeout or `page.isVisible(sel)` returning false usually means hidden, not missing:
  snapshot, find the toggle, menu or tab that reveals it, click that, then retry.
