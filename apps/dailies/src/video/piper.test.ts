import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../util/process.js";
import { findFfmpeg } from "./condense.js";
import { audioDurationSec } from "./ffmpeg.js";
import {
  DEFAULT_PIPER_VOICE,
  findPiperCommand,
  findPiperVoice,
  isPiperVoicePath,
  PIPER_TTS_ID,
  pickPiperVoice,
  piperArgs,
  piperDownloadCommand,
  piperLabel,
  piperText,
  piperVoiceDirs,
  piperVoiceName,
  piperVoicesInListing,
  resolvePiperProviders,
  SYSTEM_PIPER_VOICES_DIR,
} from "./piper.js";

const fakeLog = {
  debug() {
    // no-op
  },
  error() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
} as unknown as Parameters<typeof resolvePiperProviders>[0]["log"];

describe("piperVoiceDirs", () => {
  it("searches the user's data folder, then the distro's", () => {
    expect(piperVoiceDirs({}, "/home/ada")).toEqual([
      "/home/ada/.local/share/piper-voices",
      SYSTEM_PIPER_VOICES_DIR,
    ]);
  });

  it("follows an absolute $XDG_DATA_HOME and ignores a relative one", () => {
    expect(piperVoiceDirs({ XDG_DATA_HOME: "/data" }, "/home/ada")[0]).toBe(
      "/data/piper-voices"
    );
    expect(piperVoiceDirs({ XDG_DATA_HOME: "data" }, "/home/ada")[0]).toBe(
      "/home/ada/.local/share/piper-voices"
    );
  });

  it("lets $DAILIES_PIPER_VOICES replace the whole search", () => {
    expect(
      piperVoiceDirs(
        { DAILIES_PIPER_VOICES: "/voices", XDG_DATA_HOME: "/data" },
        "/home/ada"
      )
    ).toEqual(["/voices"]);
  });
});

describe("piperVoicesInListing", () => {
  it("finds flat downloads and the nested Hugging Face layout", () => {
    expect(
      piperVoicesInListing([
        "en_US-ryan-high.onnx",
        "en_US-ryan-high.onnx.json",
        "en/en_US/amy/medium/en_US-amy-medium.onnx",
        "en/en_US/amy/medium/en_US-amy-medium.onnx.json",
        "en/en_US/amy/medium/MODEL_CARD",
        "voices.json",
      ])
    ).toEqual([
      {
        name: "en_US-amy-medium",
        model: "en/en_US/amy/medium/en_US-amy-medium.onnx",
      },
      { name: "en_US-ryan-high", model: "en_US-ryan-high.onnx" },
    ]);
  });

  it("needs the config beside the model", () => {
    expect(
      piperVoicesInListing([
        "en_US-joe-medium.onnx",
        "elsewhere/en_US-joe-medium.onnx.json",
      ])
    ).toEqual([]);
  });

  it("keeps the shallower copy of a voice found twice", () => {
    expect(
      piperVoicesInListing([
        "a/b/en_US-joe-medium.onnx",
        "a/b/en_US-joe-medium.onnx.json",
        "en_US-joe-medium.onnx",
        "en_US-joe-medium.onnx.json",
      ])
    ).toEqual([{ name: "en_US-joe-medium", model: "en_US-joe-medium.onnx" }]);
  });
});

describe("pickPiperVoice", () => {
  it("prefers the default voice when it is installed", () => {
    expect(
      pickPiperVoice(["en_US-amy-medium", DEFAULT_PIPER_VOICE, "de_DE-x-low"])
    ).toBe(DEFAULT_PIPER_VOICE);
  });

  it("else the first US-English medium voice, whatever the input order", () => {
    expect(
      pickPiperVoice([
        "en_US-ryan-high",
        "en_US-sam-medium",
        "de_DE-thorsten-medium",
        "en_US-joe-medium",
      ])
    ).toBe("en_US-joe-medium");
  });

  it("else the first voice of all, and none from an empty folder", () => {
    expect(pickPiperVoice(["fr_FR-siwis-low", "de_DE-thorsten-high"])).toBe(
      "de_DE-thorsten-high"
    );
    expect(pickPiperVoice([])).toBeUndefined();
  });
});

