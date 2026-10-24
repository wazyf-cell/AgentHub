import { findExecutableOnPath } from "../agent-router/utils.ts";
import { splitCommandTemplate } from "./backends/custom-cli.ts";
import { readPlatformString } from "./platforms.ts";
import type { ModelDescriptor, PlatformConfig } from "./types.ts";

export type HealthStatus = "ok" | "missing" | "error" | "unknown";

export interface PlatformHealth {
  platformId: string;
  modelId?: string;
  status: HealthStatus;
  detail?: string;
  checkedAt: string;
}

export class HealthChecker {
  private readonly cache = new Map<string, PlatformHealth>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  async check(platform: PlatformConfig, model?: ModelDescriptor): Promise<PlatformHealth> {
    const key = `${platform.id}:${model?.modelId ?? "*"}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - Date.parse(cached.checkedAt) < this.ttlMs) {
      return cached;
    }
    const health = await this.probe(platform, model);
    this.cache.set(key, health);
    return health;
  }

  clear(): void {
    this.cache.clear();
  }

  private async probe(platform: PlatformConfig, model?: ModelDescriptor): Promise<PlatformHealth> {
    const checkedAt = new Date().toISOString();
    const base = { platformId: platform.id, modelId: model?.modelId, checkedAt };

    if (platform.enabled === false) {
      return { ...base, status: "error", detail: "platform is disabled" };
    }
    if (platform.kind === "fake") {
      return { ...base, status: "ok" };
    }
    if (platform.kind === "cli") {
      const template = readPlatformString(platform.config, "commandTemplate");
      if (template) {
        const command = splitCommandTemplate(template)[0] ?? "";
        const executable = command ? await findExecutableOnPath(command) : undefined;
        return executable
          ? { ...base, status: "ok", detail: executable }
          : { ...base, status: "missing", detail: `${command || "(空模板)"} 未找到（命令模板）` };
      }
      const harness = readPlatformString(platform.config, "harness") ?? platform.id;
      const executable = await findExecutableOnPath(harness);
      return executable
        ? { ...base, status: "ok", detail: executable }
        : { ...base, status: "missing", detail: `${harness} CLI was not found on PATH` };
    }
    if (platform.kind === "openai-compatible") {
      const baseUrl = readPlatformString(platform.config, "baseUrl");
      if (!baseUrl) {
        return { ...base, status: "error", detail: "baseUrl is missing" };
      }
      const apiKeyEnv = readPlatformString(platform.config, "apiKeyEnv");
      const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
      if (!apiKey) {
        return { ...base, status: "error", detail: `missing API key env ${apiKeyEnv ?? "(not configured)"}` };
      }
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        return response.ok
          ? { ...base, status: "ok", detail: `HTTP ${response.status}` }
          : { ...base, status: "error", detail: `HTTP ${response.status}` };
      } catch (error) {
        return {
          ...base,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ...base, status: "unknown", detail: `unsupported platform kind ${platform.kind}` };
  }
}
