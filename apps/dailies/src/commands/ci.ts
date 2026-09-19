import { previousMetrics, runDecide } from "../ci/demo-request.js";
import { readComments } from "../ci/inputs.js";
import {
  deserializeMetrics,
  formatMetricLines,
  serializeMetrics,
} from "../session/metrics.js";

// `dailies ci …` — the pieces a CI pipeline needs that are otherwise only
// reachable by importing this repo's TypeScript. The npm package ships a
// bundled binary with no importable modules, so a pipeline in another repo (or
// on another CI system) had to keep a source checkout just to run these two.
// Exposing them as subcommands is what makes the demo workflow copyable.

export interface CiDecideArgs {
  bodyFile?: string;
  changedFile?: string;
  commentsFile?: string;
  cwd?: string;
  force?: boolean;
  headSha?: string;
}

// Emits the decision as one line of JSON — same shape the workflow already
// parses with `jq`.
export async function ciDecide(args: CiDecideArgs): Promise<number> {
  const json = await runDecide(args);
  process.stdout.write(`${json}\n`);
  return 0;
}

export interface CiMetricsArgs {
  current: string;
  prefix: string;
  previous?: string;
}

// Renders the metric lines for a PR comment, each compared against the previous
// demo's value. Same formatter that wrote the marker being compared against, so
// the two can't drift.
export function ciMetrics(args: CiMetricsArgs): number {
  const lines = formatMetricLines(
    deserializeMetrics(args.current),
    deserializeMetrics(args.previous ?? "")
  );
  if (lines.length > 0) {
    process.stdout.write(
      `${lines.map((line) => `${args.prefix}${line}`).join("\n")}\n`
    );
  }
  return 0;
}

export interface CiPreviousMetricsArgs {
  commentsFile?: string;
}

// The metrics carried by the most recent demo comment, serialized for feeding
// straight back in as `--previous`. Fails open: an unreadable or malformed file
// yields nothing rather than failing the pipeline, since a missing baseline
// should cost you a delta, not a demo.
export async function ciPreviousMetrics(
  args: CiPreviousMetricsArgs
): Promise<number> {
  const comments = await readComments(args.commentsFile);
  process.stdout.write(serializeMetrics(previousMetrics(comments)));
  return 0;
}
