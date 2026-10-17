// The browser editor for one session's cut.json, served by `dailies cut edit`
// (../server.ts; the HTTP contract is ../contract.ts and AGENTS.md).
//
// main.ts boots the editor and lays it out: the top bar (save, render, undo),
// the validation line, the stage (stage.ts, a live preview of the edits), the
// inspector (inspector.ts) and the timeline (timeline.ts), and wires the
// narration recorder (recorder.ts) to the stage. The cut model is
// edit/cut.ts itself, so every output time shown here is the one the render
// will produce. Every time in the cut is SOURCE time.
//
// window.dailiesEditor is a small handle for QA scripts (see AGENTS.md).

import type { Cut } from "../../cut.js";
import type {
  EditorSession,
  RenderStatus,
  UploadRecordingResponse,
} from "../contract.js";
import { api } from "./api.js";
import type { EditorContext } from "./context.js";
import { button, h, isTyping } from "./dom.js";
import { clock, endOf, span } from "./format.js";
import { createInspector } from "./inspector.js";
import { analyze } from "./preview.js";
import {
  attachRecording,
  bindRecorder,
  cancelRecording,
  deleteOrphans,
  pressRecord,
  type RecorderPhase,
  type RecorderProblem,
  recordingBanner,
} from "./recorder.js";
import { createStage } from "./stage.js";
import { EditorState } from "./state.js";
import { createTimeline } from "./timeline.js";

const POLL_MS = 1000;
// A transient status message clears after this long; errors stay.
const STATUS_MS = 8000;
// Polls that may fail in a row before the editor stops following a render.
const POLL_RETRIES = 5;

export interface DailiesEditor {
  addRecording: typeof attachRecording;
  getCut(): Cut;
  // The narration recorder: its phase, and why the last Record press didn't
  // record.
  recording(): { phase: RecorderPhase; problem?: RecorderProblem };
  render(): Promise<RenderStatus | undefined>;
  save(): Promise<boolean>;
  seek(sec: number): void;
  setCut(cut: Cut): void;
}

declare global {
  interface Window {
    dailiesEditor?: DailiesEditor;
  }
}

