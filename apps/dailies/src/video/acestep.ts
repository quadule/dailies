// Local music generation via an ACE-Step 1.5 server (Apple-Silicon MLX backend).
// Additive provider mirroring omlx.ts / providers.ts: same contract (write a
// finished audio file to `outPath` or throw), wrapped in the caller's try/catch
// so a failure degrades to the Gemini music path or to no music.
//
// WHY SEPARATE FROM oMLX: oMLX serves TTS/LLM but rejects the ACE-Step model
// ("Model type acestep not supported"), so music needs ACE-Step's own server. It
// runs on its own port (8001 by default) and speaks an OpenAI chat-completions
// dialect: the song request is encoded as <prompt>…</prompt><lyrics>…</lyrics> in
// the user message, with a top-level `duration`, and the audio comes back as a
// base64 data URL at choices[0].message.audio[0].audio_url.url.
//
// PRIVACY: directionText is sent only to the configured (local by default) ACE-
// Step server. Any API key is read from env, never logged or echoed (the curl
// preview uses a $DAILIES_ACESTEP_API_KEY placeholder).
import type { Logger } from "dailies-logger";
import { writeFileAtomic } from "./media-files.js";
import type { MediaProviders, MusicProvider } from "./providers.js";
import { singleQuote } from "./shell.js";

const DEFAULT_URL = "http://127.0.0.1:8001";
const MODELS_TIMEOUT_MS = 4000;
// Music generation is slow (LM plan + diffusion); give it a generous budget.
const GENERATE_TIMEOUT_MS = 600_000;

type Echo = (line: string) => void;

export interface AceStepConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
}

export function acestepBaseUrl(env: NodeJS.ProcessEnv): string {
  return env.DAILIES_ACESTEP_URL?.trim() || DEFAULT_URL;
}

// Whether a base URL points at the local machine. Used only to phrase the
// provider note accurately (a remote server means the lyrics/direction leave this
// machine). Pure → unit-tested.
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(:\d+)?(\/|$)/i.test(
    url.trim()
  );
}

// Build the user-message content for ACE-Step's three modes:
//   - instrumental BED: tagged mode — <prompt> (style/caption) + "[instrumental]".
//   - SONG with explicit lyrics (song mode): tagged mode — <prompt> (genre/mood) +
//     the supplied lyrics, so ACE-Step SINGS those exact words.
//   - SONG without lyrics: natural-language sample mode (see buildMusicPayload),
//     where the content is just the creative direction and the LM writes lyrics.
// Pure → unit-tested.
export function buildMusicContent(
  directionText: string,
  instrumental: boolean,
  lyrics?: string
): string {
  if (instrumental) {
    return `<prompt>${directionText}</prompt><lyrics>[instrumental]</lyrics>`;
  }
  const supplied = lyrics?.trim();
  if (supplied) {
    return `<prompt>${directionText}</prompt><lyrics>${supplied}</lyrics>`;
  }
  return directionText;
}

