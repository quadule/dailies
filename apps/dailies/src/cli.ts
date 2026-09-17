import type { Command as CommandType } from "commander";
import * as commander from "commander";
import { isMainModule } from "dailies-cli-kit";
import {
  collectInjectScriptPaths,
  INJECT_SCRIPT_ENV_VAR,
} from "./inject-scripts.js";

const { Command, InvalidArgumentError } = commander as unknown as {
  Command: typeof commander.Command;
  InvalidArgumentError: typeof commander.InvalidArgumentError;
};

import { ciDecide, ciMetrics, ciPreviousMetrics } from "./commands/ci.js";
import { daemonStop } from "./commands/daemon-stop.js";
import { execScript } from "./commands/exec.js";
import {
  CI_LONG_ABOUT,
  CLI_LONG_ABOUT,
  EXEC_LONG_ABOUT,
  EXEC_SCRIPTING_GUIDE,
  INIT_LONG_ABOUT,
  INSTALL_LONG_ABOUT,
  RUN_LONG_ABOUT,
  RUN_SCRIPTING_GUIDE,
  SESSION_END_LONG_ABOUT,
  SESSION_START_LONG_ABOUT,
  STOP_LONG_ABOUT,
  USAGE_GUIDE,
} from "./commands/help-text.js";
import { initCommand } from "./commands/init.js";
import { installCommand } from "./commands/install.js";
import { runInSession } from "./commands/run.js";
import { sessionAbort } from "./commands/session-abort.js";
import { sessionEnd } from "./commands/session-end.js";
import { sessionList } from "./commands/session-list.js";
import { sessionStart } from "./commands/session-start.js";
import { sessionTakeover } from "./commands/session-takeover.js";
import { sessionUrl } from "./commands/session-url.js";
import { statusCommand } from "./commands/status.js";
import { logger } from "./logger.js";

// Injected at build time by scripts/build.mjs (esbuild `define`); falls back to
// a dev sentinel when run unbundled via tsx/vitest.
const VERSION = process.env.DAILIES_CLI_VERSION ?? "0.0.0-dev";

class ExitCodeError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit code ${code}`);
    this.code = code;
  }
}

function isJson(program: CommandType): boolean {
  return program.opts<{ json?: boolean }>().json === true;
}

// "session end", not "end" — the agent has to retype the whole path.
function commandPath(cmd: CommandType): string {
  const parts: string[] = [];
  for (
    let c: CommandType | null = cmd;
    c?.parent;
    c = c.parent as CommandType | null
  ) {
    parts.unshift(c.name());
  }
  return parts.join(" ");
}

// Walk the leading non-flag tokens down the command tree to find the command
// the user actually invoked. Stops at the first token that isn't a subcommand,
// so a positional argument (`session end <id>`) ends the walk rather than
// derailing it.
function resolveCommand(
  program: CommandType,
  args: readonly string[]
): CommandType {
  let cmd = program;
  for (const token of args) {
    if (token.startsWith("-")) {
      break;
    }
    const sub = (cmd.commands as CommandType[]).find(
      (c) => c.name() === token || c.aliases().includes(token)
    );
    if (!sub) {
      break;
    }
    cmd = sub;
  }
  return cmd;
}

// An unknown flag is a two-turn correction by default: commander names the bad
// flag, the agent runs `--help` to find the right one, and that help runs to
// ~150 lines on `session end`. Fold the answer into the error so it corrects in
// one turn. Flag names only — the full help is still there for the prose.
function unknownFlagHelp(program: CommandType, cmd: CommandType): string {
  const own = cmd.options.map((o) => o.flags.split(/[ ,]/)[0]);
  // Root options parse in any position, so they're valid on every command —
  // read them off the program rather than hardcoding a list that goes stale.
  const globals =
    cmd === program ? [] : program.options.map((o) => o.flags.split(/[ ,]/)[0]);
  const path = commandPath(cmd) || cmd.name();
  const globalNote =
    globals.length > 0
      ? ` (${[...globals, "--help"].join(", ")} valid on any command)`
      : "";
  return `help: valid flags for \`${path}\`: ${own.join(", ") || "(none)"}${globalNote}\n`;
}

