import { afterEach, describe, expect, it } from "vitest";
import { userAgent } from "./http.js";

const ORIGINAL = process.env.DAILIES_CLI_VERSION;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.DAILIES_CLI_VERSION;
  } else {
    process.env.DAILIES_CLI_VERSION = ORIGINAL;
  }
});

describe("userAgent", () => {
  it("names the real repository", () => {
    expect(userAgent()).toContain("https://github.com/quadule/dailies");
  });

  it("never claims the repo that never existed", () => {
    // The old hand-written UA pointed at https://github.com/dailies — a 404,
    // which is worse than no UA when an API operator tries to reach you.
    expect(userAgent()).not.toContain("github.com/dailies");
  });

  it("carries the build's version when esbuild defined one", () => {
    process.env.DAILIES_CLI_VERSION = "1.2.3";
    expect(userAgent()).toBe(
      "dailies-cli/1.2.3 (+https://github.com/quadule/dailies)"
    );
  });

  it("falls back to dev when unbuilt", () => {
    delete process.env.DAILIES_CLI_VERSION;
    expect(userAgent()).toBe(
      "dailies-cli/dev (+https://github.com/quadule/dailies)"
    );
  });
});
