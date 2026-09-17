// Google Cloud service-account auth for the Vertex AI transport.
//
// A service-account JSON key authenticates differently from a plain Gemini API
// key: we RS256-sign a short-lived JWT with the account's private key, exchange
// it at the OAuth token endpoint (the jwt-bearer grant) for an access token, and
// send that token as a Bearer header. Tokens live ~1 hour, so we cache one and
// re-mint only as it nears expiry.
//
// No external dependency: node:crypto signs the JWT and global fetch does the
// exchange. The private key and the minted token are NEVER logged.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

// Scope for Vertex AI (and every other Cloud API) — the standard broad scope the
// token exchange grants against a service account.
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

// The fields we need from a service-account JSON. Real keys carry more; we read
// only these and ignore the rest.
export interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id: string;
  readonly token_uri: string;
}

// Parse + validate a service-account JSON string. Throws a clean Error (naming
// the missing field, never echoing the key material) when it isn't one.
export function parseServiceAccount(raw: string): ServiceAccount {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("service-account file is not valid JSON");
  }
  if (obj.type !== "service_account") {
    throw new Error(
      `expected a service_account key (type="${String(obj.type)}")`
    );
  }
  const need = (field: keyof ServiceAccount): string => {
    const v = obj[field];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`service-account file is missing "${field}"`);
    }
    return v;
  };
  return {
    client_email: need("client_email"),
    private_key: need("private_key"),
    project_id: need("project_id"),
    // token_uri is present in real keys but harmless to default.
    token_uri:
      typeof obj.token_uri === "string" && obj.token_uri.trim()
        ? obj.token_uri
        : DEFAULT_TOKEN_URI,
  };
}

// Read + parse a service-account key from disk (synchronously — done once at
// resolve time). Any read/parse failure surfaces with the path for context.
export function loadServiceAccount(path: string): ServiceAccount {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read service-account file ${path}: ${reason}`);
  }
  return parseServiceAccount(raw);
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

// Build a signed JWT assertion for the jwt-bearer grant: header.claims.signature,
// each segment base64url, the signature an RS256 sign over "header.claims" with
// the account's private key. Pure and deterministic given `nowSec` — the network
// exchange lives in createTokenSource so this stays unit-testable.
export function buildJwtAssertion(
  sa: ServiceAccount,
  nowSec: number,
  scope: string = CLOUD_PLATFORM_SCOPE
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(sa.private_key, "base64url");
  return `${header}.${claims}.${signature}`;
}

// A no-arg async function that yields a currently-valid access token, minting
// (and caching) on demand.
export type TokenSource = () => Promise<string>;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

// Create a caching token source for a service account. The first call mints a
// token; later calls reuse it until it is within `skewSec` of expiry, then
// re-mint. `fetchImpl` and `now` are injectable for tests.
export function createTokenSource(
  sa: ServiceAccount,
  deps: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    skewSec?: number;
  } = {}
): TokenSource {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const skewSec = deps.skewSec ?? 60;

  let cached: { token: string; expiresAtSec: number } | undefined;

  return async function token(): Promise<string> {
    const nowSec = Math.floor(now() / 1000);
    if (cached && cached.expiresAtSec - skewSec > nowSec) {
      return cached.token;
    }
    const assertion = buildJwtAssertion(sa, nowSec);
    const res = await doFetch(sa.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      // Status only — the token endpoint's body can echo request details.
      throw new Error(`token exchange failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error("token exchange returned no access_token");
    }
    cached = {
      token: json.access_token,
      expiresAtSec: nowSec + (json.expires_in ?? 3600),
    };
    return cached.token;
  };
}
