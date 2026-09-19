// Local AI title-card backgrounds via an OpenAI-images-compatible server
// (LocalAI, some llama.cpp image servers, or any endpoint that speaks
// `POST /v1/images/generations`). Additive TitleBackgroundProvider mirroring the
// ACE-Step music integration: a local HTTP server addressed by an env var, same
// contract (write a finished image to outPath or throw) so a failure degrades to
// the next background source.
//
// Enabled by setting $DAILIES_IMAGE_URL (e.g. http://127.0.0.1:8080). Optional
// $DAILIES_IMAGE_MODEL picks the model; $DAILIES_IMAGE_API_KEY adds a Bearer header.
//
// PRIVACY: the creative direction is sent only to the configured server; the API
// key is read from env and never logged (the curl preview shows a placeholder).
import { writeFile } from "node:fs/promises";
import type { Logger } from "dailies-logger";
import { singleQuote } from "../util/shell.js";
import type { MediaProviders, TitleBackgroundProvider } from "./providers.js";
import { buildImagePrompt } from "./providers.js";

const GENERATE_TIMEOUT_MS = 180_000;

type Echo = (line: string) => void;

export interface LocalImageConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

// The /v1/images/generations request body. Requests a single base64 PNG at the
// video's pixel size (local servers accept an arbitrary WxH; the OpenAI cloud
// only accepts fixed sizes, but this targets local servers). Pure → unit-tested.
export function buildImageRequestBody(args: {
  directionText: string;
  width: number;
  height: number;
  model?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: buildImagePrompt(args.directionText),
    n: 1,
    size: `${Math.round(args.width)}x${Math.round(args.height)}`,
    response_format: "b64_json",
  };
  if (args.model) {
    body.model = args.model;
  }
  return body;
}

// Extract PNG/JPEG bytes from an OpenAI-images response: `data[0].b64_json`
// (preferred) or `data[0].url` (returns the url to fetch). Returns null when
// neither is present. Pure → unit-tested.
export function imageFromResponse(
  body: unknown
): { bytes?: Buffer; url?: string } | null {
  const first = (
    body as { data?: Array<{ b64_json?: unknown; url?: unknown }> }
  )?.data?.[0];
  if (!first) {
    return null;
  }
  if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
    const bytes = Buffer.from(first.b64_json, "base64");
    return bytes.length > 0 ? { bytes } : null;
  }
  if (typeof first.url === "string" && first.url.length > 0) {
    return { url: first.url };
  }
  return null;
}

// Redacted, copy-pasteable curl preview (key shown as the env-var reference).
export function describeImageCurl(args: {
  baseUrl: string;
  body: Record<string, unknown>;
  hasKey: boolean;
}): string {
  const auth = args.hasKey
    ? ['-H "Authorization: Bearer $DAILIES_IMAGE_API_KEY"']
    : [];
  return [
    "curl -s -X POST",
    `${args.baseUrl}/v1/images/generations`,
    ...auth,
    "-H 'content-type: application/json'",
    `-d ${singleQuote(JSON.stringify(args.body))}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// I/O.
// ---------------------------------------------------------------------------

async function generate(args: {
  config: LocalImageConfig;
  directionText: string;
  width: number;
  height: number;
  outPath: string;
  echo?: Echo;
}): Promise<void> {
  const { config, directionText, width, height, outPath, echo } = args;
  const body = buildImageRequestBody({
    directionText,
    width,
    height,
    model: config.model,
  });
  echo?.(
    describeImageCurl({
      baseUrl: config.baseUrl,
      body,
      hasKey: Boolean(config.apiKey),
    })
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`local image request failed: ${reason}`);
  }
  if (!res.ok) {
    throw new Error(`local image server returned HTTP ${res.status}`);
  }
  const found = imageFromResponse(await res.json());
  if (!found) {
    throw new Error("local image response had no image");
  }
  let bytes = found.bytes;
  if (!bytes && found.url) {
    const imgRes = await fetch(found.url, {
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    if (!imgRes.ok) {
      throw new Error(`local image download returned HTTP ${imgRes.status}`);
    }
    bytes = Buffer.from(await imgRes.arrayBuffer());
  }
  if (!bytes || bytes.length === 0) {
    throw new Error("local image was empty");
  }
  await writeFile(outPath, bytes);
}

function createProvider(
  config: LocalImageConfig,
  echo?: Echo
): TitleBackgroundProvider {
  return {
    id: "local-image",
    render: (directionText, width, height, outPath) =>
      generate({ config, directionText, width, height, outPath, echo }),
  };
}

// Resolve the local-image provider when $DAILIES_IMAGE_URL is set. Returns just
// { enabled: false } otherwise, so the caller falls through to the next
// background source.
export function resolveLocalImage(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
  echo?: Echo;
}): Pick<MediaProviders, "titleBackground"> & { enabled: boolean } {
  const { env, log, echo } = opts;
  const baseUrl = env.DAILIES_IMAGE_URL?.trim();
  if (!baseUrl) {
    return { enabled: false };
  }
  const config: LocalImageConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.DAILIES_IMAGE_API_KEY?.trim() || undefined,
    model: env.DAILIES_IMAGE_MODEL?.trim() || undefined,
  };
  log.debug({ url: config.baseUrl }, "local image provider enabled");
  return { enabled: true, titleBackground: createProvider(config, echo) };
}
