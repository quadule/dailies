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

import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
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

// Above this size a HAR is scrubbed one entry at a time instead of parsed
// whole. V8 caps a string at about 512 MB, so a long session's HAR could not
// even be read as one: on a 50-minute run against a dev server the 780 MB HAR
// failed to scrub and kept every session cookie, with only a warning to say so.
export const STREAM_SCRUB_BYTES = 128 * 1024 * 1024;

const ENTRIES_MARKER = Buffer.from('"entries":[');
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = Buffer.from(",");

// Slices a HAR's entries array into one buffer per entry, by bracket depth,
// across however many chunks the file arrives in. Strings are skipped (with
// their escapes) so a brace or bracket inside a URL or a body is not structure.
class EntrySlicer {
  #depth = 0;
  #inString = false;
  #escaped = false;
  #parts: Buffer[] = [];
  // Where the entry in progress starts in the current chunk; -1 between entries.
  #start = -1;
  readonly #onEntry: (bytes: Buffer) => void;

  constructor(onEntry: (bytes: Buffer) => void) {
    this.#onEntry = onEntry;
  }

  // Feed the next chunk; returns where the entries array closed, or -1.
  feed(chunk: Buffer): number {
    this.#start = this.#depth > 0 ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      if (this.#byte(chunk, i)) {
        return i;
      }
    }
    if (this.#depth > 0 && this.#start >= 0) {
      this.#parts.push(chunk.subarray(this.#start));
    }
    return -1;
  }

  // One byte of the array. True when it is the array's own closing bracket.
  #byte(chunk: Buffer, i: number): boolean {
    const b = chunk[i] as number;
    if (this.#inString) {
      this.#skipString(b);
    } else if (b === QUOTE) {
      this.#inString = true;
    } else if (b === OPEN_BRACE || b === OPEN_BRACKET) {
      if (this.#depth === 0) {
        this.#start = i;
      }
      this.#depth++;
    } else if (b === CLOSE_BRACE || b === CLOSE_BRACKET) {
      if (this.#depth === 0) {
        return true;
      }
      this.#depth--;
      if (this.#depth === 0) {
        this.#finish(chunk.subarray(this.#start, i + 1));
        this.#start = -1;
      }
    }
    return false;
  }

  #finish(tail: Buffer): void {
    this.#parts.push(tail);
    this.#onEntry(Buffer.concat(this.#parts));
    this.#parts = [];
  }

  #skipString(b: number): void {
    if (this.#escaped) {
      this.#escaped = false;
    } else if (b === BACKSLASH) {
      this.#escaped = true;
    } else if (b === QUOTE) {
      this.#inString = false;
    }
  }
}

// Scrub a HAR of any size into `tmp`, holding one entry in memory at a time.
// Everything before `"entries":[` and after its closing bracket is copied
// byte for byte (pages and metadata carry no credentials); each entry is
// parsed, scrubbed by scrubHarLog, and written back — re-serialized only if
// something in it changed. That marker can only be structural: inside a JSON
// string its quotes would be escaped. Throws on anything that isn't shaped
// like a HAR, so the caller keeps the original.
async function scrubHarStreaming(
  harPath: string,
  tmp: string
): Promise<number> {
  const out = createWriteStream(tmp);
  let count = 0;
  let first = true;
  const slicer = new EntrySlicer((bytes) => {
    const entry = JSON.parse(bytes.toString("utf8")) as unknown;
    const replaced = scrubHarLog({ log: { entries: [entry] } });
    count += replaced;
    if (!first) {
      out.write(COMMA);
    }
    first = false;
    out.write(replaced > 0 ? JSON.stringify(entry) : bytes);
  });
  let state: "prefix" | "entries" | "suffix" = "prefix";
  let prefix = Buffer.alloc(0);
  try {
    for await (const data of createReadStream(harPath)) {
      let chunk = data as Buffer;
      if (state === "prefix") {
        prefix = Buffer.concat([prefix, chunk]);
        const at = prefix.indexOf(ENTRIES_MARKER);
        if (at < 0) {
          continue;
        }
        const after = at + ENTRIES_MARKER.length;
        out.write(prefix.subarray(0, after));
        chunk = prefix.subarray(after);
        state = "entries";
      }
      if (state === "entries") {
        const close = slicer.feed(chunk);
        if (close < 0) {
          continue;
        }
        chunk = chunk.subarray(close);
        state = "suffix";
      }
      out.write(chunk);
    }
    if (state !== "suffix") {
      throw new Error("network.har has no complete entries list to scrub");
    }
  } finally {
    out.end();
    await finished(out);
  }
  return count;
}

// Rewrite `harPath` with its credentials scrubbed, atomically (temp + rename)
// so an interrupted or failed pass can never leave a truncated HAR behind. On
// any failure the original file is left exactly as it was and the reason is
// returned — the caller decides how loudly to say so. A missing HAR (capture
// disabled with --no-har) is not an error.
export async function scrubHarFile(
  harPath: string,
  logger: Logger,
  options: { streamAboveBytes?: number } = {}
): Promise<ScrubHarOutcome> {
  const tmp = `${harPath}.scrub-${process.pid}`;
  try {
    const { size } = await stat(harPath);
    let replaced: number;
    if (size > (options.streamAboveBytes ?? STREAM_SCRUB_BYTES)) {
      replaced = await scrubHarStreaming(harPath, tmp);
      if (replaced === 0) {
        await rm(tmp, { force: true });
        return { replaced: 0, scrubbed: true };
      }
    } else {
      const har = JSON.parse(await readFile(harPath, "utf8")) as unknown;
      replaced = scrubHarLog(har);
      if (replaced === 0) {
        return { replaced: 0, scrubbed: true };
      }
      await writeFile(tmp, JSON.stringify(har));
    }
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
