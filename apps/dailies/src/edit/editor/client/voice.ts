// Voicing text-to-speech lines ahead of a render: "Voice this line" in a
// line's inspector, "Voice all unvoiced lines" in the Voice panel, and the QA
// handle's voiceLine. The server voices a line of the cut ON DISK into the
// render's own clip cache (POST /api/voice, render.ts voiceCutLines), so a
// cut with unsaved edits is saved first, as Render does. The preview then
// plays the clip where the line is placed, at its real length, and the next
// render finds it in the cache.
//
// ctx.voiced is every clip the page knows of: seeded from the session's
// `voiced` list (the lines whose clip is cached under the cut's pinned voice,
// so lengths survive a restart), added to after each voicing, and replaced
// after a render, which prunes the cache to the cut's own lines. A change to
// a line removes nothing: preview.ts voicedClip matches a clip to a line by
// its exact words and the cut's voice, so editing the text — or the
// narrator, the voice name or the speed — puts the line back to an estimate,
// and undoing the change brings the clip back.
//
// The first voicing can pin a narrator into cut.json, as the first render
// does. The page takes cut.json back after every voicing the way it does
// after a render (state.ts load/setDisk with `rendered`), so an undo can't
// drop the pin. One line is voiced at a time — the server refuses a second
// one, a render and a save while it runs — and "Voice all" voices the lines
// in turn.

import type { Cut, CutLine } from "../../cut.js";
import type {
  EditorSession,
  EditorVoicedLine,
  VoiceLineResponse,
} from "../contract.js";
import { ApiError, api } from "./api.js";
import type { EditorContext } from "./context.js";
import { button, h, keyed, setIcon } from "./dom.js";
import { clock, span } from "./format.js";
import {
  clipVoice,
  sameClipVoice,
  type VoicedClip,
  voicedClip,
} from "./preview.js";
import { findLine } from "./recorder.js";

// ---------------------------------------------------------------------------
// Pure helpers. Exported for tests.
// ---------------------------------------------------------------------------

// The clips GET /api/session lists, keyed the way voicedClip looks them up:
// the words of the line at each index of the cut on disk, in that cut's voice.
export function seedVoiced(
  cut: Cut,
  voiced: readonly EditorVoicedLine[]
): VoicedClip[] {
  const voice = clipVoice(cut.voice);
  return voiced.flatMap((v) => {
    const line = cut.narration[v.index];
    return line && line.audio === undefined
      ? [{ text: line.text, voice, file: v.file, durationSec: v.durationSec }]
      : [];
  });
}

// The clip POST /api/voice made, keyed by what it answered.
export function answeredClip(answer: VoiceLineResponse): VoicedClip {
  return {
    text: answer.text,
    voice: clipVoice(answer.voice),
    file: answer.file,
    durationSec: answer.durationSec,
  };
}

// `clips` with `more` added. A clip for the same words in the same voice is
// the same cached file, so the newer one takes the older one's place.
export function mergeVoiced(
  clips: readonly VoicedClip[],
  more: readonly VoicedClip[]
): VoicedClip[] {
  const out = [...clips];
  for (const clip of more) {
    const at = out.findIndex(
      (c) => c.text === clip.text && sameClipVoice(c.voice, clip.voice)
    );
    if (at >= 0) {
      out[at] = clip;
    } else {
      out.push(clip);
    }
  }
  return out;
}

// The text-to-speech lines with words to say and no clip for them in the
// cut's voice — what "Voice all unvoiced lines" voices — in cut order.
export function unvoicedLines(
  cut: Cut,
  clips: readonly VoicedClip[]
): number[] {
  return cut.narration.flatMap((line, i) =>
    line.audio === undefined &&
    line.text.trim() &&
    !voicedClip(line, cut.voice, clips)
      ? [i]
      : []
  );
}

// An answer from POST /api/voice that would come back the same for the next
// line, so "Voice all" stops: the server gone (0), a render running (409),
// no narrator (503). A 400 or a 500 is about that one line.
export function stopsTheRest(status: number): boolean {
  return status === 0 || status === 409 || status === 503;
}

// ---------------------------------------------------------------------------
// One voicing at a time.
// ---------------------------------------------------------------------------

