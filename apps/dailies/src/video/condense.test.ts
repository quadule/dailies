import { describe, expect, it } from "vitest";
import {
  chunk,
  clampKeepsToFloor,
  computeKeepSegments,
  keptSeconds,
  MAX_SELECT_TERMS,
  MAX_STILL_SEC,
  mergeWindows,
  parseFreezeOutput,
  remapToCondensed,
  subtractFreezesFromWindows,
} from "./condense.js";

describe("clampKeepsToFloor", () => {
  it("drops keeps before the floor and clamps the one spanning it", () => {
    expect(
      clampKeepsToFloor(
        [
          { start: 0, end: 2 }, // before floor → dropped
          { start: 2.5, end: 6 }, // spans floor=3 → clamped to [3,6]
          { start: 7, end: 9 }, // after floor → kept
        ],
        3
      )
    ).toEqual([
      { start: 3, end: 6 },
      { start: 7, end: 9 },
    ]);
  });
  it("is a no-op for a zero/negative floor", () => {
    const keeps = [{ start: 0, end: 2 }];
    expect(clampKeepsToFloor(keeps, 0)).toBe(keeps);
  });
});

const freezeLine = (kind: "start" | "end", t: number) =>
  `[freezedetect @ 0x600] lavfi.freezedetect.freeze_${kind}: ${t}\n`;

describe("parseFreezeOutput", () => {
  it("pairs freeze_start/freeze_end events and reads the duration", () => {
    const stderr =
      freezeLine("start", 0.04) +
      freezeLine("end", 5.2) +
      freezeLine("start", 10) +
      freezeLine("end", 14.5);
    const progress = "out_time_us=20000000\nprogress=end\n";
    expect(parseFreezeOutput(stderr, progress)).toEqual({
      durationSec: 20,
      freezes: [
        { start: 0.04, end: 5.2 },
        { start: 10, end: 14.5 },
      ],
    });
  });

  it("closes a freeze still open at EOF using the total duration", () => {
    const stderr = freezeLine("start", 8);
    const progress = "out_time_us=12000000\n";
    expect(parseFreezeOutput(stderr, progress).freezes).toEqual([
      { start: 8, end: 12 },
    ]);
  });

  it("falls back to out_time_ms and tolerates no freezes", () => {
    const parsed = parseFreezeOutput("", "out_time_ms=7000000\n");
    expect(parsed).toEqual({ durationSec: 7, freezes: [] });
  });
});

describe("computeKeepSegments", () => {
  it("drops a leading freeze entirely (pre-page-load frames)", () => {
    const keeps = computeKeepSegments({
      durationSec: 20,
      freezes: [{ start: 0, end: 5 }],
    });
    expect(keeps).toEqual([{ start: 5, end: 20 }]);
  });

  it("caps a mid-video freeze but keeps a glide lead-out before motion resumes", () => {
    // Cut only the middle: keep the first maxStillSec AND a 1.5s tail (the
    // cursor gliding into the next action lives there), so the join lands in
    // parked-cursor idle and nothing snaps.
    const keeps = computeKeepSegments(
      {
        durationSec: 30,
        freezes: [{ start: 10, end: 20 }],
      },
      2
    );
    expect(keeps).toEqual([
      { start: 0, end: 12 },
      { start: 18.5, end: 30 }, // 20 - 1.5 lead-out
    ]);
    expect(keptSeconds(keeps)).toBe(23.5);
  });

  it("keeps a short freeze whole (no trimmable middle after the lead-out)", () => {
    // A 2s freeze at maxStill=1 leaves no middle once the 1.5s tail is reserved
    // (1 + 1.5 > 2), so it's kept entirely rather than snapping a glide inside it.
    const keeps = computeKeepSegments({
      durationSec: 20,
      freezes: [{ start: 5, end: 7 }],
    });
    expect(keeps).toEqual([{ start: 0, end: 20 }]);
  });

  it("caps a trailing freeze that runs to EOF (no lead-out — nothing follows)", () => {
    const keeps = computeKeepSegments(
      {
        durationSec: 30,
        freezes: [{ start: 25, end: 30 }],
      },
      2
    );
    expect(keeps).toEqual([{ start: 0, end: 27 }]);
  });

  it("handles leading + mid freezes together", () => {
    const keeps = computeKeepSegments(
      {
        durationSec: 40,
        freezes: [
          { start: 0.1, end: 4 },
          { start: 12, end: 20 },
        ],
      },
      2
    );
    expect(keeps).toEqual([
      { start: 4, end: 14 },
      { start: 18.5, end: 40 }, // 20 - 1.5 lead-out
    ]);
  });

  it("keeps the first seconds when the whole video is one leading freeze", () => {
    const keeps = computeKeepSegments(
      {
        durationSec: 9,
        freezes: [{ start: 0, end: 9 }],
      },
      2
    );
    expect(keeps).toEqual([{ start: 0, end: 2 }]);
  });

  it("returns the full video when nothing froze", () => {
    const keeps = computeKeepSegments({ durationSec: 15, freezes: [] });
    expect(keeps).toEqual([{ start: 0, end: 15 }]);
  });
});

