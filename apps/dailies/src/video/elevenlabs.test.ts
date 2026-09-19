import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildImageBody,
  buildMusicBody,
  buildTtsBody,
  describeCurl,
  elevenLabsBaseUrl,
  FALLBACK_VOICES,
  looksLikeVoiceId,
  parseVoices,
  pickElevenLabsVoice,
  readElevenLabsApiKey,
  readImageJob,
  resolveElevenLabsProviders,
} from "./elevenlabs.js";

// A no-op logger satisfying the bits resolveElevenLabsProviders touches.
const noopLog = {
  debug() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
  error() {
    // no-op
  },
} as unknown as Parameters<typeof resolveElevenLabsProviders>[0]["log"];

describe("readElevenLabsApiKey / elevenLabsBaseUrl", () => {
  it("reads the SDK-standard env var and trims it", () => {
    expect(readElevenLabsApiKey({})).toBeUndefined();
    expect(readElevenLabsApiKey({ ELEVENLABS_API_KEY: "  " })).toBeUndefined();
    expect(readElevenLabsApiKey({ ELEVENLABS_API_KEY: " k1 " })).toBe("k1");
  });

  it("defaults to the public host and strips a trailing slash from an override", () => {
    expect(elevenLabsBaseUrl({})).toBe("https://api.elevenlabs.io");
    expect(
      elevenLabsBaseUrl({ DAILIES_ELEVENLABS_URL: "http://127.0.0.1:9/" })
    ).toBe("http://127.0.0.1:9");
  });
});

describe("parseVoices", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(
      parseVoices({
        voices: [
          { voice_id: "abc", name: "Sarah", category: "premade" },
          { voice_id: "", name: "nope" },
          { name: "no id" },
          { voice_id: "id-only", name: "" },
          "junk",
        ],
      })
    ).toEqual([
      { id: "abc", name: "Sarah" },
      { id: "id-only", name: "id-only" },
    ]);
    expect(parseVoices(null)).toEqual([]);
    expect(parseVoices({ voices: "x" })).toEqual([]);
  });
});

