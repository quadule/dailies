import { describe, expect, it } from "vitest";

import type { SessionRecord, SessionStep } from "../session/registry.js";
import {
  contentStartFloorSec,
  isDegradedEnd,
  STEP_PAD_AFTER_SEC,
  STEP_PAD_BEFORE_SEC,
  stepKeepWindows,
} from "./session-end.js";

const CREATED_AT = "2026-06-02T10:00:00.000Z";

// Expected keep-window for a step starting `startSec` into the recording and
// running `durSec` — derived from the pad constants so tweaking them doesn't
// require editing these expectations.
const windowFor = (startSec: number, durSec: number) => ({
  start: startSec - STEP_PAD_BEFORE_SEC,
  end: startSec + durSec + STEP_PAD_AFTER_SEC,
});

function recordWith(steps: SessionStep[]): SessionRecord {
  return {
    artifactsDir: "/tmp/s",
    browser: "__session__s",
    capture: { console: true, har: true, trace: true, video: true },
    createdAt: CREATED_AT,
    headless: true,
    id: "s",
    schemaVersion: 1,
    status: "ended",
    steps,
  };
}

function step(
  partial: Partial<SessionStep> & { startedAt: string }
): SessionStep {
  return {
    durationMs: 1000,
    exitCode: 0,
    name: "step",
    ok: true,
    ...partial,
  };
}

describe("isDegradedEnd", () => {
  it("is not degraded when re-finalizing an already-ended session", () => {
    // The supported re-run: the daemon dropped the session long ago, so it
    // answers "not found". Exiting non-zero here failed CI steps that had just
    // succeeded.
    expect(
      isDegradedEnd({ daemonCode: 1, hasResult: false, wasAlreadyEnded: true })
    ).toBe(false);
  });

  it("is degraded when a LIVE session could not be finalized", () => {
    expect(
      isDegradedEnd({ daemonCode: 1, hasResult: false, wasAlreadyEnded: false })
    ).toBe(true);
  });

  it("is degraded when the daemon answered ok but returned nothing", () => {
    expect(
      isDegradedEnd({ daemonCode: 0, hasResult: false, wasAlreadyEnded: false })
    ).toBe(true);
  });

  it("is not degraded on a clean end of a live session", () => {
    expect(
      isDegradedEnd({ daemonCode: 0, hasResult: true, wasAlreadyEnded: false })
    ).toBe(false);
  });
});

describe("contentStartFloorSec", () => {
  it("is 0 with no start-URL content time", () => {
    expect(contentStartFloorSec(recordWith([]))).toBe(0);
  });
  it("is the settle offset from createdAt when a start URL was used", () => {
    const record = recordWith([]);
    // 3.2s after createdAt
    record.contentStartedAt = "2026-06-02T10:00:03.200Z";
    expect(contentStartFloorSec(record)).toBeCloseTo(3.2, 3);
  });
  it("never goes negative", () => {
    const record = recordWith([]);
    record.contentStartedAt = "2026-06-02T09:59:59.000Z"; // before createdAt
    expect(contentStartFloorSec(record)).toBe(0);
  });
});

describe("stepKeepWindows", () => {
  it("maps a successful step to a padded window in video time", () => {
    const windows = stepKeepWindows(
      recordWith([
        // starts 2s into the recording, runs 1s
        step({ startedAt: "2026-06-02T10:00:02.000Z", durationMs: 1000 }),
      ])
    );
    expect(windows).toEqual([windowFor(2, 1)]);
  });

  it("drops failed steps so stuck/timed-out attempts aren't kept", () => {
    const windows = stepKeepWindows(
      recordWith([
        // a 30s timed-out login attempt (mostly frozen) — must be excluded
        step({
          startedAt: "2026-06-02T10:00:02.000Z",
          durationMs: 30_000,
          ok: false,
          exitCode: 1,
        }),
        // the attempt that worked, 1s, starting at t=33s
        step({ startedAt: "2026-06-02T10:00:33.000Z", durationMs: 1000 }),
      ])
    );
    expect(windows).toEqual([windowFor(33, 1)]);
  });

  it("returns no windows when every step failed (falls back to freezedetect)", () => {
    const windows = stepKeepWindows(
      recordWith([
        step({ startedAt: "2026-06-02T10:00:02.000Z", ok: false, exitCode: 1 }),
        step({ startedAt: "2026-06-02T10:00:05.000Z", ok: false, exitCode: 1 }),
      ])
    );
    expect(windows).toEqual([]);
  });
});
