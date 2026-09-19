// Hosted media via ElevenLabs — narration (text-to-speech), music (Eleven Music)
// and, opt-in, a title-card image. An ADDITIVE provider layer mirroring
// providers.ts (Gemini) and omlx.ts: the same contract (write a finished,
// ffmpeg-decodable file to `outPath` or throw), wrapped in the caller's
// try/catch so any failure degrades to the next provider or the local fallback.
//
// API (https://elevenlabs.io/docs/api-reference), all keyed by an `xi-api-key`
// header:
//   - voices  GET  /v2/voices?voice_type=default → {voices:[{voice_id,name,…}]}
//             Probed once per run. It doubles as key validation — a 401 disables
//             the provider cleanly at resolve time instead of failing every
//             narration clip — and gives the session voice to pick from.
//   - TTS     POST /v1/text-to-speech/{voice_id}?output_format=…  {text, model_id}
//             → audio bytes. The text is spoken VERBATIM (no steering directive
//             is prepended, unlike Gemini TTS — it would be read aloud).
//   - music   POST /v1/music?output_format=…  {prompt, music_length_ms, model_id,
//             force_instrumental} → audio bytes. Supplied lyrics ride inside the
//             prompt, the documented way to make the model sing given words.
//   - image   POST /v1/flows/image {model_id, prompt, aspect_ratio} → {id, status};
//             GET /v1/flows/image/{id} polled until `completed` → `content_url`.
//             Asynchronous, and the Image & Video API needs a Pro plan, so it is
//             OPT-IN (--image elevenlabs / $DAILIES_IMAGE=elevenlabs) rather than
//             switched on by the key like narration and music are.
//
// Every response is an audio/image container (mp3/png); ffmpeg decodes by
// content, so the caller-chosen extension (`.wav`, `.png`) need not match.
//
// PRIVACY: narration text, lyrics and the creative direction are sent to
// ElevenLabs. The key is read from $ELEVENLABS_API_KEY only; it is never logged,
// echoed (the curl previews show the env-var reference), or written to disk.
// The signed `content_url` an image job returns lives on third-party storage
// and is fetched WITHOUT the key.
import type { Logger } from "dailies-logger";
import { writeFileAtomic } from "./media-files.js";
import {
  aspectRatioFor,
  buildImagePrompt,
  buildMusicPrompt,
  type MediaProviders,
  type MusicProvider,
  type TitleBackgroundProvider,
  type TtsProvider,
} from "./providers.js";
import { singleQuote } from "./shell.js";

const DEFAULT_URL = "https://api.elevenlabs.io";

// Current-generation defaults (https://elevenlabs.io/docs/overview/models).
// `eleven_multilingual_v2` is the documented API default and the safe choice for
// a voiceover: stable, 10k characters per request. `eleven_v3` is more
// expressive but less predictable; pin it with $DAILIES_ELEVENLABS_MODEL.
const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";
const DEFAULT_MUSIC_MODEL = "music_v2_5";
// The image flow relays third-party image models; this is the same family the
// direct Gemini provider uses, so a pinned ElevenLabs image looks consistent.
const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";

// The one output format every plan can request. Higher-bitrate mp3 and pcm/wav
// variants are tier-gated; a plain 128k mp3 is not, and ffmpeg decodes it.
const AUDIO_OUTPUT_FORMAT = "mp3_44100_128";

// ElevenLabs voices read at a natural voiceover pace already, so the hosted-TTS
// speed-up the Gemini path needs (see ttsTempo in speech.ts) is mostly
// unnecessary. A mild nudge keeps narration brisk without sounding hurried;
// $DAILIES_TTS_TEMPO still overrides it.
const TTS_TEMPO = 1.1;

// Eleven Music's accepted request range (3s–10min).
const MIN_MUSIC_MS = 3000;
const MAX_MUSIC_MS = 600_000;

const VOICES_TIMEOUT_MS = 6000;
const TTS_TIMEOUT_MS = 120_000;
// A full-length song takes a while to render.
const MUSIC_TIMEOUT_MS = 300_000;
// The image job is polled; the docs ask for no more than one poll per 2s.
const IMAGE_POLL_INTERVAL_MS = 2500;
const IMAGE_TIMEOUT_MS = 180_000;
const IMAGE_REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

// A user-facing line emitter (the cinematic pass routes it to stderr).
type Echo = (line: string) => void;

export interface ElevenLabsConfig {
  apiKey: string;
  baseUrl: string;
}

