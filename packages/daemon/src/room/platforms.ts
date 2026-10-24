import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlatformConfig } from "./types.ts";
import type { RoomStore } from "./store.ts";

const PLATFORMS_FILE = "platforms.json";

export const DEFAULT_PLATFORMS: PlatformConfig[] = [
  {
    id: "codex-cli",
    name: "Codex CLI (AI Work)",
    kind: "cli",
    enabled: true,
    config: {
      harness: "codex",
      sandboxMode: "read-only",
      timeoutMs: 600_000,
      costBaseYuanPerMillion: 10,
    },
  },
  {
    id: "claude-cli",
    name: "Claude Code (relay)",
    kind: "cli",
    enabled: true,
    config: {
      harness: "claude",
      permissionMode: "plan",
      timeoutMs: 600_000,
    },
  },
  {
    id: "aiwork-api",
    name: "AI Work OpenAI API",
    kind: "openai-compatible",
    enabled: false,
    config: {
      baseUrl: "http://127.0.0.1:17864/v1",
      apiKeyEnv: "AIWORK_API_KEY",
      timeoutMs: 600_000,
      costBaseYuanPerMillion: 10,
    },
  },
];

export function loadPlatforms(store: RoomStore): PlatformConfig[] {
  const filePath = join(store.profilesDir, PLATFORMS_FILE);
  if (!existsSync(filePath)) {
    savePlatforms(store, DEFAULT_PLATFORMS);
    return [...DEFAULT_PLATFORMS];
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Platform config ${filePath} must be a JSON object.`);
  }
  const record = parsed as { version?: number; platforms?: unknown };
  if (record.version !== 1 || !Array.isArray(record.platforms)) {
    throw new Error(`Platform config ${filePath} must contain version 1 and a platforms array.`);
  }
  return record.platforms as PlatformConfig[];
}

export function savePlatforms(store: RoomStore, platforms: PlatformConfig[]): void {
  mkdirSync(store.profilesDir, { recursive: true });
  writeFileSync(
    join(store.profilesDir, PLATFORMS_FILE),
    `${JSON.stringify({ version: 1, platforms }, null, 2)}\n`,
    "utf8",
  );
}

export function findPlatform(platforms: PlatformConfig[], platformId: string): PlatformConfig | undefined {
  return platforms.find((platform) => platform.id === platformId);
}

export function readPlatformString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readPlatformNumber(config: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = config?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
