import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSessionArtifacts } from "../src/artifacts.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dailies-artifacts-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

async function file(name: string, body = "evidence"): Promise<void> {
  const target = path.join(dir, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

describe("collectSessionArtifacts", () => {
  it("discovers all artifact kinds in report order with their current sizes", async () => {
    await Promise.all(
      [
        "trace.zip",
        "network.har",
        "console.log",
        "video/page.webm",
        "screenshots/open.png",
        "attachments/coverage.html",
      ].map((name) => file(name))
    );

    const artifacts = await collectSessionArtifacts(dir);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "trace",
      "har",
      "console",
      "video",
      "screenshot",
      "attachment",
    ]);
    expect(artifacts.every((artifact) => artifact.bytes === 8)).toBe(true);
    expect(artifacts.every((artifact) => path.isAbsolute(artifact.path))).toBe(
      true
    );
  });

  it("honors live capture flags while retaining screenshots and attachments", async () => {
    await Promise.all(
      [
        "trace.zip",
        "network.har",
        "console.log",
        "video/page.webm",
        "screenshots/open.png",
        "attachments/coverage.html",
      ].map((name) => file(name))
    );
    const artifacts = await collectSessionArtifacts(dir, {
      console: false,
      har: false,
      trace: false,
      video: false,
    });
    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "screenshot",
      "attachment",
    ]);
  });

  it("excludes working copies, wrong extensions, folders, and attachment cruft", async () => {
    await Promise.all([
      file("video/page.webm", ""),
      file("video/page.precinematic.webm"),
      file("video/notes.txt"),
      file("screenshots/open.png"),
      file("screenshots/open.precinematic.png"),
      file("attachments/coverage.html"),
      file("attachments/.metadata"),
      file("attachments/empty.txt", ""),
      file("attachments/nested/report.html"),
      mkdir(path.join(dir, "video", "directory.webm"), { recursive: true }),
    ]);
    const artifacts = await collectSessionArtifacts(dir);
    expect(
      artifacts.map((artifact) => path.relative(dir, artifact.path))
    ).toEqual([
      path.join("video", "page.webm"),
      path.join("screenshots", "open.png"),
      path.join("attachments", "coverage.html"),
    ]);
    // Empty capture files are still evidence of a partial run; only empty
    // attachments are intentionally omitted.
    expect(artifacts[0]?.bytes).toBe(0);
  });

  it("recovers surviving artifacts beside missing files and non-files", async () => {
    await file("screenshots/open.png");
    await mkdir(path.join(dir, "trace.zip"));
    const artifacts = await collectSessionArtifacts(dir);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["screenshot"]);
    expect(await collectSessionArtifacts(path.join(dir, "absent"))).toEqual([]);
  });
});
