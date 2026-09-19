import { execFile, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseWhisperSrt } from "./align.js";
import type { CreditSection } from "./credits.js";
import { ffprobeFor } from "./ffmpeg.js";
import { type CinematicOptions, cinematicProcess } from "./narrate.js";

// Only external generation/lookup is faked. Encoding, probes, title/credit
// rendering, retiming, subtitle burn, audio mixing and final cleanup are real.
const media = vi.hoisted(() => ({
  voice: vi.fn(),
  bed: vi.fn(),
  song: vi.fn(),
  background: vi.fn(),
  credits: [] as { duration: number; sections: CreditSection[] }[],
}));
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
    titleBackground: {
      id: "local-image",
      render: media.background,
      credit: () => "Title art — fixture painter",
    },
  }),
}));
vi.mock("./providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers.js")>()),
  resolveMediaProviders: () => ({
    notes: [],
    tts: {
      id: "gemini-tts",
      label: "fixture voice",
      tempo: 1,
      synthesize: media.voice,
    },
    music: {
      id: "gemini-music",
      singsLyrics: true,
      bed: media.bed,
      song: media.song,
      credit: async () => "Fixture score — sine orchestra",
    },
  }),
}));
vi.mock("./speech.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./speech.js")>()),
  resolveSpeech: async () => ({
    label: "fixture voice",
    rate: 175,
    sayLabel: "",
  }),
}));
vi.mock("./script-llm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./script-llm.js")>()),
  resolveBase: async () => "main",
  describeChange: async () => undefined,
  runLlmJson: async ({ label }: { label: string }) => ({
    writer: "fixture writer",
    value:
      label === "lyrics"
        ? {
            title: "Two screens",
            lines: [
              { index: 0, text: "Green screen rises" },
              { index: 1, text: "Blue screen shines" },
            ],
          }
        : {
            title: "Two screens",
            steps: [
              { index: 0, narration: "Green screen rises" },
              { index: 1, narration: "Blue screen shines" },
            ],
          },
  }),
}));
vi.mock("./credits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credits.js")>();
  return {
    ...actual,
    branchContributors: async () => [{ name: "Fixture author", commits: 1 }],
    buildCreditsRoll: async (
      args: Parameters<typeof actual.buildCreditsRoll>[0]
    ) => {
      const duration = await actual.buildCreditsRoll(args);
      media.credits.push({ duration, sections: args.sections });
      return duration;
    },
  };
});
vi.mock("./transcribe.js", () => ({
  transcribeSong: async () => ({
    segments: [
      { start: 1, end: 2, text: "Green screen rises" },
      { start: 4, end: 5, text: "Blue screen shines" },
    ],
    words: [],
  }),
}));

const exec = promisify(execFile);
const ffmpeg = process.env.DAILIES_FFMPEG?.trim() || "ffmpeg";
const filters = spawnSync(ffmpeg, ["-hide_banner", "-filters"], {
  encoding: "utf8",
  timeout: 10_000,
});
const hasMediaTools =
  filters.status === 0 &&
  /\bdrawtext\b/.test(filters.stdout) &&
  /\bsubtitles\b/.test(filters.stdout) &&
  spawnSync(ffprobeFor(ffmpeg), ["-version"], { timeout: 10_000 }).status === 0;
const width = 320;
const height = 180;
let dir = "";
let source = "";

async function encode(args: string[]): Promise<void> {
  await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 30_000,
  });
}

