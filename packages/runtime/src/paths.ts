import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

export function home(): string {
  const dir = homedir();
  if (!dir) {
    throw new Error("Could not determine home directory");
  }
  return dir;
}

export function dailiesDir(homeDir = home()): string {
  return join(homeDir, ".dailies");
}

export function daemonSocketPath(homeDir = home()): string {
  return join(dailiesDir(homeDir), "daemon.sock");
}

export function daemonPidPath(homeDir = home()): string {
  return join(dailiesDir(homeDir), "daemon.pid");
}

// Import-time startup failures happen before the daemon can open its pino log.
export function daemonStderrLogPath(homeDir = home()): string {
  return join(dailiesDir(homeDir), "daemon.stderr.log");
}

export function daemonBundlePath(homeDir = home()): string {
  return join(dailiesDir(homeDir), "daemon.mjs");
}

export function sandboxClientPath(homeDir = home()): string {
  return join(dailiesDir(homeDir), "sandbox-client.js");
}

export function packageJsonPath(homeDir = home()): string {
  return join(dailiesDir(homeDir), "package.json");
}

export function tmpDir(homeDir = home()): string {
  return join(dailiesDir(homeDir), "tmp");
}

export function browsersDir(homeDir = home()): string {
  return join(dailiesDir(homeDir), "browsers");
}

// The client and daemon must derive the exact same pipe name, including when
// environment variables are blank or absent. Resolve this once for both sides.
export function sanitizePipeSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return sanitized === "" ? "user" : sanitized;
}

export function currentUserSegment(homeDir?: string): string {
  for (const value of [process.env.USERNAME, process.env.USER]) {
    const username = value?.trim();
    if (username) {
      return username;
    }
  }
  try {
    const directory = homeDir ?? homedir();
    if (directory) {
      const username = basename(directory);
      if (username && username !== "." && username !== sep) {
        return username;
      }
    }
  } catch {
    // Fall back when the operating system cannot resolve a home directory.
  }
  return "user";
}

export function daemonPipeName(username = currentUserSegment()): string {
  return `dailies-daemon-${sanitizePipeSegment(username)}`;
}

// Node's net module accepts both Unix sockets and Windows named pipes.
export function daemonEndpoint(
  options: {
    homedir?: string;
    platform?: NodeJS.Platform;
    username?: string;
  } = {}
): string {
  if ((options.platform ?? process.platform) === "win32") {
    const username = options.username ?? currentUserSegment(options.homedir);
    return `\\\\.\\pipe\\${daemonPipeName(username)}`;
  }
  return daemonSocketPath(options.homedir);
}

export function requiresDaemonEndpointCleanup(
  platform = process.platform
): boolean {
  return platform !== "win32";
}

// Session artifact layout, shared by the recording daemon and CLI reports.
export function sessionsRootDir(homeDir = home()): string {
  return join(dailiesDir(homeDir), "sessions");
}

export function sessionDir(sessionId: string, homeDir = home()): string {
  return join(sessionsRootDir(homeDir), sessionId);
}

export function sessionRecordPath(sessionId: string, homeDir = home()): string {
  return join(sessionDir(sessionId, homeDir), "session.json");
}

export function sessionManifestPath(
  sessionId: string,
  homeDir = home()
): string {
  return join(sessionDir(sessionId, homeDir), "manifest.json");
}

export function sessionResultsPath(
  sessionId: string,
  homeDir = home()
): string {
  return join(sessionDir(sessionId, homeDir), "results.json");
}

export function sessionReportPath(sessionId: string, homeDir = home()): string {
  return join(sessionDir(sessionId, homeDir), "report.html");
}
