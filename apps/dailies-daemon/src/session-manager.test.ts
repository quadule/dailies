import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "dailies-logger";
import type { SessionStartRequest } from "dailies-protocol";
import type { ConsoleMessage } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserEntry,
  BrowserManager,
  SessionLaunchOptions,
} from "./browser-manager.js";
import { getSessionDir } from "./local-endpoint.js";
import { SessionManager, sessionBrowserName } from "./session-manager.js";

type Listener = (arg: unknown) => void;
interface RecorderSink {
  actionAdded?: (page: unknown, action: unknown, code: string) => void;
  actionUpdated?: (page: unknown, action: unknown, code: string) => void;
}

const log = createLogger({ level: "silent" });

// Which page the fake BrowserManager reports as active, so a test can move the
// session from one page to another between steps.
let activePage: string | undefined;

function makeSession(): {
  entry: BrowserEntry;
  calls: string[];
  emit: (event: string, arg: unknown) => void;
  recorderSink: { current?: RecorderSink };
} {
  const calls: string[] = [];
  const listeners = new Map<string, Listener[]>();
  const tracing = {
    group: () => {
      calls.push("tracing.group");
      return Promise.resolve();
    },
    groupEnd: () => {
      calls.push("tracing.groupEnd");
      return Promise.resolve();
    },
    start: () => {
      calls.push("tracing.start");
      return Promise.resolve();
    },
    stop: () => {
      calls.push("tracing.stop");
      return Promise.resolve();
    },
  };
  // Captures the recorder event sink so a takeover test can drive actions.
  const recorderSink: { current?: RecorderSink } = {};
  const context = {
    _disableRecorder: () => {
      calls.push("disableRecorder");
      recorderSink.current = undefined;
      return Promise.resolve();
    },
    _enableRecorder: (_params: unknown, sink: RecorderSink) => {
      calls.push("enableRecorder");
      recorderSink.current = sink;
      return Promise.resolve();
    },
    close: () => {
      calls.push("context.close");
      return Promise.resolve();
    },
    off(event: string, fn: Listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== fn)
      );
    },
    on(event: string, fn: Listener) {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
    },
    pages: () => [],
    tracing,
  };
  const browser = { isConnected: () => true };
  const entry = {
    browser,
    context,
    name: sessionBrowserName("s1"),
    pages: new Map(),
  } as unknown as BrowserEntry;
  // Closing a context closes every page in it, and BrowserManager's own
  // page.on("close") handler unregisters each one — so a real entry.pages is
  // EMPTY after this point. A fake that skips that lets code pass here which
  // cannot work against a browser: it is how video page labelling shipped
  // broken while this file was green.
  context.close = () => {
    calls.push("context.close");
    entry.pages.clear();
    return Promise.resolve();
  };
  const emit = (event: string, arg: unknown) => {
    for (const fn of listeners.get(event) ?? []) {
      fn(arg);
    }
  };
  return { calls, emit, entry, recorderSink };
}

function makeManager(
  entry: BrowserEntry,
  calls: string[],
  launched: Array<{ name: string; options: SessionLaunchOptions }>,
  initScripts: string[] = []
): BrowserManager {
  return {
    applyInitScripts: (_name: string, scripts: readonly string[]) => {
      calls.push("applyInitScripts");
      initScripts.push(...scripts);
      return Promise.resolve();
    },
    launchSessionBrowser: (name: string, options: SessionLaunchOptions) => {
      launched.push({ name, options });
      return Promise.resolve(entry);
    },
    activePageName: () => activePage,
    onBrowserDisconnect: () => undefined,
    screenshotActivePage: () => Promise.resolve(),
    stopBrowser: () => {
      calls.push("stopBrowser");
      return Promise.resolve();
    },
  } as unknown as BrowserManager;
}

function startReq(
  over: Partial<SessionStartRequest> = {}
): SessionStartRequest {
  return {
    capture: { console: true, har: true, trace: true, video: true },
    id: "r1",
    sessionId: "s1",
    type: "session-start",
    ...over,
  } as SessionStartRequest;
}

