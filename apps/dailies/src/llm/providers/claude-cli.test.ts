import { createLogger } from "dailies-logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOnPath, run } from "../../util/process.js";
import { createClaudeCliProvider } from "./claude-cli.js";

vi.mock("../../util/process.js", () => ({
  isOnPath: vi.fn(),
  run: vi.fn(),
}));

const log = createLogger({ level: "silent" });

beforeEach(() => {
  vi.mocked(run).mockReset();
  vi.mocked(isOnPath).mockReset();
});

describe("Claude CLI subprocess integration", () => {
  it("retains the minimal CLI contract and invokes the shared runner without stdin", async () => {
    vi.mocked(run).mockResolvedValue({
      stdout: '{"structured_output":{"line":"done"}}',
      stderr: "",
    });
    const prompt = "Describe a completed checkout";
    const schema = { type: "object" };
    const echo = vi.fn();
    const provider = createClaudeCliProvider({ DAILIES_CLAUDE_MODEL: "opus" });

    await expect(
      provider.generateJson({
        log,
        echo,
        prompt,
        schema,
        label: "narration",
        timeoutMs: 1234,
      })
    ).resolves.toBe('{"line":"done"}');

    expect(run).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "-p",
        "--model",
        "opus",
        "--strict-mcp-config",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(schema),
        prompt,
      ]),
      1234
    );
    expect(vi.mocked(run).mock.calls[0]).toHaveLength(3);
    expect(echo.mock.calls[0]?.[0]).not.toContain(prompt);
  });

  it("uses the shared availability probe", async () => {
    vi.mocked(isOnPath).mockResolvedValue(true);
    expect(await createClaudeCliProvider().isAvailable()).toBe(true);
    expect(isOnPath).toHaveBeenCalledWith("claude", ["--version"]);
  });

  it("preserves process failures for the provider fallback diagnostics", async () => {
    const failure = new Error("Not logged in");
    vi.mocked(run).mockRejectedValue(failure);
    await expect(
      createClaudeCliProvider().generateJson({
        log,
        prompt: "p",
        schema: {},
        label: "narration",
        timeoutMs: 1234,
      })
    ).rejects.toBe(failure);
  });
});
