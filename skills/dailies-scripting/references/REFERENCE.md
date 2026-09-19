# Dailies scripting API — full reference

Scripts run in a QuickJS sandbox. The body is top-level JavaScript with `await`.

## Globals

<!-- dailies:snippet api-globals -->
Every script gets these globals:

- `browser` — pre-connected browser handle (see the script API)
- `console` — `log` / `info` / `warn` / `error`, captured per run
- `setTimeout` / `clearTimeout` — basic timers
- `saveScreenshot(buffer, name)` — save a screenshot buffer (async — await it)
- `writeFile(name, data)` / `readFile(name)` — small-file persistence (async — await them)
<!-- dailies:end api-globals -->

## `browser`

<!-- dailies:snippet api-browser -->
- `browser.getPage(nameOrId)` — get-or-create a named page, or attach to an existing tab by the
  `id` from `listPages()`. Named pages persist across steps in a session — call with the same
  name to reuse the tab.
- `browser.newPage()` — an anonymous page, auto-closed when the script ends; does not persist.
- `browser.listPages()` — list every open tab: `[{ id, url, title, name }]` (`name` is `null`
  for tabs you never named).
- `browser.closePage(name)` — close and forget a named page.
<!-- dailies:end api-browser -->

## Top-level file helpers

<!-- dailies:snippet api-file-helpers -->
All file I/O is async (await it), sandboxed to `~/.dailies/tmp/` (no filesystem escape), and
returns the full path to the file:

- `saveScreenshot(buffer, name)` — persist a screenshot buffer; buffer first:
  `const path = await saveScreenshot(await page.screenshot(), "home.png");`
- `writeFile(name, data)` — write a small file (e.g. JSON state):
  `await writeFile("results.json", JSON.stringify(data));`
- `readFile(name)` — read it back (returns the contents as a string):
  `const data = JSON.parse(await readFile("results.json"));`
<!-- dailies:end api-file-helpers -->

## Console

<!-- dailies:snippet api-console -->
- `console.log` / `console.info` write to stdout; `console.warn` / `console.error` write to
  stderr. Top-level `console.log` is your script's output channel.
- `console.log` inside `page.evaluate(() => …)` runs in the page and is captured into the
  session's console artifact instead.
<!-- dailies:end api-console -->

## `Page` — common methods

<!-- dailies:snippet api-playwright-note -->
Pages returned by `browser.getPage()` and `browser.newPage()` are full Playwright Page objects —
the same API (`goto`, `click`, `fill`, `locator`, `evaluate`, `getByRole`, `waitForSelector`, …):
https://playwright.dev/docs/api/class-page
<!-- dailies:end api-playwright-note -->

<!-- dailies:snippet api-playwright-methods -->
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
<!-- dailies:end api-playwright-methods -->

## `Locator` — `page.locator(selector)`

Actions: `.click()`, `.fill(value)`, `.check()`, `.uncheck()`, `.selectOption(value)`, `.hover()`, `.focus()`.
Reads: `.textContent()`, `.innerText()`, `.getAttribute(name)`, `.inputValue()`, `.count()`.
State: `.isVisible()`, `.isEnabled()`, `.isChecked()`.
Refine: `.first()`, `.last()`, `.nth(i)`, `.filter({ hasText })`, `.all()` (→ `Locator[]`).
Semantic factories (also `Locator`): `page.getByRole(role, { name })`, `page.getByText(text)`.

## Observing the page — `snapshotForAI`

<!-- dailies:snippet api-snapshot -->
- `page.snapshotForAI()` returns `{ full, incremental?, chars, hint? }` — `full` is a deep aria outline of the
  page: roles, accessible names, `[ref=eN]` markers on actionable nodes. On an unknown page, start
  with the full-depth snapshot so you can see the whole task surface, including content near the
  end of the page. Read it to pick a semantic selector — `page.getByRole("button", { name:
  "Continue" })`, `page.getByText("Sign in")` — then act. The outline covers the WHOLE page
  regardless of scroll position, so you never need to scroll to observe.