export interface ElevenLabsVoice {
  id: string;
  name: string;
}

// ElevenLabs' stock "default" library voices, used only when the live voice
// listing can't be fetched (a network blip) so a run still has a narrator. Ids
// are the long-lived ones every account ships with; the live list is preferred
// because it also reflects the account's own voices.
export const FALLBACK_VOICES: readonly ElevenLabsVoice[] = [
  { id: "9BWtsMINqrJLrRacOk9x", name: "Aria" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam" },
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda" },
  { id: "bIHbv24MWmeRgasZH58o", name: "Will" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily" },
  { id: "pqHfZKP75CvOlQylNhV4", name: "Bill" },
];

// Read the ElevenLabs API key ($ELEVENLABS_API_KEY — the name the official SDKs
// read too). Returns undefined when unset. The value is never logged.
export function readElevenLabsApiKey(
  env: NodeJS.ProcessEnv
): string | undefined {
  const key = env.ELEVENLABS_API_KEY?.trim();
  return key ? key : undefined;
}

// The API host. $DAILIES_ELEVENLABS_URL overrides it (a proxy, or a test
// server); trailing slashes are dropped so paths join cleanly.
export function elevenLabsBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.DAILIES_ELEVENLABS_URL?.trim() || DEFAULT_URL).replace(
    /\/+$/,
    ""
  );
}

export function elevenLabsTtsModel(env: NodeJS.ProcessEnv): string {
  return env.DAILIES_ELEVENLABS_MODEL?.trim() || DEFAULT_TTS_MODEL;
}

export function elevenLabsMusicModel(env: NodeJS.ProcessEnv): string {
  return env.DAILIES_ELEVENLABS_MUSIC_MODEL?.trim() || DEFAULT_MUSIC_MODEL;
}

export function elevenLabsImageModel(env: NodeJS.ProcessEnv): string {
  return env.DAILIES_ELEVENLABS_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
}

// Parse a GET /v2/voices body into {id, name} pairs, dropping malformed
// entries. Pure → unit-tested.
export function parseVoices(body: unknown): ElevenLabsVoice[] {
  const list = (body as { voices?: unknown })?.voices;
  if (!Array.isArray(list)) {
    return [];
  }
  const voices: ElevenLabsVoice[] = [];
  for (const entry of list) {
    const id = (entry as { voice_id?: unknown })?.voice_id;
    const name = (entry as { name?: unknown })?.name;
    if (typeof id === "string" && id.trim() && typeof name === "string") {
      voices.push({ id: id.trim(), name: name.trim() || id.trim() });
    }
  }
  return voices;
}

// A value that looks like a voice id rather than a voice name (ids are ~20
// alphanumerics; names are short words). Pure.
export function looksLikeVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{16,40}$/.test(value);
}

// Choose ONE voice for the whole session (the narrator must not change
// mid-video). $DAILIES_ELEVENLABS_VOICE wins — a voice id, or a name matched
// case-insensitively against the listed voices; an unknown id-shaped value is
// passed through so the API can reject it loudly. An unknown NAME falls back to
// a random pick and says so via `note`. Otherwise pick randomly from the list.
// Pure given its inputs → unit-tested.
export function pickElevenLabsVoice(
  voices: readonly ElevenLabsVoice[],
  env: NodeJS.ProcessEnv,
  random: () => number = Math.random
): { voice: ElevenLabsVoice | undefined; note?: string } {
  const override = env.DAILIES_ELEVENLABS_VOICE?.trim();
  if (override) {
    const wanted = override.toLowerCase();
    const match = voices.find(
      (v) => v.id === override || v.name.toLowerCase() === wanted
    );
    if (match) {
      return { voice: match };
    }
    if (looksLikeVoiceId(override)) {
      return { voice: { id: override, name: override } };
    }
    const fallback = voices[Math.floor(random() * voices.length)];
    return {
      voice: fallback,
      note: `DAILIES_ELEVENLABS_VOICE "${override}" is not one of your ElevenLabs voices; using ${fallback?.name ?? "none"}`,
    };
  }
  return { voice: voices[Math.floor(random() * voices.length)] };
}

// The /v1/text-to-speech request body. The narration line goes in verbatim —
// this model reads what it is given, so no delivery directive is prepended.
// Pure → unit-tested.
export function buildTtsBody(
  text: string,
  model: string
): Record<string, unknown> {
  return { text, model_id: model };
}

