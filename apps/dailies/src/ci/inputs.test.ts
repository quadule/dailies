import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readComments, readTextInput } from "./inputs.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dailies-ci-inputs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("optional CI input files", () => {
  it("preserves multiline text and NUL bytes", async () => {
    const file = join(dir, "body");
    const body = 'A PR\'s body\nwith "quotes"\0and a final newline\n';
    await writeFile(file, body);
    expect(await readTextInput(file)).toBe(body);
  });

  it("fails open for absent and unreadable files", async () => {
    for (const file of [undefined, join(dir, "missing"), dir]) {
      expect(await readTextInput(file)).toBe("");
      expect(await readComments(file)).toEqual([]);
    }
  });

  it("keeps valid comment bodies in order, including empty strings", async () => {
    const file = join(dir, "comments.json");
    await writeFile(file, JSON.stringify(["first", null, 12, "", {}, "last"]));
    expect(await readComments(file)).toEqual(["first", "", "last"]);
  });

  it.each([
    "",
    "{broken",
    "null",
    "{}",
    '"a comment"',
  ])("ignores malformed comment input (%j)", async (raw) => {
    const file = join(dir, "comments.json");
    await writeFile(file, raw);
    expect(await readComments(file)).toEqual([]);
  });
});
