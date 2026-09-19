import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./cli.js";

// Drive the real entry point so these cover commander's own error path rather
// than a reimplementation of it. `execute` takes a process.argv-shaped array.
async function run(
  args: string[]
): Promise<{ code: number; err: string; out: string }> {
  let err = "";
  let out = "";
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    });
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
  try {
    const code = await execute(["node", "dailies", ...args]);
    return { code, err, out };
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unknown flag errors", () => {
  it("lists the command's valid flags inline", async () => {
    const { code, err } = await run(["session", "list", "--bogus"]);

    expect(code).toBe(2);
    expect(err).toContain("unknown option '--bogus'");
    // The whole point: the fix is in the error, not behind another --help call.
    expect(err).toContain("help: valid flags for `session list`");
  });

  it("names the full command path and its real flags", async () => {
    const { code, err } = await run(["session", "start", "--bogus"]);

    expect(code).toBe(2);
    expect(err).toContain("help: valid flags for `session start`");
    expect(err).toContain("--headless");
    // Not a sibling command's flag set.
    expect(err).not.toContain("--stop-daemon");
  });

  it("resolves the command past a positional argument", async () => {
    const { err } = await run(["session", "end", "some-session-id", "--bogus"]);

    expect(err).toContain("help: valid flags for `session end`");
    expect(err).toContain("--attach");
  });

  it("stays quiet on errors that already name the flag they mean", async () => {
    // Missing-required-option errors share the exit code but not the problem —
    // the flag list would be noise there.
    const { code, err } = await run(["run", "script.js"]);

    expect(code).toBe(2);
    expect(err).toContain("--session");
    expect(err).not.toContain("help: valid flags");
  });
});

describe("media provider pins", () => {
  it("rejects an unknown provider in one turn, listing the valid ones", async () => {
    const { code, err } = await run([
      "session",
      "end",
      "some-session-id",
      "--narrator",
      "polly",
    ]);

    expect(code).toBe(2);
    expect(err).toContain(
      '--narrator "polly" is not a narration voice provider'
    );
    expect(err).toContain("elevenlabs, gemini, omlx, say");
  });

  it("checks every slot, naming the one that is wrong", async () => {
    const { code, err } = await run([
      "session",
      "end",
      "some-session-id",
      "--narrator",
      "elevenlabs",
      "--image",
      "dalle",
    ]);

    expect(code).toBe(2);
    expect(err).toContain('--image "dalle"');
    expect(err).toContain("gradient, none");
  });
});
