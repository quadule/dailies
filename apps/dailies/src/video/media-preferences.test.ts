import { describe, expect, it } from "vitest";
import {
  describeMediaPreferences,
  IMAGE_CHOICES,
  MUSIC_CHOICES,
  NARRATOR_CHOICES,
  parseMediaPreferences,
} from "./media-preferences.js";

describe("parseMediaPreferences", () => {
  it("returns no pins when nothing is asked for", () => {
    expect(parseMediaPreferences({}, {})).toEqual({ preferences: {} });
    expect(parseMediaPreferences({ narrator: "  " }, {})).toEqual({
      preferences: {},
    });
  });

  it("accepts each documented choice for each slot", () => {
    for (const narrator of NARRATOR_CHOICES) {
      expect(parseMediaPreferences({ narrator }, {})).toEqual({
        preferences: { narrator },
      });
    }
    for (const music of MUSIC_CHOICES) {
      expect(parseMediaPreferences({ music }, {})).toEqual({
        preferences: { music },
      });
    }
    for (const image of IMAGE_CHOICES) {
      expect(parseMediaPreferences({ image }, {})).toEqual({
        preferences: { image },
      });
    }
  });

  it("normalizes case and the spellings people actually use", () => {
    expect(parseMediaPreferences({ narrator: "ElevenLabs" }, {})).toEqual({
      preferences: { narrator: "elevenlabs" },
    });
    expect(parseMediaPreferences({ music: "Lyria" }, {})).toEqual({
      preferences: { music: "gemini" },
    });
    expect(parseMediaPreferences({ music: "ACE-Step" }, {})).toEqual({
      preferences: { music: "acestep" },
    });
    expect(parseMediaPreferences({ music: "archive.org" }, {})).toEqual({
      preferences: { music: "archive" },
    });
    expect(parseMediaPreferences({ music: "off" }, {})).toEqual({
      preferences: { music: "none" },
    });
    expect(parseMediaPreferences({ image: "Nano Banana" }, {})).toEqual({
      preferences: { image: "gemini" },
    });
    expect(parseMediaPreferences({ image: "Wikimedia Commons" }, {})).toEqual({
      preferences: { image: "wikimedia" },
    });
    expect(parseMediaPreferences({ narrator: "macOS" }, {})).toEqual({
      preferences: { narrator: "say" },
    });
  });

  it("reads the env vars, and lets a flag beat them", () => {
    const env = {
      DAILIES_NARRATOR: "gemini",
      DAILIES_MUSIC: "none",
      DAILIES_IMAGE: "wikimedia",
    };
    expect(parseMediaPreferences({}, env)).toEqual({
      preferences: { narrator: "gemini", music: "none", image: "wikimedia" },
    });
    expect(parseMediaPreferences({ narrator: "elevenlabs" }, env)).toEqual({
      preferences: {
        narrator: "elevenlabs",
        music: "none",
        image: "wikimedia",
      },
    });
  });

  it("rejects an unknown provider, naming the source and the valid choices", () => {
    const fromFlag = parseMediaPreferences({ narrator: "polly" }, {});
    expect(fromFlag).toEqual({
      error:
        '--narrator "polly" is not a narration voice provider; valid: elevenlabs, gemini, omlx, say',
    });
    const fromEnv = parseMediaPreferences({}, { DAILIES_IMAGE: "dalle" });
    expect("error" in fromEnv && fromEnv.error).toContain(
      '$DAILIES_IMAGE "dalle"'
    );
    expect("error" in fromEnv && fromEnv.error).toContain("gradient, none");
    // A provider that exists for another slot is still wrong for this one.
    expect("error" in parseMediaPreferences({ narrator: "acestep" }, {})).toBe(
      true
    );
    expect("error" in parseMediaPreferences({ music: "say" }, {})).toBe(true);
  });
});

describe("describeMediaPreferences", () => {
  it("summarizes the pins in force, or nothing", () => {
    expect(describeMediaPreferences(undefined)).toBeUndefined();
    expect(describeMediaPreferences({})).toBeUndefined();
    expect(
      describeMediaPreferences({ narrator: "elevenlabs", music: "none" })
    ).toBe("narrator=elevenlabs, music=none");
  });
});
