import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./media-files.js";

const dirs: string[] = [];

async function outputPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dailies-media-file-"));
  dirs.push(dir);
  return path.join(dir, "audio.wav");
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("writeFileAtomic", () => {
  it("replaces an existing asset with the exact returned bytes and leaves no temp", async () => {
    const outPath = await outputPath();
    await writeFile(outPath, "previous audio");
    const bytes = Buffer.from([0, 255, 10, 20]);

    await writeFileAtomic(outPath, bytes);

    expect(await readFile(outPath)).toEqual(bytes);
    expect(await readdir(path.dirname(outPath))).toEqual(["audio.wav"]);
  });

  it("preserves an existing asset when a provider returns empty media", async () => {
    const outPath = await outputPath();
    await writeFile(outPath, "previous audio");

    await expect(
      writeFileAtomic(outPath, Buffer.alloc(0), "provider returned no audio")
    ).rejects.toThrow("provider returned no audio");

    expect(await readFile(outPath, "utf8")).toBe("previous audio");
    expect(await readdir(path.dirname(outPath))).toEqual(["audio.wav"]);
  });

  it("cleans the partial write when the final rename fails", async () => {
    const outPath = await outputPath();
    await mkdir(outPath);
    await writeFile(path.join(outPath, "keep"), "existing directory");

    await expect(
      writeFileAtomic(outPath, Buffer.from("audio"))
    ).rejects.toThrow();

    expect(await readdir(path.dirname(outPath))).toEqual(["audio.wav"]);
    expect(await readFile(path.join(outPath, "keep"), "utf8")).toBe(
      "existing directory"
    );
  });
});