- `chars` is the size of `full`, and `hint` appears only when the page is large enough that the
  next observation should be cheaper. Log them alongside the outline — `console.log(snap.hint ??
  "", snap.full)` — so the size is on the record. A whole-page outline on a real app runs tens of
  thousands of characters; `chars` is what tells you which pages those are. The hint never appears
  on a `{ track }` call, because tracking is already the advice it would give.
- Read the WHOLE `snap.full` — do NOT `.slice()` / `.substring()` / truncate it when you log or
  inspect it. A window is the worst of both worlds: you pay for the full-page walk yet only see part
  of it, so late-page fields (a rate block, a required field just above the submit) fall outside your
  window and you miss them — then rediscover them the hard way through submit failures. This is a
  self-inflicted miss, not a tool limit. If `full` is genuinely too big to reason about, don't
  window it — re-scope the NEXT snapshot with `{ selector }`, or after an interaction switch to
  `{ track }` for just the diff.
- Keep it small only when there is a clear reason — these options are mutually exclusive, and the
  call rejects if you pass both:
  - `{ selector }` scopes the outline to one element — `page.snapshotForAI({ selector: "main" })`
    drops repeated nav/sidebar chrome. Use it only after a full snapshot proves the page is
    overwhelmingly large or dominated by irrelevant chrome, or when an active dialog/form is the
    whole task surface. Do not default to truncating or shallow snapshots; that hides late-page
    fields and causes extra observe/retry loops. `selector` must resolve to exactly ONE element
    (Playwright strict mode) — a multi-target selector (comma list like `"nav, aside, .sidebar"`,
    or a broad tag name that recurs) throws a "strict mode violation: resolved to N elements" and
    burns a whole round-trip, with no hint what the matches were. Don't reach for one hoping to
    "grab whichever matches." Snapshot the whole page first (no selector) to see the structure,
    then scope to ONE unique selector — an id, a `data-testid`, a specific descendant chain, or
    `.first()`/`.nth()` to disambiguate. If you're unsure a selector is unique, don't scope: an
    oversized full snapshot is cheaper than a strict-mode error plus a retry.
  - `{ track }` returns only what CHANGED since your last snapshot with the same key —
    `page.snapshotForAI({ track: "main" })` after an interaction. The first tracked call returns the
    full tree to set the baseline; later calls (this step or a future one) return just the diff in
    both `full` and `incremental`. Tracking resets on a full page load. Best AFTER an interaction, to
    see what it did.
- `timeout` bounds the walk. Don't pass `depth` — a shallow snapshot silently omits elements,
  causing missed controls, avoidable fallback to screenshots or full HTML, and extra round trips.
- `page.locator("aria-ref=e12")` works for an immediate action in the same script only — refs go
  stale across steps and after navigations. Prefer re-deriving a semantic selector.
- For a TARGETED structural check, prefer a scoped `locator.ariaSnapshot()` over another whole-page
  `snapshotForAI()`. Any locator has it — `await page.getByRole("dialog").ariaSnapshot()`,
  `await page.locator("#new-worker-form").ariaSnapshot()` — and it returns a compact YAML aria tree
  of just that element, WITHOUT the `[ref=eN]` action markers. Use it to answer "what's inside this
  section / dialog / row now?" cheaply. Reserve `snapshotForAI()` (whole page, `[ref=eN]` markers)
  for the FIRST look at an unfamiliar page and whenever you need refs to act. Rule of thumb: first
  look → `snapshotForAI`; targeted re-check → scoped `ariaSnapshot` or `snapshotForAI({ track })`.
- Make `{ track }` your DEFAULT answer to "did my last click actually do anything?" After any
  NON-navigating click — a menu item, a disclosure toggle, a radio, a select — call
  `page.snapshotForAI({ track: "main" })`: an empty diff proves nothing changed (wrong target, or a
  menu item whose menu had already closed), a non-empty diff shows exactly what appeared. That is far
  faster and less ambiguous than re-dumping the full tree and eyeballing it for a difference.
<!-- dailies:end api-snapshot -->

