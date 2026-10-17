// The live preview's engine: what the stage should do so /source.webm plays
// the way the rendered cut will, without rendering it. It works from the same
// plan the render uses (planCut, layoutLines, outputCaptions from cut.ts), so a
// position in the preview is a position in the render.
//
// Pure and DOM-free — vitest runs it under node. stage.ts applies its
// decisions to the <video> and <audio> elements.

import { wrapCaption } from "../../../video/srt.js";
import {
  type Cut,
  type CutCaption,
  type CutLine,
  type CutPlan,
  extendTail,
  layoutLines,
  mapTime,
  type OutputCue,
  outputCaptions,
  parseCut,
  planCut,
  TAIL_PAD_SEC,
} from "../../cut.js";
import type { EditorRecording } from "../contract.js";

// ---------------------------------------------------------------------------
// The cut, analysed: what the parser says, where everything lands, and what
// to warn about. Recomputed on every change.
// ---------------------------------------------------------------------------

// Speaking pace assumed for a line nobody has voiced or recorded yet.
export const WORDS_PER_SEC = 2.6;

export function estimateSpeechSec(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, words) / WORDS_PER_SEC;
}

// A voiced line from the last render (GET /api/render's result.lines).
export interface RenderedLine {
  durationSec: number;
  text: string;
}

export type DurationSource = "recording" | "render" | "estimate";

export interface KnownDurations {
  recordings: readonly EditorRecording[];
  rendered: readonly RenderedLine[];
}

// How long a line speaks: its recording's length, else what the last render
// voiced for the same text, else an estimate from its words.
export function lineDuration(
  line: CutLine,
  known: KnownDurations
): { sec: number; source: DurationSource } {
  if (line.audio) {
    const recording = known.recordings.find((r) => r.file === line.audio);
    if (recording) {
      return { sec: recording.durationSec, source: "recording" };
    }
  }
  const rendered = known.rendered.find((r) => r.text === line.text);
  if (rendered) {
    return { sec: rendered.durationSec, source: "render" };
  }
  return { sec: estimateSpeechSec(line.text), source: "estimate" };
}

export interface PlacedLine {
  durationSec: number;
  // Its index in cut.narration.
  index: number;
  line: CutLine;
  outStart: number;
}

export interface Analysis {
  // Output-time captions, as the burn will show them.
  cues: OutputCue[];
  // Per cut.narration index.
  durations: { sec: number; source: DurationSource }[];
  // parseCut's message when the cut can't be saved.
  error?: string;
  // The model's warnings plus the editor's own checks.
  hints: string[];
  // Spoken lines in output time, in order. Lines in cut footage are left out.
  placed: PlacedLine[];
  // The render's plan, with the tail extended when the last line overruns.
  plan: CutPlan;
}

export interface AnalysisContext extends KnownDurations {
  // How many characters fit on one caption line.
  lineMax: number;
  source: { durationSec: number; fps: number };
}

