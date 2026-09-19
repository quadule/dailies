import { describe, expect, it } from "vitest";
import {
  buildModelCredits,
  type MediaCandidates,
  selectMediaProviders,
  titleArtToolName,
  voiceCredit,
} from "./narrate.js";
import type {
  MusicProvider,
  TitleBackgroundProvider,
  TtsProvider,
} from "./providers.js";

// Inert providers: only their ids matter to the selection.
function tts(id: string): TtsProvider {
  return { id, label: id, synthesize: () => Promise.resolve() };
}
function music(id: string, singsLyrics?: boolean): MusicProvider {
  return {
    id,
    singsLyrics,
    bed: () => Promise.resolve(),
    song: () => Promise.resolve(),
  };
}
function image(id: string): TitleBackgroundProvider {
  return { id, render: () => Promise.resolve() };
}

// Everything configured at once — the richest environment the chain sees.
const everything: MediaCandidates = {
  tts: {
    omlx: tts("omlx-tts"),
    elevenlabs: tts("elevenlabs-tts"),
    gemini: tts("gemini-tts"),
  },
  music: {
    archive: music("archive-music"),
    acestep: music("acestep-music", true),
    elevenlabs: music("elevenlabs-music", true),
    gemini: music("gemini-music", true),
  },
  archiveExplicit: false,
  image: {
    local: image("local-image"),
    gemini: image("gemini-image"),
    elevenlabs: image("elevenlabs-image"),
    wikimedia: image("wikimedia-image"),
  },
};

const nothing: MediaCandidates = {
  tts: {},
  music: {},
  archiveExplicit: false,
  image: {},
};

describe("selectMediaProviders (no preference)", () => {
  it("prefers local, then hosted keys, per slot", () => {
    const s = selectMediaProviders({ candidates: everything });
    expect(s.providers.tts?.id).toBe("omlx-tts");
    expect(s.providers.music?.id).toBe("acestep-music");
    expect(s.providers.titleBackground?.id).toBe("local-image");
    expect(s.skip).toBeUndefined();
    expect(s.notes).toEqual([]);
    expect(s.noTitleBackground).toBe(false);
  });

  it("puts ElevenLabs ahead of Gemini once the local servers are gone", () => {
    const s = selectMediaProviders({
      candidates: {
        ...everything,
        tts: { elevenlabs: tts("elevenlabs-tts"), gemini: tts("gemini-tts") },
        music: {
          elevenlabs: music("elevenlabs-music", true),
          gemini: music("gemini-music", true),
        },
        image: {
          gemini: image("gemini-image"),
          elevenlabs: image("elevenlabs-image"),
          wikimedia: image("wikimedia-image"),
        },
      },
    });
    expect(s.providers.tts?.id).toBe("elevenlabs-tts");
    expect(s.providers.music?.id).toBe("elevenlabs-music");
    // The ElevenLabs image flow is opt-in: never chosen unpinned.
    expect(s.providers.titleBackground?.id).toBe("gemini-image");
  });

  it("uses archive.org as the no-model fallback, and first when forced on", () => {
    const auto = selectMediaProviders({
      candidates: { ...nothing, music: { archive: music("archive-music") } },
    });
    expect(auto.providers.music?.id).toBe("archive-music");
    const forced = selectMediaProviders({
      candidates: { ...everything, archiveExplicit: true },
    });
    expect(forced.providers.music?.id).toBe("archive-music");
  });

  it("leaves the slots empty (say / gradient / no score) with nothing configured", () => {
    const s = selectMediaProviders({ candidates: nothing });
    expect(s.providers.tts).toBeUndefined();
    expect(s.providers.music).toBeUndefined();
    expect(s.providers.titleBackground).toBeUndefined();
    expect(s.skip).toBeUndefined();
  });

  it("song mode: the singer must sing supplied lyrics, so stock music is never it", () => {
    const s = selectMediaProviders({
      candidates: { ...everything, archiveExplicit: true },
      song: true,
    });
    // The score slot still honors the forced stock pick…
    expect(s.providers.music?.id).toBe("archive-music");
    // …but the singer is the first lyrics-capable model.
    expect(s.singingMusic?.id).toBe("acestep-music");
    expect(s.providers.tts).toBeUndefined();
  });
});

