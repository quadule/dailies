import { requestId } from "dailies-cli-kit";
import { isDaemonRunning, sendRequest } from "dailies-daemon-client";
import { reconcileStaleActiveSessions } from "../session/reconcile.js";
import { readSessionRecord } from "../session/registry.js";
import { renderSessionRecord, renderStatusResult } from "./render.js";

interface StatusArgs {
  json: boolean;
  sessionId?: string;
}

export async function statusCommand(args: StatusArgs): Promise<number> {
  if (args.sessionId) {
    // Reconcile a zombie "active" record (daemon restarted) so status reflects
    // the daemon's live view rather than a stale on-disk "active".
    await reconcileStaleActiveSessions();
    let record: Awaited<ReturnType<typeof readSessionRecord>>;
    try {
      record = await readSessionRecord(args.sessionId);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      renderSessionRecord(record, process.stdout);
    }
    return 0;
  }

  // No --session: report the daemon's own status. Deliberately does NOT start
  // one — asking whether anything is running must not be what starts it (and on
  // a fresh install it failed outright on the missing embedded runtime). Mirrors
  // `daemon stop`, which answers the same way when there is nothing there.
  if (!(await isDaemonRunning())) {
    process.stdout.write(
      args.json
        ? `${JSON.stringify({ running: false })}\n`
        : "Daemon is not running.\n"
    );
    return 0;
  }
  return sendRequest(
    { id: requestId("status"), type: "status" },
    args.json
      ? (data, stdout) =>
          stdout.write(
            `${JSON.stringify({ running: true, ...(data as object) })}\n`
          )
      : renderStatusResult
  );
}
