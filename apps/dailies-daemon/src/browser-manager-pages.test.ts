import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { removeDirectoryWithRetries } from "./test-cleanup.js";

const browserName = "browser-manager-pages";

function createDataUrl(title: string, body: string): string {
  return `data:text/html,${encodeURIComponent(`<title>${title}</title>${body}`)}`;
}

// Record which page the settle barrier waited on. An own property shadows the
// prototype method, so the real wait still runs underneath.
function spyOnSettle(page: Page, label: string, seen: string[]): void {
  const original = page.waitForLoadState.bind(page);
  page.waitForLoadState = ((
    state?: Parameters<Page["waitForLoadState"]>[0],
    options?: Parameters<Page["waitForLoadState"]>[1]
  ) => {
    seen.push(label);
    return original(state, options);
  }) as Page["waitForLoadState"];
}

describe.sequential("BrowserManager page discovery", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(
      path.join(os.tmpdir(), "dailies-manager-pages-")
    );
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
  }, 180_000);

  afterEach(async () => {
    await manager.stopBrowser(browserName);
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  async function ensureBrowser(): Promise<void> {
    await manager.ensureBrowser(browserName, {
      headless: true,
    });
  }

  it("activePageName follows the page a step went back to, not the newest tab", async () => {
    await ensureBrowser();

    const alpha = await manager.getPage(browserName, "alpha");
    await alpha.goto(createDataUrl("Alpha", "<main>alpha</main>"));
    const beta = await manager.getPage(browserName, "beta");
    await beta.goto(createDataUrl("Beta", "<main>beta</main>"));

    expect(manager.activePageName(browserName)).toBe("beta");

    // Going back to an earlier page is the case that broke: context.pages() is
    // creation-ordered, so "the last page in the context" stays on beta and the
    // step gets filed under the page it left. The step screenshot and the
    // video promotion both read this, so both were wrong together.
    await manager.getPage(browserName, "alpha");

    expect(manager.activePageName(browserName)).toBe("alpha");

    const info = await manager.getActivePageInfo(browserName);
    expect(info?.title).toBe("Alpha");
  }, 180_000);

  it("settles the page the step drove, not the newest tab", async () => {
    await ensureBrowser();

    const alpha = await manager.getPage(browserName, "alpha");
    await alpha.goto(createDataUrl("Alpha", "<main>alpha</main>"));
    const beta = await manager.getPage(browserName, "beta");
    await beta.goto(createDataUrl("Beta", "<main>beta</main>"));
    // The step ends back on alpha; beta stays the newest tab.
    await manager.getPage(browserName, "alpha");

    const settled: string[] = [];
    spyOnSettle(alpha, "alpha", settled);
    spyOnSettle(beta, "beta", settled);

    await manager.settleActivePage(browserName);

    // Settling beta would wait out the tab the step left and leave alpha — the
    // page the screenshot shows and the next step reads — uncommitted.
    expect([...new Set(settled)]).toEqual(["alpha"]);
  }, 180_000);

  it("falls back to the newest tab when the page it last drove is gone", async () => {
    await ensureBrowser();

    const named = await manager.getPage(browserName, "named");
    await named.goto(createDataUrl("Named", "<main>named</main>"));
    // Anonymous tabs are closed at step end, so the page last driven is
    // routinely a closed one by the time anybody asks.
    const anonymous = await manager.newPage(browserName);
    await anonymous.goto(createDataUrl("Anon", "<main>anon</main>"));
    await anonymous.close();

    expect(manager.activePageName(browserName)).toBe("named");
  }, 180_000);

  it("listPages returns objects with id, url, title, and name fields", async () => {
    await ensureBrowser();

    const anonymousPage = await manager.newPage(browserName);
    await anonymousPage.goto(
      createDataUrl("Anonymous Tab", "<h1>anonymous</h1>")
    );

    const pages = await manager.listPages(browserName);
    const anonymousSummary = pages.find(
      (page) => page.name === null && page.title === "Anonymous Tab"
    );

    expect(anonymousSummary).toBeDefined();
    expect(anonymousSummary).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^[a-f0-9]+$/i),
        name: null,
        title: "Anonymous Tab",
        url: expect.stringContaining("data:text/html"),
      })
    );

    for (const page of pages) {
      expect(typeof page.id).toBe("string");
      expect(typeof page.url).toBe("string");
      expect(typeof page.title).toBe("string");
      expect(page.name === null || typeof page.name === "string").toBe(true);
    }
  }, 120_000);

  it("listPages includes pages created via getPage with their name", async () => {
    await ensureBrowser();

    const namedPage = await manager.getPage(browserName, "dashboard");
    await namedPage.goto(createDataUrl("Dashboard", "<main>named page</main>"));

    await expect(manager.listPages(browserName)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]+$/i),
          name: "dashboard",
          title: "Dashboard",
          url: expect.stringContaining("data:text/html"),
        }),
      ])
    );
  }, 120_000);

  it("getPage accepts a targetId for an existing tab", async () => {
    await ensureBrowser();

    const existingPage = await manager.newPage(browserName);
    await existingPage.goto(createDataUrl("Target Tab", "<p>existing tab</p>"));

    const targetSummary = (await manager.listPages(browserName)).find(
      (page) => page.name === null && page.title === "Target Tab"
    );

    expect(targetSummary).toBeDefined();

    const connectedPage = await manager.getPage(browserName, targetSummary!.id);

    expect(connectedPage).toBe(existingPage);
    expect(
      (await manager.listPages(browserName)).filter(
        (page) => page.title === "Target Tab"
      )
    ).toHaveLength(1);
  }, 120_000);

  it("getPage with a name still returns the existing named page", async () => {
    await ensureBrowser();

    const firstPage = await manager.getPage(browserName, "persist");
    await firstPage.goto(createDataUrl("Persist", "<div>same page</div>"));
    await firstPage.evaluate(() => {
      window.name = "persisted-state";
    });

    const secondPage = await manager.getPage(browserName, "persist");

    expect(secondPage).toBe(firstPage);
    await expect(secondPage.evaluate(() => window.name)).resolves.toBe(
      "persisted-state"
    );
    expect(
      (await manager.listPages(browserName)).filter(
        (page) => page.name === "persist"
      )
    ).toHaveLength(1);
  }, 120_000);

  it("reuses the initial blank tab for the first getPage (no orphan tab)", async () => {
    await ensureBrowser();

    const page = await manager.getPage(browserName, "only");
    await page.goto(createDataUrl("Only", "<main>only</main>"));

    // The initial about:blank page is adopted as "only", so the context holds
    // exactly one page — no idle blank tab that a session would record as an
    // empty video.
    const pages = await manager.listPages(browserName);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual(
      expect.objectContaining({ name: "only", title: "Only" })
    );
  }, 120_000);

  it("adopts the blank tab only once; later pages open fresh tabs", async () => {
    await ensureBrowser();

    const first = await manager.newPage(browserName);
    await first.goto(createDataUrl("First", "<p>first</p>"));
    const second = await manager.newPage(browserName);
    await second.goto(createDataUrl("Second", "<p>second</p>"));

    expect(second).not.toBe(first);
    // First adopted the blank tab; second opened a new one. Two pages total,
    // neither an untouched about:blank.
    const titles = (await manager.listPages(browserName))
      .map((entry) => entry.title)
      .sort();
    expect(titles).toEqual(["First", "Second"]);
  }, 120_000);

  it("stopBrowser closes launched browser pages before removing the browser", async () => {
    await ensureBrowser();

    const namedPage = await manager.getPage(browserName, "cleanup");
    const anonymousPage = await manager.newPage(browserName);

    await namedPage.goto(createDataUrl("Cleanup Named", "<div>named</div>"));
    await anonymousPage.goto(
      createDataUrl("Cleanup Anonymous", "<div>anon</div>")
    );

    await manager.stopBrowser(browserName);

    expect(namedPage.isClosed()).toBe(true);
    expect(anonymousPage.isClosed()).toBe(true);
    expect(manager.listBrowsers()).toEqual([]);
  }, 120_000);
});
