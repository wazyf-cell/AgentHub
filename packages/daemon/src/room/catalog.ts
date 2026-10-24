import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ModelDescriptor } from "./types.ts";
import type { RoomStore } from "./store.ts";

const MODELS_FILE = "models.json";
const require = createRequire(import.meta.url);

export const DEFAULT_MODELS: ModelDescriptor[] = [
  {
    platformId: "codex-cli",
    modelId: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    contextWindow: 200_000,
    maxOutput: 64_000,
    input: ["text"],
    thinkingLevels: ["low", "medium", "high"],
    defaultThinking: "high",
    costMultiplier: 0.1,
    toolCalling: true,
    enabled: true,
    source: "manual",
    notes: "Verified with codex CLI on 2026-10-24.",
  },
  {
    platformId: "codex-cli",
    modelId: "glm-5.3-flash",
    displayName: "GLM-5.3-Flash",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    input: ["text", "image"],
    thinkingLevels: ["low", "high", "max"],
    defaultThinking: "high",
    costMultiplier: 0.08,
    toolCalling: true,
    enabled: true,
    source: "import",
    notes: "Verified with codex CLI on 2026-10-24; 1M context and vision.",
  },
  {
    platformId: "codex-cli",
    modelId: "kimi-k2.6",
    displayName: "Kimi K2.6",
    contextWindow: 256_000,
    maxOutput: 64_000,
    input: ["text", "image"],
    thinkingLevels: ["medium"],
    defaultThinking: "medium",
    costMultiplier: 0.52,
    toolCalling: true,
    enabled: true,
    source: "import",
    notes: "Verified with codex CLI on 2026-10-24.",
  },
  {
    platformId: "claude-cli",
    modelId: "sonnet",
    displayName: "Claude Sonnet (relay)",
    contextWindow: 200_000,
    maxOutput: 32_000,
    input: ["text"],
    thinkingLevels: ["low", "medium", "high"],
    defaultThinking: "medium",
    costMultiplier: 1,
    toolCalling: true,
    enabled: true,
    source: "manual",
    notes: "Relay returned 404 for every listed model on 2026-10-24; keep as a fallback option.",
  },
];

export function loadModels(store: RoomStore): ModelDescriptor[] {
  const filePath = join(store.profilesDir, MODELS_FILE);
  if (!existsSync(filePath)) {
    saveModels(store, DEFAULT_MODELS);
    return [...DEFAULT_MODELS];
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Model catalog ${filePath} must be a JSON object.`);
  }
  const record = parsed as { version?: number; models?: unknown };
  if (record.version !== 1 || !Array.isArray(record.models)) {
    throw new Error(`Model catalog ${filePath} must contain version 1 and a models array.`);
  }
  return record.models as ModelDescriptor[];
}

export function saveModels(store: RoomStore, models: ModelDescriptor[]): void {
  mkdirSync(store.profilesDir, { recursive: true });
  writeFileSync(
    join(store.profilesDir, MODELS_FILE),
    `${JSON.stringify({ version: 1, models }, null, 2)}\n`,
    "utf8",
  );
}

export function findModel(models: ModelDescriptor[], platformId: string, modelId: string): ModelDescriptor | undefined {
  return models.find((model) => model.platformId === platformId && model.modelId === modelId);
}

export interface CatalogSyncResult {
  added: number;
  skipped: number;
  total: number;
}

export function syncModelsFromAiWorkGate(store: RoomStore, platformId = "codex-cli"): CatalogSyncResult {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set; cannot locate the AIWorkGate catalog.");
  }
  const dbPath = join(appData, "AIWorkGate", "aiworkgate.db");
  if (!existsSync(dbPath)) {
    throw new Error(`AIWorkGate database not found at ${dbPath}.`);
  }

  let DatabaseSync: new (path: string, options?: Record<string, unknown>) => {
    prepare: (sql: string) => { all: () => Array<Record<string, unknown>> };
    close: () => void;
  };
  try {
    ({ DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync });
  } catch {
    throw new Error("This Node runtime does not expose node:sqlite; run the sync with Node 24 from a terminal.");
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(
      "select model_id, display_name, context_length, vision, thinking, multiplier, free from model_catalog where enabled = 1",
    ).all();
  } finally {
    db.close();
  }

  const current = loadModels(store);
  const seen = new Set(current.map((model) => `${model.platformId}:${model.modelId}`));
  const imported: ModelDescriptor[] = [];
  let skipped = 0;

  for (const row of rows) {
    const modelId = typeof row.model_id === "string" ? row.model_id.trim() : "";
    if (!modelId) {
      skipped += 1;
      continue;
    }
    const key = `${platformId}:${modelId}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    imported.push({
      platformId,
      modelId,
      displayName: typeof row.display_name === "string" && row.display_name.trim()
        ? row.display_name.trim()
        : modelId,
      contextWindow: toPositiveNumber(row.context_length),
      input: Number(row.vision) === 1 ? ["text", "image"] : ["text"],
      thinkingLevels: parseThinkingLevels(row.thinking),
      costMultiplier: toPositiveNumber(row.multiplier),
      enabled: true,
      source: "import",
      notes: "Imported from AIWorkGate; not verified with the codex route.",
    });
  }

  if (imported.length > 0) {
    saveModels(store, [...current, ...imported].sort((left, right) => {
      const platformDelta = left.platformId.localeCompare(right.platformId);
      return platformDelta !== 0 ? platformDelta : left.modelId.localeCompare(right.modelId);
    }));
  }

  return { added: imported.length, skipped, total: rows.length };
}

function parseThinkingLevels(value: unknown): string[] | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const levels = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return levels.length > 0 ? levels : undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
