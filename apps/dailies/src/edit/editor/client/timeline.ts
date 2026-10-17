// The timeline: the source footage laid out left to right, one track each for
// the steps, the captions, the narration and the timing edits (cuts, speed-
// ups, holds), with the playhead and the in/out range drawn across them all.
// Everything is in SOURCE time — an edit never moves because of another.
//
// Items are buttons: click selects, drag moves (edges resize), arrow keys
// nudge a frame (Shift: a second; Alt: the end edge). A caption's text is
// edited in place on double-click, F2, or Enter when it is selected. The
// ruler scrubs, pausing playback. Drags snap to frames and show the time they
// land on.
//
// Each track is one tab stop (a roving tabindex): Tab lands on the selected
// item, else the first one at or after the playhead, and ↑/↓ move between
// the track's items in time order (←/→ too on the steps track, where nothing
// nudges), so a long session doesn't take a hundred Tabs to cross.

import type { Cut, CutLine } from "../../cut.js";
import type { EditorStep } from "../contract.js";
import type { EditorContext } from "./context.js";
import { button, h, keyed } from "./dom.js";
import {
  clock,
  endOf,
  moveSpan,
  resizeSpan,
  type Span,
  snapTime,
  span,
} from "./format.js";
import { type LineDuration, previewModel, sourceTime } from "./preview.js";
import type { ItemKind } from "./state.js";

export interface Timeline {
  editCaption(index: number): void;
  element: HTMLElement;
  refresh(): void;
  setPlayhead(sourceSec: number, playing: boolean): void;
}

// Inset at both ends, so an item at 0 isn't flush against the edge.
const PAD = 14;
// A drag starts once the pointer has moved this far.
const DRAG_SLOP_PX = 3;
// Ruler labels at least this far apart.
const LABEL_GAP_PX = 76;
const NICE_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800,
];
// Below this a bar's resize handles move outside it, so its middle can still
// be grabbed.
const NARROW_PX = 56;
const ZOOM_STEP = 1.6;
// Most pixels per frame when zoomed all the way in.
const MAX_FRAME_PX = 16;

type Part = "move" | "start" | "end";

interface Drag {
  index: number;
  kind: ItemKind;
  moved: boolean;
  orig: Span | { at: number };
  part: Part;
  pointerId: number;
  x0: number;
}

function originOf(
  cut: Cut,
  kind: ItemKind,
  index: number
): Span | { at: number } {
  if (kind === "caption") {
    const c = cut.captions[index];
    return { start: c?.start ?? 0, end: c?.end ?? 0 };
  }
  if (kind === "cut") {
    const c = cut.cuts[index];
    return { start: c?.start ?? 0, end: c?.end ?? 0 };
  }
  if (kind === "speedup") {
    const v = cut.speedups[index];
    return { start: v?.start ?? 0, end: v?.end ?? 0 };
  }
  if (kind === "hold") {
    return { at: cut.holds[index]?.at ?? 0 };
  }
  return { at: cut.narration[index]?.at ?? 0 };
}

