import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import util from "node:util";

import type { Dialog, Page } from "playwright";

import type { BrowserManager } from "../browser-manager.js";
import {
  ensureDailiesTempDir,
  readDailiesTempFile,
  readDailiesTempFileBytes,
  writeDailiesTempFile,
} from "../temp-files.js";
import {
  createClientFactorySource,
  SANDBOX_BOOTSTRAP_SOURCE,
  TRANSPORT_RECEIVE_GLOBAL,
} from "./guest/bootstrap.js";
import { QUICKJS_RUNTIME_SOURCE } from "./guest/runtime.js";
import { HostBridge } from "./host-bridge.js";
import { type QuickJSConsoleLevel, QuickJSHost } from "./quickjs-host.js";

const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

// Resolve sandbox-client.js: next to the running script (production), or in dist/ (development)
function findBundlePath(): string {
  const candidates = [
    fileURLToPath(new URL("./sandbox-client.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/sandbox-client.js", import.meta.url)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  throw new Error(
    `Failed to find sandbox-client.js. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}
const BUNDLE_PATH = findBundlePath();

let bundleCodePromise: Promise<string> | undefined;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : util.inspect(arg, {
            colors: false,
            depth: 6,
            compact: 3,
            breakLength: Number.POSITIVE_INFINITY,
          })
    )
    .join(" ");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function getSandboxClientBundleCode(): Promise<string> {
  bundleCodePromise ??= readFile(BUNDLE_PATH, "utf8").catch(
    (error: unknown) => {
      bundleCodePromise = undefined;
      const message =
        error instanceof Error
          ? error.message
          : "Sandbox client bundle could not be read";
      throw new Error(
        `Failed to load sandbox client bundle at ${BUNDLE_PATH}: ${message}`
      );
    }
  );
  return bundleCodePromise;
}

function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }

  return `${timeoutMs}ms`;
}

function createScriptTimeoutError(timeoutMs: number): Error {
  const error = new Error(
    `Script timed out after ${formatTimeoutDuration(timeoutMs)} and was terminated.`
  );
  error.name = "ScriptTimeoutError";
  return error;
}

function createGuestScriptTimeoutErrorSource(timeoutMs: number): string {
  const message = JSON.stringify(createScriptTimeoutError(timeoutMs).message);
  return `(() => {
    const error = new Error(${message});
    error.name = "ScriptTimeoutError";
    return error;
  })()`;
}

function wrapScriptWithWallClockTimeout(
  script: string,
  timeoutMs?: number
): string {
  if (timeoutMs === undefined) {
    return script;
  }

  return `
    (() => {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(${createGuestScriptTimeoutErrorSource(timeoutMs)});
        }, ${timeoutMs});

        Promise.resolve()
          .then(() => (${script}))
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timeoutId);
          });
      });
    })()
  `;
}

// Best-effort MIME type for an upload payload, keyed on the file extension.
// setInputFiles only needs something plausible for the page's accept filter and
// any client-side type check; unknown extensions fall back to a generic binary
// type, which browsers accept.
const UPLOAD_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

function inferUploadMimeType(fileName: string): string {
  const ext = fileName.includes(".")
    ? (fileName.split(".").pop() ?? "").toLowerCase()
    : "";
  return UPLOAD_MIME_TYPES[ext] ?? "application/octet-stream";
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value;
}

function toServerImpl<T>(clientObject: unknown, label: string): T {
  const connection = (
    clientObject as { _connection?: { toImpl?: (value: unknown) => unknown } }
  )._connection;
  const toImpl = connection?.toImpl;
  if (typeof toImpl !== "function") {
    throw new Error(`${label} does not expose a server implementation`);
  }

  const impl = toImpl(clientObject);
  if (!impl) {
    throw new Error(`${label} could not be mapped to a server implementation`);
  }

  return impl as T;
}

function extractGuid(page: Page): string {
  const guid = toServerImpl<{ guid?: unknown }>(page, "Playwright page").guid;
  if (typeof guid !== "string" || guid.length === 0) {
    throw new Error("Playwright page did not expose a guid");
  }

  return guid;
}

function decodeSandboxFilePayload(
  value: unknown,
  label: string
): string | Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  const encoding = "encoding" in value ? value.encoding : undefined;
  const data = "data" in value ? value.data : undefined;
  if (
    (encoding !== "utf8" && encoding !== "base64") ||
    typeof data !== "string"
  ) {
    throw new TypeError(
      `${label} must include a valid encoding and string data`
    );
  }

  if (encoding === "utf8") {
    return data;
  }

  return Buffer.from(data, "base64");
}

interface QuickJSSandboxOptions {
  browserName: string;
  manager: BrowserManager;
  memoryLimitBytes?: number;
  // Called for every page.showCaption(). The caption is recorded as timed data
  // so `session end` can render it in whichever mode was chosen, instead of the
  // recording having to commit to one at capture time.
  onCaption?: (event: { at: string; durationMs: number; text: string }) => void;
  onStderr: (data: string) => void;
  onStdout: (data: string) => void;
  timeoutMs?: number;
}

export class QuickJSSandbox {
  readonly #options: QuickJSSandboxOptions;
  readonly #anonymousPages = new Set<Page>();
  readonly #pendingHostOperations = new Set<Promise<void>>();
  readonly #transportInbox: string[] = [];

  #asyncError?: Error;
  // Dialog handling is daemon-side (the forked client in the sandbox can't
  // reliably receive dialog events in this setup). All three maps below are
  // per-sandbox — and a sandbox is recreated for every step — so a script's
  // dialog choices never leak into a later step and never become invisible
  // boilerplate. #dialogGuards tracks the listeners we added so dispose() can
  // detach them from the (persistent) page. #dialogPolicies holds per-page
  // overrides set via page.acceptDialogs()/dismissDialogs(). #dialogScripted
  // holds pages where the script registered its OWN page.on("dialog"), so the
  // guard steps aside and lets that handler own the dialog.
  readonly #dialogGuards = new Map<Page, (dialog: Dialog) => void>();
  readonly #dialogPolicies = new Map<string, "accept" | "dismiss" | "fail">();
  readonly #dialogScripted = new Set<string>();
  #host?: QuickJSHost;
  #hostBridge?: HostBridge;
  #flushPromise?: Promise<void>;
  #disposed = false;
  #initialized = false;

  constructor(options: QuickJSSandboxOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    this.#assertAlive();
    if (this.#initialized) {
      return;
    }

    try {
      await ensureDailiesTempDir();

      this.#host = await QuickJSHost.create({
        memoryLimitBytes:
          this.#options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
        cpuTimeoutMs: this.#options.timeoutMs,
        hostFunctions: {
          getPage: (name) => this.#getPage(name),
          newPage: () => this.#newPage(),
          listPages: () =>
            this.#options.manager.listPages(this.#options.browserName),
          closePage: (name) => this.#closePage(name),
          settleAfterInteraction: () =>
            this.#options.manager.settleActivePage(this.#options.browserName, {
              fast: true,
            }),
          saveScreenshot: (name, data) => this.#writeTempFile(name, data),
          writeFile: (name, data) => this.#writeTempFile(name, data),
          readFile: (name) => this.#readTempFile(name),
          readUploadFile: (name) => this.#readUploadFile(name),
          setDialogPolicy: (guid, action) =>
            this.#setDialogPolicy(guid, action),
          // Records a page.showCaption() as timed data. Stamped here, on the
          // host, so the timestamp shares a clock with the session record and
          // the video — the sandbox has no reliable wall clock of its own.
          recordCaption: (text, durationMs) => {
            // Args arrive from the sandbox as `unknown` — a script can call
            // showCaption with anything, so coerce rather than trust.
            const ms = Number(durationMs);
            this.#options.onCaption?.({
              at: new Date().toISOString(),
              durationMs: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
              text: String(text),
            });
            return Promise.resolve();
          },
        },
        onConsole: (level, args) => {
          this.#routeConsole(level, args);
        },
        onDrain: () => this.#drainAsyncOps(),
        onTransportSend: (message) => {
          this.#handleTransportSend(message);
        },
      });

      this.#host.executeScriptSync(QUICKJS_RUNTIME_SOURCE, {
        filename: "quickjs-runtime.js",
      });

      const bundleCode = await getSandboxClientBundleCode();
      this.#host.executeScriptSync(createClientFactorySource(bundleCode), {
        filename: "sandbox-client.js",
      });

      const browserEntry = this.#options.manager.getBrowser(
        this.#options.browserName
      );
      if (!browserEntry) {
        throw new Error(
          `Browser "${this.#options.browserName}" not found. It should have been created before script execution.`
        );
      }
      this.#hostBridge = new HostBridge({
        sendToSandbox: (json) => {
          this.#transportInbox.push(json);
        },
        preLaunchedBrowser: toServerImpl(
          browserEntry.browser,
          "Playwright browser"
        ),
        sharedBrowser: true,
        denyLaunch: true,
      });

      await this.#host.executeScript(SANDBOX_BOOTSTRAP_SOURCE, {
        filename: "sandbox-init.js",
      });

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
      this.#initialized = true;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async executeScript(script: string): Promise<void> {
    this.#assertInitialized();
    let executionError: unknown;

    try {
      this.#throwIfAsyncError();

      await this.#host?.executeScript(
        wrapScriptWithWallClockTimeout(script, this.#options.timeoutMs),
        {
          filename: "user-script.js",
        }
      );

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
    } catch (error) {
      executionError = error;
    }

    try {
      await this.#cleanupAnonymousPages();
    } catch (error) {
      executionError ??= error;
    }

    if (executionError) {
      throw executionError;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    // Detach the dialog guards we added — the pages outlive this sandbox, so a
    // leftover listener would write into a disposed sandbox on a later step.
    for (const [page, handler] of this.#dialogGuards) {
      try {
        page.off("dialog", handler);
      } catch {
        // Page may already be closed; nothing to detach.
      }
    }
    this.#dialogGuards.clear();
    this.#dialogPolicies.clear();
    this.#dialogScripted.clear();

    await this.#cleanupAnonymousPages({
      suppressErrors: true,
    });

    this.#transportInbox.length = 0;
    this.#pendingHostOperations.clear();

    try {
      await this.#hostBridge?.dispose();
    } catch {
      // Best effort cleanup during sandbox teardown.
    } finally {
      this.#hostBridge = undefined;
      this.#host?.dispose();
      this.#host = undefined;
      this.#flushPromise = undefined;
    }
  }

  #routeConsole(level: QuickJSConsoleLevel, args: unknown[]): void {
    const line = `${formatArgs(args)}\n`;
    if (level === "warn" || level === "error") {
      this.#options.onStderr(line);
      return;
    }

    this.#options.onStdout(line);
  }

  #handleTransportSend(message: string): void {
    if (!this.#hostBridge) {
      this.#asyncError ??= new Error("Sandbox transport is not initialized");
      return;
    }

    this.#trackDialogSubscription(message);

    const operation = this.#hostBridge
      .receiveFromSandbox(message)
      .catch((error: unknown) => {
        this.#asyncError ??= normalizeError(error);
      })
      .finally(() => {
        this.#pendingHostOperations.delete(operation);
      });

    this.#pendingHostOperations.add(operation);
  }

  // The forked client sends an updateSubscription message when a script adds or
  // removes a page.on("dialog") listener. Watching it here lets the daemon-side
  // guard defer to a script that wants to own its dialogs, without the daemon and
  // the script racing to answer the same dialog. The message guid is the page
  // guid — the same one #getPage handed the sandbox.
  #trackDialogSubscription(message: string): void {
    let parsed: { guid?: unknown; method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(message) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.method !== "updateSubscription") {
      return;
    }
    const params = parsed.params as { event?: unknown; enabled?: unknown };
    if (params?.event !== "dialog" || typeof parsed.guid !== "string") {
      return;
    }
    if (params.enabled) {
      this.#dialogScripted.add(parsed.guid);
    } else {
      this.#dialogScripted.delete(parsed.guid);
    }
  }

  async #drainAsyncOps(): Promise<void> {
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();

    if (this.#pendingHostOperations.size === 0) {
      return;
    }

    await Promise.race(this.#pendingHostOperations);
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  async #flushTransportQueue(): Promise<void> {
    this.#throwIfAsyncError();
    if (!this.#host || this.#transportInbox.length === 0) {
      return;
    }

    if (this.#flushPromise) {
      await this.#flushPromise;
      return;
    }

    const flush = async () => {
      while (this.#transportInbox.length > 0) {
        const message = this.#transportInbox.shift();
        if (message === undefined) {
          continue;
        }

        await this.#host?.callFunction(TRANSPORT_RECEIVE_GLOBAL, message);
        this.#throwIfAsyncError();
      }
    };

    this.#flushPromise = flush().finally(() => {
      this.#flushPromise = undefined;
    });
    await this.#flushPromise;
  }

  async #getPage(name: unknown): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const guid = extractGuid(page);
    this.#guardDialogs(page, guid);
    return guid;
  }

  async #newPage(): Promise<string> {
    const page = await this.#options.manager.newPage(this.#options.browserName);
    this.#anonymousPages.add(page);
    page.on("close", () => {
      this.#anonymousPages.delete(page);
    });
    const guid = extractGuid(page);
    this.#guardDialogs(page, guid);
    return guid;
  }

  // Attach our dialog guard to a page exactly once per sandbox. The page object
  // persists across steps, but each step is a fresh sandbox, so #dialogGuards is
  // empty here at the start of every step and we re-attach (and re-detach on
  // dispose) — closures never outlive their sandbox.
  #guardDialogs(page: Page, guid: string): void {
    if (this.#dialogGuards.has(page)) {
      return;
    }
    const handler = (dialog: Dialog): void => {
      void this.#handleDialog(guid, dialog);
    };
    this.#dialogGuards.set(page, handler);
    page.on("dialog", handler);
  }

  // A browser dialog (alert/confirm/prompt) freezes the page's JS thread until
  // it's answered, and Playwright would answer it silently — so a confirm()
  // guarding the action a step just triggered gets cancelled, the flow stalls,
  // and nothing in the run explains why. We answer every dialog deliberately and,
  // by default, make an unanswered one fail the step loudly instead of passing.
  async #handleDialog(guid: string, dialog: Dialog): Promise<void> {
    const kind = dialog.type();
    // beforeunload is the browser's "leave this page?" guard, not a test signal —
    // accept it so navigations aren't blocked, and stay quiet.
    if (kind === "beforeunload") {
      await dialog.accept().catch(() => undefined);
      return;
    }
    const policy = this.#dialogPolicies.get(guid) ?? "fail";
    if (policy === "accept") {
      await dialog.accept().catch(() => undefined);
      return;
    }
    // Dismiss in every other case so the page is never left frozen for the next
    // step. "dismiss" is a deliberate, quiet cancel; "fail" is the default.
    await dialog.dismiss().catch(() => undefined);
    if (policy === "dismiss") {
      return;
    }
    const detail = dialog.message() ? ` "${dialog.message()}"` : "";
    // A script that reached for the standard page.on("dialog", ...) gets a
    // pointed message: Dailies answers dialogs itself (the daemon owns the only
    // delivery that works in the sandbox), so that listener never fires — the
    // supported override is page.acceptDialogs()/dismissDialogs().
    const message = this.#dialogScripted.has(guid)
      ? `Unhandled ${kind} dialog${detail}. Dailies answers browser dialogs itself, ` +
        `so a page.on("dialog", ...) handler in a script never fires. Use ` +
        "page.acceptDialogs() (click OK) or page.dismissDialogs() (cancel) before " +
        "the action that opens the dialog. Dailies dismissed this one and failed " +
        "the step."
      : `Unhandled ${kind} dialog${detail}. A browser dialog blocks the page until ` +
        `it's answered; Dailies dismissed it (which cancels the action that opened ` +
        `it) and failed this step so it can't pass silently. If this flow expects ` +
        "the dialog, say so before the action that triggers it: page.acceptDialogs() " +
        "to click OK, or page.dismissDialogs() to cancel quietly.";
    this.#options.onStderr(`[dailies] ${message}\n`);
    this.#asyncError ??= new Error(message);
  }

  #setDialogPolicy(guid: unknown, action: unknown): void {
    const pageGuid = requireString(guid, "Page id");
    const policy = requireString(action, "Dialog action");
    if (policy !== "accept" && policy !== "dismiss" && policy !== "fail") {
      throw new Error(`Unknown dialog action "${policy}"`);
    }
    this.#dialogPolicies.set(pageGuid, policy);
  }

  async #closePage(name: unknown): Promise<void> {
    await this.#options.manager.closePage(
      this.#options.browserName,
      requireString(name, "Page name")
    );
  }

  async #writeTempFile(name: unknown, payload: unknown): Promise<string> {
    return await writeDailiesTempFile(
      requireString(name, "File name"),
      decodeSandboxFilePayload(payload, "File data")
    );
  }

  async #readTempFile(name: unknown): Promise<string> {
    return await readDailiesTempFile(requireString(name, "File name"));
  }

  // Read a file from the sandbox temp directory as an upload payload for
  // setInputFiles: the bytes (base64), the basename the page will see, and a
  // best-effort MIME type from the extension. resolveDailiesTempPath inside
  // readDailiesTempFileBytes confines the read to that directory — a script can
  // only upload files it (or the user, via takeover) first wrote there — so the
  // page never gains access to arbitrary host paths.
  async #readUploadFile(
    name: unknown
  ): Promise<{ name: string; mimeType: string; base64: string }> {
    const fileName = requireString(name, "File name");
    const bytes = await readDailiesTempFileBytes(fileName);
    const base = fileName.split(/[\\/]/).pop() || fileName;
    return {
      name: base,
      mimeType: inferUploadMimeType(base),
      base64: bytes.toString("base64"),
    };
  }

  async #cleanupAnonymousPages(
    options: { suppressErrors?: boolean } = {}
  ): Promise<void> {
    const anonymousPages = [...this.#anonymousPages];
    this.#anonymousPages.clear();

    for (const page of anonymousPages) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (error) {
        if (!options.suppressErrors) {
          throw error;
        }
      }
    }

    if (options.suppressErrors) {
      try {
        await this.#flushTransportQueue();
      } catch {
        // Best effort cleanup during sandbox teardown.
      }
      return;
    }

    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  #throwIfAsyncError(): void {
    if (this.#asyncError) {
      throw this.#asyncError;
    }
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error("QuickJS sandbox has been disposed");
    }
  }

  #assertInitialized(): void {
    this.#assertAlive();
    if (!(this.#initialized && this.#host && this.#hostBridge)) {
      throw new Error("QuickJS sandbox has not been initialized");
    }
  }
}
