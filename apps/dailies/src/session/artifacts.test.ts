import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endResultFromDisk } from "./artifacts.js";
import type { SessionRecord } from "./registry.js";

const fixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("dailies-daemon-client", () => ({
  sessionDir: () => fixture.dir,
  sessionManifestPath: () => `${fixture.dir}/manifest.json`,
}));

beforeEach(async () => {
  fixture.dir = await mkdtemp(path.join(tmpdir(), "dailies-recover-"));
});

afterEach(async () => {
  await rm(fixture.dir, { force: true, recursive: true });
});

function record(): SessionRecord {
  return {
    artifactsDir: fixture.dir,
    browser: "__session__recovery",
    capture: { console: false, har: false, trace: false, video: false },
    createdAt: "2026-06-02T10:00:00.000Z",
    endedAt: "2026-06-02T10:00:05.000Z",
    headless: true,
    id: "recovery",
    schemaVersion: 1,
    status: "ended",
    steps: [],
  };
}

describe("endResultFromDisk", () => {
  it("recovers recordings and page names regardless of stale capture flags", async () => {
    await mkdir(path.join(fixture.dir, "video"));
    const main = path.join(fixture.dir, "video", "a.webm");
    const other = path.join(fixture.dir, "video", "b.webm");
    const stepPages = [{ page: "checkout", step: "buy" }];
    await Promise.all([
      writeFile(main, "main"),
      writeFile(other, "other"),
      writeFile(path.join(fixture.dir, "video", "a.precinematic.webm"), "old"),
      writeFile(path.join(fixture.dir, "network.har"), "{}"),
      writeFile(
        path.join(fixture.dir, "manifest.json"),
        JSON.stringify({
          artifacts: [
            { pageName: "checkout", path: main },
            { pageName: "settings", path: other },
          ],
          stepPages,
        })
      ),
    ]);
    const result = await endResultFromDisk(record());
    expect(result.artifacts).toEqual([
      { bytes: 2, kind: "har", path: path.join(fixture.dir, "network.har") },
      { bytes: 4, kind: "video", pageName: "checkout", path: main },
      { bytes: 5, kind: "video", pageName: "settings", path: other },
    ]);
    expect(result.stepPages).toEqual(stepPages);
    expect(result.session.phase).toBe("ended");
  });

  it.each([
    "invalid json",
    "null",
    JSON.stringify({ artifacts: {}, stepPages: "invalid" }),
    JSON.stringify({ artifacts: [null, 1], stepPages: [null, { step: 1 }] }),
  ])("retains surviving evidence with malformed manifest metadata: %s", async (raw) => {
    await writeFile(path.join(fixture.dir, "network.har"), "{}");
    await writeFile(path.join(fixture.dir, "manifest.json"), raw);
    const result = await endResultFromDisk({ ...record(), status: "aborted" });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe("har");
    expect(result.session.phase).toBe("aborted");
  });
});