export type VoicePhase = "idle" | "voicing" | "voiced" | "failed";

// A text-to-speech line's voicing, as its inspector shows it.
export interface LineVoice {
  // The clip it plays, when voiced.
  clip?: VoicedClip;
  // Why the last try failed (the server's message), when failed.
  message?: string;
  phase: VoicePhase;
}

// Why a line wasn't voiced.
export interface VoiceFailure {
  error: string;
  // The server's status, when it answered.
  status?: number;
  // The next line would fail the same way, so "Voice all" stops.
  stops?: boolean;
}

export type VoiceOutcome = VoiceLineResponse | VoiceFailure;

// A line in a "Voice all" run, and how it went.
export interface VoiceRow {
  at: number;
  durationSec?: number;
  line: CutLine;
  message?: string;
  state: "waiting" | "voicing" | "voiced" | "failed" | "skipped";
  text: string;
}

export type VoiceContext = Pick<
  EditorContext,
  "refresh" | "state" | "status" | "voiced"
>;

export interface VoiceApi {
  session(): Promise<EditorSession>;
  voiceLine(index: number): Promise<VoiceLineResponse>;
}

export interface VoiceHooks {
  // Why nothing can be voiced now (a render is running), else undefined.
  blocked(): string | undefined;
  // The voicing state changed: redraw.
  changed(): void;
  // Take the session back after a voicing: cut.json may hold a voice the
  // voicing pinned.
  reload(fresh: EditorSession): void;
  // Save the cut's unsaved edits. False when they weren't saved (the save
  // says why in the status line).
  save(): Promise<boolean>;
}

