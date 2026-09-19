import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildJwtAssertion,
  createTokenSource,
  parseServiceAccount,
  type ServiceAccount,
} from "./gcp-auth.js";

// A throwaway RSA keypair so the signature is real and verifiable in-test.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const sa: ServiceAccount = {
  client_email: "sa@example-project.iam.gserviceaccount.com",
  private_key: privateKey,
  project_id: "example-project",
  token_uri: "https://oauth2.googleapis.com/token",
};

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("parseServiceAccount", () => {
  it("reads the fields it needs and defaults token_uri", () => {
    const raw = JSON.stringify({
      type: "service_account",
      client_email: "a@b.iam.gserviceaccount.com",
      private_key: "KEY",
      project_id: "proj",
    });
    const parsed = parseServiceAccount(raw);
    expect(parsed.client_email).toBe("a@b.iam.gserviceaccount.com");
    expect(parsed.project_id).toBe("proj");
    expect(parsed.token_uri).toBe("https://oauth2.googleapis.com/token");
  });

  it("rejects a non-service_account key", () => {
    const raw = JSON.stringify({ type: "authorized_user" });
    expect(() => parseServiceAccount(raw)).toThrow(/service_account/);
  });

  it("names the missing field", () => {
    const raw = JSON.stringify({
      type: "service_account",
      client_email: "a@b",
    });
    expect(() => parseServiceAccount(raw)).toThrow(/private_key/);
  });

  it("rejects non-JSON without echoing content", () => {
    expect(() => parseServiceAccount("-----BEGIN KEY-----")).toThrow(
      /not valid JSON/
    );
  });
});

describe("buildJwtAssertion", () => {
  it("produces a real RS256 JWT over header.claims", () => {
    const now = 1_700_000_000;
    const jwt = buildJwtAssertion(sa, now);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [header, claims, signature] = parts as [string, string, string];

    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims)).toMatchObject({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    });

    // The signature verifies against the public half of the key.
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, signature, "base64url");
    expect(ok).toBe(true);
  });
});

describe("createTokenSource", () => {
  // Mints a fresh token id ("tok-1", "tok-2", ...) on each exchange so a bug
  // that bypasses the cache but returns a stale token is still visible.
  function fakeFetch(expiresIn = 3600) {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `tok-${calls}`,
          expires_in: expiresIn,
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  it("caches until the skew window, then re-mints a fresh token", async () => {
    let nowMs = 1_700_000_000_000;
    const f = fakeFetch(3600); // expires at T+3600; skew 60 → re-mint from T+3540
    const src = createTokenSource(sa, {
      fetchImpl: f.impl,
      now: () => nowMs,
      skewSec: 60,
    });

    expect(await src()).toBe("tok-1");
    expect(await src()).toBe("tok-1"); // still cached
    expect(f.calls()).toBe(1);

    // Just before the skew window opens → still the cached token.
    nowMs += 3_500_000; // T+3500
    expect(await src()).toBe("tok-1");
    expect(f.calls()).toBe(1);

    // Inside the skew window (< 60s to expiry) → re-mint, new token id.
    nowMs += 50_000; // T+3550
    expect(await src()).toBe("tok-2");
    expect(f.calls()).toBe(2);
  });

  it("throws a status-only error on a non-2xx exchange", async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 401,
      }) as unknown as Response) as unknown as typeof fetch;
    const src = createTokenSource(sa, { fetchImpl: impl });
    await expect(src()).rejects.toThrow(/HTTP 401/);
  });

  it("throws when the exchange returns no access_token", async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    const src = createTokenSource(sa, { fetchImpl: impl });
    await expect(src()).rejects.toThrow(/no access_token/);
  });

  it("bounds a stalled token exchange and lets the next call retry", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const retry = fakeFetch();
    const impl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true }
            );
          })
      )
      .mockImplementationOnce(retry.impl);
    try {
      const src = createTokenSource(sa, { fetchImpl: impl });
      const pending = src();
      const rejected = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
      });
      controller.abort(
        new DOMException("token exchange timed out", "TimeoutError")
      );
      await rejected;

      expect(timeout).toHaveBeenCalledWith(30_000);
      timeout.mockRestore();
      await expect(src()).resolves.toBe("tok-1");
      expect(impl).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });
});
