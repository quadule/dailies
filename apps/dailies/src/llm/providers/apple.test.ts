import { createLogger } from "dailies-logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessError, run } from "../../util/process.js";
import { createAppleProvider, helperPath } from "./apple.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));
vi.mock("../../util/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../util/process.js")>()),
  run: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(run).mockReset();
});

const request = {
  log: createLogger({ level: "silent" }),
  label: "narration",
  prompt: "Describe a completed checkout",
  schema: { type: "object", properties: { line: { type: "string" } } },
  timeoutMs: 1234,
};

describe("Apple subprocess integration", () => {
  it("sends the request through shared stdin handling with an elided preview", async () => {
    vi.mocked(run).mockResolvedValue({ stdout: '{"line":"done"}', stderr: "" });
    const echo = vi.fn();

    await expect(
      createAppleProvider().generateJson({ ...request, echo })
    ).resolves.toBe('{"line":"done"}');

    expect(run).toHaveBeenCalledWith(helperPath(), [], request.timeoutMs, {
      input: JSON.stringify({ prompt: request.prompt, schema: request.schema }),
    });
    expect(echo.mock.calls[0]?.[0]).toContain("narration prompt");
    expect(echo.mock.calls[0]?.[0]).not.toContain(request.prompt);
  });

  it("preserves the helper's availability diagnostic and underlying process cause", async () => {
    const failure = new ProcessError(
      helperPath(),
      {
        stdout: "",
        stderr: "Apple Intelligence unavailable: model not ready\n",
      },
      { reason: "exit", exitCode: 3, cause: new Error("exit 3") }
    );
    vi.mocked(run).mockRejectedValue(failure);

    await expect(
      createAppleProvider().generateJson(request)
    ).rejects.toMatchObject({
      message: "Apple Intelligence unavailable: model not ready",
      cause: failure,
    });
  });

  it("keeps the explicit helper timeout diagnostic and its cause", async () => {
    const failure = new ProcessError(
      helperPath(),
      { stdout: "", stderr: "" },
      {
        reason: "timeout",
        cause: new Error("timed out"),
      }
    );
    vi.mocked(run).mockRejectedValue(failure);

    await expect(
      createAppleProvider().generateJson(request)
    ).rejects.toMatchObject({
      message: "the Apple Intelligence helper timed out after 1234ms",
      cause: failure,
    });
  });

  it("reports an output limit as that failure instead of hiding it as a helper exit", async () => {
    const failure = new ProcessError(
      helperPath(),
      { stdout: "partial", stderr: "" },
      {
        reason: "maxBuffer",
        cause: new Error("output exceeded maxBuffer"),
      }
    );
    vi.mocked(run).mockRejectedValue(failure);
    await expect(createAppleProvider().generateJson(request)).rejects.toBe(
      failure
    );
  });
});
