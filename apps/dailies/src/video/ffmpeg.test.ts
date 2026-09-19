import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../util/process.js";
import { audioDurationSec, ffprobeFor, probeDurationSec } from "./ffmpeg.js";

vi.mock("../util/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/process.js")>()),
  run: vi.fn(),
}));

function respondsWith({
  stdout = "",
  stderr = "",
  code = 0,
}: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): void {
  if (code === 0) {
    vi.mocked(run).mockResolvedValueOnce({ stdout, stderr });
  } else {
    vi.mocked(run).mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), { stdout, stderr })
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ffprobeFor", () => {
  it.each([
    ["ffmpeg", "ffprobe"],
    ["/usr/local/bin/ffmpeg-7", "/usr/local/bin/ffprobe-7"],
    ["C:\\tools\\ffmpeg.exe", "C:\\tools\\ffprobe.exe"],
    ["./ffmpeg", "./ffprobe"],
    ["custom-encoder", "ffprobe"],
  ])("finds the matching probe for %s", (ffmpeg, expected) => {
    expect(ffprobeFor(ffmpeg)).toBe(expected);
  });
});

describe("probeDurationSec", () => {
  it("allows long file probes to retain their timeout budget", async () => {
    respondsWith({ stdout: "12.5\n" });
    await expect(
      probeDurationSec("ffmpeg", "audio.wav", { timeoutMs: 120_000 })
    ).resolves.toBe(12.5);
    expect(run).toHaveBeenCalledWith("ffprobe", expect.any(Array), 120_000);
  });

  it("keeps the normal file-probe timeout by default", async () => {
    respondsWith({ stdout: "12.5\n" });
    await probeDurationSec("ffmpeg", "audio.wav");
    expect(run).toHaveBeenCalledWith("ffprobe", expect.any(Array), 30_000);
  });
});

describe("audioDurationSec", () => {
  it("uses ffprobe without launching the fallback when a duration is available", async () => {
    respondsWith({ stdout: "12.5\n" });

    await expect(audioDurationSec("ffmpeg", "audio.wav")).resolves.toBe(12.5);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]?.[0]).toBe("ffprobe");
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
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(run).mock.calls[1]?.slice(0, 2)).toEqual([
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