// Map the --pass / --fail[reason] flags to a run verdict, or undefined when the
// agent declared neither (then the report falls back to the per-step tally).
// commander gives `fail` as `true` (bare --fail) or the reason string.
function resolveVerdict(
  opts: SessionEndOpts
): { status: "pass" | "fail"; reason?: string } | undefined {
  if (opts.pass === true) {
    return { status: "pass" };
  }
  if (opts.fail !== undefined) {
    return {
      status: "fail",
      reason: typeof opts.fail === "string" ? opts.fail : undefined,
    };
  }
  return;
}

function parseTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value || parsed < 1) {
    throw new InvalidArgumentError(
      `invalid value '${value}' for '--timeout <SECONDS>': must be at least 1`
    );
  }
  return parsed;
}

function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

async function readScriptFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface SessionStartOpts {
  cinematic?: boolean;
  console: boolean;
  cursor: boolean;
  har: boolean;
  headless?: boolean;
  name?: string;
  projectUrl?: string;
  trace: boolean;
  url?: string;
  video: boolean;
  viewport?: string;
}

interface RunOpts {
  session: string;
  step?: string;
  timeout?: number;
}

interface SessionEndOpts {
  attach?: string[];
  captions?: boolean;
  cinematic?: boolean;
  condense?: boolean;
  fail?: boolean | string;
  metric?: string[];
  open?: boolean;
  pass?: boolean;
  prompt?: string;
  scrubHar?: boolean;
  song?: boolean;
  stopDaemon?: boolean;
}

interface CiDecideOpts {
  bodyFile?: string;
  changedFile?: string;
  commentsFile?: string;
  cwd?: string;
  force?: boolean;
  headSha?: string;
}

interface CiMetricsOpts {
  current: string;
  prefix?: string;
  previous?: string;
}

interface ExecOpts {
  browser: string;
  connect?: string;
  headless?: boolean;
  ignoreHttpsErrors?: boolean;
  injectScript?: string[];
  timeout?: number;
}

interface TakeoverOpts {
  cancel?: boolean;
  step?: string;
  stop?: boolean;
}

