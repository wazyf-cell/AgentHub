import { resolve } from "node:path";
import type { RoomConfig } from "./types.ts";
import type { RoomStore } from "./store.ts";

export function buildRealRoomConfig(workspace = process.cwd()): RoomConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "real",
    name: "真实模型房间",
    workspace: resolve(workspace),
    members: [
      {
        id: "architect",
        name: "架构师",
        role: "架构与验收",
        instructions:
          "先拆解任务，给出三步以内的方案、风险和验收标准；然后写 @实现者 交接。只讨论，不修改文件。",
        binding: {
          platformId: "codex-cli",
          modelId: "deepseek-v4.1-flash",
          thinking: "high",
          contextWindow: 200_000,
          contextBudget: 140_000,
          fallback: [{ platformId: "codex-cli", modelId: "glm-5.3-flash", thinking: "high" }],
        },
        behavior: { weight: 1 },
        permissions: { write: false },
      },
      {
        id: "implementer",
        name: "实现者",
        role: "实现",
        instructions:
          "根据方案给出具体落地方案（改哪些文件、接口怎么定、风险是什么）；完成后写 @前端优化 交接。只讨论，不修改文件。",
        binding: {
          platformId: "codex-cli",
          modelId: "glm-5.3-flash",
          thinking: "high",
          contextWindow: 1_000_000,
          contextBudget: 700_000,
          fallback: [{ platformId: "codex-cli", modelId: "kimi-k2.6", thinking: "medium" }],
        },
        behavior: { weight: 1 },
        permissions: { write: false },
      },
      {
        id: "frontend",
        name: "前端优化",
        role: "前端/UI",
        instructions:
          "从界面、交互、可访问性和响应式角度审查，给出可执行的改进建议；最后以 DONE 结束。只讨论，不修改文件。",
        binding: {
          platformId: "codex-cli",
          modelId: "kimi-k2.6",
          thinking: "medium",
          contextWindow: 256_000,
          contextBudget: 180_000,
          fallback: [{ platformId: "codex-cli", modelId: "glm-5.3-flash", thinking: "high" }],
        },
        behavior: { weight: 1 },
        permissions: { write: false },
      },
    ],
    rules: {
      autonomy: "medium",
      maxHandoffs: 6,
      maxConsecutiveSameSpeaker: 1,
      summarizeAt: 0.7,
      hardStopAt: 0.85,
      budgetYuan: 5,
      stopToken: "DONE",
      planOrder: ["architect", "implementer", "frontend"],
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createRealRoom(store: RoomStore, workspace = process.cwd()): RoomConfig {
  if (store.hasRoom("real")) {
    return store.readRoom("real");
  }
  return store.createRoom(buildRealRoomConfig(workspace));
}
