// The inspector (right column): the selected item's fields, the Add section,
// the voice (voicing the text-to-speech lines, and the recordings no line
// uses), the last render, and the keyboard shortcuts.
//
// The selected item's panel is rebuilt only when the selection (or the shape
// of the item, like a line gaining audio) changes; otherwise each field
// updates its value in place, and a field being typed in is left alone. A
// field's edits from focus to blur are one undo step.

import {
  type Cut,
  type CutLine,
  type CutVoice,
  MAX_SPEEDUP_RATE,
} from "../../cut.js";
import type { RenderStatus } from "../contract.js";
import type { EditorContext } from "./context.js";
import { button, h, keyed, setIcon } from "./dom.js";
import { clock, endOf, parseSeconds, snapTime, span } from "./format.js";
import {
  deleteRecording,
  recordButton,
  recordingControls,
  recordingGone,
  unusedRecordings,
} from "./recorder.js";
import type { Selection } from "./state.js";
import { voiceAllControls, voiceLineControls } from "./voice.js";

export interface Inspector {
  element: HTMLElement;
  // Focus the selected item's main text field (after adding a line, or
  // recording one).
  focusText(): void;
  refresh(): void;
  showRender(status: RenderStatus): void;
}

interface Field {
  node: HTMLElement;
  update(): void;
}

const DEFAULT_CAPTION_SEC = 3;
const DEFAULT_HOLD_SEC = 2;
const DEFAULT_RATE = 4;
const LOG_LINES = 6;
// The spoken-text field of a recorded line with no text yet.
const RECORDED_PLACEHOLDER =
  "Type what you said for the caption, or leave it blank";

let ids = 0;
function nextId(base: string): string {
  ids += 1;
  return `${base}-${ids}`;
}

function seconds(t: number): string {
  return String(Math.round(t * 1000) / 1000);
}

// "Playhead": sets a time field to the playhead. Its accessible name says
// which field.
function playheadButton(field: string, onClick: () => void): HTMLElement {
  const node = button("Playhead", onClick, {
    class: "btn sm",
    title: `Set ${field.toLowerCase()} to the playhead`,
  });
  node.setAttribute("aria-label", `Set ${field.toLowerCase()} to the playhead`);
  return node;
}

// The parser's rule for a range ("<range>.end must be after its start"), as
// the Start or End field that would break it says it.
function startBefore(end: () => number | undefined) {
  return (t: number): string | undefined => {
    const e = end();
    return e !== undefined && t >= e
      ? `End must be after its start — this is at or after the end, ${clock(e)}`
      : undefined;
  };
}

function endAfter(start: () => number | undefined) {
  return (t: number): string | undefined => {
    const s = start();
    return s !== undefined && t <= s
      ? `End must be after its start — this is at or before the start, ${clock(s)}`
      : undefined;
  };
}

// How a line's caption override reads: none set, an empty one, or text.
function modeOf(caption: string | undefined): "spoken" | "none" | "custom" {
  if (caption === undefined) {
    return "spoken";
  }
  return caption === "" ? "none" : "custom";
}

// The override a caption mode starts from: "" for none, else the line's own
// override or, failing that, its spoken text to edit.
function captionFor(mode: string, line: CutLine): string {
  if (mode === "none") {
    return "";
  }
  return line.caption || line.text;
}

// A voice with the given keys set, and the ones set to undefined dropped.
function patchVoice(voice: CutVoice, patch: Partial<CutVoice>): CutVoice {
  const merged: Record<string, unknown> = { ...voice, ...patch };
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined)
  ) as CutVoice;
}

