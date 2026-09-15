import { requestId } from "dailies-cli-kit";
import { ensureDaemonRunning, sendRequest } from "dailies-daemon-client";
import type {
  CaptureOptions,
  SessionEndRequest,
  SessionStartRequest,
  SessionStartResult,
  Viewport,
} from "dailies-protocol";
import { logger } from "../logger.js";
import { FLOWS_LINE_BUDGET, loadProject } from "../project/config.js";
import {
  createSessionRecord,
  SESSION_SCHEMA_VERSION,
} from "../session/registry.js";
import { generateSessionId } from "../util/session-id.js";

interface SessionStartArgs {
  capture: CaptureOptions;
  cursor: boolean;
  headless: boolean;
  json: boolean;
  name?: string;
  // Optional URL to open + settle at session start, so the recording begins on a
  // loaded page (not the initial about:blank) and the pre-load blank is trimmed.
  url?: string;
  // Raw `--viewport WxH` value; the daemon applies its 1280x720 default when
  // omitted.
  viewport?: string;
}

// Parse a `WxH` viewport spec (e.g. "1280x720"). Throws on anything else so a
// typo fails the command instead of silently recording at the default size.
export function parseViewport(spec: string): Viewport {
  const match = spec.trim().match(/^(\d{1,4})x(\d{1,4})$/i);
  if (!match) {
    throw new Error(
      `Invalid --viewport "${spec}" (expected WIDTHxHEIGHT, e.g. 1280x720)`
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) {
    throw new Error(
      `Invalid --viewport "${spec}" (width and height must be positive)`
    );
  }
  return { width, height };
}

export async function sessionStart(args: SessionStartArgs): Promise<number> {
  const viewport = args.viewport ? parseViewport(args.viewport) : undefined;
  await ensureDaemonRunning();

  const id = generateSessionId(args.name);
  const request: SessionStartRequest = {
    id: requestId("session-start"),
    type: "session-start",
    sessionId: id,
    name: args.name,
    headless: args.headless,
    capture: args.capture,
    viewport,
    cursor: args.cursor,
    url: args.url,
  };

  let result: SessionStartResult | undefined;
  const code = await sendRequest(request, (data) => {
    result = data as SessionStartResult;
  });
  if (code !== 0) {
    return code;
  }
  if (!result) {
    process.stderr.write("Daemon did not return a session\n");
    return 1;
  }

  const { session } = result;
  try {
    await createSessionRecord({
      artifactsDir: session.artifactsDir,
      browser: session.browser,
      capture: session.capture,
      createdAt: new Date(session.startedAt).toISOString(),
      contentStartedAt:
        typeof session.contentStartedAt === "number"
          ? new Date(session.contentStartedAt).toISOString()
          : undefined,
      headless: session.headless,
      id,
      name: args.name,
      schemaVersion: SESSION_SCHEMA_VERSION,
      status: "active",
      steps: [],
    });
  } catch (err) {
    // The daemon already launched the live session, but we couldn't persist the
    // local record (disk full / permissions), so the CLI could never manage it
    // (`session list`/`end`/`abort` all key off the on-disk record). Tell the
    // daemon to tear the orphan down instead of leaking a recording browser
    // until daemon shutdown, then surface the original failure.
    const abort: SessionEndRequest = {
      id: requestId("session-abort"),
      type: "session-end",
      sessionId: id,
      reason: "abort",
    };
    await sendRequest(abort, undefined).catch(() => undefined);
    throw err;
  }

  logger.info(
    { sessionId: id, artifactsDir: session.artifactsDir },
    "session started"
  );

  // Say when the repo carries app knowledge, so it's obvious whether the agent
  // has it — and complain when it has outgrown being read every session. The
  // agent reads the file itself (see the `dailies-session` skill); this is just
  // the visible signal that it's there.
  const project = await loadProject(process.cwd());
  if (project.flowsPath) {
    logger.info(
      { flows: project.flowsPath, lines: project.flowsLines },
      `app knowledge: ${project.flowsPath} (${project.flowsLines} lines)`
    );
    if (project.flowsLines > FLOWS_LINE_BUDGET) {
      logger.warn(
        { budget: FLOWS_LINE_BUDGET, lines: project.flowsLines },
        `${project.flowsPath} is ${project.flowsLines} lines, over the ${FLOWS_LINE_BUDGET}-line budget — it is read in full every session. Prune stale notes, and move generic Dailies/Playwright lessons out of it.`
      );
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  } else {
    process.stdout.write(`${id}\n`);
  }
  return 0;
}
