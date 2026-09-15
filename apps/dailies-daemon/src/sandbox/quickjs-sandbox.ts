import { readFile } from "node:fs/promises";
import util from "node:util";

import type { Dialog, Page } from "playwright";

import type { BrowserManager } from "../browser-manager.js";
import { CURSOR_GLIDE_MS } from "../session-cursor.js";
import {
  ensureDailiesTempDir,
  readDailiesTempFile,
  readDailiesTempFileBytes,
  writeDailiesTempFile,
} from "../temp-files.js";
import { HostBridge } from "./host-bridge.js";
import { type QuickJSConsoleLevel, QuickJSHost } from "./quickjs-host.js";

const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const WAIT_FOR_OBJECT_ATTEMPTS = 1000;
// The human-interaction helpers move the pointer to the target and wait this
// long before pressing, so the virtual cursor finishes gliding into place and
// then visibly rests on the target for a beat before the click — rather than
// teleporting. The cursor's glide duration plus a 200ms post-arrival pause.
const CURSOR_SETTLE_MS = CURSOR_GLIDE_MS + 200;
// Extra beat added to a glide's own (distance-scaled) duration when that exceeds
// the baseline settle, so a long move still visibly rests on the target before
// the click rather than being pressed the instant it lands.
const SETTLE_BUFFER_MS = 150;