let tempHome: string;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "dailies-session-"));
  process.env.HOME = tempHome;
  activePage = undefined;
  process.env.USERPROFILE = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("SessionManager", () => {
  it("launches a capture context and starts tracing", async () => {
    const { entry, calls } = makeSession();
    const launched: Array<{ name: string; options: SessionLaunchOptions }> = [];
    const sessions = new SessionManager(
      makeManager(entry, calls, launched),
      log
    );

    const summary = await sessions.start(startReq());

    expect(summary.sessionId).toBe("s1");
    expect(summary.phase).toBe("active");
    expect(launched).toHaveLength(1);
    expect(launched[0]?.name).toBe("__session__s1");
    expect(launched[0]?.options.record.videoDir).toBeDefined();
    expect(launched[0]?.options.record.har?.path).toContain("network.har");
    expect(launched[0]?.options.profileDirOverride).toContain("profile");
    expect(calls).toContain("tracing.start");
  });

  it("defaults the recording viewport clear of the 1280px breakpoint", async () => {
    const { entry, calls } = makeSession();
    const launched: Array<{ name: string; options: SessionLaunchOptions }> = [];
    const sessions = new SessionManager(
      makeManager(entry, calls, launched),
      log
    );

    await sessions.start(startReq());

    // 1280 is where large breakpoints collapse (`max-width: 1280px` matches at
    // 1280), which once cost a recording its subject.
    expect(launched[0]?.options.viewport).toEqual({
      width: 1440,
      height: 900,
    });
  });

  it("applies the virtual-cursor init script by default", async () => {
    const { entry, calls } = makeSession();
    const initScripts: string[] = [];
    const sessions = new SessionManager(
      makeManager(entry, calls, [], initScripts),
      log
    );

    await sessions.start(startReq());

    expect(initScripts).toHaveLength(1);
    expect(initScripts[0]).toContain("dailies-virtual-cursor");
  });

  it("skips the virtual cursor when the request disables it", async () => {
    const { entry, calls } = makeSession();
    const initScripts: string[] = [];
    const sessions = new SessionManager(
      makeManager(entry, calls, [], initScripts),
      log
    );

    await sessions.start(startReq({ cursor: false }));

    expect(initScripts).toHaveLength(0);
  });

  it("honors an explicit viewport from the request", async () => {
    const { entry, calls } = makeSession();
    const launched: Array<{ name: string; options: SessionLaunchOptions }> = [];
    const sessions = new SessionManager(
      makeManager(entry, calls, launched),
      log
    );

    await sessions.start(startReq({ viewport: { width: 1440, height: 900 } }));

    expect(launched[0]?.options.viewport).toEqual({
      width: 1440,
      height: 900,
    });
  });

  it("rejects a duplicate session id", async () => {
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());
    await expect(sessions.start(startReq())).rejects.toThrow(/already exists/);
  });

  it("reconciles a session whose browser disconnects unexpectedly", async () => {
    const { entry, calls } = makeSession();
    let onDisconnect: ((name: string) => void) | undefined;
    const manager = {
      applyInitScripts: () => Promise.resolve(),
      launchSessionBrowser: () => Promise.resolve(entry),
      onBrowserDisconnect: (fn: (name: string) => void) => {
        onDisconnect = fn;
      },
      screenshotActivePage: () => Promise.resolve(),
      stopBrowser: () => {
        calls.push("stopBrowser");
        return Promise.resolve();
      },
    } as unknown as BrowserManager;
    const sessions = new SessionManager(manager, log);
    await sessions.start(startReq());
    expect(sessions.has("s1")).toBe(true);

    // The session's browser crashes out from under the daemon.
    onDisconnect?.(sessionBrowserName("s1"));

    // has()/status must stop reporting it as live so a later execute is
    // rejected instead of fabricating a fake non-session browser.
    expect(sessions.has("s1")).toBe(false);
    expect(sessions.status("s1")).toBeUndefined();
  });

  it("stops tracing before closing the context and writes a manifest", async () => {
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    const result = await sessions.end("s1", "end");

    const stopIdx = calls.indexOf("tracing.stop");
    const closeIdx = calls.indexOf("context.close");
    const dropIdx = calls.indexOf("stopBrowser");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeLessThan(closeIdx);
    expect(closeIdx).toBeLessThan(dropIdx);

    expect(result.session.phase).toBe("ended");
    expect(result.manifestPath).toBe(
      join(getSessionDir("s1"), "manifest.json")
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.session.sessionId).toBe("s1");
    expect(manifest.reason).toBe("end");
  });

  it("does not hang forever if the browser context never closes", async () => {
    // Regression test: ctx.close() talks to the browser over CDP, which can
    // hang indefinitely if that transport is wedged (observed in practice —
    // a single-session `end`/`abort` hung for over an hour with no automatic
    // recovery). end() must bound the close and still finish.
    vi.useFakeTimers();
    try {
      const { entry, calls } = makeSession();
      entry.context.close = () => new Promise(() => {}); // never resolves
      const sessions = new SessionManager(makeManager(entry, calls, []), log);
      await sessions.start(startReq());

      const resultPromise = sessions.end("s1", "end");
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result.session.phase).toBe("ended");
      expect(calls).toContain("stopBrowser");
      expect(sessions.has("s1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hang forever if stopping the session browser never resolves", async () => {
    // The same wedged-CDP failure one step later: stopBrowser awaits
    // browser.close() over that transport, and it runs in end()'s finally —
    // so an unbounded wait strands `session end` after every artifact is
    // already safely on disk.
    vi.useFakeTimers();
    try {
      const { entry, calls } = makeSession();
      const manager = makeManager(entry, calls, []);
      manager.stopBrowser = () => new Promise<void>(() => undefined);
      const sessions = new SessionManager(manager, log);
      await sessions.start(startReq());

      let pending = true;
      const resultPromise = sessions.end("s1", "end").finally(() => {
        pending = false;
      });
      // collect() does real file I/O before the stop, so the stop's timeout
      // timer only exists a few event-loop turns in — keep advancing until
      // end() returns rather than guessing at the turn count.
      let turns = 0;
      while (pending) {
        // Several bounded stages run back to back (each up to 5 s of fake
        // time), so allow well past their sum — but stay finite, so a
        // regression fails here instead of hanging the suite.
        if (turns++ > 120) {
          expect.fail("end() never returned — the browser-stop bound is gone");
        }
        await vi.advanceTimersByTimeAsync(1000);
      }
      const result = await resultPromise;

      expect(result.session.phase).toBe("ended");
      expect(sessions.has("s1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins an end already in flight instead of tearing down twice", async () => {
    // Daemon shutdown calls endAll() without the per-session browser lock the
    // session-end RPC holds, so a `stop` can re-enter end() mid-teardown. Two
    // collect() passes then race on manifest.json and the last writer wins.
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    const [first, second] = await Promise.all([
      sessions.end("s1", "end"),
      sessions.end("s1", "abort"),
    ]);

    expect(second).toBe(first);
    expect(calls.filter((call) => call === "context.close")).toHaveLength(1);
    expect(calls.filter((call) => call === "stopBrowser")).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(join(getSessionDir("s1"), "manifest.json"), "utf8")
    );
    // The reason the first (real) teardown ran with, not the joiner's.
    expect(manifest.reason).toBe("end");
    expect(sessions.has("s1")).toBe(false);
  });

  it("serializes captions.json writes", async () => {
    // recordCaption is fired and forgotten by the daemon, so two captions in a
    // row would otherwise have two whole-file O_TRUNC writes in flight at once.
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    await Promise.all(
      ["one", "two", "three"].map((text) =>
        sessions.recordCaption("s1", { at: "0:01", durationMs: 1000, text })
      )
    );

    const captions = JSON.parse(
      await readFile(join(getSessionDir("s1"), "captions.json"), "utf8")
    );
    expect(captions).toHaveLength(3);
    expect(captions.map((c: { text: string }) => c.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("captures console events as newline-delimited JSON", async () => {
    const { entry, calls, emit } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    const msg = {
      location: () => ({ columnNumber: 2, lineNumber: 1, url: "http://x" }),
      page: () => null,
      text: () => "boom",
      type: () => "error",
    } as unknown as ConsoleMessage;
    emit("console", msg);

    await sessions.end("s1", "end");

    const consoleLog = await readFile(
      join(getSessionDir("s1"), "console.log"),
      "utf8"
    );
    const first = JSON.parse(consoleLog.trim().split("\n")[0] ?? "{}");
    expect(first.kind).toBe("console");
    expect(first.type).toBe("error");
    expect(first.text).toBe("boom");
  });

  it("endAll aborts active sessions and drops them from the registry", async () => {
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    await sessions.endAll();
    // The session is finalized and removed (frees memory + closes the execute
    // guard hole), so it no longer appears in the registry.
    expect(sessions.has("s1")).toBe(false);
    expect(sessions.status("s1")).toBeUndefined();
    expect(calls).toContain("context.close");

    // A second end on a now-unknown session throws (the orchestrator reconciles
    // the on-disk record in that case).
    await expect(sessions.end("s1", "end")).rejects.toThrow(/not found/);
  });

  it("records which page each step ended on, and carries it into the manifest", async () => {
    // A session records one video per page and `session end` finishes one of them.
    // The step history is how it knows which page the run was actually about — the
    // page a run FINISHES on, not the one it spent longest being stuck on.
    const { entry, calls } = makeSession();
    entry.pages.set("flailing", {} as never);
    entry.pages.set("retake", {} as never);
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    activePage = "flailing";
    await sessions.beginStep("s1", "get-stuck");
    await sessions.endStep("s1", "get-stuck");
    activePage = "retake";
    await sessions.beginStep("s1", "start-over");
    await sessions.endStep("s1", "start-over");

    const result = await sessions.end("s1", "end");

    expect(result.stepPages).toEqual([
      { page: "flailing", step: "get-stuck" },
      { page: "retake", step: "start-over" },
    ]);
    const manifest = JSON.parse(
      await readFile(join(getSessionDir("s1"), "manifest.json"), "utf8")
    );
    expect(manifest.stepPages).toEqual(result.stepPages);
  });

  it("attributes a step even when the caller does not repeat its name", async () => {
    // The takeover path ends the step without naming it again.
    const { entry, calls } = makeSession();
    entry.pages.set("checkout", {} as never);
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    activePage = "checkout";
    await sessions.beginStep("s1", "let-the-human-drive");
    await sessions.endStep("s1");

    const result = await sessions.end("s1", "end");
    expect(result.stepPages).toEqual([
      { page: "checkout", step: "let-the-human-drive" },
    ]);
  });

  it("labels each recording with the page name its script used", async () => {
    // One video per page, and `session end` finishes exactly one of them. Playwright
    // names the files after an internal id, so without this the manifest offers no
    // way to say WHICH page mattered — see `session end --video`.
    const { entry, calls } = makeSession();
    const videoDir = join(getSessionDir("s1"), "video");
    await mkdir(videoDir, { recursive: true });
    const flowVideo = join(videoDir, "page@aaa.webm");
    const flagsVideo = join(videoDir, "page@bbb.webm");
    await writeFile(flowVideo, "v");
    await writeFile(flagsVideo, "v");
    entry.pages.set("checkout", {
      video: () => ({ path: () => Promise.resolve(flowVideo) }),
    } as never);
    entry.pages.set("flags", {
      video: () => ({ path: () => Promise.resolve(flagsVideo) }),
    } as never);
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    const result = await sessions.end("s1", "end");
    const videos = result.artifacts.filter((a) => a.kind === "video");

    expect(videos.map((v) => [v.path.split("/").at(-1), v.pageName])).toEqual(
      expect.arrayContaining([
        ["page@aaa.webm", "checkout"],
        ["page@bbb.webm", "flags"],
      ])
    );
  });

  it("leaves a recording unlabelled rather than failing when its page has no video", async () => {
    const { entry, calls } = makeSession();
    const videoDir = join(getSessionDir("s1"), "video");
    await mkdir(videoDir, { recursive: true });
    await writeFile(join(videoDir, "page@ccc.webm"), "v");
    entry.pages.set("gone", {
      video: () => ({ path: () => Promise.reject(new Error("closed")) }),
    } as never);
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    const result = await sessions.end("s1", "end");
    const video = result.artifacts.find((a) => a.kind === "video");

    expect(video?.path.endsWith("page@ccc.webm")).toBe(true);
    expect(video?.pageName).toBeUndefined();
  });

  it("does not record artifacts that capture disabled", async () => {
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(
      startReq({
        capture: { console: false, har: false, trace: false, video: false },
      })
    );
    expect(calls).not.toContain("tracing.start");

    const result = await sessions.end("s1", "end");
    expect(calls).not.toContain("tracing.stop");
    expect(result.artifacts).toHaveLength(0);
  });

  it("captures a takeover's actions as generated code", async () => {
    const { entry, calls, recorderSink } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());

    await sessions.takeoverStart("s1", {
      language: "javascript",
      step: "manual-takeover",
    });
    expect(calls).toContain("enableRecorder");
    expect(sessions.isRecording("s1")).toBe(true);

    // Drive recorder events: an action, then an update that revises the last
    // one (e.g. accumulating keystrokes), then a second distinct action.
    recorderSink.current?.actionAdded?.(null, null, "await page.click('#a');");
    recorderSink.current?.actionUpdated?.(
      null,
      null,
      "await page.fill('#a', 'hi');"
    );
    recorderSink.current?.actionAdded?.(null, null, "await page.click('#go');");

    const out = await sessions.takeoverStop("s1");
    expect(calls).toContain("disableRecorder");
    expect(sessions.isRecording("s1")).toBe(false);
    expect(out.step).toBe("manual-takeover");
    expect(out.actionCount).toBe(2);
    expect(out.code).toBe(
      "await page.fill('#a', 'hi');\nawait page.click('#go');"
    );
  });

  it("rejects a second takeover and a headless takeover", async () => {
    const { entry, calls } = makeSession();
    const sessions = new SessionManager(makeManager(entry, calls, []), log);
    await sessions.start(startReq());
    await sessions.takeoverStart("s1", {
      language: "javascript",
      step: "one",
    });
    await expect(
      sessions.takeoverStart("s1", { language: "javascript", step: "two" })
    ).rejects.toThrow(/already in an interactive takeover/);
    await sessions.takeoverStop("s1");

    const second = makeSession();
    const headless = new SessionManager(
      makeManager(second.entry, second.calls, []),
      log
    );
    await headless.start(startReq({ headless: true }));
    await expect(
      headless.takeoverStart("s1", { language: "javascript", step: "x" })
    ).rejects.toThrow(/headed/);
  });
});
