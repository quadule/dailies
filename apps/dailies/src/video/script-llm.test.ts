import { describe, expect, it } from "vitest";
import {
  type CinematicStep,
  groupStepsForLyrics,
  stepFootageSec,
} from "./narrate.js";
import {
  buildLyricsPrompt,
  buildNarrationPrompt,
  isSetupStep,
  planLyricGroups,
  stepNameTokens,
} from "./script-llm.js";

// narrate.ts's GROUP_MIN_SEC, which isn't exported. Kept in sync by hand; the
// tests below only need A threshold, not THE threshold.
const GROUP_MIN_SEC = 7;

const named = (names: string[]) => names.map((name) => ({ name }));

describe("stepNameTokens", () => {
  it("splits kebab, snake, dotted, spaced and camelCase names alike", () => {
    expect(stepNameTokens("click-developer-login")).toEqual([
      "click",
      "developer",
      "login",
    ]);
    expect(stepNameTokens("choose_company_admin")).toEqual([
      "choose",
      "company",
      "admin",
    ]);
    expect(stepNameTokens("clickDeveloperLogin")).toEqual([
      "click",
      "developer",
      "login",
    ]);
    expect(stepNameTokens("Wait 2s / settle")).toEqual([
      "wait",
      "2s",
      "settle",
    ]);
    expect(stepNameTokens("   ")).toEqual([]);
  });
});

describe("isSetupStep", () => {
  it("classifies the plumbing of getting into the app", () => {
    for (const name of [
      "goto-root",
      "click-developer-login",
      "choose-company-admin-and-sign-in",
      "navigate-to-app",
      "visit-home-page",
      "log-in-as-test-user",
      "signin",
      "select-company",
      "pick-role",
      "switch-workspace",
      "wait-for-network-idle",
      "wait-2s",
      "retry-load",
      "settle",
      "snapshot-dom",
      "inspect-selectors",
      "debug-dump",
      "screenshot-page",
    ]) {
      expect(isSetupStep({ name }), name).toBe(true);
    }
  });

  it("leaves the beats of the product story alone", () => {
    for (const name of [
      "click-startwork",
      "click-display-button",
      "check-display-menu-state",
      "reset-columns-to-default",
      "recheck-headers-after-reset",
      "click-columns-submenu",
      "open-display-and-columns",
      "uncheck-approval-workflow-column",
      "apply-column-change",
      "verify-table-headers-updated",
      "confirm-result",
    ]) {
      expect(isSetupStep({ name }), name).toBe(false);
    }
  });

  it("does not fall for names that merely LOOK like setup", () => {
    // These are the false positives that matter: each one silently deletes a
    // real beat from the film if it's swept into a setup run.
    // Token equality, not substring: "logo" is not "login", "log" is not "log in".
    expect(isSetupStep({ name: "check-logo-visible" })).toBe(false);
    expect(isSetupStep({ name: "open-audit-log" })).toBe(false);
    expect(isSetupStep({ name: "verify-login-error-message" })).toBe(false);
    // A real marker, but the name also names something in the PRODUCT.
    expect(isSetupStep({ name: "waiting-list-signup" })).toBe(false);
    expect(isSetupStep({ name: "navigate-to-column-settings" })).toBe(false);
    expect(isSetupStep({ name: "wait-for-invoice-total" })).toBe(false);
    expect(isSetupStep({ name: "goto-timecard-approvals" })).toBe(false);
    // Half an identity pair is not a pair.
    expect(isSetupStep({ name: "verify-admin-can-delete-row" })).toBe(false);
    expect(isSetupStep({ name: "switch-the-invoice-view" })).toBe(false);
    expect(isSetupStep({ name: "company-admin" })).toBe(false);
    // Nothing to go on.
    expect(isSetupStep({ name: "" })).toBe(false);
  });

  it("ignores the step's script — it can only promote false positives", () => {
    // A product beat's script navigates and fills fields too, so the name is the
    // only signal consulted.
    expect(
      isSetupStep({
        name: "apply-column-change",
        script: "await page.goto('/login'); await page.fill('#password', 'x')",
      })
    ).toBe(false);
  });
});

