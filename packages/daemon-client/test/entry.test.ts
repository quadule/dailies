import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDaemonCommand } from "../src/daemon/entry.js";

let tempDir: string;
const originalOverride = process.env.DAILIES_DAEMON;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cli-ts-entry-"));
});

afterEach(async () => {
  if (originalOverride === undefined) {
    delete process.env.DAILIES_DAEMON;
  } else {
    process.env.DAILIES_DAEMON = originalOverride;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("findDaemonCommand", () => {
  it("runs the daemon on the Node running the CLI, not a bare PATH lookup", async () => {
    // A machine with nvm/volta/asdf routinely has several Nodes, and the
    // detached daemon gets a different PATH than the shell the CLI ran in —
    // "node" there can be an older major, or absent.
    const entry = join(tempDir, "daemon.mjs");
    await writeFile(entry, "");
    process.env.DAILIES_DAEMON = entry;

    const command = await findDaemonCommand();

    expect(command.program).toBe(process.execPath);
    expect(command.args).toEqual([await realpath(entry)]);
  });
});