describe("selectMediaProviders (pinned)", () => {
  it("takes exactly the named provider for each slot", () => {
    const s = selectMediaProviders({
      candidates: everything,
      preferences: {
        narrator: "gemini",
        music: "elevenlabs",
        image: "wikimedia",
      },
    });
    expect(s.providers.tts?.id).toBe("gemini-tts");
    expect(s.providers.music?.id).toBe("elevenlabs-music");
    expect(s.providers.titleBackground?.id).toBe("wikimedia-image");
    expect(s.notes).toEqual([]);
  });

  it("narrator=say empties the slot even when hosted voices are configured", () => {
    const s = selectMediaProviders({
      candidates: everything,
      preferences: { narrator: "say" },
    });
    expect(s.providers.tts).toBeUndefined();
    expect(s.skip).toBeUndefined();
  });

  it("skips the pass (never a silent switch) when the pinned narrator is missing", () => {
    const s = selectMediaProviders({
      candidates: { ...everything, tts: { gemini: tts("gemini-tts") } },
      preferences: { narrator: "elevenlabs" },
    });
    expect(s.providers.tts).toBeUndefined();
    expect(s.skip).toContain("narrator pinned to elevenlabs");
    expect(s.skip).toContain("ELEVENLABS_API_KEY");
  });

  it("ignores a narrator pin in song mode, with a note", () => {
    const s = selectMediaProviders({
      candidates: everything,
      preferences: { narrator: "elevenlabs" },
      song: true,
    });
    expect(s.skip).toBeUndefined();
    expect(s.notes.join("\n")).toContain("ignored");
  });

  it("music=none silences the score, and skips a song", () => {
    const plain = selectMediaProviders({
      candidates: everything,
      preferences: { music: "none" },
    });
    expect(plain.providers.music).toBeUndefined();
    expect(plain.notes.join("\n")).toContain("no music");
    expect(plain.skip).toBeUndefined();
    const sung = selectMediaProviders({
      candidates: everything,
      preferences: { music: "none" },
      song: true,
    });
    expect(sung.skip).toContain("pinned to none");
  });

  it("a missing pinned music provider degrades with a note (narration) or skips (song)", () => {
    const candidates = {
      ...everything,
      music: { gemini: music("gemini-music", true) },
    };
    const plain = selectMediaProviders({
      candidates,
      preferences: { music: "acestep" },
    });
    expect(plain.providers.music).toBeUndefined();
    expect(plain.notes.join("\n")).toContain("music pinned to acestep");
    expect(plain.notes.join("\n")).toContain("ACE-Step server");
    const sung = selectMediaProviders({
      candidates,
      preferences: { music: "acestep" },
      song: true,
    });
    expect(sung.skip).toContain("music pinned to acestep");
  });

  it("a pinned singer that cannot sing skips song mode", () => {
    const s = selectMediaProviders({
      candidates: everything,
      preferences: { music: "archive" },
      song: true,
    });
    expect(s.providers.music?.id).toBe("archive-music");
    expect(s.singingMusic).toBeUndefined();
    expect(s.skip).toContain("archive can't");
  });

  it("image=gradient leaves the slot for the local gradient; image=none asks for a solid card", () => {
    const gradient = selectMediaProviders({
      candidates: everything,
      preferences: { image: "gradient" },
    });
    expect(gradient.providers.titleBackground).toBeUndefined();
    expect(gradient.noTitleBackground).toBe(false);
    const none = selectMediaProviders({
      candidates: everything,
      preferences: { image: "none" },
    });
    expect(none.providers.titleBackground).toBeUndefined();
    expect(none.noTitleBackground).toBe(true);
  });

  it("a missing pinned image provider falls back to the gradient with a note", () => {
    const s = selectMediaProviders({
      candidates: { ...everything, image: { gemini: image("gemini-image") } },
      preferences: { image: "elevenlabs" },
    });
    expect(s.providers.titleBackground).toBeUndefined();
    expect(s.notes.join("\n")).toContain("title art pinned to elevenlabs");
    expect(s.notes.join("\n")).toContain("ELEVENLABS_API_KEY");
  });
});

describe("ElevenLabs credits", () => {
  it("names the voice, the music, and the title art", () => {
    expect(voiceCredit("elevenlabs-tts", "elevenlabs:Sarah")).toBe(
      "Voice — Sarah (ElevenLabs)"
    );
    expect(titleArtToolName("elevenlabs-image")).toBe(
      "Title art — ElevenLabs Image"
    );
    expect(
      buildModelCredits({
        voiceLabel: "elevenlabs:Brian",
        ttsId: "elevenlabs-tts",
        musicId: "elevenlabs-music",
        titleArtId: undefined,
      })
    ).toEqual([
      "Narration — Claude (Anthropic)",
      "Voice — Brian (ElevenLabs)",
      "Music — Eleven Music (ElevenLabs)",
    ]);
  });
});
