// Time spans on a timeline, and the arithmetic over them: merging, subtracting,
// and joining ffmpeg `select` terms. Shared by the condense pass (video/) and
// the cut model (edit/cut.ts).
//
// Pure and dependency-free on purpose: edit/cut.ts imports this, and the
// browser editor bundles cut.ts to preview edits client-side, so nothing here
// may reach for Node (no fs, no child_process, no logger).

export interface Segment {
  end: number;
  start: number;
}

// Clamp each window to [0, durationSec], drop empties, and merge overlapping or
// touching windows into a sorted, disjoint keep list.
export function mergeWindows(
  windows: Segment[],
  durationSec: number
): Segment[] {
  const clamped = windows
    .map((w) => ({
      start: Math.max(0, Math.min(w.start, durationSec)),
      end: Math.max(0, Math.min(w.end, durationSec)),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const w of clamped) {
    const last = merged.at(-1);
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// Remove `remove` from `spans`, splitting a span in two when a removal falls in
// its middle. Pure → unit-tested.
export function subtractSpans(spans: Segment[], remove: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const span of spans) {
    let parts: Segment[] = [{ start: span.start, end: span.end }];
    for (const cut of remove) {
      const cs = Math.max(cut.start, span.start);
      const ce = Math.min(cut.end, span.end);
      if (ce <= cs) {
        continue;
      }
      parts = parts.flatMap((seg) => {
        if (ce <= seg.start || cs >= seg.end) {
          return [seg];
        }
        const out: Segment[] = [];
        if (seg.start < cs) {
          out.push({ start: seg.start, end: cs });
        }
        if (seg.end > ce) {
          out.push({ start: ce, end: seg.end });
        }
        return out;
      });
    }
    result.push(...parts);
  }
  return result.filter((s) => s.end > s.start);
}

// Join `select` terms into one expression as a balanced tree of `+`.
//
// ffmpeg's expression parser has a nesting budget, and a flat `a+b+c+…` spends
// it once per term: past ~100 terms it fails with "Error while parsing
// expression" / "Cannot allocate memory" and the encode aborts. A balanced tree
// nests only log2(n) deep — measured, 2,000 terms parse and run in one pass. So
// a long session's hundreds of kept segments are one decode of the source, not
// one per batch of 50 plus a concat. Pure → unit-tested.
export function selectTree(terms: string[]): string {
  if (terms.length === 0) {
    return "0";
  }
  if (terms.length === 1) {
    return terms[0] as string;
  }
  const mid = Math.floor(terms.length / 2);
  return `(${selectTree(terms.slice(0, mid))}+${selectTree(terms.slice(mid))})`;
}
