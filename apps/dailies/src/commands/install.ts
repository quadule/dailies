import { installDaemonRuntime } from "dailies-daemon-client";

// Install the embedded daemon runtime (Playwright + sandbox) under
// ~/.dailies/. Safe to run repeatedly.
export function installCommand(): Promise<number> {
  return installDaemonRuntime();
}
