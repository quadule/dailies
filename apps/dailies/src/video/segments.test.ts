import { describe, expect, it } from "vitest";
import { mergeWindows, selectTree, subtractSpans } from "./segments.js";

describe("selectTree", () => {
  // ffmpeg's parser fails on a flat sum past ~100 terms; a balanced tree nests
  // only log2(n) deep, so hundreds of kept segments stay one expression.
  it("nests a long sum only logarithmically deep", () => {
    const terms = Array.from(
      { length: 400 },
      (_, i) => `between(t,${i},${i + 0.5})`
    );
    const expr = selectTree(terms);
    let depth = 0;
    let max = 0;
    for (const ch of expr) {
      if (ch === "(") {
        depth += 1;
        max = Math.max(max, depth);
      } else if (ch === ")") {
        depth -= 1;
      }
    }
    // between(…) contributes one level of its own.
    expect(max).toBeLessThanOrEqual(Math.ceil(Math.log2(400)) + 1);
    for (const term of terms) {
      expect(expr).toContain(term);
    }
  });

  it("returns a lone term unwrapped, and selects nothing for no terms", () => {
    expect(selectTree(["a"])).toBe("a");
    expect(selectTree(["a", "b"])).toBe("(a+b)");
    expect(selectTree([])).toBe("0");
  });
});

describe("mergeWindows", () => {
  it("clamps to [0, duration], sorts, and merges overlapping/touching windows", () => {
    const merged = mergeWindows(
      [
        { start: 11, end: 30 }, // end clamped to 20
        { start: -1, end: 3 }, // start clamped to 0
        { start: 2.5, end: 5 }, // overlaps the previous → merges to 0-5
        { start: 8, end: 8 }, // empty → dropped
      ],
      20
    );
    expect(merged).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 20 },
    ]);
  });

  it("returns nothing when all windows are empty or out of range", () => {
    expect(mergeWindows([{ start: 5, end: 5 }], 10)).toEqual([]);
    expect(mergeWindows([], 10)).toEqual([]);
  });
});

describe("subtractSpans", () => {
  it("splits a span around a removal in its middle", () => {
    expect(
      subtractSpans([{ start: 0, end: 10 }], [{ start: 3, end: 4 }])
    ).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 10 },
    ]);
  });

  it("drops a span removed whole and ignores removals outside it", () => {
    expect(
      subtractSpans(
        [
          { start: 0, end: 2 },
          { start: 5, end: 6 },
        ],
        [
          { start: 1, end: 3 },
          { start: 4.5, end: 7 },
          { start: 20, end: 30 },
        ]
      )
    ).toEqual([{ start: 0, end: 1 }]);
  });
});
