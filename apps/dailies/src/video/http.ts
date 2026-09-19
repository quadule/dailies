import { writeFile } from "node:fs/promises";

// One User-Agent for every outbound fetch the media providers make.
//
// WHY it lives here: Wikimedia asks callers to identify themselves (a vague UA
// is throttled), archive.org appreciates the same, and both were getting it
// wrong in different ways — a hand-written string naming a repo that doesn't
// exist and a frozen "1.0", or no header at all. A shared helper means the
// version tracks the shipped build and the contact URL is right everywhere.
//
// The literal `process.env.DAILIES_CLI_VERSION` must stay spelled out: the
// esbuild bundle replaces that exact expression with the package version at
// build time (see scripts/build.mjs), so a destructured or computed lookup
// would silently fall back to "dev" in the published CLI.
const REPO_URL = "https://github.com/quadule/dailies";

export function userAgent(): string {
  const version = process.env.DAILIES_CLI_VERSION ?? "dev";
  return `dailies-cli/${version} (+${REPO_URL})`;
}

interface RequestOptions {
  headers?: Record<string, string>;
  service: string;
  timeoutMs: number;
}

async function getResponse(
  url: string,
  options: RequestOptions,
  operation: "GET" | "download"
): Promise<Response> {
  const response = await fetch(url, {
    headers: options.headers ?? { "user-agent": userAgent() },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${options.service} ${operation} ${response.status}`);
  }
  return response;
}

export async function getJson(
  url: string,
  options: RequestOptions
): Promise<unknown> {
  return (await getResponse(url, options, "GET")).json();
}

export async function downloadTo(
  url: string,
  outPath: string,
  options: RequestOptions
): Promise<void> {
  const response = await getResponse(url, options, "download");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`${options.service} returned 0 bytes`);
  }
  await writeFile(outPath, bytes);
}

// OpenAI-compatible local media servers expose the same availability probe.
// null means unavailable; an empty list means reachable with no loaded models.
// Callers provide their own headers so optional and required auth stay distinct.
export async function listModelIds(
  baseUrl: string,
  options: { headers: Record<string, string>; timeoutMs: number }
): Promise<string[] | null> {
  try {
    const body = (await getJson(`${baseUrl}/v1/models`, {
      ...options,
      service: "model probe",
    })) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}