describe("pickElevenLabsVoice", () => {
  const voices = [
    { id: "9BWtsMINqrJLrRacOk9x", name: "Aria" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  ];

  it("draws one voice per session from the list", () => {
    expect(pickElevenLabsVoice(voices, {}, () => 0).voice).toEqual(voices[0]);
    expect(pickElevenLabsVoice(voices, {}, () => 0.99).voice).toEqual(
      voices[1]
    );
  });

  it("honors $DAILIES_ELEVENLABS_VOICE by name (case-insensitive) or id", () => {
    expect(
      pickElevenLabsVoice(voices, { DAILIES_ELEVENLABS_VOICE: "sarah" }).voice
    ).toEqual(voices[1]);
    expect(
      pickElevenLabsVoice(voices, {
        DAILIES_ELEVENLABS_VOICE: "9BWtsMINqrJLrRacOk9x",
      }).voice
    ).toEqual(voices[0]);
  });

  it("passes an unknown id-shaped override through so the API can reject it", () => {
    const picked = pickElevenLabsVoice(voices, {
      DAILIES_ELEVENLABS_VOICE: "zzzzzzzzzzzzzzzzzzzz",
    });
    expect(picked.voice).toEqual({
      id: "zzzzzzzzzzzzzzzzzzzz",
      name: "zzzzzzzzzzzzzzzzzzzz",
    });
    expect(picked.note).toBeUndefined();
  });

  it("falls back to a random voice, with a note, for an unknown NAME", () => {
    const picked = pickElevenLabsVoice(
      voices,
      { DAILIES_ELEVENLABS_VOICE: "Nobody" },
      () => 0
    );
    expect(picked.voice).toEqual(voices[0]);
    expect(picked.note).toContain('"Nobody"');
    expect(picked.note).toContain("Aria");
  });

  it("recognizes id-shaped values", () => {
    expect(looksLikeVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(true);
    expect(looksLikeVoiceId("Sarah")).toBe(false);
    expect(looksLikeVoiceId("Bad News")).toBe(false);
  });

  it("ships a built-in default library with unique ids", () => {
    expect(FALLBACK_VOICES.length).toBeGreaterThan(10);
    expect(new Set(FALLBACK_VOICES.map((v) => v.id)).size).toBe(
      FALLBACK_VOICES.length
    );
    for (const v of FALLBACK_VOICES) {
      expect(looksLikeVoiceId(v.id)).toBe(true);
    }
  });
});

describe("request bodies", () => {
  it("sends the narration line verbatim (no delivery directive)", () => {
    expect(buildTtsBody("We open the door.", "eleven_multilingual_v2")).toEqual(
      { text: "We open the door.", model_id: "eleven_multilingual_v2" }
    );
  });

  it("builds an instrumental bed request with the length in ms", () => {
    const body = buildMusicBody({
      directionText: "noir detective",
      seconds: 42.4,
      instrumental: true,
      model: "music_v2_5",
    });
    expect(body.model_id).toBe("music_v2_5");
    expect(body.force_instrumental).toBe(true);
    expect(body.music_length_ms).toBe(42_400);
    expect(String(body.prompt)).toContain("noir detective");
    expect(String(body.prompt)).toContain("NO vocals");
  });

  it("embeds supplied lyrics in a song request and clamps the length", () => {
    const body = buildMusicBody({
      directionText: "80s power ballad",
      seconds: 1,
      instrumental: false,
      lyrics: "we ship it green\nwe ship it clean",
      model: "music_v2_5",
    });
    expect(body.force_instrumental).toBe(false);
    expect(body.music_length_ms).toBe(3000);
    expect(String(body.prompt)).toContain("Sing these exact lyrics");
    expect(String(body.prompt)).toContain("we ship it clean");
    expect(
      buildMusicBody({
        directionText: "x",
        seconds: 9999,
        instrumental: true,
        model: "m",
      }).music_length_ms
    ).toBe(600_000);
  });

  it("asks the image flow for a lettering-free background at the video's aspect", () => {
    const body = buildImageBody({
      directionText: "nature documentary",
      width: 1440,
      height: 900,
      model: "gemini-3.1-flash-image",
    });
    expect(body.model_id).toBe("gemini-3.1-flash-image");
    expect(body.aspect_ratio).toBe("16:9");
    expect(String(body.prompt)).toContain("NO text");
  });
});

describe("readImageJob", () => {
  it("maps the job lifecycle to done / failed / pending", () => {
    expect(
      readImageJob({
        status: "completed",
        content_url: "https://storage.example/x",
        content_mime_type: "image/png",
      })
    ).toEqual({
      state: "done",
      url: "https://storage.example/x",
      mimeType: "image/png",
    });
    expect(readImageJob({ status: "completed" })).toEqual({
      state: "failed",
      reason: "completed without a content_url",
    });
    expect(
      readImageJob({ status: "failed", failure_reason: "moderation" })
    ).toEqual({ state: "failed", reason: "moderation" });
    expect(readImageJob({ status: "generating" })).toEqual({
      state: "pending",
    });
    expect(readImageJob(undefined)).toEqual({ state: "pending" });
  });
});

describe("describeCurl", () => {
  it("never prints the key — only the env-var reference", () => {
    const line = describeCurl({
      baseUrl: "https://api.elevenlabs.io",
      path: "/v1/text-to-speech/abc?output_format=mp3_44100_128",
      body: { text: "it's live", model_id: "m" },
      outPath: "/tmp/out.wav",
    });
    expect(line).toContain('-H "xi-api-key: $ELEVENLABS_API_KEY"');
    expect(line).toContain("curl -s -X POST https://api.elevenlabs.io/v1/");
    expect(line).toContain("-o '/tmp/out.wav'");
    // The apostrophe in the text is shell-escaped, not broken.
    expect(line).toContain("it'\\''s live");
    expect(line).not.toContain("sk-");
  });
});

describe("resolveElevenLabsProviders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays silent (no providers, no notes) without a key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await resolveElevenLabsProviders({ env: {}, log: noopLog });
    expect(result).toEqual({ notes: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enables narration + music from the live voice list, image only when asked", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://api.elevenlabs.io/v2/voices?voice_type=default&page_size=100"
      );
      expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe(
        "sk-test"
      );
      return new Response(
        JSON.stringify({
          voices: [{ voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = { ELEVENLABS_API_KEY: "sk-test" };

    const plain = await resolveElevenLabsProviders({ env, log: noopLog });
    expect(plain.tts?.id).toBe("elevenlabs-tts");
    expect(plain.tts?.label).toBe("elevenlabs:Sarah");
    expect(plain.tts?.tempo).toBeCloseTo(1.1);
    expect(plain.music?.id).toBe("elevenlabs-music");
    expect(plain.music?.singsLyrics).toBe(true);
    expect(plain.titleBackground).toBeUndefined();
    expect(plain.notes.join("\n")).toContain("ElevenLabs enabled");
    expect(plain.notes.join("\n")).not.toContain("sk-test");

    const withImage = await resolveElevenLabsProviders({
      env,
      log: noopLog,
      image: true,
    });
    expect(withImage.titleBackground?.id).toBe("elevenlabs-image");
    expect(withImage.titleBackground?.credit?.()).toContain("via ElevenLabs");
  });

  it("disables itself, with a note, when the key is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    );
    const result = await resolveElevenLabsProviders({
      env: { ELEVENLABS_API_KEY: "bad" },
      log: noopLog,
    });
    expect(result.tts).toBeUndefined();
    expect(result.music).toBeUndefined();
    expect(result.notes.join("\n")).toContain("rejected");
    expect(result.notes.join("\n")).toContain("401");
    expect(result.notes.join("\n")).not.toContain("bad");
  });

  it("falls back to the built-in voices when the listing is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );
    const result = await resolveElevenLabsProviders({
      env: { ELEVENLABS_API_KEY: "sk", DAILIES_ELEVENLABS_VOICE: "Brian" },
      log: noopLog,
    });
    expect(result.tts?.label).toBe("elevenlabs:Brian");
  });

  it("writes the TTS audio it receives to outPath, verbatim", async () => {
    const audio = Buffer.from("ID3-fake-mp3-bytes");
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/v2/voices")) {
        return new Response(JSON.stringify({ voices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toContain("/v1/text-to-speech/");
      expect(url).toContain("output_format=mp3_44100_128");
      return new Response(audio, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "dailies-eleven-"));
    try {
      const result = await resolveElevenLabsProviders({
        env: { ELEVENLABS_API_KEY: "sk" },
        log: noopLog,
      });
      const out = path.join(dir, "clip.wav");
      await result.tts?.synthesize("hello", out);
      expect((await readFile(out)).equals(audio)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a JSON body under a 2xx as audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/v2/voices")
          ? new Response(JSON.stringify({ voices: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ detail: "quota" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
      )
    );
    const result = await resolveElevenLabsProviders({
      env: { ELEVENLABS_API_KEY: "sk" },
      log: noopLog,
    });
    await expect(
      result.tts?.synthesize("hello", "/nonexistent/dir/clip.wav")
    ).rejects.toThrow(/JSON, not media/);
  });
});
