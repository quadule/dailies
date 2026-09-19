import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseTraceActions } from "./parse-trace.js";

function makeTraceZip(events: unknown[]): Uint8Array {
  const text = events.map((e) => JSON.stringify(e)).join("\n");
  return zipSync({ "trace.trace": strToU8(text) });
}

describe("parseTraceActions", () => {
  it("groups actions by step and reconstructs Class.method names", () => {
    const zip = makeTraceZip([
      { browserName: "chromium", type: "context-options" },
      {
        callId: "g1",
        class: "Tracing",
        method: "tracingGroup",
        startTime: 100,
        title: "open-home",
        type: "before",
      },
      {
        callId: "c1",
        class: "Frame",
        method: "goto",
        params: { timeout: 30_000, url: "https://example.com" },
        startTime: 110,
        type: "before",
      },
      { callId: "c1", endTime: 160, type: "after" },
      {
        callId: "c2",
        class: "Page",
        method: "mouseWheel",
        params: { deltaX: 0, deltaY: 700 },
        startTime: 170,
        type: "before",
      },
      { callId: "c2", endTime: 175, type: "after" },
      {
        callId: "g2",
        class: "Tracing",
        method: "tracingGroup",
        startTime: 200,
        title: "submit",
        type: "before",
      },
      {
        callId: "c3",
        class: "Frame",
        method: "click",
        params: { selector: "#go" },
        startTime: 210,
        type: "before",
      },
      { callId: "c3", endTime: 230, error: { message: "boom" }, type: "after" },
    ]);

    const { byStep, total } = parseTraceActions(zip);

    expect(total).toBe(3);
    expect(byStep["open-home"]?.map((a) => a.apiName)).toEqual([
      "Frame.goto",
      "Page.mouseWheel",
    ]);
    // goto: url surfaced, noise dropped, duration paired by callId
    const goto = byStep["open-home"]?.[0];
    expect(goto?.params).toBe("https://example.com");
    expect(goto?.durationMs).toBe(50);
    // mouseWheel: deltas summarized
    expect(byStep["open-home"]?.[1]?.params).toContain("deltaY");
    // submit step: click recorded with its error + duration
    expect(byStep.submit?.[0]?.apiName).toBe("Frame.click");
    expect(byStep.submit?.[0]?.error).toBe("boom");
    expect(byStep.submit?.[0]?.durationMs).toBe(20);
  });

  it("redacts a value typed into a credential field, but not other typing", () => {
    // These summaries are rendered into report.html, the artifact documented as
    // shareable — a sign-in step must not carry the password into it.
    const zip = makeTraceZip([
      {
        callId: "c1",
        class: "Frame",
        method: "fill",
        params: { selector: "#user_password", value: "hunter2" },
        startTime: 100,
        type: "before",
      },
      {
        callId: "c2",
        class: "Frame",
        method: "fill",
        params: { selector: "#search", value: "invoices" },
        startTime: 110,
        type: "before",
      },
      {
        callId: "c3",
        class: "Frame",
        method: "type",
        params: { selector: 'internal:label="OTP"i', text: "123456" },
        startTime: 120,
        type: "before",
      },
    ]);

    const actions = parseTraceActions(zip).byStep["(setup)"];

    expect(actions?.[0]?.params).not.toContain("hunter2");
    expect(actions?.[0]?.params).toContain("[redacted]");
    // The selector stays — it is what makes the redacted line legible.
    expect(actions?.[0]?.params).toContain("#user_password");
    // An ordinary field keeps its value: the trace is evidence.
    expect(actions?.[1]?.params).toContain("invoices");
    expect(actions?.[2]?.params).not.toContain("123456");
    expect(actions?.[2]?.params).toContain("[redacted]");
  });

  it("returns empty for non-zip / garbage input", () => {
    expect(parseTraceActions(new Uint8Array([1, 2, 3, 4]))).toEqual({
      byStep: {},
      total: 0,
    });
  });

  it("returns empty when the zip has no trace.trace entry", () => {
    const zip = zipSync({ "other.txt": strToU8("hello") });
    expect(parseTraceActions(zip)).toEqual({ byStep: {}, total: 0 });
  });

  it("retains valid trace actions around unexpected JSON records", () => {
    const result = parseTraceActions(
      makeTraceZip([
        null,
        [],
        5,
        "text",
        { type: "before", class: { unexpected: true }, method: false },
        { type: "before", class: "Frame", method: "goto" },
      ])
    );
    expect(result.total).toBe(1);
    expect(result.byStep["(setup)"]).toEqual([{ apiName: "Frame.goto" }]);
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
  ])("accepts the step name %s without colliding with object properties", (title) => {
    const result = parseTraceActions(
      makeTraceZip([
        { type: "before", class: "Tracing", method: "tracingGroup", title },
        { type: "before", class: "Frame", method: "click" },
      ])
    );
    expect(result.total).toBe(1);
    expect(Object.hasOwn(result.byStep, title)).toBe(true);
    expect(result.byStep[title]).toEqual([{ apiName: "Frame.click" }]);
  });
});
