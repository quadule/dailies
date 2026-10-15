import { describe, expect, it } from "vitest";
import { buildChapters, captionsByStep } from "./chapters.js";
import type { ManifestStep } from "./manifest.js";

function step(
  name: string,
  second: number,
  extra: Partial<ManifestStep> = {}
): ManifestStep {
  return {
    actions: [],
    durationMs: 500,
    exitCode: extra.status === "fail" ? 1 : 0,
    name,
    startedAt: `2026-10-14T10:00:${String(second).padStart(2, "0")}.000Z`,
    status: "pass",
    ...extra,
  };
}

function caption(second: number, text: string) {
  return {
    at: `2026-10-14T10:00:${String(second).padStart(2, "0")}.080Z`,
    durationMs: 3000,
    text,
  };
}

describe("captionsByStep", () => {
  it("gives each caption to the last step started by then", () => {
    const steps = [step("a", 1), step("b", 5), step("c", 9)];
    const byStep = captionsByStep(steps, [
      caption(5, "during b"),
      // Between steps: belongs with the step before, not the next one.
      caption(7, "after b"),
      caption(0, "before anything"),
    ]);
    expect(byStep.get(0)).toEqual(["before anything"]);
    expect(byStep.get(1)).toEqual(["during b", "after b"]);
    expect(byStep.has(2)).toBe(false);
  });

  it("ignores blank and unparseable captions", () => {
    const byStep = captionsByStep(
      [step("a", 1)],
      [{ at: "nope", durationMs: 1, text: "x" }, caption(2, "  ")]
    );
    expect(byStep.size).toBe(0);
  });
});

describe("buildChapters", () => {
  it("opens a chapter at each captioned step and folds the rest under it", () => {
    const steps = [
      step("setup", 1),
      step("open-form", 2),
      step("fill", 3),
      step("submit", 4),
      step("check", 5),
    ];
    const chapters = buildChapters(steps, [
      caption(2, "Open the form"),
      caption(4, "Submit it"),
      caption(4, "and it saves"),
    ]);
    expect(chapters.map((c) => [c.title, c.steps])).toEqual([
      [undefined, [0]],
      ["Open the form", [1, 2]],
      ["Submit it", [3, 4]],
    ]);
    expect(chapters[2]?.notes).toEqual(["and it saves"]);
  });

  it("keeps a run with no captions as one untitled chapter", () => {
    const chapters = buildChapters([step("a", 1), step("b", 2)], []);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBeUndefined();
    expect(chapters[0]?.items).toEqual([
      { index: 0, kind: "step" },
      { index: 1, kind: "step" },
    ]);
  });

  it("groups failed attempts with the step that got past them", () => {
    // Retries rarely share a name, so position decides the group.
    const steps = [
      step("sign-i9", 1, { status: "fail" }),
      step("type-signature", 2, { status: "fail" }),
      step("check-dialog", 3),
      step("next", 4),
      step("give-up", 5, { status: "fail" }),
    ];
    const [chapter] = buildChapters(steps, [caption(1, "Sign the I-9")]);
    expect(chapter?.items).toEqual([
      { failed: [0, 1], kind: "attempts", outcome: 2 },
      { index: 3, kind: "step" },
      // Nothing after it in the chapter: an unrecovered failure stays a row.
      { index: 4, kind: "step" },
    ]);
  });

  it("never lets an attempt group cross into the next chapter", () => {
    const steps = [step("a", 1, { status: "fail" }), step("b", 2)];
    const chapters = buildChapters(steps, [
      caption(1, "First"),
      caption(2, "Second"),
    ]);
    expect(chapters[0]?.items).toEqual([{ index: 0, kind: "step" }]);
    expect(chapters[1]?.items).toEqual([{ index: 1, kind: "step" }]);
  });

  it("folds runs of skimmed steps, but not a lone one or a failure", () => {
    const steps = [
      step("login", 1, { skim: true }),
      step("retry-login", 2, { skim: true, status: "fail" }),
      step("login-again", 3, { skim: true }),
      step("seed", 4, { skim: true }),
      step("the-feature", 5),
      step("cleanup", 6, { skim: true }),
      step("broken-setup", 7, { skim: true, status: "fail" }),
    ];
    const [chapter] = buildChapters(steps, []);
    expect(chapter?.items).toEqual([
      {
        items: [
          { index: 0, kind: "step" },
          { failed: [1], kind: "attempts", outcome: 2 },
          { index: 3, kind: "step" },
        ],
        kind: "skim",
      },
      { index: 4, kind: "step" },
      { index: 5, kind: "step" },
      { index: 6, kind: "step" },
    ]);
  });
});
