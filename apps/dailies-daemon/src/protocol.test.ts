import { CaptionEventSchema, parseRequest, serialize } from "dailies-protocol";
import { describe, expect, it } from "vitest";

describe("session request capture defaults", () => {
  const start = { id: "request-1", type: "session-start", sessionId: "demo" };

  it("enables each capture when the entire option is omitted", () => {
    expect(parseRequest(JSON.stringify(start))).toEqual({
      success: true,
      request: {
        ...start,
        capture: { trace: true, video: true, har: true, console: true },
        cursor: true,
      },
    });
  });

  it("defaults unspecified capture flags without overriding explicit false", () => {
    const result = parseRequest(
      JSON.stringify({ ...start, capture: { video: false }, cursor: false })
    );
    expect(result).toEqual({
      success: true,
      request: {
        ...start,
        capture: { trace: true, video: false, har: true, console: true },
        cursor: false,
      },
    });
  });

  it("rejects malformed capture values and retains the request id and path", () => {
    const result = parseRequest(
      JSON.stringify({ ...start, capture: { trace: "false" } })
    );
    expect(result).toEqual({
      success: false,
      id: start.id,
      error: expect.stringContaining("capture.trace:"),
    });
  });
});

describe("protocol numeric validation", () => {
  it.each(["0", "-1", "1.5", '"1000"', "null", "1e400", "9007199254740992"])(
    "rejects invalid timeout %s on the wire",
    (timeout) => {
      const result = parseRequest(
        `{"id":"timeout","type":"execute","script":"","timeoutMs":${timeout}}`
      );
      expect(result).toEqual({
        success: false,
        id: "timeout",
        error: expect.stringContaining("timeoutMs:"),
      });
    }
  );

  it("accepts a positive integer timeout without changing it", () => {
    expect(
      parseRequest(
        '{"id":"timeout","type":"execute","script":"","timeoutMs":30000}'
      )
    ).toEqual({
      success: true,
      request: {
        id: "timeout",
        type: "execute",
        script: "",
        browser: "default",
        timeoutMs: 30_000,
      },
    });
  });

  it.each([0, 1.5, 7681])("rejects invalid viewport width %s", (width) => {
    const result = parseRequest(
      JSON.stringify({
        id: "viewport",
        type: "session-start",
        sessionId: "demo",
        viewport: { width, height: 900 },
      })
    );
    expect(result).toEqual({
      success: false,
      id: "viewport",
      error: expect.stringContaining("viewport.width:"),
    });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid caption duration %s",
    (durationMs) => {
      expect(
        CaptionEventSchema.safeParse({
          at: "2026-09-19T00:00:00Z",
          text: "Hello",
          durationMs,
        }).success
      ).toBe(false);
    }
  );

  it("allows a zero-duration caption", () => {
    const event = { at: "2026-09-19T00:00:00Z", text: "Hello", durationMs: 0 };
    expect(CaptionEventSchema.parse(event)).toEqual(event);
  });
});

describe("result wire format", () => {
  it("keeps absent and undefined result payloads valid", () => {
    expect(serialize({ id: "result", type: "result" })).toBe(
      '{"id":"result","type":"result"}\n'
    );
    expect(serialize({ id: "result", type: "result", data: undefined })).toBe(
      '{"id":"result","type":"result"}\n'
    );
  });

  it("preserves structured payloads and appends one newline", () => {
    const message = {
      id: "result",
      type: "result" as const,
      data: { count: 2, pages: ["main", "checkout"], extra: null },
    };
    expect(serialize(message)).toBe(`${JSON.stringify(message)}\n`);
  });
});