<!-- dailies:snippet rule-observe-first -->
- Unknown page? Snapshot first, then act: read `(await page.snapshotForAI()).full` to see the full
  page, including content below the fold and near the end. Pick a semantic selector from it
  (`getByRole`, `getByText`), then interact. Never guess selectors blind, and don't start with a
  shallow or truncated observation.
- Known page or selectors? Skip the snapshot and use direct selectors — faster and more reliable.
- The snapshot covers the whole page no matter where it's scrolled — never add a scroll step just to
  observe. If the full snapshot is overwhelmingly large or mostly repeated nav/sidebar chrome,
  re-observe with a deliberate scope such as `{ selector: "main" }`, an active dialog, or the
  relevant form. After an interaction, pass `{ track: "main" }` to get just what changed instead of
  re-reading the full outline.
- On a long or dynamic form, enumerate EVERY required field in ONE pass up front, before you fill
  anything — don't discover requirements one submit-failure at a time. Requirements appear in the
  snapshot as an asterisk or "required" / "This field is required" in a field's accessible name;
  confirm with a single DOM sweep, e.g. `page.$$eval("[required], [aria-required='true']", els =>
  els.map(e => e.name || e.id))`. Build the checklist, fill all of it, THEN submit. Dynamic forms
  grow — choosing an option (employment type, a guild) can rebuild the form and reveal a NEW required
  section, so re-enumerate after any interaction that rebuilds it.
- After a navigation the new page often renders asynchronously (client-side routing / SPAs swap
  content without a full document load). Don't snapshot or assert the instant a click returns.
  Prefer acting on or waiting for a KNOWN element on the destination (`getByRole`/`getByText`) —
  Playwright auto-waits for it, which both confirms the navigation and avoids reading stale content.
  Need the result in the SAME step after a click that navigates? `await
  page.humanClickAndWaitForURL(link)` waits for the URL and load in one call. Otherwise you needn't
  wait at all: Dailies settles the page (load + network-idle + DOM quiescence) at the END of every
  step, so just end the step and observe at the start of the next — its fresh page is already on the
  committed, quiet destination. Avoid fixed `waitForTimeout`; `waitForLoadState("load")` /
  `"domcontentloaded"` are fine, but `"networkidle"` can hang on apps with long-lived HTTP (SSE,
  long-polling, heartbeats) — an open WebSocket alone does NOT block it.
- `page.url()` is a cached value updated by an async event, so right after a client-side navigation
  it can still read the OLD url — especially a Turbo/SPA visit, whose URL only changes once its fetch
  lands and the nav commits (the NEXT step's fresh page reads it correctly — the step-end settle
  guarantees that). To get the post-nav URL WITHIN a step, use the helpers that read the live
  `location.href`: `page.humanClickAndWaitForURL(link)` (returns the new href) or
  `page.waitForURLChange({ from })`; or `page.waitForURL(<url|regex|fn>)` for a known destination; or
  read it directly with `await page.evaluate(() => location.href)`.
<!-- dailies:end rule-observe-first -->

<!-- dailies:snippet rule-visible-interaction -->
- Every recorded click and text entry goes through the human helpers
  `page.humanClick(target)` / `page.humanFill(target, text)` (`target` is a selector string or a
  locator) — this is the default, not an option. Do NOT use raw `page.click` / `locator.click` /
  `page.fill` for a recorded action. The helpers reveal the element (scroll it into view), glide
  the on-screen cursor onto it and let it settle, then act through real input — a true click, and
  for fills a focus-then-type that sends real key events. That cursor-settling beat is the point:
  a bare `locator.click()` moves and presses in the same instant, so on camera the click lands
  before the cursor has visibly arrived. (Gestures the helpers don't cover — `hover`, keyboard
  `press`, `selectOption`, `check`/`uncheck`, drag — use the normal locator methods, still on a
  revealed element. `selectOption`/`check`/`uncheck`/`dragTo` still settle the page after acting on
  their own, even called directly on a `Locator` — see the DOM-rebuild note below.)
