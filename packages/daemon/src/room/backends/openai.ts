import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { readPlatformNumber, readPlatformString } from "../platforms.ts";
import type {
  AgentBackend,
  AgentTurnRequest,
  AgentTurnResult,
  ModelDescriptor,
  PlatformConfig,
  TokenUsage,
} from "../types.ts";

export interface OpenAiBackendOptions {
  platform: PlatformConfig;
  model: ModelDescriptor;
  thinking?: string;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | Array<{ type?: string; text?: string }> };
    message?: { content?: string | Array<{ type?: string; text?: string }> };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

function mapUsage(usage: NonNullable<ChatCompletionChunk["usage"]>): TokenUsage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const mapped: TokenUsage = {
    inputTokens,
    outputTokens,
    contextTokens: inputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens;
  if (cacheRead !== undefined) mapped.cacheReadTokens = cacheRead;
  if (usage.cache_creation_input_tokens !== undefined) mapped.cacheWriteTokens = usage.cache_creation_input_tokens;
  return mapped;
}

export class OpenAiBackend implements AgentBackend {
  readonly id = "openai-compatible";
  private readonly options: OpenAiBackendOptions;

  constructor(options: OpenAiBackendOptions) {
    this.options = options;
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const { platform, model } = this.options;
    const baseUrl = (readPlatformString(platform.config, "baseUrl") ?? "http://127.0.0.1:17864/v1").replace(/\/+$/, "");
    const apiKey = resolveApiKey(platform);
    if (!apiKey) {
      return {
        text: "",
        status: "failed",
        error: `${platform.id} has no API key; set the environment variable named by apiKeyEnv.`,
      };
    }

    const body: Record<string, unknown> = {
      model: model.modelId,
      messages: [{ role: "user", content: buildContent(request) }],
      stream: true,
      stream_options: { include_usage: true },
    };
    const maxOutput = model.maxOutput ?? readPlatformNumber(platform.config, "maxOutputTokens");
    if (maxOutput) {
      body.max_tokens = maxOutput;
    }
    const reasoningParam = readPlatformString(platform.config, "reasoningParam") ?? "reasoning_effort";
    if (this.options.thinking && reasoningParam !== "none") {
      body[reasoningParam] = this.options.thinking;
    }
    const extraBody = platform.config?.extraBody;
    if (extraBody && typeof extraBody === "object" && !Array.isArray(extraBody)) {
      Object.assign(body, extraBody);
    }

    const timeoutMs = readPlatformNumber(platform.config, "timeoutMs") ?? 600_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return {
        text: "",
        status: "failed",
        error: request.signal?.aborted
          ? "aborted"
          : `request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!response.ok) {
      const detail = redact(await safeText(response), apiKey).slice(-600);
      return {
        text: "",
        status: "failed",
        error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return parseJsonResponse(await response.json(), model, platform);
    }
    return parseStream(response, model, platform, request);
  }
}

function resolveApiKey(platform: PlatformConfig): string | undefined {
  const envName = readPlatformString(platform.config, "apiKeyEnv");
  if (envName && process.env[envName]?.trim()) {
    return process.env[envName]!.trim();
  }
  const keyFile = readPlatformString(platform.config, "apiKeyFile");
  if (keyFile && existsSync(keyFile)) {
    const value = readFileSync(keyFile, "utf8").trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildContent(request: AgentTurnRequest): string | Array<Record<string, unknown>> {
  const images = request.images ?? [];
  if (images.length === 0) {
    return request.prompt;
  }
  return [
    { type: "text", text: request.prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: toDataUrl(image) },
    })),
  ];
}

function toDataUrl(image: string): string {
  if (/^(https?:|data:)/i.test(image)) {
    return image;
  }
  const mime = mimeFor(extname(image).toLowerCase());
  return `data:${mime};base64,${readFileSync(image).toString("base64")}`;
}

function mimeFor(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

async function parseStream(
  response: Response,
  model: ModelDescriptor,
  platform: PlatformConfig,
  request: AgentTurnRequest,
): Promise<AgentTurnResult> {
  if (!response.body) {
    return { text: "", status: "failed", error: "stream response had no body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: TokenUsage | undefined;
  let providerError: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk;
      } catch {
        continue;
      }
      if (chunk.error?.message) {
        providerError = chunk.error.message;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      const piece = normalizeContent(delta);
      if (piece) {
        text += piece;
        request.onDelta?.(piece);
      }
      if (chunk.usage) {
        usage = mapUsage(chunk.usage);
      }
    }
  }

  if (providerError && !text.trim()) {
    return { text: "", status: "failed", error: providerError };
  }
  if (!text.trim()) {
    return { text: "", status: "failed", error: "API returned an empty response", usage };
  }
  return {
    text: text.trim(),
    status: "completed",
    usage,
    costYuan: estimateCostYuan(usage, model, platform),
  };
}

function parseJsonResponse(value: unknown, model: ModelDescriptor, platform: PlatformConfig): AgentTurnResult {
  const chunk = value as ChatCompletionChunk;
  if (chunk.error?.message) {
    return { text: "", status: "failed", error: chunk.error.message };
  }
  const text = normalizeContent(chunk.choices?.[0]?.message?.content);
  if (!text) {
    return { text: "", status: "failed", error: "API returned an empty response" };
  }
  const usage = chunk.usage ? mapUsage(chunk.usage) : undefined;
  return {
    text,
    status: "completed",
    usage,
    costYuan: estimateCostYuan(usage, model, platform),
  };
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
  }
  return "";
}

function estimateCostYuan(
  usage: TokenUsage | undefined,
  model: ModelDescriptor,
  platform: PlatformConfig,
): number | undefined {
  if (!usage) return undefined;
  const totalTokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (totalTokens <= 0) return undefined;
  const base = readPlatformNumber(platform.config, "costBaseYuanPerMillion") ?? 10;
  const multiplier = model.costMultiplier ?? 1;
  return (totalTokens / 1_000_000) * base * multiplier;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
