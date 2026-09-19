// Optional Gemini-backed media providers for the cinematic pipeline. This is an
// ADDITIVE layer: narrate.ts already has fully-local fallbacks (macOS `say` for
// voiceover, ffmpeg `drawtext` for the title card, no music). When a Gemini key
// is present these providers upgrade those three slots with generated media; the
// caller wraps each call in try/catch and falls back to the local path on any
// throw, so a missing/renamed model or a network blip degrades silently to the
// pre-existing behavior rather than failing the run.
//
// CONTRACT: every method writes a finished file to `outPath` (an
// ffmpeg-decodable audio/image file — that's the entire integration surface)
// and THROWS a clean Error on any failure. The caller (narrate.ts) dictates the
// output path AND its extension (e.g. `${videoPath}.bed.wav`); we always write
// the returned container bytes to that exact path. ffmpeg decodes by content, so
// the on-disk extension and the actual codec need not match. To honor "never
// leave a half-written file the caller might use", each method writes to a
// sibling temp path and only `rename`s it into place once the bytes are valid.
//
// API SURFACE: two credentials are supported, and they speak DIFFERENT surfaces.
//   - AI Studio (GEMINI_API_KEY): Google's unified "Interactions API"
//     (POST .../v1beta/interactions), one request/response shape for image
//     (Nano Banana), TTS, and Lyria music, keyed by an x-goog-api-key header.
//   - Vertex AI (GOOGLE_APPLICATION_CREDENTIALS): a service account, Bearer
//     token. Vertex does NOT serve the Interactions API for these models;
//     instead TTS + image use each model's native `:generateContent`, and Lyria
//     music uses the `.../interactions` host at the `global` location. Verified
//     against a live project 2026-09-17. See the Vertex section further down.
// Endpoints, model ids, and the auth headers live in the constants/factories
// below so a maintainer can adjust them in one place. Docs:
//   - https://ai.google.dev/gemini-api/docs/interactions-overview (AI Studio)
//   - https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/image-generation (Vertex image)
//   - https://docs.cloud.google.com/text-to-speech/docs/gemini-tts (Vertex TTS)
//   - https://ai.google.dev/gemini-api/docs/migrate-to-cloud (AI Studio vs Vertex)
//
// PRIVACY: the directionText and per-step narration text are session-derived and
// are sent to Google's API. The API key / service-account key are read from
// `env` only; neither the key nor a minted token is ever logged, embedded in an
// error message, or written to disk.
import type { Logger } from "dailies-logger";
import {
  createTokenSource,
  loadServiceAccount,
  type TokenSource,
} from "./gcp-auth.js";
import { writeFileAtomic } from "./media-files.js";

// ---------------------------------------------------------------------------
// Public interfaces (the only contract: each method writes `outPath` or throws).
// ---------------------------------------------------------------------------

export interface TtsProvider {
  id: string; // stable id, e.g. "gemini-tts"
  label: string; // for reproducibility, e.g. "gemini:Charon"
  // Write spoken audio for `text` to `outPath` (any ffmpeg-decodable file).
  // Throws on failure.
  synthesize(text: string, outPath: string): Promise<void>;
  // Optional: the playback speed-up the clip renderer should apply to this
  // provider's audio (pitch-preserving atempo). Hosted TTS models read at
  // different paces — Gemini needs a nudge toward voiceover pace, ElevenLabs
  // barely any — and none expose a rate parameter, so each names its own.
  // Unset means the shared hosted-TTS default; $DAILIES_TTS_TEMPO overrides
  // either (see ttsTempo in speech.ts).
  tempo?: number;
}

export interface TitleBackgroundProvider {
  // Optional: a specific credit line for the image actually used, read AFTER
  // render(). A stock source must name the creator — "Wikimedia Commons" is the
  // platform, not the author, and CC-BY/BY-SA require the author. Mirrors
  // MusicProvider.credit(); when absent the caller falls back to a generic
  // "made with" line naming the tool.
  credit?(): string | undefined;
  id: string;
  // Write a themed background IMAGE (png/jpg) at width×height to `outPath`.
  // Throws on failure.
  render(
    directionText: string,
    width: number,
    height: number,
    outPath: string
  ): Promise<void>;
}

// What a music provider's `song()` may hand back besides the audio file: the
// model's own lyric timestamps, when it can produce them (see MusicProvider.song).
export interface SongResult {
  // Standard LRC ("[mm:ss.xx]line" per line) timing the SUPPLIED lyrics to the
  // generated vocals. Present only when the provider/server exposes it.
  lrcText?: string;
}

