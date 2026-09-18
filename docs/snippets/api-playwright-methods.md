- `page.goto(url, { waitUntil: "domcontentloaded" })` — navigate; `waitUntil` is `"load"` /
  `"domcontentloaded"` / `"networkidle"` (prefer `"domcontentloaded"` on dev servers; `"networkidle"`
  can hang on apps with long-lived HTTP — SSE, long-polling, heartbeats — though an open WebSocket
  alone does not block it)
- `page.title()` / `page.url()` — current title / URL (note: `page.url()` is client-cached and lags a
  Turbo/SPA nav until it commits — to confirm a navigation use `humanClickAndWaitForURL` /
  `waitForURLChange`, or read the live `await page.evaluate(() => location.href)`)
- `page.snapshotForAI(options)` — AI-optimized page outline (whole page, any scroll position);
  returns `{ full, incremental?, chars, hint? }` (`chars` is the size of `full`; `hint` appears only
  on a large page and names the cheaper next look); options `{ selector?, track?, timeout? }` — `selector` scopes to
  an element (e.g. `"main"`, to drop nav chrome after a full first look proves it is noise),
  `track` returns just the diff since the last same-key snapshot (the two are mutually exclusive);
  omit `depth` — a shallow tree forces expensive fallbacks and hides late-page fields
- `page.getByRole(role, { name })` / `page.getByText(text)` — semantic locators (survive re-renders)
- `page.textContent(sel)` / `page.innerText(sel)` / `page.innerHTML(sel)` /
  `page.getAttribute(sel, name)` — read by selector
- `page.inputValue(sel)` / `page.isChecked(sel)` / `page.isVisible(sel)` / `page.isHidden(sel)` —
  input and visibility state
- `page.humanClick(target)` / `page.humanFill(target, text)` — Dailies helpers that act like a
  person for the recording: smooth-scroll the element into view, glide the on-screen cursor onto
  it and let it land, then click — or, for a fill, focus and type with real key events. `target` is
  a selector string or a locator. Prefer these for recorded interactions — they reveal the target
  for you, so you don't call `scrollIntoViewIfNeeded` first. `humanFill(target, text, opts)` takes
  `opts.click: false` (type without clicking — for a field that's already active, e.g. an open
  combobox a second click would dismiss) and `opts.clear: false` (append instead of replacing).
  Typing has a human cadence (bursts, a slower reach for capitals and symbols, a hesitation at
  word and clause breaks, a rare typo-and-correct) and is BOUNDED: the whole cadence is planned
  up front and scaled to fit `opts.budgetMs` (default 4500) so a long value can't turn into
  half a minute of film — raise it for a field where the typing itself is the demo, or pass
  `opts.delay` for an exact, unscaled per-key delay. Every character always arrives
  NAVIGATING click (a link or a submit)?
  `humanClick` returns BEFORE the navigation commits — a `page.url()` or `snapshotForAI()` on the
  next line shows the OLD page. Either make that click the LAST action of the step (the step-end
  settle commits it; observe in the next step) or use `humanClickAndWaitForURL` to stay in this step.
