import { type SessionEndResult, sessionStepSlug } from "dailies-protocol";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../session/registry.js";
import { buildManifest } from "./manifest.js";
import type { TraceAction } from "./parse-trace.js";
import { renderReport } from "./render-report.js";

const DIR = "/sessions/s1";
const INJECT = "<script>alert(1)</script>";
// Screenshots are keyed by the step's slug (the daemon writes <slug>.png and
// render-report looks it up by sessionStepSlug(step.name)).
const LOGIN_SLUG = sessionStepSlug("login");

function fixtureManifest(extra?: {
  actionsByStep?: Record<string, TraceAction[]>;
  scripts?: Record<string, string>;
  withVideo?: boolean;
}) {
  const record: SessionRecord = {
    artifactsDir: DIR,
    browser: "__session__s1",
    capture: {
      console: true,
      full: false,
      har: true,
      trace: true,
      video: false,
    },
    createdAt: "2026-06-02T10:00:00.000Z",
    endedAt: "2026-06-02T10:00:04.000Z",
    headless: true,
    id: "s1",
    name: "checkout",
    schemaVersion: 1,
    status: "ended",
    steps: [
      {
        durationMs: 800,
        exitCode: 0,
        name: "login",
        ok: true,
        startedAt: "2026-06-02T10:00:01.000Z",
      },
      {
        durationMs: 500,
        exitCode: 1,
        name: INJECT,
        ok: false,
        startedAt: "2026-06-02T10:00:02.000Z",
      },
    ],
  };
  const endResult: SessionEndResult = {
    artifacts: [
      { bytes: 1234, kind: "trace", path: `${DIR}/trace.zip` },
      {
        bytes: 900,
        kind: "screenshot",
        path: `${DIR}/screenshots/${LOGIN_SLUG}.png`,
      },
    ],
    manifestPath: `${DIR}/manifest.json`,
    session: {
      artifactsDir: DIR,
      browser: "__session__s1",
      capture: record.capture,
      headless: true,
      pageCount: 0,
      phase: "ended",
      runCount: 2,
      sessionId: "s1",
      startedAt: 0,
    },
  };
  if (extra?.scripts) {
    for (const step of record.steps) {
      const text = extra.scripts[step.name];
      if (text !== undefined) {
        step.script = text;
      }
    }
  }
  if (extra?.withVideo) {
    endResult.artifacts.push({
      bytes: 4096,
      kind: "video",
      path: `${DIR}/video/page.webm`,
    });
    if (record.steps[0]) {
      record.steps[0].videoTime = 1;
    }
    if (record.steps[1]) {
      record.steps[1].videoTime = 2;
    }
  }
  return buildManifest({
    actionsByStep: extra?.actionsByStep,
    consoleErrors: 1,
    endResult,
    networkFailures: 1,
    record,
  });
}