// Upper bound on the animated scroll that reveals an off-screen target. Playwright's
// scrollIntoViewIfNeeded jumps instantly (invisible on camera), so before it we
// smooth-scroll the element into view and wait for that to settle — capped here so
// a page that ignores `behavior:smooth` (CSS scroll-behavior / reduced motion) or
// an unusually long scroll can't stall the step.
const SCROLL_REVEAL_CAP_MS = 1500;

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const TRANSPORT_RECEIVE_GLOBAL = "__transport_receive";

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

      this.#host.executeScriptSync(
        `
          const __performanceOrigin = Date.now();
          const __base64Alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

          const __encodeBase64 = (bytes) => {
            let result = "";
            for (let index = 0; index < bytes.length; index += 3) {
              const chunk =
                (bytes[index] << 16) |
                ((bytes[index + 1] ?? 0) << 8) |
                (bytes[index + 2] ?? 0);
              result += __base64Alphabet[(chunk >> 18) & 63];
              result += __base64Alphabet[(chunk >> 12) & 63];
              result += index + 1 < bytes.length ? __base64Alphabet[(chunk >> 6) & 63] : "=";
              result += index + 2 < bytes.length ? __base64Alphabet[chunk & 63] : "=";
            }
            return result;
          };

          const __decodeBase64 = (base64) => {
            const normalized = String(base64).replace(/\\s+/g, "");
            const output = [];
            for (let index = 0; index < normalized.length; index += 4) {
              const a = __base64Alphabet.indexOf(normalized[index] ?? "A");
              const b = __base64Alphabet.indexOf(normalized[index + 1] ?? "A");
              const c =
                normalized[index + 2] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 2] ?? "A");
              const d =
                normalized[index + 3] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 3] ?? "A");
              const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
              output.push((chunk >> 16) & 255);
              if (c !== 64) {
                output.push((chunk >> 8) & 255);
              }
              if (d !== 64) {
                output.push(chunk & 255);
              }
            }
            return new Uint8Array(output);
          };

          globalThis.URL ??= class URL {
            constructor(value, base) {
              this.href = base === undefined ? String(value) : String(base) + String(value);
            }

            toJSON() {
              return this.href;
            }

            toString() {
              return this.href;
            }
          };

          globalThis.Buffer ??= class Buffer extends Uint8Array {
            constructor(value, byteOffset, length) {
              if (typeof value === "number") {
                super(value);
                return;
              }
              if (value instanceof ArrayBuffer) {
                super(value, byteOffset, length);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                super(value.buffer, value.byteOffset, value.byteLength);
                return;
              }
              super(value);
            }

            static from(value, encodingOrOffset, length) {
              if (typeof value === "string") {
                if (encodingOrOffset !== undefined && encodingOrOffset !== "base64") {
                  throw new Error("QuickJS Buffer only supports base64 string input");
                }
                return new Buffer(__decodeBase64(value));
              }
              if (value instanceof ArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
              }
              if (ArrayBuffer.isView(value)) {
                return new Buffer(
                  value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
                );
              }
              if (Array.isArray(value)) {
                return new Buffer(value);
              }
              throw new TypeError("Unsupported Buffer.from input");
            }

            toString(encoding) {
              if (encoding === undefined || encoding === "utf8") {
                return Array.from(this)
                  .map((value) => String.fromCharCode(value))
                  .join("");
              }
              if (encoding === "base64") {
                return __encodeBase64(this);
              }
              throw new Error("QuickJS Buffer only supports utf8 and base64 output");
            }
          };

          globalThis.performance ??= {
            now: () => Date.now() - __performanceOrigin,
            timeOrigin: __performanceOrigin,
          };
          globalThis.global = globalThis;
        `,
        {
          filename: "quickjs-runtime.js",
        }
      );

      const bundleCode = await getSandboxClientBundleCode();
      const bundleFactorySource = JSON.stringify(
        `${bundleCode}\nreturn __PlaywrightClient;`
      );
      this.#host.executeScriptSync(
        `
          globalThis.__createPlaywrightClient = () => {
            return new Function(${bundleFactorySource})();
          };
        `,
        {
          filename: "sandbox-client.js",
        }
      );

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

      await this.#host.executeScript(
        `
          (() => {
            const hostCall = globalThis.__hostCall;
            const transportSend = globalThis.__transport_send;
            const createPlaywrightClient = globalThis.__createPlaywrightClient;

            if (typeof hostCall !== "function") {
              throw new Error("Sandbox bridge did not expose a host-call function");
            }
            if (typeof transportSend !== "function") {
              throw new Error("Sandbox bridge did not expose a transport sender");
            }
            if (typeof createPlaywrightClient !== "function") {
              throw new Error("Sandbox client bundle did not expose a Playwright client factory");
            }

            if (!delete globalThis.__hostCall) {
              globalThis.__hostCall = undefined;
            }
            if (!delete globalThis.__transport_send) {
              globalThis.__transport_send = undefined;
            }
            if (!delete globalThis.__createPlaywrightClient) {
              globalThis.__createPlaywrightClient = undefined;
            }

            const playwrightClient = createPlaywrightClient();
            const connection = new playwrightClient.Connection(playwrightClient.quickjsPlatform);
            connection.onmessage = (message) => {
              transportSend(JSON.stringify(message));
            };

            Object.defineProperty(globalThis, "${TRANSPORT_RECEIVE_GLOBAL}", {
              value: (json) => {
                connection.dispatch(JSON.parse(json));
              },
              configurable: false,
              enumerable: false,
              writable: false,
            });

            const waitForConnectionObject = async (guid, label) => {
              if (typeof guid !== "string" || guid.length === 0) {
                throw new Error(\`\${label} did not return a valid guid\`);
              }

              for (let attempt = 0; attempt < ${WAIT_FOR_OBJECT_ATTEMPTS}; attempt += 1) {
                const object = connection.getObjectWithKnownName(guid);
                if (object) {
                  return object;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
              }

              throw new Error(\`Timed out waiting for \${label} (\${guid}) in the sandbox\`);
            };

            const encodeHostFilePayload = (value) => {
              if (typeof value === "string") {
                return { encoding: "utf8", data: value };
              }
              if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return { encoding: "base64", data: Buffer.from(value).toString("base64") };
              }
              throw new TypeError(
                "File data must be a string, Buffer, Uint8Array, or ArrayBuffer",
              );
            };

            // Human-interaction helpers attached to every page handed to a
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
                  // glide returns the distance-scaled duration it picked.
                  const ms = window.__dailiesCursor?.glide(
                    r.left + r.width / 2,
                    r.top + r.height / 2,
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
                // Park the cursor just above the field so it doesn't sit on top
                // of the text as it's typed. Visual only (no DOM interaction), so
                // it's safe even when the click is skipped.
                await locator
                  .evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    window.__dailiesCursor?.park(
                      r.left + 8 + Math.random() * 16,
                      r.top - 12 + Math.random() * 14
                    );
                  })
                  .catch(() => undefined);
                if (shouldClear) await locator.fill("");
                // Type with variable per-character timing for a natural human rhythm.
                const chars = Array.from(String(text));
                const fixedDelay = options && 'delay' in options ? options.delay : null;
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
                // QWERTY neighbours for the occasional fat-finger typo.
                const NEIGHBORS = { a:'sq', s:'ad', d:'sf', f:'dg', g:'fh', h:'gj', j:'hk', k:'jl', l:'k', e:'rw', r:'et', t:'ry', i:'ou', o:'ip', u:'yi', n:'mb', m:'n' };
                let didTypo = false;
                for (let i = 0; i < chars.length; i++) {
                  const ch = chars[i];
                  // Rare typo-and-correct: hit a neighbouring key, pause, backspace,
                  // then the right one. Only ADDS key/input events (the count
                  // assertion stays valid) and never changes the final value. Once
                  // per fill, never on the last char, and not in fixed-delay mode.
                  if (
                    fixedDelay === null &&
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
                  let delay;
                  if (fixedDelay !== null) {
                    delay = fixedDelay;
                  } else {
                    // Bursts of fluent typing separated by short thinking pauses.
                    delay = 45 + Math.random() * 35;
                    if (ch === ' ' || /[.!?,;:]/.test(ch)) {
                      delay += 80 + Math.random() * 160;
                      // Small chance of a longer pause at a word break.
                      if (Math.random() < 0.15) delay += 250 + Math.random() * 350;
                    }
                  }
                  if (delay > 0) await page.waitForTimeout(delay);
                }
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
              // Show a caption overlay in the page to label a section of the
              // recording for a human viewer. Non-blocking: it fades in, holds
              // for durationMs, then fades out. Cosmetic only (custom element,
              // pointer-events:none, aria-hidden) so it never affects the page
              // or snapshots. Replaces any caption already showing. The hold
              // gently breathes so the frame never reads as "still" — otherwise
              // the condense pass (which now drops every motionless stretch)
              // would collapse a caption shown over a static page.
              page.showCaption = async (text, options) => {
                const ms =
                  options && typeof options.durationMs === "number"
                    ? options.durationMs
                    : 3000;
                // Record it as data FIRST. The event is what session end
                // renders the caption from, and what keeps the condense pass
                // from trimming this stretch of video away, so it has to
                // survive a page that navigates or closes mid-call.
                await hostCall("recordCaption", JSON.stringify([text, ms]));
                await page
                  .evaluate(
                    (arg) => {
                      // In a cinematic recording the themed captions are burned
                      // in by the session-end pass; painting this overlay too
                      // would double-caption. The call still runs (its text
                      // stays in the recorded script as narration context); we
                      // just skip drawing the on-page overlay.
                      if (window.__dailiesCinematic) {
                        return;
                      }
                      const host = document.documentElement;
                      if (!host) {
                        return;
                      }
                      for (const prev of document.querySelectorAll(
                        "dailies-caption"
                      )) {
                        prev.remove();
                      }
                      const el = document.createElement("dailies-caption");
                      el.setAttribute("aria-hidden", "true");
                      el.textContent = arg.text;
                      // Clamp to two lines so an over-long caption can't grow
                      // into a wall of text over the page: -webkit-line-clamp
                      // truncates with an ellipsis past line two. A narrower
                      // max-width keeps a normal one-liner on one or two lines.
                      el.style.cssText =
                        "position:fixed;left:50%;bottom:36px;" +
                        "transform:translateX(-50%) translateY(8px);" +
                        "width:auto;max-width:90vw;padding:12px 20px;border-radius:10px;" +
                        "background:rgba(17,17,17,0.86);color:#fff;" +
                        "font:500 18px/1.45 system-ui,-apple-system,sans-serif;" +
                        "z-index:2147483646;pointer-events:none;white-space:pre-wrap;" +
                        "text-align:center;box-shadow:0 4px 18px rgba(0,0,0,0.35);opacity:0;" +
                        "display:-webkit-box;-webkit-box-orient:vertical;" +
                        "-webkit-line-clamp:2;overflow:hidden;";
                      host.appendChild(el);
                      const FADE = 250;
                      const hold = Math.max(0, arg.ms - FADE * 2);
                      try {
                        const fadeIn = el.animate(
                          [
                            {
                              opacity: 0,
                              transform: "translateX(-50%) translateY(8px)",
                            },
                            {
                              opacity: 1,
                              transform: "translateX(-50%) translateY(0)",
                            },
                          ],
                          { duration: FADE, easing: "ease-out", fill: "forwards" }
                        );
                        fadeIn.onfinish = () => {
                          // Whole-box opacity breathing — enough changing area
                          // per frame to clear the freeze-detector's threshold.
                          const breathe = el.animate(
                            [{ opacity: 1 }, { opacity: 0.85 }, { opacity: 1 }],
                            { duration: 2000, iterations: Number.POSITIVE_INFINITY }
                          );
                          setTimeout(() => {
                            breathe.cancel();
                            const out = el.animate(
                              [{ opacity: 1 }, { opacity: 0 }],
                              { duration: FADE, easing: "ease-in", fill: "forwards" }
                            );
                            out.onfinish = () => el.remove();
                            setTimeout(() => el.remove(), FADE + 250);
                          }, hold);
                        };
                      } catch {
                        setTimeout(() => el.remove(), arg.ms);
                      }
                    },
                    { ms, text: String(text) }
                  )
                  .catch(() => undefined);
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

            return (async () => {
              await connection.initializePlaywright();

              const browserApi = Object.create(null);
              Object.defineProperties(browserApi, {
                getPage: {
                  value: async (name) => {
                    const guid = await hostCall("getPage", JSON.stringify([name]));
                    return augmentPage(await waitForConnectionObject(guid, \`page "\${name}"\`));
                  },
                  enumerable: true,
                },
                newPage: {
                  value: async () => {
                    const guid = await hostCall("newPage", JSON.stringify([]));
                    return augmentPage(await waitForConnectionObject(guid, "anonymous page"));
                  },
                  enumerable: true,
                },
                listPages: {
                  value: async () => {
                    return await hostCall("listPages", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                closePage: {
                  value: async (name) => {
                    await hostCall("closePage", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(browserApi);

              Object.defineProperty(globalThis, "browser", {
                value: browserApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              Object.defineProperties(globalThis, {
                saveScreenshot: {
                  value: async (buffer, name) => {
                    return await hostCall(
                      "saveScreenshot",
                      JSON.stringify([name, encodeHostFilePayload(buffer)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                writeFile: {
                  value: async (name, data) => {
                    return await hostCall(
                      "writeFile",
                      JSON.stringify([name, encodeHostFilePayload(data)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                readFile: {
                  value: async (name) => {
                    return await hostCall("readFile", JSON.stringify([name]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
              });
            })();
          })()
        `,
        {
          filename: "sandbox-init.js",
        }
      );

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
