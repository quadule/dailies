// The stage: the picture with its caption band, the transport, the two
// clocks and the in/out marks. It plays /source.webm and, with "Preview
// edits" on, simulates the cut as the render will make it — skipping removed
// footage, freezing on holds, speeding through speed-ups, showing the
// captions and playing recorded lines in output time. The decisions come
// from preview.ts; this module only applies them to the media elements.
//
// "Rendered video" swaps the picture for the last render (it has the band
// and voices burned in), mapping its time back to source time for the
// playhead. It is the video as last rendered, which may predate edits, so its
// label says when that was.

import {
  type Cut,
  type CutPlan,
  extendTail,
  mapTime,
  planCut,
} from "../../cut.js";
import type { EditorContext } from "./context.js";
import { button, h, setIcon } from "./dom.js";
import { clock, endOf, snapTime, span } from "./format.js";
import {
  analyze,
  captionAtSource,
  captionLines,
  cueAt,
  type EngineState,
  linesAt,
  linesStarting,
  outputAt,
  type PlacedLine,
  type PreviewModel,
  previewModel,
  sourceTime,
  tick,
} from "./preview.js";

export interface Stage {
  element: HTMLElement;
  jumpStep(direction: -1 | 1): void;
  // Set the in or out point at the playhead.
  mark(which: "in" | "out"): void;
  onTime(listener: (sourceSec: number, playing: boolean) => void): void;
  pause(): void;
  refresh(): void;
  seek(sec: number): void;
  // The cut the rendered video was made from, so its time maps to source,
  // and when it was rendered (ms since the epoch; `here` when this editor
  // made it, so it is known to be that cut).
  setRendered(
    cut: Cut | undefined,
    made?: { at?: number; here: boolean }
  ): void;
  stepFrames(frames: number): void;
  time(): number;
  toggle(): void;
}

type Mode = "preview" | "raw" | "rendered";

// Keep the libass proportions of the burn (narrate.ts subtitleStyle): text
// at the top of the band, below a gap of 8% of its height.
const BAND_GAP = 0.08;
// Longest frame step the engine is given: after a stall (a background tab),
// don't let a hold or a line leap ahead.
const MAX_DT = 0.25;

interface Clocks {
  output: HTMLElement;
  outputTotal: HTMLElement;
  source: HTMLElement;
  sourceTotal: HTMLElement;
}

function clocks(): { node: HTMLElement; parts: Clocks } {
  const parts: Clocks = {
    source: h("span", {
      class: "clock-now",
      attrs: { "data-clock": "source" },
    }),
    sourceTotal: h("span", { class: "clock-total" }),
    output: h("span", {
      class: "clock-now",
      attrs: { "data-clock": "output" },
    }),
    outputTotal: h("span", { class: "clock-total" }),
  };
  const node = h(
    "dl",
    { class: "clocks" },
    h(
      "div",
      { class: "clock" },
      h("dt", { text: "Source" }),
      h("dd", {}, parts.source, " / ", parts.sourceTotal)
    ),
    h(
      "div",
      { class: "clock" },
      h("dt", { text: "Video" }),
      h("dd", {}, parts.output, " / ", parts.outputTotal)
    )
  );
  return { node, parts };
}

