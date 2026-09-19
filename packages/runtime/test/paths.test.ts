import { homedir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browsersDir,
  currentUserSegment,
  daemonBundlePath,
  daemonEndpoint,
  daemonPidPath,
  daemonPipeName,
  daemonSocketPath,
  daemonStderrLogPath,
  dailiesDir,
  packageJsonPath,
  requiresDaemonEndpointCleanup,
  sandboxClientPath,
  sessionDir,
  sessionManifestPath,
  sessionRecordPath,
  sessionReportPath,
  sessionResultsPath,
  sessionsRootDir,
  tmpDir,
} from "../src/paths.js";

afterEach(() => vi.unstubAllEnvs());

describe("shared runtime paths", () => {
  it("uses the same home directory for the daemon and session artifacts", () => {
    const directory = join(homedir(), "isolated-home");
    const base = join(directory, ".dailies");
    expect(dailiesDir(directory)).toBe(base);
    expect(browsersDir(directory)).toBe(join(base, "browsers"));
    expect(tmpDir(directory)).toBe(join(base, "tmp"));
    expect(daemonSocketPath(directory)).toBe(join(base, "daemon.sock"));
    expect(daemonPidPath(directory)).toBe(join(base, "daemon.pid"));
    expect(daemonStderrLogPath(directory)).toBe(
      join(base, "daemon.stderr.log")
    );
    expect(daemonBundlePath(directory)).toBe(join(base, "daemon.mjs"));
    expect(sandboxClientPath(directory)).toBe(join(base, "sandbox-client.js"));
    expect(packageJsonPath(directory)).toBe(join(base, "package.json"));
    expect(sessionsRootDir(directory)).toBe(join(base, "sessions"));
    const session = join(base, "sessions", "demo-1");
    expect(sessionDir("demo-1", directory)).toBe(session);
    expect(sessionRecordPath("demo-1", directory)).toBe(
      join(session, "session.json")
    );
    expect(sessionManifestPath("demo-1", directory)).toBe(
      join(session, "manifest.json")
    );
    expect(sessionResultsPath("demo-1", directory)).toBe(
      join(session, "results.json")
    );
    expect(sessionReportPath("demo-1", directory)).toBe(
      join(session, "report.html")
    );
  });

  it.each([
    "linux",
    "darwin",
  ] as const)("uses a filesystem socket on %s", (platform) => {
    const directory = join(homedir(), "isolated-home");
    expect(daemonEndpoint({ homedir: directory, platform })).toBe(
      daemonSocketPath(directory)
    );
    expect(requiresDaemonEndpointCleanup(platform)).toBe(true);
  });

  it("uses an explicit user-scoped Windows pipe without a filesystem socket", () => {
    expect(daemonEndpoint({ platform: "win32", username: "Tester Name" })).toBe(
      "\\\\.\\pipe\\dailies-daemon-tester-name"
    );
    expect(requiresDaemonEndpointCleanup("win32")).toBe(false);
  });

  it.each([
    [" Alice ", "Bob", "Alice"],
    [" \t ", " Bob ", "Bob"],
    [undefined, "Bob", "Bob"],
    ["", undefined, "home-user"],
    [undefined, undefined, "home-user"],
  ])("resolves USERNAME=%j and USER=%j identically for both pipe callers", (username, user, expected) => {
    vi.stubEnv("USERNAME", username);
    vi.stubEnv("USER", user);
    const directory = join(homedir(), "home-user");
    expect(currentUserSegment(directory)).toBe(expected);
    expect(daemonEndpoint({ platform: "win32", homedir: directory })).toBe(
      `\\\\.\\pipe\\${daemonPipeName(expected)}`
    );
  });

  it("uses a stable fallback when no user or home basename is available", () => {
    vi.stubEnv("USERNAME", undefined);
    vi.stubEnv("USER", undefined);
    for (const directory of ["", ".", parse(homedir()).root]) {
      expect(currentUserSegment(directory)).toBe("user");
    }
  });
});