- ALWAYS reveal an element before interacting — no exceptions; the recording must show every
  interaction a viewer is asked to trust. The helpers scroll to the target but cannot reveal an
  element hidden behind collapsed UI — if
  it lives inside a closed menu, dropdown, accordion, tab, or unopened modal, open that container
  first, then interact — in the SAME step. A toggle-opened container (a menu/dropdown) STAYS open
  across steps, so if you opened it in an earlier step (e.g. to snapshot and find the item), do NOT
  click the toggle again to "open" it — that CLOSES it; just click the item. Any
  `scrollIntoViewIfNeeded` / `page.isVisible(sel)` checks fold into the interaction's own script —
  keep them out of the step list as bookkeeping.
- To bring something into view just to SHOW it (not act on it), use `page.reveal(target)` — never
  `window.scrollTo` or `page.evaluate(() => scrollTo(...))`, which move nothing the camera can see.
  Observing doesn't need scrolling at all: `snapshotForAI` reads the whole page regardless of scroll.
- Toggle a checkbox or radio with `humanClick` — target it by role/name
  (`getByRole("checkbox", { name })`) or its label text. Apps routinely hide the real `<input>` and
  draw a custom control with CSS, so the input is zero-size and a direct click misses; `humanClick`
  detects that and clicks the input's `<label>` for you (what a real user clicks). You don't need
  to find the label yourself — just don't reach past `humanClick` to a raw `click` on the input.
- Before interacting, make sure the target isn't covered by an overlay or modal — a cookie
  banner, dialog, toast, or loading spinner. A click that fails with "intercepts pointer events" /
  "not clickable" means something is on top: deal with that overlay first (act within the modal,
  accept/close the banner, wait for the spinner to clear), then retry — don't `{ force: true }`
  through it. Right after a navigation, check for such overlays before starting the main flow.
- When several `<dialog>` elements coexist in the DOM at once (a modal, a drawer, …), don't rely
  on `isVisible()` / `isHidden()` to pick the active one — frameworks often show/hide a `<dialog>`
  with CSS while it stays `open` in the DOM, so Playwright's visibility heuristic can report the
  truly-shown one as `false`. Identify it by content instead: `page.locator("dialog", { hasText:
  "…" })` / `page.getByRole("dialog", { name: "…" })`, or scope straight to a known descendant
  inside it — rather than testing `.isVisible()` across every match and trusting the boolean.
- Cascading-disclosure UI — a menu / split button that opens a list of item buttons, each of which
  opens something more — does NOT tell you in advance whether an item reveals an INLINE section
  grafted into the page or a drawer/modal, and that can differ per item and change between releases.
  So after EACH click in the chain, observe immediately — prefer `snapshotForAI({ track: "main" })`
  so an empty diff instantly tells you the click did nothing (wrong element, or a menu item whose
  menu had already closed) versus showing you exactly what appeared. Don't pre-commit to hunting a
  `<dialog>`: a `dialog`-scoped snapshot after an inline disclosure finds nothing and sends you
  chasing a modal that never opened. The reveal may need a beat to mount or animate, so then wait on
  the concrete new element you expect (`getByRole`/`getByText` for its heading or first field), not a
  fixed sleep.
- Move between pages the way a user does: click links and buttons, don't `goto` internal URLs.
  The lone exception is the flow's entry point — the first navigation is a `page.goto(...)`;
  after that, reach each new page by clicking your way there.
- Find elements the way a user reads them — `getByRole(role, { name })`, `getByText`,
  `getByLabel`. CSS selectors and `page.evaluate(...)` are fine for EXAMINING the page, but when
  a selector is unavoidable in a recorded action prefer a `data-testid` / `data-test-id`
  attribute; never hardcode presentational class names.
- Never bypass real input: no `{ force: true }`, no `page.evaluate(el => el.click())`, and for a
  field the user types into don't set the value with the atomic `page.fill` (it writes in one
  step with no typing on camera — that's why `humanFill` types key by key instead). If a real
  user couldn't see and perform the interaction, the run hasn't verified anything and the video
  shows nothing.
