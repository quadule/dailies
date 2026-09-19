import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CinematicOptions, cinematicProcess } from "./narrate.js";

const mocks = vi.hoisted(() => ({
  background: vi.fn(),
  encode: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

vi.mock("../llm/index.js", () => ({ resolveProviders: async () => [{}] }));
vi.mock("./omlx.js", () => ({
  resolveOmlxProviders: async () => ({ notes: [] }),
}));
vi.mock("./acestep.js", () => ({
  resolveAceStepMusic: async () => ({ notes: [] }),
}));
vi.mock("./elevenlabs.js", () => ({
  readElevenLabsApiKey: () => undefined,
  resolveElevenLabsProviders: async () => ({ notes: [] }),
}));
vi.mock("./local-image.js", () => ({
  resolveLocalImage: () => ({
    titleBackground: { id: "local-image", render: mocks.background },
  }),
}));
vi.mock("./providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers.js")>()),
  resolveMediaProviders: () => ({
    notes: [],
    tts: { id: "gemini-tts", label: "test", synthesize: async () => undefined },
    music: {
      id: "gemini-music",
      singsLyrics: true,
      song: async () => undefined,
    },
  }),
}));
vi.mock("./speech.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./speech.js")>()),
  resolveSpeech: async () => ({ label: "test", rate: 175, sayLabel: "" }),
}));
vi.mock("./script-llm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./script-llm.js")>()),
  resolveBase: async () => "main",
  describeChange: async () => undefined,
  runLlmJson: async ({ label }: { label: string }) => ({
    writer: "test writer",
    value:
      label === "lyrics"
        ? {
            title: "Test",
            lines: [{ index: 0, text: "See the finished result" }],
          }
        : {
            title: "Test",
            steps: [{ index: 0, narration: "See the finished result" }],
          },
  }),
}));
vi.mock("./credits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credits.js")>()),
  branchContributors: async () => [],
}));
vi.mock("./transcribe.js", () => ({ transcribeSong: async () => null }));
vi.mock("./ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ffmpeg.js")>()),
  availableFilters: async () => new Set(["adelay", "amix", "drawtext"]),
  probeVideo: async () => ({ width: 1280, height: 720, frameRate: 30 }),
  audioDurationSec: async () => 3,
  run: async () => ({ stdout: "", stderr: "" }),
  encodeSlice: mocks.encode,
}));

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

describe("cinematic cleanup", () => {
  it.each([
    false,
    true,
  ])("waits for title art after an encoder failure (song=%s)", async (song) => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "dailies-cinematic-lifecycle-")
    );
    dirs.push(dir);
    const videoPath = path.join(dir, "video.webm");
    await writeFile(videoPath, "original recording");
    const finishBackground = deferred();
    const encodeFailed = deferred();
    mocks.background.mockImplementation(
      async (_direction, _width, _height, outPath: string) => {
        await finishBackground.promise;
        await writeFile(outPath, "late title art");
      }
    );
    mocks.encode.mockImplementation(async () => {
      encodeFailed.resolve();
      throw new Error("encoder failed");
    });
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as CinematicOptions["log"];
    const pending = cinematicProcess(
      videoPath,
      [{ name: "Show result", durationMs: 3000, videoTime: 0 }],
      {
        captions: false,
        ffmpegPath: "fake-ffmpeg",
        log,
        prompt: "A calm documentary",
        media: { narrator: "gemini", music: "gemini", image: "local" },
        song,
      }
    );
    try {
      await encodeFailed.promise;
      // Let the rejected encode reach the outer finally while title art remains
      // blocked. Cleanup must not race the provider that still owns this path.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.background).toHaveBeenCalledOnce();
      expect(rm).not.toHaveBeenCalledWith(`${videoPath}.titlebg.png`, {
        force: true,
      });
    } finally {
      finishBackground.resolve();
    }

    await expect(pending).resolves.toMatchObject({
      applied: false,
      reason: "encoder failed",
    });
    expect(await readFile(videoPath, "utf8")).toBe("original recording");
    expect((await readdir(dir)).sort()).toEqual([
      "video.precinematic.webm",
      "video.webm",
    ]);
  });
});
