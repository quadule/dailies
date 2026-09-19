// Which provider voices, scores, and paints the cinematic cut — when the user
// has a preference. Without one, narrate.ts picks per slot from whatever is
// configured (local first, then hosted, then the free/stock fallbacks); with one,
// that slot is PINNED: the named provider is used or, if it isn't available,
// the slot degrades loudly instead of silently switching to something else —
// the same rule $DAILIES_LLM applies to the text provider.
//
// Surfaces: `session end --narrator/--music/--image <provider>` (a flag wins),
// then $DAILIES_NARRATOR / $DAILIES_MUSIC / $DAILIES_IMAGE. Names are the short
// provider names a person would say ("elevenlabs", "gemini"); a few aliases
// are accepted so an agent passing a user's words through ("Lyria", "ACE-Step",
// "archive.org") doesn't have to translate them.

export const NARRATOR_CHOICES = [
  "elevenlabs",
  "gemini",
  "omlx",
  "say",
] as const;
export const MUSIC_CHOICES = [
  "elevenlabs",
  "gemini",
  "acestep",
  "archive",
  "none",
] as const;
export const IMAGE_CHOICES = [
  "elevenlabs",
  "gemini",
  "local",
  "wikimedia",
  "gradient",
  "none",
] as const;

export type NarratorChoice = (typeof NARRATOR_CHOICES)[number];
export type MusicChoice = (typeof MUSIC_CHOICES)[number];
export type ImageChoice = (typeof IMAGE_CHOICES)[number];

export interface MediaPreferences {
  // Who paints the title-card background.
  image?: ImageChoice;
  // Who composes the score — and, in --song mode, who sings.
  music?: MusicChoice;
  // Who voices the narration (narration mode only; ignored by --song).
  narrator?: NarratorChoice;
}

// The environment variable behind each flag.
export const MEDIA_PREFERENCE_ENV = {
  narrator: "DAILIES_NARRATOR",
  music: "DAILIES_MUSIC",
  image: "DAILIES_IMAGE",
} as const;

// Spellings people (and agents relaying people) use for the same provider.
const ALIASES: Record<string, string> = {
  "11labs": "elevenlabs",
  eleven: "elevenlabs",
  "eleven-labs": "elevenlabs",
  "eleven-music": "elevenlabs",
  elevenmusic: "elevenlabs",
  google: "gemini",
  lyria: "gemini",
  "nano-banana": "gemini",
  nanobanana: "gemini",
  vertex: "gemini",
  "vertex-ai": "gemini",
  "ace-step": "acestep",
  "archive.org": "archive",
  "internet-archive": "archive",
  stock: "archive",
  "wikimedia-commons": "wikimedia",
  commons: "wikimedia",
  macos: "say",
  system: "say",
  apple: "say",
  local: "local",
  "local-image": "local",
  "local-gradient": "gradient",
  off: "none",
  no: "none",
  false: "none",
};

function normalize(value: string): string {
  // "Nano Banana", "ace_step" and "ACE-Step" all mean the same provider.
  const lowered = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return ALIASES[lowered] ?? lowered;
}

function isChoice<T extends string>(
  choices: readonly T[],
  value: string
): value is T {
  return (choices as readonly string[]).includes(value);
}

export interface MediaPreferenceFlags {
  image?: string;
  music?: string;
  narrator?: string;
}

// Resolve the three preferences from flags (first) and env (second). Returns
// the normalized preferences, or one error naming the bad value, where it came
// from, and the valid choices — so a typo fails the command in one turn rather
// than silently falling through to the default chain. Pure → unit-tested.
export function parseMediaPreferences(
  flags: MediaPreferenceFlags,
  env: NodeJS.ProcessEnv = process.env
): { preferences: MediaPreferences } | { error: string } {
  const preferences: MediaPreferences = {};
  const slots: {
    key: keyof MediaPreferences;
    choices: readonly string[];
    what: string;
  }[] = [
    { key: "narrator", choices: NARRATOR_CHOICES, what: "narration voice" },
    { key: "music", choices: MUSIC_CHOICES, what: "music" },
    { key: "image", choices: IMAGE_CHOICES, what: "title-art" },
  ];
  for (const slot of slots) {
    const fromFlag = flags[slot.key]?.trim();
    const envName = MEDIA_PREFERENCE_ENV[slot.key];
    const fromEnv = env[envName]?.trim();
    const raw = fromFlag || fromEnv;
    if (!raw) {
      continue;
    }
    const value = normalize(raw);
    if (!isChoice(slot.choices, value)) {
      const source = fromFlag ? `--${slot.key}` : `$${envName}`;
      return {
        error: `${source} "${raw}" is not a ${slot.what} provider; valid: ${slot.choices.join(", ")}`,
      };
    }
    (preferences as Record<string, string>)[slot.key] = value;
  }
  return { preferences };
}

// One line describing the pins in force, for the run log ("narrator=elevenlabs,
// music=none"), or undefined when nothing is pinned. Pure.
export function describeMediaPreferences(
  preferences: MediaPreferences | undefined
): string | undefined {
  if (!preferences) {
    return;
  }
  const parts = (["narrator", "music", "image"] as const)
    .filter((key) => preferences[key])
    .map((key) => `${key}=${preferences[key]}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}