- Don't submit the instant you finish an interaction — this applies to EVERY input before a
  submit, not just typing: checking a box, choosing a radio, selecting a dropdown option, and
  filling a field all commonly trigger async work — inline validation, a newly revealed or
  required field, a dependent control, the submit button enabling/disabling. After each such
  interaction wait on the CONCRETE result before moving on — assert or act on the thing that
  changed (the validation message appearing, the new/required field rendering, the submit button
  flipping enabled); Playwright auto-waits when you act on it. Re-check the submit control is
  enabled right before you submit. Firing submit into a mid-validation form records a failure that
  isn't the app's fault, and a real user wouldn't do it either.
- Some non-navigating interactions REBUILD part of the DOM — choosing a radio / checkbox / dropdown
  or typing into a field can trigger a client-side rebuild (a form controller regenerating a
  dependent section, an inline-validation re-render, an htmx/React/Turbo swap) that DETACHES the
  elements it replaces, so a handle grabbed a moment earlier throws "Element is not attached to the
  DOM" when acted on next. This is handled automatically for essentially every recorded gesture:
  `humanClick`, `humanFill`, and `setInputFiles` settle the page AFTER acting (bounded network-idle
  + DOM-mutation quiescence — framework-agnostic, NOT attribute-sniffing); and `Locator.check()` /
  `.uncheck()` / `.selectOption()` / `.dragTo()` settle themselves the same way even when called
  directly on a `Locator` (not through `humanClick`), since a script can reach these without going
  through the human-interaction helpers. Either way, a rebuild the interaction triggered has
  committed before the NEXT interaction resolves its target, so back-to-back interactions no longer
  stale each other — you do NOT need to detect `data-action` / `data-controller` attributes or
  hand-split steps for this, it's automatic. Two cases still need care: (a) `hover` and keyboard
  `press` are NOT auto-settled — they rarely mutate the DOM on their own, but if one does (e.g.
  `press("Enter")` submitting a form), wait on the concrete result the same way you would after any
  submit; and (b) the rare rebuild slower than the per-interaction settle ceiling (a long
  fetch-then-swap) — if a dependent still comes back detached, make the rebuilding interaction the
  last action of its step and act on the dependents in the NEXT step (the step-end settle has a
  larger budget). Never reuse a handle grabbed before a rebuild.
- A form submit that FAILS validation usually returns HTTP 422 and re-renders the form with errors.
  In Rails/Turbo apps that comes back as a Turbo-stream rebuild, NOT a navigation. A SUCCESSFUL
  submit navigates, but a submit that MIGHT fail in place shouldn't use `humanClickAndWaitForURL` —
  it hangs to the timeout on failure. Instead `humanClick` the submit, then wait for EITHER outcome:
  the URL to change (success) OR an error/flash to appear (failure). Observe the re-rendered page. To
  FIND the errors, do NOT assume a class name: a `snapshotForAI` outline surfaces ACCESSIBILITY
  semantics, not CSS classes, and many design systems attach NO ARIA to error markup (no
  `aria-invalid`, no `role="alert"`), so the error is just an anonymous text node in the outline.
  Instead (a) search the snapshot for the message TEXT, or (b) read the DOM for the app's real error
  class — `page.$$eval(".<app-error-class>", els => els.map(e => e.textContent))`, discovering that
  class once from a failing field's `outerHTML`. Don't reach for `[aria-invalid]` / `.is-invalid` /
  `.field_with_errors`: those are Bootstrap / Rails-default markers that a design-system app commonly
  overrides or suppresses, so all three match nothing. Note that some errors attach to an
  association or the record's base, not a single field, and by design render nowhere inline — a
  generic flash banner is then the only user-visible signal.
- Verify through the surfaces a SHIPPED user sees — the on-screen flash and inline field messages.
  Do NOT click dev-only diagnostics (a "View Submitted Errors" / debug-drawer button, a `?debug=`
  panel): they don't exist in production, so reading them proves nothing about the real experience
  and reads wrong in a demo recording.
- A click timeout or `page.isVisible(sel)` returning false usually means hidden, not missing:
  snapshot, find the toggle/menu/tab that reveals the element, click that, then retry.