export interface MusicProvider {
  // Write a themed instrumental bed of ~`seconds` to `outPath`. Throws on failure.
  bed(directionText: string, seconds: number, outPath: string): Promise<void>;
  // Optional: a human credit line for the score (e.g. an archive.org track's
  // title/artist/license, or a model name), resolved WITHOUT producing audio so
  // it can go in the credits roll before generation. Implementations that select
  // a specific asset should cache it so bed/song reuse the credited one.
  credit?(directionText: string): Promise<string | undefined>;
  id: string;
  // True when `song(..., lyrics)` actually sings the supplied lyrics (a generative
  // model like ACE-Step or Lyria). Stock-track providers leave it unset, so song
  // mode can pick a lyrics-capable provider rather than relying on chain order.
  singsLyrics?: boolean;
  // Write a themed full song (may have vocals) of ~`seconds` to `outPath`. When
  // `lyrics` is given the provider must SING those exact words (song mode);
  // without it the provider writes its own themed vocals/instrumental. Throws on
  // failure. A provider that can't sing supplied lyrics (e.g. stock music) leaves
  // `singsLyrics` unset and simply ignores `lyrics`.
  //
  // May return a SongResult carrying the model's OWN per-line lyric timestamps
  // (`lrcText`, standard `[mm:ss.xx]` LRC) when it can produce them — the ideal
  // caption source (the model's alignment of the exact lyrics it sang, no
  // transcription). Providers that can't return void; the caller then falls back
  // to transcribe-and-align.
  song(
    directionText: string,
    seconds: number,
    outPath: string,
    lyrics?: string
    // biome-ignore lint/suspicious/noConfusingVoidType: `void` (not `undefined`) is deliberate — it lets a provider with no lyric timestamps implement this as a plain async function with no return statement; `undefined` would force every such provider to `return undefined`, which noUselessUndefined then flags.
  ): Promise<SongResult | void>;
}

export interface MediaProviders {
  music?: MusicProvider;
  notes: string[]; // provider-selection notes surfaced to the user
  titleBackground?: TitleBackgroundProvider;
  tts?: TtsProvider;
}

// ---------------------------------------------------------------------------
// Configuration constants. Endpoints + model ids live here so a maintainer can
// adjust them in one place (see the API SURFACE note above).
// ---------------------------------------------------------------------------

// AI Studio's Interactions API: one endpoint for every modality, the `model`
// field in the body selecting the capability, keyed by an x-goog-api-key header.
// (Vertex does NOT serve this — it uses per-model native surfaces built from the
// constants below; see the Vertex section.)
const AI_STUDIO_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

// Default Vertex location. The Interactions surface is served ONLY from the
// `global` location (measured: us/eu multi-region hosts 404, us-central1 reports
// "Unsupported location"), and `global` uses the un-prefixed host. Overridable
// via GOOGLE_CLOUD_LOCATION (the ADC-standard var) for a future regional rollout.
const DEFAULT_VERTEX_LOCATION = "global";

// Vertex host for a location: `global` has no region prefix, regions do.
function vertexHost(location: string): string {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

// Image generation ("Nano Banana 2"). Confirmed on the image-generation docs.
// Fall-back / higher-quality alternative: "gemini-3-pro-image".
const IMAGE_MODEL = "gemini-3.1-flash-image";

// Text-to-speech. Confirmed on the speech-generation docs (preview).
const TTS_MODEL = "gemini-3.1-flash-tts-preview";

// Music ("Lyria 3"). The clip model is fixed at ~30s and suits the instrumental
// bed; the pro model produces full-length songs with verse/chorus structure.
const MUSIC_CLIP_MODEL = "lyria-3-clip-preview"; // bed (≤30s, instrumental)
const MUSIC_PRO_MODEL = "lyria-3-pro-preview"; // song (full-length)

// Gemini TTS returns raw PCM (16-bit signed little-endian, 24 kHz, mono) inside
// an audio block. When the returned mime indicates raw PCM we wrap it in a WAV
// header before writing; a real container (mp3/wav, as Lyria returns) is written
// through unchanged. These describe the PCM the TTS model emits.
const TTS_SAMPLE_RATE = 24_000;
const TTS_CHANNELS = 1;
const TTS_BITS_PER_SAMPLE = 16;

// Single-speaker voices the Gemini TTS model accepts. One is picked per session
// (consistency) and surfaced in the provider's `label` for reproducibility.
const TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Enceladus",
  "Algieba",
] as const;

