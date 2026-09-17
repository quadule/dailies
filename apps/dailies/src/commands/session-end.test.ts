import { describe, expect, it } from "vitest";

import type { SessionRecord, SessionStep } from "../session/registry.js";
import {
  captionCues,
  captionKeepWindows,
  captionReadMs,
  contentStartFloorSec,
  isDegradedEnd,
  matchRequestedVideo,
  promotePrimaryVideo,
  STEP_PAD_AFTER_SEC,
  STEP_PAD_BEFORE_SEC,
  stepKeepWindows,
  videoLabel,
  videosByPrimacy,
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

describe("captionReadMs", () => {
  it("treats the requested duration as a floor, not a ceiling", () => {
    // A long sentence asked to show for 500ms is unreadable no matter what the
    // caller wanted.
    const long =
      "Selecting a non-system-dated payment method unlocks the payment date field for editing";
    expect(captionReadMs(long, 500)).toBeGreaterThan(500);
  });

  it("honors a generous requested duration", () => {
    expect(captionReadMs("Short", 6000)).toBe(6000);
  });

  it("caps the floor so one caption cannot hold the whole cut", () => {
    const wall = `${"word ".repeat(400)}`;
    expect(captionReadMs(wall, 0)).toBe(8000);
  });

  it("handles an empty caption without dividing by zero", () => {
    expect(Number.isFinite(captionReadMs("", 0))).toBe(true);
  });
});

describe("captionKeepWindows", () => {
  const record = recordWith([]);

  it("places a caption window at its wall-clock offset into the video", () => {
    // Same clock basis as stepKeepWindows: caption time minus createdAt.
    const windows = captionKeepWindows(record, [
      { at: "2026-06-02T10:00:12.000Z", durationMs: 3000, text: "Hi" },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.start).toBe(12);
    expect(windows[0]?.end).toBeGreaterThanOrEqual(15);
  });

  it("extends a window that was asked to be shorter than it is readable", () => {
    const windows = captionKeepWindows(record, [
      {
        at: "2026-06-02T10:00:12.000Z",
        durationMs: 200,
        text: "Selecting a non-system-dated method unlocks the payment date field",
      },
    ]);
    expect(windows).toHaveLength(1);
    expect((windows[0]?.end ?? 0) - (windows[0]?.start ?? 0)).toBeGreaterThan(
      0.2
    );
  });

  it("skips a caption with an unparseable timestamp rather than throwing", () => {
    expect(
      captionKeepWindows(record, [
        { at: "not a date", durationMs: 3000, text: "Hi" },
      ])
    ).toEqual([]);
  });

  it("returns nothing when there are no captions", () => {
    expect(captionKeepWindows(record, [])).toEqual([]);
  });
});

describe("captionCues", () => {
  const record = recordWith([]);
  const at = (sec: number) =>
    new Date(Date.parse(CREATED_AT) + sec * 1000).toISOString();

  it("passes times through unmapped when nothing was condensed", () => {
    const cues = captionCues(
      record,
      [{ at: at(5), durationMs: 3000, text: "Hi" }],
      undefined
    );
    expect(cues[0]?.startSec).toBe(5);
  });

  it("ends a caption where the next one begins", () => {
    // showCaption replaces the caption on screen, so the render has to as well
    // — two overlapping cues stack on top of each other.
    const cues = captionCues(
      record,
      [
        { at: at(0), durationMs: 9000, text: "First" },
        { at: at(2), durationMs: 3000, text: "Second" },
      ],
      undefined
    );
    expect(cues[0]?.endSec).toBe(2);
    expect(cues[1]?.startSec).toBe(2);
  });

  it("drops a caption the next one immediately supersedes", () => {
    const cues = captionCues(
      record,
      [
        { at: at(4), durationMs: 3000, text: "Replaced instantly" },
        { at: at(4), durationMs: 3000, text: "Winner" },
      ],
      undefined
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe("Winner");
  });
});

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

describe("videosByPrimacy", () => {
  // The case that cost a real demo its subject: a run that opened a feature-flag page
  // in a second tab, where the flag page sorted first and got the song burnt into it
  // while the page showing the feature was left silent.
  it("puts the page that kept the most footage first", () => {
    const order = videosByPrimacy([
      { bytes: 5_263_260, keptSec: 40.16 },
      { bytes: 5_550_424, keptSec: 66.92 },
    ]);

    expect(order).toEqual([1, 0]);
  });

  it("falls back to bytes when nothing could be condensed", () => {
    expect(
      videosByPrimacy([{ bytes: 100 }, { bytes: 900 }, { bytes: 500 }])
    ).toEqual([1, 2, 0]);
  });

  it("prefers a condensed video over one with no kept time at all", () => {
    // An un-condensed video is unknown, not zero: a huge raw file must not outrank
    // a page we measured.
    expect(
      videosByPrimacy([{ bytes: 9_000_000 }, { bytes: 10, keptSec: 1 }])
    ).toEqual([1, 0]);
  });

  it("leaves a single video alone", () => {
    expect(videosByPrimacy([{ bytes: 10, keptSec: 3 }])).toEqual([0]);
  });
});

describe("promotePrimaryVideo", () => {
  // The comparator was right the first time and the demo still came out wrong,
  // because the reorder lived inside the condense pass and a re-finalize skips it.
  // This exercises the plumbing: paths that do not exist cannot be probed, so it
  // falls back to bytes and stays deterministic.
  function resultWith(videos: { bytes: number; path: string }[]) {
    return {
      artifacts: [
        { bytes: 1, kind: "trace" as const, path: "/t/trace.zip" },
        ...videos.map((v) => ({ ...v, kind: "video" as const })),
        { bytes: 2, kind: "har" as const, path: "/t/network.har" },
      ],
    };
  }

  it("moves the fuller recording to the front of the artifact list", async () => {
    const result = resultWith([
      { bytes: 5_262_293, path: "/t/video/page@flags.webm" },
      { bytes: 5_550_424, path: "/t/video/page@theflow.webm" },
    ]);

    await promotePrimaryVideo(result as never);

    const videos = result.artifacts.filter((a) => a.kind === "video");
    expect(videos[0]?.path).toBe("/t/video/page@theflow.webm");
    // Non-video artifacts keep their places; only the video slots are reordered.
    expect(result.artifacts[0]?.kind).toBe("trace");
    expect(result.artifacts.at(-1)?.kind).toBe("har");
  });

  it("leaves a single-page session untouched", async () => {
    const result = resultWith([{ bytes: 10, path: "/t/video/page@only.webm" }]);
    const before = [...result.artifacts];

    await promotePrimaryVideo(result as never);

    expect(result.artifacts).toEqual(before);
  });
});

describe("matchRequestedVideo", () => {
  const videos = [
    { pageName: "flags", path: "/t/video/page@aaa.webm" },
    { pageName: "checkout", path: "/t/video/page@bbb.webm" },
    { path: "/t/video/page@ccc.webm" },
  ];

  it("finds a page by the name the script gave it", () => {
    expect(matchRequestedVideo(videos, "checkout")).toEqual([videos[1]]);
    expect(matchRequestedVideo(videos, "CheckOut")).toEqual([videos[1]]);
  });

  it("finds an unlabelled page by its filename", () => {
    expect(matchRequestedVideo(videos, "page@ccc.webm")).toEqual([videos[2]]);
    // …and by a fragment of it, so nobody has to type a full hash.
    expect(matchRequestedVideo(videos, "ccc")).toEqual([videos[2]]);
  });

  it("returns every match so the caller can refuse to guess", () => {
    // "page@" is in all three: ambiguous, and session end must say so rather
    // than pick one — guessing is the bug this flag exists to fix.
    expect(matchRequestedVideo(videos, "page@")).toHaveLength(3);
    expect(matchRequestedVideo(videos, "nothing-like-this")).toHaveLength(0);
  });

  it("prefers an exact name over a substring of another", () => {
    const pages = [
      { pageName: "cart", path: "/t/a.webm" },
      { pageName: "cart-review", path: "/t/b.webm" },
    ];
    expect(matchRequestedVideo(pages, "cart")).toEqual([pages[0]]);
  });
});

describe("videoLabel", () => {
  it("prefers the page name and falls back to the filename", () => {
    expect(videoLabel({ pageName: "checkout", path: "/t/page@bbb.webm" })).toBe(
      "checkout"
    );
    expect(videoLabel({ path: "/t/page@bbb.webm" })).toBe("page@bbb.webm");
  });
});

describe("promotePrimaryVideo with --video", () => {
  function resultWith(
    videos: { bytes: number; pageName?: string; path: string }[]
  ) {
    return {
      artifacts: [
        ...videos.map((v) => ({ ...v, kind: "video" as const })),
        { bytes: 2, kind: "har" as const, path: "/t/network.har" },
      ],
    };
  }

  it("finishes the page asked for, even when it is the shorter recording", async () => {
    // The restart case: the agent flailed on one page, then re-ran the flow clean
    // on another. The good take is the SMALLER file, so the heuristic would pick
    // wrong and only the caller knows better.
    const result = resultWith([
      {
        bytes: 9_000_000,
        pageName: "flailing",
        path: "/t/video/page@aaa.webm",
      },
      { bytes: 1_000_000, pageName: "retake", path: "/t/video/page@bbb.webm" },
    ]);

    await promotePrimaryVideo(result as never, "retake");

    expect(result.artifacts[0]?.path).toBe("/t/video/page@bbb.webm");
  });

  it("refuses an ambiguous or unknown request, naming what there is", async () => {
    const result = resultWith([
      { bytes: 10, pageName: "one", path: "/t/video/page@aaa.webm" },
      { bytes: 20, pageName: "two", path: "/t/video/page@bbb.webm" },
    ]);

    await expect(promotePrimaryVideo(result as never, "page@")).rejects.toThrow(
      /ambiguous.*one, two/s
    );
    await expect(promotePrimaryVideo(result as never, "nope")).rejects.toThrow(
      /matched no recording/
    );
  });
});
