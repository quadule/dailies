// Virtual cursor overlay for session recordings.
//
// Playwright drives the page through CDP, so the OS cursor never appears in
// video or screenshots — a recording shows elements reacting to invisible
// input. This context init script renders a synthetic cursor that the agent
// positions explicitly via state.glide() (from the humanClick/humanFill
// helpers), with a ripple animation on the click that follows, making recorded
// interactions legible to a human reviewer. It deliberately does NOT track
// mouse events — those are indistinguishable from the user's real pointer, so
// tracking them would make it chase a stray move between actions.
//
// Design constraints:
// - Runs in EVERY frame (mouse events fire only in the frame under the
//   pointer, with frame-local client coordinates). Only the top frame shows
//   the cursor eagerly — an eager cursor in every ad/embed iframe would draw
//   multiple cursors; subframes reveal theirs on first pointer event.
// - Must never affect the page: custom (unknown) element names so page CSS
//   selectors don't match, `pointer-events: none`, `position: fixed`, and
//   `aria-hidden` so the overlay is invisible to snapshotForAI / ARIA
//   snapshots and assistive queries.
// - Always visible and animated: the cursor glides between positions via a
//   rAF Bezier animation loop, starts at the position persisted in
//   sessionStorage (continuity across navigations) or the viewport center,
//   and re-creates itself if a SPA wipes the DOM.
// - document.open() (setContent) removes window listeners but keeps window
//   properties, so installation re-arms on an interval instead of trusting
//   the install guard.
// Baseline glide duration. The actual per-move duration is now distance-scaled
// (Fitts's law) inside glideAnimated and returned to the sandbox, which waits
// for it before pressing so the click never lands mid-flight (a teleport in the
// recording). This constant is the sandbox's floor for that wait (CURSOR_SETTLE_MS),
// so even a short hop visibly rests on the target before the click.
export const CURSOR_GLIDE_MS = 600;