const app = document.getElementById("app") as HTMLElement;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// When the video at session.video.url was written (its `v` is its mtime), or
// undefined when there is none.
function renderedAt(session: EditorSession): number | undefined {
  const v = Number(
    new URL(session.video.url, location.origin).searchParams.get("v")
  );
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// The video at session.video.url exists.
function hasRender(session: EditorSession): boolean {
  return !session.video.url.endsWith("?v=0");
}

function start(session: EditorSession, initial: RenderStatus): void {
  const state = new EditorState(session.cut);
  const grid = {
    durationSec: session.source.durationSec,
    fps: session.source.fps || 30,
  };
  const statusLine = h("p", { class: "status", attrs: { role: "status" } });
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  // The status line holds "can't save" for an invalid cut: cleared once the
  // cut is valid again, so it never contradicts the verdict.
  let invalidNotice = false;

  const ctx: EditorContext = {
    session,
    state,
    grid,
    rendered: (initial.result?.lines ?? []).map((l) => ({
      text: l.text,
      durationSec: l.durationSec,
    })),
    analysis: analyze(state.cut, {
      source: grid,
      lineMax: session.caption.lineMax,
      recordings: session.recordings,
      rendered: [],
    }),
    pause: () => stage.pause(),
    playhead: () => stage.time(),
    refresh: () => {
      recompute();
      refreshAll();
    },
    seek: (sec) => stage.seek(sec),
    status(text, tone) {
      invalidNotice = false;
      statusLine.textContent = text;
      statusLine.classList.toggle("error", tone === "error");
      clearTimeout(statusTimer);
      if (tone !== "error") {
        statusTimer = setTimeout(() => {
          statusLine.textContent = "";
        }, STATUS_MS);
      }
    },
  };
  const recompute = () => {
    ctx.analysis = analyze(state.cut, {
      source: grid,
      lineMax: session.caption.lineMax,
      recordings: session.recordings,
      rendered: ctx.rendered,
    });
  };
  recompute();

  // A take was attached and its line selected: put the cursor in its text
  // and the playhead on it, to review it by playing.
  function recorded(saved: UploadRecordingResponse, line?: number): void {
    inspector.focusText();
    const at = line === undefined ? undefined : state.cut.narration[line]?.at;
    if (at !== undefined) {
      stage.seek(at);
    }
    ctx.status(
      `Recorded ${span(saved.durationSec)} — type what you said for the caption, or leave it blank. Play to review it; save to keep it.`
    );
  }

  const banner = recordingBanner();
  const recorder = bindRecorder(ctx, {
    attached: recorded,
    changed: () => {
      app.dataset.recording = recorder.phase;
      banner.update();
      inspector.refresh();
    },
    pause: () => stage.pause(),
    play: (sec) => stage.playSilently(sec),
  });

  const stage = createStage(ctx);
  const timeline = createTimeline(ctx);
  const inspector = createInspector(ctx, {
    editCaption: (i) => timeline.editCaption(i),
  });
  stage.addOverlay(banner.element);
  stage.onPause(() => recorder.playbackStopped());

  // ----- top bar -----

  let rendering = initial.state === "running";
  let saving = false;
  let renderNote = "";

  const badge = h("span", { class: "badge sm" });
  const undo = button("Undo", () => state.undo(), {
    class: "btn icon",
    icon: "undo",
    iconOnly: true,
    title: "Undo (Ctrl/⌘ Z)",
  });
  const redo = button("Redo", () => state.redo(), {
    class: "btn icon",
    icon: "redo",
    iconOnly: true,
    title: "Redo (Shift Ctrl/⌘ Z)",
  });
  const saveButton = button("Save", () => void save(), {
    class: "btn primary",
  });
  const renderButton = button("Render", () => void render(), { class: "btn" });
  const renderState = h("span", {
    class: "render-note",
    attrs: { role: "status" },
  });
  const reportPath = `~/.dailies/sessions/${session.id}/report.html`;
  const copy = button(
    "Copy the report's path",
    () => {
      navigator.clipboard.writeText(reportPath).then(
        () => ctx.status("Copied the report's path"),
        () => ctx.status("Couldn't copy — select the path instead", "error")
      );
    },
    { class: "btn icon xs", icon: "copy", iconOnly: true }
  );
  const header = h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "title" },
      h("h1", { text: session.name ?? session.id }),
      h(
        "p",
        { class: "crumb" },
        h("span", { class: "mono", text: session.id }),
        h("span", {
          class: "sep",
          text: "·",
          attrs: { "aria-hidden": "true" },
        }),
        "Report ",
        h("code", { text: reportPath }),
        copy
      )
    ),
    badge,
    h(
      "div",
      { class: "actions" },
      undo,
      redo,
      saveButton,
      renderButton,
      renderState
    )
  );

  // ----- the validation line -----

  const verdict = h("p", { class: "verdict" });
  const hintList = h("ul", { class: "hint-list" });
  const hintSummary = h("summary");
  const hints = h("details", { class: "hints" }, hintSummary, hintList);
  const checks = h(
    "div",
    { class: "checks", attrs: { "aria-label": "Validation" } },
    verdict,
    hints,
    statusLine
  );

  function saveBlocker(): string | undefined {
    if (rendering) {
      return "Saving waits for the render: it writes the voice it used into cut.json when it finishes";
    }
    if (ctx.analysis.error) {
      return "Fix the problem in the cut first";
    }
    if (saving) {
      return "Saving…";
    }
    if (!state.dirty) {
      return "No unsaved changes";
    }
  }

  function drawChecks(): void {
    const { error, hints: found, plan } = ctx.analysis;
    verdict.className = `verdict ${error ? "bad" : "ok"}`;
    verdict.replaceChildren(
      h("span", {
        class: "mark",
        text: error ? "✕" : "✓",
        attrs: { "aria-hidden": "true" },
      }),
      error
        ? h("span", {}, h("strong", { text: "Can't save: " }), error)
        : h("span", {
            text: `Valid · ${clock(endOf(grid))} of footage → ${clock(plan.outDurationSec)} of video`,
          })
    );
    hints.hidden = found.length === 0;
    hintSummary.textContent =
      found.length === 1
        ? `1 hint: ${found[0]}`
        : `${found.length} hints — ${found[0] ?? ""}`;
    hintList.replaceChildren(...found.map((t) => h("li", { text: t })));
    if (invalidNotice && !error) {
      ctx.status("");
    }
    if (rendering && !statusLine.textContent) {
      statusLine.textContent =
        "A render is running — saving is paused until it finishes.";
    }
  }

  function drawTop(): void {
    const dirty = state.dirty;
    badge.textContent = dirty ? "Unsaved changes" : "Saved";
    badge.className = `badge sm ${dirty ? "unsaved" : "saved"}`;
    undo.disabled = !state.canUndo;
    redo.disabled = !state.canRedo;
    const blocker = saveBlocker();
    saveButton.disabled = blocker !== undefined;
    saveButton.title = blocker ?? "Save cut.json (Ctrl/⌘ S)";
    renderButton.disabled = rendering || Boolean(ctx.analysis.error);
    renderButton.title = rendering
      ? "A render is running"
      : "Save if needed, then render the video from cut.json";
    const label = renderButton.querySelector("span");
    if (label) {
      label.textContent = rendering ? "Rendering…" : "Render";
    }
    renderState.textContent = renderNote;
    drawChecks();
  }

  // ----- saving and rendering -----

  async function save(): Promise<boolean> {
    const blocker = rendering || ctx.analysis.error ? saveBlocker() : undefined;
    if (blocker) {
      ctx.status(
        ctx.analysis.error ? `Can't save: ${ctx.analysis.error}` : blocker,
        "error"
      );
      invalidNotice = Boolean(ctx.analysis.error);
      return false;
    }
    saving = true;
    drawTop();
    const sent = JSON.stringify(state.cut);
    try {
      const saved = await api.saveCut(state.cut);
      state.markSaved(saved.cut, sent);
      // Takes this page uploaded that the saved cut no longer uses (replaced,
      // removed, undone) are deleted now. An undo can still bring one back;
      // its line then says the file is gone.
      const removed = await deleteOrphans(saved.cut, state.cut);
      if (removed.length > 0) {
        recompute();
        refreshAll();
      }
      ctx.status(
        removed.length > 0
          ? `Saved cut.json and deleted ${removed.length === 1 ? "1 unused recording" : `${removed.length} unused recordings`}`
          : "Saved cut.json"
      );
      return true;
    } catch (err) {
      ctx.status(`Not saved: ${message(err)}`, "error");
      return false;
    } finally {
      saving = false;
      drawTop();
    }
  }

  function showRender(status: RenderStatus): void {
    inspector.showRender(status);
    if (status.state === "running") {
      renderNote = status.progress.at(-1) ?? "starting…";
    } else if (status.state === "error") {
      renderNote = "Render failed";
    } else {
      renderNote = "";
    }
    drawTop();
  }

  async function finishRender(status: RenderStatus): Promise<void> {
    rendering = false;
    if (status.result) {
      ctx.rendered = status.result.lines.map((l) => ({
        text: l.text,
        durationSec: l.durationSec,
      }));
    }
    const fresh = await api.session();
    session.video = fresh.video;
    session.recordings = fresh.recordings;
    session.steps = fresh.steps;
    // The render may have pinned its voice into cut.json: the edits made
    // while it ran stay, and the history takes the pinned voice too.
    if (state.dirty) {
      state.setDisk(fresh.cut, { rendered: true });
    } else {
      state.load(fresh.cut, { rendered: true });
    }
    recompute();
    if (status.state === "done" && hasRender(session)) {
      stage.setRendered(fresh.cut, { at: renderedAt(session), here: true });
    }
    refreshAll();
    showRender(status);
    ctx.status(
      status.state === "done" && status.result
        ? `Rendered ${clock(status.result.durationSec)} of video — switch on "Rendered video" to watch it`
        : `The render failed: ${status.error ?? "no reason given"}`,
      status.state === "done" ? undefined : "error"
    );
  }

  let failures = 0;
  async function poll(): Promise<void> {
    try {
      const status = await api.renderStatus();
      failures = 0;
      showRender(status);
      if (status.state === "running") {
        setTimeout(() => void poll(), POLL_MS);
        return;
      }
      await finishRender(status);
    } catch (err) {
      failures += 1;
      if (failures < POLL_RETRIES) {
        setTimeout(() => void poll(), POLL_MS);
        return;
      }
      rendering = false;
      drawTop();
      ctx.status(`Lost track of the render: ${message(err)}`, "error");
    }
  }

  async function render(): Promise<RenderStatus | undefined> {
    if (rendering) {
      return;
    }
    if (state.dirty && !(await save())) {
      return;
    }
    try {
      const status = await api.startRender();
      rendering = true;
      showRender(status);
      setTimeout(() => void poll(), POLL_MS);
      return status;
    } catch (err) {
      ctx.status(`Not rendered: ${message(err)}`, "error");
      return;
    }
  }

  // ----- wiring -----

  function refreshAll(): void {
    stage.refresh();
    timeline.refresh();
    inspector.refresh();
    drawTop();
  }

  state.subscribe((change) => {
    if (change.cut) {
      recompute();
      stage.refresh();
    }
    if (change.cut || change.selection || change.marks) {
      timeline.refresh();
      inspector.refresh();
    }
    drawTop();
  });
  stage.onTime((t, playing) => timeline.setPlayhead(t, playing));

  const main = h(
    "main",
    { class: "workspace" },
    stage.element,
    inspector.element
  );
  app.className = "editor";
  app.replaceChildren(header, checks, main, timeline.element);

  if (hasRender(session)) {
    stage.setRendered(session.cut, { at: renderedAt(session), here: false });
  }
  showRender(initial);
  if (rendering) {
    setTimeout(() => void poll(), POLL_MS);
  }
  refreshAll();

  // ----- keyboard -----

  function history(forward: boolean): void {
    if (forward) {
      state.redo();
    } else {
      state.undo();
    }
  }

  // Keys that work wherever the focus is: Ctrl/⌘ S saves, and Escape throws
  // a recording away.
  function anywhereKey(event: KeyboardEvent): boolean {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      void save();
      return true;
    }
    return event.key === "Escape" && cancelRecording();
  }

  function onKey(event: KeyboardEvent): void {
    if (anywhereKey(event)) {
      event.preventDefault();
      return;
    }
    if (isTyping(event.target)) {
      if (event.key === "Escape") {
        (event.target as HTMLElement).blur();
      }
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && (key === "z" || key === "y")) {
      event.preventDefault();
      history(key === "y" || event.shiftKey);
      return;
    }
    if (mod || event.altKey) {
      return;
    }
    const handled = key === "r" ? record() : shortcut(event);
    if (handled) {
      event.preventDefault();
    }
  }

  // R: record the selected narration line, else a new one at the playhead;
  // again to stop.
  function record(): boolean {
    const sel = state.selection;
    pressRecord(sel?.kind === "line" ? sel.index : undefined);
    return true;
  }

  function shortcut(event: KeyboardEvent): boolean {
    switch (event.key) {
      case " ":
        stage.toggle();
        return true;
      case "i":
      case "I":
        stage.mark("in");
        return true;
      case "o":
      case "O":
        stage.mark("out");
        return true;
      case "ArrowLeft":
      case "ArrowRight": {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (event.shiftKey) {
          stage.pause();
          stage.seek(stage.time() + direction);
        } else {
          stage.stepFrames(direction);
        }
        return true;
      }
      case "Home":
        stage.seek(0);
        return true;
      case "End":
        stage.seek(endOf(grid));
        return true;
      case "Delete":
      case "Backspace":
        return state.removeSelected();
      case "Escape":
        if (state.selection) {
          state.select(undefined);
        } else {
          state.setMarks({});
        }
        return true;
      default:
        return false;
    }
  }

  window.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", (event) => {
    if (state.dirty || recorder.busy) {
      event.preventDefault();
    }
  });
  // Let go of the microphone with the page.
  window.addEventListener("pagehide", () => recorder.release());

  window.dailiesEditor = {
    getCut: () => structuredClone(state.cut),
    setCut(cut) {
      state.edit((current) => {
        Object.assign(current, structuredClone(cut));
        return;
      });
    },
    addRecording: attachRecording,
    recording: () => ({
      phase: recorder.phase,
      ...(recorder.problem ? { problem: { ...recorder.problem } } : {}),
    }),
    save,
    render,
    seek: (sec) => stage.seek(sec),
  };
}

function failed(err: unknown): void {
  app.className = "editor failed";
  app.replaceChildren(
    h(
      "div",
      { class: "boot-error", attrs: { role: "alert" } },
      h("h1", { text: "The editor couldn't load this session" }),
      h("p", { text: message(err) })
    )
  );
}

Promise.all([
  api.session(),
  api
    .renderStatus()
    .catch((): RenderStatus => ({ state: "idle", progress: [] })),
]).then(([session, status]) => start(session, status), failed);
