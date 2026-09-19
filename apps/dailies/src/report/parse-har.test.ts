import { describe, expect, it } from "vitest";
import { parseHar } from "./parse-har.js";

describe("parseHar", () => {
  it("summarizes entries, counting failures and slowest", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "GET", url: "http://x/ok" },
            response: { status: 200 },
            time: 50,
          },
          {
            request: { method: "POST", url: "http://x/boom" },
            response: { status: 500 },
            time: 300,
          },
          {
            request: { method: "GET", url: "http://x/aborted" },
            response: { status: 0 },
            time: 10,
          },
        ],
      },
    });
    const summary = parseHar(har);
    expect(summary.total).toBe(3);
    expect(summary.failed).toBe(2); // 500 + status 0
    expect(summary.slowest[0]?.url).toBe("http://x/boom");
  });

  it("returns an empty summary on malformed input (never throws)", () => {
    expect(parseHar("not json")).toEqual({
      entries: [],
      failed: 0,
      slowest: [],
      total: 0,
    });
    expect(parseHar("").total).toBe(0);
  });

  it("keeps partial requests renderable when HAR entries have unexpected shapes", () => {
    const summary = parseHar(
      JSON.stringify({
        log: {
          entries: [
            null,
            { request: { method: {}, url: 5 }, response: { status: "200" } },
            {
              request: { method: "GET", url: "https://example.com" },
              response: { status: 200 },
            },
          ],
        },
      })
    );
    expect(summary.entries).toEqual([
      { durationMs: 0, method: "", status: 0, url: "" },
      { durationMs: 0, method: "", status: 0, url: "" },
      { durationMs: 0, method: "GET", status: 200, url: "https://example.com" },
    ]);
    expect(summary.failed).toBe(2);
  });
});
