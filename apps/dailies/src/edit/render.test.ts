import { describe, expect, it } from "vitest";
import { narratorOf, voiceFromLabel } from "./render.js";

describe("narratorOf", () => {
  it("maps a TTS provider id to the narrator a cut names", () => {
    expect(narratorOf("gemini-tts")).toBe("gemini");
    expect(narratorOf("elevenlabs-tts")).toBe("elevenlabs");
    expect(narratorOf("omlx-tts")).toBe("omlx");
    expect(narratorOf("mystery-tts")).toBeUndefined();
  });
});

describe("voiceFromLabel", () => {
  it("reads the voice out of a provider label", () => {
    expect(voiceFromLabel("gemini:Charon")).toBe("Charon");
    expect(voiceFromLabel("elevenlabs:Aria")).toBe("Aria");
    expect(voiceFromLabel("omlx:kokoro/af_heart")).toBe("af_heart");
  });

  it("names no voice for a model that uses its default", () => {
    expect(voiceFromLabel("omlx:kokoro")).toBeUndefined();
  });
});