// Generation can be slow; image/music especially. Generous per-call budgets.
const TTS_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 180_000;
const MUSIC_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no network, no fs).
// ---------------------------------------------------------------------------

// Wrap raw little-endian PCM samples in a canonical 44-byte WAV (RIFF) header so
// ffmpeg can decode them. `sampleRate`/`channels` describe the PCM; bit depth is
// fixed at 16 (what Gemini TTS returns). Pure: returns a new Buffer.
export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number
): Buffer {
  const bitsPerSample = TTS_BITS_PER_SAMPLE;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4); // RIFF chunk size = 36 + data
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// The media type we want back from an interaction: "image" or "audio". This is
// matched against `steps[].content[].type` and used to pick the convenience
// `output_image` / `output_audio` field.
type InteractionMediaType = "image" | "audio";

interface InteractionContent {
  data?: unknown;
  mime_type?: unknown;
  type?: unknown;
}

// Decode one base64 content block into bytes + mime. Returns null unless `type`
// matches `wantType` and `data` is a non-empty base64 string. Pure.
function readContentBlock(
  block: InteractionContent | undefined,
  wantType: InteractionMediaType
): { bytes: Buffer; mimeType: string } | null {
  if (!block || block.type !== wantType) {
    return null;
  }
  if (typeof block.data !== "string" || block.data.length === 0) {
    return null;
  }
  const mimeType = typeof block.mime_type === "string" ? block.mime_type : "";
  return { bytes: Buffer.from(block.data, "base64"), mimeType };
}