<!-- dailies:end rule-visible-interaction -->

Keeping it small: snapshot once to orient; after the page changes, use `{ track }` incrementals
instead of a full re-dump. If you only need a specific value, skip the snapshot entirely and read
it directly with `locator(sel).innerText()` / `.count()`. Don't limit depth — a truncated
snapshot causes consecutive observe steps and expensive screenshot fallbacks.

<!-- dailies:snippet ex-snapshot fenced=js -->
```js
const page = await browser.getPage("main");
const snap = await page.snapshotForAI(); // full-depth first look
console.log(page.url(), await page.title());
console.log(snap.full); // aria outline — pick a role/text selector from this
// then act: await page.humanClick(page.getByRole("button", { name: "Continue" }));
// the first page.snapshotForAI({ track: "main" }) call sets the baseline (returns full);
// after that, track: "main" returns just the incremental diff
```
<!-- dailies:end ex-snapshot -->

## The per-step screenshot rule (sessions)

<!-- dailies:snippet rule-screenshot cli=npx-cli -->
After each `npx dailies-cli run --step`, the daemon auto-captures ONE screenshot of the step's
last-opened tab and binds it to that step in the report. So:

- Keep one primary named page per step — the report screenshot is always the page you mean.
- If a step opens several tabs, open the one you want featured last.
- `saveScreenshot(...)` images land in `~/.dailies/tmp/` and are NOT in the report — they're
  extras for debugging.
<!-- dailies:end rule-screenshot -->

## Passing state between steps

<!-- dailies:snippet rule-data-passing -->
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
<!-- dailies:end rule-data-passing -->

## Dev servers

<!-- dailies:snippet rule-dev-server -->
For local dev servers (Next.js, Vite, …) prefer
`await page.goto(url, { waitUntil: "domcontentloaded" })` — the default `"load"` wait can hang
on HMR, streaming, or other long-lived dev-server connections. Use `"load"` only when you
specifically need every subresource to finish loading.
<!-- dailies:end rule-dev-server -->

## Sandbox limits

<!-- dailies:snippet api-sandbox-env -->
Scripts execute inside a QuickJS WASM sandbox with no arbitrary access to the host system.
This is NOT Node.js — there is no module system and no Node API:

- `require()` / `import()` — no module loading; inline any helpers in the script
- `process`, `fs` / `path` / `os` — no process or direct filesystem access (use the file helpers)
- `fetch` / `WebSocket` — no direct network access (the page does the networking)
- `__dirname` / `__filename` — no path globals

Memory and CPU limits are enforced, and both CPU time and wall-clock time are bounded — infinite
loops or never-settling promises abort the script. Values crossing `evaluate` / `$eval` must be
JSON-serializable.
<!-- dailies:end api-sandbox-env -->

## Resilience & failure discipline

<!-- dailies:snippet rule-fail-fast cli=npx-cli -->
- End each script by logging the state you need for the next decision — stdout is your
  observation channel.
- Use short timeouts (`npx dailies-cli run --timeout 10`) so a step fails fast instead of hanging on a
  missing element.
- In assertion / extraction steps, degrade gracefully — log a `WARN` / `FAIL` line instead of
  crashing, so the step still records its evidence. While exploring, a missed selector means
  look again (snapshot, fix, retry as a new step), not a silent fallback.
- End before you stop: `npx dailies-cli stop` shuts the daemon down and aborts any live session,
  skipping its report.html — always `npx dailies-cli session end <id>` first.
<!-- dailies:end rule-fail-fast -->

Recommended pattern for assertion / extraction steps:

```js
const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.getPage("main");
await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded" });
const ok = await safe(() => page.waitForSelector("tr.athing", { timeout: 15000 }).then(() => true), false);
if (!ok) {
  console.log("WARN: rows not found — page changed or rate-limited");
} else {
  const titles = await safe(() => page.evaluate(() =>
    [...document.querySelectorAll("span.titleline > a")].slice(0, 10).map((a) => a.textContent)
  ), []);
  console.log(JSON.stringify(titles));
}
```
