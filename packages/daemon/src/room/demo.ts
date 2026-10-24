import { resolve } from "node:path";
import type { RoomConfig } from "./types.ts";
import type { RoomStore } from "./store.ts";

export function buildDemoRoomConfig(workspace = process.cwd()): RoomConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "demo",
    name: "演示房间",
    workspace: resolve(workspace),
    members: [
      {
        id: "planner",
        name: "规划者",
        role: "规划",
        instructions: "把任务拆成可执行的步骤，指出风险和验收方式。",
        binding: { platformId: "fake", modelId: "fake-planner" },
        behavior: { weight: 1 },
      },
      {
        id: "implementer",
        name: "实现者",
        role: "实现",
        instructions: "根据计划给出具体实现方案，说明改哪些文件、为什么。",
        binding: { platformId: "fake", modelId: "fake-implementer" },
        behavior: { weight: 1 },
      },
      {
        id: "reviewer",
        name: "审查者",
        role: "审查",
        instructions: "审查前两位的输出，指出缺陷、遗漏的验证和下一步。",
        binding: { platformId: "fake", modelId: "fake-reviewer" },
        behavior: { weight: 1 },
      },
    ],
    rules: {
      autonomy: "medium",
      maxHandoffs: 8,
      maxConsecutiveSameSpeaker: 1,
      stopToken: "DONE",
      planOrder: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createDemoRoom(store: RoomStore, workspace = process.cwd()): RoomConfig {
  if (store.hasRoom("demo")) {
    return store.readRoom("demo");
  }
  return store.createRoom(buildDemoRoomConfig(workspace));
}
