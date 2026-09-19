// Strip credentials out of a recorded session's HAR.
//
// Playwright records every request header verbatim, so a session driven against
// a logged-in app leaves live `Cookie` / `set-cookie` / `Authorization` values
// in `network.har` — and a session directory is meant to be handed to someone
// else. Header NAMES are kept (so "this request carried a cookie" is still
// visible when debugging); only the values are replaced.
//
// REQUEST BODIES are scrubbed the same way, by field NAME: a login POST carries
// the password in its body, not in a header, so headers alone left the one
// credential the session was most likely to hold. Matching is by name because
// nothing else distinguishes a password from any other string.
//
// This does NOT make a session directory safe to publish wholesale: the
// Playwright trace holds the same traffic, RESPONSE bodies are not scrubbed and
// can carry tokens of their own, and the browser `profile/` directory contains a
// real Chrome cookie database. See the artifact table in the README.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Logger } from "dailies-logger";
import type { SessionEndResult } from "dailies-protocol";

export const SCRUB_PLACEHOLDER = "[scrubbed]";

// Headers whose value is, on its own, enough to act as the user. Kept
// deliberately tight: scrubbing more (a CSRF token, a request id) costs real
// debugging signal without removing a session-takeover risk.
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

// Body FIELDS whose value is a credential. Same "deliberately tight" policy as
// the header set above: enough to catch a sign-in form or a token exchange,
// narrow enough that a HAR is still worth reading afterwards.
// `\bpass(word|wd|phrase)` and not a bare `pass`: "passengers", "passes" and
// "bypass_cache" are ordinary fields, and one false match replaces a WHOLE body.
const SENSITIVE_FIELD =
  /\bpass(?:word|wd|phrase)|secret|token|\botp\b|\bpin\b|api[-_ ]?key/i;

interface NameValue {
  name?: unknown;
  value?: unknown;
}

function scrubNameValueList(list: unknown): number {
  if (!Array.isArray(list)) {
    return 0;
  }
  let count = 0;
  for (const item of list) {
    const entry = item as NameValue;
    if (
      typeof entry?.name === "string" &&
      typeof entry.value === "string" &&
      entry.value !== SCRUB_PLACEHOLDER &&
      SENSITIVE_HEADERS.has(entry.name.toLowerCase())
    ) {
      entry.value = SCRUB_PLACEHOLDER;
      count++;
    }
  }
  return count;
}

// HAR models cookies structurally too (`request.cookies` / `response.cookies`),
// so a value scrubbed from the header would otherwise survive here.
function scrubCookieList(list: unknown): number {
  if (!Array.isArray(list)) {
    return 0;
  }
  let count = 0;
  for (const item of list) {
    const cookie = item as { value?: unknown };
    if (
      typeof cookie?.value === "string" &&
      cookie.value !== SCRUB_PLACEHOLDER
    ) {
      cookie.value = SCRUB_PLACEHOLDER;
      count++;
    }
  }
  return count;
}

// Whether a raw body reads as JSON carrying a credential field, for the case
// HAR gives us no structured params (a JSON login POST). Key names only — the
// same signal the params pass uses, applied to the text we cannot take apart.
function jsonBodyNamesACredential(text: string): boolean {
  for (const match of text.matchAll(/"([^"]{1,200})"\s*:/g)) {
    if (SENSITIVE_FIELD.test(match[1] ?? "")) {
      return true;
    }
  }
  return false;
}

// The same for a raw form-encoded body HAR did not break into params (a
// text/plain or otherwise unparsed `password=…&remember=1`).
function formBodyNamesACredential(text: string): boolean {
  for (const match of text.matchAll(/(?:^|[&?])([^=&]{1,200})=/g)) {
    if (SENSITIVE_FIELD.test(match[1] ?? "")) {
      return true;
    }
  }
  return false;
}

