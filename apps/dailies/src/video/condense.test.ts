import { describe, expect, it } from "vitest";
import {
  analyzeMotion,
  chunk,
  clampKeepsToFloor,
  computeKeepSegments,
  keptSeconds,
  MAX_SELECT_TERMS,
  MAX_STILL_SEC,
  mergeWindows,
  motionBursts,
  parseMotionOutput,
  remapToCondensed,
  stillSpans,
  subtractStillsFromWindows,
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

// The motion pass prints two lines per frame: the frame header (carrying
// pts_time) then signalstats' YAVG of the binarised difference — 255 x the
// fraction of the picture that changed. Times are half-second steps so the
// arithmetic in these expectations is exact in binary floating point.
const motionOutput = (frames: [number, number][]) =>
  frames
    .map(
      ([t, yavg], i) =>
        `frame:${i}    pts:${t * 1000}      pts_time:${t}\nlavfi.signalstats.YAVG=${yavg}\n`
    )
    .join("");

// YAVG values measured on real footage, for tests that need a realistic scale.
// Divide by 255 for the fraction of the frame each one changes.
const NOTHING = 0;
// A 2x18px text caret toggling: 0.000028 of the frame. Handled in the
// recording — the caret is painted transparent — not here.
const CARET = 0.007_08;
// Typing one character: 0.000086 — MORE of the frame than the caret, which is
// why no size bound can tell the two apart.
const TYPED = 0.022;
// A checkbox ticking: 0.00015.
const TICK = 0.039;
// One frame of a slow cursor glide, at its faintest: 0.0008.
const GLIDE = 0.2;

describe("parseMotionOutput", () => {
  it("reads each frame's time and changed-area fraction", () => {
    const parsed = parseMotionOutput(
      motionOutput([
        [0.5, 0],
        [1, 25.5],
        [1.5, 255],
      ])
    );
    expect(parsed.frames).toEqual([
      { t: 0.5, area: 0 },
      { t: 1, area: 0.1 },
      { t: 1.5, area: 1 },
    ]);
    expect(parsed.intervalSec).toBe(0.5);
    // tblend gives no entry for the first source frame, so the duration is
    // the last frame's time plus one interval.
    expect(parsed.durationSec).toBe(2);
  });

  it("takes the MEDIAN interval so a dropped frame doesn't stretch it", () => {
    // A screencast stalls while the page is busy: one 1.5s gap among 0.5s ones.
    const parsed = parseMotionOutput(
      motionOutput([
        [0.5, 0],
        [1, 0],
        [1.5, 0],
        [3, 0],
      ])
    );
    expect(parsed.intervalSec).toBe(0.5);
  });

  it("tolerates empty output", () => {
    expect(parseMotionOutput("")).toEqual({
      durationSec: 0,
      frames: [],
      intervalSec: 0.04,
    });
  });
});

describe("motionBursts", () => {
  it("groups consecutive changed frames, tracking length and largest change", () => {
    const bursts = motionBursts(
      parseMotionOutput(
        motionOutput([
          [0.5, NOTHING],
          [1, GLIDE],
          [1.5, TICK],
          [2, NOTHING],
          [2.5, CARET],
        ])
      )
    );
    expect(bursts).toEqual([
      // Starts one interval before its first frame: a frame's area describes
      // the interval ending at its time. A glide frame covers more of the
      // picture than a ticking checkbox (the cursor is the bigger object), so
      // it is the burst's maxArea.
      { start: 0.5, end: 1.5, frameCount: 2, maxArea: GLIDE / 255 },
      { start: 2, end: 2.5, frameCount: 1, maxArea: CARET / 255 },
    ]);
  });
});

describe("stillSpans", () => {
  it("returns the gaps between real motion bursts", () => {
    const timeline = parseMotionOutput(
      motionOutput([
        [0.5, NOTHING],
        [1, NOTHING],
        [1.5, TICK],
        [2, NOTHING],
        [2.5, NOTHING],
        [3, NOTHING],
      ])
    );
    expect(stillSpans(timeline)).toEqual([
      { start: 0, end: 1 },
      { start: 1.5, end: 3.5 },
    ]);
  });

  it("drops spans shorter than the minimum worth cutting", () => {
    const timeline = parseMotionOutput(
      motionOutput([
        [0.5, NOTHING],
        [1, TICK],
        [1.5, NOTHING],
        [2, NOTHING],
        [2.5, NOTHING],
      ])
    );
    expect(stillSpans(timeline, 1.5)).toEqual([{ start: 1, end: 3 }]);
  });

  it("treats every burst as real motion, however small or brief", () => {
    // Nothing is filtered by size. A typed character changes LESS of the frame
    // than a blinking caret does, and both arrive as a lone frame between
    // stills, so any bound that dropped the caret would also drop typing and
    // text would appear in a field instantly instead of being typed. The caret
    // is dealt with in the recording instead.
    const timeline = parseMotionOutput(
      motionOutput([
        [0.5, NOTHING],
        [1, CARET],
        [1.5, NOTHING],
        [2, TYPED],
        [2.5, NOTHING],
        [3, TICK],
        [3.5, NOTHING],
      ])
    );
    expect(stillSpans(timeline, 0)).toEqual([
      { start: 0, end: 0.5 },
      { start: 1, end: 1.5 },
      { start: 2, end: 2.5 },
      { start: 3, end: 4 },
    ]);
  });

  it("splits the stills either side of a one-frame change", () => {
    // A checkbox ticking is a single frame. The still before it and the still
    // after it stay separate spans, so each keeps its own beat and the change
    // itself is never cut across.
    const timeline = parseMotionOutput(
      motionOutput([
        [0.5, NOTHING],
        [1, TICK],
        [1.5, NOTHING],
      ])
    );
    expect(stillSpans(timeline, 0)).toEqual([
      { start: 0, end: 0.5 },
      { start: 1, end: 2 },
    ]);
  });

  it("keeps a slow glide whole", () => {
    const timeline = parseMotionOutput(
      motionOutput([
        [0.5, NOTHING],
        [1, GLIDE],
        [1.5, GLIDE],
        [2, GLIDE],
        [2.5, NOTHING],
      ])
    );
    expect(stillSpans(timeline, 0)).toEqual([
      { start: 0, end: 0.5 },
      { start: 2, end: 3 },
    ]);
  });
});

describe("analyzeMotion", () => {
  it("parses and reduces to still spans in one step", () => {
    expect(
      analyzeMotion(
        motionOutput([
          [0.5, NOTHING],
          [1, NOTHING],
          [1.5, TICK],
          [2, NOTHING],
          [2.5, NOTHING],
        ])
      )
    ).toEqual({
      durationSec: 3,
      stills: [
        { start: 0, end: 1 },
        { start: 1.5, end: 3 },
      ],
    });
  });
});

describe("computeKeepSegments", () => {
  it("drops a leading still entirely (pre-page-load frames)", () => {
    const keeps = computeKeepSegments({
      durationSec: 20,
      stills: [{ start: 0, end: 5 }],
    });
    expect(keeps).toEqual([{ start: 5, end: 20 }]);
  });

  it("keeps a still's first beat and cuts clean through to where motion resumes", () => {
    // No lead-out is reserved: a still span contains no visible change, so
    // the frames either side of the cut are identical and the join is
    // invisible. (The detector this replaced could not see the cursor, so it
    // had to keep a 1.5s tail on every freeze in case a glide was hiding in
    // it — which set a 2.5s floor under which nothing was ever trimmed.)
    const keeps = computeKeepSegments(
      { durationSec: 30, stills: [{ start: 10, end: 20 }] },
      2
    );
    expect(keeps).toEqual([
      { start: 0, end: 12 },
      { start: 20, end: 30 },
    ]);
    expect(keptSeconds(keeps)).toBe(22);
  });

  it("trims a SHORT still too (no floor below which stills survive whole)", () => {
    // The regression this pass was rewritten for: at maxStill=1 a 2s still
    // used to be kept whole because 1 + the 1.5s lead-out exceeded it. Most
    // real dead air arrives as a chain of such short stills, so almost
    // nothing got trimmed.
    const keeps = computeKeepSegments({
      durationSec: 20,
      stills: [{ start: 5, end: 7 }],
    });
    expect(keeps).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 20 },
    ]);
  });

  it("caps a trailing still that runs to EOF", () => {
    const keeps = computeKeepSegments(
      { durationSec: 30, stills: [{ start: 25, end: 30 }] },
      2
    );
    expect(keeps).toEqual([{ start: 0, end: 27 }]);
  });

  it("handles leading + mid stills together", () => {
    const keeps = computeKeepSegments(
      {
        durationSec: 40,
        stills: [
          { start: 0.1, end: 4 },
          { start: 12, end: 20 },
        ],
      },
      2
    );
    expect(keeps).toEqual([
      { start: 4, end: 14 },
      { start: 20, end: 40 },
    ]);
  });

  it("holds each side of a one-frame change for its own beat", () => {
    // Two stills split by a single changed frame stay separate spans, so each
    // distinct state is on screen for at least maxStillSec and a run of quick
    // changes can't flicker past.
    const keeps = computeKeepSegments(
      {
        durationSec: 40,
        stills: [
          { start: 5, end: 20 },
          { start: 20.04, end: 35 },
        ],
      },
      1
    );
    expect(keeps).toEqual([
      { start: 0, end: 6 },
      { start: 20, end: 21.04 },
      { start: 35, end: 40 },
    ]);
  });

  it("keeps the first seconds when the whole video is one leading still", () => {
    const keeps = computeKeepSegments(
      { durationSec: 9, stills: [{ start: 0, end: 9 }] },
      2
    );
    expect(keeps).toEqual([{ start: 0, end: 2 }]);
  });

  it("returns the full video when nothing was still", () => {
    const keeps = computeKeepSegments({ durationSec: 15, stills: [] });
    expect(keeps).toEqual([{ start: 0, end: 15 }]);
  });
});

