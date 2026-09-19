import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "dailies-logger";
import {
  type CaptionEvent,
  type CaptureOptions,
  DEFAULT_SESSION_VIEWPORT,
  SESSION_CAPTIONS_FILE,
  SESSION_CONSOLE_FILE,
  SESSION_HAR_FILE,
  SESSION_VIDEO_DIR,
  type SessionEndResult,
  type SessionPhase,
  type SessionStartRequest,
  type SessionSummary,
  type SessionTakeoverStopResult,
  type StepPage,
} from "dailies-protocol";
import { collectSessionArtifacts } from "dailies-runtime/artifacts";
import type { ConsoleMessage, Page, WebError } from "playwright";
import type { BrowserEntry, BrowserManager } from "./browser-manager.js";
import { getSessionDir } from "./local-endpoint.js";
import { SESSION_CURSOR_SCRIPT } from "./session-cursor.js";

// Reserved browser-name prefix. A session is a dedicated capture-enabled
// persistent context registered under this name so the existing `execute`
// path drives it unchanged (just target `__session__<id>`).
const SESSION_PREFIX = "__session__";

// Cap each teardown step so a hung context.close() can't stall daemon exit.
const TEARDOWN_TIMEOUT_MS = 5000;

export function sessionBrowserName(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

type EndReason = "end" | "abort";

interface SessionState {
  artifactsDir: string;
  // page.showCaption() calls in order, mirrored to captions.json.
  captions: CaptionEvent[];
  // Serializes the whole-file writes of captions.json (see recordCaption).
  captionWrite: Promise<void>;
  capture: CaptureOptions;
  consolePath: string;
  consoleStream?: WriteStream;
  // Wall-clock (ms) the start URL finished loading + settling, if one was given.
  contentStartedAt?: number;
  // The step currently open, so endStep can name it without being told again.
  currentStep?: string;
  endedAt?: number;
  // The in-flight end(), set for the life of the teardown. A second end() on
  // the same session joins it instead of tearing down (and collecting) twice.
  ending?: Promise<SessionEndResult>;
  entry: BrowserEntry;
  errorDisposers: Array<() => void>;
  headless: boolean;
  name?: string;
  // Last known page count, captured before the context closes (summarize()
  // can't read pages() once the browser disconnects).
  pageCount: number;
  phase: SessionPhase;
  // Set while an interactive takeover is recording the user's manual actions
  // on this context (between takeover-start and takeover-stop).
  recorder?: RecorderCapture;
  runCount: number;
  sessionId: string;
  startedAt: number;
  // The page each step ended on, in order — see endStep.
  stepPages: StepPage[];
  // name-by-video-path, read while the pages are still open (see end()).
  videoNamesByPath?: Map<string, string>;
}

// Buffers the Playwright code the recorder generates for each manual action.
// actionUpdated revises the most recent action (e.g. coalesced keystrokes), so
// it replaces the last entry rather than appending.
interface RecorderCapture {
  actions: Array<{ code: string }>;
  name: string;
  startedAt: number;
}

// Playwright's recorder is reachable on a real client BrowserContext via the
// internal `_enableRecorder(params, eventSink)` / `_disableRecorder()` pair
// (not on the public type). `recorderMode: "api"` streams generated code back
// through the sink with no inspector window.
interface RecorderSink {
  actionAdded?: (page: unknown, action: unknown, code: string) => void;
  actionUpdated?: (page: unknown, action: unknown, code: string) => void;
}
interface RecorderCapableContext {
  _disableRecorder(): Promise<void>;
  _enableRecorder(
    params: {
      language: string;
      mode: "recording";
      recorderMode: "api";
    },
    sink?: RecorderSink
  ): Promise<void>;
}

// Owns the daemon-side session registry and all capture wiring (tracing, video,
// HAR, console). Capture targets the daemon's REAL Playwright context only; the
// QuickJS forked client is never involved.
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly manager: BrowserManager;
  private readonly log: Logger;

  constructor(manager: BrowserManager, log: Logger) {
    this.manager = manager;
    this.log = log;
    // Reconcile the registry when a session's browser disconnects out from
    // under us (crash/external kill). Without this, has() keeps reporting the
    // dead session as live and a later execute launches a fake non-session
    // browser under the reserved __session__ prefix.
    this.manager.onBrowserDisconnect((name) =>
      this.handleBrowserDisconnect(name)
    );
  }

  private handleBrowserDisconnect(name: string): void {
    const sessionId = this.sessionIdForBrowser(name);
    if (!sessionId) {
      return;
    }
    const state = this.sessions.get(sessionId);
    // A normal end() sets phase to "ending" before closing the context, so this
    // only fires on an unexpected crash of a still-active session.
    if (state?.phase !== "active") {
      return;
    }
    state.phase = "failed";
    state.endedAt = Date.now();
    // Drop it immediately so has()/status stop reporting it as live and the
    // execute guard rejects a later run instead of fabricating a context.
    this.sessions.delete(sessionId);
    for (const dispose of state.errorDisposers) {
      try {
        dispose();
      } catch {
        // listener already gone
      }
    }
    state.errorDisposers = [];
    // Flush console; the context is gone so tracing can't be finalized — the
    // orchestrator rebuilds the report from artifacts already on disk.
    void this.closeStream(state.consoleStream);
    state.consoleStream = undefined;
    this.log.warn({ sessionId }, "session browser disconnected unexpectedly");
  }

  isSessionBrowser(name: string): boolean {
    return name.startsWith(SESSION_PREFIX);
  }

  sessionIdForBrowser(name: string): string | undefined {
    return name.startsWith(SESSION_PREFIX)
      ? name.slice(SESSION_PREFIX.length)
      : undefined;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  status(sessionId: string): SessionSummary | undefined {
    const state = this.sessions.get(sessionId);
    return state ? this.summarize(state) : undefined;
  }

  list(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((state) =>
      this.summarize(state)
    );
  }

  noteRun(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.runCount += 1;
    }
  }

  async start(req: SessionStartRequest): Promise<SessionSummary> {
    if (this.sessions.has(req.sessionId)) {
      throw new Error(`Session "${req.sessionId}" already exists`);
    }

    const artifactsDir = getSessionDir(req.sessionId);
    const profileDir = path.join(artifactsDir, "profile");
    const videoDir = path.join(artifactsDir, SESSION_VIDEO_DIR);
    const harPath = path.join(artifactsDir, SESSION_HAR_FILE);
    const consolePath = path.join(artifactsDir, SESSION_CONSOLE_FILE);
    await mkdir(profileDir, { recursive: true });

    const entry = await this.manager.launchSessionBrowser(
      sessionBrowserName(req.sessionId),
      {
        headless: req.headless ?? false,
        ignoreHTTPSErrors: req.ignoreHTTPSErrors ?? false,
        profileDirOverride: profileDir,
        record: {
          videoDir: req.capture.video ? videoDir : undefined,
          har: req.capture.har
            ? { path: harPath, content: "embed" }
            : undefined,
        },
        // Recordings always get a fixed, realistic desktop viewport so video
        // and screenshots are deterministic regardless of headed window size.
        viewport: req.viewport ?? DEFAULT_SESSION_VIEWPORT,
      }
    );

    const state: SessionState = {
      artifactsDir,
      capture: req.capture,
      captions: [],
      captionWrite: Promise.resolve(),
      consolePath,
      entry,
      errorDisposers: [],
      headless: req.headless ?? false,
      name: req.name,
      pageCount: 0,
      phase: "active",
      runCount: 0,
      sessionId: req.sessionId,
      startedAt: Date.now(),
      stepPages: [],
    };

    // launchSessionBrowser already registered the capture context. If the
    // remaining setup throws, tear that context down rather than leaking an
    // untracked recording browser that SessionManager can never reach (it would
    // otherwise survive until daemon shutdown).
    try {
      // Stamp when real content first paints — the first non-about:blank page
      // load — so `session end` trims the pre-content blank (the initial
      // about:blank AND the first navigation's white load screen) off the video
      // head. Fires for a --url open and for the first step's own goto alike; the
      // --url path below overwrites it with a more precise post-settle time.
      // First writer wins (guard), so a later navigation doesn't move it.
      const stampContentStart = (page: Page): void => {
        page.on("load", () => {
          if (!state.contentStartedAt && page.url() !== "about:blank") {
            state.contentStartedAt = Date.now();
          }
        });
      };
      for (const page of entry.context.pages()) {
        stampContentStart(page);
      }
      entry.context.on("page", stampContentStart);

      if (req.cursor !== false) {
        // Virtual cursor + click ripple so recorded video/screenshots show
        // where input happened. Applied via the manager so it shares the
        // content-hash dedupe with user init scripts.
        await this.manager.applyInitScripts(entry.name, [
          SESSION_CURSOR_SCRIPT,
        ]);
        // addInitScript only reaches documents created AFTER registration, and
        // the persistent context comes up with an about:blank page that steps
        // may adopt without ever navigating (e.g. setContent-only flows) —
        // seed the script into already-open pages directly.
        await Promise.all(
          entry.context
            .pages()
            .map((page) =>
              page.evaluate(SESSION_CURSOR_SCRIPT).catch(() => undefined)
            )
        );
      }
      if (req.capture.trace) {
        await entry.context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
          title: req.name ?? req.sessionId,
        });
      }
      if (req.capture.console) {
        this.attachConsole(state);
      }
      // Open the session on a loaded page (before any step) when a start URL is
      // given, so the recording doesn't begin on the initial about:blank. Then
      // settle and stamp contentStartedAt — `session end` trims the video head to
      // it, dropping the pre-load blank. Best-effort: a bad/slow URL warns and
      // leaves the session drivable rather than failing session start.
      if (req.url) {
        try {
          await this.manager.navigateInitialPage(entry.name, req.url);
          await this.manager.settleActivePage(entry.name);
          state.contentStartedAt = Date.now();
        } catch (err) {
          this.log.warn(
            { err, sessionId: req.sessionId, url: req.url },
            "session start URL failed to load; continuing on a blank page"
          );
        }
      }
    } catch (err) {
      await this.swallow(() => this.manager.stopBrowser(entry.name));
      throw err;
    }

    this.sessions.set(req.sessionId, state);
    this.log.info(
      { sessionId: req.sessionId, artifactsDir },
      "session started"
    );
    return this.summarize(state);
  }

  // Record a page.showCaption() as timed data. Written through to
  // captions.json on every call rather than flushed at session end: `session
  // end` can be re-run on an ended session (to re-cut a video), and a crash
  // must not lose the captions a completed run already showed.
  //
  // The writes are chained rather than issued in parallel: the caller fires
  // this and forgets it (`void manager.recordCaption(...)`), so two captions
  // shown back to back would otherwise have two O_TRUNC whole-file writes of
  // the same growing array in flight at once — which can interleave into a
  // truncated, unparseable captions.json. Each write already carries the full
  // array, so serializing them costs nothing and the last one still wins.
  recordCaption(sessionId: string, event: CaptionEvent): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return Promise.resolve();
    }
    state.captions.push(event);
    const captionsPath = path.join(state.artifactsDir, SESSION_CAPTIONS_FILE);
    state.captionWrite = state.captionWrite
      .then(() =>
        writeFile(
          captionsPath,
          `${JSON.stringify(state.captions, null, 2)}\n`,
          "utf8"
        )
      )
      .catch(() => {
        // A caption is presentation, never the point of the run — losing one
        // must not fail the step that showed it, nor poison the chain for the
        // captions after it.
      });
    return state.captionWrite;
  }

  async beginStep(sessionId: string, step: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) {
      // Remembered so endStep can attribute the step even where the caller does
      // not repeat its name (the takeover path).
      state.currentStep = step;
    }
    if (state?.capture.trace) {
      await state.entry.context.tracing.group(step).catch(() => undefined);
    }
  }

  // Records the page the step ended on (BrowserManager.activePageName — the same
  // "last page in the context" the step's screenshot is taken of), so `session
  // end` can finish the recording of the page the run was actually about rather
  // than guessing from how long each one is. Resolved here rather than by the
  // caller so a takeover step is recorded exactly like an executed one.
  async endStep(sessionId: string, step?: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    const stepName = step ?? state?.currentStep;
    if (state && stepName) {
      state.stepPages.push({
        page: this.manager.activePageName(sessionBrowserName(sessionId)),
        step: stepName,
      });
      state.currentStep = undefined;
    }
    if (state?.capture.trace) {
      await state.entry.context.tracing.groupEnd().catch(() => undefined);
    }
  }

  isRecording(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.recorder !== undefined;
  }

  // Enable Playwright's recorder (api mode) on the live session context so a
  // human can drive the headed browser; each manual action's generated code is
  // buffered. Opens a trace group so the takeover reads as one step. Paired
  // with takeoverStop.
  async takeoverStart(
    sessionId: string,
    opts: { language: string; step: string }
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state?.phase !== "active") {
      throw new Error(`Session "${sessionId}" is not active`);
    }
    if (state.recorder) {
      throw new Error(
        `Session "${sessionId}" is already in an interactive takeover`
      );
    }
    if (state.headless) {
      throw new Error(
        "Interactive takeover needs a headed session — start it without --headless"
      );
    }

    const capture: RecorderCapture = {
      actions: [],
      name: opts.step,
      startedAt: Date.now(),
    };
    const sink: RecorderSink = {
      actionAdded: (_page, _action, code) => {
        capture.actions.push({ code: code ?? "" });
      },
      // A revision of the latest action (e.g. accumulating keystrokes) replaces
      // the last buffered entry rather than adding a new one.
      actionUpdated: (_page, _action, code) => {
        if (capture.actions.length > 0) {
          capture.actions[capture.actions.length - 1] = { code: code ?? "" };
        } else {
          capture.actions.push({ code: code ?? "" });
        }
      },
    };

    await this.beginStep(sessionId, opts.step);
    try {
      const context = state.entry.context as unknown as RecorderCapableContext;
      await context._enableRecorder(
        { language: opts.language, mode: "recording", recorderMode: "api" },
        sink
      );
    } catch (err) {
      await this.endStep(sessionId);
      throw err;
    }
    state.recorder = capture;
    // The user drives with their own pointer during a takeover, so hide the
    // virtual cursor (it would otherwise sit frozen, since it ignores user
    // input). Restored on stop.
    await this.#setCursorHidden(state, true);
  }

  #setCursorHidden(state: SessionState, hidden: boolean): Promise<unknown> {
    return Promise.all(
      state.entry.context.pages().map((page) =>
        page
          .evaluate((h) => {
            const c = (
              window as unknown as {
                __dailiesCursor?: { setHidden?: (v: boolean) => void };
              }
            ).__dailiesCursor;
            c?.setHidden?.(h);
          }, hidden)
          .catch(() => undefined)
      )
    );
  }

  // Disable the recorder and return the captured Playwright source. `cancel`
  // still tears the recorder down (and closes the trace group) but signals the
  // caller to discard the capture rather than record a step.
  async takeoverStop(sessionId: string): Promise<SessionTakeoverStopResult> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const capture = state.recorder;
    if (!capture) {
      throw new Error(`Session "${sessionId}" has no active takeover`);
    }

    const context = state.entry.context as unknown as RecorderCapableContext;
    await context._disableRecorder().catch(() => undefined);
    state.recorder = undefined;
    await this.#setCursorHidden(state, false);
    await this.endStep(sessionId);

    const code = capture.actions
      .map((a) => a.code.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    return {
      actionCount: capture.actions.length,
      code,
      durationMs: Date.now() - capture.startedAt,
      startedAt: capture.startedAt,
      step: capture.name,
    };
  }

  // Finalize a session exactly once: the guards here decide whether this call
  // runs the teardown (runEnd) or joins one already in flight.
  async end(sessionId: string, reason: EndReason): Promise<SessionEndResult> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    // Re-entry while a teardown is already running. The session-end RPC holds
    // the per-session browser lock, but daemon shutdown calls endAll() outside
    // it — so a `stop` or SIGTERM lands here mid-teardown. Join the in-flight
    // end instead of tearing down a second time: two collect() passes write
    // manifest.json concurrently, and the one that wins is whichever finished
    // last, not whichever saw the more complete context.
    if (state.ending) {
      return await state.ending;
    }
    // Terminal but still registered. Not reachable today — a crashed session is
    // dropped by handleBrowserDisconnect, and a completed one deletes itself in
    // the finally below — so this is the defensive path for a teardown that was
    // interrupted before it could clean up: collect whatever landed on disk,
    // then make sure the browser and the registry entry go with it.
    if (state.phase !== "active") {
      try {
        return await this.collect(state, reason);
      } finally {
        await this.best(
          () => this.manager.stopBrowser(state.entry.name),
          "session browser stop"
        );
        this.sessions.delete(sessionId);
      }
    }

    // Recorded before the first await, so a re-entrant end() in the same tick
    // finds it (the branch above) rather than starting its own teardown.
    state.ending = this.runEnd(state, sessionId, reason);
    return await state.ending;
  }

  // Strict teardown ordering: stop tracing (writes trace.zip) -> close context
  // (flushes *.webm + finalizes HAR) -> detach listeners + flush console stream
  // -> enumerate artifacts + write manifest.json -> drop the session browser.
  private async runEnd(
    state: SessionState,
    sessionId: string,
    reason: EndReason
  ): Promise<SessionEndResult> {
    state.phase = "ending";
    const ctx = state.entry.context;

    // Capture the live page count BEFORE closing — summarize() can't read
    // pages() once the browser disconnects, so the manifest would record 0.
    if (state.entry.browser.isConnected()) {
      state.pageCount = ctx.pages().length;
    }

    // Same reason, and the one that actually bit: which video belongs to which
    // page can only be read while the pages exist. Closing the context fires
    // page.on("close") for every page, which unregisters each one from
    // entry.pages — so by the time collect() runs, there is nothing left to ask
    // and every video lands unlabelled. That silently disables the whole
    // step-page video promotion path downstream, which matches on pageName.
    state.videoNamesByPath = await this.videoPageNames(state);

    // Flush the trace FULLY — await directly (no timeout race) so trace.zip
    // is completely written before collect() enumerates it.
    if (state.capture.trace) {
      await this.swallow(() =>
        ctx.tracing.stop({ path: path.join(state.artifactsDir, "trace.zip") })
      );
    }
    // Bounded: ctx.close() talks to the browser over CDP (Browser.close /
    // Target.closeTarget), which can hang indefinitely if that transport is
    // wedged — even when the browser process itself is otherwise healthy, and
    // even outside of daemon shutdown. Observed in practice: a single-session
    // `session end` (and `session abort`, which reaches this same path) hung
    // for over an hour with no automatic recovery, and the only way out was
    // manually killing the browser process from outside the daemon. Video/HAR
    // written so far are flushed to disk incrementally, so a timed-out close
    // still leaves collect() something usable to build the report from.
    await this.best(() => ctx.close(), "browser context close");

    for (const dispose of state.errorDisposers) {
      try {
        dispose();
      } catch {
        // listener already gone
      }
    }
    state.errorDisposers = [];
    await this.closeStream(state.consoleStream);
    state.consoleStream = undefined;

    // Finalize phase BEFORE collecting so the manifest reflects ended/aborted.
    state.phase = reason === "abort" ? "aborted" : "ended";
    state.endedAt = Date.now();

    // Always stop the browser and drop the session, even if collect() throws
    // (e.g. a manifest write failure) — otherwise the __session__ browser leaks
    // in BrowserManager with no session entry left to reach it.
    try {
      const result = await this.collect(state, reason);
      this.log.info({ sessionId, reason }, "session ended");
      return result;
    } finally {
      // Bounded for the same reason ctx.close() is: stopBrowser awaits
      // browser.close(), which goes over the same CDP transport and hangs with
      // it — and this one runs in a finally, so an unbounded wait here strands
      // `session end` (and daemon shutdown behind it) after the artifacts are
      // already safely on disk.
      await this.best(
        () => this.manager.stopBrowser(state.entry.name),
        "session browser stop"
      );
      // Drop the session: frees the registry and closes the execute guard hole
      // (a later execute on this name is rejected instead of launching a fake
      // non-session browser under the reserved __session__ prefix).
      this.sessions.delete(sessionId);
    }
  }

  async endAll(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.best(
        () => this.end(sessionId, "abort"),
        "session end (endAll)"
      );
    }
  }

  private attachConsole(state: SessionState): void {
    const stream = createWriteStream(state.consolePath, { flags: "a" });
    // A WriteStream with no 'error' listener throws as an uncaught exception on
    // an async write failure (ENOSPC/EPIPE), which would crash the whole daemon
    // and every other session. Swallow it — losing a console line must not.
    stream.on("error", (err) => {
      this.log.debug(
        { err, sessionId: state.sessionId },
        "console log stream error"
      );
    });
    state.consoleStream = stream;
    const ctx = state.entry.context;

    const write = (record: Record<string, unknown>) => {
      if (!stream.destroyed) {
        stream.write(`${JSON.stringify(record)}\n`);
      }
    };

    const onConsole = (msg: ConsoleMessage) => {
      const loc = msg.location();
      write({
        ts: Date.now(),
        kind: "console",
        type: msg.type(),
        text: msg.text(),
        url: loc.url,
        line: loc.lineNumber,
        col: loc.columnNumber,
        page: this.namePage(state, msg.page()),
      });
    };
    ctx.on("console", onConsole);
    state.errorDisposers.push(() => ctx.off("console", onConsole));

    // weberror is the context-level aggregation of every page's uncaught
    // error, including pages opened later — no per-page wiring needed.
    const onWebError = (webError: WebError) => {
      const err = webError.error();
      write({
        ts: Date.now(),
        kind: "pageerror",
        message: err?.message ?? String(err),
        stack: err?.stack,
        page: this.namePage(state, webError.page()),
      });
    };
    ctx.on("weberror", onWebError);
    state.errorDisposers.push(() => ctx.off("weberror", onWebError));
  }

  private namePage(state: SessionState, page: Page | null): string | undefined {
    if (!page) {
      return;
    }
    for (const [name, candidate] of state.entry.pages) {
      if (candidate === page) {
        return name;
      }
    }
    return;
  }

  // Which page each recording belongs to. Playwright names video files after an
  // internal id, so `page@<hash>.webm` says nothing about what was recorded — and a
  // session with more than one page then offers no way to say which one matters.
  // Ask the pages themselves: scripts name them (`newPage("checkout")`), and that
  // name is what a person or an agent can pass to `session end --video`.
  //
  // Must run BEFORE the context closes, which is the whole hazard: closing a
  // context fires page.on("close") for every page and BrowserManager
  // unregisters each one from entry.pages, so afterwards there is nothing left
  // to ask and every recording lands unlabelled. Reading the path this early is
  // safe — for a local browser Playwright knows the file name as soon as the
  // page exists; it does not wait for the recording to finish.
  private async videoPageNames(
    state: SessionState
  ): Promise<Map<string, string>> {
    const namesByPath = new Map<string, string>();
    await Promise.all(
      [...state.entry.pages].map(async ([name, page]) => {
        try {
          const filePath = await page.video()?.path();
          if (filePath) {
            namesByPath.set(filePath, name);
          }
        } catch {
          // A page that never recorded, or one whose video never landed: the
          // artifact simply goes unlabelled rather than failing the manifest.
        }
      })
    );
    return namesByPath;
  }

  private async collect(
    state: SessionState,
    reason: EndReason
  ): Promise<SessionEndResult> {
    const artifacts = await collectSessionArtifacts(
      state.artifactsDir,
      state.capture
    );
    if (state.capture.video) {
      // Normally captured before the pages close. Interrupted teardown can only
      // recover names if its pages are still available; unlabeled videos remain
      // valid artifacts when they are not.
      const namesByPath =
        state.videoNamesByPath ?? (await this.videoPageNames(state));
      for (const artifact of artifacts) {
        const pageName = namesByPath.get(artifact.path);
        if (artifact.kind === "video" && pageName) {
          artifact.pageName = pageName;
        }
      }
    }

    const session = this.summarize(state);
    const manifestPath = path.join(state.artifactsDir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        { artifacts, reason, session, stepPages: state.stepPages },
        null,
        2
      )
    );
    return { artifacts, manifestPath, session, stepPages: state.stepPages };
  }

  private summarize(state: SessionState): SessionSummary {
    // Live count while the browser is up; the value captured at end() time once
    // it has disconnected (so an ended session reports its real page count, not 0).
    const pageCount = state.entry.browser.isConnected()
      ? state.entry.context.pages().length
      : state.pageCount;
    return {
      artifactsDir: state.artifactsDir,
      browser: state.entry.name,
      capture: state.capture,
      endedAt: state.endedAt,
      headless: state.headless,
      name: state.name,
      pageCount,
      phase: state.phase,
      runCount: state.runCount,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
      contentStartedAt: state.contentStartedAt,
    };
  }

  // Await a teardown step to completion, logging (not throwing) on failure.
  // Used by end() so artifacts are fully flushed before enumeration.
  private async swallow(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.debug({ err }, "session teardown step failed");
    }
  }

  // Like swallow(), but bounded by a timeout so a wedged step (e.g.
  // ctx.close()) can't stall the caller forever. Used by endAll() during
  // daemon shutdown, and by end() when closing the browser context. The
  // losing promise's eventual rejection is consumed by Promise.race, so it
  // never becomes unhandled.
  private async best(fn: () => Promise<unknown>, label: string): Promise<void> {
    let settled = false;
    try {
      await Promise.race([
        fn().finally(() => {
          settled = true;
        }),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!settled) {
              this.log.warn(
                { label },
                "teardown step timed out; proceeding without waiting for it"
              );
            }
            resolve();
          }, TEARDOWN_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (err) {
      this.log.debug({ err, label }, "session teardown step failed");
    }
  }

  private closeStream(stream?: WriteStream): Promise<void> {
    if (!stream) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }
}