// Scrub a request body. `params` is HAR's parsed view of a form post, so each
// credential field is replaced individually and the rest of the form survives.
// `text` is the raw body and has no such structure, so once anything in it looks
// like a credential the WHOLE body goes: a half-scrubbed body would still carry
// the password, which is the only outcome that matters here.
function scrubPostData(postData: unknown): number {
  if (!postData || typeof postData !== "object") {
    return 0;
  }
  const data = postData as { params?: unknown; text?: unknown };
  let count = 0;
  let named = false;
  if (Array.isArray(data.params)) {
    for (const item of data.params) {
      const param = item as NameValue;
      if (
        !(typeof param?.name === "string" && SENSITIVE_FIELD.test(param.name))
      ) {
        continue;
      }
      named = true;
      if (
        typeof param.value === "string" &&
        param.value !== SCRUB_PLACEHOLDER
      ) {
        param.value = SCRUB_PLACEHOLDER;
        count++;
      }
    }
  }
  if (
    typeof data.text === "string" &&
    data.text !== SCRUB_PLACEHOLDER &&
    (named ||
      jsonBodyNamesACredential(data.text) ||
      formBodyNamesACredential(data.text))
  ) {
    data.text = SCRUB_PLACEHOLDER;
    count++;
  }
  return count;
}

// Scrub a parsed HAR in place. Returns the number of values replaced, so the
// caller can report what it did (and say nothing when there was nothing to do).
// Tolerant of shape: a malformed or partial HAR scrubs what it can rather than
// throwing. Pure apart from the in-place mutation → unit-tested.
export function scrubHarLog(har: unknown): number {
  const entries = (har as { log?: { entries?: unknown } })?.log?.entries;
  if (!Array.isArray(entries)) {
    return 0;
  }
  let count = 0;
  for (const item of entries) {
    const entry = item as { request?: unknown; response?: unknown };
    for (const side of [entry?.request, entry?.response]) {
      const message = side as { headers?: unknown; cookies?: unknown };
      if (!message) {
        continue;
      }
      count += scrubNameValueList(message.headers);
      count += scrubCookieList(message.cookies);
    }
    // Requests only: a response has no postData, and response BODIES are out of
    // scope (see the header note).
    count += scrubPostData(
      (entry?.request as { postData?: unknown } | undefined)?.postData
    );
  }
  return count;
}

export type ScrubHarOutcome =
  | { scrubbed: true; replaced: number }
  | { scrubbed: false; reason: string };

// Rewrite `harPath` with its credentials scrubbed, atomically (temp + rename)
// so an interrupted or failed pass can never leave a truncated HAR behind. On
// any failure the original file is left exactly as it was and the reason is
// returned — the caller decides how loudly to say so. A missing HAR (capture
// disabled with --no-har) is not an error.
export async function scrubHarFile(
  harPath: string,
  logger: Logger
): Promise<ScrubHarOutcome> {
  const tmp = `${harPath}.scrub-${process.pid}`;
  try {
    const raw = await readFile(harPath, "utf8");
    const har = JSON.parse(raw) as unknown;
    const replaced = scrubHarLog(har);
    if (replaced === 0) {
      return { replaced: 0, scrubbed: true };
    }
    await writeFile(tmp, JSON.stringify(har));
    await rename(tmp, harPath);
    logger.debug({ harPath, replaced }, "scrubbed credentials from the HAR");
    return { replaced, scrubbed: true };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    // No HAR on disk means capture was off (--no-har). Nothing to scrub, and
    // nothing worth warning about.
    if ((err as { code?: string })?.code === "ENOENT") {
      return { replaced: 0, scrubbed: true };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { reason, scrubbed: false };
  }
}

// Scrub the HAR of a finished session, whatever finished it. Lives here rather
// than in `session end` because `session abort` produces the same directory,
// against the same logged-in app, with the same credentials in it — it just
// produces it after something went wrong, which is not a reason to hand it over
// unscrubbed. Never throws: the session is already over.
export async function scrubSessionHar(
  result: SessionEndResult,
  logger: Logger
): Promise<void> {
  const har = result.artifacts.find((a) => a.kind === "har");
  if (!har) {
    return;
  }
  const outcome = await scrubHarFile(har.path, logger);
  if (outcome.scrubbed) {
    if (outcome.replaced > 0) {
      logger.info(
        { har: har.path, replaced: outcome.replaced },
        `scrubbed ${outcome.replaced} credential value(s) from network.har`
      );
    }
    return;
  }
  // Loudly: the artifact is still on disk WITH its credentials, and the whole
  // point of the pass is that someone is about to share it.
  logger.warn(
    { har: har.path, reason: outcome.reason },
    "could not scrub network.har — it still contains credentials; do not share this session directory"
  );
}
