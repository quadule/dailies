// Redact typed credentials out of the text that reaches a SHAREABLE artifact.
//
// Two paths put the literal characters a person typed into results.json and
// report.html — the two artifacts documented as safe to hand over:
//
//   session takeover   the Playwright recorder's generated code, stored verbatim
//                      as the step's script (`page.getByLabel('Password')
//                      .fill('hunter2')`)
//   trace summary      the trace's own fill/type params, rendered into the report
//
// The rule is deliberately narrow: the FIELD decides, never the value. A value
// is replaced only when the locator or selector it is typed into names a
// credential, so a step script stays the readable, replayable evidence it is
// meant to be. Redacting scripts wholesale would take the report's whole point
// with it.
//
// This is a mitigation, not a guarantee: a password typed into a field named
// something else survives, and the trace and profile/ hold the traffic anyway
// (see the artifact table in the README). Credentials belong in a file the
// script reads, not in the script.

export const REDACTED = "[redacted]";

// What a credential field is called. A close cousin of scrub-har.ts's
// SENSITIVE_FIELD (that one matches request-body field names, this one locator
// text) — both tight enough that ordinary form input keeps its value.
const CREDENTIAL_HINT = /passw|passcode|secret|token|otp|pin\b|api[-_ ]?key/i;

// Whether some locator / selector text names a credential field.
export function namesCredential(text: string): boolean {
  return CREDENTIAL_HINT.test(text);
}

// The four ways a value is typed into a field in generated code and in this
// project's own scripts. All are method calls, so one pattern covers them.
const TYPING_CALL = /\.(?:fill|type|pressSequentially|humanFill)\s*\(/g;
const QUOTES = new Set(["'", '"', "`"]);
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

interface Span {
  end: number;
  start: number;
}

// Index of the quote closing the literal that opens at `open`, or -1 when it is
// unterminated. Escapes are skipped so `'it\'s'` reads as one literal.
function endOfString(text: string, open: number): number {
  const quote = text[open];
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      return i;
    }
    i += text[i] === "\\" ? 2 : 1;
  }
  return -1;
}

// Walk a call's argument list from its opening paren and return the string
// literals at the TOP level of that list. Paren- and quote-aware, so a locator
// built inline (`getByRole('textbox', { name: 'Password' }).fill('x')`) neither
// ends the scan early nor contributes its own strings as candidate values.
// Returns null for anything it can't read confidently — an unterminated literal,
// or a call spanning lines — because guessing there could only redact the wrong
// thing.
function topLevelStrings(text: string, open: number): Span[] | null {
  const strings: Span[] = [];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\n") {
      return null;
    }
    if (OPENERS.has(char)) {
      depth++;
      continue;
    }
    if (CLOSERS.has(char)) {
      depth--;
      if (depth === 0) {
        return strings;
      }
      continue;
    }
    if (!QUOTES.has(char)) {
      continue;
    }
    const end = endOfString(text, i);
    if (end === -1) {
      return null;
    }
    if (depth === 1) {
      strings.push({ end, start: i + 1 });
    }
    i = end;
  }
  return null;
}

// Replace the typed value of every credential-named field in `text`, leaving
// everything else — including every other typed value — exactly as it was. Pure
// → unit-tested.
export function redactSecrets(text: string): string {
  const edits: Span[] = [];
  for (const match of text.matchAll(TYPING_CALL)) {
    const open = match.index + match[0].length - 1;
    const strings = topLevelStrings(text, open);
    // The value is the LAST string argument, which covers both the locator form
    // (`.fill('secret')`) and the two-argument form (`.fill('#password',
    // 'secret')`). No string literal means the value came from a variable —
    // nothing to leak here.
    const value = strings?.at(-1);
    if (!value) {
      continue;
    }
    // Everything on this line up to the value: the locator chain, and the
    // selector argument when there is one.
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    if (namesCredential(text.slice(lineStart, value.start - 1))) {
      edits.push(value);
    }
  }
  if (edits.length === 0) {
    return text;
  }
  // Right to left: an earlier replacement would shift every later offset.
  let out = text;
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + REDACTED + out.slice(edit.end);
  }
  return out;
}
