// Narration voicing: parsing `say -v ?` output, picking the session voice/rate,
// and building the speech synth (macOS `say`, a $DAILIES_SAY_COMMAND override, or
// a TTS provider) that renderClip drives. `SpeechSynth`/`speechText`/
// `resolveSpeech` are used by narrate's clip rendering, so they're exported.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Echo, run, VERSION_PROBE_TIMEOUT_MS } from "./ffmpeg.js";
import type { MediaProviders } from "./providers.js";
import { shellQuote } from "./shell.js";

const execFileAsync = promisify(execFile);

// A parsed `say -v '?'` entry. `full` is the exact string to pass to `say -v`,
// INCLUDING any "(Premium)"/"(Enhanced)" suffix — passing the bare name selects
// the low-quality compact variant even when a premium one is installed, which is
// why local narration used to sound robotic. `quality` lets us prefer the
// higher-fidelity downloads; `locale` lets us prefer US English.
export interface InstalledVoice {
  full: string;
  locale: string;
  name: string;
  quality: "Premium" | "Enhanced" | "Default";
}

// Last-resort voice that ships on every Mac, used only when no installed voice
// can be parsed. One voice is picked per session (consistency) — an explicit
// premium/enhanced English voice when available, else $DAILIES_SAY_VOICE.
const FALLBACK_VOICE = "Samantha";

// `say` speaking rate (words per minute). Default tuned for intelligibility;
// overridable via $DAILIES_SAY_RATE.
const DEFAULT_SAY_RATE = 175;

const SAY_TIMEOUT_MS = 60_000;

// How to turn narration text into a raw audio file: `ext` is that file's
// extension, `run` writes it. A say-backed synth writes .aiff; a TTS provider
// writes .wav. renderClip is otherwise provider-agnostic.
export interface SpeechSynth {
  ext: string;
  run: (text: string, outPath: string) => Promise<void>;
}

// Parse `say -v '?'` output into structured voices. Each line is
// "<Name>[ (Quality)]   <locale>   # sample" — columns separated by runs of
// spaces. macOS lists only the highest-quality installed build of each voice
// but keeps a hidden compact build reachable by identifier (verified:
// `say -v com.apple.voice.compact.en-US.Ava` succeeds with audible-quality
// audio distinct from "Ava (Premium)"). Passing the full listed token,
// INCLUDING its "(Premium)"/"(Enhanced)" suffix, pins the listed (high-quality)
// variant; we keep the quality tag and locale so the picker can prefer the
// premium/enhanced US-English downloads over a plain compact voice.
export function parseInstalledVoices(stdout: string): InstalledVoice[] {
  const voices: InstalledVoice[] = [];
  for (const line of stdout.split("\n")) {
    // Name column ends at the first run of 2+ spaces, before the BCP-47-ish
    // locale (en_US / en-US / en_GB). Intra-name spaces are single, so a
    // multi-word voice name ("Bad News") stays intact.
    const match = line.match(/^(.+?)\s{2,}([A-Za-z]{2}[-_][A-Za-z]{2})\b/);
    if (!(match?.[1] && match[2])) {
      continue;
    }
    const full = match[1].trim();
    if (!full) {
      continue;
    }
    // The capture group is exactly "Premium" or "Enhanced" when present.
    const qualityMatch = /\((Premium|Enhanced)\)\s*$/.exec(full);
    const quality: InstalledVoice["quality"] = qualityMatch
      ? (qualityMatch[1] as "Premium" | "Enhanced")
      : "Default";
    const name = full.replace(/\s*\((?:Premium|Enhanced)\)\s*$/, "").trim();
    voices.push({ full, name, quality, locale: match[2].replace("-", "_") });
  }
  return voices;
}

// The command used to synthesize speech, `say` by default. Override with
// $DAILIES_SAY_COMMAND to point at a say-compatible binary — a non-macOS TTS tool,
// or a wrapper that authorizes a macOS Personal Voice (e.g. a one-line script:
// `exec env DYLD_INSERT_LIBRARIES=…/mysay.dylib say "$@"`; see SavePersonalVoiceAudio).
// It's invoked with the same argv `say` gets: `-v <voice> -r <rate> <text> -o <out>`.
export function sayCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.DAILIES_SAY_COMMAND?.trim() || "say";
}

