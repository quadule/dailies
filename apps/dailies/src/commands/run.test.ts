import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionRecord,
  readSessionRecord,
  type SessionRecord,
} from "../session/registry.js";
import { countingStdout, runInSession } from "./run.js";

const fixture = vi.hoisted(() => ({
  dir: "",
  // What the fake daemon prints for the next request.
  print: [] as (string | Uint8Array)[],
}));
vi.mock("dailies-daemon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dailies-daemon-client")>()),
  ensureDaemonRunning: vi.fn(async () => undefined),
  sendRequest: vi.fn(
    async (
      _request: unknown,
      _render: unknown,
      stdout: NodeJS.WritableStream
    ) => {
      for (const chunk of fixture.print) {
        stdout.write(chunk);
      }
      return 0;
    }
  ),
  sessionDir: () => fixture.dir,
  sessionRecordPath: () => `${fixture.dir}/session.json`,
}));

beforeEach(async () => {
  fixture.dir = await mkdtemp(path.join(tmpdir(), "dailies-run-"));
  fixture.print = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture.dir, { force: true, recursive: true });
});

function record(): SessionRecord {
  return {
    artifactsDir: fixture.dir,
    browser: "__session__s",
    capture: {
      console: true,
      full: false,
      har: true,
      trace: true,
      video: true,
    },
    createdAt: "2026-06-02T10:00:00.000Z",
    headless: true,
    id: "s",
    schemaVersion: 1,
    status: "active",
    steps: [],
  };
}

describe("countingStdout", () => {
  it("passes writes through and counts characters, not bytes", () => {
    const seen: unknown[] = [];
    const target = {
      write: (chunk: unknown) => {
        seen.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;
    const out = countingStdout(target);
    out.stream.write("héllo\n");
    out.stream.write(Buffer.from("→ ok"));
    expect(out.chars()).toBe(10);
    expect(seen).toHaveLength(2);
  });
});

describe("runInSession output size", () => {
  it("records each step's stdout size", async () => {
    await createSessionRecord(record());
    fixture.print = ["a".repeat(1200), "\n"];
    await runInSession({
      json: false,
      script: "console.log(1)",
      sessionId: "s",
      step: "open",
    });
    const saved = await readSessionRecord("s");
    expect(saved.steps[0]?.outputChars).toBe(1201);
    expect(saved.peeks).toBeUndefined();
  });

  it("adds peeks to a running total without recording a step", async () => {
    await createSessionRecord(record());
    fixture.print = ["x".repeat(300)];
    await runInSession({
      json: false,
      peek: true,
      script: "console.log(1)",
      sessionId: "s",
    });
    fixture.print = ["y".repeat(50)];
    await runInSession({
      json: false,
      peek: true,
      script: "console.log(2)",
      sessionId: "s",
    });
    const saved = await readSessionRecord("s");
    expect(saved.steps).toEqual([]);
    expect(saved.peeks).toEqual({ count: 2, outputChars: 350 });
  });
});
