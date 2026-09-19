// Any OpenAI-compatible chat-completions endpoint as a text provider.
//
// One shape covers a lot of ground: OpenAI, OpenRouter, LM Studio, Ollama,
// vLLM, llama.cpp's server — and any local bridge that speaks it, including
// Apple Intelligence bridges. Configured exactly like the project's other
// OpenAI-compatible integrations (oMLX TTS, transcription):
//
//   $DAILIES_LLM_URL       host root, e.g. http://localhost:1234 or
//                          https://openrouter.ai/api
//   $DAILIES_LLM_API_KEY   sent as `Authorization: Bearer …` when set
//   $DAILIES_LLM_MODEL     model id (required by most servers)
//
// Structured output uses `response_format: {type: "json_schema", strict: true}`.
// Servers that ignore it still usually return JSON, and the shared tolerant
// reader handles a fenced or prose-wrapped reply — so this degrades rather than
// failing outright on a server with weaker support.

import { shellQuote } from "../../util/shell.js";
import type { GenerateJsonArgs, TextProvider } from "../types.js";

export interface OpenAiCompatConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

// Read the config from env. Returns null when no endpoint is configured, which
// is how this provider stays out of the way by default. Pure → unit-tested.
export function resolveOpenAiConfig(
  env: NodeJS.ProcessEnv
): OpenAiCompatConfig | null {
  const baseUrl = env.DAILIES_LLM_URL?.trim();
  if (!baseUrl) {
    return null;
  }
  return {
    apiKey: env.DAILIES_LLM_API_KEY?.trim() || undefined,
    // `gpt-4o-mini`-style ids vary per server; most local servers accept any
    // string and serve whatever is loaded, so a placeholder is a usable default.
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: env.DAILIES_LLM_MODEL?.trim() || "local-model",
  };
}

// Body for a schema-constrained chat completion. Pure → unit-tested.
export function buildChatBody(args: {
  model: string;
  prompt: string;
  schema: unknown;
}): Record<string, unknown> {
  return {
    messages: [
      {
        content:
          "You are a precise generator. Reply with only the requested JSON object — no preamble, no commentary, no code fences.",
        role: "system",
      },
      { content: args.prompt, role: "user" },
    ],
    model: args.model,
    response_format: {
      json_schema: { name: "reply", schema: args.schema, strict: true },
      type: "json_schema",
    },
  };
}

// Pull the assistant message text out of a chat-completions response. Tolerant
// of the shape: a server that returns a bare string or a content-parts array
// still works. Pure → unit-tested.
export function readChatReply(body: unknown): string | null {
  const choice = (body as { choices?: { message?: unknown }[] })?.choices?.[0];
  const content = (choice?.message as { content?: unknown })?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part as { text?: unknown })?.text)
      .filter((t): t is string => typeof t === "string")
      .join("");
    return text || null;
  }
  return null;
}

// A redacted, copy-pasteable curl equivalent. The key is shown as the env-var
// reference (never the value), so the line runs verbatim once it's exported.
export function describeChatCurl(args: {
  body: Record<string, unknown>;
  config: OpenAiCompatConfig;
}): string {
  const auth = args.config.apiKey
    ? ['-H "Authorization: Bearer $DAILIES_LLM_API_KEY"']
    : [];
  return [
    "curl -s -X POST",
    `${args.config.baseUrl}/v1/chat/completions`,
    ...auth,
    "-H 'content-type: application/json'",
    `-d ${shellQuote(JSON.stringify(args.body))}`,
  ].join(" ");
}

export function createOpenAiCompatProvider(
  env: NodeJS.ProcessEnv = process.env
): TextProvider {
  const config = resolveOpenAiConfig(env);
  return {
    describe(): string {
      return config
        ? `an OpenAI-compatible endpoint (${config.model} at ${config.baseUrl})`
        : "an OpenAI-compatible endpoint (not configured)";
    },

    async generateJson(args: GenerateJsonArgs): Promise<string> {
      const { echo, label, prompt, schema, timeoutMs } = args;
      if (!config) {
        throw new Error("no $DAILIES_LLM_URL configured");
      }
      const body = buildChatBody({ model: config.model, prompt, schema });
      echo?.(
        `$ ${describeChatCurl({ body: { ...body, messages: `<${label} prompt, ${prompt.length} chars>` }, config })}`
      );
      const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(config.apiKey
            ? { authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(
          `HTTP ${res.status} from ${config.baseUrl}${detail ? ` — ${detail}` : ""}`
        );
      }
      const reply = readChatReply(await res.json());
      if (reply === null) {
        throw new Error("the endpoint returned no assistant message");
      }
      return reply;
    },

    id: "openai",

    model: config?.model ?? "(unconfigured)",

    async isAvailable(): Promise<boolean> {
      if (!config) {
        return false;
      }
      // A models listing is the cheapest liveness probe every compatible
      // server implements. A server that 404s it but serves completions is
      // still usable, so only a transport failure counts as unavailable.
      try {
        await fetch(`${config.baseUrl}/v1/models`, {
          signal: AbortSignal.timeout(2000),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
