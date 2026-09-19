import { readFile } from "node:fs/promises";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { QuickJSHost } from "../quickjs-host.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const bundleUrl = new URL("../../../dist/sandbox-client.js", import.meta.url);

const hosts = new Set<QuickJSHost>();

let bundleCode = "";

async function createHost(): Promise<QuickJSHost> {
  const host = await QuickJSHost.create();
  hosts.add(host);
  return host;
}

afterEach(() => {
  for (const host of hosts) {
    host.dispose();
  }
  hosts.clear();
});

beforeAll(async () => {
  await ensureSandboxClientBundle();
  bundleCode = await readFile(bundleUrl, "utf8");
}, 120_000);

describe("forked Playwright bundle", () => {
  it("adapts operation timeouts and wait notifications to the current host protocol", async () => {
    const host = await createHost();
    host.executeScriptSync(bundleCode);

    const result = host.executeScriptSync(`
      const connection = new __PlaywrightClient.Connection();
      const messages = [];
      connection.onmessage = message => messages.push(message);
      const frame = { _guid: "frame", _type: "Frame" };
      connection.sendMessageToServer(frame, "click", { selector: "#target", timeout: 75 }, {});
      connection.sendMessageToServer(frame, "click", { selector: "#target", timeout: 0 }, {});
      connection.sendMessageToServer(frame, "title", undefined, {});
      const page = { _guid: "page", _type: "Page" };
      for (const phase of ["before", "log", "after"])
        connection.sendMessageToServer(page, "waitForEventInfo", { info: { waitId: "wait", phase } }, {});
      JSON.stringify({ messages, pendingCalls: connection._callbacks.size });
    `);

    expect(JSON.parse(String(result))).toEqual({
      messages: [
        {
          id: 1,
          guid: "frame",
          method: "click",
          params: { selector: "#target" },
          metadata: { timeout: 75 },
        },
        {
          id: 2,
          guid: "frame",
          method: "click",
          params: { selector: "#target" },
          metadata: { timeout: 0 },
        },
        { id: 3, guid: "frame", method: "title", params: {}, metadata: {} },
        ...["before", "log", "after"].map((phase, index) => ({
          id: index + 4,
          guid: "page",
          method: "__waitInfo__",
          params: { waitId: "wait", phase },
          metadata: {},
        })),
      ],
      pendingCalls: 3,
    });
  });

  it("loads into QuickJS and exposes the client entry points", async () => {
    const host = await createHost();

    expect(() =>
      host.executeScriptSync(bundleCode, {
        filename: "sandbox-client.js",
      })
    ).not.toThrow();

    expect(host.executeScriptSync("typeof __PlaywrightClient.Connection")).toBe(
      "function"
    );
    expect(
      host.executeScriptSync("typeof __PlaywrightClient.quickjsPlatform")
    ).toBe("object");

    expect(() =>
      host.executeScriptSync(`
        globalThis.__sandboxConnection = new __PlaywrightClient.Connection();
      `)
    ).not.toThrow();

    expect(host.executeScriptSync("typeof __sandboxConnection.dispatch")).toBe(
      "function"
    );
  }, 120_000);
});
