// The `claude` CLI as a text provider — the default, because it needs no API
// key and no local model: if Claude Code is installed, this already works.
//
// `--json-schema` forces the model through a structured-output tool call, so it
// can't emit prose, fences, or a truncated blob; the CLI hands back a validated
// object inside its own JSON envelope, which `readEnvelope` unwraps.

import { isOnPath, run } from "../../util/process.js";
import { tryParseJson } from "../json.js";
import type { GenerateJsonArgs, TextProvider } from "../types.js";

// Flags that strip everything these calls don't need from the `claude -p`
// context: all MCP servers (their tool schemas can be huge), the user's
// settings/DAILIES.md/skills, every built-in tool schema, and the coding-agent
// system prompt (replaced with a one-liner — our prompt already specifies the
// full JSON contract). This keeps the logged-in auth token (we do NOT use
// `--bare`, which skips the keychain read and would break auth). The model is
// pinned because `--setting-sources ""` also drops the user's model preference,
// and we don't want the CLI default to silently change output quality between
// environments. Override the pin with $DAILIES_CLAUDE_MODEL.
export function minContextArgs(env: NodeJS.ProcessEnv): string[] {
  return [
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--tools",
    "",
    "--system-prompt",
    "You are a precise generator. Output only what the user's message asks for, with no preamble or commentary.",
    "--model",
    claudeModel(env),
  ];
}

// Unwrap the CLI's `--output-format json` envelope. Returns the structured
// output when present, else the parsed `result` text, else undefined.
export function readEnvelope(stdout: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return tryParseJson(stdout) ?? undefined;
  }
  if (!envelope || typeof envelope !== "object") {
    return;
  }
  const env = envelope as {
    is_error?: boolean;
    result?: unknown;
    structured_output?: unknown;
  };
  if (env.is_error) {
    return;
  }
  if (env.structured_output !== undefined && env.structured_output !== null) {
    return env.structured_output;
  }
  if (typeof env.result === "string") {
    return tryParseJson(env.result) ?? undefined;
  }
  return;
}

// The model the CLI is pinned to, matching minContextArgs.
export function claudeModel(env: NodeJS.ProcessEnv): string {
  return env.DAILIES_CLAUDE_MODEL?.trim() || "sonnet";
}

export function createClaudeCliProvider(
  env: NodeJS.ProcessEnv = process.env
): TextProvider {
  return {
    describe(): string {
      return "the `claude` CLI";
    },

    async generateJson(args: GenerateJsonArgs): Promise<string> {
      const { echo, label, prompt, schema, timeoutMs } = args;
      const cliArgs = [
        "-p",
        ...minContextArgs(env),
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(schema),
        prompt,
      ];
      // The prompt is multi-KB — echo an elided form.
      echo?.(
        `$ claude -p --json-schema … <${label} prompt, ${prompt.length} chars>`
      );
      const { stdout } = await run("claude", cliArgs, timeoutMs);
      const output = readEnvelope(stdout);
      // Hand back text either way: an unusable envelope is described upstream
      // rather than thrown, so the reply itself reaches the diagnostics.
      return output === undefined ? stdout : JSON.stringify(output);
    },

    id: "claude",

    model: claudeModel(env),

    isAvailable(): Promise<boolean> {
      return isOnPath("claude", ["--version"]);
    },
  };
}
