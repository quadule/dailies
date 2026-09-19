import { describe, expect, it } from "vitest";
import { noProviderReason, writerCredit } from "./index.js";

describe("writerCredit", () => {
  it("names the provider that wrote the words, with the model where it matters", () => {
    // The default provider keeps the label existing credits used, so a cut made
    // with the claude CLI looks exactly as before.
    expect(writerCredit("claude", "sonnet")).toBe("Claude (Anthropic)");
    expect(writerCredit("apple", "foundation")).toBe(
      "Apple Intelligence (on-device)"
    );
    // "OpenAI-compatible" alone says nothing; the model is the credit.
    expect(writerCredit("openai", "gpt-4o-mini")).toBe(
      "gpt-4o-mini (OpenAI-compatible)"
    );
    expect(writerCredit("openai", "  ")).toBe("an OpenAI-compatible model");
  });
});

describe("noProviderReason", () => {
  it("names every route when nothing is pinned, and the bad pin otherwise", () => {
    expect(noProviderReason({})).toContain("install the `claude` CLI");
    expect(noProviderReason({})).toContain("$DAILIES_LLM_URL");
    expect(noProviderReason({})).toContain("Apple Intelligence");
    expect(noProviderReason({ DAILIES_LLM: "bard" })).toBe(
      'no text provider named "bard" ($DAILIES_LLM must be claude, openai or apple)'
    );
  });
});