export function buildProgram(): CommandType {
  const program = new Command();
  program
    .name("dailies")
    .description(CLI_LONG_ABOUT)
    .version(VERSION, "-V, --version", "Output the version number")
    .exitOverride()
    .showHelpAfterError(false)
    .allowExcessArguments(false)
    .addHelpText("after", `\n${USAGE_GUIDE}`);

  program
    .option("-v, --verbose", "Enable verbose diagnostic logging on stderr")
    .option("--json", "Emit machine-readable JSON on stdout and stderr");

  const session = program
    .command("session")
    .description("Manage capture-enabled browser sessions");

  session
    .command("start")
    .description("Start a session and begin recording artifacts")
    .addHelpText("before", `${SESSION_START_LONG_ABOUT}\n`)
    .option("--name <NAME>", "Human-readable session name")
    .option("--headless", "Launch the session browser without a visible window")
    .option("--no-trace", "Disable Playwright trace capture")
    .option("--no-video", "Disable video recording")
    .option("--no-har", "Disable network HAR capture")
    .option("--no-console", "Disable console / page-error capture")
    .option(
      "--viewport <WxH>",
      "Page viewport for the recording, e.g. 1440x900 (default 1280x720)"
    )
    .option(
      "--no-cursor",
      "Disable the virtual cursor / click animation overlay in recordings"
    )
    .option(
      "--url <url>",
      "Open (and settle) this URL at session start so the recording begins on a loaded page, not a blank one — the pre-load blank is trimmed from the video head"
    )
    .option(
      "--project-url <url>",
      "Fetch .dailies/ (the app's own browser guidance) from a non-production environment that serves it, when you have no checkout — e.g. staging or a review app. Ignored when a .dailies/ directory is found locally. Also $DAILIES_PROJECT_URL"
    )
    .action(async (opts: SessionStartOpts) => {
      const code = await sessionStart({
        name: opts.name,
        projectUrl: opts.projectUrl,
        headless: opts.headless === true,
        capture: {
          trace: opts.trace,
          video: opts.video,
          har: opts.har,
          console: opts.console,
        },
        viewport: opts.viewport,
        cursor: opts.cursor,
        url: opts.url,
        json: isJson(program),
      });
      throw new ExitCodeError(code);
    });

  session
    .command("end")
    .description("Stop recording, collect artifacts, and render the report")
    .addHelpText("before", `${SESSION_END_LONG_ABOUT}\n`)
    .argument("<id>", "Session id")
    .option(
      "--stop-daemon",
      "After ending, stop the daemon if no other sessions/browsers remain"
    )
    .option(
      "--no-condense",
      "Keep raw videos (skip trimming pre-load frames and long stills)"
    )
    .option(
      "--attach <file>",
      "Copy a file into the session's attachments/ so it appears in the report (repeatable) — e.g. a coverage report",
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option(
      "--metric <name=value>",
      "Record a named number for this run, e.g. coverage=42.5 (repeatable) — persisted in results.json and echoed by --json, for comparing runs over time",
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option(
      "--no-scrub-har",
      "Keep credential header values (Cookie/Authorization) in network.har instead of replacing them"
    )
    .option(
      "--cinematic",
      "Add LLM narration, a macOS voice-over, captions, and a title card (macOS only; needs `claude` and `say`)"
    )
    .option(
      "--song",
      "Score the whole video with ONE sung song (LLM-written themed lyrics performed by a local/AI music model) instead of spoken narration; needs ACE-Step or GEMINI_API_KEY (a flavor of --cinematic)"
    )
    .option(
      "--prompt <text>",
      'Steer the cinematic narration (or, with --song, the song) — theme, tone, and style — in your own words, e.g. "1970s heist film, narrated as a limerick" (implies --cinematic)'
    )
    .option("--no-captions", "With --cinematic, skip burning in subtitles")
    .option("--open", "Open the rendered report.html in your default browser")
    .option(
      "--pass",
      "Mark the run PASSED regardless of individual step exit codes — the agent judged the workflow succeeded (a failed step it recovered from won't fail the run)"
    )
    .option(
      "--fail [reason]",
      "Mark the run FAILED with an optional reason — the workflow did not meet its success criteria (overrides the per-step tally)"
    )
    .action(async (id: string, opts: SessionEndOpts) => {
      if (opts.pass === true && opts.fail !== undefined) {
        process.stderr.write("Pass --pass or --fail, not both.\n");
        throw new ExitCodeError(2);
      }
      const code = await sessionEnd(id, isJson(program), {
        stopDaemon: opts.stopDaemon === true,
        attach: opts.attach,
        condense: opts.condense,
        metric: opts.metric,
        scrubHar: opts.scrubHar,
        cinematic: opts.cinematic === true || typeof opts.prompt === "string",
        song: opts.song === true,
        prompt: opts.prompt,
        captions: opts.captions,
        open: opts.open === true,
        verdict: resolveVerdict(opts),
      });
      throw new ExitCodeError(code);
    });

  session
    .command("abort")
    .description("Best-effort teardown of a session (artifacts may be partial)")
    .argument("<id>", "Session id")
    .option(
      "--stop-daemon",
      "After aborting, stop the daemon if no other sessions/browsers remain"
    )
    .action(async (id: string, opts: SessionEndOpts) => {
      const code = await sessionAbort(id, isJson(program), {
        stopDaemon: opts.stopDaemon === true,
      });
      throw new ExitCodeError(code);
    });

  session
    .command("list")
    .description("List recorded sessions")
    .action(async () => {
      const code = await sessionList(isJson(program));
      throw new ExitCodeError(code);
    });

  session
    .command("url")
    .description(
      "Print a session's current page URL (read-only; records nothing) — use it between steps to check where you landed"
    )
    .argument("<id>", "Session id")
    .action(async (id: string) => {
      const code = await sessionUrl(id, isJson(program));
      throw new ExitCodeError(code);
    });

  session
    .command("takeover")
    .description(
      "Hand the live headed browser to a human and record their actions as a step"
    )
    .argument("<id>", "Session id")
    .option("--step <name>", "Step label for the captured actions")
    .option("--stop", "Stop the active takeover and record the captured step")
    .option("--cancel", "Stop the active takeover and discard the capture")
    .action(async (id: string, opts: TakeoverOpts) => {
      const code = await sessionTakeover(id, isJson(program), {
        step: opts.step,
        stop: opts.stop === true,
        cancel: opts.cancel === true,
      });
      throw new ExitCodeError(code);
    });

  program
    .command("run")
    .description(
      "Run a script as a recorded step inside a session (see `exec` for a one-off)"
    )
    .addHelpText("before", `${RUN_LONG_ABOUT}\n`)
    .addHelpText("after", `\n${RUN_SCRIPTING_GUIDE}`)
    .argument("[FILE]", "Path to a JavaScript file (reads stdin if omitted)")
    .requiredOption("--session <id>", "Target session id")
    .option("--step <name>", "Step label (defaults to step-N)")
    .option(
      "--timeout <SECONDS>",
      "Maximum script execution time in seconds",
      parseTimeout
    )
    .action(async (file: string | undefined, opts: RunOpts) => {
      let script: string | undefined;
      if (!file) {
        if (stdinIsTty()) {
          program.outputHelp();
          throw new ExitCodeError(2);
        }
        script = await readScriptFromStdin();
      }
      const code = await runInSession({
        sessionId: opts.session,
        step: opts.step,
        file,
        script,
        timeoutMs: opts.timeout === undefined ? undefined : opts.timeout * 1000,
        json: isJson(program),
      });
      throw new ExitCodeError(code);
    });

  program
    .command("exec")
    .description("Run a script once, unrecorded and outside any session")
    .addHelpText("before", `${EXEC_LONG_ABOUT}\n`)
    .addHelpText("after", `\n${EXEC_SCRIPTING_GUIDE}`)
    .argument("[FILE]", "Path to a JavaScript file (reads stdin if omitted)")
    .option(
      "--browser <NAME>",
      "Use a named daemon-managed browser instance",
      "default"
    )
    .addOption(
      new commander.Option(
        "--connect [URL]",
        "Connect to a running Chrome instance"
      )
    )
    .option(
      "--headless",
      "Launch daemon-managed Chromium without a visible window"
    )
    .option(
      "--ignore-https-errors",
      "Ignore HTTPS certificate errors for daemon-managed Chromium"
    )
    .option(
      "--inject-script <PATH>",
      "Pre-load a JavaScript file on every page in the browser context (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[]
    )
    .option(
      "--timeout <SECONDS>",
      "Maximum script execution time in seconds",
      parseTimeout,
      30
    )
    .action(async (file: string | undefined, opts: ExecOpts) => {
      let script: string | undefined;
      if (!file) {
        if (stdinIsTty()) {
          program.outputHelp();
          throw new ExitCodeError(2);
        }
        script = await readScriptFromStdin();
      }
      const code = await execScript({
        browser: opts.browser,
        connect: opts.connect,
        file,
        headless: opts.headless === true,
        ignoreHttpsErrors: opts.ignoreHttpsErrors === true,
        injectScriptPaths: collectInjectScriptPaths(
          process.env[INJECT_SCRIPT_ENV_VAR],
          opts.injectScript ?? []
        ),
        json: isJson(program),
        script,
        timeoutMs: (opts.timeout ?? 30) * 1000,
      });
      throw new ExitCodeError(code);
    });

  const ci = program
    .command("ci")
    .description(
      "Pieces a CI pipeline needs (decide whether to demo, render metrics)"
    )
    .addHelpText("before", `${CI_LONG_ABOUT}\n`);

  ci.command("decide")
    .description("Decide whether a PR should be demoed, as one line of JSON")
    .option("--cwd <PATH>", "Repo root to read .dailies/config.json from")
    .option("--body-file <PATH>", "File holding the PR description")
    .option(
      "--changed-file <PATH>",
      "File holding the changed paths, one per line"
    )
    .option(
      "--comments-file <PATH>",
      "JSON array of existing PR comment bodies"
    )
    .option("--head-sha <SHA>", "The commit being considered")
    .option(
      "--force",
      "Demo this commit even if a demo comment already names it. Skips ONLY the freshness check — always keep passing --comments-file, which also carries the deploy target and the last run's metrics"
    )
    .action(async (opts: CiDecideOpts) => {
      const code = await ciDecide({
        bodyFile: opts.bodyFile,
        changedFile: opts.changedFile,
        commentsFile: opts.commentsFile,
        cwd: opts.cwd,
        force: opts.force,
        headSha: opts.headSha,
      });
      throw new ExitCodeError(code);
    });

  ci.command("metrics")
    .description(
      "Render metric lines for a PR comment, compared against the last demo"
    )
    .requiredOption("--current <TEXT>", 'This run\'s metrics ("name=value …")')
    .option("--previous <TEXT>", "The last demo's metrics, for deltas")
    .option(
      "--prefix <TEXT>",
      'Prefix each line (e.g. "- " for a markdown list)',
      ""
    )
    .action((opts: CiMetricsOpts) => {
      const code = ciMetrics({
        current: opts.current,
        previous: opts.previous,
        prefix: opts.prefix ?? "",
      });
      throw new ExitCodeError(code);
    });

  ci.command("previous-metrics")
    .description("The metrics from the last demo comment, for --previous")
    .option(
      "--comments-file <PATH>",
      "JSON array of existing PR comment bodies"
    )
    .action(async (opts: { commentsFile?: string }) => {
      const code = await ciPreviousMetrics({ commentsFile: opts.commentsFile });
      throw new ExitCodeError(code);
    });

  program
    .command("status")
    .description("Show session status (or daemon status without --session)")
    .option("--session <id>", "Session id")
    .action(async (opts: { session?: string }) => {
      const code = await statusCommand({
        sessionId: opts.session,
        json: isJson(program),
      });
      throw new ExitCodeError(code);
    });

  program
    .command("install")
    .description("Install the embedded daemon runtime (Playwright + sandbox)")
    .addHelpText("before", `${INSTALL_LONG_ABOUT}\n`)
    .action(async () => {
      const code = await installCommand();
      throw new ExitCodeError(code);
    });

  program
    .command("init")
    .description("Set up dailies: install the runtime, then print next steps")
    .addHelpText("before", `${INIT_LONG_ABOUT}\n`)
    .action(async () => {
      const code = await initCommand();
      throw new ExitCodeError(code);
    });

  program
    .command("stop")
    .description(
      "Stop the daemon and everything it's running in the background"
    )
    .addHelpText("before", `${STOP_LONG_ABOUT}\n`)
    .action(async () => {
      const code = await daemonStop(isJson(program));
      throw new ExitCodeError(code);
    });

  const daemon = program
    .command("daemon")
    .description("Manage the shared daemon process");

  daemon
    .command("stop")
    .description("Stop the running daemon")
    .action(async () => {
      const code = await daemonStop(isJson(program));
      throw new ExitCodeError(code);
    });

  return program;
}

// Map a thrown CommanderError to an exit code, or undefined when the error
// isn't commander's to explain. Commander has already written its own message
// to stderr by the time it throws; this only adds what that message lacks.
function exitCodeForCommanderError(
  err: unknown,
  program: CommandType,
  argv: readonly string[]
): number | undefined {
  if (!(err && typeof err === "object" && "code" in err)) {
    return;
  }
  const code = (err as { code?: string }).code;
  if (typeof code !== "string" || !code.startsWith("commander.")) {
    return;
  }
  if (
    code === "commander.helpDisplayed" ||
    code === "commander.help" ||
    code === "commander.version"
  ) {
    return 0;
  }
  if (code === "commander.unknownOption") {
    // Commander named the bad flag; add the valid set so the agent doesn't
    // need a second call to find the right one.
    process.stderr.write(
      unknownFlagHelp(program, resolveCommand(program, argv.slice(2)))
    );
  }
  return 2;
}

export async function execute(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[], { from: "node" });
    return 0;
  } catch (err) {
    if (err instanceof ExitCodeError) {
      return err.code;
    }
    const commanderCode = exitCodeForCommanderError(err, program, argv);
    if (commanderCode !== undefined) {
      return commanderCode;
    }
    logger.debug({ err }, "command failed");
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

// True only when this module is the process entry point (see isMainModule).
const isMain = isMainModule(import.meta.url);

if (isMain) {
  execute(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  );
}
