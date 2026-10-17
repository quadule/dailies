// Times as the editor shows, reads and snaps them. Every time here is SOURCE
// time (seconds into /source.webm), like every time in the cut. Pure and
// DOM-free, so vitest runs it under node.

// m:ss.s — the way `dailies cut render` prints a position. `decimals` 2 is for
// the stage clocks, where a frame step has to show.
export function clock(sec: number, decimals = 1): string {
  const scale = 10 ** decimals;
  const total = Math.round(Math.max(0, sec) * scale);
  const minutes = Math.floor(total / (60 * scale));
  const rest = (total - minutes * 60 * scale) / scale;
  const width = decimals > 0 ? 3 + decimals : 2;
  return `${minutes}:${rest.toFixed(decimals).padStart(width, "0")}`;
}

// A length, as a label on the timeline: "2.0s".
export function span(sec: number): string {
  return `${Math.max(0, sec).toFixed(1)}s`;
}

// Seconds as typed into a field: "12.5", "12.5s", "1:02.5", "1:00:02". A
// decimal comma is read as a point. Undefined when it isn't a time.
export function parseSeconds(text: string): number | undefined {
  const value = text.trim().replace(",", ".").replace(/s$/i, "").trim();
  if (value === "") {
    return;
  }
  const parts = value.split(":");
  if (parts.length > 3) {
    return;
  }
  let total = 0;
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const ok = last ? /^(\d+(\.\d*)?|\.\d+)$/ : /^\d+$/;
    if (!ok.test(part)) {
      return;
    }
    const n = Number(part);
    // Minutes and seconds after the first field stay under 60.
    if (i > 0 && n >= 60) {
      return;
    }
    total = total * 60 + n;
  }
  return Number.isFinite(total) ? total : undefined;
}

// The source's frame grid and length, which every edited time is held to.
export interface Grid {
  durationSec: number;
  fps: number;
}

// The last frame time a cut may name. planCut snaps the duration the same way.
export function endOf(grid: Grid): number {
  return Math.round(grid.durationSec * grid.fps) / grid.fps;
}

// Snap to the frame grid and clamp into the source.
export function snapTime(t: number, grid: Grid): number {
  const snapped = Math.round(t * grid.fps) / grid.fps;
  return Math.min(Math.max(snapped, 0), endOf(grid));
}

export interface Span {
  end: number;
  start: number;
}

// A range moved by `delta` seconds, keeping its length, snapped and kept
// inside [min, max] (the source unless a neighbour narrows it).
export function moveSpan(
  range: Span,
  delta: number,
  grid: Grid,
  bounds: Partial<Span> = {}
): Span {
  const min = bounds.start ?? 0;
  const max = bounds.end ?? endOf(grid);
  // Whole frames, so snapping the start never changes the length.
  const length = Math.round((range.end - range.start) * grid.fps) / grid.fps;
  const start = Math.min(
    Math.max(snapTime(range.start + delta, grid), min),
    Math.max(min, max - length)
  );
  return { start, end: Math.min(snapTime(start + length, grid), max) };
}

// A range with one edge dragged to `t`, snapped, at least one frame long and
// kept inside [min, max].
export function resizeSpan(
  range: Span,
  edge: "start" | "end",
  t: number,
  grid: Grid,
  bounds: Partial<Span> = {}
): Span {
  const frame = 1 / grid.fps;
  const min = bounds.start ?? 0;
  const max = bounds.end ?? endOf(grid);
  const at = snapTime(t, grid);
  if (edge === "start") {
    return {
      start: Math.min(Math.max(at, min), snapTime(range.end - frame, grid)),
      end: range.end,
    };
  }
  return {
    start: range.start,
    end: Math.max(Math.min(at, max), snapTime(range.start + frame, grid)),
  };
}