// Defensively extract the first media block of `wantType` from an Interactions
// API response. Reads both shapes the docs describe:
//   - the convenience field `interaction.output_image` / `output_audio`
//     ({ data, mime_type }), checked first; and
//   - the full `steps[].content[]` array, where each content block has
//     { type: "image"|"audio", data: <base64>, mime_type }.
// Returns null when no usable block is present, so callers can throw a clean
// "no media in response" error. Pure.
export function extractInteractionMedia(
  body: unknown,
  wantType: InteractionMediaType
): { bytes: Buffer; mimeType: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  // Defensive: the docs describe a top-level object, but the SDK phrasing
  // (`interaction.output_image.data`) hints the raw HTTP body may wrap
  // everything under an `interaction` key on some surfaces. Unwrap it if
  // present so we read `steps`/`output_*` from the right level either way.
  const wrapped = (body as { interaction?: unknown }).interaction;
  const root = (wrapped && typeof wrapped === "object" ? wrapped : body) as {
    output_image?: InteractionContent;
    output_audio?: InteractionContent;
    steps?: unknown;
  };

  // 1) Convenience field. The SDK surfaces the last image/audio block here.
  const convenience =
    wantType === "image" ? root.output_image : root.output_audio;
  const fromConvenience = readContentBlock(
    // The convenience block omits `type`; treat it as already the wanted type.
    convenience ? { ...convenience, type: wantType } : undefined,
    wantType
  );
  if (fromConvenience) {
    return fromConvenience;
  }

  // 2) Full steps[].content[] walk.
  const steps = root.steps;
  if (!Array.isArray(steps)) {
    return null;
  }
  for (const step of steps) {
    const content = (step as { content?: unknown })?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content as InteractionContent[]) {
      const found = readContentBlock(block, wantType);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

// Choose ONE voice for the whole session (mirrors narrate.ts picking one `say`
// voice per session for consistency — the narrator's voice must not change
// mid-video). An explicit $DAILIES_TTS_VOICE wins (the user asked for it; let the
// API error loudly if it's wrong); otherwise pick randomly from the supported
// voices. The chosen voice is surfaced in the provider's `label` for
// reproducibility. Pure given its inputs → unit-tested.
export function pickTtsVoice(
  env: NodeJS.ProcessEnv,
  random: () => number = Math.random
): string {
  const override = env.DAILIES_TTS_VOICE?.trim();
  if (override) {
    return override;
  }
  const index = Math.floor(random() * TTS_VOICES.length);
  return TTS_VOICES[index] ?? "Charon";
}

// Build the TTS prompt. Gemini TTS takes plain text whose leading instruction
// steers delivery ("Say cheerfully: …"), so we prepend an expressive cinematic
// directive before the verbatim narration line. The TtsProvider only receives the
// per-step narration (not the session direction), so the directive is theme-
// agnostic; the chosen voice carries the thematic flavor.
//
// It asks for a BRISK pace deliberately. The earlier wording ("with dramatic
// pacing and emotion") read as an invitation to slow down and draw every line
// out, and a line that overruns its step is narration playing over the wrong
// footage. The model only partly honours this, so the rendered audio is also
// sped up afterwards — see ttsTempo in speech.ts. Pure → unit-tested.
export function buildTtsPrompt(text: string): string {
  return `Read this aloud as an expressive cinematic voiceover: brisk and energetic, moving at a confident clip, with emotion but without drawing words out or pausing between phrases:\n\n${text}`;
}

// Build the image prompt for a TITLE-CARD BACKGROUND. The title text is overlaid
// later by ffmpeg, so we explicitly demand NO lettering and negative space / a
// darkened lower third for legible overlay. Pure → unit-tested.
export function buildImagePrompt(directionText: string): string {
  return [
    `A cinematic title-card background image for a short film with this creative direction: ${directionText}.`,
    "Atmospheric, evocative, film-poster quality, dramatic lighting and depth.",
    "This is a BACKGROUND only: leave generous empty negative space and a darkened, low-contrast lower third where title text will be overlaid afterward.",
    "Absolutely NO text, NO words, NO letters, NO numbers, NO captions, NO logos, NO watermarks anywhere in the image.",
  ].join(" ");
}

// Build the music prompt. `wantVocals` distinguishes an instrumental bed from a
// full song; genre/mood are mapped from the direction by the model. A full song
// may use [Verse]/[Chorus] structure markers (Lyria pro understands them). Pure
// → unit-tested.
export function buildMusicPrompt(
  directionText: string,
  seconds: number,
  wantVocals: boolean,
  lyrics?: string
): string {
  const kind = wantVocals
    ? "a complete song with vocals (use [Verse] and [Chorus] structure as it fits)"
    : "an instrumental score with NO vocals";
  const lyricLine =
    wantVocals && lyrics?.trim()
      ? [`Sing these exact lyrics:\n${lyrics.trim()}`]
      : [];
  return [
    `Compose ${kind} as the soundtrack for a short cinematic piece with this creative direction: ${directionText}.`,
    `Target roughly ${Math.round(seconds)} seconds.`,
    "Match the genre, mood, tempo, and instrumentation to that theme; make it evocative and film-quality.",
    ...lyricLine,
  ].join(" ");
}

// Map pixel geometry to one of the aspect-ratio strings the image model accepts.
// Pure → unit-tested.
export function aspectRatioFor(width: number, height: number): string {
  if (!(width > 0 && height > 0)) {
    return "16:9";
  }
  const ratio = width / height;
  const options: { label: string; value: number }[] = [
    { label: "21:9", value: 21 / 9 },
    { label: "16:9", value: 16 / 9 },
    { label: "4:3", value: 4 / 3 },
    { label: "1:1", value: 1 },
    { label: "3:4", value: 3 / 4 },
    { label: "9:16", value: 9 / 16 },
  ];
  let best = options[0] ?? { label: "16:9", value: 16 / 9 };
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const delta = Math.abs(option.value - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = option;
    }
  }
  return best.label;
}

// The shape of a `response_format` request object. `type` is required; the image
// fields are optional and ignored for audio.
interface ResponseFormat {
  aspect_ratio?: string;
  image_size?: string;
  mime_type?: string;
  type: InteractionMediaType;
}

// Build the Interactions API request body. Pure (no network, no fs) so the body
// shape is unit-tested directly. `input` is sent as a plain string (the docs
// accept a string or an array of `{type,text}`/`{type:"image",...}` parts; a
// string is the simplest form for our text-only prompts). Output modality is
// requested via `response_format` per the concrete per-feature doc examples.
//
// NOTE: the API reference also documents a `response_modalities: ["image"|...]`
// array as an alternative to `response_format`. Every per-feature example uses
// `response_format`, so we send that; flip here if a live call rejects it.
export function buildInteractionBody(args: {
  model: string;
  input: string;
  responseFormat: ResponseFormat;
  // TTS only: generation_config.speech_config voices.
  speechVoice?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    input: args.input,
    response_format: args.responseFormat,
  };
  if (args.speechVoice) {
    // speech_config is an ARRAY of speaker configs; single-speaker = one entry.
    body.generation_config = {
      speech_config: [{ voice: args.speechVoice }],
    };
  }
  return body;
}

// Read the Gemini API key from the env. Accepts either documented var name.
// Returns undefined when neither is set. The key value itself is never logged.
export function readApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.GEMINI_API_KEY ?? env.GOOGLE_GENAI_API_KEY;
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

// AI Studio (Gemini Developer API) transport: the API key rides in a constant
// header and every modality is served through the ONE Interactions URL. Vertex
// does not use this — it speaks per-model native surfaces (see the Vertex section
// below), so the two surfaces don't share a transport shape.
export interface GeminiTransport {
  // Auth header for every call (API-key form; constant). Never logged.
  readonly headers: Record<string, string>;
  // Non-secret label for notes/debug, e.g. "AI Studio (API key)".
  readonly label: string;
  // Absolute URL to POST an interaction to.
  readonly url: string;
}

function createStudioTransport(apiKey: string): GeminiTransport {
  return {
    url: AI_STUDIO_INTERACTIONS_URL,
    headers: { "x-goog-api-key": apiKey },
    label: "AI Studio (API key)",
  };
}

// ---------------------------------------------------------------------------
// Vertex AI (service account) surface.
//
// Vertex does NOT serve these media models through the unified Interactions API
// the AI Studio path uses. Measured against a live project (2026-09-17), all
// three modalities work via NATIVE surfaces instead:
//   - TTS   → `<model>:generateContent`, PCM (audio/l16 24kHz) in
//             candidates[].content.parts[].inlineData.
//   - image → `<model>:generateContent`, PNG in the same inlineData shape;
//             gemini-3.1-flash-image is served ONLY in the `global` location.
//   - music → the `.../interactions` host at `global`, Lyria 3 returning mp3 in a
//             top-level `outputs[]` array (the `:predict` path only has Lyria 2).
// So the Vertex providers below build those native shapes; they do not reuse the
// interactions transport/body/parser the AI Studio providers use.
// ---------------------------------------------------------------------------

interface VertexContext {
  location: string;
  project: string;
  token: TokenSource;
}

// Build a Vertex context from a service-account key path. Throws on a bad path
// (the resolver catches it and falls back). Token minting is lazy and cached.
function createVertexContext(
  credPath: string,
  env: NodeJS.ProcessEnv
): VertexContext {
  const sa = loadServiceAccount(credPath);
  return {
    token: createTokenSource(sa),
    project: env.GOOGLE_CLOUD_PROJECT?.trim() || sa.project_id,
    location: env.GOOGLE_CLOUD_LOCATION?.trim() || DEFAULT_VERTEX_LOCATION,
  };
}

// A model's native method URL, e.g. `<model>:generateContent`. Exported so tests
// can pin host/path construction — the `global` → bare-host vs region → prefixed-
// host distinction is easy to break and only fails at runtime against live Vertex.
export function vertexModelUrl(
  ctx: { project: string; location: string },
  model: string,
  method: string
): string {
  return (
    `https://${vertexHost(ctx.location)}/v1beta1` +
    `/projects/${ctx.project}/locations/${ctx.location}` +
    `/publishers/google/models/${model}:${method}`
  );
}

// The interactions host (Lyria music only, `global`). Exported for URL-shape tests.
export function vertexInteractionsUrl(ctx: {
  project: string;
  location: string;
}): string {
  return (
    `https://${vertexHost(ctx.location)}/v1beta1` +
    `/projects/${ctx.project}/locations/${ctx.location}/interactions`
  );
}

// POST JSON to a Vertex URL with a freshly-minted Bearer token. Clean errors
// (carrying NEITHER the token NOR the request text). Mirrors postInteraction for
// the Vertex surface.
async function postVertex(args: {
  model: string;
  url: string;
  ctx: VertexContext;
  body: unknown;
  timeoutMs: number;
}): Promise<unknown> {
  const { model, url, ctx, body, timeoutMs } = args;
  let response: Response;
  try {
    const token = await ctx.token();
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Vertex ${model} request failed: ${reason}`);
  }
  if (!response.ok) {
    // Status only — the body can echo request text.
    throw new Error(`Vertex ${model} returned HTTP ${response.status}`);
  }
  return response.json();
}

// Vertex `:generateContent` request body for TTS. The text part is spoken; the
// voice is a prebuilt voice name (all of TTS_VOICES are valid on Vertex). Pure →
// unit-tested.
export function buildVertexTtsBody(
  text: string,
  voice: string
): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };
}

// Vertex `:generateContent` request body for image. `aspectRatio` steers the
// output shape (best-effort). Pure → unit-tested.
export function buildVertexImageBody(
  prompt: string,
  aspectRatio: string
): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio },
    },
  };
}

// Extract the first inline media block of `wantType` from a Vertex
// `:generateContent` response (candidates[].content.parts[].inlineData, camel or
// snake case), matched by mime prefix ("audio/"/"image/"). Returns null when
// absent or empty. Pure → unit-tested.
export function extractGenerateContentMedia(
  body: unknown,
  wantType: InteractionMediaType
): { bytes: Buffer; mimeType: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return null;
  }
  for (const cand of candidates) {
    const parts = (cand as { content?: { parts?: unknown } })?.content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const inline =
        (part as { inlineData?: unknown; inline_data?: unknown })?.inlineData ??
        (part as { inline_data?: unknown })?.inline_data;
      const data = (inline as { data?: unknown })?.data;
      const mimeType =
        (inline as { mimeType?: unknown; mime_type?: unknown })?.mimeType ??
        (inline as { mime_type?: unknown })?.mime_type;
      if (
        typeof data === "string" &&
        data.length > 0 &&
        typeof mimeType === "string" &&
        mimeType.toLowerCase().startsWith(`${wantType}/`)
      ) {
        return { bytes: Buffer.from(data, "base64"), mimeType };
      }
    }
  }
  return null;
}

// Extract the first audio block from a Vertex interactions (Lyria) response,
// whose media lives in a top-level `outputs[]` array of {type,data,mime_type}.
// Returns null when absent or empty. Pure → unit-tested.
export function extractVertexOutputsAudio(
  body: unknown
): { bytes: Buffer; mimeType: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const outputs = (body as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) {
    return null;
  }
  for (const out of outputs) {
    const type = (out as { type?: unknown })?.type;
    const data = (out as { data?: unknown })?.data;
    if (type === "audio" && typeof data === "string" && data.length > 0) {
      const mimeType = (out as { mime_type?: unknown })?.mime_type;
      return {
        bytes: Buffer.from(data, "base64"),
        mimeType: typeof mimeType === "string" ? mimeType : "",
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP + file helpers (network; not unit-tested — covered by manual/live runs).
// ---------------------------------------------------------------------------

// POST an interaction request and return the parsed JSON body. Throws a clean
// Error (carrying NEITHER the key NOR the request text) on a non-2xx or transport
// failure. Uses the global fetch with an AbortSignal timeout.
async function postInteraction(args: {
  model: string;
  transport: GeminiTransport;
  body: unknown;
  timeoutMs: number;
}): Promise<unknown> {
  const { model, transport, body, timeoutMs } = args;
  let response: Response;
  try {
    // The API key travels in the header form, never in the URL or logs.
    response = await fetch(transport.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...transport.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network/timeout. Surface a short reason without the request payload.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini ${model} request failed: ${reason}`);
  }
  if (!response.ok) {
    // Status only — the body can echo request text, so we don't include it.
    throw new Error(`Gemini ${model} returned HTTP ${response.status}`);
  }
  return response.json();
}

