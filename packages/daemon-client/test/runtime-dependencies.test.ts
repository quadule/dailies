import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_RUNTIME_DEPENDENCIES,
  EMBEDDED_PACKAGE_JSON,
} from "dailies-protocol";
import { minVersion } from "semver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embeddedRuntimeInstalled } from "../src/daemon/extract.js";

let dir: string;
const manifestPath = (pkg: string) =>
  join(dir, "node_modules", pkg, "package.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dailies-runtime-deps-"));
  await Promise.all(
    Object.entries(DAEMON_RUNTIME_DEPENDENCIES).map(async ([pkg, range]) => {
      await mkdir(join(dir, "node_modules", pkg), { recursive: true });
      await writeFile(
        manifestPath(pkg),
        JSON.stringify({ version: minVersion(range)!.version })
      );
    })
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("embedded runtime compatibility", () => {
  it("keeps the shipped dependency specifications aligned with the daemon workspace", async () => {
    const workspace = JSON.parse(
      await readFile(
        new URL("../../../apps/dailies-daemon/package.json", import.meta.url),
        "utf8"
      )
    );
    const embedded = JSON.parse(EMBEDDED_PACKAGE_JSON);
    expect(embedded.dependencies).toEqual(DAEMON_RUNTIME_DEPENDENCIES);
    for (const [pkg, range] of Object.entries(embedded.dependencies)) {
      expect(workspace.dependencies[pkg]).toBe(range);
    }
  });

  it("accepts the current runtime and compatible ranged dependency updates", async () => {
    expect(await embeddedRuntimeInstalled(dir)).toBe(true);
    await writeFile(
      manifestPath("pino"),
      JSON.stringify({ version: "10.99.0" })
    );
    expect(await embeddedRuntimeInstalled(dir)).toBe(true);
  });

  it.each(["playwright", "playwright-core"])(
    "rejects previously installed %s before daemon startup",
    async (pkg) => {
      await writeFile(manifestPath(pkg), JSON.stringify({ version: "1.61.1" }));
      expect(await embeddedRuntimeInstalled(dir)).toBe(false);
    }
  );

  it("rejects a missing dependency even when the other packages are present", async () => {
    await rm(manifestPath("quickjs-emscripten"));
    expect(await embeddedRuntimeInstalled(dir)).toBe(false);
  });

  it.each([
    "invalid JSON",
    "null",
    "{}",
    '{"version":42}',
    '{"version":"broken"}',
    '{"version":"9.14.0"}',
  ])("rejects invalid or incompatible installed metadata: %s", async (text) => {
    await writeFile(manifestPath("pino"), text);
    expect(await embeddedRuntimeInstalled(dir)).toBe(false);
  });
});