describe("subtractStillsFromWindows", () => {
  it("cuts a dead wait inside a keep window down to one beat", () => {
    const keeps = subtractStillsFromWindows(
      [{ start: 0, end: 20 }],
      [{ start: 5, end: 18 }]
    );
    expect(keeps).toEqual([
      { start: 0, end: 6 },
      { start: 18, end: 20 },
    ]);
  });

  it("trims a short internal still as well", () => {
    const keeps = subtractStillsFromWindows(
      [{ start: 0, end: 10 }],
      [{ start: 4, end: 6 }]
    );
    expect(keeps).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 10 },
    ]);
  });

  it("keeps a protected caption span and still trims the idle around it", () => {
    // The case showCaption's "breathing" animation existed to fake: a caption
    // shown over a page doing nothing, inside a long dead wait. The caption's
    // own seconds must survive; the wait either side of it must not.
    const keeps = subtractStillsFromWindows(
      [{ start: 0, end: 40 }],
      [{ start: 2, end: 38 }],
      MAX_STILL_SEC,
      [{ start: 20, end: 25 }]
    );
    // Cut would have been [3, 38]; the protected span splits it in two.
    expect(keeps).toEqual([
      { start: 0, end: 3 },
      { start: 20, end: 25 },
      { start: 38, end: 40 },
    ]);
  });

  it("protects a caption that starts before the still's cut begins", () => {
    const keeps = subtractStillsFromWindows(
      [{ start: 0, end: 20 }],
      [{ start: 5, end: 18 }],
      MAX_STILL_SEC,
      [{ start: 0, end: 8 }]
    );
    // Nothing is lost before 8; the rest of the cut [8, 18] still goes.
    expect(keeps).toEqual([
      { start: 0, end: 8 },
      { start: 18, end: 20 },
    ]);
  });

  it("changes nothing when no window is protected", () => {
    expect(
      subtractStillsFromWindows(
        [{ start: 0, end: 20 }],
        [{ start: 5, end: 18 }],
        MAX_STILL_SEC,
        []
      )
    ).toEqual(
      subtractStillsFromWindows(
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
