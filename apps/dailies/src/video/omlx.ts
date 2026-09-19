// Local TTS (and, later, music) via an oMLX server — an OpenAI-compatible MLX
// runtime that serves models from the user's Hugging Face cache on localhost.
// This is an ADDITIVE provider layer mirroring providers.ts (the Gemini path):
// same contract (write a finished file to `outPath` or throw), wrapped in the
// caller's try/catch so any failure degrades to the next provider / local `say`.
//
// WHY LOCAL: unlike the Gemini path, session-derived narration text normally
// never leaves the machine — it's POSTed only to 127.0.0.1. That privacy win is
// surfaced in the provider notes. $DAILIES_OMLX_URL can point elsewhere, and
// then the note says so instead of claiming a privacy it no longer has.
//
// API: oMLX speaks the OpenAI audio API. `POST /v1/audio/speech` takes
// { model, input, voice?, response_format } and returns the audio BYTES directly
// (verified: a 24 kHz mono WAV), synchronously — no poll loop, and it does not
// play aloud. `GET /v1/models` lists what's loaded so we can auto-pick a TTS
// model. Auth is an OpenAI-style bearer token.
//
// PRIVACY: the API key comes from env, or from the local oMLX config when (and
// only when) the server is this machine; it is never logged, echoed (the curl
// preview uses a $DAILIES_OMLX_API_KEY placeholder), or written to disk.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "dailies-logger";
import { singleQuote } from "../util/shell.js";
import { isLocalUrl } from "./acestep.js";
import { listModelIds } from "./http.js";
import { writeFileAtomic } from "./media-files.js";
import type { MediaProviders, TtsProvider } from "./providers.js";

const DEFAULT_URL = "http://127.0.0.1:8000";
const MODELS_TIMEOUT_MS = 4000;
const SPEECH_TIMEOUT_MS = 120_000;

// A user-facing line emitter (the cinematic pass routes it to stderr).
type Echo = (line: string) => void;

export interface OmlxConfig {
  apiKey: string;
  baseUrl: string;
}

// Resolve the oMLX base URL. $DAILIES_OMLX_URL overrides the localhost default.
export function omlxBaseUrl(env: NodeJS.ProcessEnv): string {
  return env.DAILIES_OMLX_URL?.trim() || DEFAULT_URL;
}

// Read the oMLX API key: $DAILIES_OMLX_API_KEY wins; otherwise best-effort read
// the local oMLX app config (~/.omlx/settings.json → auth.api_key) so it works
// out of the box on a machine running oMLX. Returns undefined when neither is
// available (oMLX is then treated as not configured and we skip it entirely).
// The key value is never logged.
//
// The config file is consulted ONLY for a local server: that key belongs to the
// oMLX app on this machine, and a $DAILIES_OMLX_URL pointing at some other host
// must bring its own $DAILIES_OMLX_API_KEY rather than have us mail the local
// secret to whoever set the variable.
export async function readOmlxApiKey(
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const fromEnv = env.DAILIES_OMLX_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!isLocalUrl(omlxBaseUrl(env))) {
    return;
  }
  try {
    const raw = await readFile(
      path.join(os.homedir(), ".omlx", "settings.json"),
      "utf8"
    );
    const key = (JSON.parse(raw) as { auth?: { api_key?: unknown } })?.auth
      ?.api_key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return;
  }
}

// A loaded model id that looks like a speech-synthesis model. Beyond a literal
// "tts", match the common on-device TTS families whose ids don't say "tts" (e.g.
// Kokoro, Piper). Deliberately excludes ASR/STT models like parakeet/whisper.
const TTS_MODEL_RE =
  /tts|kokoro|piper|xtts|styletts|speecht5|\bvits\b|orpheus|\bbark\b|\bdia\b|\bcsm\b/i;
// A model that needs a speaker name (`voice`) to synthesize at all — oMLX returns
// HTTP 500 for these when none is given. The id carries the "CustomVoice" signal.
const NEEDS_VOICE_RE = /custom[-_ ]?voice/i;

// Choose the TTS model: an explicit $DAILIES_OMLX_TTS_MODEL wins; otherwise the
// first loaded model that looks like TTS AND speaks out of the box — a
// CustomVoice model is only chosen when $DAILIES_OMLX_TTS_VOICE names a speaker,
// since it 500s otherwise. Returns undefined when no usable TTS model is loaded.
// Pure → unit-tested.
export function pickTtsModel(
  modelIds: string[],
  env: NodeJS.ProcessEnv
): string | undefined {
  const override = env.DAILIES_OMLX_TTS_MODEL?.trim();
  if (override) {
    return override;
  }
  const hasVoice = Boolean(env.DAILIES_OMLX_TTS_VOICE?.trim());
  const candidates = modelIds.filter((id) => TTS_MODEL_RE.test(id));
  return (
    candidates.find((id) => !NEEDS_VOICE_RE.test(id)) ??
    (hasVoice ? candidates.find((id) => NEEDS_VOICE_RE.test(id)) : undefined)
  );
}

