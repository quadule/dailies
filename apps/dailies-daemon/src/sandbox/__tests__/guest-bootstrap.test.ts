import { afterEach, describe, expect, it } from "vitest";
import {
  createClientFactorySource,
  SANDBOX_BOOTSTRAP_SOURCE,
  TRANSPORT_RECEIVE_GLOBAL,
} from "../guest/bootstrap.js";
import { QUICKJS_RUNTIME_SOURCE } from "../guest/runtime.js";
import { QuickJSHost } from "../quickjs-host.js";

const hosts = new Set<QuickJSHost>();

afterEach(() => {
  for (const host of hosts) {
    host.dispose();
  }
  hosts.clear();
});

async function createHost(
  options: Parameters<typeof QuickJSHost.create>[0] = {}
): Promise<QuickJSHost> {
  const host = await QuickJSHost.create(options);
  hosts.add(host);
  host.executeScriptSync(QUICKJS_RUNTIME_SOURCE);
  return host;
}

// A small client fixture exercises the real guest bootstrap without a browser,
// host filesystem, or Playwright transport. The browser suites cover real input.
const CLIENT_FIXTURE = `
  var __PlaywrightClient = (() => {
    const page = {
      _guid: "page-1",
      events: [],
      href: "https://example.test/start",
      locator() { return locator; },
      async evaluate() { return page.href; },
      async waitForTimeout(ms) { page.events.push(["wait", ms]); },
      async waitForLoadState() {},
    };
    const locator = {
      async evaluate() { return 0; },
      async evaluateHandle() { return null; },
      async click(options) { page.events.push(["click", options || null]); },
      async fill(value) { page.events.push(["fill", value]); },
      async pressSequentially(value, options) { page.events.push(["type", value, options]); },
      async setInputFiles(files, options) {
        page.events.push(["upload", files.map(file => ({
          name: file.name, mimeType: file.mimeType, bytes: Array.from(file.buffer)
        })), options]);
      },
    };
    return {
      quickjsPlatform: {},
      Connection: class {
        async initializePlaywright() { this.onmessage({ method: "initialize" }); }
        getObjectWithKnownName(guid) { return guid === page._guid ? page : undefined; }
        dispatch(message) { page.received = message; }
      },
    };
  })();
`;

async function bootstrap() {
  const calls: Array<{ args: unknown[]; name: string }> = [];
  const messages: string[] = [];
  const host = await createHost({
    onHostCall: (name, args) => {
      calls.push({ name, args });
      switch (name) {
        case "getPage":
        case "newPage":
          return "page-1";
        case "listPages":
          return [{ id: "page-1", name: "demo" }];
        case "readFile":
          return "stored text";
        case "writeFile":
        case "saveScreenshot":
          return `/controlled/${String(args[0])}`;
        case "readUploadFile":
          return { name: "photo.png", mimeType: "image/png", base64: "AID/" };
        default:
          return;
      }
    },
    onTransportSend: (message) => {
      messages.push(message);
    },
  });
  host.executeScriptSync(createClientFactorySource(CLIENT_FIXTURE));
  await host.executeScript(SANDBOX_BOOTSTRAP_SOURCE);
  return { calls, host, messages };
}

