import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { screenshotDataUris } from "./encode-screenshots.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("screenshotDataUris", () => {
  it("embeds the PNG when there is no ffmpeg or it can't encode", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dailies-shots-"));
    const shot = path.join(dir, "a.png");
    await writeFile(shot, Buffer.from([1, 2, 3]));
    const files = [
      { key: "a", path: shot },
      { key: "gone", path: path.join(dir, "missing.png") },
    ];
    const expected = { a: "data:image/png;base64,AQID" };
    expect(await screenshotDataUris(files, undefined)).toEqual(expected);
    expect(
      await screenshotDataUris(files, path.join(dir, "no-such-ffmpeg"))
    ).toEqual(expected);
  });
});
