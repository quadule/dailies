import { spawn } from "node:child_process";

// Open a file/URL in the OS default app, detached and best-effort: opening a
// report or the editor is a convenience, so a missing opener or a headless host
// must never fail the command that asked for it.
export function openInOSDefault(target: string): void {
  let command = "xdg-open";
  let args = [target];
  if (process.platform === "darwin") {
    command = "open";
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", target];
  }
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // no opener on this host — ignore
    });
    child.unref();
  } catch {
    // ignore — best effort
  }
}