async function tone(
  outPath: string,
  seconds: number,
  frequency: number
): Promise<void> {
  await encode([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:sample_rate=24000:duration=${seconds}`,
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

async function frame(
  videoPath: string,
  seconds: number,
  crop?: string
): Promise<Buffer> {
  const { stdout } = await exec(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(seconds),
      "-i",
      videoPath,
      ...(crop ? ["-vf", `crop=${crop}`] : []),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout;
}

function whitePixels(bytes: Buffer): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    if (bytes[i]! > 180 && bytes[i + 1]! > 180 && bytes[i + 2]! > 180) {
      count++;
    }
  }
  return count;
}

async function audioLevel(videoPath: string, start: number): Promise<number> {
  const { stdout } = await exec(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(start),
      "-i",
      videoPath,
      "-t",
      "0.2",
      "-vn",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { encoding: "buffer" }
  );
  let energy = 0;
  for (let i = 0; i < stdout.length; i += 2) {
    energy += stdout.readInt16LE(i) ** 2;
  }
  return Math.sqrt(energy / (stdout.length / 2));
}

describe.skipIf(!hasMediaTools)(
  "cinematic rendered fixtures (requires ffmpeg/ffprobe with drawtext and subtitles)",
  () => {
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "dailies-render-"));
      source = path.join(dir, "source.webm");
      const title = path.join(dir, "title.png");
      const voice = path.join(dir, "voice.wav");
      const song = path.join(dir, "song.wav");
      await encode([
        "-f",
        "lavfi",
        "-i",
        `color=c=lime:s=${width}x${height}:r=10:d=7`,
        "-f",
        "lavfi",
        "-i",
        `color=c=blue:s=${width}x${height}:r=10:d=7`,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libvpx",
        "-b:v",
        "200k",
        source,
      ]);
      await encode([
        "-f",
        "lavfi",
        "-i",
        `color=c=0xc080ff:s=${width}x${height}`,
        "-frames:v",
        "1",
        title,
      ]);
      await tone(voice, 0.8, 880);
      await tone(song, 30, 440);
      media.voice.mockImplementation((_text, outPath: string) =>
        copyFile(voice, outPath)
      );
      media.song.mockImplementation((_direction, _seconds, outPath: string) =>
        copyFile(song, outPath)
      );
      media.bed.mockImplementation(
        (_direction, seconds: number, outPath: string) =>
          tone(outPath, seconds, 220)
      );
      media.background.mockImplementation(
        (_direction, _width, _height, outPath: string) =>
          copyFile(title, outPath)
      );
      vi.stubEnv("DAILIES_SONG_FILE", "");
      vi.stubEnv("DAILIES_TTS_TEMPO", "1");
      vi.stubEnv("DAILIES_NARRATION_GAP_SEC", "0.6");
    }, 30_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      "preserves picture, sound, titles, credits and captions (song=%s)",
      async (song) => {
        media.credits.length = 0;
        const runDir = path.join(dir, song ? "song" : "narration");
        await mkdir(runDir);
        const videoPath = path.join(runDir, "video.webm");
        await copyFile(source, videoPath);
        const log = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        } as unknown as CinematicOptions["log"];
        const result = await cinematicProcess(
          videoPath,
          [
            { name: "Green screen", durationMs: 7000, videoTime: 0 },
            { name: "Blue screen", durationMs: 7000, videoTime: 7 },
          ],
          {
            captions: true,
            ffmpegPath: ffmpeg,
            log,
            prompt: "A calm documentary",
            media: { narrator: "gemini", music: "gemini", image: "local" },
            song,
          }
        );
        expect(
          result,
          JSON.stringify(vi.mocked(log.debug).mock.calls)
        ).toMatchObject({
          applied: true,
          titleOffsetSec: 2.5,
        });
        const steps = result.stepTimes!;
        expect(steps).toEqual(song ? [3.5, 6.5] : [2.5, 9.5]);

        const { stdout } = await exec(ffprobeFor(ffmpeg), [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          videoPath,
        ]);
        const probe = JSON.parse(stdout) as {
          streams: {
            codec_type: string;
            codec_name: string;
            width?: number;
            height?: number;
            r_frame_rate?: string;
          }[];
          format: { duration: string };
        };
        expect(probe.streams).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              codec_type: "video",
              codec_name: "vp8",
              width,
              height: 276,
              r_frame_rate: "10/1",
            }),
            expect.objectContaining({
              codec_type: "audio",
              codec_name: "opus",
            }),
          ])
        );
        expect(probe.streams).toHaveLength(2);
        expect(media.credits).toHaveLength(1);
        const credit = media.credits.at(-1)!;
        const creditLines = credit.sections.flatMap((s) => s.entries);
        expect(creditLines).toEqual(
          expect.arrayContaining([
            "Fixture author",
            "Fixture score — sine orchestra",
            "Title art — fixture painter",
            song ? "Lyrics — fixture writer" : "Narration — fixture writer",
          ])
        );
        expect(
          creditLines.filter((line) => line.startsWith("Voice —"))
        ).toHaveLength(song ? 0 : 1);
        const duration = Number(probe.format.duration);
        expect(duration).toBeCloseTo(
          2.5 + (song ? 7 : 14) + credit.duration,
          0
        );
        const cues = parseWhisperSrt(
          await readFile(path.join(runDir, "video.srt"), "utf8")
        );
        expect(
          cues.map((cue) => ({ start: cue.start, text: cue.text }))
        ).toEqual([
          { start: steps[0], text: "Green screen rises" },
          { start: steps[1], text: "Blue screen shines" },
        ]);
        const green = await frame(videoPath, steps[0]! + 0.3, "16:16:8:8");
        const blue = await frame(videoPath, steps[1]! + 0.3, "16:16:8:8");
        expect(green[1]).toBeGreaterThan(240);
        expect(green[0]).toBeLessThan(10);
        expect(blue[2]).toBeGreaterThan(240);
        expect(blue[1]).toBeLessThan(10);
        const title = await frame(videoPath, 1, "16:16:8:8");
        expect(title[0]).toBeGreaterThan(title[1]!);
        expect(title[2]).toBeGreaterThan(title[0]!);
        expect(
          whitePixels(await frame(videoPath, 1, "320:180:0:0"))
        ).toBeGreaterThan(20);
        expect(
          whitePixels(await frame(videoPath, steps[0]! + 0.3, "320:96:0:180"))
        ).toBeGreaterThan(20);
        expect(
          whitePixels(await frame(videoPath, steps[0]! + 2, "320:96:0:180"))
        ).toBe(0);
        expect(
          whitePixels(
            await frame(
              videoPath,
              duration - credit.duration / 2,
              "320:180:0:0"
            )
          )
        ).toBeGreaterThan(20);
        expect(await audioLevel(videoPath, 0.2)).toBeLessThan(1);
        expect(await audioLevel(videoPath, steps[0]! + 0.2)).toBeGreaterThan(
          100
        );
        if (!song) {
          // The narration must be audible above the bed, not merely an audio stream.
          expect(await audioLevel(videoPath, steps[0]! + 0.2)).toBeGreaterThan(
            4 * (await audioLevel(videoPath, steps[0]! + 2))
          );
        }
        expect(
          await readFile(path.join(runDir, "video.precinematic.webm"))
        ).toEqual(await readFile(source));
        expect((await readdir(runDir)).sort()).toEqual(
          song
            ? [
                "video.lyrics.txt",
                "video.precinematic.webm",
                "video.srt",
                "video.webm",
              ]
            : ["video.precinematic.webm", "video.srt", "video.webm"]
        );
      },
      60_000
    );
  }
);
