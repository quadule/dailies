import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioDurationSec, run } from "./ffmpeg.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function respondsWith({
  stdout = "",
  stderr = "",
  code = 0,
}: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): void {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("run", () => {
  it("keeps subprocess output available when adding failure diagnostics", async () => {
    respondsWith({
      stdout: "partial output",
      stderr: "tool diagnostic",
      code: 1,
    });

    await expect(run("tool", [], 1000)).rejects.toMatchObject({
      message: "tool failed:\ntool diagnostic",
      stdout: "partial output",
      stderr: "tool diagnostic",
    });
  });
});

describe("audioDurationSec", () => {
  it("uses ffprobe without launching the fallback when a duration is available", async () => {
    respondsWith({ stdout: "12.5\n" });

    await expect(audioDurationSec("ffmpeg", "audio.wav")).resolves.toBe(12.5);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("ffprobe");
  });

  it.each([
    { stdout: "N/A\n", code: 0 },
    { stderr: "ffprobe unavailable", code: 1 },
  ])("reads ffmpeg's stderr after an unusable probe: %j", async (probe) => {
    respondsWith(probe);
    respondsWith({
      stderr:
        "Input #0, wav:\n  Duration: 00:01:02.50, bitrate: 768 kb/s\nAt least one output file must be specified\n",
      code: 1,
    });

    await expect(audioDurationSec("ffmpeg", "audio.wav")).resolves.toBe(62.5);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1]?.slice(0, 2)).toEqual([
      "ffmpeg",
      ["-hide_banner", "-i", "audio.wav"],
    ]);
  });

  it("returns unavailable when neither probe reports a duration", async () => {
    respondsWith({ code: 1 });
    respondsWith({ stderr: "invalid media", code: 1 });

    await expect(
      audioDurationSec("ffmpeg", "audio.wav")
    ).resolves.toBeUndefined();
  });
});