// Build the /v1/audio/speech request body. `wav` keeps the bytes trivially
// ffmpeg-decodable. Pure → unit-tested.
export function buildSpeechBody(args: {
  model: string;
  text: string;
  voice?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    input: args.text,
    response_format: "wav",
  };
  if (args.voice) {
    body.voice = args.voice;
  }
  return body;
}

// A redacted, copy-pasteable curl equivalent of a /v1/audio/speech call. The key
// is shown as the env-var reference $DAILIES_OMLX_API_KEY (never the value) so the
// line runs verbatim once that var is exported. Pure → unit-tested.
export function describeSpeechCurl(args: {
  baseUrl: string;
  body: Record<string, unknown>;
  outPath: string;
}): string {
  return [
    "curl -s -X POST",
    `${args.baseUrl}/v1/audio/speech`,
    '-H "Authorization: Bearer $DAILIES_OMLX_API_KEY"',
    "-H 'content-type: application/json'",
    `-d ${singleQuote(JSON.stringify(args.body))}`,
    `-o ${singleQuote(args.outPath)}`,
  ].join(" ");
}

// POST one speech request and write the returned audio bytes to `outPath`.
// Throws a clean Error (no key, no request text) on a non-2xx or transport
// failure — a JSON error body (oMLX returns one) is detected via content-type.
async function synthesizeSpeech(args: {
  config: OmlxConfig;
  model: string;
  voice?: string;
  text: string;
  outPath: string;
  echo?: Echo;
}): Promise<void> {
  const { config, model, voice, text, outPath, echo } = args;
  const body = buildSpeechBody({ model, text, voice });
  echo?.(describeSpeechCurl({ baseUrl: config.baseUrl, body, outPath }));
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`oMLX ${model} speech request failed: ${reason}`);
  }
  if (!res.ok) {
    throw new Error(`oMLX ${model} returned HTTP ${res.status}`);
  }
  if (res.headers.get("content-type")?.includes("application/json")) {
    // An OK status with a JSON body means an error envelope, not audio.
    throw new Error(`oMLX ${model} returned JSON, not audio`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFileAtomic(outPath, bytes, "oMLX returned 0 audio bytes");
}

function createTtsProvider(args: {
  config: OmlxConfig;
  model: string;
  voice?: string;
  echo?: Echo;
}): TtsProvider {
  const { config, model, voice, echo } = args;
  return {
    id: "omlx-tts",
    label: voice ? `omlx:${model}/${voice}` : `omlx:${model}`,
    synthesize: (text, outPath) =>
      synthesizeSpeech({ config, model, voice, text, outPath, echo }),
  };
}

// Resolve oMLX-backed media providers, or just notes when oMLX isn't configured /
// reachable / has no usable model. Returns a partial MediaProviders the caller
// merges over the Gemini/local defaults (oMLX wins per capability). Async because
// it probes /v1/models to discover what's loaded.
export async function resolveOmlxProviders(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
  echo?: Echo;
}): Promise<Pick<MediaProviders, "tts" | "music" | "notes">> {
  const { env, log, echo } = opts;
  const apiKey = await readOmlxApiKey(env);
  if (!apiKey) {
    const url = env.DAILIES_OMLX_URL?.trim();
    if (url && !isLocalUrl(url)) {
      // Configured to reach off-box, but the only key we have belongs to the
      // local oMLX app and is never sent elsewhere — say so rather than let a
      // LAN server that worked yesterday vanish without a word.
      return {
        notes: [
          `oMLX skipped — DAILIES_OMLX_URL points off this machine (${url}), so set DAILIES_OMLX_API_KEY explicitly (the local ~/.omlx key is never sent to another host)`,
        ],
      };
    }
    // Not configured — stay silent so non-oMLX machines see no noise.
    return { notes: [] };
  }
  const config: OmlxConfig = { apiKey, baseUrl: omlxBaseUrl(env) };
  const modelIds = await listModelIds(config.baseUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    timeoutMs: MODELS_TIMEOUT_MS,
  });
  if (!modelIds) {
    log.debug({ url: config.baseUrl }, "oMLX configured but not reachable");
    return { notes: [] };
  }
  const ttsModel = pickTtsModel(modelIds, env);
  if (!ttsModel) {
    return {
      notes: [
        `oMLX reachable at ${config.baseUrl} but no TTS model loaded (set DAILIES_OMLX_TTS_MODEL or load one); using fallback narration.`,
      ],
    };
  }
  const voice = env.DAILIES_OMLX_TTS_VOICE?.trim() || undefined;
  log.debug({ url: config.baseUrl, ttsModel }, "oMLX TTS provider enabled");
  // Phrased like ACE-Step's note: claim the privacy win only when it is true.
  const where = isLocalUrl(config.baseUrl)
    ? "narration is synthesized on this machine and never leaves it"
    : `narration text is sent to ${config.baseUrl}`;
  return {
    tts: createTtsProvider({ config, model: ttsModel, voice, echo }),
    notes: [`oMLX TTS enabled (${ttsModel}) — ${where}.`],
  };
}