// Where a speed-up may go without overlapping another.
function speedupBounds(cut: Cut, index: number, self: Span): Partial<Span> {
  let start: number | undefined;
  let end: number | undefined;
  for (const [i, v] of cut.speedups.entries()) {
    if (i === index) {
      continue;
    }
    if (v.end <= self.start + 1e-9) {
      start = Math.max(start ?? 0, v.end);
    } else if (v.start >= self.end - 1e-9) {
      end = Math.min(end ?? Number.POSITIVE_INFINITY, v.start);
    }
  }
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

function rangeAt(cut: Cut, kind: ItemKind, index: number): Span | undefined {
  if (kind === "caption") {
    return cut.captions[index];
  }
  if (kind === "cut") {
    return cut.cuts[index];
  }
  if (kind === "speedup") {
    return cut.speedups[index];
  }
}

function pointAt(
  cut: Cut,
  kind: ItemKind,
  index: number
): { at: number } | undefined {
  if (kind === "hold") {
    return cut.holds[index];
  }
  if (kind === "line") {
    return cut.narration[index];
  }
}

// A step marker's visible name, tooltip and accessible name. A failed step
// says so in words and with a ✕, not only in colour.
// A narration line's label on its bar, and what it says to a screen reader:
// recorded or text to speech, and its length — "~" (about) while estimated.
function lineLabel(
  line: CutLine,
  dur: LineDuration,
  placed: boolean
): [string, string] {
  const text = line.text.trim() || line.audio || "(no text)";
  const estimated = dur.source === "estimate";
  let kind = "text to speech, voiced";
  if (line.audio) {
    kind = "recorded";
  } else if (estimated) {
    kind = "text to speech, not voiced yet";
  }
  return [
    `${line.audio ? "REC" : "TTS"} ${estimated ? "~" : ""}${span(dur.sec)} · ${text}`,
    `Narration line at ${clock(line.at)}, ${kind}, ${estimated ? "about " : ""}${span(dur.sec)}${placed ? "" : ", inside cut footage"}: ${text}`,
  ];
}

function describeStep(step: EditorStep): {
  aria: string;
  name: string;
  title: string;
} {
  const status = [step.ok ? "" : "failed", step.skim ? "skimmed" : ""]
    .filter(Boolean)
    .join(", ");
  const error = step.error ? `\n${step.error}` : "";
  return {
    name: `${step.ok ? "" : "✕ "}${step.name}`,
    title: `${step.name} · ${clock(step.at)}${status ? ` · ${status}` : ""}${error}`,
    aria: `Go to step ${step.name} at ${clock(step.at)}${status ? `, ${status}` : ""}`,
  };
}

function niceStep(pps: number): number {
  return NICE_STEPS.find((s) => s * pps >= LABEL_GAP_PX) ?? 3600;
}

export function createTimeline(ctx: EditorContext): Timeline {
  const { grid } = ctx;
  const duration = endOf(grid);
  const frame = 1 / grid.fps;

  const ruler = h("div", {
    class: "tl-ruler",
    attrs: { "aria-hidden": "true" },
  });
  const tracks = {
    steps: h("div", {
      class: "tl-track steps",
      attrs: { role: "group", "aria-label": "Steps" },
    }),
    captions: h("div", {
      class: "tl-track captions",
      attrs: { role: "group", "aria-label": "Captions" },
    }),
    narration: h("div", {
      class: "tl-track narration",
      attrs: { role: "group", "aria-label": "Narration" },
    }),
    timing: h("div", {
      class: "tl-track timing",
      attrs: { role: "group", "aria-label": "Cuts, speed-ups and holds" },
    }),
  };
  const trackList = [
    tracks.steps,
    tracks.captions,
    tracks.narration,
    tracks.timing,
  ];
  const shade = h("div", {
    class: "tl-shade",
    attrs: { "aria-hidden": "true" },
  });
  const range = h("div", {
    class: "tl-range",
    hidden: true,
    attrs: { "aria-hidden": "true" },
  });
  const playhead = h("div", {
    class: "tl-playhead",
    attrs: { "aria-hidden": "true" },
  });
  const tip = h("div", {
    class: "tl-tip",
    hidden: true,
    attrs: { "aria-hidden": "true" },
  });
  const inline = h("input", {
    class: "tl-inline",
    type: "text",
    hidden: true,
    attrs: { "aria-label": "Caption text", autocomplete: "off" },
  });
  const content = h(
    "div",
    { class: "tl-content" },
    ruler,
    shade,
    tracks.steps,
    tracks.captions,
    tracks.narration,
    tracks.timing,
    range,
    playhead,
    tip,
    inline
  );
  const scroller = h("div", { class: "tl-scroll" }, content);
  const heads = h(
    "div",
    { class: "tl-heads", attrs: { "aria-hidden": "true" } },
    h("div", { class: "tl-head ruler-head" }),
    h("div", { class: "tl-head steps", text: "Steps" }),
    h("div", { class: "tl-head captions", text: "Captions" }),
    h("div", { class: "tl-head narration", text: "Narration" }),
    h("div", { class: "tl-head timing", text: "Timing" })
  );
  const readout = h("p", {
    class: "tl-readout",
    attrs: { "aria-live": "polite" },
  });

  let pps = 40;
  let fitted = true;
  let drag: Drag | undefined;
  let scrubbing: number | undefined;
  let editing: { index: number; original: string } | undefined;
  let playheadAt = 0;

  const x = (t: number) => PAD + t * pps;
  const timeAt = (px: number) => (px - PAD) / pps;
  const minPps = () =>
    Math.max(
      1e-3,
      (scroller.clientWidth - 2 * PAD) / Math.max(duration, frame)
    );
  const maxPps = () => Math.max(minPps(), grid.fps * MAX_FRAME_PX);

  // ----- zoom -----

  function setZoom(next: number, anchor: number): void {
    const offset = x(anchor) - scroller.scrollLeft;
    pps = Math.min(Math.max(next, minPps()), maxPps());
    fitted = pps <= minPps() * 1.0001;
    layout();
    scroller.scrollLeft = x(anchor) - offset;
    drawRuler();
  }

  function fit(): void {
    pps = minPps();
    fitted = true;
    layout();
    scroller.scrollLeft = 0;
    drawRuler();
  }

  function zoomAnchor(): number {
    const left = timeAt(scroller.scrollLeft);
    const right = timeAt(scroller.scrollLeft + scroller.clientWidth);
    return playheadAt >= left && playheadAt <= right
      ? playheadAt
      : (left + right) / 2;
  }

  const bar = h(
    "div",
    { class: "tl-bar" },
    h("h2", { text: "Timeline" }),
    h(
      "div",
      { class: "zoom", attrs: { role: "group", "aria-label": "Zoom" } },
      button("Fit", fit, {
        class: "btn sm",
        icon: "fit",
        title: "Fit the whole recording",
      }),
      button("Zoom out", () => setZoom(pps / ZOOM_STEP, zoomAnchor()), {
        class: "btn sm icon",
        icon: "minus",
        iconOnly: true,
      }),
      button("Zoom in", () => setZoom(pps * ZOOM_STEP, zoomAnchor()), {
        class: "btn sm icon",
        icon: "plus",
        iconOnly: true,
      })
    ),
    readout,
    h("p", {
      class: "tl-help",
      text: "Drag to move, drag an edge to resize · Tab to a track, ↑/↓ between its items · ←/→ nudge a frame, Shift a second, Alt the end · double-click a caption to edit",
    })
  );

  const element = h(
    "section",
    { class: "timeline", attrs: { "aria-label": "Timeline" } },
    bar,
    h("div", { class: "tl-body" }, heads, scroller)
  );

  // ----- drawing -----

  function drawRuler(): void {
    const step = niceStep(pps);
    const decimals = step < 1 ? 1 : 0;
    const from = Math.max(
      0,
      timeAt(scroller.scrollLeft - scroller.clientWidth / 2)
    );
    const to = Math.min(
      duration,
      timeAt(scroller.scrollLeft + scroller.clientWidth * 1.5)
    );
    const ticks: HTMLElement[] = [];
    const first = Math.floor(from / step) * step;
    for (let t = first; t <= to + 1e-9; t += step / 2) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      const tickEl = h("span", { class: major ? "tick major" : "tick" });
      tickEl.style.left = `${x(t)}px`;
      if (major) {
        tickEl.append(
          h("span", { class: "tick-label", text: clock(t, decimals) })
        );
      }
      ticks.push(tickEl);
    }
    ruler.replaceChildren(...ticks);
  }

  function place(el: HTMLElement, start: number, end?: number): void {
    el.style.left = `${x(start)}px`;
    if (end !== undefined) {
      const w = Math.max(2, (end - start) * pps);
      el.style.width = `${w}px`;
      el.classList.toggle("narrow", w < NARROW_PX);
    }
  }

  function itemButton(kind: ItemKind, ranged: boolean): HTMLElement {
    const el = h("button", {
      type: "button",
      class: `tl-item ${kind}`,
      tabIndex: -1,
      attrs: { "data-kind": kind },
    });
    if (ranged) {
      el.append(
        h("span", {
          class: "tl-handle start",
          attrs: { "data-edge": "start" },
        }),
        h("span", { class: "tl-label" }),
        h("span", { class: "tl-handle end", attrs: { "data-edge": "end" } })
      );
    } else {
      el.append(h("span", { class: "tl-label" }));
    }
    return el;
  }

  // Where an item sits in time, for the roving tabindex.
  function at(el: HTMLElement, t: number): void {
    el.dataset.at = String(t);
  }

  function label(el: HTMLElement, text: string, aria: string): void {
    const node = el.querySelector(".tl-label");
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
    el.setAttribute("aria-label", aria);
  }

  function selectState(el: HTMLElement, kind: ItemKind, index: number): void {
    const s = ctx.state.selection;
    const selected = s?.kind === kind && s.index === index;
    el.classList.toggle("selected", selected);
    el.setAttribute("aria-pressed", String(selected));
    el.dataset.index = String(index);
  }

  function drawSteps(): void {
    const steps = ctx.session.steps;
    keyed(
      tracks.steps,
      steps.map((_, i) => `step:${i}`),
      (key) => {
        const i = Number(key.slice(5));
        const step = steps[i];
        const el = h("button", {
          type: "button",
          class: "tl-step",
          tabIndex: -1,
          on: { click: () => ctx.seek(steps[i]?.at ?? 0) },
        });
        if (step?.screenshot) {
          el.append(
            h("img", {
              class: "tl-thumb",
              src: step.screenshot,
              alt: "",
              loading: "lazy",
            })
          );
        }
        el.append(h("span", { class: "tl-step-name" }));
        return el;
      },
      (el, key) => {
        const i = Number(key.slice(5));
        const step = steps[i];
        if (!step) {
          return;
        }
        const next =
          steps.slice(i + 1).find((s) => s.at > step.at)?.at ?? duration + 2;
        place(el, step.at);
        at(el, step.at);
        el.style.maxWidth = `${Math.max(14, (next - step.at) * pps - 4)}px`;
        el.classList.toggle("fail", !step.ok);
        el.classList.toggle("skim", Boolean(step.skim));
        const text = describeStep(step);
        const name = el.querySelector(".tl-step-name") as HTMLElement;
        name.textContent = text.name;
        el.title = text.title;
        el.setAttribute("aria-label", text.aria);
      }
    );
  }

  function drawCaptions(): void {
    const captions = ctx.state.cut.captions;
    keyed(
      tracks.captions,
      captions.map((_, i) => `caption:${i}`),
      () => itemButton("caption", true),
      (el, key) => {
        const i = Number(key.slice(8));
        const c = captions[i];
        if (!c) {
          return;
        }
        place(el, c.start, c.end);
        at(el, c.start);
        selectState(el, "caption", i);
        el.classList.toggle("empty", !c.text.trim());
        label(
          el,
          c.text.trim() || "(no text)",
          `Caption ${clock(c.start)} to ${clock(c.end)}: ${c.text || "no text"}`
        );
      }
    );
  }

  function drawNarration(): void {
    const { narration } = ctx.state.cut;
    const { placed, durations, plan } = ctx.analysis;
    keyed(
      tracks.narration,
      narration.map((_, i) => `line:${i}`),
      () => itemButton("line", false),
      (el, key) => {
        const i = Number(key.slice(5));
        const line = narration[i];
        const dur = durations[i];
        if (!(line && dur)) {
          return;
        }
        const p = placed.find((q) => q.index === i);
        const end = p
          ? sourceTime(plan, p.outStart + p.durationSec)
          : line.at + dur.sec;
        place(el, line.at, Math.max(end, line.at + frame));
        at(el, line.at);
        selectState(el, "line", i);
        el.classList.toggle("recorded", Boolean(line.audio));
        el.classList.toggle("voiced", dur.source === "voiced");
        el.classList.toggle("estimate", dur.source === "estimate");
        el.classList.toggle("dropped", !p);
        // Where its length comes from: recording, voiced, render or estimate.
        el.dataset.source = dur.source;
        const [shown, said] = lineLabel(line, dur, Boolean(p));
        label(el, shown, said);
      }
    );
  }

  function drawTiming(): void {
    const { cuts, speedups, holds } = ctx.state.cut;
    const keys = [
      ...speedups.map((_, i) => `speedup:${i}`),
      ...cuts.map((_, i) => `cut:${i}`),
      ...holds.map((_, i) => `hold:${i}`),
    ];
    keyed(
      tracks.timing,
      keys,
      (key) => {
        const kind = key.split(":")[0] as ItemKind;
        return itemButton(kind, kind !== "hold");
      },
      (el, key) => {
        const [kind, n] = key.split(":") as [ItemKind, string];
        const i = Number(n);
        selectState(el, kind, i);
        if (kind === "hold") {
          const hold = holds[i];
          if (hold) {
            place(el, hold.at);
            at(el, hold.at);
            label(
              el,
              `+${span(hold.seconds)}`,
              `Hold at ${clock(hold.at)} for ${span(hold.seconds)}`
            );
          }
          return;
        }
        const r = kind === "cut" ? cuts[i] : speedups[i];
        if (!r) {
          return;
        }
        place(el, r.start, r.end);
        at(el, r.start);
        if (kind === "cut") {
          label(
            el,
            `Cut ${span(r.end - r.start)}`,
            `Cut ${clock(r.start)} to ${clock(r.end)}, ${span(r.end - r.start)} removed`
          );
        } else {
          const rate = speedups[i]?.rate ?? 2;
          label(
            el,
            `${rate}×`,
            `Speed-up ${rate}× from ${clock(r.start)} to ${clock(r.end)}`
          );
        }
      }
    );
  }

  function drawShade(): void {
    const gaps = previewModel(ctx.analysis.plan).gaps;
    keyed(
      shade,
      gaps.map((_, i) => `gap:${i}`),
      () => h("div", { class: "tl-removed" }),
      (el, key) => {
        const g = gaps[Number(key.slice(4))];
        if (g) {
          place(el, g.start, g.end);
        }
      }
    );
  }

  function drawRange(): void {
    const { in: inAt, out: outAt } = ctx.state.marks;
    range.hidden = inAt === undefined && outAt === undefined;
    if (range.hidden) {
      return;
    }
    const start = inAt ?? outAt ?? 0;
    const end = outAt ?? inAt ?? 0;
    range.classList.toggle("open", inAt === undefined || outAt === undefined);
    range.style.left = `${x(Math.min(start, end))}px`;
    range.style.width = `${Math.max(2, Math.abs(end - start) * pps)}px`;
  }

  function drawPlayhead(): void {
    playhead.style.transform = `translateX(${x(playheadAt)}px)`;
  }

  function layout(): void {
    content.style.width = `${x(duration) + PAD}px`;
    drawSteps();
    drawItems();
    drawPlayhead();
    if (editing) {
      positionInline();
    }
  }

  function drawItems(): void {
    drawCaptions();
    drawNarration();
    drawTiming();
    drawShade();
    drawRange();
    rove();
  }

  // ----- one tab stop per track -----

  // A track's items in time order.
  function itemsIn(track: HTMLElement): HTMLElement[] {
    return [...track.children]
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .sort((a, b) => Number(a.dataset.at) - Number(b.dataset.at));
  }

  // Give each track exactly one tab stop: the focused item while the focus is
  // in it, else the selected item, else the first at or after the playhead.
  function rove(): void {
    const focused = document.activeElement;
    for (const track of trackList) {
      const items = itemsIn(track);
      const current =
        items.find((el) => el === focused) ??
        items.find((el) => el.classList.contains("selected")) ??
        items.find((el) => Number(el.dataset.at) >= playheadAt - frame / 2) ??
        items.at(-1);
      for (const el of items) {
        el.tabIndex = el === current ? 0 : -1;
      }
    }
  }

  // ↑/↓ (and ←/→ on the steps track) to the previous or next item.
  function travel(item: HTMLElement, direction: -1 | 1): void {
    const track = item.parentElement;
    if (!track) {
      return;
    }
    const items = itemsIn(track);
    const next = items[items.indexOf(item) + direction];
    if (!next) {
      return;
    }
    item.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
    const t = Number(next.dataset.at);
    if (
      t < timeAt(scroller.scrollLeft) ||
      x(t) > scroller.scrollLeft + scroller.clientWidth - 40
    ) {
      scroller.scrollLeft = x(t) - scroller.clientWidth / 3;
    }
  }

  // ----- dragging -----

  function applyDrag(cut: Cut, d: Drag, delta: number): void {
    if ("at" in d.orig) {
      const point = pointAt(cut, d.kind, d.index);
      if (point) {
        point.at = snapTime(d.orig.at + delta, grid);
      }
      return;
    }
    const target = rangeAt(cut, d.kind, d.index);
    if (!target) {
      return;
    }
    const bounds =
      d.kind === "speedup" ? speedupBounds(cut, d.index, d.orig) : {};
    const next =
      d.part === "move"
        ? moveSpan(d.orig, delta, grid, bounds)
        : resizeSpan(d.orig, d.part, d.orig[d.part] + delta, grid, bounds);
    target.start = next.start;
    target.end = next.end;
  }

  function trackOf(kind: ItemKind): HTMLElement {
    if (kind === "caption") {
      return tracks.captions;
    }
    return kind === "line" ? tracks.narration : tracks.timing;
  }

  function showTip(kind: ItemKind, index: number): void {
    const cut = ctx.state.cut;
    const r = rangeAt(cut, kind, index);
    const p = pointAt(cut, kind, index);
    const at = r?.start ?? p?.at ?? 0;
    tip.textContent = r
      ? `${clock(r.start, 2)} – ${clock(r.end, 2)}`
      : clock(p?.at ?? 0, 2);
    tip.style.left = `${x(at)}px`;
    const track = trackOf(kind);
    tip.style.top = `${track.offsetTop - 24}px`;
    tip.hidden = false;
  }

  function endDrag(): void {
    if (drag?.moved) {
      ctx.state.end();
      readout.textContent = tip.textContent
        ? `Moved to ${tip.textContent}`
        : "";
    }
    drag = undefined;
    tip.hidden = true;
  }

  function scrubTo(clientX: number): void {
    const box = content.getBoundingClientRect();
    ctx.seek(snapTime(timeAt(clientX - box.left), grid));
  }

  content.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target === inline) {
      return;
    }
    const target = event.target as Element;
    const item = target.closest<HTMLElement>(".tl-item");
    if (!item) {
      if (target.closest(".tl-step")) {
        return;
      }
      scrubbing = event.pointerId;
      content.setPointerCapture(event.pointerId);
      ctx.pause();
      if (!target.closest(".tl-ruler")) {
        ctx.state.select(undefined);
      }
      scrubTo(event.clientX);
      return;
    }
    const kind = item.dataset.kind as ItemKind;
    const index = Number(item.dataset.index);
    const part = (target.closest<HTMLElement>(".tl-handle")?.dataset.edge ??
      "move") as Part;
    ctx.state.select({ kind, index });
    item.setPointerCapture(event.pointerId);
    drag = {
      kind,
      index,
      part,
      pointerId: event.pointerId,
      x0: event.clientX,
      moved: false,
      orig: originOf(ctx.state.cut, kind, index),
    };
  });

  content.addEventListener("pointermove", (event) => {
    if (scrubbing === event.pointerId) {
      scrubTo(event.clientX);
      return;
    }
    const d = drag;
    if (!d || d.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < DRAG_SLOP_PX) {
      return;
    }
    if (!d.moved) {
      d.moved = true;
      ctx.state.begin();
    }
    ctx.state.edit((cut) => {
      applyDrag(cut, d, dx / pps);
      return;
    });
    showTip(d.kind, d.index);
  });

  const release = (event: PointerEvent) => {
    if (scrubbing === event.pointerId) {
      scrubbing = undefined;
      return;
    }
    if (drag?.pointerId === event.pointerId) {
      endDrag();
    }
  };
  content.addEventListener("pointerup", release);
  content.addEventListener("pointercancel", release);
  content.addEventListener("lostpointercapture", release);

  content.addEventListener("click", (event) => {
    const item = (event.target as Element).closest<HTMLElement>(".tl-item");
    if (item) {
      ctx.state.select({
        kind: item.dataset.kind as ItemKind,
        index: Number(item.dataset.index),
      });
    }
  });

  content.addEventListener("dblclick", (event) => {
    const item = (event.target as Element).closest<HTMLElement>(
      ".tl-item.caption"
    );
    if (item) {
      editCaption(Number(item.dataset.index));
    }
  });

  // Keys on a step marker: ↑/↓ and ←/→ move to the previous or next step.
  function stepKey(event: KeyboardEvent, step: HTMLElement): void {
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (back || event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      travel(step, back ? -1 : 1);
    }
  }

  // ←/→ nudge an item a frame (Shift: a second; Alt: its end edge).
  function nudge(event: KeyboardEvent, kind: ItemKind, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    const delta =
      (event.shiftKey ? 1 : frame) * (event.key === "ArrowLeft" ? -1 : 1);
    const orig = originOf(ctx.state.cut, kind, index);
    const part: Part = event.altKey && !("at" in orig) ? "end" : "move";
    ctx.state.edit((cut) => {
      applyDrag(
        cut,
        { kind, index, part, orig, moved: true, pointerId: -1, x0: 0 },
        delta
      );
      return { kind, index };
    });
  }

  // Keys on an item: ↑/↓ move to the previous or next item in its track, ←/→
  // nudge it, and Enter or F2 on a selected caption edits it.
  function itemKey(event: KeyboardEvent, item: HTMLElement): void {
    const plain = !(event.altKey || event.ctrlKey || event.metaKey);
    if (plain && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      travel(item, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    const kind = item.dataset.kind as ItemKind;
    const index = Number(item.dataset.index);
    const s = ctx.state.selection;
    const selected = s?.kind === kind && s.index === index;
    if (
      kind === "caption" &&
      (event.key === "F2" || (event.key === "Enter" && selected))
    ) {
      event.preventDefault();
      editCaption(index);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nudge(event, kind, index);
    }
  }

  content.addEventListener("keydown", (event) => {
    const target = event.target as Element;
    const step = target.closest<HTMLElement>(".tl-step");
    if (step) {
      stepKey(event, step);
      return;
    }
    const item = target.closest<HTMLElement>(".tl-item");
    if (item) {
      itemKey(event, item);
    }
  });

  scroller.addEventListener("scroll", drawRuler, { passive: true });
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      const box = content.getBoundingClientRect();
      setZoom(
        pps * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP),
        timeAt(event.clientX - box.left)
      );
    },
    { passive: false }
  );
  new ResizeObserver(() => {
    if (fitted) {
      pps = minPps();
      layout();
    }
    drawRuler();
  }).observe(scroller);

  // ----- in-place caption editing -----

  function positionInline(): void {
    const c = editing ? ctx.state.cut.captions[editing.index] : undefined;
    if (!c) {
      return;
    }
    const width = Math.max(280, (c.end - c.start) * pps);
    const left = Math.min(
      x(c.start),
      Math.max(0, content.scrollWidth - width - 4)
    );
    inline.style.left = `${left}px`;
    inline.style.width = `${width}px`;
    inline.style.top = `${tracks.captions.offsetTop}px`;
  }

  // Close the in-place editor. From the keyboard (Enter, Escape) focus goes
  // back to the caption; a blur leaves it wherever the user moved it.
  function closeInline(revert: boolean, refocus = true): void {
    const session = editing;
    if (!session) {
      return;
    }
    editing = undefined;
    if (revert) {
      ctx.state.edit((cut) => {
        const c = cut.captions[session.index];
        if (c) {
          c.text = session.original;
        }
        return;
      });
    }
    ctx.state.end();
    inline.hidden = true;
    if (refocus) {
      tracks.captions
        .querySelector<HTMLElement>(`.tl-item[data-index="${session.index}"]`)
        ?.focus();
    }
  }

  function editCaption(index: number): void {
    const c = ctx.state.cut.captions[index];
    if (!c) {
      return;
    }
    if (editing) {
      closeInline(false, false);
    }
    ctx.state.select({ kind: "caption", index });
    editing = { index, original: c.text };
    ctx.state.begin();
    inline.value = c.text;
    inline.hidden = false;
    positionInline();
    const item = tracks.captions.querySelector<HTMLElement>(
      `.tl-item[data-index="${index}"]`
    );
    if (
      item &&
      (x(c.start) < scroller.scrollLeft ||
        x(c.start) > scroller.scrollLeft + scroller.clientWidth - 40)
    ) {
      scroller.scrollLeft = x(c.start) - 40;
    }
    inline.focus();
    inline.select();
  }

  inline.addEventListener("input", () => {
    const index = editing?.index;
    if (index === undefined) {
      return;
    }
    ctx.state.edit((cut) => {
      const c = cut.captions[index];
      if (c) {
        c.text = inline.value;
      }
      return;
    });
  });
  inline.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      closeInline(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeInline(true);
    }
  });
  inline.addEventListener("blur", () => closeInline(false, false));

  // ----- the API -----

  return {
    element,
    editCaption,
    refresh() {
      layout();
    },
    setPlayhead(sourceSec, playing) {
      playheadAt = sourceSec;
      drawPlayhead();
      if (!playing) {
        rove();
      }
      const px = x(sourceSec);
      const left = scroller.scrollLeft;
      const right = left + scroller.clientWidth;
      if (
        (px < left || px > right - 24) &&
        (playing || scrubbing === undefined)
      ) {
        scroller.scrollLeft = px - scroller.clientWidth * (playing ? 0.1 : 0.5);
      }
    },
  };
}
