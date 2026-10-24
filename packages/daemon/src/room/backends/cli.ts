import { isAgentRouterHarness, runAgentRouter } from "../../agent-router/router.ts";
import type { AgentRouterEvent, AgentRouterRunRequest } from "../../agent-router/types.ts";
import { estimateTokens } from "../transcript.ts";
import { killProcessTree, runCustomCliTurn } from "./custom-cli.ts";
import { readPlatformNumber, readPlatformString } from "../platforms.ts";
import type { SessionStore } from "../sessions.ts";
import type {
  AgentBackend,
  AgentTurnRequest,
  AgentTurnResult,
  ModelDescriptor,
  PlatformConfig,
  TokenUsage,
} from "../types.ts";

export interface CliBackendOptions {
  platform: PlatformConfig;
  model: ModelDescriptor;
  sessionStore: SessionStore;
  thinking?: string;
  timeoutMs?: number;
  usdToCny?: number;
  baseYuanPerMillion?: number;
}

export class CliBackend implements AgentBackend {
  readonly id = "cli";
  private readonly options: CliBackendOptions;

  constructor(options: CliBackendOptions) {
    this.options = options;
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const { platform, model, sessionStore } = this.options;
    const template = readPlatformString(platform.config, "commandTemplate");
    if (template) {
      return this.runCustom(request, template);
    }
    const harness = readPlatformString(platform.config, "harness") ?? platform.id;
    if (!isAgentRouterHarness(harness)) {
      return {
        text: "",
        status: "failed",
        error: `Platform ${platform.id} uses unsupported harness "${harness}".`,
        usedBinding: { platformId: platform.id, modelId: model.modelId },
      };
    }
    const sessionId = sessionStore.get(request.member.id, platform.id, model.modelId);
    let result = await this.invoke(request, harness, sessionId);

    if (
      result.status !== "completed"
      && sessionId
      && isSessionFailure(result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join(" "))
    ) {
      // A stale/foreign session must not poison every future turn.
      sessionStore.clear(request.member.id);
      result = await this.invoke(request, harness, undefined);
    }

    const usage = extractUsage(result.events);
    const costUsd = extractCostUsd(result.events);
    const costYuan = costUsd !== undefined && costUsd > 0
      ? costUsd * (this.options.usdToCny ?? 7.2)
      : estimateCostYuan(usage, model, platform, this.options.baseYuanPerMillion);

    if (result.sessionId) {
      sessionStore.set(request.member.id, result.sessionId, platform.id, model.modelId);
    }

    if (result.status !== "completed") {
      const message = result.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning")
        .map((diagnostic) => diagnostic.message)
        .join("; ");
      return {
        text: result.outputText ?? "",
        status: "failed",
        usage,
        costYuan,
        error: message || `CLI returned ${result.status}`,
        sessionId: result.sessionId,
        usedBinding: { platformId: platform.id, modelId: model.modelId },
      };
    }

    return {
      text: result.outputText ?? "",
      status: "completed",
      usage,
      costYuan,
      sessionId: result.sessionId,
      usedBinding: { platformId: platform.id, modelId: model.modelId },
    };
  }

  private async runCustom(request: AgentTurnRequest, template: string): Promise<AgentTurnResult> {
    const { platform, model } = this.options;
    const usedBinding = { platformId: platform.id, modelId: model.modelId };
    const result = await runCustomCliTurn({
      template,
      prompt: request.prompt,
      model: model.modelId,
      images: request.images,
      cwd: request.cwd ?? request.room.workspace,
      platformEnv: readPlatformEnv(platform.config?.env),
      timeoutMs: this.options.timeoutMs
        ?? readPlatformNumber(platform.config, "timeoutMs")
        ?? 600_000,
      onDelta: request.onDelta,
      signal: request.signal,
    });
    // The template contract has no usage report, so estimate from the text we saw.
    const inputTokens = estimateTokens(request.prompt);
    const outputTokens = estimateTokens(result.text);
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
    return {
      text: result.text,
      status: result.status,
      usage,
      costYuan: estimateCostYuan(usage, model, platform, this.options.baseYuanPerMillion),
      error: result.error,
      usedBinding,
    };
  }