// The /v1/music request body. Lyrics (song mode) are embedded in the prompt the
// way the docs describe; an instrumental bed is forced instrumental so a
// themed prompt can't grow vocals under the narration. The length is clamped
// to the API's accepted range. Pure → unit-tested.
export function buildMusicBody(args: {
  directionText: string;
  seconds: number;
  instrumental: boolean;
  lyrics?: string;
  model: string;
}): Record<string, unknown> {
  const ms = Math.round(args.seconds * 1000);
  return {
    prompt: buildMusicPrompt(
      args.directionText,
      args.seconds,
      !args.instrumental,
      args.lyrics
    ),
    music_length_ms: Math.min(
      MAX_MUSIC_MS,
      Math.max(MIN_MUSIC_MS, Number.isFinite(ms) ? ms : MIN_MUSIC_MS)
    ),
    model_id: args.model,
    force_instrumental: args.instrumental,
  };
}

// The /v1/flows/image request body: the same no-lettering title-background
// prompt the Gemini provider uses, steered toward the video's aspect. Pure →
// unit-tested.
export function buildImageBody(args: {
  directionText: string;
  width: number;
  height: number;
  model: string;
}): Record<string, unknown> {
  return {
    model_id: args.model,
    prompt: buildImagePrompt(args.directionText),
    aspect_ratio: aspectRatioFor(args.width, args.height),
  };
}

export type ImageJobStatus =
  | { state: "done"; url: string; mimeType?: string }
  | { state: "failed"; reason: string }
  | { state: "pending" };

// Read a GET /v1/flows/image/{id} body: terminal `completed` (with its signed
// content_url), terminal `failed` (with the API's reason), or still running.
// Anything unrecognized counts as running so the poll keeps going until its
// own deadline. Pure → unit-tested.
export function readImageJob(body: unknown): ImageJobStatus {
  const job = (body ?? {}) as {
    status?: unknown;
    content_url?: unknown;
    content_mime_type?: unknown;
    failure_reason?: unknown;
    error_message?: unknown;
  };
  const status = typeof job.status === "string" ? job.status : "";
  if (status === "completed") {
    if (typeof job.content_url === "string" && job.content_url) {
      return {
        state: "done",
        url: job.content_url,
        mimeType:
          typeof job.content_mime_type === "string"
            ? job.content_mime_type
            : undefined,
      };
    }
    return { state: "failed", reason: "completed without a content_url" };
  }
  if (status === "failed") {
    const reason = [job.failure_reason, job.error_message]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join(": ");
    return { state: "failed", reason: reason || "failed" };
  }
  return { state: "pending" };
}

// Redacted, copy-pasteable curl previews. The key is shown as the env-var
// reference $ELEVENLABS_API_KEY (never the value) so each line runs verbatim
// once that var is exported. Pure → unit-tested.
export function describeCurl(args: {
  baseUrl: string;
  path: string;
  body?: Record<string, unknown>;
  outPath?: string;
}): string {
  const parts = [
    args.body ? "curl -s -X POST" : "curl -s",
    `${args.baseUrl}${args.path}`,
    '-H "xi-api-key: $ELEVENLABS_API_KEY"',
  ];
  if (args.body) {
    parts.push(
      "-H 'content-type: application/json'",
      `-d ${singleQuote(JSON.stringify(args.body))}`
    );
  }
  if (args.outPath) {
    parts.push(`-o ${singleQuote(args.outPath)}`);
  }
  return parts.join(" ");
}

