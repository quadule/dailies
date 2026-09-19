import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSpeechBody,
  describeSpeechCurl,
  omlxBaseUrl,
  pickTtsModel,
  readOmlxApiKey,
  resolveOmlxProviders,
} from "./omlx.js";

describe("omlxBaseUrl", () => {
  it("defaults to localhost and honors the override", () => {
    expect(omlxBaseUrl({})).toBe("http://127.0.0.1:8000");
    expect(omlxBaseUrl({ DAILIES_OMLX_URL: "http://host:9000" })).toBe(
      "http://host:9000"
    );
  });
});

describe("pickTtsModel", () => {
  const ids = [
    "ACE-Step1.5-MLX-4bit",
    "Qwen3-TTS-12Hz-1.7B-Base",
    "Qwen3-0.6B",
  ];
  it("prefers an explicit override", () => {
    expect(pickTtsModel(ids, { DAILIES_OMLX_TTS_MODEL: "custom" })).toBe(
      "custom"
    );
  });
  it("auto-picks the first TTS-looking model", () => {
    expect(pickTtsModel(ids, {})).toBe("Qwen3-TTS-12Hz-1.7B-Base");
  });
  it("returns undefined when none look like TTS", () => {
    expect(pickTtsModel(["ACE-Step1.5-MLX-4bit"], {})).toBeUndefined();
  });
  it("recognizes a known TTS family with no 'tts' in the id (Kokoro)", () => {
    expect(pickTtsModel(["ACE-Step1.5-MLX-4bit", "Kokoro-82M-bf16"], {})).toBe(
      "Kokoro-82M-bf16"
    );
  });
  it("prefers a ready model over a CustomVoice one that needs a speaker", () => {
    // Qwen3-TTS-CustomVoice 500s without a voice; Kokoro speaks out of the box.
    expect(
      pickTtsModel(
        ["Kokoro-82M-bf16", "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"],
        {}
      )
    ).toBe("Kokoro-82M-bf16");
  });
  it("takes a CustomVoice model only when a voice is configured", () => {
    const only = ["Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"];
    expect(pickTtsModel(only, {})).toBeUndefined();
    expect(pickTtsModel(only, { DAILIES_OMLX_TTS_VOICE: "Chelsie" })).toBe(
      "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
    );
  });
});

describe("buildSpeechBody", () => {
  it("requests wav and includes the voice only when given", () => {
    expect(buildSpeechBody({ model: "m", text: "hi" })).toEqual({
      model: "m",
      input: "hi",
      response_format: "wav",
    });
    expect(
      buildSpeechBody({ model: "m", text: "hi", voice: "v" })
    ).toMatchObject({ voice: "v" });
  });
});

describe("readOmlxApiKey", () => {
  it("prefers the explicit env key", async () => {
    await expect(
      readOmlxApiKey({
        DAILIES_OMLX_API_KEY: " k ",
        DAILIES_OMLX_URL: "http://elsewhere:8000",
      })
    ).resolves.toBe("k");
  });

  it("never hands the local oMLX app's key to a remote server", async () => {
    // ~/.omlx/settings.json may well exist on this machine; a non-local URL must
    // still come up empty, so the key can only travel to 127.0.0.1.
    await expect(
      readOmlxApiKey({ DAILIES_OMLX_URL: "http://198.51.100.7:8000" })
    ).resolves.toBeUndefined();
  });
});

describe("describeSpeechCurl", () => {
  it("is copy-pasteable and NEVER contains the real key", () => {
    const curl = describeSpeechCurl({
      baseUrl: "http://127.0.0.1:8000",
      body: buildSpeechBody({ model: "m", text: "hi" }),
      outPath: "/tmp/out file.wav",
    });
    expect(curl).toContain("$DAILIES_OMLX_API_KEY");
    expect(curl).toContain("/v1/audio/speech");
    expect(curl).toContain("'/tmp/out file.wav'");
    expect(curl).not.toMatch(/Bearer (?!\$)/); // no literal token after Bearer
  });
});

// Live integration: exercise the real provider against a running oMLX. Skipped
// automatically when oMLX isn't reachable / configured, OR when it is reachable
// but has no TTS model loaded (e.g. an oMLX serving only a music or LLM model) —
// reachability is not the same as a speech model being present, so CI, non-oMLX
// machines, and oMLX hosts without a TTS model all stay green.
const apiKey = await readOmlxApiKey(process.env);
const baseUrl = omlxBaseUrl(process.env);
const ttsModelLoaded =
  apiKey != null &&
  (await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(3000),
  })
    .then((r) =>
      r.ok ? (r.json() as Promise<{ data?: { id?: unknown }[] }>) : null
    )
    .then((body) => {
      const ids = (body?.data ?? [])
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === "string");
      return pickTtsModel(ids, process.env) != null;
    })
    .catch(() => false));

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
} as unknown as Parameters<typeof resolveOmlxProviders>[0]["log"];

describe("resolveOmlxProviders notes", () => {
  it("a remote URL with no explicit key disables oMLX and says why", async () => {
    // The local ~/.omlx key must never be sent to another host, so without an
    // explicit $DAILIES_OMLX_API_KEY a remote server is skipped — loudly, since a
    // LAN oMLX that worked yesterday vanishing without a word is a support call.
    const { tts, notes } = await resolveOmlxProviders({
      env: { DAILIES_OMLX_URL: "http://198.51.100.7:8000" },
      log: fakeLog,
    });
    expect(tts).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("198.51.100.7");
    expect(notes[0]).toContain("set DAILIES_OMLX_API_KEY");
  });
});

describe.skipIf(!ttsModelLoaded)("oMLX live TTS", () => {
  const out = path.join(os.tmpdir(), `dailies-omlx-test-${process.pid}.wav`);
  afterAll(() => rm(out, { force: true }));

  it("synthesizes a real WAV via the provider", async () => {
    const { tts, notes } = await resolveOmlxProviders({
      env: process.env,
      log: fakeLog,
    });
    expect(tts, "a TTS model should be loaded in oMLX").toBeDefined();
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseUrl);
    expect(
      notes.some((n) => n.includes(local ? "never leaves" : "is sent to"))
    ).toBe(true);
    await tts?.synthesize("Dailies checks the login flow.", out);
    const bytes = await readFile(out);
    expect(bytes.length).toBeGreaterThan(1000);
    // RIFF/WAVE header — proves it's audio, not a JSON error envelope.
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  }, 60_000);
});
