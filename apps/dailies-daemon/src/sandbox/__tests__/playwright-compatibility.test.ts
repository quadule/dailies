import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserManager } from "../../browser-manager.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

describe("Playwright host compatibility", { concurrent: false }, () => {
  let rootDir = "";
  let manager: BrowserManager;
  let baseUrl = "";
  const server = createServer((request, response) => {
    if (
      request.url === "/auth" &&
      request.headers.authorization !==
        `Basic ${Buffer.from("dailies:fixture").toString("base64")}`
    ) {
      response
        .writeHead(401, { "www-authenticate": 'Basic realm="test"' })
        .end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><title>Authorized</title><button>Ready</button>"
    );
  });

  beforeAll(async () => {
    await ensureSandboxClientBundle();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    rootDir = await mkdtemp(path.join(os.tmpdir(), "dailies-pw-compat-"));
    manager = new BrowserManager(path.join(rootDir, "browsers"), {
      launchPersistentContext: (userDataDir, options) =>
        chromium.launchPersistentContext(userDataDir, {
          ...options,
          httpCredentials: { username: "dailies", password: "fixture" },
        }),
    });
    await manager.ensureBrowser("compat", { headless: true });
  }, 120_000);

  afterAll(async () => {
    await manager?.stopAll();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (rootDir) {
      await removeDirectoryWithRetries(rootDir);
    }
  });

  async function runJson<T>(script: string): Promise<T> {
    const output: string[] = [];
    const errors: string[] = [];
    await runScript(
      script,
      manager,
      "compat",
      {
        onStdout: (data) => output.push(data),
        onStderr: (data) => errors.push(data),
      },
      { timeout: 5000 }
    );
    expect(errors).toEqual([]);
    return JSON.parse(output.join("").trim()) as T;
  }

  it("honors per-call and default timeouts inside the sandbox", async () => {
    const messages = await runJson<string[]>(`
      const page = await browser.getPage("timeouts");
      await page.setContent("<button>Ready</button>");
      const messages = [];
      try { await page.locator("#missing").click({ timeout: 75 }); }
      catch (error) { messages.push(error.message); }
      page.setDefaultTimeout(90);
      try { await page.waitForSelector("#missing"); }
      catch (error) { messages.push(error.message); }
      console.log(JSON.stringify(messages));
    `);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("Timeout 75ms exceeded");
    expect(messages[1]).toContain("Timeout 90ms exceeded");
  });

  it("receives credential lists and preserves the single-object credentials API", async () => {
    const result = await runJson<{ initial: number; updated: number }>(`
      const page = await browser.getPage("auth");
      const initial = (await page.goto(${JSON.stringify(`${baseUrl}/auth`)})).status();
      const credentials = { username: "dailies", password: "fixture" };
      await page.context().setHTTPCredentials(credentials);
      const updated = (await page.goto(${JSON.stringify(`${baseUrl}/auth`)})).status();
      console.log(JSON.stringify({ initial, updated }));
    `);
    expect(result).toEqual({ initial: 200, updated: 200 });
  });

  it("rejects handle bindings before registration and preserves serialized page and context bindings", async () => {
    const result = await runJson<{
      errors: string[];
      page: { count: number; label: string };
      context: { count: number; label: string };
    }>(`
      const page = await browser.getPage("bindings");
      const errors = [];
      for (const [scope, name] of [[page, "pageBinding"], [page.context(), "contextBinding"]]) {
        try {
          await scope.exposeBinding(name, () => "unexpected", { handle: true });
        } catch (error) {
          errors.push(error.message);
        }
        // Reuse the rejected name: the unsupported call must not have registered it.
        await scope.exposeBinding(name, (_source, value) => ({
          count: value.count * 2,
          label: value.label,
        }));
      }
      await page.evaluate(() => {
        window.bindingValues = Promise.all([
          window.pageBinding({ count: 3, label: "page value" }),
          window.contextBinding({ count: 4, label: "context value" }),
        ]).then(([page, context]) => ({ page, context }));
      });
      const values = await page.evaluate(() => window.bindingValues);
      console.log(JSON.stringify({ errors, ...values }));
    `);
    expect(result.errors).toEqual([
      "exposeBinding({ handle: true }) is no longer supported. Pass serializable data to the binding instead of a DOM node or JSHandle.",
      "exposeBinding({ handle: true }) is no longer supported. Pass serializable data to the binding instead of a DOM node or JSHandle.",
    ]);
    expect(result.page).toEqual({ count: 6, label: "page value" });
    expect(result.context).toEqual({ count: 8, label: "context value" });
  });

  it("runs beforeunload handlers when explicitly requested on page close", async () => {
    const result = await runJson<{
      closed: boolean;
      beforeUnload: string | null;
    }>(`
      const page = await browser.getPage("beforeunload");
      await page.goto(${JSON.stringify(baseUrl)});
      await page.evaluate(() => {
        localStorage.removeItem("beforeunload");
        window.addEventListener("beforeunload", () => localStorage.setItem("beforeunload", "ran"));
      });
      await page.click("button");
      const closed = page.waitForEvent("close");
      await page.close({ runBeforeUnload: true });
      await closed;
      const other = await browser.getPage("after-close");
      await other.goto(${JSON.stringify(baseUrl)});
      const beforeUnload = await other.evaluate(() => localStorage.getItem("beforeunload"));
      console.log(JSON.stringify({ closed: page.isClosed(), beforeUnload }));
    `);
    expect(result).toEqual({ closed: true, beforeUnload: "ran" });
  });
});