// When a render was made, short: the time today, else the date and time.
function renderedWhen(ms: number): string {
  const at = new Date(ms);
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function toggle(label: string, checked: boolean): HTMLInputElement {
  return h("input", {
    type: "checkbox",
    checked,
    attrs: { "aria-label": label },
  });
}

export function createStage(ctx: EditorContext): Stage {
  const { session } = ctx;
  const width = session.source.width || 1280;
  const height = session.source.height || 720;
  const { bandPx, fontPx, lineMax } = session.caption;

  const video = h("video", {
    class: "picture",
    preload: "auto",
    playsInline: true,
    src: "/source.webm",
    attrs: { "aria-label": "The recording" },
  });
  const bandText = h("p", { class: "band-text" });
  const band = h("div", { class: "band" }, bandText);
  const flag = h("p", { class: "flag", hidden: true });
  const screen = h("div", { class: "screen" }, video, band, flag);
  const area = h("div", { class: "screen-area" }, screen);

  const { node: clockNode, parts: clockParts } = clocks();
  const playButton = button("Play", () => api.toggle(), {
    class: "btn icon play",
    icon: "play",
    iconOnly: true,
    title: "Play (Space)",
  });
  const previewToggle = toggle("Preview edits", true);
  const renderedToggle = toggle("Rendered video", false);
  renderedToggle.disabled = true;
  const renderedNote = h("span", { class: "toggle-note" });
  const renderedLabel = h(
    "label",
    { class: "check" },
    renderedToggle,
    h("span", { text: "Rendered video" }),
    renderedNote
  );
  const markIn = h("span", { class: "mark-value", text: "—" });
  const markOut = h("span", { class: "mark-value", text: "—" });
  const markLength = h("span", { class: "mark-length" });

  const transport = h(
    "div",
    { class: "transport" },
    h(
      "div",
      {
        class: "transport-buttons",
        attrs: { role: "group", "aria-label": "Transport" },
      },
      button("Previous step", () => api.jumpStep(-1), {
        class: "btn icon",
        icon: "stepBack",
        iconOnly: true,
      }),
      button("Back one frame", () => api.stepFrames(-1), {
        class: "btn icon",
        icon: "frameBack",
        iconOnly: true,
        title: "Back one frame (←, Shift+← a second)",
      }),
      playButton,
      button("Forward one frame", () => api.stepFrames(1), {
        class: "btn icon",
        icon: "frameForward",
        iconOnly: true,
        title: "Forward one frame (→, Shift+→ a second)",
      }),
      button("Next step", () => api.jumpStep(1), {
        class: "btn icon",
        icon: "stepForward",
        iconOnly: true,
      })
    ),
    clockNode,
    h(
      "div",
      { class: "toggles" },
      h(
        "label",
        { class: "check" },
        previewToggle,
        h("span", { text: "Preview edits" })
      ),
      renderedLabel
    )
  );
  const marks = h(
    "div",
    {
      class: "marks",
      attrs: { role: "group", "aria-label": "In and out points" },
    },
    button("Set in", () => api.mark("in"), {
      class: "btn sm",
      title: "Set the in point at the playhead (I)",
    }),
    h("span", { class: "mark" }, "In ", markIn),
    button("Set out", () => api.mark("out"), {
      class: "btn sm",
      title: "Set the out point at the playhead (O)",
    }),
    h("span", { class: "mark" }, "Out ", markOut),
    markLength,
    button("Clear", () => ctx.state.setMarks({}), {
      class: "btn sm ghost",
      title: "Clear the in and out points (Esc)",
    })
  );
  const element = h(
    "section",
    { class: "stage", attrs: { "aria-label": "Preview" } },
    area,
    transport,
    marks
  );

  // ----- playback state -----

  let mode: Mode = "preview";
  let playing = false;
  let model: PreviewModel = previewModel(ctx.analysis.plan);
  let renderedPlan: CutPlan | undefined;
  let renderedCut: Cut | undefined;
  let engine: EngineState = {};
  let since = 0;
  let out = 0;
  let removed = false;
  let sourceNow = 0;
  let lastFrame = 0;
  let shownText: string | undefined;
  let pendingSeek: number | undefined;
  const listeners: ((t: number, playing: boolean) => void)[] = [];
  const voices = new Map<number, HTMLAudioElement>();
  const frame = 1 / ctx.grid.fps;

  // ----- layout -----

  function layout(): void {
    const box = area.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      return;
    }
    const scale = Math.min(box.width / width, box.height / (height + bandPx));
    screen.style.width = `${Math.floor(width * scale)}px`;
    screen.style.height = `${Math.floor((height + bandPx) * scale)}px`;
    band.style.height = `${bandPx * scale}px`;
    band.style.fontSize = `${fontPx * scale}px`;
    band.style.paddingTop = `${Math.max(2, Math.round(bandPx * BAND_GAP)) * scale}px`;
  }
  new ResizeObserver(layout).observe(area);

  // ----- narration -----

  function stopVoices(): void {
    for (const audio of voices.values()) {
      audio.pause();
    }
  }

  function startVoice(p: PlacedLine, offset: number): void {
    if (!p.line.audio) {
      return;
    }
    const src = `/${p.line.audio}`;
    let audio = voices.get(p.index);
    if (!audio) {
      audio = new Audio();
      voices.set(p.index, audio);
    }
    if (audio.getAttribute("src") !== src) {
      audio.src = src;
    }
    audio.currentTime = Math.max(0, offset);
    audio.play().catch(() => {
      ctx.status(`Couldn't play ${p.line.audio}`, "error");
    });
  }

  function startVoicesAt(at: number): void {
    for (const p of linesAt(ctx.analysis.placed, at)) {
      startVoice(p, at - p.outStart);
    }
  }

  // ----- clocks and band -----

  function mapOut(t: number): void {
    const plan = model.plan;
    const mapped = outputAt(plan, t);
    removed = mapped === undefined;
    out = mapped ?? mapTime(plan, t).out;
  }

  function captionText(): string | undefined {
    if (mode === "rendered") {
      return;
    }
    if (mode === "raw") {
      return captionAtSource(ctx.state.cut.captions, sourceNow)?.text;
    }
    return cueAt(ctx.analysis.cues, out)?.text;
  }

  function drawBand(): void {
    const text = captionText() ?? "";
    if (text === shownText) {
      return;
    }
    shownText = text;
    bandText.replaceChildren(
      ...captionLines(text, lineMax).map((line) => h("span", { text: line }))
    );
  }

  function flagText(): string | undefined {
    if (mode === "rendered") {
      return;
    }
    if (engine.hold) {
      return `Hold ${engine.hold.elapsed.toFixed(1)} / ${span(engine.hold.seconds)}`;
    }
    if (removed && !playing) {
      return "Cut — this footage is removed from the video";
    }
  }

  function draw(): void {
    clockParts.source.textContent = clock(sourceNow, 2);
    clockParts.output.textContent =
      removed && mode !== "rendered" ? "cut" : clock(out, 2);
    const flagged = flagText();
    flag.hidden = flagged === undefined;
    flag.textContent = flagged ?? "";
    element.dataset.holding = engine.hold ? "true" : "false";
    drawBand();
  }

  function drawTotals(): void {
    clockParts.sourceTotal.textContent = clock(endOf(ctx.grid), 2);
    const total =
      mode === "rendered" && renderedPlan
        ? renderedPlan.outDurationSec
        : model.plan.outDurationSec;
    clockParts.outputTotal.textContent = clock(total, 2);
  }

  function emit(): void {
    for (const listener of listeners) {
      listener(sourceNow, playing);
    }
  }

  // ----- the loop -----

  // Start the element. A play() cut short by our own pause (a hold starting)
  // rejects with AbortError, which is no reason to stop; anything else (the
  // browser refusing to play) is.
  function playVideo(): void {
    video.play().catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        api.pause();
      }
    });
  }

  function advancePreview(dt: number): void {
    const end = model.plan.sourceDurationSec;
    const now = video.ended
      ? Math.max(video.currentTime, end)
      : video.currentTime;
    const step = tick(model, engine, { now, since, dt });
    engine = step.state;
    since = step.since;
    if (step.seekTo !== undefined) {
      video.currentTime = step.seekTo;
    }
    if (video.playbackRate !== step.rate) {
      video.playbackRate = step.rate;
    }
    if (step.action === "hold" && !video.paused) {
      video.pause();
    } else if (step.action === "play" && video.paused) {
      playVideo();
    } else if (step.action === "end") {
      api.pause();
    }
    const previous = out;
    out = step.out;
    removed = false;
    sourceNow = Math.min(video.currentTime, end);
    if (out > previous && out - previous < 1) {
      for (const p of linesStarting(ctx.analysis.placed, previous, out)) {
        startVoice(p, out - p.outStart);
      }
    }
  }

  function sync(): void {
    if (mode === "rendered") {
      out = video.currentTime;
      removed = false;
      sourceNow = renderedPlan ? sourceTime(renderedPlan, out) : out;
      return;
    }
    if (engine.hold) {
      // Paused in the middle of a hold: the clocks stay where it stopped.
      return;
    }
    sourceNow = video.currentTime;
    mapOut(sourceNow);
  }

  function loop(ms: number): void {
    const dt = lastFrame ? Math.min((ms - lastFrame) / 1000, MAX_DT) : 0;
    lastFrame = ms;
    const before = sourceNow;
    if (playing && mode === "preview") {
      advancePreview(dt);
    } else {
      sync();
    }
    draw();
    if (sourceNow !== before || playing) {
      emit();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  video.addEventListener("ended", () => {
    if (mode !== "preview") {
      api.pause();
    }
  });
  video.addEventListener("loadedmetadata", () => {
    if (mode === "rendered") {
      fitRenderedPlan(video.duration);
    }
    if (pendingSeek !== undefined) {
      video.currentTime = pendingSeek;
      pendingSeek = undefined;
    }
  });

  // ----- modes -----

  // The plan the rendered video was made with, to map its time to source.
  // The tail the render held for an overrunning last line depends on how long
  // the voices really were: once the video has loaded, its own length says;
  // until then analyze estimates it the way the render does.
  function fitRenderedPlan(videoSec?: number): void {
    if (!renderedCut) {
      renderedPlan = undefined;
      return;
    }
    if (videoSec !== undefined && Number.isFinite(videoSec)) {
      const base = planCut(renderedCut, session.source);
      const extra = videoSec - base.outDurationSec;
      renderedPlan = extra > frame ? extendTail(base, extra) : base;
    } else {
      renderedPlan = analyze(renderedCut, {
        source: session.source,
        lineMax,
        recordings: session.recordings,
        rendered: ctx.rendered,
      }).plan;
    }
    drawTotals();
  }

  function setMode(next: Mode): void {
    if (next === mode) {
      return;
    }
    const t = sourceNow;
    api.pause();
    const wasRendered = mode === "rendered";
    mode = next;
    engine = {};
    video.playbackRate = 1;
    element.dataset.mode = mode;
    if (mode === "rendered") {
      video.src = session.video.url;
      pendingSeek = renderedPlan ? mapTime(renderedPlan, t).out : 0;
    } else if (wasRendered) {
      video.src = "/source.webm";
      pendingSeek = t;
    } else {
      api.seek(t);
    }
    previewToggle.disabled = mode === "rendered";
    drawTotals();
    shownText = undefined;
  }

  previewToggle.addEventListener("change", () => {
    setMode(previewToggle.checked ? "preview" : "raw");
  });
  renderedToggle.addEventListener("change", () => {
    if (renderedToggle.checked) {
      setMode("rendered");
    } else {
      setMode(previewToggle.checked ? "preview" : "raw");
    }
  });

  // ----- marks -----

  function mark(which: "in" | "out"): void {
    const t = snapTime(api.time(), ctx.grid);
    const marks = { ...ctx.state.marks, [which]: t };
    if (
      marks.in !== undefined &&
      marks.out !== undefined &&
      marks.out <= marks.in
    ) {
      if (which === "in") {
        marks.out = undefined;
      } else {
        marks.in = undefined;
      }
    }
    ctx.state.setMarks(marks);
  }

  function drawMarks(): void {
    const { in: inAt, out: outAt } = ctx.state.marks;
    markIn.textContent = inAt === undefined ? "—" : clock(inAt, 2);
    markOut.textContent = outAt === undefined ? "—" : clock(outAt, 2);
    markLength.textContent =
      inAt !== undefined && outAt !== undefined ? span(outAt - inAt) : "";
  }

  ctx.state.subscribe((change) => {
    if (change.marks) {
      drawMarks();
    }
  });

  // ----- the API -----

  const api: Stage = {
    element,
    mark,
    time: () => sourceNow,
    onTime(listener) {
      listeners.push(listener);
    },
    toggle() {
      if (playing) {
        api.pause();
        return;
      }
      if (mode !== "rendered" && sourceNow >= endOf(ctx.grid) - frame) {
        api.seek(0);
      }
      playing = true;
      lastFrame = 0;
      setIcon(playButton, "pause");
      playButton.setAttribute("aria-label", "Pause");
      playButton.title = "Pause (Space)";
      if (mode === "preview") {
        if (!engine.hold) {
          since = sourceNow - 2e-6;
        }
        startVoicesAt(out);
      } else {
        playVideo();
      }
      emit();
    },
    pause() {
      playing = false;
      video.pause();
      stopVoices();
      setIcon(playButton, "play");
      playButton.setAttribute("aria-label", "Play");
      playButton.title = "Play (Space)";
      emit();
    },
    seek(sec) {
      const t = Math.min(Math.max(sec, 0), endOf(ctx.grid));
      stopVoices();
      engine = {};
      since = t - 2e-6;
      sourceNow = t;
      if (mode === "rendered" && renderedPlan) {
        out = mapTime(renderedPlan, t).out;
        video.currentTime = out;
      } else {
        video.currentTime = t;
        mapOut(t);
      }
      if (playing && mode === "preview") {
        startVoicesAt(out);
      }
      draw();
      emit();
    },
    stepFrames(frames) {
      api.pause();
      if (mode === "rendered") {
        video.currentTime = Math.max(0, video.currentTime + frames * frame);
        return;
      }
      api.seek(snapTime(sourceNow + frames * frame, ctx.grid));
    },
    jumpStep(direction) {
      const steps = [...session.steps].sort((a, b) => a.at - b.at);
      const t = sourceNow;
      const target =
        direction < 0
          ? steps.filter((s) => s.at < t - frame / 2).at(-1)
          : steps.find((s) => s.at > t + frame / 2);
      if (target) {
        api.seek(target.at);
      }
    },
    refresh() {
      model = previewModel(ctx.analysis.plan);
      if (!(playing || engine.hold)) {
        sync();
      }
      drawTotals();
      shownText = undefined;
      draw();
    },
    setRendered(cut, made) {
      renderedCut = cut ? structuredClone(cut) : undefined;
      fitRenderedPlan();
      renderedToggle.disabled = !renderedCut;
      if (!renderedCut) {
        renderedNote.textContent = "";
        renderedLabel.title =
          "There's no rendered video yet — Render makes one to watch here.";
      } else if (made?.at === undefined) {
        renderedNote.textContent = "may not match the cut on disk";
        renderedLabel.title =
          "The last rendered video. It may not match the cut on disk if cut.json changed after it was rendered.";
      } else {
        const when = renderedWhen(made.at);
        renderedNote.textContent = `as last rendered ${when}`;
        renderedLabel.title = made.here
          ? `The video this editor rendered at ${when}. Edits made since then aren't in it.`
          : `The video as last rendered, at ${when} — before this editor opened, so it may not match the cut on disk.`;
      }
      if (mode === "rendered") {
        // A new render: reload the video at the same source position.
        const t = sourceNow;
        video.src = session.video.url;
        pendingSeek = renderedPlan ? mapTime(renderedPlan, t).out : 0;
      }
    },
  };

  element.dataset.mode = mode;
  api.setRendered(undefined);
  drawTotals();
  drawMarks();
  return api;
}
