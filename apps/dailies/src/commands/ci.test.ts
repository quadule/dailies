import { describe, expect, it, vi } from "vitest";
import { ciMetrics } from "./ci.js";

function captureStdout(run: () => void): string {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe("ci metrics", () => {
  it("renders one line per current metric, prefixed", () => {
    const out = captureStdout(() =>
      ciMetrics({ current: "duration=12 steps=4", prefix: "- " })
    );
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.startsWith("- ")).toBe(true);
    }
  });

  it("compares against the previous run's values", () => {
    const withPrev = captureStdout(() =>
      ciMetrics({ current: "duration=12", previous: "duration=20", prefix: "" })
    );
    const withoutPrev = captureStdout(() =>
      ciMetrics({ current: "duration=12", prefix: "" })
    );
    // A previous value must change the rendering — otherwise the delta the PR
    // comment advertises is not actually being computed.
    expect(withPrev).not.toBe(withoutPrev);
  });

  it("writes nothing when there are no metrics, so the caller can guard on empty", () => {
    expect(captureStdout(() => ciMetrics({ current: "", prefix: "- " }))).toBe(
      ""
    );
  });

  it("returns 0 so a metric-less run never fails the pipeline", () => {
    expect(ciMetrics({ current: "", prefix: "" })).toBe(0);
  });
});