function at(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

function captionHints(cut: Cut, lineMax: number): string[] {
  const hints: string[] = [];
  const fits = lineMax * 2;
  for (const caption of cut.captions) {
    if (!caption.text.trim()) {
      hints.push(`caption at ${at(caption.start)} has no text`);
    } else if (caption.text.length > fits) {
      hints.push(
        `caption at ${at(caption.start)} is ${caption.text.length} characters — two lines hold about ${fits}, so the burn cuts it off`
      );
    }
  }
  for (const line of cut.narration) {
    const shown = line.caption ?? line.text;
    if (shown.length > fits) {
      hints.push(
        `line at ${at(line.at)} shows ${shown.length} characters as its caption — about ${fits} fit; the voice still says it all`
      );
    }
  }
  return hints;
}

// Everything the editor shows about a cut, computed the way the render does
// (render.ts renderCutVideo): plan, place the lines, extend the tail for an
// overrunning last line, then the captions.
export function analyze(cut: Cut, ctx: AnalysisContext): Analysis {
  const parsed = parseCut(cut);
  const warnings: string[] = [];
  let plan = planCut(cut, ctx.source);
  warnings.push(...plan.warnings);
  const durations = cut.narration.map((line) => lineDuration(line, ctx));
  const { placed, overrunSec } = layoutLines({
    plan,
    lines: cut.narration.map((line, i) => ({
      line,
      durationSec: durations[i]?.sec ?? 0,
    })),
    warnings,
  });
  if (overrunSec > 0) {
    plan = extendTail(plan, overrunSec + TAIL_PAD_SEC);
    warnings.push(
      `the last line runs ${at(overrunSec)} past the picture — the render holds the final frame for it`
    );
  }
  const cues = outputCaptions({
    plan,
    captions: cut.captions,
    lines: placed,
    warnings,
  });
  return {
    ...("error" in parsed ? { error: parsed.error } : {}),
    plan,
    placed: placed.map((p) => ({ ...p, index: cut.narration.indexOf(p.line) })),
    cues,
    durations,
    hints: [...warnings, ...captionHints(cut, ctx.lineMax)],
  };
}

// ---------------------------------------------------------------------------
// The playback engine. Given the plan, the source time, and the hold in
// progress, it says what the stage does next: keep playing (at what rate),
// seek over removed footage, freeze on a hold, or stop.
// ---------------------------------------------------------------------------

export interface HoldPoint {
  at: number;
  seconds: number;
}

export interface SourceSpan {
  end: number;
  start: number;
}

export interface PreviewModel {
  // Sped-up stretches as the plan plays them.
  fast: (SourceSpan & { rate: number })[];
  frame: number;
  // Removed footage: before, between and after the plan's pieces.
  gaps: SourceSpan[];
  // Freezes, one per frame (planCut has merged holds on the same frame and
  // dropped the ones in removed footage).
  holds: HoldPoint[];
  plan: CutPlan;
}

const EPS = 1e-6;

export function previewModel(plan: CutPlan): PreviewModel {
  const holds: HoldPoint[] = [];
  const gaps: SourceSpan[] = [];
  const fast: PreviewModel["fast"] = [];
  let cursor = 0;
  for (const p of plan.pieces) {
    if (p.srcStart > cursor + EPS) {
      gaps.push({ start: cursor, end: p.srcStart });
    }
    cursor = p.srcEnd;
    if (p.startHoldSec > 0) {
      holds.push({ at: p.srcStart, seconds: p.startHoldSec });
    }
    if (p.endHoldSec > 0) {
      holds.push({ at: p.srcEnd, seconds: p.endHoldSec });
    }
    if (p.rate) {
      fast.push({ start: p.srcStart, end: p.srcEnd, rate: p.rate });
    }
  }
  if (plan.sourceDurationSec > cursor + EPS) {
    gaps.push({ start: cursor, end: plan.sourceDurationSec });
  }
  holds.sort((a, b) => a.at - b.at);
  return { plan, holds, gaps, fast, frame: 1 / plan.fps };
}

export interface EngineState {
  // The hold that just finished, while playback still sits on its frame — the
  // output clock has already counted it.
  after?: HoldPoint;
  // The hold being played, and how many seconds of it have passed.
  hold?: HoldPoint & { elapsed: number };
}

export interface EngineInput {
  // Wall-clock seconds since the last tick (a hold runs on these).
  dt: number;
  // The source time: video.currentTime.
  now: number;
  // Source time already played through, exclusive: a hold is due when it
  // lies after this and at or before `now`. Pass the previous step's `since`;
  // after a seek of your own, pass a hair less than the target so a hold on
  // that very frame still plays.
  since: number;
}

export interface EngineStep {
  // play: the element should be playing. hold: paused on the held frame.
  // end: the cut is over; stop.
  action: "play" | "hold" | "end";
  // The output clock: where this moment lands in the rendered video.
  out: number;
  rate: number;
  // Seek the element here first.
  seekTo?: number;
  since: number;
  state: EngineState;
}

export function rateAt(model: PreviewModel, t: number): number {
  return (
    model.fast.find((f) => t >= f.start - EPS && t < f.end - EPS)?.rate ?? 1
  );
}

function ended(model: PreviewModel, now: number): EngineStep {
  return {
    action: "end",
    out: model.plan.outDurationSec,
    rate: 1,
    since: now,
    state: {},
  };
}

// One step of playback. Call it on every animation frame while the preview
// plays, and apply what it returns.
export function tick(
  model: PreviewModel,
  state: EngineState,
  input: EngineInput
): EngineStep {
  const half = model.frame / 2;
  let { now, since } = input;
  let after = state.after;
  if (state.hold) {
    const { hold } = state;
    const elapsed = hold.elapsed + input.dt;
    if (elapsed < hold.seconds) {
      return {
        action: "hold",
        out: mapTime(model.plan, hold.at).out + elapsed,
        rate: 1,
        since: hold.at,
        state: { hold: { ...hold, elapsed } },
      };
    }
    // Done: play on from the held frame.
    now = hold.at;
    since = hold.at;
    after = { at: hold.at, seconds: hold.seconds };
  }

  // A hold reached since the last step. Within half a frame counts: that is
  // the frame on screen.
  const hold = model.holds.find(
    (h) => h.at > since + EPS && h.at <= now + half
  );
  if (hold) {
    return {
      action: "hold",
      out: mapTime(model.plan, hold.at).out,
      rate: 1,
      ...(Math.abs(now - hold.at) > EPS ? { seekTo: hold.at } : {}),
      since: hold.at,
      state: { hold: { ...hold, elapsed: 0 } },
    };
  }

  const end = model.plan.sourceDurationSec;
  const gap = model.gaps.find((g) => now >= g.start - EPS && now < g.end - EPS);
  if (gap) {
    if (gap.end >= end - EPS) {
      return ended(model, now);
    }
    // Skip to the next kept frame. `since` stays just short of it, so a hold
    // on that frame plays next.
    return {
      action: "play",
      out: mapTime(model.plan, gap.end).out,
      rate: rateAt(model, gap.end),
      seekTo: gap.end,
      since: gap.end - 2 * EPS,
      state: {},
    };
  }
  if (now >= end - EPS) {
    return ended(model, now);
  }

  let out = mapTime(model.plan, now).out;
  const fps = model.plan.fps;
  if (after && Math.round(now * fps) === Math.round(after.at * fps)) {
    // mapTime puts a held frame (it snaps `now` to one, as here) at the START
    // of its freeze.
    out += after.seconds;
  } else {
    after = undefined;
  }
  return {
    action: "play",
    out,
    rate: rateAt(model, now),
    since: Math.max(since, now),
    state: after ? { after } : {},
  };
}

// The output clock when not playing (paused, or scrubbing): where a source
// time lands, or undefined when it is removed footage.
export function outputAt(plan: CutPlan, t: number): number | undefined {
  const mapped = mapTime(plan, t);
  return mapped.removed ? undefined : mapped.out;
}

// The inverse of mapTime: the source frame on screen at output time `out`. A
// freeze maps to its held frame; inside a sped-up piece each output second
// covers `rate` source seconds. Used to place the playhead while the rendered
// video plays.
export function sourceTime(plan: CutPlan, out: number): number {
  const pieces = plan.pieces;
  for (const [i, p] of pieces.entries()) {
    const pieceEnd = pieces[i + 1]?.outStart ?? plan.outDurationSec;
    if (out >= pieceEnd && i < pieces.length - 1) {
      continue;
    }
    const footage = pieceEnd - p.outStart - p.startHoldSec - p.endHoldSec;
    const into = out - p.outStart - p.startHoldSec;
    if (into <= 0) {
      return p.srcStart;
    }
    if (into >= footage) {
      return p.srcEnd;
    }
    return Math.min(p.srcEnd, p.srcStart + into * (p.rate ?? 1));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// What the caption band and the narration play at a moment.
// ---------------------------------------------------------------------------

// The cue on screen at output time `out`.
export function cueAt(
  cues: readonly OutputCue[],
  out: number
): OutputCue | undefined {
  return cues.find((c) => out >= c.start && out < c.end);
}

// The free-standing caption over a source time — what the band shows when
// the preview is off and the raw footage plays.
export function captionAtSource(
  captions: readonly CutCaption[],
  t: number
): CutCaption | undefined {
  return captions.find((c) => t >= c.start && t < c.end);
}

// Caption text as the burn lays it out: balanced, at most two lines, an
// ellipsis when it doesn't fit (wrapCaption is the burn's own wrapper).
export function captionLines(text: string, lineMax: number): string[] {
  return wrapCaption(text, lineMax).split("\n").filter(Boolean);
}

// Lines whose start the output clock crossed going from `from` to `to`: after
// `from`, up to and including `to`. A line starting exactly at `from` was
// already started (by linesAt, when playback began there).
export function linesStarting(
  placed: readonly PlacedLine[],
  from: number,
  to: number
): PlacedLine[] {
  return placed.filter((p) => p.outStart > from && p.outStart <= to);
}

// Lines speaking at output time `out` — what to pick up mid-line when
// playback starts there.
export function linesAt(
  placed: readonly PlacedLine[],
  out: number
): PlacedLine[] {
  return placed.filter(
    (p) => out >= p.outStart && out < p.outStart + p.durationSec
  );
}
