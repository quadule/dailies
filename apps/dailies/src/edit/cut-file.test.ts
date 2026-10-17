import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Cut, formatCut } from "./cut.js";
import { cutPath, readCut, writeCut } from "./cut-file.js";

const SESSION = "cut-file-test-0001";

function cutWith(text: string): Cut {
  return {
    version: 1,
    video: "page.webm",
    voice: {},
    steps: [],
    cuts: [],
    holds: [],
    speedups: [],
    captions: [{ start: 1, end: 2, text }],
    narration: [],
  };
}

describe("writeCut", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "dailies-cut-file-"));
    process.env.HOME = home;
    await mkdir(path.dirname(cutPath(SESSION)), { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("writes formatCut's form and leaves nothing beside it", async () => {
    const file = await writeCut(SESSION, cutWith("one"));
    expect(await readFile(file, "utf8")).toBe(formatCut(cutWith("one")));
    expect(await readdir(path.dirname(file))).toEqual(["cut.json"]);
  });

  it("keeps two writes in flight from mixing", async () => {
    const long = cutWith("x".repeat(5000));
    const short = cutWith("y");
    await Promise.all([writeCut(SESSION, long), writeCut(SESSION, short)]);
    const read = await readCut(SESSION);
    expect("cut" in read).toBe(true);
    const text = await readFile(cutPath(SESSION), "utf8");
    expect([formatCut(long), formatCut(short)]).toContain(text);
    expect(await readdir(path.dirname(cutPath(SESSION)))).toEqual(["cut.json"]);
  });
});
