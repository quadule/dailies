import { describe, expect, it } from "vitest";
import {
  type CutLine,
  cutVideoFilter,
  extendTail,
  formatCut,
  layoutLines,
  mapTime,
  outputCaptions,
  parseCut,
  planCut,
  seedCut,
  seedSpeedups,
} from "./cut.js";

const SOURCE = { durationSec: 20, fps: 25 };

describe("planCut", () => {
  it("is the identity when nothing is cut or held", () => {
    const plan = planCut({ cuts: [], holds: [] }, SOURCE);
    expect(plan.identity).toBe(true);
    expect(plan.outDurationSec).toBe(20);
    expect(plan.pieces).toEqual([
      { srcStart: 0, srcEnd: 20, startHoldSec: 0, endHoldSec: 0, outStart: 0 },
    ]);
  });

  it("removes cut ranges and merges overlapping ones", () => {
    const plan = planCut(
      {
        cuts: [
          { start: 4, end: 6 },
          { start: 5, end: 8 },
          { start: 15, end: 25 },
        ],
        holds: [],
      },
      SOURCE
    );
    expect(plan.pieces.map((p) => [p.srcStart, p.srcEnd])).toEqual([
      [0, 4],
      [8, 15],
    ]);
    expect(plan.outDurationSec).toBe(11);
  });

  it("splits at a hold and freezes the frame there", () => {
    const plan = planCut({ cuts: [], holds: [{ at: 5, seconds: 2 }] }, SOURCE);
    expect(plan.identity).toBe(false);
    expect(plan.pieces).toEqual([
      { srcStart: 0, srcEnd: 5, startHoldSec: 0, endHoldSec: 2, outStart: 0 },
      { srcStart: 5, srcEnd: 20, startHoldSec: 0, endHoldSec: 0, outStart: 7 },
    ]);
    expect(plan.outDurationSec).toBe(22);
  });

  it("puts a hold at the start of kept footage before it, not in an empty slice", () => {
    const plan = planCut(
      { cuts: [{ start: 2, end: 4 }], holds: [{ at: 4, seconds: 1 }] },
      SOURCE
    );
    expect(plan.pieces).toEqual([
      { srcStart: 0, srcEnd: 2, startHoldSec: 0, endHoldSec: 0, outStart: 0 },
      { srcStart: 4, srcEnd: 20, startHoldSec: 1, endHoldSec: 0, outStart: 2 },
    ]);
  });

  it("holds the last frame when the hold is at the end", () => {
    const plan = planCut({ cuts: [], holds: [{ at: 20, seconds: 3 }] }, SOURCE);
    expect(plan.pieces).toEqual([
      { srcStart: 0, srcEnd: 20, startHoldSec: 0, endHoldSec: 3, outStart: 0 },
    ]);
  });

  it("sums holds on the same frame and skips holds in cut footage", () => {
    const plan = planCut(
      {
        cuts: [{ start: 10, end: 12 }],
        holds: [
          { at: 5, seconds: 1 },
          { at: 5.01, seconds: 0.6 },
          { at: 11, seconds: 4 },
        ],
      },
      SOURCE
    );
    expect(plan.pieces[0]?.endHoldSec).toBe(1.6);
    expect(plan.warnings).toEqual([
      "hold at 11.00s is inside cut footage and was skipped",
    ]);
  });

  it("snaps edits to whole frames so no slice is shorter than a frame", () => {
    const plan = planCut(
      { cuts: [], holds: [{ at: 0.013, seconds: 1 }] },
      { durationSec: 1, fps: 25 }
    );
    // 0.013s snaps to frame 0 — a start hold, not a 0.013s slice.
    expect(plan.pieces).toEqual([
      { srcStart: 0, srcEnd: 1, startHoldSec: 1, endHoldSec: 0, outStart: 0 },
    ]);
  });
});

describe("mapTime", () => {
  const plan = planCut(
    { cuts: [{ start: 4, end: 6 }], holds: [{ at: 10, seconds: 2 }] },
    SOURCE
  );

  it("passes through times before any edit", () => {
    expect(mapTime(plan, 3)).toEqual({ out: 3, removed: false });
  });

  it("shifts times after a cut back by the cut length", () => {
    expect(mapTime(plan, 8)).toEqual({ out: 6, removed: false });
  });

  it("maps a time inside a cut to where the footage resumes", () => {
    expect(mapTime(plan, 5)).toEqual({ out: 4, removed: true });
  });

  it("maps a time on a hold to the start of the freeze", () => {
    expect(mapTime(plan, 10)).toEqual({ out: 8, removed: false });
  });

  it("shifts times after a hold forward by the hold", () => {
    expect(mapTime(plan, 11)).toEqual({ out: 11, removed: false });
  });

  it("maps the end of the source to the end of the output", () => {
    expect(mapTime(plan, 20)).toEqual({ out: 20, removed: false });
  });
});

