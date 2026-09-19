import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readScript } from "./script-input.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dailies-script-input-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("execution script input", () => {
  it("preserves the exact script recorded for replay", async () => {
    const file = join(dir, "step.js");
    const script = "  return 'hello 🌅';\n\n";
    await writeFile(file, script);
    expect(await readScript({ file })).toBe(script);
  });

  it("prefers supplied text without reading the file", async () => {
    expect(
      await readScript({ file: join(dir, "missing.js"), script: "return 1;" })
    ).toBe("return 1;");
  });

  it.each([undefined, "", " \n\t"])(
    "rejects blank input (%j) with the same diagnostic",
    async (script) => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(await readScript({ script })).toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(
        "No script provided (pass a FILE or pipe stdin)\n"
      );
    }
  );

  it("does not fall back to a file when supplied text is blank", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(
      await readScript({ file: join(dir, "missing.js"), script: "" })
    ).toBeUndefined();
  });

  it("rejects an empty file before starting a daemon", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const file = join(dir, "empty.js");
    await writeFile(file, "\n");
    expect(await readScript({ file })).toBeUndefined();
  });

  it("preserves the CLI's missing-file error", async () => {
    await expect(readScript({ file: join(dir, "missing.js") })).rejects.toThrow(
      "No such file or directory (os error 2)"
    );
  });
});