// List the voices the say command can use, or null if it's missing/unusable or
// doesn't support the `-v ?` listing (a custom non-macOS command may not). Used
// as the precondition probe and to constrain the voice pick to installed voices.
async function listSayVoices(
  command: string
): Promise<InstalledVoice[] | null> {
  try {
    const { stdout } = await run(
      command,
      ["-v", "?"],
      VERSION_PROBE_TIMEOUT_MS
    );
    return parseInstalledVoices(stdout);
  } catch {
    return null;
  }
}

// Pick the session voice and return the exact `-v` string. An explicit
// $DAILIES_SAY_VOICE always wins (the user asked for it; let `say` error loudly
// if it's wrong). Otherwise prefer the highest-fidelity US-English download
// actually installed — Premium over Enhanced, US English over other English,
// English over anything — because a bare/compact voice (e.g. the default
// Samantha) is what made earlier narration sound robotic. Falls back to
// "Samantha" so a fresh Mac without premium downloads still narrates.
export function pickVoice(voices: InstalledVoice[]): string {
  const override = process.env.DAILIES_SAY_VOICE;
  if (override) {
    return override;
  }
  const isEnglish = (v: InstalledVoice) => /^en[-_]/i.test(v.locale);
  const isUsEnglish = (v: InstalledVoice) => /^en[-_]us$/i.test(v.locale);
  const premium = voices.filter((v) => v.quality === "Premium");
  const enhanced = voices.filter((v) => v.quality === "Enhanced");
  // Tiers from most to least preferred; first non-empty tier wins.
  const tiers: InstalledVoice[][] = [
    premium.filter(isUsEnglish),
    premium.filter(isEnglish),
    premium,
    enhanced.filter(isUsEnglish),
    enhanced.filter(isEnglish),
    enhanced,
    voices.filter((v) => isEnglish(v) && v.name === FALLBACK_VOICE),
    voices.filter(isEnglish),
  ];
  for (const tier of tiers) {
    if (tier.length > 0) {
      const pick = tier[Math.floor(Math.random() * tier.length)];
      if (pick) {
        return pick.full;
      }
    }
  }
  return FALLBACK_VOICE;
}

function pickRate(): number {
  const override = Number(process.env.DAILIES_SAY_RATE);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_SAY_RATE;
}

function saySynth(
  command: string,
  voice: string,
  rate: number,
  echo?: Echo
): SpeechSynth {
  return {
    ext: "aiff",
    run: (text, outPath) =>
      run(
        command,
        ["-v", voice, "-r", String(rate), text, "-o", outPath],
        SAY_TIMEOUT_MS,
        echo
      ).then(() => undefined),
  };
}

// Run a $DAILIES_SAY_COMMAND override through the shell so the command STRING can
// carry its own arguments (flags, quoting, redirects). The text to speak is the
// only argument we append (passed as the positional "$@", never interpolated, so
// narration can't inject shell). The output path and the voice ride in the
// environment: $DAILIES_SAY_OUTPUT is where the command must write the audio, and
// $DAILIES_SAY_VOICE (if the user set it) is inherited for the command to read.
async function runSayCommand(
  command: string,
  text: string,
  outPath: string,
  echo?: Echo
): Promise<void> {
  echo?.(
    `$ DAILIES_SAY_OUTPUT=${shellQuote(outPath)} ${command} ${shellQuote(text)}`
  );
  await execFileAsync("/bin/sh", ["-c", `${command} "$@"`, "sh", text], {
    timeout: SAY_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DAILIES_SAY_OUTPUT: outPath },
  });
}

// Synth for a $DAILIES_SAY_COMMAND override. The command may not be `say`, so we
// impose no say-specific flags — it gets the text (only) and writes to
// $DAILIES_SAY_OUTPUT. Use it for a non-macOS TTS tool, or a wrapper that voices a
// macOS Personal Voice, e.g. (chmod +x, then point $DAILIES_SAY_COMMAND at it):
//   exec env DYLD_INSERT_LIBRARIES=…/mysay.dylib \
//     say -v "$DAILIES_SAY_VOICE" -o "$DAILIES_SAY_OUTPUT" "$1"
export function customSaySynth(command: string, echo?: Echo): SpeechSynth {
  return {
    ext: "aiff",
    run: (text, outPath) => runSayCommand(command, text, outPath, echo),
  };
}