describe("outputCaptions", () => {
  it("maps captions, adds line captions, and makes the earlier yield", () => {
    const plan = planCut({ cuts: [{ start: 0, end: 2 }], holds: [] }, SOURCE);
    const warnings: string[] = [];
    const line: CutLine = { at: 6, text: "spoken", caption: "shown" };
    const cues = outputCaptions({
      plan,
      captions: [
        { start: 2, end: 6, text: "first" },
        { start: 0.5, end: 1.5, text: "gone" },
      ],
      lines: [{ line, outStart: 3, durationSec: 2 }],
      warnings,
    });
    expect(cues).toEqual([
      { start: 0, end: 3, text: "first" },
      { start: 3, end: 5, text: "shown" },
    ]);
    expect(warnings).toEqual([
      'caption "gone" is inside cut footage and was dropped',
    ]);
  });

  it("shows no caption for a line whose caption is empty", () => {
    const plan = planCut({ cuts: [], holds: [] }, SOURCE);
    const cues = outputCaptions({
      plan,
      captions: [],
      lines: [
        {
          line: { at: 1, text: "hi", caption: "" },
          outStart: 1,
          durationSec: 1,
        },
      ],
      warnings: [],
    });
    expect(cues).toEqual([]);
  });
});

describe("layoutLines", () => {
  it("flags overlapping lines with the hold that fixes them", () => {
    const plan = planCut({ cuts: [], holds: [] }, SOURCE);
    const warnings: string[] = [];
    const { placed, overrunSec } = layoutLines({
      plan,
      lines: [
        { line: { at: 1, text: "a" }, durationSec: 3 },
        { line: { at: 3, text: "b" }, durationSec: 1 },
      ],
      warnings,
    });
    expect(placed.map((p) => p.outStart)).toEqual([1, 3]);
    expect(overrunSec).toBe(0);
    expect(warnings[0]).toContain("add a hold of about 1s at 3.00s");
  });

  it("reports how far the last line runs past the picture", () => {
    const plan = planCut({ cuts: [], holds: [] }, SOURCE);
    const { overrunSec } = layoutLines({
      plan,
      lines: [{ line: { at: 19, text: "late" }, durationSec: 3 }],
      warnings: [],
    });
    expect(overrunSec).toBe(2);
    expect(extendTail(plan, overrunSec).outDurationSec).toBe(22);
  });

  it("drops a line placed in cut footage", () => {
    const plan = planCut({ cuts: [{ start: 5, end: 8 }], holds: [] }, SOURCE);
    const warnings: string[] = [];
    const { placed } = layoutLines({
      plan,
      lines: [{ line: { at: 6, text: "cut" }, durationSec: 1 }],
      warnings,
    });
    expect(placed).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("parseCut", () => {
  const seed = seedCut({
    video: "page.webm",
    steps: [{ name: "open", videoTime: 1.5 }, { name: "no time" }],
    captions: [{ startSec: 1, endSec: 3, text: "why" }],
  });

  it("round-trips a seed through formatCut", () => {
    expect(seed.steps).toEqual([{ name: "open", at: 1.5 }]);
    expect(parseCut(JSON.parse(formatCut(seed)))).toEqual({ cut: seed });
  });

  it("explains what is wrong", () => {
    expect(parseCut({ ...seed, holds: [{ at: 1, seconds: "2" }] })).toEqual({
      error: "holds[0].seconds must be a number ≥ 0 (seconds)",
    });
    expect(parseCut({ ...seed, cuts: [{ start: 3, end: 2 }] })).toEqual({
      error: "cuts[0].end must be after its start",
    });
    expect(parseCut({ ...seed, voice: { name: "Ava" } })).toEqual({
      error: "voice.name needs voice.narrator to say whose voice it is",
    });
    expect(parseCut({ ...seed, hold: [] })).toEqual({
      error: 'unknown key "hold" — did you mean "holds"?',
    });
    expect(
      parseCut({ ...seed, narration: [{ at: 1, text: "hi", voice: "Ava" }] })
    ).toEqual({
      error:
        'narration[0]: unknown key "voice" (expected at, text, audio, caption)',
    });
    expect(parseCut({ ...seed, narration: [{ at: 1, text: " " }] })).toEqual({
      error: "narration[0] needs text to speak or an audio file",
    });
  });
});

describe("cutVideoFilter", () => {
  it("is empty for the identity plan", () => {
    expect(cutVideoFilter(planCut({ cuts: [], holds: [] }, SOURCE))).toBe("");
  });

  it("keeps frames, renumbers, and repeats a frame for each hold", () => {
    // The plan the end-to-end render used: a 6s cut, a 2s hold, a tail hold.
    const plan = extendTail(
      planCut(
        { cuts: [{ start: 6, end: 12 }], holds: [{ at: 23.36, seconds: 2 }] },
        { durationSec: 28.88, fps: 25 }
      ),
      1.4
    );
    expect(cutVideoFilter(plan)).toBe(
      "fps=25,select='(between(n,0,149)+between(n,300,721))',setpts=N/FRAME_RATE/TB,loop=loop=35:size=1:start=571,loop=loop=50:size=1:start=433,setpts=N/FRAME_RATE/TB"
    );
  });

  it("freezes the first frame of a piece for a start hold", () => {
    const plan = planCut(
      { cuts: [{ start: 0, end: 2 }], holds: [{ at: 2, seconds: 1 }] },
      SOURCE
    );
    expect(cutVideoFilter(plan)).toBe(
      "fps=25,select='between(n,50,499)',setpts=N/FRAME_RATE/TB,loop=loop=25:size=1:start=0,setpts=N/FRAME_RATE/TB"
    );
  });

  it("does not renumber twice when nothing is held", () => {
    const plan = planCut({ cuts: [{ start: 2, end: 4 }], holds: [] }, SOURCE);
    expect(cutVideoFilter(plan)).toBe(
      "fps=25,select='(between(n,0,49)+between(n,100,499))',setpts=N/FRAME_RATE/TB"
    );
  });
});

describe("speedups", () => {
  // 25fps: 4s→8s at 4x is frames 100..199, every 4th kept = 25 frames = 1s.
  const fast = {
    cuts: [],
    holds: [],
    speedups: [{ start: 4, end: 8, rate: 4 }],
  };

  it("plays a sped-up range in a whole number of kept frames", () => {
    const plan = planCut(fast, SOURCE);
    expect(plan.identity).toBe(false);
    expect(plan.pieces.map((p) => [p.srcStart, p.srcEnd, p.rate])).toEqual([
      [0, 4, undefined],
      [4, 8, 4],
      [8, 20, undefined],
    ]);
    expect(plan.outDurationSec).toBe(17);
  });

  it("maps times inside and after the speed-up", () => {
    const plan = planCut(fast, SOURCE);
    // Offset 50 frames; the first kept frame at or after it is the 13th.
    expect(mapTime(plan, 6)).toEqual({ out: 4.52, removed: false });
    expect(mapTime(plan, 10)).toEqual({ out: 7, removed: false });
  });

  it("keeps every rate-th frame of the range in the filter", () => {
    expect(cutVideoFilter(planCut(fast, SOURCE))).toBe(
      "fps=25,select='(between(n,0,99)+(between(n,100,199)*not(mod(n-100,4))+between(n,200,499)))',setpts=N/FRAME_RATE/TB"
    );
  });

  it("keeps a hold inside a speed-up on the right frame", () => {
    const plan = planCut(
      {
        cuts: [],
        holds: [{ at: 6, seconds: 1 }],
        speedups: [{ start: 4, end: 8, rate: 2 }],
      },
      SOURCE
    );
    // 4→6 at 2x is 25 frames (1s), then the 1s hold, then 6→8 at 2x.
    expect(mapTime(plan, 6).out).toBe(5);
    expect(plan.outDurationSec).toBe(4 + 1 + 1 + 1 + 12);
  });

  it("holds a caption for its own length over fast footage", () => {
    const plan = planCut(fast, SOURCE);
    const cues = outputCaptions({
      plan,
      captions: [{ start: 4, end: 7, text: "detour" }],
      lines: [],
      warnings: [],
    });
    expect(cues).toEqual([{ start: 4, end: 7, text: "detour" }]);
  });

  it("refuses fractional, too-fast, and overlapping rates", () => {
    const seed = seedCut({ video: "page.webm", steps: [], captions: [] });
    expect(
      parseCut({ ...seed, speedups: [{ start: 1, end: 2, rate: 2.5 }] })
    ).toEqual({
      error: "speedups[0].rate must be a whole number from 2 to 8",
    });
    expect(
      parseCut({ ...seed, speedups: [{ start: 1, end: 2, rate: 1 }] })
    ).toEqual({
      error: "speedups[0].rate must be a whole number from 2 to 8",
    });
    expect(
      parseCut({
        ...seed,
        speedups: [
          { start: 1, end: 5, rate: 2 },
          { start: 4, end: 6, rate: 3 },
        ],
      })
    ).toEqual({
      error: "speedups overlap at 4.00s — merge them or pick one rate",
    });
  });
});

describe("seedSpeedups", () => {
  it("speeds up a run of skimmed steps up to the next unskimmed one", () => {
    expect(
      seedSpeedups({
        steps: [
          { videoTime: 0 },
          { videoTime: 10, skim: true },
          { videoTime: 30, skim: true },
          { videoTime: 74 },
        ],
        captions: [],
        durationSec: 90,
      })
    ).toEqual([{ start: 10, end: 74, rate: 8 }]);
  });

  it("speeds up long uncaptioned stretches when the run captions anything", () => {
    expect(
      seedSpeedups({
        steps: [],
        captions: [
          { startSec: 2, endSec: 5 },
          { startSec: 9, endSec: 12 },
        ],
        durationSec: 30,
      })
    ).toEqual([{ start: 13, end: 30, rate: 4 }]);
  });

  it("leaves a run with no captions at real speed", () => {
    expect(
      seedSpeedups({
        steps: [{ videoTime: 0 }],
        captions: [],
        durationSec: 300,
      })
    ).toEqual([]);
  });
});
