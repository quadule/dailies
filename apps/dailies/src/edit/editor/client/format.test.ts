import { describe, expect, it } from "vitest";
import {
  clock,
  endOf,
  moveSpan,
  parseSeconds,
  resizeSpan,
  snapTime,
  span,
} from "./format.js";

const grid = { durationSec: 10, fps: 30 };

describe("clock", () => {
  it("prints m:ss.s", () => {
    expect(clock(0)).toBe("0:00.0");
    expect(clock(9.16)).toBe("0:09.2");
    expect(clock(75.04)).toBe("1:15.0");
  });

  it("carries a rounded 60 into the minutes", () => {
    expect(clock(59.96)).toBe("1:00.0");
  });

  it("prints hundredths for the stage clocks, and whole seconds", () => {
    expect(clock(12.345, 2)).toBe("0:12.35");
    expect(clock(5.4, 0)).toBe("0:05");
  });

  it("clamps negatives to zero", () => {
    expect(clock(-3)).toBe("0:00.0");
  });
});

describe("span", () => {
  it("prints a length", () => {
    expect(span(2)).toBe("2.0s");
    expect(span(1.26)).toBe("1.3s");
  });
});

describe("parseSeconds", () => {
  it("reads seconds", () => {
    expect(parseSeconds("12.5")).toBe(12.5);
    expect(parseSeconds(" 3 ")).toBe(3);
    expect(parseSeconds("4.25s")).toBe(4.25);
    expect(parseSeconds(".5")).toBe(0.5);
    expect(parseSeconds("2,5")).toBe(2.5);
  });

  it("reads minutes and hours", () => {
    expect(parseSeconds("1:02.5")).toBe(62.5);
    expect(parseSeconds("0:09.2")).toBeCloseTo(9.2);
    expect(parseSeconds("1:00:02")).toBe(3602);
  });

  it("refuses what isn't a time", () => {
    for (const bad of ["", "abc", "-1", "1:60", "1:2:3:4", "1.2.3", ":5"]) {
      expect(parseSeconds(bad), bad).toBeUndefined();
    }
  });
});

describe("snapTime", () => {
  it("snaps to the frame grid", () => {
    expect(snapTime(1.01, grid)).toBeCloseTo(30 / 30);
    expect(snapTime(1.02, grid)).toBeCloseTo(31 / 30);
  });

  it("clamps into the source", () => {
    expect(snapTime(-2, grid)).toBe(0);
    expect(snapTime(99, grid)).toBe(10);
    expect(endOf({ durationSec: 10.01, fps: 30 })).toBe(10);
  });
});

describe("moveSpan", () => {
  it("moves a range by a delta, keeping its length, on frames", () => {
    const moved = moveSpan({ start: 1, end: 3 }, 2.004, grid);
    expect(moved.start).toBeCloseTo(3);
    expect(moved.end - moved.start).toBeCloseTo(2);
  });

  it("keeps the length in whole frames while it moves", () => {
    const g = { durationSec: 22.8, fps: 25 };
    const once = moveSpan({ start: 18.661, end: 21.761 }, 0.04, g);
    const twice = moveSpan(once, 1, g);
    expect(once.end - once.start).toBeCloseTo(3.08);
    expect(twice.end - twice.start).toBeCloseTo(3.08);
    expect(twice.end).toBeCloseTo(22.8);
  });

  it("stops at the ends of the source", () => {
    expect(moveSpan({ start: 1, end: 3 }, -5, grid)).toEqual({
      start: 0,
      end: 2,
    });
    const late = moveSpan({ start: 7, end: 9 }, 5, grid);
    expect(late.start).toBeCloseTo(8);
    expect(late.end).toBeCloseTo(10);
  });

  it("stays inside bounds a neighbour sets", () => {
    const moved = moveSpan({ start: 4, end: 5 }, 3, grid, { end: 6 });
    expect(moved.start).toBeCloseTo(5);
    expect(moved.end).toBeCloseTo(6);
  });
});

describe("resizeSpan", () => {
  it("moves one edge", () => {
    expect(resizeSpan({ start: 1, end: 3 }, "end", 4.5, grid)).toEqual({
      start: 1,
      end: 4.5,
    });
    expect(resizeSpan({ start: 1, end: 3 }, "start", 0.5, grid)).toEqual({
      start: 0.5,
      end: 3,
    });
  });

  it("keeps at least one frame", () => {
    const r = resizeSpan({ start: 1, end: 3 }, "start", 5, grid);
    expect(r.end - r.start).toBeCloseTo(1 / 30);
    const e = resizeSpan({ start: 1, end: 3 }, "end", 0, grid);
    expect(e.end - e.start).toBeCloseTo(1 / 30);
  });

  it("stays inside bounds", () => {
    expect(
      resizeSpan({ start: 1, end: 3 }, "end", 8, grid, { end: 5 }).end
    ).toBe(5);
    expect(
      resizeSpan({ start: 4, end: 6 }, "start", 1, grid, { start: 3 }).start
    ).toBe(3);
  });
});
