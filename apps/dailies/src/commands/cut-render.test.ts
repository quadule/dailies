import { describe, expect, it } from "vitest";
import type { CutRenderResult } from "../edit/render.js";
import { timelineLines } from "./cut-render.js";

function result(stepCount: number, extra: Partial<CutRenderResult> = {}) {
  return {
    captions: [],
    cuts: [],
    durationSec: stepCount,
    holds: [],
    lines: [],
    notes: [],
    sourceDurationSec: stepCount,
    speedups: [],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      at: i,
      name: `step-${i}`,
    })),
    videoPath: "/v.mp4",
    warnings: [],
    ...extra,
  } satisfies CutRenderResult;
}

describe("timelineLines", () => {
  it("lists every step and edit for a short run", () => {
    const lines = timelineLines(
      result(3, { cuts: [{ end: 2, outAt: 1.5, start: 1.5 }] })
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("step     step-0");
    expect(lines[2]).toContain("cut      0.5s removed");
  });

  it("lists only the edits, with the step on screen, for a long run", () => {
    const lines = timelineLines(
      result(200, {
        captions: [{ end: 4, start: 1, text: "hello" }],
        holds: [{ at: 50.2, outAt: 50.2, seconds: 1.5 }],
      })
    );
    expect(lines).toEqual([
      "200 steps and 1 caption placed (--json lists each). Edits:",
      "    0:50.2  hold     1.5s freeze (written at 50.20)   · during step-50",
    ]);
  });

  it("says so when a long run has no edits", () => {
    expect(timelineLines(result(60))[1]).toContain("(none");
  });
});
