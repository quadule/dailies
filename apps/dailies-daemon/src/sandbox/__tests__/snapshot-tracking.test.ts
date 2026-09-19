import { describe, expect, it } from "vitest";
import type { AriaSnapshotNode } from "../playwright-internals.js";
import { SnapshotTracker } from "../snapshot-tracking.js";

const original: AriaSnapshotNode[] = [
  {
    role: "main",
    ref: "e1",
    children: [
      { role: "heading", ref: "e2", name: "Heading", level: 1 },
      { role: "button", ref: "e3", name: "Save" },
    ],
  },
];

describe("snapshot tracking", () => {
  it("starts each document and key with a full baseline, then returns empty", () => {
    const tracker = new SnapshotTracker();
    const firstDocument = {};
    const full = tracker.render(firstDocument, "main", original);
    expect(full).toContain('heading "Heading"');
    expect(full).not.toContain("<changed>");
    expect(tracker.render(firstDocument, "main", original)).toBe("");
    expect(tracker.render(firstDocument, "another-key", original)).toBe(full);
    expect(tracker.render({}, "main", original)).toBe(full);
  });

  it("renders only the changed descendant when the surrounding structure stays", () => {
    const tracker = new SnapshotTracker();
    const document = {};
    tracker.render(document, "main", original);
    const updated = structuredClone(original);
    updated[0]!.children![1] = {
      role: "button",
      ref: "e3",
      name: "Saved",
      disabled: true,
    };

    const diff = tracker.render(document, "main", updated);
    expect(diff).toBe('- <changed> button "Saved" [disabled] [ref=e3]');
    expect(tracker.render(document, "main", updated)).toBe("");
  });

  it("keeps unchanged references as context for added and removed children", () => {
    const tracker = new SnapshotTracker();
    const document = {};
    tracker.render(document, "main", original);
    const added = structuredClone(original);
    added[0]!.children!.push({ role: "button", name: "Cancel", ref: "e4" });
    expect(tracker.render(document, "main", added)).toBe(
      '- <changed> main [ref=e1]:\n  - ref=e2 [unchanged]\n  - ref=e3 [unchanged]\n  - button "Cancel" [ref=e4]'
    );
    expect(tracker.render(document, "main", original)).toBe(
      "- <changed> main [ref=e1]:\n  - ref=e2 [unchanged]\n  - ref=e3 [unchanged]"
    );
  });

  it("does not hide a page whose last accessible root was removed", () => {
    const tracker = new SnapshotTracker();
    const document = {};
    tracker.render(document, "main", original);
    expect(tracker.render(document, "main", [])).toBe("- <changed> fragment");
    expect(tracker.render(document, "main", [])).toBe("");
  });

  it("reports reordered top-level references", () => {
    const tracker = new SnapshotTracker();
    const document = {};
    const first = { role: "button", ref: "e1", name: "First" };
    const second = { role: "button", ref: "e2", name: "Second" };
    tracker.render(document, "main", [first, second]);
    expect(tracker.render(document, "main", [second, first])).toBe(
      '- <changed> button "Second" [ref=e2]\n- <changed> button "First" [ref=e1]'
    );
  });

  it("preserves duplicate text nodes and their order", () => {
    const tracker = new SnapshotTracker();
    const document = {};
    const snapshot: AriaSnapshotNode[] = [
      { role: "main", ref: "e1", children: ["Repeated", "Repeated"] },
    ];
    tracker.render(document, "main", snapshot);
    expect(
      tracker.render(document, "main", [
        { role: "main", ref: "e1", children: ["Repeated"] },
      ])
    ).toBe("- <changed> main [ref=e1]:\n  - text: Repeated");
  });

  it("uses Playwright's escaping for names and property values", () => {
    const tracker = new SnapshotTracker();
    const document = {};
    tracker.render(document, "main", [
      { role: "link", ref: "e1", name: "Original", url: "/original" },
    ]);
    const diff = tracker.render(document, "main", [
      { role: "link", ref: "e1", name: 'A "quoted" label', url: "data: a\nb" },
    ]);
    expect(diff).toContain('link "A \\"quoted\\" label"');
    expect(diff).toContain('- /url: "data: a\\nb"');
  });
});