// Decide how narration gets voiced: a TTS provider when present, with the `say`
// command as the fallback. `say` is macOS-only, but $DAILIES_SAY_COMMAND can point
// at a say-compatible binary (a non-macOS tool, or a Personal Voice shim), so the
// say path is also taken off-macOS when that's set. Returns the say synth (if
// usable here), the rate, and a reproducibility voice label — or null when
// there's NO way to voice it, so cinematic can run anywhere a key/command is set.
export async function resolveSpeech(
  providers: MediaProviders,
  notes: string[],
  echo?: Echo
): Promise<{ say?: SpeechSynth; rate: number; label: string } | null> {
  const rate = pickRate();
  const command = sayCommand();
  const voiceOverride = process.env.DAILIES_SAY_VOICE?.trim();
  let say: SpeechSynth | undefined;
  let sayLabel = "";
  if (command !== "say") {
    // Custom command: it owns voice/rate, so we only feed it text + output. Works
    // on any platform. Prefer $DAILIES_SAY_VOICE for the label (the command string
    // itself — often a long shim with paths — is noise in credits/meta); the full
    // command is still shown by the per-call echo for reproducibility.
    say = customSaySynth(command, echo);
    sayLabel = voiceOverride || command;
  } else if (process.platform === "darwin") {
    const installed = await listSayVoices(command);
    // An explicit $DAILIES_SAY_VOICE always wins and works even when listing
    // fails. Otherwise pick the best installed voice.
    const voice =
      voiceOverride || (installed ? pickVoice(installed) : undefined);
    if (voice) {
      say = saySynth(command, voice, rate, echo);
      // sayLabel is the full `-v` identifier (e.g. "Ava (Premium)"), surfaced in
      // meta so a good run can be reproduced via $DAILIES_SAY_VOICE.
      sayLabel = voice;
      // The compact voices are the ones that sound robotic. macOS hides a
      // compact build behind every premium/enhanced voice, so a name like
      // "Ava (Premium)" DOES reach the premium asset — but if no premium or
      // enhanced English voice is installed at all, the pick falls through to a
      // compact voice. When that happens and no higher-quality TTS provider is
      // configured, say so, since it's the usual cause of robotic narration.
      const chosen = installed?.find((v) => v.full === voice);
      const fellBackToCompact = !chosen || chosen.quality === "Default";
      if (!(providers.tts || voiceOverride) && fellBackToCompact) {
        notes.push(
          "no premium/enhanced English voice installed — narration uses the compact (robotic-sounding) voice; download one in System Settings › Accessibility › Spoken Content › System Voice (e.g. Ava, Zoe), or set GEMINI_API_KEY (or GOOGLE_APPLICATION_CREDENTIALS for a Vertex service account) for higher-quality TTS"
        );
      }
    }
  }
  if (!(providers.tts || say)) {
    return null;
  }
  return { say, rate, label: providers.tts?.label ?? sayLabel };
}

// Rewrite narration for the ear before handing it to a TTS engine. macOS `say`
// (and some other engines) read a slash aloud as the word "slash" and stumble on
// a pipe — but verse/poem narration uses "/" (and "|") as LINE separators. Turn
// any run of them into a comma so it becomes a natural spoken pause instead.
// Only the SPOKEN audio is affected — captions keep the original text (with its
// slashes), so this must be applied at the synth boundary, not to the stored
// narration. Kept deliberately narrow (per "without getting too complicated").
// Pure → unit-tested.
export function speechText(narration: string): string {
  return narration
    .replace(/\s*[/|]+\s*/g, ", ") // slash/pipe separators → a spoken pause
    .replace(/\s+([,.;:!?])/g, "$1") // drop space left before punctuation
    .replace(/([,;:])(?:\s*\1)+/g, "$1") // collapse doubled separators
    .replace(/\s{2,}/g, " ")
    .trim();
}