describe("guest runtime and bootstrap source", () => {
  it("preserves binary buffers and view offsets in the runtime shim", async () => {
    const host = await createHost();
    expect(
      host.executeScriptSync(`(() => {
        const bytes = new Uint8Array([9, 0, 128, 255, 8]);
        const view = bytes.subarray(1, 4);
        return {
          encoded: Buffer.from(view).toString("base64"),
          decoded: Array.from(Buffer.from("AID/", "base64")),
          globalAlias: global === globalThis,
          clock: typeof performance.now(),
        };
      })()`)
    ).toEqual({
      encoded: "AID/",
      decoded: [0, 128, 255],
      globalAlias: true,
      clock: "number",
    });
  });

  it("treats client source as data and creates a fresh client on each call", async () => {
    const host = await createHost();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The client bundle must preserve literal template syntax.
    const value = 'quotes " and `template ${syntax}`\nsecond line';
    const bundle = `globalThis.loadCount = (globalThis.loadCount || 0) + 1; var __PlaywrightClient = { value: ${JSON.stringify(value)} };`;
    host.executeScriptSync(createClientFactorySource(bundle));
    expect(host.executeScriptSync("typeof loadCount")).toBe("undefined");
    expect(host.executeScriptSync("__createPlaywrightClient().value")).toBe(
      value
    );
    expect(host.executeScriptSync("__createPlaywrightClient().value")).toBe(
      value
    );
    expect(host.executeScriptSync("loadCount")).toBe(2);
  });

  it("removes private bridge globals and publishes only the controlled browser surface", async () => {
    const { host } = await bootstrap();
    expect(
      host.executeScriptSync(`({
        hooks: [typeof __hostCall, typeof __transport_send, typeof __createPlaywrightClient],
        hostGlobals: [typeof require, typeof process, typeof fetch],
        methods: Object.keys(browser),
        prototype: Object.getPrototypeOf(browser),
        frozen: Object.isFrozen(browser),
        writable: Object.getOwnPropertyDescriptor(globalThis, "browser").writable,
        receiverEnumerable: Object.getOwnPropertyDescriptor(globalThis, "${TRANSPORT_RECEIVE_GLOBAL}").enumerable,
      })`)
    ).toEqual({
      hooks: ["undefined", "undefined", "undefined"],
      hostGlobals: ["undefined", "undefined", "undefined"],
      methods: ["getPage", "newPage", "listPages", "closePage"],
      prototype: null,
      frozen: true,
      writable: false,
      receiverEnumerable: false,
    });
  });

  it("keeps the captured transport callable after removing its global hook", async () => {
    const { host, messages } = await bootstrap();
    expect(messages).toEqual(['{"method":"initialize"}']);
    await host.callFunction(TRANSPORT_RECEIVE_GLOBAL, '{"event":"ready"}');
    expect(
      await host.executeScript(
        '(async () => (await browser.getPage("demo")).received)()'
      )
    ).toEqual({ event: "ready" });
  });

  it("uses the captured file bridge for text and offset binary payloads", async () => {
    const { calls, host } = await bootstrap();
    expect(
      await host.executeScript(`(async () => {
        await writeFile("notes.txt", "naïve 🌅");
        const view = new Uint8Array([9, 0, 128, 255, 8]).subarray(1, 4);
        await saveScreenshot(view, "shot.png");
        return await readFile("notes.txt");
      })()`)
    ).toBe("stored text");
    expect(calls).toEqual([
      {
        name: "writeFile",
        args: ["notes.txt", { encoding: "utf8", data: "naïve 🌅" }],
      },
      {
        name: "saveScreenshot",
        args: ["shot.png", { encoding: "base64", data: "AID/" }],
      },
      { name: "readFile", args: ["notes.txt"] },
    ]);
  });

  it("augments each page once and sends caption and dialog choices through the bridge", async () => {
    const { calls, host } = await bootstrap();
    expect(
      await host.executeScript(`(async () => {
        const page = await browser.getPage("demo");
        const firstFill = page.humanFill;
        const samePage = await browser.newPage();
        await page.showCaption("Watch this");
        await page.acceptDialogs();
        await page.dismissDialogs();
        await page.failOnDialogs();
        return page === samePage && firstFill === samePage.humanFill;
      })()`)
    ).toBe(true);
    expect(calls.slice(2)).toEqual([
      { name: "recordCaption", args: ["Watch this", 3000] },
      { name: "setDialogPolicy", args: ["page-1", "accept"] },
      { name: "setDialogPolicy", args: ["page-1", "dismiss"] },
      { name: "setDialogPolicy", args: ["page-1", "fail"] },
    ]);
  });

  it("keeps human-fill input exact and settles after the final character", async () => {
    const { calls, host } = await bootstrap();
    const events = (await host.executeScript(`(async () => {
      const page = await browser.getPage("demo");
      await page.humanFill("#name", "A🌅", { delay: 1, preTypeMs: 0 });
      return page.events;
    })()`)) as unknown[][];
    expect(events.filter(([type]) => type !== "wait")).toEqual([
      ["click", null],
      ["fill", ""],
      ["type", "A", { delay: 0 }],
      ["type", "🌅", { delay: 0 }],
    ]);
    expect(events[0]?.[0]).toBe("wait");
    expect(calls.at(-1)).toEqual({ name: "settleAfterInteraction", args: [] });
  });

  it("decodes uploads through the same runtime before handing them to the client", async () => {
    const { calls, host } = await bootstrap();
    expect(
      await host.executeScript(`(async () => {
        const page = await browser.getPage("demo");
        await page.setInputFiles("#file", "photo.png", { timeout: 50 });
        return page.events.filter(([kind]) => kind === "upload");
      })()`)
    ).toEqual([
      [
        "upload",
        [{ name: "photo.png", mimeType: "image/png", bytes: [0, 128, 255] }],
        { timeout: 50 },
      ],
    ]);
    expect(calls.slice(1)).toEqual([
      { name: "readUploadFile", args: ["photo.png"] },
      { name: "settleAfterInteraction", args: [] },
    ]);
  });
});
