import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTo, getJson, listModelIds, userAgent } from "./http.js";

const ORIGINAL = process.env.DAILIES_CLI_VERSION;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("media HTTP transport", () => {
  const options = { service: "archive.org", timeoutMs: 15_000 };

  it("identifies stock requests and uses the caller's timeout", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ files: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getJson("https://example.test/meta", options)
    ).resolves.toEqual({ files: [] });
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/meta", {
      headers: { "user-agent": userAgent() },
      signal,
    });
  });

  it("keeps service and operation in HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(null, { status: 503 }))
        )
    );
    await expect(getJson("https://example.test/meta", options)).rejects.toThrow(
      "archive.org GET 503"
    );
    await expect(
      downloadTo("https://example.test/art", "unused", {
        service: "Wikimedia",
        timeoutMs: 60_000,
      })
    ).rejects.toThrow("Wikimedia download 503");
  });

  it("writes exact downloaded bytes and leaves the destination intact on an empty response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dailies-http-"));
    const out = join(dir, "media.bin");
    const bytes = Buffer.from([0, 255, 7, 128]);
    try {
      await writeFile(out, "previous");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null))
        .mockResolvedValueOnce(new Response(bytes));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        downloadTo("https://example.test/empty", out, options)
      ).rejects.toThrow("archive.org returned 0 bytes");
      expect(await readFile(out, "utf8")).toBe("previous");
      await downloadTo("https://example.test/audio", out, options);
      expect(await readFile(out)).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("propagates JSON and transport failures to the provider", async () => {
    const error = new Error("timed out");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("invalid JSON"))
        .mockRejectedValueOnce(error)
    );
    await expect(
      getJson("https://example.test/meta", options)
    ).rejects.toBeInstanceOf(SyntaxError);
    await expect(getJson("https://example.test/meta", options)).rejects.toBe(
      error
    );
  });
});

describe("model availability probes", () => {
  it.each<Record<string, string>>([
    {},
    { Authorization: "Bearer private-key" },
  ])("preserves explicit auth headers %j", async (headers) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: [{ id: "tts" }, { id: 3 }, {}, { id: "music" }] })
      );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listModelIds("http://localhost:8000", { headers, timeoutMs: 4000 })
    ).resolves.toEqual(["tts", "music"]);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8000/v1/models", {
      headers,
      signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(4000);
  });

  it.each([{}, { data: null }, { data: [] }])(
    "distinguishes a reachable empty server %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(
        listModelIds("http://local", { headers: {}, timeoutMs: 4000 })
      ).resolves.toEqual([]);
    }
  );

  it.each([null, { data: {} }, { data: [null] }])(
    "declines malformed model lists %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(
        listModelIds("http://local", { headers: {}, timeoutMs: 4000 })
      ).resolves.toBeNull();
    }
  );

  it("declines HTTP, parse and connection failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response("invalid JSON"))
        .mockRejectedValueOnce(new Error("offline"))
    );
    for (let i = 0; i < 3; i++) {
      await expect(
        listModelIds("http://local", { headers: {}, timeoutMs: 4000 })
      ).resolves.toBeNull();
    }
  });
});
