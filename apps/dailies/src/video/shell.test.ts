import { describe, expect, it } from "vitest";
import { formatCommand, shellQuote, singleQuote } from "./shell.js";

describe("singleQuote", () => {
  it("preserves the quoted curl preview format for paths, empty values, and apostrophes", () => {
    expect(singleQuote("/tmp/audio.wav")).toBe("'/tmp/audio.wav'");
    expect(singleQuote("")).toBe("''");
    expect(singleQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("shellQuote", () => {
  it("leaves safe bare tokens unquoted", () => {
    expect(shellQuote("say")).toBe("say");
    expect(shellQuote("-v")).toBe("-v");
    expect(shellQuote("http://127.0.0.1:8000/v1/audio/speech")).toBe(
      "http://127.0.0.1:8000/v1/audio/speech"
    );
    expect(shellQuote("44100")).toBe("44100");
  });

  it("single-quotes tokens with spaces or parens (voice names)", () => {
    expect(shellQuote("Ava (Premium)")).toBe("'Ava (Premium)'");
    expect(shellQuote("")).toBe("''");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("formatCommand", () => {
  it("renders a copy-pasteable say line with a parenthesized voice", () => {
    expect(
      formatCommand("say", [
        "-v",
        "Ava (Premium)",
        "-r",
        "170",
        "Hi",
        "-o",
        "out.aiff",
      ])
    ).toBe("say -v 'Ava (Premium)' -r 170 Hi -o out.aiff");
  });
});
