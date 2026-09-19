import { describe, expect, it } from "vitest";
import { countConsoleErrors, parseConsole } from "./parse-console.js";

describe("parseConsole", () => {
  it("parses newline-delimited JSON and skips malformed lines", () => {
    const raw = [
      JSON.stringify({ kind: "console", type: "log", text: "hello" }),
      JSON.stringify({ kind: "console", type: "error", text: "bad" }),
      "{ not valid json",
      JSON.stringify({ kind: "pageerror", message: "boom" }),
      "",
    ].join("\n");

    const entries = parseConsole(raw);
    expect(entries).toHaveLength(3);
    expect(countConsoleErrors(entries)).toBe(2); // console error + pageerror
  });

  it("returns an empty array for empty input", () => {
    expect(parseConsole("")).toEqual([]);
  });

  it("skips JSON values and malformed fields that cannot be rendered", () => {
    const raw = [
      null,
      false,
      12,
      "text",
      [],
      { type: ["error"], text: "bad type" },
      { type: "log", text: { nested: "bad text" } },
      { kind: "pageerror", message: "survived", ts: 123 },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    const entries = parseConsole(raw);
    expect(entries).toEqual([
      { kind: "pageerror", message: "survived", ts: 123 },
    ]);
    expect(countConsoleErrors(entries)).toBe(1);
  });
});