describe("the command line and labels", () => {
  const voice = {
    name: "en_US-lessac-medium",
    model: "/v/en_US-lessac-medium.onnx",
    config: "/v/en_US-lessac-medium.onnx.json",
  };

  it("names the model, its config and the output file", () => {
    expect(piperArgs(voice, "/out/line.wav")).toEqual([
      "-m",
      "/v/en_US-lessac-medium.onnx",
      "-c",
      "/v/en_US-lessac-medium.onnx.json",
      "-f",
      "/out/line.wav",
    ]);
  });

  it("feeds one line of narration as one utterance", () => {
    expect(piperText("  Opens the page.\nThen\tsigns in.  ")).toBe(
      "Opens the page. Then signs in."
    );
  });

  it("tells a voice name from a model path", () => {
    expect(isPiperVoicePath("en_US-lessac-medium")).toBe(false);
    expect(isPiperVoicePath("en_US-lessac-medium.onnx")).toBe(true);
    expect(isPiperVoicePath("./voices/x")).toBe(true);
  });

  it("labels by voice name and reads the name back from either form", () => {
    expect(piperLabel("en_US-lessac-medium")).toBe("piper:en_US-lessac-medium");
    expect(piperVoiceName("piper:en_US-lessac-medium")).toBe(
      "en_US-lessac-medium"
    );
    expect(piperVoiceName("piper:/v/en_GB-alba-medium.onnx")).toBe(
      "en_GB-alba-medium"
    );
  });

  it("gives a download command that pastes into a shell", () => {
    expect(piperDownloadCommand("en_US-lessac-medium", "/home/a b/v")).toBe(
      "python3 -m piper.download_voices en_US-lessac-medium --data-dir '/home/a b/v'"
    );
  });
});

