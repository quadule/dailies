import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEndResult } from "dailies-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionRecord,
  readSessionRecord,
  type SessionRecord,
} from "../session/registry.js";
import { sessionEnd } from "./session-end.js";

const fixture = vi.hoisted(() => ({ dir: "", sendRequest: vi.fn() }));
vi.mock("dailies-daemon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dailies-daemon-client")>()),
  sendRequest: fixture.sendRequest,
  sessionDir: () => fixture.dir,
  sessionManifestPath: () => `${fixture.dir}/manifest.json`,
  sessionRecordPath: () => `${fixture.dir}/session.json`,
  sessionReportPath: () => `${fixture.dir}/report.html`,
  sessionResultsPath: () => `${fixture.dir}/results.json`,
}));

let output: string;

beforeEach(async () => {
  fixture.dir = await mkdtemp(path.join(tmpdir(), "dailies-end-lifecycle-"));
  fixture.sendRequest.mockReset();
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture.dir, { force: true, recursive: true });
});

function record(status: SessionRecord["status"]): SessionRecord {
  return {
    artifactsDir: fixture.dir,
    browser: "__session__s",
    capture: { console: true, har: true, trace: true, video: true },
    createdAt: "2026-06-02T10:00:00.000Z",
    endedAt: status === "active" ? undefined : "2026-06-02T10:00:05.000Z",
    headless: true,
    id: "s",
    schemaVersion: 1,
    status,
    steps: [],
  };
}

describe("sessionEnd lifecycle", () => {
  it.each(["ended", "aborted"] as const)(
    "re-finalizes an %s session from current artifacts without contacting the daemon",
    async (status) => {
      await createSessionRecord(record(status));
      await mkdir(path.join(fixture.dir, "video"));
      const video = path.join(fixture.dir, "video", "page.webm");
      const attachment = path.join(fixture.dir, "new-attachment.txt");
      await Promise.all([
        writeFile(video, "recording"),
        writeFile(attachment, "new evidence"),
        writeFile(
          path.join(fixture.dir, "manifest.json"),
          JSON.stringify({
            artifacts: [{ kind: "video", path: video, pageName: "main" }],
            stepPages: [{ step: "open", page: "main" }],
          })
        ),
        writeFile(
          path.join(fixture.dir, "network.har"),
          JSON.stringify({
            log: {
              entries: [
                {
                  request: {
                    headers: [{ name: "Authorization", value: "secret" }],
                  },
                },
              ],
            },
          })
        ),
      ]);

      expect(
        await sessionEnd("s", true, {
          attach: [attachment],
          condense: false,
        })
      ).toBe(0);

      expect(fixture.sendRequest).not.toHaveBeenCalled();
      const result = JSON.parse(output) as {
        artifacts: SessionEndResult["artifacts"];
        status: string;
      };
      expect(result.status).toBe(status === "ended" ? "passed" : "aborted");
      expect(result.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "video",
            pageName: "main",
            path: video,
          }),
          expect.objectContaining({ kind: "attachment", bytes: 12 }),
        ])
      );
      const har = await readFile(path.join(fixture.dir, "network.har"), "utf8");
      expect(har).toContain("[scrubbed]");
      expect(har).not.toContain("secret");
      expect(
        await readFile(path.join(fixture.dir, "report.html"), "utf8")
      ).toContain("new-attachment.txt");
      expect((await readSessionRecord("s")).status).toBe(status);
    }
  );

  it("still asks the daemon to finish an active session", async () => {
    await createSessionRecord(record("active"));
    fixture.sendRequest.mockImplementation(
      (_request: unknown, receive: (result: SessionEndResult) => void) => {
        receive({
          artifacts: [],
          manifestPath: path.join(fixture.dir, "manifest.json"),
          session: {
            artifactsDir: fixture.dir,
            browser: "__session__s",
            capture: record("active").capture,
            endedAt: Date.parse("2026-06-02T10:00:05.000Z"),
            headless: true,
            pageCount: 1,
            phase: "ended",
            runCount: 0,
            sessionId: "s",
            startedAt: Date.parse("2026-06-02T10:00:00.000Z"),
          },
        });
        return Promise.resolve(0);
      }
    );
    expect(await sessionEnd("s", true, { condense: false })).toBe(0);
    expect(fixture.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-end", sessionId: "s" }),
      expect.any(Function)
    );
    expect((await readSessionRecord("s")).status).toBe("ended");
  });

  it("keeps a failed live finalization nonzero while recovering its report", async () => {
    await createSessionRecord(record("active"));
    fixture.sendRequest.mockResolvedValue(1);
    expect(await sessionEnd("s", true, { condense: false })).toBe(1);
    expect(fixture.sendRequest).toHaveBeenCalledTimes(1);
    expect(
      await readFile(path.join(fixture.dir, "report.html"), "utf8")
    ).toContain("Dailies report");
  });
});