// Build the chat-completions payload. CRITICAL nuances learned from live runs:
//   - duration (and vocal_language) live under `audio_config`, NOT top level — a
//     top-level duration is ignored (server falls back to a multi-minute ceiling).
//   - ALWAYS pin the duration, INCLUDING a song with explicit lyrics. It's honored
//     exactly (a 90s request yields 90.000s of audio) AND the song still sings —
//     re-verified live at 45/60/90/120s, every one with full vocals. An earlier
//     note claimed pinning a duration on a tagged-lyric song came out INSTRUMENTAL;
//     that was stale for this model version (acestep-v15-turbo). Pinning makes the
//     length deterministic so the caller can size the song to its lyrics, instead
//     of the model auto-picking an inconsistent 45–205s and singing sparsely. (Once
//     the written lines are exhausted the model repeats/holds to fill the rest; the
//     caller trims that tail to the last distinct sung line.)
//   - A song WITHOUT lyrics uses top-level `sample_mode` (LM writes its own lyrics)
//     and keeps a duration (it's background, e.g. the credits bed).
//   - An instrumental bed keeps its duration (it must match a target length).
// Pure → unit-tested.
export function buildMusicPayload(args: {
  directionText: string;
  seconds: number;
  instrumental: boolean;
  lyrics?: string;
  model?: string;
}): Record<string, unknown> {
  const audioConfig: Record<string, unknown> = {
    duration: Math.max(1, Math.round(args.seconds)),
  };
  const payload: Record<string, unknown> = {
    messages: [
      {
        role: "user",
        content: buildMusicContent(
          args.directionText,
          args.instrumental,
          args.lyrics
        ),
      },
    ],
    audio_config: audioConfig,
  };
  if (!args.instrumental) {
    // Any vocal track picks an output language. Only let the LM invent lyrics
    // (sample_mode) when none were supplied — with explicit lyrics, tagged mode
    // sings them verbatim.
    audioConfig.vocal_language = "en";
    if (!args.lyrics?.trim()) {
      payload.sample_mode = true;
    }
    // Enable the LM "Songwriter" planning pass (ACE-Step's `thinking` mode) for any
    // sung track. This is the single biggest lever on LYRIC ADHERENCE: with it off,
    // the model skips most lines (verified live — 1 of 8 lines sung); with it on it
    // sings them in order (8 of 8). The project defaults it to True, but the
    // OpenAI-compatible endpoint defaults it to FALSE, so we must set it explicitly.
    // Instrumental beds don't need it (no lyrics to plan) and skip the extra time.
    payload.thinking = true;
  }
  if (args.model) {
    payload.model = args.model;
  }
  return payload;
}

// Extract audio bytes from a base64 data URL (data:audio/…;base64,<data>).
// Returns null when the value isn't a base64 data URL. Pure → unit-tested.
export function parseAudioDataUrl(url: unknown): Buffer | null {
  if (typeof url !== "string" || !url.startsWith("data:")) {
    return null;
  }
  const comma = url.indexOf(",");
  if (comma < 0 || !/;base64/i.test(url.slice(0, comma))) {
    return null;
  }
  const bytes = Buffer.from(url.slice(comma + 1), "base64");
  return bytes.length > 0 ? bytes : null;
}

// Pull the first audio data URL out of a chat-completions response. Pure.
export function audioFromResponse(body: unknown): Buffer | null {
  const choice = (body as { choices?: { message?: unknown }[] })?.choices?.[0];
  const audio = (choice?.message as { audio?: unknown[] })?.audio?.[0];
  const url = (audio as { audio_url?: { url?: unknown } })?.audio_url?.url;
  return parseAudioDataUrl(url);
}

// Pull the model's LRC (per-line lyric timestamps) out of a chat-completions
// response, when present. The stock ACE-Step server does NOT return this; a server
// patched to run get_lyric_timestamp surfaces it at `choices[0].message.lrc`
// (a string of "[mm:ss.xx]line" lines). Returns undefined when absent. Pure.
export function lrcFromResponse(body: unknown): string | undefined {
  const choice = (body as { choices?: { message?: unknown }[] })?.choices?.[0];
  const lrc = (choice?.message as { lrc?: unknown })?.lrc;
  return typeof lrc === "string" && lrc.trim() ? lrc : undefined;
}

// Redacted, copy-pasteable curl preview (key shown as the env-var reference).
export function describeMusicCurl(args: {
  baseUrl: string;
  payload: Record<string, unknown>;
  hasKey: boolean;
}): string {
  const auth = args.hasKey
    ? ['-H "Authorization: Bearer $DAILIES_ACESTEP_API_KEY"']
    : [];
  return [
    "curl -s -X POST",
    `${args.baseUrl}/v1/chat/completions`,
    ...auth,
    "-H 'content-type: application/json'",
    `-d ${singleQuote(JSON.stringify(args.payload))}`,
  ].join(" ");
}

