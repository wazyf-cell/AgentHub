import { findModel } from "../catalog.ts";
import { findPlatform } from "../platforms.ts";
import type { HealthChecker } from "../health.ts";
import type { SessionStore } from "../sessions.ts";
import type {
  AgentBackend,
  AgentTurnRequest,
  AgentTurnResult,
  ModelDescriptor,
  PlatformConfig,
  RoleBinding,
} from "../types.ts";
import type { RoomStore } from "../store.ts";
import { CliBackend } from "./cli.ts";
import { OpenAiBackend } from "./openai.ts";

export interface RoomBackendRouterOptions {
  store: RoomStore;
  roomId: string;
  platforms: PlatformConfig[];
  models: ModelDescriptor[];
  sessions: SessionStore;
  health: HealthChecker;
  fakeBackend?: AgentBackend;
  createBackend?: (platform: PlatformConfig, model: ModelDescriptor, binding: RoleBinding) => AgentBackend;
}

export class RoomBackendRouter implements AgentBackend {
  readonly id = "room-router";
  private readonly options: RoomBackendRouterOptions;

  constructor(options: RoomBackendRouterOptions) {
    this.options = options;
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const { platforms, models, health, sessions } = this.options;
    const requested = request.member.binding;
    const bindings: RoleBinding[] = [
      requested,
      ...(requested.fallback ?? []),
    ];
    const fallbacks: Array<{ platformId: string; modelId: string; error: string }> = [];

    for (const binding of bindings) {
      if (request.signal?.aborted) {
        return {
          text: "",
          status: "failed",
          error: "aborted",
          usedBinding: { platformId: binding.platformId, modelId: binding.modelId },
          fallbacks,
        };
      }
      const platform = findPlatform(platforms, binding.platformId);
      const model = findModel(models, binding.platformId, binding.modelId);
      if (!platform) {
        fallbacks.push({ platformId: binding.platformId, modelId: binding.modelId, error: "unknown platform" });
        continue;
      }
      if (!model) {
        fallbacks.push({ platformId: binding.platformId, modelId: binding.modelId, error: "unknown model in catalog" });
        continue;
      }
      if (model.enabled === false) {
        fallbacks.push({ platformId: binding.platformId, modelId: binding.modelId, error: "model is disabled" });
        continue;
      }

      const status = await health.check(platform, model);
      if (status.status === "missing" || status.status === "error") {
        fallbacks.push({
          platformId: binding.platformId,
          modelId: binding.modelId,
          error: status.detail ?? `health ${status.status}`,
        });
        continue;
      }

      try {
        const backend = this.createBackend(platform, model, binding);
        const supportsImage = model.input?.includes("image") === true;
        const effectiveRequest = request.images?.length && !supportsImage
          ? {
            ...request,
            prompt: `${request.prompt}\n\n[附件说明] 用户附带了 ${request.images.length} 张图片，但当前模型不支持图片输入；请勿臆测图片内容。`,
            images: undefined,
          }
          : request;
        const result = await backend.runTurn(effectiveRequest);
        if (result.status === "completed") {
          return {
            ...result,
            usedBinding: { platformId: platform.id, modelId: model.modelId },
            fallbacks,
          };
        }
        fallbacks.push({
          platformId: platform.id,
          modelId: model.modelId,
          error: (result.error ?? "turn failed").slice(0, 500),
        });
        if (request.signal?.aborted) {
          return { ...result, fallbacks };
        }
      } catch (error) {
        fallbacks.push({
          platformId: platform.id,
          modelId: model.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      text: "",
      status: "failed",
      error: fallbacks.length > 0
        ? `all bindings failed: ${fallbacks.map((item) => `${item.platformId}/${item.modelId}: ${item.error}`).join(" | ")}`
        : "no bindings configured",
      usedBinding: {
        platformId: requested.platformId,
        modelId: requested.modelId,
      },
      fallbacks,
    };
  }

  private createBackend(platform: PlatformConfig, model: ModelDescriptor, binding: RoleBinding): AgentBackend {
    if (this.options.createBackend) {
      return this.options.createBackend(platform, model, binding);
    }
    if (platform.kind === "fake") {
      if (!this.options.fakeBackend) {
        throw new Error("Fake platform requested but no fake backend was provided.");
      }
      return this.options.fakeBackend;
    }
    if (platform.kind === "cli") {
      return new CliBackend({
        platform,
        model,
        sessionStore: this.options.sessions,
        thinking: binding.thinking,
      });
    }
    if (platform.kind === "openai-compatible") {
      return new OpenAiBackend({
        platform,
        model,
        thinking: binding.thinking,
      });
    }
    throw new Error(`Platform kind "${platform.kind}" is not implemented yet.`);
  }
}