describe("renderReport", () => {
  it("renders a self-contained report with key sections", () => {
    const html = renderReport(fixtureManifest(), {
      consoleEntries: [{ kind: "console", text: "kaboom", type: "error" }],
      parsedHar: {
        entries: [
          {
            durationMs: 300,
            method: "POST",
            status: 500,
            url: "http://x/boom",
          },
        ],
        failed: 1,
        slowest: [
          {
            durationMs: 300,
            method: "POST",
            status: 500,
            url: "http://x/boom",
          },
        ],
        total: 3,
      },
      screenshots: { [LOGIN_SLUG]: "data:image/png;base64,AAAA" },
    });

    expect(html).toContain('class="badge failed"');
    expect(html).toContain("login");
    expect(html).toContain("show-trace");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("kaboom");
    expect(html).toContain("http://x/boom");
  });

  it("puts the video in a persistent left column synced to the steps", () => {
    const html = renderReport(fixtureManifest({ withVideo: true }), {
      consoleEntries: [],
      parsedHar: { entries: [], failed: 0, slowest: [], total: 0 },
      screenshots: {},
    });
    // Persistent left column holds the (sync-able) video, not a tab.
    expect(html).toContain('class="leftcol"');
    expect(html).toContain('id="report-video"');
    expect(html).not.toContain('data-tab="videos"');
    // Steps carry their condensed-video offset for click-to-seek + highlight.
    expect(html).toContain('data-vtime="1.000"');
    expect(html).toContain('data-vtime="2.000"');
    // Page-wide script toggle (scripts collapsed by default).
    expect(html).toContain('id="scripts-toggle"');
  });

  it("renders the merged tab set (summary, steps, screenshots, videos)", () => {
    const html = renderReport(fixtureManifest(), {
      consoleEntries: [],
      parsedHar: { entries: [], failed: 0, slowest: [], total: 0 },
      screenshots: { [LOGIN_SLUG]: "data:image/png;base64,AAAA" },
    });

    expect(html).toContain('data-tab="summary"');
    expect(html).toContain('id="panel-steps"');
    expect(html).toContain('id="panel-screenshots"');
    // Video moved out of a tab into the persistent left column, synced to steps.
    expect(html).not.toContain('id="panel-videos"');
    expect(html).not.toContain('data-tab="videos"');
    expect(html).toContain('class="leftcol"');
    // execution + commands merged into the steps panel
    expect(html).not.toContain('id="panel-execution"');
    expect(html).not.toContain('id="panel-commands"');
    // list/timeline toggle + per-step timeline bar
    expect(html).toContain('data-view="timeline"');
    expect(html).toContain('class="bar pass"');
    // environment table moved into the summary panel
    expect(html).toContain("Playwright");
    // step screenshot moved into the gallery
    expect(html).toContain('id="shot-main"');
  });

  it("links steps and screenshots bidirectionally with gallery navigation", () => {
    const html = renderReport(fixtureManifest(), {
      consoleEntries: [],
      parsedHar: { entries: [], failed: 0, slowest: [], total: 0 },
      screenshots: { [LOGIN_SLUG]: "data:image/png;base64,AAAA" },
    });

    // step row -> screenshot (only the step that has one)
    expect(html).toContain(`data-goto-shot="${LOGIN_SLUG}"`);
    // screenshot caption -> step
    expect(html).toContain('id="shot-cap-link"');
    expect(html).toContain('data-goto-step="step-0"');
    expect(html).toContain(`data-step="step-0"`);
    // arrow-key handler is part of the inlined script
    expect(html).toContain("ArrowRight");
  });

  it("renders step bodies with actions, script, and escaping", () => {
    const html = renderReport(
      fixtureManifest({
        actionsByStep: {
          login: [
            {
              apiName: "Frame.goto",
              durationMs: 40,
              params: "https://x/?q=<b>",
            },
          ],
        },
        scripts: {
          login: "await page.goto('/'); // <script>alert(2)</script>",
        },
      }),
      {
        consoleEntries: [],
        parsedHar: { entries: [], failed: 0, slowest: [], total: 0 },
        screenshots: {},
      }
    );
    expect(html).toContain('id="panel-steps"');
    expect(html).toContain("Frame.goto");
    expect(html).toContain("await page.goto");
    // injected markup in the script/params is escaped, never emitted raw
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("escapes attacker-influenced content (step names, console text)", () => {
    const html = renderReport(fixtureManifest(), {
      consoleEntries: [{ kind: "pageerror", message: INJECT }],
      parsedHar: { entries: [], failed: 0, slowest: [], total: 0 },
      screenshots: {},
    });
    expect(html).not.toContain(INJECT);
    expect(html).toContain("&lt;script&gt;");
  });

  it("groups steps into chapters titled by the captions they showed", () => {
    const empty = {
      consoleEntries: [],
      parsedHar: { entries: [], failed: 0, slowest: [], total: 0 },
      screenshots: {},
    };
    const html = renderReport(fixtureManifest({ withVideo: true }), {
      ...empty,
      captions: [
        { at: "2026-06-02T10:00:01.080Z", durationMs: 3000, text: INJECT },
      ],
    });
    expect(html).toContain('class="chapter" data-ctime="1.000" open');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('id="chapters-toggle"');
    // The step ids the screenshot gallery links to survive the nesting.
    expect(html).toContain('id="step-0"');
    expect(html).toContain('id="step-1"');

    const flat = renderReport(fixtureManifest(), empty);
    expect(flat).not.toContain('class="chapter"');
    expect(flat).not.toContain('id="chapters-toggle"');
  });
});