// Discovery and synthesis against stand-in binaries: a `piper` that is some
// other program, a `piper-tts` that answers like Piper and writes its stdin
// into the -f file, and one that fails halfway through a file.
describe.skipIf(process.platform === "win32")("discovery and synthesis", () => {
  let root: string;
  let bin: string;
  let voices: string;
  let empty: string;

  const script = async (name: string, body: string, dir = bin) => {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  const writeArgsOut = [
    'if [ "$1" = "--help" ]; then echo "  -m MODEL  Path to Onnx model file"; exit 0; fi',
    'out=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then out="$2"; fi; shift; done',
  ].join("\n");

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dailies-piper-"));
    bin = path.join(root, "bin");
    voices = path.join(root, "voices");
    empty = path.join(root, "empty");
    await mkdir(bin);
    await mkdir(empty);
    const nested = path.join(voices, "en", "en_US", "amy", "medium");
    await mkdir(nested, { recursive: true });
    for (const name of ["en_US-amy-medium", "en_US-ryan-high"]) {
      const dir = name === "en_US-amy-medium" ? nested : voices;
      await writeFile(path.join(dir, `${name}.onnx`), "model");
      await writeFile(path.join(dir, `${name}.onnx.json`), "{}");
    }
    // Arch's `piper` is a GTK app for gaming mice.
    await mkdir(path.join(root, "mouse"));
    await script(
      "piper",
      'echo "Usage: piper [GTK options]"',
      path.join(root, "mouse")
    );
    await script(
      "piper-tts",
      `${writeArgsOut}\n{ printf 'RIFF'; cat; head -c 4096 /dev/zero; } > "$out"`
    );
    await script(
      "piper-broken",
      `${writeArgsOut}\nprintf 'RIFF' > "$out"; echo "voice failed to load" >&2; exit 3`
    );
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("finds piper-tts on PATH, and skips a `piper` that isn't Piper TTS", async () => {
    const mouse = path.join(root, "mouse");
    expect(
      await findPiperCommand({ PATH: [mouse, bin].join(path.delimiter) })
    ).toEqual({ command: path.join(bin, "piper-tts") });
    expect(await findPiperCommand({ PATH: mouse })).toEqual({
      missing: "Piper isn't installed",
      loud: false,
    });
  });

  it("reports nothing to use quietly when Piper isn't installed", async () => {
    expect(await findPiperCommand({ PATH: empty })).toEqual({
      missing: "Piper isn't installed",
      loud: false,
    });
  });

  it("takes $DAILIES_PIPER as given, and says so loudly when it's missing", async () => {
    const broken = path.join(bin, "piper-broken");
    expect(await findPiperCommand({ DAILIES_PIPER: broken })).toEqual({
      command: broken,
    });
    const missing = await findPiperCommand({
      DAILIES_PIPER: path.join(root, "nope"),
      PATH: bin,
    });
    expect(missing).toMatchObject({ loud: true });
  });

  it("finds a named voice, or picks one, across the nested layout", async () => {
    const env = { DAILIES_PIPER_VOICES: voices };
    expect(await findPiperVoice(env, root)).toMatchObject({
      ref: "en_US-amy-medium",
      voice: {
        model: path.join(voices, "en/en_US/amy/medium/en_US-amy-medium.onnx"),
      },
    });
    expect(
      await findPiperVoice(
        { ...env, DAILIES_PIPER_VOICE: "en_US-ryan-high" },
        root
      )
    ).toMatchObject({ ref: "en_US-ryan-high" });
  });

  it("looks five folders down and no further", async () => {
    const deep = path.join(root, "deep");
    const place = async (folders: string[], name: string) => {
      const dir = path.join(deep, ...folders);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${name}.onnx`), "model");
      await writeFile(path.join(dir, `${name}.onnx.json`), "{}");
    };
    await place(["a", "b", "c", "d", "e"], "en_US-five-medium");
    await place(["a", "b", "c", "d", "e", "f"], "en_US-six-medium");
    const env = { DAILIES_PIPER_VOICES: deep };
    expect(
      await findPiperVoice({ ...env, DAILIES_PIPER_VOICE: "en_US-five-medium" })
    ).toMatchObject({ ref: "en_US-five-medium" });
    expect(
      await findPiperVoice({ ...env, DAILIES_PIPER_VOICE: "en_US-six-medium" })
    ).toHaveProperty("problem");
  });

  it("follows symlinked voice files", async () => {
    const links = path.join(root, "links");
    await mkdir(links);
    for (const ext of [".onnx", ".onnx.json"]) {
      await symlink(
        path.join(voices, `en_US-ryan-high${ext}`),
        path.join(links, `en_US-ryan-high${ext}`)
      );
    }
    expect(
      await findPiperVoice({ DAILIES_PIPER_VOICES: links }, root)
    ).toMatchObject({ ref: "en_US-ryan-high" });
  });

  it("takes a voice by model path, and keeps the path as its reference", async () => {
    const model = path.join(voices, "en_US-ryan-high.onnx");
    expect(
      await findPiperVoice(
        { DAILIES_PIPER_VOICES: empty, DAILIES_PIPER_VOICE: model },
        root
      )
    ).toMatchObject({ ref: model, voice: { name: "en_US-ryan-high" } });
    const lonely = path.join(empty, "solo.onnx");
    const result = await findPiperVoice({ DAILIES_PIPER_VOICE: lonely }, root);
    expect("problem" in result && result.problem).toContain("doesn't exist");
  });

  it("names the download command for a voice that isn't there", async () => {
    const result = await findPiperVoice(
      {
        DAILIES_PIPER_VOICES: voices,
        DAILIES_PIPER_VOICE: "en_GB-alba-medium",
      },
      root
    );
    expect("problem" in result && result.problem).toContain(
      `python3 -m piper.download_voices en_GB-alba-medium --data-dir ${voices}`
    );
  });

  it("degrades loudly with the download command when there is no voice", async () => {
    const resolved = await resolvePiperProviders({
      env: { PATH: bin, DAILIES_PIPER_VOICES: empty },
      log: fakeLog,
      home: root,
    });
    expect(resolved.tts).toBeUndefined();
    const download = `python3 -m piper.download_voices ${DEFAULT_PIPER_VOICE} --data-dir ${empty}`;
    expect(resolved.unavailable).toContain(download);
    expect(resolved.notes).toHaveLength(1);
    expect(resolved.notes[0]).toContain(path.join(bin, "piper-tts"));
    expect(resolved.notes[0]).toContain(download);
  });

  it("stays silent when Piper isn't installed at all", async () => {
    expect(
      await resolvePiperProviders({
        env: { PATH: empty },
        log: fakeLog,
        home: root,
      })
    ).toEqual({ notes: [] });
  });

  it("speaks the line through stdin into the output file", async () => {
    const lines: string[] = [];
    const { tts, notes } = await resolvePiperProviders({
      env: { PATH: bin, DAILIES_PIPER_VOICES: voices },
      log: fakeLog,
      echo: (line) => lines.push(line),
      home: root,
    });
    expect(tts?.id).toBe(PIPER_TTS_ID);
    expect(tts?.label).toBe("piper:en_US-amy-medium");
    // Piper already reads at voiceover pace; nothing speeds it up.
    expect(tts?.tempo).toBe(1);
    expect(notes[0]).toContain("never leaves");
    const out = path.join(root, "line one.wav");
    await tts?.synthesize("Opens the page.\nThen signs in.", out);
    const bytes = await readFile(out);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("utf8", 4, 35)).toBe(
      "Opens the page. Then signs in.\n"
    );
    // The echoed command reproduces the call: the text piped in, then Piper
    // writing straight to the clip's path.
    expect(lines).toEqual([
      `$ printf '%s\\n' 'Opens the page. Then signs in.' | ${path.join(bin, "piper-tts")} -m ${path.join(voices, "en/en_US/amy/medium/en_US-amy-medium.onnx")} -c ${path.join(voices, "en/en_US/amy/medium/en_US-amy-medium.onnx.json")} -f '${out}'`,
    ]);
    // Only the finished file is left: the partial it was written to is gone.
    expect((await readdir(root)).filter((f) => f.includes(".part-"))).toEqual(
      []
    );
  });

  it("throws on a failed run and leaves no file where the clip belongs", async () => {
    const { tts } = await resolvePiperProviders({
      env: {
        DAILIES_PIPER: path.join(bin, "piper-broken"),
        DAILIES_PIPER_VOICES: voices,
      },
      log: fakeLog,
      home: root,
    });
    const out = path.join(root, "broken.wav");
    await expect(tts?.synthesize("Hello.", out)).rejects.toThrow(
      "voice failed to load"
    );
    expect((await readdir(root)).filter((f) => f.startsWith("broken"))).toEqual(
      []
    );
    await expect(tts?.synthesize("  \n ", out)).rejects.toThrow("no words");
  });
});

// Live: the real binary and a real voice, when this machine has both (CI and
// machines without Piper skip). One short line, checked by decoding it.
const ffmpeg = await findFfmpeg();
const live = await resolvePiperProviders({ env: process.env, log: fakeLog });

describe.skipIf(!(live.tts && ffmpeg))("Piper live TTS", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dailies-piper-live-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("synthesizes a WAV that ffmpeg decodes", async () => {
    const out = path.join(dir, "line.wav");
    await live.tts?.synthesize("Dailies checks the login flow.", out);
    const bytes = await readFile(out);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    const seconds = await audioDurationSec(ffmpeg as string, out);
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(10);
    // A full decode, not just a header read.
    await run(
      ffmpeg as string,
      ["-v", "error", "-i", out, "-f", "null", "-"],
      30_000
    );
  }, 60_000);
});