- `page.humanClickAndWaitForURL(target, opts?)` — Dailies helper: `humanClick` a control that
  NAVIGATES, then wait for it the race-free way. Captures `location.href` BEFORE the click and waits
  — under one `opts.timeout` (default 15000) — for the URL to settle AND `opts.loadState` (default
  `"load"`). Returns the new href. The one-liner for "click this link and continue on the new page":
  no stale `page.url()`, no racy read after the click. Pass `opts.url` (glob/RegExp/predicate) to wait
  for a specific destination, or `opts.loadState: "networkidle"` to also wait for the fetch +
  sub-resources (safe only when the app's sole live connection is a WebSocket). For a click that does
  NOT navigate use `humanClick` — this throws once the timeout elapses if the URL never changes.
- `page.fill(sel, value)` / `page.click(sel)` / `page.type(sel, text)` / `page.press(sel, key)` —
  lower-level acts on elements (`fill` sets the value atomically — no cursor travel or typing on
  camera; reach for `humanClick` / `humanFill` in recordings)
- `page.showCaption(text, opts?)` — Dailies helper: overlay a short caption on the page to label a
  moment in the recording for a human viewer; fades after `opts.durationMs` (default 3000).
  Cosmetic only — use sparingly, not to echo step names. Cues are recorded as timed data and
  rendered into a caption band at `session end` in every mode; in cinematic/song cuts the text
  also feeds the narration/lyrics as intent — so keep calling it
- `page.showSpotlight(target?)` — Dailies helper: animate a spotlight vignette to focus on an
  element (`target` is a selector or locator). The aperture opens wide then tightens to
  circumscribe the element's bounding box while the surround deepens, so it reads as a camera
  pushing in — drawing the reviewer's eye before you interact. Omit `target` to spotlight the
  current cursor position. Use for subtle elements a viewer might miss — validation errors,
  small toggles, non-obvious fields. There is deliberately NO page zoom: scaling the page would
  move where clicks land, so this is how Dailies pushes in
- `page.reveal(target)` — Dailies helper: smooth-scroll a region into view and glide the cursor onto
  it WITHOUT clicking (the `humanClick` motion minus the press). Use to show something in the
  recording; never `window.scrollTo` / `page.evaluate(() => scrollTo(...))` (invisible on camera).
  You don't need it to observe — `snapshotForAI` sees the whole page regardless of scroll
- `page.lookAt(target)` — Dailies helper: `reveal` an element, then rest the cursor on it a beat
  longer — a deliberate "now look here" before you talk about it. No click
- `page.circle(target, opts?)` / `page.underline(target)` / `page.pointAt(target)` — Dailies gesture
  helpers: draw the viewer's eye to an element with a hand-like cursor flourish — circle it
  (`opts.loops`, default 1), sweep an underline beneath it (short elements get a double pass), or
  nudge toward it twice. Cosmetic only — they reveal the element and move the cursor but never click
  or change focus. Use to emphasise something on camera, not as a substitute for `humanClick`
- `page.highlightText(target, opts?)` — Dailies helper: drag-select an element's text so the browser
  paints its native selection highlight while the cursor sweeps across — for calling out a specific
  passage. `opts.clearAfterMs` clears the selection that long after the sweep. Cosmetic; no click
- Settling is AUTOMATIC — you never call a settle yourself. Dailies settles the page (document load +
  a bounded network-idle + DOM-mutation quiescence) at the END of every step, so each step's
  screenshot and the next step's fresh page both start committed and quiet. WITHIN a step, wait on a
  concrete signal: a navigation → `humanClickAndWaitForURL` / `waitForURLChange`; a known element →
  `waitForSelector` / `locator.waitFor` (most actions already auto-wait); a fetch → `waitForResponse`;
  an arbitrary condition → `waitForFunction`. To observe an unknown result with no nameable signal,
  end the step and observe at the start of the next one
- `page.waitForSelector(sel, { state, timeout })` (`state`: `"attached"` / `"visible"` /
  `"hidden"` / `"detached"`) / `page.waitForURL(pattern)` (polls the live URL, so it resolves on
  History API / Turbo / SPA navigations too; `pattern` is a glob, RegExp, or predicate) /
  `page.waitForLoadState(state)` / `page.waitForFunction(fn)` / `page.waitForTimeout(ms)` — waiting
- `page.waitForURLChange(opts?)` — Dailies helper: wait until the live URL changes (returns the new
  href) when you DON'T know the destination — e.g. confirming a click navigated. For the common
  click→nav case, reach for `humanClickAndWaitForURL` instead — it wraps this. Use this directly when
  the nav isn't triggered by a single click. Capture the start URL before the click and pass it:
  `const from = await page.evaluate(() => location.href); await page.humanClick(link); await
  page.waitForURLChange({ from });` — or run both at once: `await Promise.all([page.waitForURLChange(),
  page.humanClick(link)])`. (`page.url()` is client-cached and won't reflect a Turbo nav; the helper
  reads `location.href`.) Then act on a known destination element before observing — or simply end the
  step, since Dailies settles the committed page for the next one
- `page.setInputFiles(target, files, opts?)` — Dailies helper: attach files to a file `<input>`.
  `files` is one filename or an array; each must already live in the sandbox temp dir (write it
  with `writeFile(name, data)` first, or have the user drop it in via takeover). The bytes are read
  host-side — confined to that dir — and handed to the browser as an in-memory payload, so a script
  can only upload files it put there. Glides the cursor to the control when it's visible. `target`
  is a selector or locator. Call this on `page`, not on a locator — `locator.setInputFiles(name)`
  is raw Playwright, which tries to resolve `name` as a real filesystem path and throws (the sandbox
  has none); `page.setInputFiles(target, name)` is the only form that reads the sandbox temp file.
- `page.screenshot({ fullPage })` — capture a screenshot Buffer; save it with `saveScreenshot(...)`
- `page.evaluate(fn[, arg])` / `page.$eval(sel, fn)` / `page.$$eval(sel, fn)` — run plain
  JavaScript in the page context (real DOM; args/returns must be serializable)
- `page.locator(sel)` — a Locator for chained actions (`.click()`, `.fill(value)`,
  `.pressSequentially(text)` to type with real key events, `.textContent()`, `.first()`, …);
  `.scrollIntoViewIfNeeded()` brings an offscreen element into the viewport without clicking it —
  only needed when revealing without acting, since `humanClick` / `humanFill` already reveal first
- `page.keyboard.press/type/down/up(...)` / `page.mouse.move/click/down/up(...)` — low-level input
- `page.reload()` / `page.goBack()` / `page.goForward()` — history;
  `page.content()` / `page.setContent(html)` — full HTML
- `page.on("console", handler)` — observe page console events
- Browser dialogs (`alert` / `confirm` / `prompt`) freeze the page until answered. By default
  Dailies fails the step on an unanswered one (it dismisses the dialog — cancelling whatever opened
  it — and reports a clear error) so a silently-cancelled flow can't pass unnoticed. When a flow
  expects a dialog, say so **before** the action that triggers it: `await page.acceptDialogs()`
  (click OK / confirm), `await page.dismissDialogs()` (cancel quietly, no failure), or
  `await page.failOnDialogs()` to restore the strict default. The choice lasts for the current step
  only. A standard `page.on("dialog", …)` handler does **not** work — Dailies answers dialogs itself
  — so use these methods.