describe("subtractFreezesFromWindows", () => {
  it("cuts a dead wait inside a keep window but keeps a glide lead-out", () => {
    // maxStill=1 (default), lead-out=1.5: the cut is [6, 16.5], so the tail
    // [16.5, 18] (the glide into the next action) survives.
    const keeps = subtractFreezesFromWindows(
      [{ start: 0, end: 20 }],
      [{ start: 5, end: 18 }]
    );
    expect(keeps).toEqual([
      { start: 0, end: 6 },
      { start: 16.5, end: 20 },
    ]);
  });

  it("leaves a short internal freeze whole (no middle after the lead-out)", () => {
    const keeps = subtractFreezesFromWindows(
      [{ start: 0, end: 10 }],
      [{ start: 4, end: 6 }]
    );
    expect(keeps).toEqual([{ start: 0, end: 10 }]);
  });

  it("keeps a protected caption span and still trims the idle around it", () => {
    // The case showCaption's "breathing" animation existed to fake: a caption
    // shown over a page doing nothing, inside a long dead wait. The caption's
    // own seconds must survive; the wait either side of it must not.
    const keeps = subtractFreezesFromWindows(
      [{ start: 0, end: 40 }],
      [{ start: 2, end: 38 }],
      MAX_STILL_SEC,
      [{ start: 20, end: 25 }]
    );
    // Cut would have been [3, 36.5]; the protected span splits it in two.
    expect(keeps).toEqual([
      { start: 0, end: 3 },
      { start: 20, end: 25 },
      { start: 36.5, end: 40 },
    ]);
  });

  it("protects a caption that starts before the freeze's cut begins", () => {
    const keeps = subtractFreezesFromWindows(
      [{ start: 0, end: 20 }],
      [{ start: 5, end: 18 }],
      MAX_STILL_SEC,
      [{ start: 0, end: 8 }]
    );
    // Nothing is lost before 8; the rest of the cut [8, 16.5] still goes.
    expect(keeps).toEqual([
      { start: 0, end: 8 },
      { start: 16.5, end: 20 },
    ]);
  });

  it("changes nothing when no window is protected", () => {
    expect(
      subtractFreezesFromWindows(
        [{ start: 0, end: 20 }],
        [{ start: 5, end: 18 }],
        MAX_STILL_SEC,
        []
      )
    ).toEqual(
      subtractFreezesFromWindows(
        [{ start: 0, end: 20 }],
        [{ start: 5, end: 18 }]
      )
    );
  });
});

describe("chunk", () => {
  // A long session can produce hundreds of kept segments; past ~100
  // `between(t,…)` terms ffmpeg's expression parser aborts the encode, so the
  // segments must be batched under MAX_SELECT_TERMS and concatenated.
  it("keeps every batch within the select-expression ceiling", () => {
    const keeps = Array.from({ length: 170 }, (_, i) => ({
      start: i,
      end: i + 0.5,
    }));
    const batches = chunk(keeps, MAX_SELECT_TERMS);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_SELECT_TERMS);
    }
    // No segment is lost or duplicated across batches.
    expect(batches.flat()).toEqual(keeps);
  });

  it("returns a single batch when keeps fit", () => {
    const keeps = [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ];
    expect(chunk(keeps, MAX_SELECT_TERMS)).toEqual([keeps]);
  });

  it("handles an empty list", () => {
    expect(chunk([], MAX_SELECT_TERMS)).toEqual([]);
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

describe("remapToCondensed", () => {
  // Kept 0-5 and 10-15; the 5-10 gap is trimmed. Condensed timeline is 0-10.
  const keeps = [
    { start: 0, end: 5 },
    { start: 10, end: 15 },
  ];

  it("maps times inside kept segments to their condensed position", () => {
    expect(remapToCondensed(0, keeps)).toBe(0);
    expect(remapToCondensed(3, keeps)).toBe(3);
    expect(remapToCondensed(12, keeps)).toBe(7); // 5 kept + (12-10)
    expect(remapToCondensed(15, keeps)).toBe(10);
  });

  it("collapses a time inside a trimmed gap to the gap's near edge", () => {
    expect(remapToCondensed(7, keeps)).toBe(5); // gap 5-10 → end of first kept
    expect(remapToCondensed(10, keeps)).toBe(5); // exactly at 2nd segment start
  });

  it("clamps a time past the end to total kept duration", () => {
    expect(remapToCondensed(99, keeps)).toBe(10);
  });
});
