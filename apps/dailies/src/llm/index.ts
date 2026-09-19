// Resolving a text provider, and generating schema-shaped JSON through it.
//
// Selection:
//   $DAILIES_LLM=claude|openai|apple   pins ONE provider. No fallthrough — if
//                                      you asked for a specific backend, a
//                                      silent switch to another is worse than
//                                      a clear failure.
//   otherwise                          try claude, then an OpenAI-compatible
//                                      endpoint, then Apple Intelligence,
//                                      skipping any that isn't available.
//
// The cinematic pipeline's contract is DEGRADE, NEVER THROW: a failed
// generation has to come back as a reason a human can read, because that reason
// ends up in the run notes and the report. So `generateJson` returns a result
// rather than throwing, and names both the provider that produced the value and
// every provider that declined along the way.

import type { Logger } from "dailies-logger";
import { describeReply } from "./json.js";
import { createAppleProvider } from "./providers/apple.js";
import { createClaudeCliProvider } from "./providers/claude-cli.js";
import { createOpenAiCompatProvider } from "./providers/openai-compat.js";
import {
  type Echo,
  isProviderId,
  type ProviderId,
  type TextProvider,
} from "./types.js";

export const LLM_TIMEOUT_MS = 120_000;

// The model is stochastic — one retry recovers most unusable replies.
const MAX_ATTEMPTS = 2;

export function allProviders(env: NodeJS.ProcessEnv): TextProvider[] {
  return [
    createClaudeCliProvider(env),
    createOpenAiCompatProvider(env),
    createAppleProvider(),
  ];
}

// Which providers to try, in order. A pinned id yields exactly that provider
// (even if unavailable, so the failure names it); otherwise availability is
// probed and unavailable backends are dropped.
export async function resolveProviders(
  env: NodeJS.ProcessEnv = process.env
): Promise<TextProvider[]> {
  const all = allProviders(env);
  const pinned = env.DAILIES_LLM?.trim().toLowerCase();
  if (pinned) {
    const match = isProviderId(pinned)
      ? all.find((p) => p.id === pinned)
      : undefined;
    return match ? [match] : [];
  }
  const available: TextProvider[] = [];
  for (const provider of all) {
    if (await provider.isAvailable()) {
      available.push(provider);
    }
  }
  return available;
}

// Why there is nothing to generate with, worded as a fix the user can act on.
// Shared by generateJson's error and the cinematic pass's precondition check so
// both surfaces name the same remedy (and neither hardcodes the `claude` CLI as
// the only option).
export function noProviderReason(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.DAILIES_LLM?.trim();
  return pinned
    ? `no text provider named "${pinned}" ($DAILIES_LLM must be claude, openai or apple)`
    : "no text provider available — install the `claude` CLI, set $DAILIES_LLM_URL for an OpenAI-compatible endpoint, or enable Apple Intelligence";
}

// The credit line for whoever wrote the words, for the film's "Made with" roll:
// the provider and, where the provider alone says nothing, the model. Pure.
export function writerCredit(provider: ProviderId, model: string): string {
  switch (provider) {
    case "claude":
      return "Claude (Anthropic)";
    case "apple":
      return "Apple Intelligence (on-device)";
    default: {
      const name = model.trim();
      return name
        ? `${name} (OpenAI-compatible)`
        : "an OpenAI-compatible model";
    }
  }
}

export type GenerateResult<T> =
  | { model: string; provider: ProviderId; value: T }
  | { error: string };

type Attempt<T> = { value: T } | { reason: string };

// One provider's turn: retry an unusable reply once, but give up immediately on
// a transport failure (bad auth, missing binary, dead endpoint, timeout) — that
// won't fix itself, and the next provider might work.
async function tryProvider<T>(
  provider: TextProvider,
  args: {
    echo?: Echo;
    label: string;
    log: Logger;
    parse: (raw: string) => T | null;
    prompt: string;
    schema: unknown;
    timeoutMs: number;
  }
): Promise<Attempt<T>> {
  const { echo, label, log, parse, prompt, schema, timeoutMs } = args;
  let reason = `${provider.id} returned no usable ${label}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await provider.generateJson({
        echo,
        label,
        log,
        prompt,
        schema,
        timeoutMs,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.debug({ err, provider: provider.id }, `${label}: provider failed`);
      return { reason: `${provider.id} failed — ${detail}` };
    }
    const value = parse(raw);
    if (value) {
      return { value };
    }
    log.debug(
      { attempt, provider: provider.id, raw },
      `${label}: could not read the reply`
    );
    reason = `${provider.id} replied with unusable ${label} JSON (${describeReply(raw)})`;
  }
  return { reason };
}

// Generate an object matching `schema` and hand it to `parse`, trying each
// resolved provider in turn. The error names every provider that declined and
// why, because that string reaches the run notes and the report.
export async function generateJson<T>(args: {
  echo?: Echo;
  env?: NodeJS.ProcessEnv;
  label: string;
  log: Logger;
  parse: (raw: string) => T | null;
  prompt: string;
  // Overrides provider resolution. Injected by tests so the suite never makes a
  // real model call; production callers omit it.
  providers?: TextProvider[];
  schema: unknown;
  timeoutMs?: number;
}): Promise<GenerateResult<T>> {
  const {
    env = process.env,
    providers: injected,
    timeoutMs = LLM_TIMEOUT_MS,
    ...rest
  } = args;

  const providers = injected ?? (await resolveProviders(env));
  if (providers.length === 0) {
    return { error: noProviderReason(env) };
  }

  const declined: string[] = [];
  for (const provider of providers) {
    const outcome = await tryProvider(provider, { ...rest, timeoutMs });
    if ("value" in outcome) {
      // Always logged, not just on a fallthrough: which model produced a piece
      // of narration is the first thing you want when it reads oddly.
      rest.log.info(
        {
          declined: declined.length > 0 ? declined : undefined,
          model: provider.model,
          provider: provider.id,
        },
        `${rest.label}: generated by ${provider.describe()} [${provider.model}]${
          declined.length > 0
            ? ` after ${declined.length} provider(s) declined`
            : ""
        }`
      );
      return {
        model: provider.model,
        provider: provider.id,
        value: outcome.value,
      };
    }
    declined.push(outcome.reason);
  }
  return { error: declined.join("; ") };
}