export function createInspector(
  ctx: EditorContext,
  hooks: { editCaption(index: number): void }
): Inspector {
  const { state, grid } = ctx;
  const frame = 1 / grid.fps;
  const lineMax = ctx.session.caption.lineMax;

  // Edit through the state; the field gesture (focus → blur) groups them.
  const edit = (mutate: (cut: Cut) => void) =>
    state.edit((cut) => {
      mutate(cut);
      return;
    });

  // ----- field builders -----

  // A time field. `check` refuses a time the parser would (an end before its
  // start) with its message, inline, instead of applying it.
  function timeField(
    name: string,
    get: () => number | undefined,
    set: (t: number) => void,
    check?: (t: number) => string | undefined
  ): Field {
    const id = nextId("t");
    const input = h("input", {
      id,
      type: "text",
      class: "time-input",
      attrs: {
        inputmode: "decimal",
        autocomplete: "off",
        "aria-describedby": `${id}-clock ${id}-err`,
      },
    });
    const hint = h("span", { id: `${id}-clock`, class: "clock-hint" });
    const error = h("p", {
      id: `${id}-err`,
      class: "field-error",
      hidden: true,
    });
    const refuse = (problem: string | undefined) => {
      input.setAttribute("aria-invalid", String(problem !== undefined));
      error.hidden = problem === undefined;
      error.textContent = problem ?? "";
    };
    const apply = (t: number) => {
      const problem = check?.(t);
      refuse(problem);
      if (problem === undefined) {
        set(t);
      }
    };
    const commit = () => {
      const value = parseSeconds(input.value);
      if (value === undefined) {
        refuse("Type seconds (12.5) or minutes and seconds (0:12.5)");
        return;
      }
      apply(snapTime(value, grid));
    };
    input.addEventListener("change", commit);
    const node = h(
      "div",
      { class: "field" },
      h("label", { htmlFor: id, text: name }),
      h(
        "div",
        { class: "time-row" },
        input,
        h("span", { class: "unit", text: "s" }),
        hint,
        playheadButton(name, () => {
          const t = snapTime(ctx.playhead(), grid);
          input.value = seconds(t);
          apply(t);
        })
      ),
      error
    );
    return {
      node,
      update() {
        const t = get();
        if (t === undefined) {
          return;
        }
        if (
          document.activeElement !== input &&
          input.getAttribute("aria-invalid") !== "true"
        ) {
          input.value = seconds(t);
        }
        hint.textContent = clock(t);
      },
    };
  }

  function textField(
    name: string,
    get: () => string | undefined,
    set: (text: string) => void,
    opts: { counter?: boolean; placeholder?: string; rows?: number } = {}
  ): Field & { input: HTMLTextAreaElement } {
    const id = nextId("x");
    const input = h("textarea", {
      id,
      rows: opts.rows ?? 2,
      placeholder: opts.placeholder ?? "",
      attrs: { "aria-describedby": `${id}-count` },
    });
    const count = h("span", { id: `${id}-count`, class: "counter" });
    input.addEventListener("focus", () => state.begin());
    input.addEventListener("blur", () => state.end());
    input.addEventListener("input", () => set(input.value));
    const node = h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "label-row" },
        h("label", { htmlFor: id, text: name }),
        opts.counter ? count : null
      ),
      input
    );
    return {
      node,
      input,
      update() {
        const text = get() ?? "";
        if (document.activeElement !== input && input.value !== text) {
          input.value = text;
        }
        if (opts.counter) {
          const over = text.length > lineMax * 2;
          count.textContent = `${text.length} / ${lineMax * 2}${over ? " — too long, cut off" : ""}`;
          count.classList.toggle("over", over);
        }
      },
    };
  }

  function note(get: () => string): Field {
    const node = h("p", { class: "note" });
    return {
      node,
      update() {
        node.textContent = get();
      },
    };
  }

  // ----- the selected item -----

  const selected = h("section", {
    class: "panel selected",
    attrs: { "aria-labelledby": "selected-title" },
  });
  let fields: Field[] = [];
  let shape = "";
  let mainText: HTMLTextAreaElement | undefined;

  function header(
    title: string,
    sel: Selection,
    total: number,
    at: () => number
  ): HTMLElement {
    return h(
      "div",
      { class: "panel-head" },
      h("h2", { id: "selected-title", text: title }),
      h("span", { class: "count", text: `${sel.index + 1} of ${total}` }),
      h(
        "div",
        { class: "head-actions" },
        button("Go to", () => ctx.seek(at()), {
          class: "btn sm",
          title: "Move the playhead here",
        }),
        button(`Delete ${title.toLowerCase()}`, () => state.removeSelected(), {
          class: "btn sm icon danger",
          icon: "trash",
          iconOnly: true,
          title: `Delete this ${title.toLowerCase()} (Delete)`,
        })
      )
    );
  }

  function captionFields(i: number): HTMLElement[] {
    const get = () => state.cut.captions[i];
    const text = textField(
      "Text",
      () => get()?.text,
      (v) =>
        edit((c) => {
          const cap = c.captions[i];
          if (cap) {
            cap.text = v;
          }
        }),
      { counter: true, placeholder: "What the band says" }
    );
    mainText = text.input;
    fields = [
      timeField(
        "Start",
        () => get()?.start,
        (t) =>
          edit((c) => {
            const cap = c.captions[i];
            if (cap) {
              cap.start = t;
            }
          }),
        startBefore(() => get()?.end)
      ),
      timeField(
        "End",
        () => get()?.end,
        (t) =>
          edit((c) => {
            const cap = c.captions[i];
            if (cap) {
              cap.end = t;
            }
          }),
        endAfter(() => get()?.start)
      ),
      note(() => {
        const cap = get();
        return cap
          ? `On screen for ${span(cap.end - cap.start)} of footage.`
          : "";
      }),
      text,
    ];
    return [
      header(
        "Caption",
        { kind: "caption", index: i },
        state.cut.captions.length,
        () => get()?.start ?? 0
      ),
      ...fields.map((f) => f.node),
      button("Edit on the timeline", () => hooks.editCaption(i), {
        class: "btn sm ghost",
      }),
    ];
  }

  function captionMode(i: number): Field {
    const name = nextId("capmode");
    const custom = h("input", {
      type: "text",
      class: "caption-custom",
      placeholder: "Text to show instead",
      attrs: { "aria-label": "Caption to show instead" },
    });
    const radio = (value: string, labelText: string) =>
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "radio",
          name,
          value,
          on: {
            change: () =>
              edit((c) => {
                const line = c.narration[i];
                if (!line) {
                  return;
                }
                const { caption: _drop, ...rest } = line;
                c.narration[i] =
                  value === "spoken"
                    ? rest
                    : { ...rest, caption: captionFor(value, line) };
              }),
          },
        }),
        h("span", { text: labelText })
      );
    const radios = [
      radio("spoken", "The spoken text"),
      radio("custom", "Other text"),
      radio("none", "No caption"),
    ];
    custom.addEventListener("focus", () => state.begin());
    custom.addEventListener("blur", () => state.end());
    custom.addEventListener("input", () =>
      edit((c) => {
        const line = c.narration[i];
        if (line) {
          line.caption = custom.value;
        }
      })
    );
    const node = h(
      "fieldset",
      { class: "field radios" },
      h("legend", { text: "Caption while it speaks" }),
      ...radios,
      custom
    );
    return {
      node,
      update() {
        const line = state.cut.narration[i];
        const mode = modeOf(line?.caption);
        for (const r of node.querySelectorAll<HTMLInputElement>(
          "input[type=radio]"
        )) {
          r.checked = r.value === mode;
        }
        custom.hidden = mode !== "custom";
        if (document.activeElement !== custom) {
          custom.value = line?.caption ?? "";
        }
      },
    };
  }

  // A narration line's recording: what it is, Play, and the ways to replace
  // or drop it — Record (from the microphone), a file, or text to speech. A
  // file that is gone (deleted after a save, then brought back by an undo)
  // says so and offers the same ways back.
  function audioBlock(i: number): HTMLElement {
    const line = state.cut.narration[i];
    const audio = line?.audio;
    const block = h("div", {
      class: "field audio",
      attrs: { role: "group", "aria-label": "Recording" },
    });
    const controls = recordingControls(i, Boolean(audio));
    fields.push({ node: block, update: () => controls.update() });
    if (!audio) {
      block.append(
        h("p", {
          class: "note",
          text: "To use your own voice instead, record it from your microphone or attach a recording.",
        }),
        h("div", { class: "audio-actions" }, ...controls.buttons),
        controls.message
      );
      return block;
    }
    const removeButton = button(
      "Remove recording",
      () =>
        edit((c) => {
          const l = c.narration[i];
          if (l) {
            const { audio: _drop, ...rest } = l;
            c.narration[i] = rest;
          }
        }),
      {
        class: "btn sm ghost",
        title: "Voice this line with text to speech instead",
      }
    );
    const gone = recordingGone(audio);
    if (gone) {
      block.classList.add("gone");
      block.append(
        h("p", { class: "audio-file" }, h("code", { text: audio }), " · gone"),
        h("p", {
          class: "mic-problem",
          attrs: { role: "status" },
          text:
            gone === "deleted"
              ? "This recording was deleted as unused after a save. Record the line again, replace it from a file, or remove it."
              : "This recording isn't in the session's recordings/ folder, or can't be read. Record the line again, replace it from a file, or remove it.",
        }),
        h("div", { class: "audio-actions" }, ...controls.buttons, removeButton),
        controls.message
      );
      return block;
    }
    const recording = ctx.session.recordings.find((r) => r.file === audio);
    const player = h("audio", { src: `/${audio}`, preload: "none" });
    const play = button(
      "Play",
      () => {
        if (player.paused) {
          player.currentTime = 0;
          player
            .play()
            .catch(() => ctx.status(`Couldn't play ${audio}`, "error"));
        } else {
          player.pause();
        }
      },
      { class: "btn sm", icon: "play" }
    );
    const sync = () => {
      const playing = !player.paused;
      setIcon(play, playing ? "stop" : "play");
      const text = play.querySelector("span");
      if (text) {
        text.textContent = playing ? "Stop" : "Play";
      }
    };
    player.addEventListener("play", sync);
    player.addEventListener("pause", sync);
    player.addEventListener("ended", sync);
    block.append(
      h(
        "p",
        { class: "audio-file" },
        h("code", { text: audio }),
        recording ? ` · ${span(recording.durationSec)}` : " · length unknown"
      ),
      player,
      h(
        "div",
        { class: "audio-actions" },
        play,
        ...controls.buttons,
        removeButton
      ),
      controls.message
    );
    return block;
  }

  function lineFields(i: number): HTMLElement[] {
    const get = () => state.cut.narration[i];
    const text = textField(
      "Spoken text",
      () => get()?.text,
      (v) =>
        edit((c) => {
          const line = c.narration[i];
          if (line) {
            line.text = v;
          }
        }),
      {
        placeholder: get()?.audio ? RECORDED_PLACEHOLDER : "What the line says",
        rows: 3,
      }
    );
    mainText = text.input;
    const duration = note(() => {
      const d = ctx.analysis.durations[i];
      if (!d) {
        return "";
      }
      const from = {
        recording: "the recording's length",
        voiced: "its voiced clip's length",
        render: "as voiced in the last render",
        estimate: "estimated from its words",
      }[d.source];
      const placed = ctx.analysis.placed.some((p) => p.index === i);
      return `Speaks for ${span(d.sec)} — ${from}.${placed ? "" : " It is inside cut footage, so the render drops it."}`;
    });
    const mode = captionMode(i);
    fields = [
      timeField(
        "At",
        () => get()?.at,
        (t) =>
          edit((c) => {
            const line = c.narration[i];
            if (line) {
              line.at = t;
            }
          })
      ),
      text,
      duration,
      mode,
    ];
    const nodes = fields.map((f) => f.node);
    // A text-to-speech line can be voiced now, ahead of a render.
    const tts = get()?.audio === undefined ? voiceLineControls(i) : undefined;
    if (tts) {
      fields.push(tts);
    }
    return [
      header(
        "Narration line",
        { kind: "line", index: i },
        state.cut.narration.length,
        () => get()?.at ?? 0
      ),
      ...nodes,
      tts?.node ?? null,
      audioBlock(i),
    ].filter((n): n is HTMLElement => n !== null);
  }

  function cutFields(i: number): HTMLElement[] {
    const get = () => state.cut.cuts[i];
    fields = [
      timeField(
        "Start",
        () => get()?.start,
        (t) =>
          edit((c) => {
            const r = c.cuts[i];
            if (r) {
              r.start = t;
            }
          }),
        startBefore(() => get()?.end)
      ),
      timeField(
        "End",
        () => get()?.end,
        (t) =>
          edit((c) => {
            const r = c.cuts[i];
            if (r) {
              r.end = t;
            }
          }),
        endAfter(() => get()?.start)
      ),
      note(() => {
        const r = get();
        return r
          ? `Removes ${span(r.end - r.start)} of footage. Captions, lines and holds inside it are dropped.`
          : "";
      }),
    ];
    return [
      header(
        "Cut",
        { kind: "cut", index: i },
        state.cut.cuts.length,
        () => get()?.start ?? 0
      ),
      ...fields.map((f) => f.node),
    ];
  }

  function rateField(i: number): Field {
    const id = nextId("rate");
    const select = h(
      "select",
      { id },
      ...Array.from({ length: MAX_SPEEDUP_RATE - 1 }, (_, k) =>
        h("option", { value: String(k + 2), text: `${k + 2}×` })
      )
    );
    select.addEventListener("change", () =>
      edit((c) => {
        const v = c.speedups[i];
        if (v) {
          v.rate = Number(select.value);
        }
      })
    );
    return {
      node: h(
        "div",
        { class: "field" },
        h("label", { htmlFor: id, text: "Rate" }),
        select
      ),
      update() {
        select.value = String(state.cut.speedups[i]?.rate ?? 2);
      },
    };
  }

  function speedupFields(i: number): HTMLElement[] {
    const get = () => state.cut.speedups[i];
    fields = [
      timeField(
        "Start",
        () => get()?.start,
        (t) =>
          edit((c) => {
            const v = c.speedups[i];
            if (v) {
              v.start = t;
            }
          }),
        startBefore(() => get()?.end)
      ),
      timeField(
        "End",
        () => get()?.end,
        (t) =>
          edit((c) => {
            const v = c.speedups[i];
            if (v) {
              v.end = t;
            }
          }),
        endAfter(() => get()?.start)
      ),
      rateField(i),
      note(() => {
        const v = get();
        if (!v) {
          return "";
        }
        const frames =
          Math.round(v.end * grid.fps) - Math.round(v.start * grid.fps);
        return `Plays ${span(v.end - v.start)} of footage in ${span(Math.ceil(frames / v.rate) / grid.fps)}. Captions over it stay up for their full length.`;
      }),
    ];
    return [
      header(
        "Speed-up",
        { kind: "speedup", index: i },
        state.cut.speedups.length,
        () => get()?.start ?? 0
      ),
      ...fields.map((f) => f.node),
    ];
  }

  function holdSeconds(i: number): Field {
    const id = nextId("hold");
    const input = h("input", {
      id,
      type: "number",
      min: String(frame),
      step: "0.1",
      class: "num-input",
    });
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (Number.isFinite(value) && value > 0) {
        edit((c) => {
          const hold = c.holds[i];
          if (hold) {
            hold.seconds = Math.max(
              frame,
              Math.round(value * grid.fps) / grid.fps
            );
          }
        });
      }
    });
    return {
      node: h(
        "div",
        { class: "field" },
        h("label", { htmlFor: id, text: "Seconds" }),
        input
      ),
      update() {
        if (document.activeElement !== input) {
          input.value = seconds(state.cut.holds[i]?.seconds ?? 0);
        }
      },
    };
  }

  function holdFields(i: number): HTMLElement[] {
    const get = () => state.cut.holds[i];
    fields = [
      timeField(
        "At",
        () => get()?.at,
        (t) =>
          edit((c) => {
            const hold = c.holds[i];
            if (hold) {
              hold.at = t;
            }
          })
      ),
      holdSeconds(i),
      note(
        () =>
          "Freezes this frame; everything after it plays later. Holds on the same frame add up."
      ),
    ];
    return [
      header(
        "Hold",
        { kind: "hold", index: i },
        state.cut.holds.length,
        () => get()?.at ?? 0
      ),
      ...fields.map((f) => f.node),
    ];
  }

  function shapeOf(sel: Selection | undefined): string {
    if (!sel) {
      return "";
    }
    const line =
      sel.kind === "line" ? state.cut.narration[sel.index] : undefined;
    const audio = line?.audio ?? "";
    const gone = audio ? (recordingGone(audio) ?? "") : "";
    return `${sel.kind}:${sel.index}:${audio}:${gone}`;
  }

  function buildSelected(): void {
    const sel = state.selection;
    fields = [];
    mainText = undefined;
    if (!sel) {
      selected.replaceChildren(
        h("h2", { id: "selected-title", text: "Selection" }),
        h("p", {
          class: "note",
          text: "Click an item on the timeline to edit it, or add one below.",
        })
      );
      return;
    }
    const build = {
      caption: captionFields,
      line: lineFields,
      cut: cutFields,
      speedup: speedupFields,
      hold: holdFields,
    }[sel.kind];
    selected.replaceChildren(...build(sel.index));
  }

  // ----- add -----

  const addNote = h("p", { class: "note", id: "add-note" });
  const addCut = button("Cut", () => addRange("cut"), { class: "btn" });
  const addSpeedup = button(
    `Speed up ${DEFAULT_RATE}×`,
    () => addRange("speedup"),
    { class: "btn" }
  );
  addCut.setAttribute("aria-describedby", "add-note");
  addSpeedup.setAttribute("aria-describedby", "add-note");

  function addCaption(): void {
    const end = endOf(grid);
    let start = snapTime(ctx.playhead(), grid);
    if (start > end - frame) {
      start = Math.max(0, snapTime(end - DEFAULT_CAPTION_SEC, grid));
    }
    const stop = snapTime(Math.min(start + DEFAULT_CAPTION_SEC, end), grid);
    state.edit((cut) => {
      cut.captions.push({ start, end: stop, text: "" });
      return { kind: "caption", index: cut.captions.length - 1 };
    });
    hooks.editCaption(state.cut.captions.length - 1);
  }

  function addLine(): void {
    state.edit((cut) => {
      cut.narration.push({ at: snapTime(ctx.playhead(), grid), text: "" });
      return { kind: "line", index: cut.narration.length - 1 };
    });
    api.focusText();
    ctx.status("Type what the line says — or attach a recording");
  }

  function addHold(): void {
    state.edit((cut) => {
      cut.holds.push({
        at: snapTime(ctx.playhead(), grid),
        seconds: DEFAULT_HOLD_SEC,
      });
      return { kind: "hold", index: cut.holds.length - 1 };
    });
  }

  function addRange(kind: "cut" | "speedup"): void {
    const { in: start, out: end } = state.marks;
    if (start === undefined || end === undefined || end <= start) {
      ctx.status("Set an in point and an out point first (I and O)", "error");
      return;
    }
    if (kind === "cut") {
      state.edit((cut) => {
        cut.cuts.push({ start, end });
        return { kind: "cut", index: cut.cuts.length - 1 };
      });
      return;
    }
    const clash = state.cut.speedups.find(
      (v) => v.start < end && v.end > start
    );
    if (clash) {
      ctx.status(
        `That range overlaps the ${clash.rate}× speed-up at ${clock(clash.start)} — speed-ups can't overlap, so change that one instead`,
        "error"
      );
      return;
    }
    state.edit((cut) => {
      const at = cut.speedups.findIndex((v) => v.start > start);
      const index = at === -1 ? cut.speedups.length : at;
      cut.speedups.splice(index, 0, { start, end, rate: DEFAULT_RATE });
      return { kind: "speedup", index };
    });
  }

  const recordNew = recordButton(undefined, false);
  const add = h(
    "section",
    { class: "panel add", attrs: { "aria-labelledby": "add-title" } },
    h("h2", { id: "add-title", text: "Add" }),
    h("p", { class: "sub", text: "At the playhead" }),
    h(
      "div",
      { class: "button-row" },
      button("Caption", addCaption, {
        class: "btn",
        icon: "plus",
        title: `A ${DEFAULT_CAPTION_SEC}s caption`,
      }),
      button("Narration line", addLine, { class: "btn", icon: "plus" }),
      button("Hold", addHold, {
        class: "btn",
        icon: "plus",
        title: `Freeze the frame for ${DEFAULT_HOLD_SEC}s`,
      })
    ),
    h("div", { class: "button-row" }, recordNew.button),
    recordNew.message,
    h("p", { class: "sub", text: "From the in point to the out point" }),
    h("div", { class: "button-row" }, addCut, addSpeedup),
    addNote
  );

  function drawAdd(): void {
    recordNew.update();
    const { in: start, out: end } = state.marks;
    const ready = start !== undefined && end !== undefined && end > start;
    addCut.disabled = !ready;
    addSpeedup.disabled = !ready;
    addNote.textContent = ready
      ? `In ${clock(start)} → out ${clock(end)}, ${span(end - start)}.`
      : "Set in and out points (I and O) to add a cut or a speed-up.";
  }

  // ----- recordings no line uses -----

  const unusedList = h("ul", { class: "unused-list" });
  const unused = h(
    "div",
    { class: "unused", hidden: true },
    h("h3", { id: "unused-title", text: "Unused recordings" }),
    h("p", {
      class: "note",
      text: "In the session's recordings/ folder, on no line. Delete the ones you don't need.",
    }),
    unusedList
  );
  unusedList.setAttribute("aria-labelledby", "unused-title");
  const listen = new Audio();
  let listening: string | undefined;

  function drawListen(): void {
    for (const row of unusedList.children) {
      const file = (row as HTMLElement).dataset.file;
      const play = row.querySelector<HTMLElement>(".unused-play");
      if (!play) {
        continue;
      }
      const on = file === listening && !listen.paused;
      setIcon(play, on ? "stop" : "play");
      const text = play.querySelector("span");
      if (text) {
        text.textContent = on ? "Stop" : "Play";
      }
    }
  }
  listen.addEventListener("play", drawListen);
  listen.addEventListener("pause", drawListen);
  listen.addEventListener("ended", drawListen);

  function playUnused(file: string): void {
    if (listening === file && !listen.paused) {
      listen.pause();
      return;
    }
    listening = file;
    listen.src = `/${file}`;
    listen.currentTime = 0;
    listen.play().catch(() => ctx.status(`Couldn't play ${file}`, "error"));
  }

  async function deleteUnused(file: string): Promise<void> {
    if (listening === file) {
      listen.pause();
    }
    try {
      await deleteRecording(file);
      ctx.status(`Deleted ${file}`);
      ctx.refresh();
    } catch (err) {
      ctx.status(
        `Couldn't delete ${file}: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  }

  function drawUnused(): void {
    const files = unusedRecordings(state.cut);
    unused.hidden = files.length === 0;
    keyed(
      unusedList,
      files.map((r) => r.file),
      (file) => {
        const id = nextId("unused");
        const named = (node: HTMLElement) => {
          node.setAttribute("aria-describedby", id);
          return node;
        };
        return h(
          "li",
          { class: "unused-row", attrs: { "data-file": file } },
          h("code", { id, class: "unused-name", text: file.split("/").pop() }),
          h("span", { class: "unused-length" }),
          named(
            button("Play", () => playUnused(file), {
              class: "btn sm unused-play",
              icon: "play",
              title: `Listen to ${file}`,
            })
          ),
          named(
            button("Delete", () => void deleteUnused(file), {
              class: "btn sm ghost unused-delete",
              icon: "trash",
              title: `Delete ${file} from the session`,
            })
          )
        );
      },
      (row, file) => {
        const length = row.querySelector(".unused-length");
        const found = files.find((r) => r.file === file);
        if (length && found) {
          length.textContent = span(found.durationSec);
        }
      }
    );
    drawListen();
  }

  // ----- voice -----

  const narratorId = nextId("narrator");
  const nameId = nextId("voice-name");
  const speedId = nextId("speed");
  const narrator = h(
    "select",
    { id: narratorId },
    h("option", { value: "", text: "Automatic" }),
    ...ctx.session.narrators.map((n) => h("option", { value: n, text: n }))
  );
  const voiceName = h("input", {
    id: nameId,
    type: "text",
    placeholder: "Its default voice",
    attrs: { autocomplete: "off", "aria-describedby": `${nameId}-note` },
  });
  const nameNote = h("p", { id: `${nameId}-note`, class: "note" });
  const speed = h("input", {
    id: speedId,
    type: "range",
    min: "0.5",
    max: "2",
    step: "0.05",
  });
  const speedValue = h("output", {
    class: "speed-value",
    attrs: { for: speedId },
  });
  narrator.addEventListener("change", () =>
    edit((cut) => {
      const value = narrator.value || undefined;
      cut.voice = patchVoice(cut.voice, {
        narrator: value as CutVoice["narrator"],
        ...(value ? {} : { name: undefined }),
      });
    })
  );
  voiceName.addEventListener("focus", () => state.begin());
  voiceName.addEventListener("blur", () => state.end());
  voiceName.addEventListener("input", () =>
    edit((cut) => {
      cut.voice = patchVoice(cut.voice, { name: voiceName.value || undefined });
    })
  );
  speed.addEventListener("pointerdown", () => state.begin());
  speed.addEventListener("input", () =>
    edit((cut) => {
      cut.voice = patchVoice(cut.voice, { speed: Number(speed.value) });
    })
  );
  speed.addEventListener("change", () => state.end());
  const voiceAll = voiceAllControls();

  const voice = h(
    "section",
    { class: "panel voice", attrs: { "aria-labelledby": "voice-title" } },
    h("h2", { id: "voice-title", text: "Voice" }),
    h("p", {
      class: "sub",
      text: "Who reads the text-to-speech lines. Left automatic, the first render picks one and keeps it.",
    }),
    h(
      "div",
      { class: "field" },
      h("label", { htmlFor: narratorId, text: "Narrator" }),
      narrator
    ),
    h(
      "div",
      { class: "field" },
      h("label", { htmlFor: nameId, text: "Voice name" }),
      voiceName,
      nameNote
    ),
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "label-row" },
        h("label", { htmlFor: speedId, text: "Speed" }),
        speedValue
      ),
      h(
        "div",
        { class: "speed-row" },
        speed,
        button(
          "Reset",
          () =>
            edit((cut) => {
              cut.voice = patchVoice(cut.voice, { speed: undefined });
            }),
          { class: "btn sm ghost", title: "Speak at the normal pace" }
        )
      )
    ),
    voiceAll.node,
    unused
  );

  function drawVoice(): void {
    const v = state.cut.voice;
    narrator.value = v.narrator ?? "";
    voiceName.disabled = !v.narrator;
    if (document.activeElement !== voiceName) {
      voiceName.value = v.name ?? "";
    }
    nameNote.textContent = v.narrator
      ? ""
      : "Pick a narrator first — a voice name belongs to one.";
    nameNote.hidden = Boolean(v.narrator);
    if (document.activeElement !== speed) {
      speed.value = String(v.speed ?? 1);
    }
    speedValue.textContent =
      v.speed === undefined ? "Normal" : `${v.speed.toFixed(2)}×`;
    voiceAll.update();
  }

  // ----- render -----

  const renderState = h("span", { class: "badge sm" });
  const renderBody = h("div", { class: "render-body" });
  const render = h(
    "section",
    { class: "panel render", attrs: { "aria-labelledby": "render-title" } },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { id: "render-title", text: "Render" }),
      renderState
    ),
    renderBody
  );

  function list(
    items: string[],
    className: string,
    prefix = ""
  ): HTMLElement | null {
    if (items.length === 0) {
      return null;
    }
    return h(
      "ul",
      { class: className },
      ...items.map((t) =>
        h("li", {}, prefix ? h("strong", { text: prefix }) : null, t)
      )
    );
  }

  // ----- keys -----

  const keys = h(
    "details",
    { class: "panel keys" },
    h("summary", { text: "Keyboard shortcuts" }),
    h(
      "dl",
      {},
      ...[
        ["Space", "Play / pause"],
        ["← →", "One frame (Shift: one second)"],
        ["Home End", "Start / end"],
        ["I O", "In / out point"],
        [
          "R",
          "Record narration — the selected line, else a new one at the playhead; again to stop",
        ],
        ["Esc", "While recording: cancel, keeping nothing"],
        ["Delete", "Delete the selection"],
        ["Esc", "Clear the selection, then the in/out points"],
        ["Ctrl/⌘ S", "Save"],
        ["Ctrl/⌘ Z", "Undo (Shift: redo)"],
        ["Tab", "Into a timeline track, then ↑ ↓ between its items"],
        ["On an item: ← →", "Move it a frame (Shift: a second; Alt: its end)"],
        ["On a caption: F2", "Edit its text"],
      ].flatMap(([k, v]) => [
        h("dt", {}, h("kbd", { text: k ?? "" })),
        h("dd", { text: v ?? "" }),
      ])
    )
  );

  const element = h(
    "aside",
    { class: "inspector", attrs: { "aria-label": "Inspector" } },
    selected,
    add,
    voice,
    render,
    keys
  );

  const api: Inspector = {
    element,
    focusText() {
      api.refresh();
      mainText?.focus();
    },
    refresh() {
      const next = shapeOf(state.selection);
      if (next !== shape) {
        const reselected =
          next.split(":").slice(0, 2).join(":") !==
          shape.split(":").slice(0, 2).join(":");
        shape = next;
        buildSelected();
        if (reselected && state.selection) {
          // The selected item's fields are at the top; bring them into view.
          element.scrollTop = 0;
        }
      }
      for (const f of fields) {
        f.update();
      }
      drawAdd();
      drawVoice();
      drawUnused();
    },
    showRender(status) {
      const label = {
        idle: "Not run yet",
        running: "Running",
        done: "Done",
        error: "Failed",
      }[status.state];
      renderState.textContent = label;
      renderState.className = `badge sm ${status.state}`;
      const result = status.result;
      const log =
        status.state === "running" ? status.progress.slice(-LOG_LINES) : [];
      renderBody.replaceChildren(
        ...[
          status.error
            ? h(
                "p",
                { class: "error-text" },
                h("strong", { text: "Error: " }),
                status.error
              )
            : null,
          list(log, "log"),
          result
            ? h("p", {
                class: "note",
                text: `Last render: ${clock(result.durationSec)} of video from ${clock(result.sourceDurationSec)} of footage.`,
              })
            : h("p", {
                class: "note",
                text: "Render to check the real output; the preview shows the edits without it.",
              }),
          list(result?.notes ?? [], "notes"),
          list(result?.warnings ?? [], "warnings", "Warning: "),
        ].filter((n): n is HTMLElement => n !== null)
      );
    },
  };
  buildSelected();
  api.refresh();
  return api;
}