function headers(
  config: ElevenLabsConfig,
  json = false
): Record<string, string> {
  return {
    "xi-api-key": config.apiKey,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

// POST a JSON body and return the raw response. Throws a clean Error (carrying
// NEITHER the key NOR the request text) on a transport failure or a non-2xx —
// status only, since an error body can echo the prompt. `what` names the call
// in the message ("TTS eleven_multilingual_v2").
async function post(args: {
  config: ElevenLabsConfig;
  path: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  what: string;
}): Promise<Response> {
  const { config, path, body, timeoutMs, what } = args;
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: headers(config, true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`ElevenLabs ${what} request failed: ${reason}`);
  }
  if (!res.ok) {
    throw new Error(`ElevenLabs ${what} returned HTTP ${res.status}`);
  }
  return res;
}

// Read a media response's bytes, rejecting a JSON body (an error envelope
// under a 2xx) so it never gets written as "audio".
async function mediaBytes(res: Response, what: string): Promise<Buffer> {
  if (res.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`ElevenLabs ${what} returned JSON, not media`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Probe the account's voices. Distinguishes a REJECTED key (4xx: the provider
// must be disabled, and the user told) from an UNREACHABLE API (network: fall
// back to the built-in voices and let the run try).
async function listVoices(
  config: ElevenLabsConfig
): Promise<
  { voices: ElevenLabsVoice[] } | { rejected: number } | { unreachable: string }
> {
  try {
    const res = await fetch(
      `${config.baseUrl}/v2/voices?voice_type=default&page_size=100`,
      {
        headers: headers(config),
        signal: AbortSignal.timeout(VOICES_TIMEOUT_MS),
      }
    );
    if (res.status === 401 || res.status === 403) {
      return { rejected: res.status };
    }
    if (!res.ok) {
      return { unreachable: `HTTP ${res.status}` };
    }
    return { voices: parseVoices(await res.json()) };
  } catch (err) {
    return { unreachable: err instanceof Error ? err.message : String(err) };
  }
}

function createTtsProvider(args: {
  config: ElevenLabsConfig;
  model: string;
  voice: ElevenLabsVoice;
  echo?: Echo;
}): TtsProvider {
  const { config, model, voice, echo } = args;
  const path = `/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=${AUDIO_OUTPUT_FORMAT}`;
  return {
    id: "elevenlabs-tts",
    // e.g. "elevenlabs:Sarah" — surfaced in meta/credits so a good run can be
    // reproduced via $DAILIES_ELEVENLABS_VOICE.
    label: `elevenlabs:${voice.name}`,
    tempo: TTS_TEMPO,
    async synthesize(text: string, outPath: string): Promise<void> {
      const body = buildTtsBody(text, model);
      echo?.(describeCurl({ baseUrl: config.baseUrl, path, body, outPath }));
      const res = await post({
        config,
        path,
        body,
        timeoutMs: TTS_TIMEOUT_MS,
        what: `TTS ${model}`,
      });
      await writeFileAtomic(
        outPath,
        await mediaBytes(res, "TTS"),
        "ElevenLabs returned 0 audio bytes"
      );
    },
  };
}

function createMusicProvider(args: {
  config: ElevenLabsConfig;
  model: string;
  echo?: Echo;
}): MusicProvider {
  const { config, model, echo } = args;
  const path = `/v1/music?output_format=${AUDIO_OUTPUT_FORMAT}`;
  const generate = async (
    body: Record<string, unknown>,
    outPath: string
  ): Promise<void> => {
    echo?.(describeCurl({ baseUrl: config.baseUrl, path, body, outPath }));
    const res = await post({
      config,
      path,
      body,
      timeoutMs: MUSIC_TIMEOUT_MS,
      what: `music ${model}`,
    });
    await writeFileAtomic(
      outPath,
      await mediaBytes(res, "music"),
      "ElevenLabs returned 0 audio bytes"
    );
  };
  return {
    id: "elevenlabs-music",
    singsLyrics: true,
    credit(): Promise<string | undefined> {
      return Promise.resolve(`Eleven Music (ElevenLabs ${model})`);
    },
    bed(directionText, seconds, outPath) {
      return generate(
        buildMusicBody({ directionText, seconds, instrumental: true, model }),
        outPath
      );
    },
    song(directionText, seconds, outPath, lyrics) {
      // No lyric timestamps are wired up (the detailed endpoint's timing shape
      // is undocumented), so song captions fall back to transcribe-and-align —
      // exactly as Lyria does.
      return generate(
        buildMusicBody({
          directionText,
          seconds,
          instrumental: false,
          lyrics,
          model,
        }),
        outPath
      );
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll an image job until it completes or fails, or the deadline passes.
async function awaitImageJob(
  config: ElevenLabsConfig,
  id: string
): Promise<{ url: string }> {
  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  const path = `/v1/flows/image/${encodeURIComponent(id)}`;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        headers: headers(config),
        signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`ElevenLabs image poll failed: ${reason}`);
    }
    if (!res.ok) {
      throw new Error(`ElevenLabs image poll returned HTTP ${res.status}`);
    }
    const job = readImageJob(await res.json());
    if (job.state === "done") {
      return { url: job.url };
    }
    if (job.state === "failed") {
      throw new Error(`ElevenLabs image generation failed: ${job.reason}`);
    }
    if (Date.now() >= deadline) {
      throw new Error("ElevenLabs image generation timed out");
    }
    await sleep(IMAGE_POLL_INTERVAL_MS);
  }
}

function createTitleBackgroundProvider(args: {
  config: ElevenLabsConfig;
  model: string;
  echo?: Echo;
}): TitleBackgroundProvider {
  const { config, model, echo } = args;
  return {
    id: "elevenlabs-image",
    credit() {
      return `Title art — ${model} (via ElevenLabs)`;
    },
    async render(directionText, width, height, outPath) {
      const body = buildImageBody({ directionText, width, height, model });
      echo?.(
        describeCurl({ baseUrl: config.baseUrl, path: "/v1/flows/image", body })
      );
      const res = await post({
        config,
        path: "/v1/flows/image",
        body,
        timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
        what: `image ${model}`,
      });
      const created = (await res.json()) as { id?: unknown };
      if (typeof created.id !== "string" || !created.id) {
        throw new Error("ElevenLabs image request returned no job id");
      }
      const { url } = await awaitImageJob(config, created.id);
      // A signed URL on third-party storage: fetched WITHOUT the API key.
      echo?.(`$ curl -sL ${singleQuote(url)} -o ${singleQuote(outPath)}`);
      let download: Response;
      try {
        download = await fetch(url, {
          signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`ElevenLabs image download failed: ${reason}`);
      }
      if (!download.ok) {
        throw new Error(
          `ElevenLabs image download returned HTTP ${download.status}`
        );
      }
      await writeFileAtomic(
        outPath,
        Buffer.from(await download.arrayBuffer()),
        "ElevenLabs returned 0 image bytes"
      );
    },
  };
}

// Resolve ElevenLabs-backed providers, or just notes when no key is set / the
// key is rejected. Narration + music come with the key; the title image only
// when `image` is set (the caller passes the user's explicit choice). Async
// because it probes the voice list once.
export async function resolveElevenLabsProviders(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
  echo?: Echo;
  image?: boolean;
}): Promise<MediaProviders> {
  const { env, log, echo, image = false } = opts;
  const apiKey = readElevenLabsApiKey(env);
  if (!apiKey) {
    // Not configured — stay silent so machines without a key see no noise.
    return { notes: [] };
  }
  const config: ElevenLabsConfig = { apiKey, baseUrl: elevenLabsBaseUrl(env) };
  const probe = await listVoices(config);
  if ("rejected" in probe) {
    log.warn(
      { status: probe.rejected },
      "ELEVENLABS_API_KEY was rejected; ElevenLabs providers disabled"
    );
    return {
      notes: [
        `ELEVENLABS_API_KEY set but rejected by ElevenLabs (HTTP ${probe.rejected}) — ElevenLabs narration/music disabled; check the key`,
      ],
    };
  }
  const notes: string[] = [];
  let voices: readonly ElevenLabsVoice[];
  if ("voices" in probe && probe.voices.length > 0) {
    voices = probe.voices;
  } else {
    // Unreachable, or an account with no default voices listed: fall back to the
    // stock library so the run still has a narrator (a later TTS failure then
    // degrades to the next voice the same way any provider failure does).
    log.debug(
      { reason: "unreachable" in probe ? probe.unreachable : "empty list" },
      "ElevenLabs voice list unavailable; using the built-in default voices"
    );
    voices = FALLBACK_VOICES;
  }
  const picked = pickElevenLabsVoice(voices, env);
  if (picked.note) {
    notes.push(picked.note);
  }
  const ttsModel = elevenLabsTtsModel(env);
  const musicModel = elevenLabsMusicModel(env);
  const imageModel = elevenLabsImageModel(env);
  log.debug(
    { ttsModel, musicModel, voice: picked.voice?.name, image },
    "ElevenLabs providers enabled"
  );
  notes.push(
    `ElevenLabs enabled (${ttsModel}, voice ${picked.voice?.name ?? "none"}; music ${musicModel}${image ? `; title image ${imageModel}` : ""}) — narration text, lyrics and the theme are sent to ElevenLabs.`
  );
  return {
    tts: picked.voice
      ? createTtsProvider({
          config,
          model: ttsModel,
          voice: picked.voice,
          echo,
        })
      : undefined,
    music: createMusicProvider({ config, model: musicModel, echo }),
    titleBackground: image
      ? createTitleBackgroundProvider({ config, model: imageModel, echo })
      : undefined,
    notes,
  };
}