describe("planLyricGroups", () => {
  // Call the real footage grouper; only the collapse is under test.
  const plan = (names: string[], footageSec: number[]) =>
    planLyricGroups({
      footageSec,
      group: groupStepsForLyrics,
      minSec: GROUP_MIN_SEC,
      steps: named(names),
    });

  it("collapses a leading setup run into ONE group, however long its footage", () => {
    // The session that prompted this: 3 setup steps (~19s) then 11 product steps.
    // Before, the footage grouper spent two groups — two sung lines — on the
    // first three.
    const names = [
      "goto-root",
      "click-developer-login",
      "choose-company-admin-and-sign-in",
      "click-startwork",
      "click-display-button",
      "check-display-menu-state",
      "reset-columns-to-default",
      "recheck-headers-after-reset",
      "click-columns-submenu",
      "open-display-and-columns",
      "uncheck-approval-workflow-column",
      "apply-column-change",
      "verify-table-headers-updated",
      "confirm-result",
    ];
    const footage = [4, 6, 9, 5, 4, 3, 5, 3, 4, 5, 6, 4, 5, 4];
    expect(groupStepsForLyrics(footage, GROUP_MIN_SEC).slice(0, 2)).toEqual([
      [0, 1],
      [2],
    ]);
    const groups = plan(names, footage);
    expect(groups[0]).toEqual([0, 1, 2]);
    // Every later group is product-only: the sign-in never drags a real beat in.
    expect(groups.slice(1).flat()).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("collapses a consecutive setup run mid-flow too", () => {
    const groups = plan(
      [
        "click-display-button",
        "wait-for-network-idle",
        "snapshot-dom",
        "apply-column-change",
      ],
      [8, 2, 2, 8]
    );
    expect(groups).toEqual([[0], [1, 2], [3]]);
  });

  it("leaves a LONE setup step to the footage grouper", () => {
    // On its own it already costs at most one line, and giving it its own group
    // would sometimes cost more. This is also what makes one misclassified step
    // a no-op.
    const names = ["goto-root", "click-display-button", "apply-column-change"];
    const footage = [3, 3, 3];
    expect(plan(names, footage)).toEqual(
      groupStepsForLyrics(footage, GROUP_MIN_SEC)
    );
  });

  it("falls back to plain grouping when the whole session is plumbing", () => {
    // A login-only recording would otherwise become a one-line song.
    const names = ["goto-root", "click-developer-login", "wait-for-app"];
    const footage = [8, 8, 8];
    expect(plan(names, footage)).toEqual(
      groupStepsForLyrics(footage, GROUP_MIN_SEC)
    );
  });

  it("always partitions every step index, in order, exactly once", () => {
    // Song re-timing indexes holds/onsets BY STEP, so a dropped or reordered
    // index silently desyncs the footage from the vocals.
    const cases: [string[], number[]][] = [
      [[], []],
      [["goto-root"], [3]],
      [
        ["goto-root", "sign-in"],
        [3, 3],
      ],
      [
        ["goto-root", "sign-in", "apply-column-change"],
        [3, 3, 3],
      ],
      [
        [
          "goto-root",
          "sign-in",
          "click-display-button",
          "wait-2s",
          "snapshot-dom",
          "verify-table-headers-updated",
        ],
        [2, 9, 1, 1, 1, 20],
      ],
    ];
    for (const [names, footage] of cases) {
      const groups = plan(names, footage);
      expect(groups.flat(), names.join(",")).toEqual(
        Array.from({ length: names.length }, (_, i) => i)
      );
      for (const g of groups) {
        expect(g.length, names.join(",")).toBeGreaterThan(0);
      }
    }
  });

  it("takes a session's own steps as-is — the narrate.ts call site, typed", () => {
    const steps: CinematicStep[] = [
      { name: "goto-root", durationMs: 4000, videoTime: 0 },
      { name: "click-developer-login", durationMs: 6000, videoTime: 4 },
      {
        name: "choose-company-admin-and-sign-in",
        durationMs: 9000,
        videoTime: 10,
      },
      {
        name: "uncheck-approval-workflow-column",
        durationMs: 8000,
        videoTime: 19,
      },
    ];
    expect(
      planLyricGroups({
        footageSec: stepFootageSec(steps),
        group: groupStepsForLyrics,
        minSec: GROUP_MIN_SEC,
        steps,
      })
    ).toEqual([[0, 1, 2], [3]]);
  });

  it("tolerates a short footage list rather than dropping steps", () => {
    const groups = plan(
      ["goto-root", "sign-in", "apply-column-change"],
      [3, 3]
    );
    expect(groups.flat()).toEqual([0, 1, 2]);
  });
});

describe("prompt aim: the feature, not the login", () => {
  const steps = [
    { index: 0, name: "goto-root", script: "await page.goto('/')" },
    { index: 1, name: "uncheck-approval-workflow-column" },
  ];

  it("tells the lyricist that getting in costs at most one line", () => {
    const prompt = buildLyricsPrompt({
      direction: "sea shanty",
      steps,
      videoSeconds: 40,
    });
    expect(prompt).toContain("Getting INTO the app is never the point");
    expect(prompt).toContain("Exactly ONE line covers that whole stretch");
    expect(prompt).toContain("the FEATURE being exercised");
    expect(prompt).toContain("what a viewer can SEE change on screen");
  });

  it("tells the narrator the same thing", () => {
    const prompt = buildNarrationPrompt({ direction: "noir", steps });
    expect(prompt).toContain("Getting INTO the app is never the point");
    expect(prompt).toContain("gets ONE line");
    expect(prompt).toContain("the FEATURE being exercised");
  });

  it("requires an orienting opening line that says what is being tested", () => {
    // Skipping the login stretch entirely left the first ~17s of a real demo
    // silent: an un-narrated step still plays its footage IN FULL (planRetime only
    // ever extends footage to fit a line, never shortens it), so "no line" buys no
    // time back — it just removes the voice. The setup stretch gets exactly one
    // line, and that line is the one that orients the viewer.
    for (const prompt of [
      buildNarrationPrompt({ direction: "noir", steps }),
      buildLyricsPrompt({ direction: "sea shanty", steps, videoSeconds: 40 }),
    ]) {
      expect(prompt).toMatch(/OPEN by (saying|naming) what is being tested/);
      expect(prompt).toContain("FIRST line must orient");
    }
  });

  it("warns the narrator against leaving a long silent stretch", () => {
    const prompt = buildNarrationPrompt({ direction: "noir", steps });
    expect(prompt).toContain("Do NOT leave a long stretch with no voice");
    expect(prompt).toContain("still plays its footage in full");
  });

  it("steers only what the lines are ABOUT, never the creative direction", () => {
    // The random theme + style draw is a project goal (see AGENTS.md); nothing
    // added here may pin a theme, genre, mood or tone.
    const lyrics = buildLyricsPrompt({
      direction: "sea shanty",
      steps,
      videoSeconds: 40,
    });
    const narration = buildNarrationPrompt({ direction: "noir", steps });
    for (const prompt of [lyrics, narration]) {
      for (const word of [
        "upbeat",
        "serious",
        "dramatic score",
        "cheerful",
        "corporate",
        "professional tone",
      ]) {
        expect(prompt).not.toContain(word);
      }
    }
    // The direction the caller passed is still the only creative steer.
    expect(lyrics).toContain("sea shanty");
    expect(narration).toContain("Creative direction: noir");
  });

  it("stays deterministic for the same inputs", () => {
    expect(buildNarrationPrompt({ direction: "noir", steps })).toEqual(
      buildNarrationPrompt({ direction: "noir", steps })
    );
    expect(
      buildLyricsPrompt({ direction: "noir", steps, videoSeconds: 40 })
    ).toEqual(
      buildLyricsPrompt({ direction: "noir", steps, videoSeconds: 40 })
    );
  });
});
