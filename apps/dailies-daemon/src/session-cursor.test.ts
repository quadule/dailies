import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_CURSOR_SCRIPT } from "./session-cursor.js";

// The init script attaches these to the page's `window` at runtime; declare them
// so the in-browser `page.evaluate` callbacks type-check against the real shape.
declare global {
  interface Window {
    __dailiesCursor: {
      x: number;
      y: number;
      glyph: string;
      glide: (x: number, y: number, el?: Element) => void;
    };
    __ripples: number;
  }
}

// The virtual cursor is positioned ONLY by the agent's explicit state.glide()
// (called from the humanClick/humanFill helpers). It must never track raw mouse
// events — those are indistinguishable from the user's real pointer, so tracking
// them would make it chase a stray move. These tests pin that contract against a
// real browser with the init script injected the same way the daemon injects it.
describe("session cursor", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function pageWithCursor() {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
    });
    await context.addInitScript(SESSION_CURSOR_SCRIPT);
    const page = await context.newPage();
    await page.setContent(
      '<a id="link" href="#" style="position:absolute;left:380px;top:280px">a link</a>'
    );
    await page.waitForFunction(() => Boolean(window.__dailiesCursor));
    return { context, page };
  }

  it("ignores a mouse move it was not told to make", async () => {
    const { context, page } = await pageWithCursor();
    try {
      const before = await page.evaluate(() => ({
        x: window.__dailiesCursor.x,
        y: window.__dailiesCursor.y,
      }));
      await page.mouse.move(120, 140);
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        x: window.__dailiesCursor.x,
        y: window.__dailiesCursor.y,
      }));
      // The cursor stayed put — it did not follow the pointer to (120, 140).
      expect(after).toEqual(before);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("glides onto the target, picks the glyph, and ripples once on the click", async () => {
    const { context, page } = await pageWithCursor();
    try {
      // Count ripple elements as they are created (the animation removes itself,
      // so a later DOM query could miss it).
      await page.evaluate(() => {
        window.__ripples = 0;
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeName === "DAILIES-CLICK-RIPPLE") {
                window.__ripples += 1;
              }
            }
          }
        }).observe(document.documentElement, { childList: true });
      });

      const center = await page.evaluate(() => {
        const el = document.getElementById("link");
        if (!el) {
          throw new Error("test fixture missing #link");
        }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // glide sets state.x/y and the glyph synchronously (the CSS transition
        // is cosmetic), so we can read them straight away.
        window.__dailiesCursor.glide(x, y, el);
        return { x: Math.round(x), y: Math.round(y) };
      });

      const landed = await page.evaluate(() => ({
        x: Math.round(window.__dailiesCursor.x),
        y: Math.round(window.__dailiesCursor.y),
        glyph: window.__dailiesCursor.glyph,
      }));
      expect(Math.abs(landed.x - center.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(landed.y - center.y)).toBeLessThanOrEqual(2);
      // A link computes cursor:pointer → the hand glyph.
      expect(landed.glyph).toBe("hand");

      // The real click that follows fires the armed one-shot ripple.
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => window.__ripples)).toBe(1);

      // The arm is one-shot: a further click with no fresh glide must not ripple,
      // so a stray user click between actions can't paint a phantom ripple.
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => window.__ripples)).toBe(1);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("creeps briefly after landing, then goes completely still", async () => {
    // The settle drift is what stops the cursor reading as a machine stopping
    // dead — but it MUST end. `session end` condenses a recording by detecting
    // frozen frames, so a cursor that never stops means nothing is trimmable
    // and every film gets longer. This pins both halves of that contract.
    const { context, page } = await pageWithCursor();
    try {
      const samples = await page.evaluate(async () => {
        const el = document.getElementById("link");
        if (!el) {
          throw new Error("test fixture missing #link");
        }
        const r = el.getBoundingClientRect();
        window.__dailiesCursor.glide(
          r.left + r.width / 2,
          r.top + r.height / 2,
          el
        );
        const cursor = document.querySelector("dailies-virtual-cursor");
        if (!cursor) {
          throw new Error("cursor element missing");
        }
        const read = () => (cursor as HTMLElement).style.transform;
        const wait = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        // Let the glide itself finish first (its duration is distance-scaled
        // and capped at GLIDE_MAX_MS), so what follows is the drift alone.
        await wait(1300);
        const afterLanding = read();
        await wait(120);
        const duringDrift = read();
        // Past DRIFT_MS (900) plus the glide, the overlay must be static.
        await wait(1400);
        const settled = read();
        await wait(350);
        const stillSettled = read();
        return { afterLanding, duringDrift, settled, stillSettled };
      });

      // It was still creeping shortly after the glide landed...
      expect(samples.duringDrift).not.toBe(samples.afterLanding);
      // ...and later it is genuinely frozen — two reads apart agree exactly.
      expect(samples.stillSettled).toBe(samples.settled);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("paints the text caret transparent without disturbing the selection", async () => {
    // A blinking caret toggles about twice a second, and the condense pass
    // counts changed pixels — so each toggle is a lone changed frame that
    // splits a long idle wait into stills too short to trim. Measured: a
    // focused field held still for 9s produced changed frames 12-13 frames
    // apart at 25fps. It cannot be filtered downstream (a typed character
    // changes FEWER pixels than a caret toggle), so it is suppressed here.
    const { context, page } = await pageWithCursor();
    try {
      await page.setContent(
        '<input id="field" value="hello"><p id="para">some words</p>'
      );
      await page.waitForFunction(() =>
        Boolean(document.querySelector("style[data-dailies-caret]"))
      );
      await page.focus("#field");

      const computed = await page.evaluate(() => {
        const field = document.getElementById("field");
        const para = document.getElementById("para");
        if (!(field && para)) {
          throw new Error("test fixture missing");
        }
        return {
          fieldCaret: getComputedStyle(field).caretColor,
          rootCaret: getComputedStyle(document.documentElement).caretColor,
          // Layout must be untouched — caret-color paints, it doesn't reflow.
          fieldWidth: field.getBoundingClientRect().width,
        };
      });

      expect(computed.fieldCaret).toBe("rgba(0, 0, 0, 0)");
      expect(computed.rootCaret).toBe("rgba(0, 0, 0, 0)");
      expect(computed.fieldWidth).toBeGreaterThan(0);

      // Input still works — the caret is invisible, not disabled.
      await page.fill("#field", "");
      await page.type("#field", "typed");
      expect(await page.inputValue("#field")).toBe("typed");

      // And the native selection highlight that highlightText relies on is
      // untouched: only caret-color is overridden, never ::selection.
      const selected = await page.evaluate(() => {
        const para = document.getElementById("para");
        if (!para) {
          throw new Error("test fixture missing #para");
        }
        const range = document.createRange();
        range.selectNodeContents(para);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        return window.getSelection()?.toString();
      });
      expect(selected).toBe("some words");
    } finally {
      await context.close();
    }
  }, 30_000);

  it("starts parked off-screen so it glides in on the first interaction", async () => {
    const { context, page } = await pageWithCursor();
    try {
      const start = await page.evaluate(() => ({
        x: window.__dailiesCursor.x,
        y: window.__dailiesCursor.y,
        width: window.innerWidth,
      }));
      // Parked past the right edge — out of frame until the first glide.
      expect(start.x).toBeGreaterThanOrEqual(start.width);
    } finally {
      await context.close();
    }
  }, 30_000);
});
