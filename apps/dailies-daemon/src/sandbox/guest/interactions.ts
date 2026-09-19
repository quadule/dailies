import { CURSOR_GLIDE_MS } from "../../session-cursor.js";

// Wait for the visual glide to finish, then leave a short rest before acting.
const CURSOR_SETTLE_MS = CURSOR_GLIDE_MS + 200;
const SETTLE_BUFFER_MS = 150;
// Bound smooth scrolling even when a page ignores its requested behavior.
const SCROLL_REVEAL_CAP_MS = 1500;

// This source runs in the bootstrap's private closure. Its only dependencies
// are the captured hostCall and guest runtime globals; it supplies augmentPage.
// It never executes against the Node host or changes the host Playwright client.
export const PAGE_INTERACTIONS_SOURCE = `            // Human-interaction helpers attached to every page handed to a
            // script. They reveal the target, glide the virtual cursor to it,
            // wait for the glide to land, then act through real input — so the
            // recording shows what a person would see. Pure wrappers over the
            // documented page/locator API; the daemon's Playwright is untouched.
            const resolveLocator = (page, target) =>
              typeof target === "string" ? page.locator(target) : target;

            // Match a URL the way page.waitForURL callers expect, without a
            // baseURL (not available in the sandbox): a RegExp tests the href,
            // a function is called with it, and a string is treated as a
            // Playwright-style glob ("**" → anything, "*" → anything within a
            // path segment), falling back to substring. Keeps client-side
            // navigation waits generic.
            const makeUrlMatcher = (pattern) => {
              if (typeof pattern === "function") {
                return (href) => Boolean(pattern(href));
              }
              if (pattern instanceof RegExp) {
                return (href) => pattern.test(href);
              }
              const str = String(pattern);
              if (str.indexOf("*") === -1) {
                return (href) => href === str || href.indexOf(str) !== -1;
              }
              let src = "";
              for (let i = 0; i < str.length; i += 1) {
                const ch = str[i];
                if (ch === "*") {
                  if (str[i + 1] === "*") {
                    src += ".*";
                    i += 1;
                  } else {
                    src += "[^/]*";
                  }
                } else if ("\\\\^$.|?+()[]{}".indexOf(ch) !== -1) {
                  src += "\\\\" + ch;
                } else {
                  src += ch;
                }
              }
              try {
                const rx = new RegExp("^" + src + "$");
                return (href) => rx.test(href);
              } catch {
                return (href) => href.indexOf(str) !== -1;
              }
            };

            // Animate an off-screen target into view so the scroll is visible on
            // camera (Playwright's scrollIntoViewIfNeeded teleports). Resolves once
            // the element stops moving — tracked via its rect, which moves no matter
            // which ancestor scrolls (an inner panel won't change window.scrollY) —
            // or when the cap elapses. A no-op when the element is already in view.
            const smoothReveal = (target) =>
              target
                .evaluate(
                  (el, capMs) =>
                    new Promise((resolve) => {
                      const inView = () => {
                        const r = el.getBoundingClientRect();
                        const m = 8;
                        return (
                          r.top >= m &&
                          r.left >= m &&
                          r.bottom <= window.innerHeight - m &&
                          r.right <= window.innerWidth - m
                        );
                      };
                      if (inView()) {
                        resolve();
                        return;
                      }
                      el.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                        inline: "center",
                      });
                      const start = performance.now();
                      let lastTop = Number.NaN;
                      let lastLeft = Number.NaN;
                      let stable = 0;
                      const tick = () => {
                        const rect = el.getBoundingClientRect();
                        const top = Math.round(rect.top);
                        const left = Math.round(rect.left);
                        if (top === lastTop && left === lastLeft) {
                          stable += 1;
                        } else {
                          stable = 0;
                          lastTop = top;
                          lastLeft = left;
                        }
                        if (stable >= 4 || performance.now() - start > capMs) {
                          resolve();
                          return;
                        }
                        requestAnimationFrame(tick);
                      };
                      requestAnimationFrame(tick);
                    }),
                  ${SCROLL_REVEAL_CAP_MS},
                )
                .catch(() => undefined);

            const revealAndGlide = async (page, target) => {
              // Smooth-scroll for the camera. We deliberately do NOT also call
              // target.scrollIntoViewIfNeeded() here: every real action that
              // follows this (click/fill/press/setInputFiles, via
              // humanClick/humanFill/setInputFiles) already runs Playwright's
              // OWN actionability protocol before dispatching — which itself
              // scrolls the target into view and waits for it to be stable —
              // so an extra explicit scroll here adds no correctness value.
              // For a scroll-reactive popover (e.g. a date picker that
              // repositions itself in response to ANY scroll on the page),
              // it's actively harmful: a second, unaccounted-for scroll
              // trigger fired the instant smoothReveal's own settle-loop
              // finishes gives the popover another chance to reposition,
              // which can then race the actionability check that follows and
              // oscillate until the click times out. One controlled scroll
              // mechanism (smoothReveal's geometry-only settle loop) is
              // enough; Playwright's own action dispatch supplies the rest.
              await smoothReveal(target);
              // Drive the virtual cursor explicitly: one in-page call glides it
              // onto the target's centre and arms the click ripple. No "driving"
              // flag and no extra mouse.move/boundingBox — so the cursor never
              // chases the user's real pointer and the trace isn't cluttered with
              // cursor bookkeeping. The CSS transform transition animates the move.
              const glideMs = await target
                .evaluate((el) => {
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 && r.height === 0) {
                    return null;
                  }
                  // Aim NEAR the centre, not exactly at it. Hitting the precise
                  // geometric centre of every button and field is the other
                  // mechanical tell (the first was the park below): a person
                  // lands somewhere in the middle of a control, a different
                  // somewhere each time. Kept to a fraction of the element and
                  // capped in pixels, so the cursor is always well inside the
                  // target — on a small control the jitter collapses to nothing.
                  //
                  // Only the CURSOR moves here. Playwright dispatches the real
                  // click through its own actionability protocol (element centre),
                  // so nothing about where input lands changes.
                  const off = (extent) =>
                    (Math.random() * 2 - 1) * Math.min(extent * 0.22, 18);
                  const ms = window.__dailiesCursor?.glide(
                    r.left + r.width / 2 + off(r.width),
                    r.top + r.height / 2 + off(r.height),
                    el,
                  );
                  return typeof ms === "number" ? ms : 0;
                })
                .catch(() => null);
              if (glideMs === null) {
                return false;
              }
              // Wait for the cursor to actually land before the click fires.
              // The glide duration now scales with distance, so a long move can
              // outlast the old fixed settle — and armPress would then teleport
              // the cursor to the click point on mousedown (the very teleport
              // this feature exists to prevent). Wait the longer of the visible
              // rest beat and the move's own duration plus a small buffer.
              await page.waitForTimeout(
                Math.max(${CURSOR_SETTLE_MS}, glideMs + ${SETTLE_BUFFER_MS}),
              );
              return true;
            };

            // A checkbox/radio is frequently a visually-hidden <input> with a
            // custom CSS control drawn over a <label>; clicking the input itself
            // misses (it's zero-size/invisible). When the target resolves to such
            // a hidden input, retarget the click to its label — what a real user
            // clicks. One round-trip: evaluateHandle returns the label to click,
            // or the element itself otherwise (an ElementHandle that supports the
            // scrollIntoViewIfNeeded / evaluate / click that follow).
            const resolveClickTarget = async (page, target) => {
              const locator = resolveLocator(page, target);
              const handle = await locator
                .evaluateHandle((el) => {
                  if (
                    el instanceof HTMLInputElement &&
                    (el.type === "checkbox" || el.type === "radio")
                  ) {
                    const rect = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    const hidden =
                      rect.width <= 1 ||
                      rect.height <= 1 ||
                      cs.visibility === "hidden" ||
                      cs.display === "none" ||
                      Number(cs.opacity) === 0;
                    const label = el.labels && el.labels[0];
                    if (hidden && label) {
                      return label;
                    }
                  }
                  return el;
                })
                .catch(() => null);
              return (handle && handle.asElement()) || locator;
            };

            // Ask the daemon to let the page settle (bounded network-idle + DOM-
            // mutation quiescence) AFTER an interaction, so an in-flight rebuild
            // the interaction triggered (a Stimulus/Turbo/React/htmx form rebuild,
            // etc.) commits before the NEXT interaction resolves its target.
            // Framework-agnostic and best-effort: a settle failure must never fail
            // the interaction itself, so swallow everything. Used by humanFill and
            // setInputFiles only — humanClick does NOT need this: the click it
            // performs goes through Locator.click() / ElementHandle.click() in the
            // forked client, which now settle themselves (navigation-aware —
            // see settleAfterInteraction.ts in the client), so calling this
            // daemon-side hostCall again afterward would just duplicate that work.
            const settleAfterInteraction = async () => {
              try {
                await hostCall("settleAfterInteraction", "[]");
              } catch {
                // Ignore — settling is a convenience, never a correctness gate.
              }
            };

            const augmentPage = (page) => {
              if (!page || page.__dailiesHuman) {
                return page;
              }
              Object.defineProperty(page, "__dailiesHuman", { value: true });
              // The click itself — reused by humanClickAndWaitForURL, which does
              // its own load-state wait on top. No separate post-click settle
              // needed here: locator.click()/ElementHandle.click() (the forked
              // client's Locator/ElementHandle classes) already settle themselves
              // after acting (settleAfterInteraction.ts), regardless of which one
              // resolveClickTarget returned.
              const clickCore = async (target, options) => {
                const locator = await resolveClickTarget(page, target);
                await revealAndGlide(page, locator);
                await locator.click(options);
              };
              page.humanClick = async (target, options) => {
                await clickCore(target, options);
              };
              page.humanFill = async (target, text, options) => {
                const locator = resolveLocator(page, target);
                // Skip the click/clear when typing into a field that's already
                // active — e.g. an open combobox (TomSelect) whose dropdown a
                // second click would dismiss, or a focused search box you want to
                // append to. The cursor still glides over for the recording.
                const shouldClick = !(options && options.click === false);
                const shouldClear = !(options && options.clear === false);
                await revealAndGlide(page, locator);
                if (shouldClick) await locator.click();
                // Park the cursor just clear of the field so it doesn't sit on top
                // of the text as it's typed. Visual only (no DOM interaction), so
                // it's safe even when the click is skipped.
                //
                // The destination must NOT be a fixed offset from one corner. It
                // used to be "left + 8..24", which put the cursor at the field's
                // top-LEFT corner after every single click — a ±16px jitter on a
                // 300px field reads as no variation at all, and on camera the
                // mouse visibly snapped to the same spot on every field in the
                // form. So drift from where the click actually LANDED, spread
                // across the field's own width.
                //
                // Still always ABOVE the field: below is where a combobox opens
                // its options (TomSelect, a datepicker), and parking there covers
                // the very list the viewer needs to see.
                await locator
                  .evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    const cursor = window.__dailiesCursor;
                    const from =
                      typeof cursor?.x === "number"
                        ? cursor.x
                        : r.left + r.width / 2;
                    // Bounded by the field so the cursor never parks off the
                    // control it just used, and collapses to a nudge on a narrow one.
                    const spread = Math.max(0, Math.min(r.width / 2 - 8, 70));
                    const x = Math.min(
                      r.right - 6,
                      Math.max(r.left + 6, from + (Math.random() * 2 - 1) * spread)
                    );
                    cursor?.park(x, r.top - (6 + Math.random() * 16));
                  })
                  .catch(() => undefined);
                if (shouldClear) await locator.fill("");
                // Type with variable per-character timing for a natural human rhythm.
                const chars = Array.from(String(text));
                const fixedDelay = options && 'delay' in options ? options.delay : null;
                // Keystroke budget (the typing only — the pre-type beat and the
                // post-type rest sit outside it). Typed at full human leisure a
                // long value is film nobody watches. MEASURED, 193 characters
                // into a textarea: 26.2s unbounded, 7.9s with this budget, same
                // text arriving character for character. So the cadence is
                // PLANNED up front, summed, and scaled to fit — which keeps the
                // rhythm (the ratios between a fluent key and a hesitation)
                // while capping the wall clock. Short fills (a name, an email —
                // the overwhelming majority) come in under budget and are
                // untouched. Raise it per call for the rare field where the
                // typing itself is the thing being demonstrated.
                //
                // The budget cannot take a long fill below its round-trip floor:
                // every keystroke is a sandbox->daemon->CDP hop (~15ms), so
                // those same 193 characters carry ~2.9s of fixed cost that no
                // scaling touches — which is most of the gap between the 4500ms
                // budget and the 7.9s measured above.
                const budgetMs =
                  options && typeof options.budgetMs === 'number'
                    ? options.budgetMs
                    : 4500;
                // Always pause between landing on the field and the first
                // keystroke — a person never clicks and types in the same
                // instant, and typing onto a field that hasn't visibly focused
                // reads as a glitch. A presenter's natural beat by default; a
                // short floor even in fixed-delay (deterministic) mode.
                const preType =
                  options && typeof options.preTypeMs === 'number'
                    ? options.preTypeMs
                    : fixedDelay === null
                      ? 250 + Math.random() * 250
                      : 120;
                if (preType > 0) await page.waitForTimeout(preType);
                // Plan the whole cadence before typing a single key, so the
                // total is known and can be scaled to budgetMs. Deciding each
                // delay as you go can't be bounded without either truncating
                // the tail (the last word suddenly types at machine speed) or
                // guessing a per-key cap up front (which flattens the rhythm
                // the pauses exist to create).
                //
                // What makes the rhythm read as a person rather than a metronome:
                //  - bursts. Real typing comes in fluent runs of a few
                //    characters, then the hands re-settle. This is independent
                //    of the text's grammar, which is why it isn't folded into
                //    the punctuation rule below.
                //  - reach cost. A capital is a shift chord and a digit or
                //    symbol is a trip off the home row; both are measurably
                //    slower than a lowercase letter.
                //  - hesitation. A clause boundary is where a person stops to
                //    think; a word break is a shorter version of the same.
                const plan = [];
                let burstLeft = 3 + Math.floor(Math.random() * 5);
                for (let i = 0; i < chars.length; i++) {
                  const ch = chars[i];
                  if (fixedDelay !== null) {
                    plan.push(fixedDelay);
                    continue;
                  }
                  let d = 45 + Math.random() * 35;
                  if (/[A-Z]/.test(ch)) {
                    d += 25 + Math.random() * 35;
                  } else if (/[^a-z\\s]/i.test(ch)) {
                    d += 30 + Math.random() * 45;
                  }
                  if (/[.!?,;:]/.test(ch)) {
                    d += 90 + Math.random() * 170;
                  } else if (/\\s/.test(ch)) {
                    d += 40 + Math.random() * 90;
                  }
                  burstLeft -= 1;
                  if (burstLeft <= 0) {
                    d += 70 + Math.random() * 180;
                    burstLeft = 3 + Math.floor(Math.random() * 5);
                  }
                  plan.push(d);
                }
                // Scale, don't truncate: every delay shrinks by the same factor,
                // so a long value types faster but still hesitates in the same
                // places. A fixed-delay (deterministic) caller is never scaled —
                // it asked for an exact cadence.
                //
                // MIN_KEY_MS is the floor that keeps this honest, and it was
                // added after measuring the failure. 400 characters against the
                // 4500ms budget scales the plan to a ~10ms median gap between
                // keystrokes — at that point waitForTimeout is below the
                // per-key round-trip cost, contributes nothing, and the field
                // fills at machine speed. Measured: 294 of 399 gaps under 20ms,
                // which on camera reads as a paste with jitter, not typing.
                // So the budget is BEST-EFFORT: it scales the cadence down
                // until the floor binds, and past that the floor wins and the
                // total exceeds the budget. That is the right trade — a value
                // too long to type believably in its budget should look slow,
                // not look pasted. (Above roughly budgetMs / MIN_KEY_MS
                // characters the floor governs; at the 4500ms default that is
                // about 160. A value far past that is a paste in real life too,
                // so consider whether the recording needs to show it typed.)
                const MIN_KEY_MS = 28;
                let planned = 0;
                for (let i = 0; i < plan.length; i++) planned += plan[i];
                const pace =
                  fixedDelay === null && planned > budgetMs && planned > 0
                    ? budgetMs / planned
                    : 1;
                if (pace < 1) {
                  for (let i = 0; i < plan.length; i++) {
                    plan[i] = Math.max(MIN_KEY_MS, plan[i] * pace);
                  }
                }
                // QWERTY neighbours for the occasional fat-finger typo.
                const NEIGHBORS = { a:'sq', s:'ad', d:'sf', f:'dg', g:'fh', h:'gj', j:'hk', k:'jl', l:'k', e:'rw', r:'et', t:'ry', i:'ou', o:'ip', u:'yi', n:'mb', m:'n' };
                let didTypo = false;
                for (let i = 0; i < chars.length; i++) {
                  const ch = chars[i];
                  // Rare typo-and-correct: hit a neighbouring key, pause, backspace,
                  // then the right one. Only ADDS key/input events (the count
                  // assertion stays valid) and never changes the final value. Once
                  // per fill, never on the last char, and not in fixed-delay mode.
                  // Skipped entirely on a scaled (over-budget) fill: that value is
                  // already being hurried, so spending ~300ms on a flourish there
                  // would defeat the budget it was scaled to meet.
                  if (
                    fixedDelay === null &&
                    pace === 1 &&
                    !didTypo &&
                    i < chars.length - 1 &&
                    /[a-z]/i.test(ch) &&
                    Math.random() < 0.02
                  ) {
                    const lower = ch.toLowerCase();
                    const near = NEIGHBORS[lower];
                    if (near) {
                      didTypo = true;
                      const w = near[Math.floor(Math.random() * near.length)];
                      const wrong = ch === lower ? w : w.toUpperCase();
                      await locator.pressSequentially(wrong, { delay: 0 });
                      await page.waitForTimeout(120 + Math.random() * 180);
                      await locator.press('Backspace');
                      await page.waitForTimeout(80 + Math.random() * 120);
                    }
                  }
                  await locator.pressSequentially(ch, { delay: 0 });
                  const delay = plan[i];
                  if (delay > 0) await page.waitForTimeout(delay);
                }
                // Rest on the finished field before anything else happens. Two
                // reasons: the completed value needs a beat to be legible on
                // camera, and whatever the field commit triggers (blur
                // validation, a dependent rebuild, a submit button enabling)
                // then reads as a CONSEQUENCE of the typing rather than
                // something that happened during it.
                const postType = fixedDelay === null ? 220 + Math.random() * 200 : 80;
                await page.waitForTimeout(postType);
                // Typing into a field routinely fires inline validation or a
                // dependent-field rebuild; settle so the next interaction sees
                // the committed DOM.
                await settleAfterInteraction();
              };
              // Attach files to a file <input> from the sandbox temp directory —
              // the same directory writeFile/readFile use. Pass one filename or
              // an array; each is read host-side (confined to that directory) and
              // handed to Playwright as an in-memory payload, so no host path is
              // ever exposed to the script and the QuickJS client never touches
              // the filesystem. Glides the cursor to the control first when it's
              // visible (a styled button); silently skips the camera move for the
              // hidden <input> that file pickers usually use. Write the file with
              // writeFile(name, data) first, or have the user drop it in via
              // takeover, then point this at the input.
              page.setInputFiles = async (target, files, options) => {
                const names = Array.isArray(files) ? files : [files];
                const payloads = [];
                for (const name of names) {
                  const f = await hostCall(
                    "readUploadFile",
                    JSON.stringify([name]),
                  );
                  payloads.push({
                    name: f.name,
                    mimeType: f.mimeType,
                    buffer: Buffer.from(f.base64, "base64"),
                  });
                }
                const locator = resolveLocator(page, target);
                // Best-effort camera move; hidden file inputs throw on reveal, so
                // don't let that abort the upload.
                await revealAndGlide(page, locator).catch(() => undefined);
                await locator.setInputFiles(payloads, options);
                // A file selection can trigger a preview render or upload-driven
                // rebuild; settle before the next interaction.
                await settleAfterInteraction();
              };
              // Spotlight: animate the vignette to focus on a specific element
              // (or the current cursor position when called with no argument).
              // Call this before interacting with a subtle element the reviewer
              // might miss — a validation error, an inconspicuous field, etc.
              page.showSpotlight = async (target) => {
                const box = target
                  ? await resolveLocator(page, target).boundingBox().catch(() => null)
                  : null;
                await page.evaluate((rect) => {
                  const proxy = rect
                    ? { getBoundingClientRect: () => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }) }
                    : null;
                  window.__dailiesCursor?.showVignette?.(proxy);
                }, box);
              };
              // Record a caption for this moment of the run. Nothing is
              // painted into the page: the caption is stored as timed data and
              // rendered at session end, which is what lets one recording be
              // finished plain, cinematic or song. The condense pass protects
              // each caption's span so it stays on screen long enough to read
              // even when the page underneath is perfectly still.
              page.showCaption = async (text, options) => {
                const ms =
                  options && typeof options.durationMs === "number"
                    ? options.durationMs
                    : 3000;
                await hostCall("recordCaption", JSON.stringify([text, ms]));
              };
              const nativeWaitForURL =
                typeof page.waitForURL === "function"
                  ? page.waitForURL.bind(page)
                  : null;
              // Wait for a client-side navigation by polling the live URL
              // instead of relying only on Playwright's "navigated" channel
              // event, which does not fire reliably for History API (pushState)
              // navigations used by Turbo/Hotwire and SPA routers — so the stock
              // waitForURL hangs until timeout even after the URL has changed.
              // The native wait still runs in the background (authoritative for
              // full-document navigations and exact glob/baseURL matching);
              // polling location.href rescues same-document navigations. A URL
              // match does NOT guarantee the new content has rendered — act on a
              // destination element afterward (or just end the step, which Dailies
              // settles), as the observe-first rules advise.
              page.waitForURL = async (url, options) => {
                const opts = options || {};
                const timeout =
                  typeof opts.timeout === "number" ? opts.timeout : 30000;
                const matches = makeUrlMatcher(url);
                let nativeSettled = false;
                if (nativeWaitForURL) {
                  nativeWaitForURL(url, { ...opts, timeout }).then(
                    () => {
                      nativeSettled = true;
                    },
                    () => {
                      // Native rejects/times out on History API navs — the poll
                      // below is the source of truth in that case.
                    },
                  );
                }
                const intervalMs = 150;
                let waited = 0;
                for (;;) {
                  if (nativeSettled) {
                    return;
                  }
                  const href = await page
                    .evaluate(() => location.href)
                    .catch(() => null);
                  if (href && matches(href)) {
                    return;
                  }
                  if (waited >= timeout) {
                    throw new Error(
                      \`page.waitForURL: timed out after \${timeout}ms waiting for \${String(url)} (current: \${href || "unknown"})\`,
                    );
                  }
                  await page.waitForTimeout(intervalMs);
                  waited += intervalMs;
                }
              };
              // Wait until the live URL CHANGES, without knowing the
              // destination ahead of time — for confirming a click navigated
              // somewhere new during exploratory QA. Reading the URL right after
              // the click is racy: a DOM-quiescence wait can go quiet before
              // Turbo/Hotwire (or an SPA router) runs its pushState, so the URL
              // read back is stale. This waits on the URL specifically. Capture
              // the starting URL BEFORE the click (pass { from }), or start the
              // wait before the click — otherwise the navigation can finish
              // first and "from" is already the new URL. Reads location.href
              // (NOT page.url(), which the client caches and never refreshes on
              // a pushState nav). Returns the new href.
              page.waitForURLChange = async (options) => {
                const opts = options || {};
                const timeout =
                  typeof opts.timeout === "number" ? opts.timeout : 30000;
                const from =
                  typeof opts.from === "string"
                    ? opts.from
                    : await page
                        .evaluate(() => location.href)
                        .catch(() => null);
                const intervalMs = 150;
                let waited = 0;
                for (;;) {
                  const href = await page
                    .evaluate(() => location.href)
                    .catch(() => null);
                  if (href && href !== from) {
                    return href;
                  }
                  if (waited >= timeout) {
                    throw new Error(
                      \`page.waitForURLChange: URL did not change from \${from || "unknown"} within \${timeout}ms\`,
                    );
                  }
                  await page.waitForTimeout(intervalMs);
                  waited += intervalMs;
                }
              };
              // Click a control that triggers a navigation and wait for it the
              // race-free way, in one call. Reading the URL AFTER a click is
              // racy: a Turbo/Hotwire/SPA visit fetches before it swaps the DOM
              // and runs pushState, and page.url() is client-cached and lags a
              // same-document nav until it commits — so reading the URL right
              // after the click gets the OLD url (the DOM goes quiet during the
              // fetch gap, before the nav commits). This captures location.href
              // BEFORE the click, clicks, then waits — under ONE shared timeout — for the
              // live URL to settle AND the page to reach a load state. Returns
              // the new href.
              //   options.url       wait for this specific destination (glob /
              //                     RegExp / predicate) instead of "any change".
              //   options.loadState which load state to also await; default
              //                     "load" (safe everywhere — and a harmless
              //                     no-op for a same-document Turbo nav, where
              //                     the URL wait is the real signal). Pass
              //                     "networkidle" to also wait for the fetch and
              //                     its sub-resources to go quiet — only on apps
              //                     whose sole live connection is a WebSocket (an
              //                     open WebSocket does NOT hold networkidle;
              //                     long-poll / SSE / heartbeat HTTP does).
              //   options.timeout   shared cap for both waits (default 15000).
              //   options.clickOptions  passed through to the underlying click.
              // For a click that should NOT navigate, use humanClick — this
              // throws (the URL never changes) once the timeout elapses.
              page.humanClickAndWaitForURL = async (target, options) => {
                const opts = options || {};
                const timeout =
                  typeof opts.timeout === "number" ? opts.timeout : 15000;
                const loadState = opts.loadState || "load";
                // Capture BEFORE the click so the wait straddles the navigation.
                const from = await page
                  .evaluate(() => location.href)
                  .catch(() => null);
                // Use the settle-free click: this method does its own load-state
                // wait below, so a per-interaction settle here would be redundant.
                await clickCore(target, opts.clickOptions);
                const urlWait =
                  opts.url !== undefined
                    ? page.waitForURL(opts.url, { timeout })
                    : page.waitForURLChange({ from, timeout });
                // The URL wait is authoritative for "did it navigate"; a
                // load-state timeout shouldn't reject the call, so swallow it.
                await Promise.all([
                  urlWait,
                  page
                    .waitForLoadState(loadState, { timeout })
                    .catch(() => undefined),
                ]);
                return page.evaluate(() => location.href).catch(() => null);
              };
              // Reveal a region for the camera without acting on it: smooth-
              // scroll it into view and glide the virtual cursor onto it (the
              // motion humanClick/humanFill use, minus the click). Use this to
              // show something in the recording — never window.scrollTo or
              // page.evaluate(scroll), which aren't visible on camera. Observing
              // never needs it: snapshotForAI captures the whole page
              // regardless of scroll position.
              page.reveal = async (target) => {
                await revealAndGlide(page, resolveLocator(page, target));
              };
              // Look at an element: reveal + glide the cursor onto it WITHOUT
              // clicking, then rest a beat longer than reveal so the viewer's eye
              // settles on it. A deliberate "now look here".
              page.lookAt = async (target) => {
                await revealAndGlide(page, resolveLocator(page, target));
                await page.waitForTimeout(400);
              };
              // Demonstrative cursor gestures that draw a viewer's eye to an
              // element. Each reveals the element, hands the in-page cursor the
              // element's viewport rect (boundingBox is viewport-relative, like
              // getBoundingClientRect — same space the fixed-position cursor uses
              // after scrollIntoViewIfNeeded), and waits the duration the gesture
              // reports back. Cosmetic only — the cursor is a visual overlay that
              // dispatches no input, so these never click, type, or change focus.
              const revealForGesture = async (locator) => {
                await smoothReveal(locator);
                await locator.scrollIntoViewIfNeeded().catch(() => undefined);
                const box = await locator.boundingBox().catch(() => null);
                if (!box) {
                  return null;
                }
                return {
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  right: box.x + box.width,
                  bottom: box.y + box.height,
                };
              };
              // Trace a hand-drawn ellipse around the element. opts.loops (default
              // 1) circles more than once.
              page.circle = async (target, options) => {
                const rect = await revealForGesture(resolveLocator(page, target));
                if (!rect) {
                  return;
                }
                const ms = await page
                  .evaluate(
                    (arg) =>
                      window.__dailiesCursor?.circleAround?.(arg.rect, arg.opts) || 0,
                    { rect, opts: options || {} },
                  )
                  .catch(() => 0);
                await page.waitForTimeout(typeof ms === "number" ? ms : 0);
              };
              // Sweep the cursor under the element; short elements get a second,
              // reverse pass (double underline).
              page.underline = async (target) => {
                const rect = await revealForGesture(resolveLocator(page, target));
                if (!rect) {
                  return;
                }
                const ms = await page
                  .evaluate(
                    (arg) => window.__dailiesCursor?.underlineAcross?.(arg) || 0,
                    rect,
                  )
                  .catch(() => 0);
                await page.waitForTimeout(typeof ms === "number" ? ms : 0);
              };
              // Two small nudges toward the element — a "look here" tap.
              page.pointAt = async (target) => {
                const rect = await revealForGesture(resolveLocator(page, target));
                if (!rect) {
                  return;
                }
                const ms = await page
                  .evaluate(
                    (arg) => window.__dailiesCursor?.pointAt?.(arg) || 0,
                    rect,
                  )
                  .catch(() => 0);
                await page.waitForTimeout(typeof ms === "number" ? ms : 0);
              };
              // Drag-select the element's text so the browser paints its native
              // highlight while the I-beam sweeps across. opts.clearAfterMs
              // collapses the selection that long after the sweep finishes.
              page.highlightText = async (target, options) => {
                const locator = resolveLocator(page, target);
                await smoothReveal(locator);
                await locator.scrollIntoViewIfNeeded().catch(() => undefined);
                const ms = await locator
                  .evaluate((el, opts) => {
                    const b = el.getBoundingClientRect();
                    const rect = {
                      left: b.left,
                      top: b.top,
                      width: b.width,
                      height: b.height,
                      right: b.right,
                      bottom: b.bottom,
                    };
                    return (
                      window.__dailiesCursor?.highlightText?.(el, rect, opts) || 0
                    );
                  }, options || {})
                  .catch(() => 0);
                await page.waitForTimeout(typeof ms === "number" ? ms : 0);
              };
              // Tell Dailies how to answer browser dialogs (alert/confirm/prompt)
              // on this page. By default an unanswered dialog FAILS the step (it
              // blocks the page and silently cancels the action that opened it),
              // so opt in deliberately, before the action that triggers it:
              //   await page.acceptDialogs();   // click OK / confirm
              //   await page.dismissDialogs();  // cancel quietly, no failure
              //   await page.failOnDialogs();    // back to the strict default
              // The choice lasts for this step only (the next step starts strict
              // again) so auto-answering never hardens into invisible boilerplate.
              // (A standard page.on("dialog", ...) handler does NOT work here —
              // Dailies answers dialogs daemon-side — so use these methods.)
              page.acceptDialogs = async () => {
                await hostCall("setDialogPolicy", JSON.stringify([page._guid, "accept"]));
              };
              page.dismissDialogs = async () => {
                await hostCall("setDialogPolicy", JSON.stringify([page._guid, "dismiss"]));
              };
              page.failOnDialogs = async () => {
                await hostCall("setDialogPolicy", JSON.stringify([page._guid, "fail"]));
              };
              return page;
            };

`;