function authHeaders(config: AceStepConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

// Probe reachability + list model ids, or null if unreachable.
async function listModelIds(config: AceStepConfig): Promise<string[] | null> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/models`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

async function generate(args: {
  config: AceStepConfig;
  directionText: string;
  seconds: number;
  instrumental: boolean;
  lyrics?: string;
  outPath: string;
  echo?: Echo;
}): Promise<{ lrcText?: string }> {
  const {
    config,
    directionText,
    seconds,
    instrumental,
    lyrics,
    outPath,
    echo,
  } = args;
  const payload = buildMusicPayload({
    directionText,
    seconds,
    instrumental,
    lyrics,
    model: config.model,
  });
  echo?.(
    describeMusicCurl({
      baseUrl: config.baseUrl,
      payload,
      hasKey: Boolean(config.apiKey),
    })
  );
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`ACE-Step request failed: ${reason}`);
  }
  if (!res.ok) {
    throw new Error(`ACE-Step returned HTTP ${res.status}`);
  }
  const body = await res.json();
  const bytes = audioFromResponse(body);
  if (!bytes) {
    throw new Error("ACE-Step response had no audio");
  }
  await writeFileAtomic(outPath, bytes, "ACE-Step returned 0 audio bytes");
  // The model's own per-line lyric timestamps, when the server exposes them (a
  // patched server that runs get_lyric_timestamp) — the ideal caption source.
  return { lrcText: lrcFromResponse(body) };
}

function createMusicProvider(
  config: AceStepConfig,
  echo?: Echo
): MusicProvider {
  return {
    id: "acestep-music",
    singsLyrics: true,
    credit: () =>
      Promise.resolve(
        `ACE-Step 1.5${config.model ? ` (${config.model})` : ""} — generated ${
          isLocalUrl(config.baseUrl) ? "locally" : "on a local-network server"
        }`
      ),
    bed: async (directionText, seconds, outPath) => {
      await generate({
        config,
        directionText,
        seconds,
        instrumental: true,
        outPath,
        echo,
      });
    },
    song: (directionText, seconds, outPath, lyrics) =>
      generate({
        config,
        directionText,
        seconds,
        instrumental: false,
        lyrics,
        outPath,
        echo,
      }),
  };
}

// Resolve an ACE-Step music provider when its server is reachable, else just
// notes. Auto-probes the local default; set $DAILIES_ACESTEP_URL to point
// elsewhere and $DAILIES_ACESTEP_API_KEY / $DAILIES_ACESTEP_MODEL as needed.
export async function resolveAceStepMusic(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
  echo?: Echo;
}): Promise<Pick<MediaProviders, "music" | "notes">> {
  const { env, log, echo } = opts;
  const config: AceStepConfig = {
    baseUrl: acestepBaseUrl(env),
    apiKey: env.DAILIES_ACESTEP_API_KEY?.trim() || undefined,
    model: env.DAILIES_ACESTEP_MODEL?.trim() || undefined,
  };
  const models = await listModelIds(config);
  if (!models) {
    // Server not running — silent (it's an optional, heavy local service).
    return { notes: [] };
  }
  // The server REQUIRES a `model` field, so resolve one: an explicit
  // $DAILIES_ACESTEP_MODEL wins, else the first model it has loaded.
  const model = config.model ?? models[0];
  if (!model) {
    return {
      notes: [
        `ACE-Step reachable at ${config.baseUrl} but has no model loaded; skipping music.`,
      ],
    };
  }
  const resolved: AceStepConfig = { ...config, model };
  log.debug({ url: config.baseUrl, model }, "ACE-Step music provider enabled");
  const where = isLocalUrl(config.baseUrl)
    ? "generated on this machine"
    : "generated on the configured server (lyrics/direction are sent there)";
  return {
    music: createMusicProvider(resolved, echo),
    notes: [
      `ACE-Step music enabled (${model} @ ${config.baseUrl}) — ${where}.`,
    ],
  };
}