// Decode an interaction response to media bytes (+ mime) or throw. Centralizes
// the "empty/missing media" error so every provider fails the same clean way.
function mediaOrThrow(
  model: string,
  body: unknown,
  wantType: InteractionMediaType
): { bytes: Buffer; mimeType: string } {
  const found = extractInteractionMedia(body, wantType);
  if (!found || found.bytes.length === 0) {
    throw new Error(`Gemini ${model} returned no media bytes`);
  }
  return found;
}

// Audio can come back as raw PCM (Gemini TTS: `audio/l16` / `audio/pcm`) or as a
// real container (Lyria: `audio/mpeg` mp3, or `audio/wav`). ffmpeg decodes by
// content, so for a container we write the bytes through unchanged; only raw PCM
// needs a WAV header wrapped around it. Returns the bytes to write to `outPath`.
function audioBytesForWriting(bytes: Buffer, mimeType: string): Buffer {
  const mime = mimeType.toLowerCase();
  const isRawPcm = mime.includes("l16") || mime.includes("pcm");
  if (isRawPcm) {
    return pcmToWav(bytes, TTS_SAMPLE_RATE, TTS_CHANNELS);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Provider factories. Each closes over the key + logger; the key never leaves.
// ---------------------------------------------------------------------------

function createTtsProvider(
  transport: GeminiTransport,
  env: NodeJS.ProcessEnv
): TtsProvider {
  // One voice for the whole session: every step's clip uses it, and `label`
  // carries it (e.g. "gemini:Charon") so a good run can be reproduced via
  // $DAILIES_TTS_VOICE.
  const voice = pickTtsVoice(env);
  return {
    id: "gemini-tts",
    label: `gemini:${voice}`,
    async synthesize(text: string, outPath: string): Promise<void> {
      const body = buildInteractionBody({
        model: TTS_MODEL,
        input: buildTtsPrompt(text),
        responseFormat: { type: "audio" },
        speechVoice: voice,
      });
      const json = await postInteraction({
        model: TTS_MODEL,
        transport,
        body,
        timeoutMs: TTS_TIMEOUT_MS,
      });
      const { bytes, mimeType } = mediaOrThrow(TTS_MODEL, json, "audio");
      // Raw PCM → wrap as WAV; a container passes through unchanged.
      await writeFileAtomic(outPath, audioBytesForWriting(bytes, mimeType));
    },
  };
}

function createTitleBackgroundProvider(
  transport: GeminiTransport
): TitleBackgroundProvider {
  return {
    id: "gemini-image",
    async render(
      directionText: string,
      width: number,
      height: number,
      outPath: string
    ): Promise<void> {
      const body = buildInteractionBody({
        model: IMAGE_MODEL,
        input: buildImagePrompt(directionText),
        responseFormat: {
          type: "image",
          // Steer the output toward the video's shape; best-effort fields.
          aspect_ratio: aspectRatioFor(width, height),
        },
      });
      const json = await postInteraction({
        model: IMAGE_MODEL,
        transport,
        body,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
      const { bytes } = mediaOrThrow(IMAGE_MODEL, json, "image");
      // Image bytes (png/jpg) are a real container; write through unchanged.
      await writeFileAtomic(outPath, bytes);
    },
  };
}

function createMusicProvider(transport: GeminiTransport): MusicProvider {
  const generate = async (
    model: string,
    prompt: string,
    outPath: string
  ): Promise<void> => {
    const body = buildInteractionBody({
      model,
      input: prompt,
      responseFormat: { type: "audio" },
    });
    const json = await postInteraction({
      model,
      transport,
      body,
      timeoutMs: MUSIC_TIMEOUT_MS,
    });
    const { bytes, mimeType } = mediaOrThrow(model, json, "audio");
    // Lyria returns an mp3 (or wav) container; write through unchanged. The
    // raw-PCM branch is defensive and won't trigger for Lyria's containers.
    await writeFileAtomic(outPath, audioBytesForWriting(bytes, mimeType));
  };
  return {
    id: "gemini-music",
    singsLyrics: true,
    credit(): Promise<string | undefined> {
      return Promise.resolve("Lyria (Google Gemini)");
    },
    bed(
      directionText: string,
      seconds: number,
      outPath: string
    ): Promise<void> {
      // Instrumental bed → the fixed ~30s clip model.
      return generate(
        MUSIC_CLIP_MODEL,
        buildMusicPrompt(directionText, seconds, false),
        outPath
      );
    },
    song(
      directionText: string,
      seconds: number,
      outPath: string,
      lyrics?: string
    ): Promise<void> {
      // Full song → the full-length pro model. With explicit lyrics Lyria sings
      // them (song mode); without, it writes its own.
      return generate(
        MUSIC_PRO_MODEL,
        buildMusicPrompt(directionText, seconds, true, lyrics),
        outPath
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Vertex provider factories (native surfaces; each closes over the context).
// ---------------------------------------------------------------------------

function createVertexTtsProvider(
  ctx: VertexContext,
  env: NodeJS.ProcessEnv
): TtsProvider {
  const voice = pickTtsVoice(env);
  return {
    id: "gemini-tts",
    label: `gemini:${voice}`,
    async synthesize(text: string, outPath: string): Promise<void> {
      const json = await postVertex({
        model: TTS_MODEL,
        url: vertexModelUrl(ctx, TTS_MODEL, "generateContent"),
        ctx,
        body: buildVertexTtsBody(buildTtsPrompt(text), voice),
        timeoutMs: TTS_TIMEOUT_MS,
      });
      const media = extractGenerateContentMedia(json, "audio");
      if (!media || media.bytes.length === 0) {
        throw new Error(`Vertex ${TTS_MODEL} returned no audio`);
      }
      // Vertex TTS returns raw PCM (audio/l16) → wrap as WAV.
      await writeFileAtomic(
        outPath,
        audioBytesForWriting(media.bytes, media.mimeType)
      );
    },
  };
}

function createVertexTitleBackgroundProvider(
  ctx: VertexContext
): TitleBackgroundProvider {
  return {
    id: "gemini-image",
    async render(
      directionText: string,
      width: number,
      height: number,
      outPath: string
    ): Promise<void> {
      const json = await postVertex({
        model: IMAGE_MODEL,
        url: vertexModelUrl(ctx, IMAGE_MODEL, "generateContent"),
        ctx,
        body: buildVertexImageBody(
          buildImagePrompt(directionText),
          aspectRatioFor(width, height)
        ),
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
      const media = extractGenerateContentMedia(json, "image");
      if (!media || media.bytes.length === 0) {
        throw new Error(`Vertex ${IMAGE_MODEL} returned no image`);
      }
      await writeFileAtomic(outPath, media.bytes);
    },
  };
}

function createVertexMusicProvider(ctx: VertexContext): MusicProvider {
  // Lyria 3 lives on the interactions host (not :predict), returning audio in a
  // top-level outputs[] array. The body is a bare {model, input}: Vertex rejects
  // the response_format the AI Studio interactions body carries. song() returns
  // void (no lrcText) — like the AI Studio provider, so captions fall back to
  // transcribe-and-align; Lyria's own lyric timestamps are not wired up.
  const generate = async (
    model: string,
    prompt: string,
    outPath: string
  ): Promise<void> => {
    const json = await postVertex({
      model,
      url: vertexInteractionsUrl(ctx),
      ctx,
      body: { model, input: prompt },
      timeoutMs: MUSIC_TIMEOUT_MS,
    });
    const media = extractVertexOutputsAudio(json);
    if (!media || media.bytes.length === 0) {
      throw new Error(`Vertex ${model} returned no audio`);
    }
    await writeFileAtomic(
      outPath,
      audioBytesForWriting(media.bytes, media.mimeType)
    );
  };
  return {
    id: "gemini-music",
    singsLyrics: true,
    credit(): Promise<string | undefined> {
      return Promise.resolve("Lyria (Google Gemini)");
    },
    bed(
      directionText: string,
      seconds: number,
      outPath: string
    ): Promise<void> {
      return generate(
        MUSIC_CLIP_MODEL,
        buildMusicPrompt(directionText, seconds, false),
        outPath
      );
    },
    song(
      directionText: string,
      seconds: number,
      outPath: string,
      lyrics?: string
    ): Promise<void> {
      return generate(
        MUSIC_PRO_MODEL,
        buildMusicPrompt(directionText, seconds, true, lyrics),
        outPath
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

// Returns Gemini-backed providers for whichever credential is set, else just
// notes so the caller falls back to its local say/drawtext/no-music paths.
// A Vertex service account (GOOGLE_APPLICATION_CREDENTIALS) takes precedence over
// an AI Studio key; a bad credentials path warns and falls through to the key.
// Each capability is independent: a throw in any one falls back to local without
// affecting the others (so e.g. a non-`global` GOOGLE_CLOUD_LOCATION, where the
// image model isn't served, just yields a local title card).
export function resolveMediaProviders(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
}): MediaProviders {
  const { env, log } = opts;

  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (credPath) {
    try {
      const ctx = createVertexContext(credPath, env);
      // Only the non-secret project/location is logged, never the token.
      log.debug(
        `media providers: Vertex AI (project ${ctx.project}, ${ctx.location})`
      );
      return {
        tts: createVertexTtsProvider(ctx, env),
        titleBackground: createVertexTitleBackgroundProvider(ctx),
        music: createVertexMusicProvider(ctx),
        notes: [
          `Gemini media providers enabled via Vertex AI (project ${ctx.project}, ${ctx.location}): ` +
            "generated narration and music, plus a title background when the location serves the image model " +
            "(only `global` does — elsewhere the title card falls back to local). " +
            "Session-derived text is sent to Google.",
        ],
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(
        `GOOGLE_APPLICATION_CREDENTIALS set but unusable (${reason}); ` +
          "falling back to GEMINI_API_KEY if set."
      );
    }
  }

  const apiKey = readApiKey(env);
  if (apiKey) {
    const transport = createStudioTransport(apiKey);
    // Note: only the non-secret transport label is logged, never the key.
    log.debug(`media providers: ${transport.label}, enabling generated media`);
    return {
      tts: createTtsProvider(transport, env),
      titleBackground: createTitleBackgroundProvider(transport),
      music: createMusicProvider(transport),
      notes: [
        `Gemini media providers enabled via ${transport.label} (Interactions API): ` +
          "generated narration, title background, and music. Session-derived text is sent to Google.",
      ],
    };
  }

  return {
    notes: [
      "No hosted media key set (ELEVENLABS_API_KEY, GEMINI_API_KEY/GOOGLE_GENAI_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS) — using local narration (say), a local title card, and stock music when available.",
    ],
  };
}
