import { installDaemonRuntime, isDaemonRunning } from "dailies-daemon-client";
import { stopDaemonIfIdle } from "./daemon-stop.js";

// Install the embedded daemon runtime (Playwright + sandbox) under
// ~/.dailies/. Safe to run repeatedly.
//
// A daemon that was already running keeps serving the bundle it started with,
// and nothing else restarts it — so `npm i -g dailies-cli@latest && dailies
// install` used to extract the new daemon and then go on talking to the old
// one for as long as the machine stayed up. Retire it here, AFTER the install
// (so it is not down for the whole download) and only when idle: a recording
// in progress must not lose its trace/video/HAR to an upgrade.
export async function installCommand(): Promise<number> {
  const code = await installDaemonRuntime();
  if (code !== 0) {
    return code;
  }
  if (await isDaemonRunning()) {
    process.stdout.write(
      "A daemon from the previous install is still running — stopping it if idle so the next command starts the one just installed.\n"
    );
    await stopDaemonIfIdle("", false);
  }
  return 0;
}