export const SESSION_CURSOR_SCRIPT = `(() => {
  if (window.__dailiesCursor) {
    return;
  }
  const POS_KEY = '__dailiesCursorPos';
  // Persist hidden across the re-arm interval and same-origin navigations so a
  // takeover keeps the cursor hidden even if the page reloads mid-takeover.
  const HIDE_KEY = '__dailiesCursorHidden';
  let startHidden = false;
  try {
    startHidden = sessionStorage.getItem(HIDE_KEY) === '1';
  } catch {
    // storage unavailable — default visible
  }
  // The cursor is positioned explicitly by the agent via state.glide() (called
  // from the humanClick/humanFill helpers), not by listening to mouse events —
  // those are trusted DOM events indistinguishable from Playwright's, so tracking
  // them would make the cursor chase the user's real pointer. \`hidden\`:
  // suppressed entirely during a manual takeover.
  const state = {
    cursor: null,
    glyph: 'arrow',
    hidden: startHidden,
    pressed: false,
    x: null,
    y: null,
  };
  window.__dailiesCursor = state;

  const SIZE = 28;
  let caretStyleEl = null;
  let animRaf = null;
  let vignetteEl = null;
  let vignetteHalfW = 0;
  let vignetteHalfH = 0;
  let vignetteTimer = null;
  let spotlightRaf = null;
  let spotlightLocked = false;

  function cancelAnim() {
    if (animRaf !== null) {
      cancelAnimationFrame(animRaf);
      animRaf = null;
    }
  }

  function setTransform(x, y) {
    const el = state.cursor;
    if (el && el.isConnected) {
      el.style.transform = transformFor(x, y);
    }
  }

  function updateVignette(x, y) {
    if (spotlightLocked) return;
    if (vignetteEl && vignetteEl.isConnected) {
      vignetteEl.style.transform =
        'translate(' + (x - vignetteHalfW) + 'px,' + (y - vignetteHalfH) + 'px)';
    }
  }

  function ensureVignette() {
    if (vignetteEl && vignetteEl.isConnected) {
      return vignetteEl;
    }
    const host = document.documentElement;
    if (!host) {
      return null;
    }
    const W = window.innerWidth * 2;
    const H = window.innerHeight * 2;
    vignetteHalfW = W / 2;
    vignetteHalfH = H / 2;
    const v = document.createElement('dailies-vignette');
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText =
      'position:fixed;left:0;top:0;width:' + W + 'px;height:' + H + 'px;' +
      'pointer-events:none;z-index:2147483645;' +
      'background:radial-gradient(circle 160px at 50% 50%,transparent 35%,rgba(0,0,0,0.4) 100%);' +
      'opacity:0;transition:opacity 0.4s;';
    if (state.x !== null) {
      v.style.transform =
        'translate(' + (state.x - vignetteHalfW) + 'px,' + (state.y - vignetteHalfH) + 'px)';
    }
    host.insertBefore(v, host.firstChild);
    vignetteEl = v;
    return v;
  }

  function showVignette(targetEl) {
    if (spotlightRaf !== null) {
      cancelAnimationFrame(spotlightRaf);
      spotlightRaf = null;
    }
    if (vignetteTimer !== null) {
      clearTimeout(vignetteTimer);
      vignetteTimer = null;
    }
    spotlightLocked = false;
    const v = ensureVignette();
    if (!v) return;
    // Compute target center and circumscribed radius from the element's rect.
    var cx, cy, targetR;
    if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
      var rect = targetEl.getBoundingClientRect();
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
      var hw = rect.width / 2;
      var hh = rect.height / 2;
      targetR = Math.max(Math.sqrt(hw * hw + hh * hh) + 40, 60);
    } else {
      cx = state.x !== null ? state.x : window.innerWidth / 2;
      cy = state.y !== null ? state.y : window.innerHeight / 2;
      targetR = 120;
    }
    // Lock cursor-follow and position vignette on target immediately.
    spotlightLocked = true;
    v.style.transform = 'translate(' + (cx - vignetteHalfW) + 'px,' + (cy - vignetteHalfH) + 'px)';
    v.style.opacity = '1';
    // Animate radius: wide open → tight around the element (focus-in).
    //
    // This is as close to a ZOOM as Dailies gets, and deliberately so: a real
    // zoom means scaling the page, and a CSS transform on the root makes that
    // element the containing block for position:fixed descendants — which is
    // exactly what this overlay and the cursor are — so the overlay's
    // coordinate space stops agreeing with the viewport coordinates Playwright
    // dispatches input in, and clicks land in the wrong place. A true zoom
    // belongs in the video pipeline, after the fact, where it cannot move a
    // click. So the push is sold with light instead of scale: the aperture
    // closes AND the surround deepens together, which reads as the camera
    // moving in even though nothing on the page has moved a pixel.
    var startR = 380;
    var duration = 650;
    // Surround darkness travels with the aperture. A constant scrim made the
    // tighten read as a mask sliding in; deepening it in step is what sells
    // the push.
    var startDark = 0.28;
    var endDark = 0.66;
    // A hair tighter than the target at ~85% of the way, then back out to
    // exact — the same arrive-and-settle idea as the cursor's overshoot, and
    // what a camera operator's hand does on a focus pull.
    var settleR = Math.min(18, targetR * 0.12);
    var t0 = performance.now();
    function frame(now) {
      var t = Math.min((now - t0) / duration, 1);
      var et = t * t * (3 - 2 * t); // smooth-step ease-in-out
      var r = startR + (targetR - startR) * et;
      if (et > 0.7) {
        r -= Math.sin(((et - 0.7) / 0.3) * Math.PI) * settleR;
      }
      var dark = startDark + (endDark - startDark) * et;
      v.style.background =
        'radial-gradient(circle ' + Math.max(24, r).toFixed(0) + 'px at 50% 50%,' +
        'transparent 35%,rgba(0,0,0,' + dark.toFixed(3) + ') 100%)';
      if (t < 1) {
        spotlightRaf = requestAnimationFrame(frame);
      } else {
        spotlightRaf = null;
        vignetteTimer = setTimeout(function() {
          if (vignetteEl && vignetteEl.isConnected) {
            vignetteEl.style.opacity = '0';
          }
          // After opacity transition completes, reset gradient and unlock.
          vignetteTimer = setTimeout(function() {
            if (vignetteEl && vignetteEl.isConnected) {
              vignetteEl.style.background =
                'radial-gradient(circle 160px at 50% 50%,transparent 35%,rgba(0,0,0,0.4) 100%)';
            }
            spotlightLocked = false;
            vignetteTimer = null;
          }, 450);
        }, 1200);
      }
    }
    spotlightRaf = requestAnimationFrame(frame);
  }

  // Motion-realism tunables. The cursor should read like a confident presenter,
  // not a bot evading detection — these are deliberately gentle and named so
  // they can be adjusted by eye against an actual recording.
  // Fitts's-law glide duration: t = BASE + PER_BIT * log2(dist / WIDTH + 1).
  const GLIDE_BASE_MS = 90;
  const GLIDE_PER_BIT_MS = 180;
  const GLIDE_WIDTH_PX = 24;
  const GLIDE_JITTER = 0.15; // ±15% so repeated moves aren't identical
  const GLIDE_MIN_MS = 220;
  const GLIDE_MAX_MS = 1100;
  // Perpendicular bow of the path's mid-knots (tapers to 0 at both ends).
  const CURVE_FRAC = 0.12;
  const CURVE_MAX_PX = 48;
  // Gentle arrive-with-momentum overshoot, then settles exact. The threshold is
  // deliberately well under half a viewport width: at a 1280x720 recording most
  // purposeful moves are 150-400px, so a 280px floor meant the overshoot almost
  // never fired and the cursor stopped dead on nearly every target — the one
  // motion tell that reads unmistakably as a machine. Amplitude still scales
  // with distance (dist * 0.03), so a move just over the threshold gets a
  // barely-there correction and only a long reach gets the full OVERSHOOT_PX.
  const OVERSHOOT_MIN_PX = 170;
  const OVERSHOOT_PX = 9;
  // Sub-pixel liveness in flight; fades to 0 on landing so the rest is still.
  const TREMOR_PX = 0.6;
  // Post-landing settle drift: a real hand doesn't stop dead, it creeps for a
  // moment before going still. STRICTLY BOUNDED, and the bound is not about
  // taste — "session end" condenses the recording by detecting FROZEN frames
  // (ffmpeg freezedetect), so a cursor that drifts forever means no frame is
  // ever frozen, nothing is trimmable, and every film gets longer instead of
  // tighter. Sub-pixel doesn't save you either: antialiasing changes real
  // pixels. So the drift runs for under a second and then the overlay is
  // genuinely static, which leaves any hold longer than that trimmable.
  // MEASURED at these values: a session whose only step glides once and then
  // holds perfectly still for 12s condensed 16.4s -> 3.1s, i.e. freeze
  // detection still found the hold. Raise DRIFT_MS much past a second and you
  // are trading the film's pace for a motion tell nobody consciously notices.
  const DRIFT_MS = 900;
  const DRIFT_PX = 1.1;

  // Gesture tunables (circle / underline / point / highlight). A deliberate
  // gesture is shakier than a glide, so its hand-wobble is a touch larger.
  const WOBBLE_PX = 1.5;
  const CIRCLE_MS = 900; // per loop
  const UNDERLINE_MS = 700; // per pass
  const UNDERLINE_DOUBLE_PX = 220; // narrower than this gets a second pass
  const BOW_PX = 3; // downward bow of an underline sweep

  function easeInOut(t) {
    return t * t * (3 - 2 * t);
  }

  function reducedMotion() {
    try {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch {
      return false;
    }
  }

  // Uniform Catmull-Rom: the curve passes THROUGH p1 at u=0 and p2 at u=1, so a
  // path built from [from, ...knots, to] hits its endpoints exactly.
  function catmull(p0, p1, p2, p3, u) {
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      0.5 *
      (2 * p1 +
        (-p0 + p2) * u +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
    );
  }

  // Animate the cursor from its current position to (x, y). Returns the chosen
  // duration so the host can wait for the move to actually finish before
  // pressing. \`fixedDuration\` (used by park) bypasses the Fitts computation for
  // a short, predictable hop. Builds a multi-knot Catmull-Rom path with a gentle
  // perpendicular bow, distance-scaled timing, optional end-overshoot, and a
  // fading tremor — all collapsed to a straight, still line under reduced motion.
  function glideAnimated(x, y, fixedDuration) {
    const fromX = state.x !== null ? state.x : x;
    const fromY = state.y !== null ? state.y : y;
    cancelAnim();
    state.x = x;
    state.y = y;
    savePos(x, y);
    ensureCursor();
    ensureVignette();
    const dx = x - fromX;
    const dy = y - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 8) {
      setTransform(x, y);
      updateVignette(x, y);
      return 0;
    }
    const reduced = reducedMotion();
    // Fitts's-law duration: short hops snap, long reaches take their time.
    let duration;
    if (typeof fixedDuration === 'number') {
      duration = fixedDuration;
    } else {
      const bits = Math.log(dist / GLIDE_WIDTH_PX + 1) / Math.LN2;
      duration = GLIDE_BASE_MS + GLIDE_PER_BIT_MS * bits;
      duration *= 1 + (Math.random() * 2 - 1) * GLIDE_JITTER;
      duration = Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, duration));
    }
    // Build the path knots: from -> mid-knots (perpendicular bow) -> to.
    const perpX = -dy / dist;
    const perpY = dx / dist;
    const knotCount = dist < 200 ? 1 : dist < 500 ? 2 : 3;
    const curveAmp = reduced ? 0 : Math.min(dist * CURVE_FRAC, CURVE_MAX_PX);
    const xs = [fromX];
    const ys = [fromY];
    for (let i = 1; i <= knotCount; i++) {
      const u = i / (knotCount + 1);
      const taper = Math.sin(u * Math.PI); // 0 at ends, 1 in the middle
      const off = (Math.random() * 2 - 1) * curveAmp * taper;
      xs.push(fromX + dx * u + perpX * off);
      ys.push(fromY + dy * u + perpY * off);
    }
    xs.push(x);
    ys.push(y);
    // Pad endpoints so every segment has the four controls Catmull-Rom needs.
    const xp = [xs[0]].concat(xs, [xs[xs.length - 1]]);
    const yp = [ys[0]].concat(ys, [ys[ys.length - 1]]);
    const segs = xs.length - 1;
    const overshoot =
      !reduced && dist > OVERSHOOT_MIN_PX ? Math.min(OVERSHOOT_PX, dist * 0.03) : 0;
    const dirX = dx / dist;
    const dirY = dy / dist;
    const t0 = performance.now();
    function step(now) {
      const t = Math.min((now - t0) / duration, 1);
      const et = 1 - (1 - t) * (1 - t); // ease-out
      let fs = et * segs;
      let seg = Math.floor(fs);
      if (seg > segs - 1) seg = segs - 1;
      const lu = fs - seg;
      let bx = catmull(xp[seg], xp[seg + 1], xp[seg + 2], xp[seg + 3], lu);
      let by = catmull(yp[seg], yp[seg + 1], yp[seg + 2], yp[seg + 3], lu);
      // Forward overshoot bump: zero before 0.62 and at t=1, peaks near 0.81 —
      // the cursor drifts just past the target then settles exactly onto it.
      if (overshoot > 0 && t > 0.62) {
        const b = Math.sin(((t - 0.62) / 0.38) * Math.PI);
        bx += dirX * overshoot * b;
        by += dirY * overshoot * b;
      }
      if (!reduced && t < 1) {
        const tremor = TREMOR_PX * (1 - t);
        bx += (Math.random() * 2 - 1) * tremor;
        by += (Math.random() * 2 - 1) * tremor;
      }
      setTransform(bx, by);
      updateVignette(bx, by);
      if (t < 1) {
        animRaf = requestAnimationFrame(step);
      } else {
        setTransform(x, y);
        updateVignette(x, y);
        animRaf = null;
        if (!reduced) {
          settleDrift(x, y);
        }
      }
    }
    animRaf = requestAnimationFrame(step);
    return duration;
  }

  // Creep for DRIFT_MS after landing, then go completely still. Two sines at
  // incommensurate rates so the path doesn't visibly repeat, and it finishes by
  // snapping to the exact target (a sub-pixel correction) so the resting
  // position is the one the host asked for — the click that follows lands on
  // the element's centre either way, since the press is dispatched by
  // Playwright from the element's own geometry, not from this overlay.
  //
  // Deliberately moves the TRANSFORM only, never state.x/state.y: the logical
  // position stays the exact target, so the next glide measures its distance
  // from where the cursor was sent rather than from wherever the creep left it,
  // and nothing here writes to sessionStorage on every frame.
  function settleDrift(x, y) {
    const t0 = performance.now();
    function drift(now) {
      const t = (now - t0) / DRIFT_MS;
      if (t >= 1) {
        setTransform(x, y);
        updateVignette(x, y);
        animRaf = null;
        return;
      }
      // Fade the amplitude out so the motion dies away rather than stopping.
      const a = DRIFT_PX * (1 - t);
      const bx = x + Math.sin(t * 7.1) * a;
      const by = y + Math.sin(t * 4.3 + 1.7) * a;
      setTransform(bx, by);
      updateVignette(bx, by);
      animRaf = requestAnimationFrame(drift);
    }
    animRaf = requestAnimationFrame(drift);
  }

  const ARROW_SVG =
    '<svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 1.8 L3 18.6 L7.6 14.7 L10.4 20.9 L13.3 19.6 L10.5 13.5 L16.2 12.9 Z"' +
    ' fill="#111111" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke"/></svg>';
  // Classic pointing-hand glyph, shown over links and anything the page styles
  // as clickable (computed cursor: pointer).
  const HAND_SVG =
    '<svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M9.2 3.1a1.3 1.3 0 0 1 2.6 0v7.1h.7v-1a1.2 1.2 0 0 1 2.4 0v1.3h.7v-.8a1.2 1.2 0 0 1 2.4 0v1.5h.6v-.5a1.1 1.1 0 0 1 2.2 0v4.6c0 1-.2 1.6-.6 2.4l-1.3 2.6c-.3.6-.9 1-1.6 1h-5.5c-.6 0-1.2-.3-1.5-.8l-3.3-4.6c-.4-.6-.3-1.4.2-1.9.6-.5 1.4-.5 1.9.1l1.1 1.2z"' +
    ' fill="#111111" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke"/></svg>';
  // I-beam, shown over text fields (computed cursor: text). White halo under a
  // black bar so it stays legible on any background, matching the other glyphs.
  const TEXT_SVG =
    '<svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M9 4 H15 M12 4 V20 M9 20 H15" fill="none" stroke="#ffffff"' +
    ' stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" paint-order="stroke"/>' +
    '<path d="M9 4 H15 M12 4 V20 M9 20 H15" fill="none" stroke="#111111"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" paint-order="stroke"/></svg>';

  function loadPos() {
    try {
      const raw = sessionStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          return p;
        }
      }
    } catch {
      // storage unavailable (sandboxed frame, data: URL) — fall through
    }
    return null;
  }

  function savePos(x, y) {
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
    } catch {
      // best effort
    }
  }

  function transformFor(x, y) {
    // Arrow/hand hotspot is the glyph tip near the box's top-left, so the box
    // sits at (x,y). The I-beam's hotspot is its centre, so shift the box
    // up-left by half its size to centre it on (x,y).
    const center = state.glyph === 'text' ? ' translate(-50%,-50%)' : '';
    const scale = state.pressed ? ' scale(0.85)' : '';
    return 'translate(' + x + 'px,' + y + 'px)' + center + scale;
  }

  function ensureCursor() {
    let el = state.cursor;
    if (el && el.isConnected) {
      return el;
    }
    const host = document.documentElement;
    if (!host) {
      return null;
    }
    if (state.x === null) {
      const stored = loadPos();
      if (stored) {
        state.x = stored.x;
        state.y = stored.y;
      } else {
        // Fresh session: park the cursor just off the bottom-right edge so it's
        // out of frame, then glide in from the side on the first interaction —
        // like a presenter moving their hand into shot — instead of sitting in
        // the middle of the page from the first frame. Once it has moved, the
        // on-screen position persists (sessionStorage) across navigations.
        state.x = window.innerWidth + SIZE;
        state.y = Math.round(window.innerHeight * 0.82);
      }
    }
    el = document.createElement('dailies-virtual-cursor');
    el.setAttribute('aria-hidden', 'true');
    el.dataset.turboPermanent = true;
    el.style.cssText =
      'position:fixed;left:0;top:0;width:' + SIZE + 'px;height:' + SIZE + 'px;' +
      'display:' + (state.hidden ? 'none' : 'block') + ';' +
      'pointer-events:none;z-index:2147483647;will-change:transform;' +
      'transform:' + transformFor(state.x, state.y) + ';';
    el.innerHTML = svgFor(state.glyph);
    host.appendChild(el);
    state.cursor = el;
    return el;
  }

  // Paint the text caret transparent for the recording.
  //
  // WHY, measured. The condense pass detects motion by counting CHANGED PIXELS
  // per frame, so it sees the virtual cursor (ffmpeg's freezedetect thresholds
  // the MEAN frame difference and was blind to a 28px overlay). That
  // sensitivity is what makes the cut safe, and it is also what makes a
  // blinking caret expensive: the caret toggles about twice a second, each
  // toggle is ONE changed frame, so a long idle wait in a focused field is
  // chopped into ~0.46s stills that are each too short to trim, and a page
  // doing nothing survives in full.
  //
  // It cannot be filtered downstream. Measured on real footage, typing one
  // character changes 0.000086 of the frame and a 2x18px caret toggle changes
  // 0.000028 — a typed character is SMALLER than a caret, and both arrive as a
  // lone changed frame between stills. Any size bound that absorbs the caret
  // also absorbs typing, which would make text appear in a field instantly
  // instead of being typed. So it has to be fixed in the recording.
  //
  // And it does blink here. Measured on a recorded session that focused a field
  // and then held still for 9s: 51 of the gaps between changed frames were
  // exactly 12-13 frames at 25fps (0.48-0.52s) — a textbook caret toggle.
  //
  // caret-color is purely presentational: no layout, no hit-testing, no input
  // behaviour, and it leaves ::selection alone so highlightText's native
  // selection paint still works. Playwright's own screenshot caret:"hide" option
  // does the same thing, so there is precedent for hiding it on camera.
  //
  // Both selectors are load-bearing. The :root rule is what reaches into shadow trees
  // — caret-color is inherited, and inheritance crosses a shadow boundary, so a
  // web component whose own CSS says nothing about the caret gets it from here.
  // The universal rule is what beats a page that sets caret-color on its own inputs, since
  // inheritance only supplies a value to an element that has no declaration of
  // its own, and !important then wins over any non-important page rule whatever
  // its specificity. A component that sets caret-color INSIDE its own shadow
  // stylesheet still wins — accepted: rare, and the alternative is walking
  // every shadow root on an interval.
  function ensureCaretStyle() {
    if (caretStyleEl && caretStyleEl.isConnected) {
      return;
    }
    const host = document.head || document.documentElement;
    if (!host) {
      return;
    }
    const el = document.createElement('style');
    el.setAttribute('data-dailies-caret', 'hidden');
    el.textContent =
      ':root{caret-color:transparent !important}' +
      '*{caret-color:transparent !important}';
    host.appendChild(el);
    caretStyleEl = el;
  }

  function moveTo(x, y) {
    cancelAnim();
    state.x = x;
    state.y = y;
    savePos(x, y);
    ensureCursor();
    setTransform(x, y);
    updateVignette(x, y);
  }

  // Hide/show the cursor (used to suppress it during a manual takeover, where
  // the user drives with their own pointer). Persisted so a re-arm or a
  // same-origin navigation mid-takeover keeps it hidden.
  function setHidden(value) {
    state.hidden = value;
    try {
      sessionStorage.setItem(HIDE_KEY, value ? '1' : '0');
    } catch {
      // best effort
    }
    const el = state.cursor;
    if (el && el.isConnected) {
      el.style.display = value ? 'none' : 'block';
    }
    if (value) {
      if (vignetteTimer !== null) {
        clearTimeout(vignetteTimer);
        vignetteTimer = null;
      }
      const v = vignetteEl;
      if (v && v.isConnected) {
        v.style.opacity = '0';
      }
    }
  }
  state.setHidden = setHidden;

  function svgFor(glyph) {
    if (glyph === 'hand') {
      return HAND_SVG;
    }
    if (glyph === 'text') {
      return TEXT_SVG;
    }
    return ARROW_SVG;
  }

  // Realistic glyph chosen from the element's computed cursor: an I-beam over
  // text fields (cursor:text), a hand over links/clickables (cursor:pointer),
  // an arrow elsewhere. Reading the resolved cursor (not the tag) covers native
  // controls and anything the page restyles.
  function glyphFor(el) {
    try {
      if (!(el instanceof Element)) {
        return 'arrow';
      }
      const c = getComputedStyle(el).cursor;
      if (c === 'text' || c === 'vertical-text') {
        return 'text';
      }
      if (c === 'pointer') {
        return 'hand';
      }
      return 'arrow';
    } catch {
      return 'arrow';
    }
  }

  function setGlyph(glyph) {
    if (state.glyph === glyph) {
      return;
    }
    state.glyph = glyph;
    if (state.cursor && state.cursor.isConnected) {
      state.cursor.innerHTML = svgFor(glyph);
      // The I-beam carries a different hotspot offset, so re-apply the transform.
      if (state.x !== null) {
        state.cursor.style.transform = transformFor(state.x, state.y);
      }
    }
  }

  // Re-evaluate the glyph for whatever now sits under the pointer, so it tracks
  // page changes that happen WITHOUT mouse movement (content loads, a menu
  // opens, navigation) — not just on mousemove.
  function refreshGlyph() {
    if (state.x === null || !isTopFrame) {
      return;
    }
    try {
      const el = document.elementFromPoint(state.x, state.y);
      if (el) {
        setGlyph(glyphFor(el));
      }
    } catch {
      // elementFromPoint can throw on a detached document — ignore.
    }
  }

  function ripple(x, y) {
    const host = document.documentElement;
    if (!host) {
      return;
    }
    const el = document.createElement('dailies-click-ripple');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'position:fixed;width:44px;height:44px;display:block;border-radius:50%;' +
      'pointer-events:none;z-index:2147483646;' +
      'border:3px solid rgba(255,64,129,0.9);background:rgba(255,64,129,0.25);' +
      'left:' + x + 'px;top:' + y + 'px;' +
      'transform:translate(-50%,-50%) scale(0.3);opacity:0;';
    host.appendChild(el);
    try {
      const animation = el.animate(
        [
          { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(1.4)', opacity: 0 },
        ],
        { duration: 450, easing: 'ease-out' }
      );
      animation.onfinish = () => el.remove();
      // Fallback removal in case onfinish never fires (e.g. display:none tab).
      setTimeout(() => el.remove(), 800);
    } catch {
      el.remove();
    }
  }

  // Arm a one-shot press for the click that's about to happen: the next trusted
  // mousedown (the helper's real click, landing where we just glided) shows the
  // ripple and press-scale, then disarms. Because it's one-shot it can't react
  // to a later stray user click.
  function armPress() {
    const onDown = (e) => {
      state.pressed = true;
      moveTo(e.clientX, e.clientY);
      ripple(e.clientX, e.clientY);
    };
    const onUp = (e) => {
      state.pressed = false;
      moveTo(e.clientX, e.clientY);
    };
    window.addEventListener('mousedown', onDown, { capture: true, once: true });
    window.addEventListener('mouseup', onUp, { capture: true, once: true });
  }

  function glide(x, y, el) {
    setGlyph(glyphFor(el));
    // Distance-scaled duration (returned to the host so it can wait for the
    // cursor to actually land before the click fires — see revealAndGlide).
    const duration = glideAnimated(x, y);
    armPress();
    return duration;
  }
  state.glide = glide;
  state.showVignette = showVignette;

  function park(x, y) {
    return glideAnimated(x, y, 250);
  }
  state.park = park;

  // Shared gesture runner: drive the cursor along sample(t) (t in [0,1]) over
  // \`duration\` ms, adding a faint per-frame hand-wobble and landing exactly on
  // sample(1). Fire-and-forget like glideAnimated — the host waits the duration
  // the gesture reports. sample() may carry a side effect (e.g. growing a
  // selection in lockstep with the sweep).
  function gestureLoop(duration, sample) {
    cancelAnim();
    const reduced = reducedMotion();
    const t0 = performance.now();
    function step(now) {
      const t = Math.min((now - t0) / duration, 1);
      const p = sample(t);
      let bx = p.x;
      let by = p.y;
      if (!reduced && t < 1) {
        bx += (Math.random() * 2 - 1) * WOBBLE_PX;
        by += (Math.random() * 2 - 1) * WOBBLE_PX;
      }
      state.x = bx;
      state.y = by;
      savePos(bx, by);
      setTransform(bx, by);
      updateVignette(bx, by);
      if (t < 1) {
        animRaf = requestAnimationFrame(step);
      } else {
        animRaf = null;
      }
    }
    animRaf = requestAnimationFrame(step);
  }

  // Trace 1+ loops around an element's box, then a little extra so the ring
  // overlaps where it began (a hand-drawn circle never closes perfectly). The
  // angle advances on an ease-in-out clock, not constant angular speed.
  function circleAround(rect, opts) {
    const pad = 14;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rx = rect.width / 2 + pad;
    const ry = rect.height / 2 + pad + (Math.random() * 6 - 3);
    const loops = (opts && opts.loops) || 1;
    const start = Math.random() * Math.PI * 2;
    const extra = ((10 + Math.random() * 10) * Math.PI) / 180;
    const sweep = loops * Math.PI * 2 + extra;
    const dur = CIRCLE_MS * loops;
    const sx = cx + rx * Math.cos(start);
    const sy = cy + ry * Math.sin(start);
    setGlyph('arrow');
    const d1 = glideAnimated(sx, sy);
    setTimeout(function () {
      gestureLoop(dur, function (t) {
        const ang = start + sweep * easeInOut(t);
        return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
      });
    }, d1 + 60);
    return d1 + 60 + dur + 80;
  }
  state.circleAround = circleAround;

  // Sweep the cursor along the underside of an element with eased speed and a
  // slight downward bow. Short elements get a second (reverse) pass, the way
  // someone double-underlines a short phrase for emphasis.
  function underlineAcross(rect) {
    const y0 = rect.bottom + 4;
    const x1 = rect.left + 2;
    const x2 = rect.right - 2;
    const width = Math.max(1, x2 - x1);
    const doublePass = width < UNDERLINE_DOUBLE_PX;
    setGlyph('arrow');
    const d1 = glideAnimated(x1, y0);
    setTimeout(function () {
      gestureLoop(UNDERLINE_MS, function (t) {
        const e = easeInOut(t);
        return { x: x1 + width * e, y: y0 + BOW_PX * Math.sin(e * Math.PI) };
      });
      if (doublePass) {
        setTimeout(function () {
          const y1 = y0 - 3;
          gestureLoop(UNDERLINE_MS * 0.85, function (t) {
            const e = easeInOut(t);
            return { x: x2 - width * e, y: y1 + BOW_PX * Math.sin(e * Math.PI) };
          });
        }, UNDERLINE_MS + 40);
      }
    }, d1 + 60);
    let total = d1 + 60 + UNDERLINE_MS;
    if (doublePass) total += 40 + UNDERLINE_MS * 0.85;
    return total + 80;
  }
  state.underlineAcross = underlineAcross;

  // Two small in-and-back nudges toward an element — a "look here" tap.
  function pointAt(rect) {
    const tx = rect.left + rect.width / 2;
    const ty = rect.top + rect.height / 2;
    const ax = rect.left + Math.min(rect.width * 0.25, 30);
    const ay = rect.top + Math.min(rect.height * 0.5, 20);
    setGlyph('arrow');
    const d1 = glideAnimated(ax, ay);
    const dirX = tx - ax;
    const dirY = ty - ay;
    const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    const ux = dirX / len;
    const uy = dirY / len;
    const nudge = 10;
    const nudgeDur = 150;
    const tap = function (t) {
      const e = Math.sin(t * Math.PI);
      return { x: ax + ux * nudge * e, y: ay + uy * nudge * e };
    };
    setTimeout(function () {
      gestureLoop(nudgeDur, tap);
      setTimeout(function () {
        gestureLoop(nudgeDur, tap);
      }, nudgeDur + 30);
    }, d1 + 50);
    return d1 + 50 + nudgeDur * 2 + 30 + 60;
  }
  state.pointAt = pointAt;

  // Select the first \`n\` characters of an element's text into \`range\`, walking
  // its text nodes so the offset works across nested inline markup.
  function selectFirstChars(root, n) {
    const range = document.createRange();
    range.selectNodeContents(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let counted = 0;
    let node = walker.nextNode();
    while (node) {
      const len = node.nodeValue.length;
      if (counted + len >= n) {
        range.setEnd(node, n - counted);
        return range;
      }
      counted += len;
      node = walker.nextNode();
    }
    return range;
  }

  // Drag-select an element's text: the I-beam sweeps left to right while a real
  // DOM Selection grows in lockstep, so the browser paints its native highlight.
  // Driven by the same rAF clock, never by page.mouse (the overlay ignores mouse
  // events by design, and a real drag would fight the synthetic cursor).
  function highlightText(el, rect, opts) {
    const y = rect.top + rect.height / 2;
    const x1 = rect.left + 2;
    const x2 = rect.right - 2;
    const width = Math.max(1, x2 - x1);
    let sel = null;
    let textLen = 0;
    try {
      sel = window.getSelection();
      const probe = document.createRange();
      probe.selectNodeContents(el);
      textLen = probe.toString().length;
      sel.removeAllRanges();
    } catch {
      sel = null;
    }
    setGlyph('text');
    const d1 = glideAnimated(x1, y);
    const sweepDur = Math.max(500, Math.min(1200, width * 2));
    setTimeout(function () {
      gestureLoop(sweepDur, function (t) {
        const e = easeInOut(t);
        if (sel && textLen > 0) {
          try {
            const chars = Math.max(1, Math.round(textLen * e));
            const r = selectFirstChars(el, chars);
            sel.removeAllRanges();
            sel.addRange(r);
          } catch {
            // selection unsupported on this node — sweep cosmetically only
          }
        }
        return { x: x1 + width * e, y: y };
      });
    }, d1 + 60);
    if (opts && typeof opts.clearAfterMs === 'number') {
      setTimeout(
        function () {
          try {
            window.getSelection().removeAllRanges();
          } catch {
            // best effort
          }
        },
        d1 + 60 + sweepDur + opts.clearAfterMs,
      );
    }
    return d1 + 60 + sweepDur + 80;
  }
  state.highlightText = highlightText;

  const isTopFrame = (() => {
    try {
      return window === window.top;
    } catch {
      return false;
    }
  })();

  function arm() {
    // Unconditional, unlike the cursor: only the top frame draws a cursor
    // eagerly (one per ad/embed iframe would be several cursors), but a focused
    // field inside ANY frame blinks a caret into the same recording, so the
    // caret style goes everywhere the script runs. Re-checked on the same
    // interval so it survives an SPA wiping the DOM and document.open().
    ensureCaretStyle();
    if (isTopFrame) {
      ensureCursor();
      refreshGlyph();
    }
  }
  arm();
  // document.open() (used by setContent) wipes every window listener but
  // keeps window properties — so the install guard above would leave a dead
  // overlay. Re-arming is a no-op while listeners exist (same fn reference)
  // and restores them after a wipe.
  setInterval(arm, 500);
  // Track page changes under a stationary pointer. One hit-test per tick is
  // cheap, and the timer lives on window, which document.open() preserves.
  setInterval(refreshGlyph, 250);
})();`;