  private async invoke(
    request: AgentTurnRequest,
    harness: Parameters<typeof runAgentRouter>[0]["harness"],
    sessionId: string | undefined,
  ): Promise<Awaited<ReturnType<typeof runAgentRouter>>> {
    const { platform, model } = this.options;
    let pid: number | undefined;
    let emittedText = false;
    const onAbort = (): void => {
      if (pid) {
        killProcessTree(pid);
      }
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await runAgentRouter({
        version: 1,
        harness,
        prompt: request.prompt,
        cwd: request.cwd ?? request.room.workspace,
        model: model.modelId,
        mode: request.writeMode ? "workspace-write" : readPlatformString(platform.config, "sandboxMode"),
        permissionMode: request.writeMode
          ? readPlatformString(platform.config, "permissionMode") ?? "acceptEdits"
          : readPlatformString(platform.config, "permissionMode"),
        reasoningEffort: this.options.thinking ?? model.defaultThinking,
        sessionId,
        env: readPlatformEnv(platform.config?.env),
        imagePaths: [
          ...(readPlatformStringArray(platform.config, "imagePaths") ?? []),
          ...(request.images ?? []),
        ],
        claudeMcpConfigPaths: readPlatformStringArray(platform.config, "claudeMcpConfigPaths"),
        configOverrides: readPlatformRecord(platform.config, "configOverrides"),
        timeoutMs: this.options.timeoutMs
          ?? readPlatformNumber(platform.config, "timeoutMs")
          ?? 600_000,
        outputFormat: "json-events",
        dangerouslyBypassPermissions: false,
      } satisfies AgentRouterRunRequest, {
        emit: (event: AgentRouterEvent) => {
          if (event.type === "harness_started") {
            pid = event.pid;
          } else if (event.type === "text_delta" && event.text) {
            emittedText = true;
            request.onDelta?.(event.text);
          }
        },
      });
      if (!emittedText && result.outputText?.trim()) {
        request.onDelta?.(result.outputText);
      }
      return result;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function extractUsage(events: AgentRouterEvent[]): TokenUsage | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let contextTokens: number | undefined;
  for (const event of events) {
    if (event.type !== "tool_output" || event.tool !== "usage" || !event.metadata || typeof event.metadata !== "object") {
      continue;
    }
    const metadata = event.metadata as Record<string, unknown>;
    inputTokens = numberValue(metadata.input_tokens) ?? inputTokens;
    outputTokens = numberValue(metadata.output_tokens) ?? outputTokens;
    cacheReadTokens = numberValue(metadata.cached_input_tokens)
      ?? numberValue(metadata.cache_read_input_tokens)
      ?? numberValue(metadata.cache_read_tokens)
      ?? cacheReadTokens;
    cacheWriteTokens = numberValue(metadata.cache_creation_input_tokens)
      ?? numberValue(metadata.cache_write_tokens)
      ?? cacheWriteTokens;
    contextTokens = numberValue(metadata.context_tokens) ?? contextTokens;
  }
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    contextTokens: contextTokens ?? inputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function extractCostUsd(events: AgentRouterEvent[]): number | undefined {
  for (const event of events) {
    if (event.type !== "tool_output" || event.tool !== "usage" || !event.metadata || typeof event.metadata !== "object") {
      continue;
    }
    const value = numberValue((event.metadata as Record<string, unknown>).cost_usd);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function estimateCostYuan(
  usage: TokenUsage | undefined,
  model: ModelDescriptor,
  platform: PlatformConfig,
  overrideBase?: number,
): number {
  const totalTokens = usage?.totalTokens ?? 0;
  if (totalTokens <= 0) {
    return 0;
  }
  const base = overrideBase
    ?? readPlatformNumber(platform.config, "costBaseYuanPerMillion")
    ?? 10;
  return (totalTokens / 1_000_000) * (model.costMultiplier ?? 1) * base;
}

function isSessionFailure(text: string): boolean {
  const compact = text.toLowerCase();
  return /session|resume|thread/.test(compact) && /missing|not found|invalid|expired|unknown/.test(compact);
}

function readPlatformEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      env[key] = item;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function readPlatformStringArray(config: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = config?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function readPlatformRecord(config: Record<string, unknown> | undefined, key: string): Record<string, string> | undefined {
  const value = config?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [itemKey, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      record[itemKey] = item;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