// Saves to try before giving up on a cut edited while each one was in flight.
const SAVE_TRIES = 3;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Voicer {
  // The last "Voice all" run's lines, in order, while it runs and after.
  batch: VoiceRow[] = [];
  batchRunning = false;
  // The line being voiced: saved first, then voiced by the server.
  current: CutLine | undefined;
  // The server is voicing it now, so cut.json can't be saved.
  posting = false;

  // The last failure for a line's words.
  private readonly failures = new Map<string, string>();
  private readonly ctx: VoiceContext;
  private readonly hooks: VoiceHooks;
  private readonly server: VoiceApi;

  constructor(ctx: VoiceContext, hooks: VoiceHooks, server: VoiceApi = api) {
    this.ctx = ctx;
    this.hooks = hooks;
    this.server = server;
  }

  get busy(): boolean {
    return this.current !== undefined || this.batchRunning;
  }

  // Text-to-speech lines with words, and how many of them have no clip.
  counts(): { spoken: number; unvoiced: number } {
    const { cut } = this.ctx.state;
    return {
      spoken: cut.narration.filter(
        (l) => l.audio === undefined && l.text.trim()
      ).length,
      unvoiced: unvoicedLines(cut, this.ctx.voiced).length,
    };
  }

  // Why line `index` can't be voiced now, or undefined when it can.
  refusal(index: number): string | undefined {
    const line = this.ctx.state.cut.narration[index];
    if (!line) {
      return `There's no narration line ${index}`;
    }
    if (line.audio !== undefined) {
      return "This line is recorded — only a text-to-speech line is voiced";
    }
    if (!line.text.trim()) {
      return "Type what the line says first";
    }
    if (this.busy) {
      return "Another line is being voiced — one at a time";
    }
    return this.hooks.blocked();
  }

  // Why "Voice all" can't start now, or undefined when it can.
  refusalForAll(): string | undefined {
    return this.busy
      ? "Another line is being voiced — one at a time"
      : this.hooks.blocked();
  }

  phaseOf(index: number): LineVoice {
    const { cut } = this.ctx.state;
    const line = cut.narration[index];
    if (!line || line.audio !== undefined) {
      return { phase: "idle" };
    }
    if (this.current && findLine(cut.narration, this.current) === index) {
      return { phase: "voicing" };
    }
    const clip = voicedClip(line, cut.voice, this.ctx.voiced);
    if (clip) {
      return { phase: "voiced", clip };
    }
    const message = this.failures.get(line.text);
    return message === undefined
      ? { phase: "idle" }
      : { phase: "failed", message };
  }

  // Voice line `index`: save the cut if it has unsaved edits, then have the
  // server voice the line from cut.json.
  async voice(index: number): Promise<VoiceOutcome> {
    const refused = this.refusal(index);
    if (refused) {
      return { error: refused };
    }
    const outcome = await this.run(index);
    if ("error" in outcome) {
      this.ctx.status(`Not voiced: ${outcome.error}`, "error");
    } else {
      this.ctx.status(
        `Voiced the line — it speaks for ${span(outcome.durationSec)}`
      );
    }
    return outcome;
  }

  // Voice every unvoiced text-to-speech line, one after another. A failure
  // that would fail every line the same way stops the run.
  async voiceAll(): Promise<void> {
    if (this.busy || this.hooks.blocked()) {
      return;
    }
    const { state } = this.ctx;
    this.batch = unvoicedLines(state.cut, this.ctx.voiced).map((i) => {
      const line = state.cut.narration[i] as CutLine;
      return { line, at: line.at, text: line.text, state: "waiting" };
    });
    if (this.batch.length === 0) {
      return;
    }
    this.batchRunning = true;
    this.hooks.changed();
    let stop: string | undefined;
    try {
      for (const row of this.batch) {
        if (stop === undefined) {
          stop = await this.voiceRow(row);
        } else {
          row.state = "skipped";
          row.message = "not tried — the run stopped";
        }
        this.hooks.changed();
      }
    } finally {
      this.batchRunning = false;
      this.hooks.changed();
    }
    const done = this.batch.filter((r) => r.state === "voiced").length;
    const total = this.batch.length;
    if (done === total) {
      this.ctx.status(`Voiced ${total === 1 ? "the line" : `all ${total}`}`);
    } else {
      this.ctx.status(
        `Voiced ${done} of ${total}${stop ? ` — stopped: ${stop}` : ""}`,
        "error"
      );
    }
  }

  // One line of a "Voice all" run. Returns why the run stops, if it does.
  private async voiceRow(row: VoiceRow): Promise<string | undefined> {
    const { state } = this.ctx;
    const index = findLine(state.cut.narration, row.line);
    const line = index === undefined ? undefined : state.cut.narration[index];
    if (index === undefined || !line) {
      row.state = "skipped";
      row.message = "the line was deleted";
      return;
    }
    if (line.audio !== undefined || !line.text.trim()) {
      row.state = "skipped";
      row.message = line.audio ? "it has a recording now" : "it has no words";
      return;
    }
    // An earlier line with the same words made this one's clip too.
    const made = voicedClip(line, state.cut.voice, this.ctx.voiced);
    if (made) {
      row.state = "voiced";
      row.durationSec = made.durationSec;
      return;
    }
    row.state = "voicing";
    this.hooks.changed();
    const outcome = await this.run(index);
    if ("error" in outcome) {
      row.state = "failed";
      row.message = outcome.error;
      return outcome.stops ? outcome.error : undefined;
    }
    row.state = "voiced";
    row.durationSec = outcome.durationSec;
    return;
  }

  private async run(index: number): Promise<VoiceOutcome> {
    const line = this.ctx.state.cut.narration[index] as CutLine;
    const text = line.text;
    this.current = line;
    this.failures.delete(text);
    this.hooks.changed();
    try {
      const outcome = await this.voiceSaved(line);
      if ("error" in outcome) {
        this.failures.set(text, outcome.error);
      }
      return outcome;
    } finally {
      this.current = undefined;
      this.posting = false;
      // Durations come from ctx.voiced: recompute and redraw.
      this.ctx.refresh();
      this.hooks.changed();
    }
  }

  private async voiceSaved(line: CutLine): Promise<VoiceOutcome> {
    const index = await this.saved(line);
    if (typeof index !== "number") {
      return index;
    }
    this.posting = true;
    this.hooks.changed();
    let answer: VoiceLineResponse;
    try {
      answer = await this.server.voiceLine(index);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      return {
        error: errorText(err),
        ...(status === undefined
          ? {}
          : { status, stops: stopsTheRest(status) }),
      };
    } finally {
      this.posting = false;
    }
    this.ctx.voiced = mergeVoiced(this.ctx.voiced, [answeredClip(answer)]);
    try {
      const fresh = await this.server.session();
      this.hooks.reload(fresh);
      this.ctx.voiced = mergeVoiced(
        this.ctx.voiced,
        seedVoiced(fresh.cut, fresh.voiced)
      );
    } catch (err) {
      this.ctx.status(
        `The line is voiced, but cut.json couldn't be read back (${errorText(err)}) — reload the page before saving, or the voice it pinned is lost`,
        "error"
      );
    }
    return answer;
  }

  // Save until cut.json holds the line, and say where it is there. A save
  // that nothing raced takes the server's normalized cut — new objects, times
  // to the millisecond, in the same order — so the line is then the one at
  // the same place; an edit made while a save was in flight keeps the cut's
  // objects and leaves it unsaved, so it saves again.
  private async saved(line: CutLine): Promise<number | VoiceFailure> {
    const { state } = this.ctx;
    let target = line;
    for (let tries = 0; ; tries++) {
      const index = findLine(state.cut.narration, target);
      if (index === undefined) {
        return { error: "the line was deleted before it was voiced" };
      }
      if (!state.dirty) {
        return index;
      }
      if (tries === SAVE_TRIES || !(await this.hooks.save())) {
        return {
          error:
            "the cut's unsaved changes weren't saved, and a line is voiced from cut.json",
          stops: true,
        };
      }
      if (!state.cut.narration.includes(target)) {
        target = state.cut.narration[index] ?? target;
        this.current = target;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The editor's voicer, bound to the editor's context once main.ts has one,
// and its views.
// ---------------------------------------------------------------------------

let bound: Voicer | undefined;

export function bindVoicer(ctx: EditorContext, hooks: VoiceHooks): Voicer {
  bound = new Voicer(ctx, hooks);
  return bound;
}

function voicer(): Voicer {
  if (!bound) {
    throw new Error("the voicer isn't bound to the editor yet");
  }
  return bound;
}

// Set a node's text only when it changes, so a screen reader doesn't hear a
// status repeated on every redraw.
function setText(node: Element | null, text: string): void {
  if (node && node.textContent !== text) {
    node.textContent = text;
  }
}

// Point a player at `src` ("" for nothing), stopping what it played.
function setSource(player: HTMLAudioElement, src: string): void {
  if (player.getAttribute("src") === src) {
    return;
  }
  player.pause();
  if (src) {
    player.src = src;
  } else {
    player.removeAttribute("src");
  }
}

const VOICE_TITLE =
  "Make this line's clip now, as the render will, so the preview plays it at its real length";

// A text-to-speech line's voicing in its inspector: not voiced yet, voicing,
// voiced (its length, and Play), or failed (the server's message) — and the
// button that voices it.
export function voiceLineControls(lineIndex: number): {
  node: HTMLElement;
  update(): void;
} {
  const status = h("p", { class: "voice-status", attrs: { role: "status" } });
  const action = button(
    "Voice this line",
    () => void voicer().voice(lineIndex),
    { class: "btn sm voice-btn", icon: "speak", title: VOICE_TITLE }
  );
  const label = action.querySelector("span");
  const player = h("audio", { preload: "none" });
  const play = button(
    "Play",
    () => {
      if (player.paused) {
        player.currentTime = 0;
        player.play().catch(() => undefined);
      } else {
        player.pause();
      }
    },
    { class: "btn sm voice-play", icon: "play" }
  );
  const playing = () => {
    const on = !player.paused;
    setIcon(play, on ? "stop" : "play");
    const text = play.querySelector("span");
    if (text) {
      text.textContent = on ? "Stop" : "Play";
    }
  };
  player.addEventListener("play", playing);
  player.addEventListener("pause", playing);
  player.addEventListener("ended", playing);
  const problem = h("p", {
    class: "mic-problem",
    hidden: true,
    attrs: { role: "alert" },
  });
  const node = h(
    "div",
    {
      class: "field voice-line",
      attrs: { role: "group", "aria-label": "Text to speech" },
    },
    status,
    player,
    h("div", { class: "audio-actions" }, action, play),
    problem
  );
  return {
    node,
    update() {
      const v = voicer();
      const look = v.phaseOf(lineIndex);
      node.dataset.state = look.phase;
      setText(
        status,
        {
          idle: "Not voiced yet, so it's silent in the preview.",
          voicing: v.posting ? "Voicing…" : "Saving the cut, then voicing…",
          voiced: `Voiced · ${span(look.clip?.durationSec ?? 0)} — the preview plays it.`,
          failed: "Not voiced.",
        }[look.phase]
      );
      setText(
        label,
        {
          idle: "Voice this line",
          voicing: "Voicing…",
          voiced: "Voice this line",
          failed: "Try again",
        }[look.phase]
      );
      const voicing = look.phase === "voicing";
      const refused = voicing ? undefined : v.refusal(lineIndex);
      action.hidden = look.phase === "voiced";
      action.disabled = voicing || refused !== undefined;
      action.title = refused ?? VOICE_TITLE;
      action.setAttribute("aria-busy", String(voicing));
      setSource(player, look.clip ? `/${look.clip.file}` : "");
      play.hidden = look.phase !== "voiced";
      problem.hidden = look.message === undefined;
      setText(problem, look.message ?? "");
    },
  };
}

const ALL_TITLE =
  "Voice every text-to-speech line that has no clip yet, one after another";

const ROW_STATE = {
  waiting: "Waiting",
  voicing: "Voicing…",
  voiced: "Voiced",
  failed: "Failed",
  skipped: "Skipped",
} as const;

// "Voice all unvoiced lines" in the Voice panel: how many text-to-speech
// lines are voiced, the button, and the last run's lines with how each went.
export function voiceAllControls(): { node: HTMLElement; update(): void } {
  const summary = h("p", { class: "note" });
  const action = button(
    "Voice all unvoiced lines",
    () => void voicer().voiceAll(),
    { class: "btn sm voice-all-btn", icon: "speak", title: ALL_TITLE }
  );
  const label = action.querySelector("span");
  const list = h("ul", {
    class: "voice-rows",
    attrs: { "aria-labelledby": "voice-all-title" },
  });
  const node = h(
    "div",
    { class: "voice-all" },
    h("h3", { id: "voice-all-title", text: "Text-to-speech lines" }),
    summary,
    h("div", { class: "button-row" }, action),
    list
  );
  return {
    node,
    update() {
      const v = voicer();
      const { spoken, unvoiced } = v.counts();
      node.hidden = spoken === 0 && v.batch.length === 0;
      summary.textContent =
        unvoiced === 0
          ? `All ${spoken} voiced — the preview plays them at their real length.`
          : `${spoken - unvoiced} of ${spoken} voiced. The rest are silent in the preview, their length estimated.`;
      setText(label, v.batchRunning ? "Voicing…" : "Voice all unvoiced lines");
      const blocked = v.refusalForAll();
      action.disabled = unvoiced === 0 || blocked !== undefined;
      action.title = blocked ?? ALL_TITLE;
      action.setAttribute("aria-busy", String(v.batchRunning));
      keyed(
        list,
        v.batch.map((_, i) => `row:${i}`),
        () =>
          h(
            "li",
            { class: "voice-row" },
            h("span", { class: "voice-row-at" }),
            h("span", { class: "voice-row-text" }),
            h("span", { class: "voice-row-state" }),
            h("p", { class: "voice-row-problem" })
          ),
        (el, key) => {
          const row = v.batch[Number(key.slice(4))];
          if (!row) {
            return;
          }
          el.dataset.state = row.state;
          const [at, text, state, problem] = el.children as unknown as [
            HTMLElement,
            HTMLElement,
            HTMLElement,
            HTMLElement,
          ];
          at.textContent = clock(row.at);
          text.textContent = row.text;
          state.textContent =
            row.state === "voiced" && row.durationSec !== undefined
              ? `${ROW_STATE.voiced} · ${span(row.durationSec)}`
              : ROW_STATE[row.state];
          problem.hidden = !row.message;
          problem.textContent = row.message ?? "";
        }
      );
    },
  };
}
