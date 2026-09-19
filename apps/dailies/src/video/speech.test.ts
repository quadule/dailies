import { describe, expect, it } from "vitest";
import { ttsTempo } from "./speech.js";

// In its own file rather than narrate.test.ts: that file is large, shared, and
// covers the narration pass, while this covers speech.ts's own pure helpers.
describe("ttsTempo", () => {
  it("speeds hosted TTS up by default", () => {
    // The Gemini TTS model reads at a talking-head pace and exposes no rate
    // parameter, so the speed-up happens to the rendered audio instead.
    expect(ttsTempo({})).toBeCloseTo(1.2);
  });

  it("honors $DAILIES_TTS_TEMPO, including 1 to disable the speed-up", () => {
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "1" })).toBe(1);
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "1.5" })).toBe(1.5);
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "0.8" })).toBe(0.8);
  });

  it("falls back to the default outside atempo's supported range", () => {
    // ffmpeg's atempo errors beyond [0.5, 2], which would fail the whole
    // narration pass for a typo in an env var.
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "0.2" })).toBeCloseTo(1.2);
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "3" })).toBeCloseTo(1.2);
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "nope" })).toBeCloseTo(1.2);
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "" })).toBeCloseTo(1.2);
  });
});

describe("ttsTempo (provider hint)", () => {
  it("takes the provider's own tempo when the env doesn't override it", () => {
    // ElevenLabs reads at a voiceover pace already, so it asks for a milder
    // nudge than the Gemini-tuned default.
    expect(ttsTempo({}, 1.1)).toBeCloseTo(1.1);
    expect(ttsTempo({}, 1)).toBe(1);
  });

  it("lets $DAILIES_TTS_TEMPO beat the provider hint", () => {
    expect(ttsTempo({ DAILIES_TTS_TEMPO: "1.5" }, 1.1)).toBe(1.5);
  });

  it("ignores an out-of-range hint", () => {
    expect(ttsTempo({}, 4)).toBeCloseTo(1.2);
    expect(ttsTempo({}, Number.NaN)).toBeCloseTo(1.2);
  });
});
