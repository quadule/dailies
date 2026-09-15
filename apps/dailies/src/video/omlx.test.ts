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

describe.skipIf(!ttsModelLoaded)("oMLX live TTS", () => {
  const out = path.join(os.tmpdir(), `dailies-omlx-test-${process.pid}.wav`);
  afterAll(() => rm(out, { force: true }));

  it("synthesizes a real WAV via the provider", async () => {
    const { tts, notes } = await resolveOmlxProviders({
      env: process.env,
      log: { debug() {}, info() {}, warn() {}, error() {} } as any,
    });
    expect(tts, "a TTS model should be loaded in oMLX").toBeDefined();
    expect(notes.some((n) => n.includes("never leaves"))).toBe(true);
    await tts?.synthesize("Dailies checks the login flow.", out);
    const bytes = await readFile(out);
    expect(bytes.length).toBeGreaterThan(1000);
    // RIFF/WAVE header — proves it's audio, not a JSON error envelope.
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  }, 60_000);
});
