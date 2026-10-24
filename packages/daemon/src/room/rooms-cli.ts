#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDemoFakeBackend } from "./backends/fake.ts";
import { RoomBackendRouter } from "./backends/router.ts";
import { scanCapabilities } from "./capabilities.ts";
import { describeImage } from "./vision.ts";
import { findModel, loadModels, syncModelsFromAiWorkGate } from "./catalog.ts";
import { createDemoRoom } from "./demo.ts";
import { runRoom } from "./engine.ts";
import { HealthChecker } from "./health.ts";
import { loadPlatforms } from "./platforms.ts";
import { createRealRoom } from "./real-room.ts";
import { SessionStore } from "./sessions.ts";
import { RoomStore, resolveRoomDataDir } from "./store.ts";
import { createRoomSummarizer } from "./summary.ts";
import type { RoomConfig, RoomEvent, RoomMember, RoomRules, StopReason } from "./types.ts";

const HELP = `AgentHub room CLI

用法:
  room init [--real] [--data-dir <dir>] [--workspace <path>]
  room run --prompt "..." [--room real] [--data-dir <dir>] [--autonomy low|medium|high] [--max-handoffs 8] [--image <path> ...] [--fake] [--json-events]
  room list [--json]
  room show [--json] [--room <id>]
  room update --json-file <room.json> [--room <id>]
  room replay [--room <id>] [--json]
  room export --out <dir> [--room <id>]
  room platforms [--json] [--health]
  room models [--json] [--platform <id>]
  room models sync [--data-dir <dir>]
  room capabilities [--json]
  room vision --image <path> [--prompt "..."] [--command modlens] [--json]

说明:
  init         创建假后端演示房间；加 --real 创建三个真实模型的房间。
  run          默认自动选择后端：成员全是 fake 时用假后端，否则走平台路由。
  run --image  附带图片；只有声明支持图片的模型会收到图片，其他成员只收到附件说明。
  models sync  从 AIWorkGate 的本地目录导入模型能力（需要 Node 24 的 node:sqlite）。
  capabilities 只读扫描本机 Claude skills、Codex/Claude 的 MCP 服务名，供角色卡参考。
  vision       调用本机 ModLens（需自行安装）把图片转成文字证据，结果按图片+提示词缓存；不随应用打包。
`;

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      room: { type: "string", default: "demo" },
      prompt: { type: "string" },
      workspace: { type: "string" },
      real: { type: "boolean", default: false },
      fake: { type: "boolean", default: false },
      "json-events": { type: "boolean", default: false },
      autonomy: { type: "string" },
      "max-handoffs": { type: "string" },
      image: { type: "string", multiple: true },
      command: { type: "string" },
      timeout: { type: "string" },
      reason: { type: "string" },
      detail: { type: "string" },
      out: { type: "string" },
      "json-file": { type: "string" },
      platform: { type: "string" },
      health: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = parsed.positionals[0] ?? "help";
  const store = new RoomStore(resolveRoomDataDir(parsed.values["data-dir"]));
  const roomId = parsed.values.room ?? "demo";

  switch (command) {
    case "init": {
      loadPlatforms(store);
      loadModels(store);
      const room = parsed.values.real
        ? createRealRoom(store, parsed.values.workspace ?? process.cwd())
        : createDemoRoom(store, parsed.values.workspace ?? process.cwd());
      process.stdout.write(`房间已就绪: ${store.roomDir(room.id)}\n`);
      return 0;
    }
    case "run":
      return runCommand(store, roomId, {
        ...parsed.values,
      });
    case "list": {
      const rooms = store.listRooms();
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(rooms, null, 2)}\n`);
        return 0;
      }
      if (rooms.length === 0) {
        process.stdout.write(`没有房间。数据目录: ${store.dataDir}\n`);
        return 0;
      }
      for (const room of rooms) {
        process.stdout.write(`${room.id}\t${room.name}\t${room.members.length} 个成员\t${room.updatedAt}\n`);
      }
      return 0;
    }
    case "show": {
      const room = store.readRoom(roomId);
      process.stdout.write(`${JSON.stringify(room, null, 2)}\n`);
      return 0;
    }
    case "update": {
      const filePath = parsed.values["json-file"];
      if (!filePath) {
        process.stderr.write("缺少 --json-file <room.json>。\n");
        return 2;
      }
      const room = JSON.parse(readFileSync(filePath, "utf8")) as RoomConfig;
      if (!room || room.version !== 1 || !Array.isArray(room.members) || room.members.length === 0) {
        process.stderr.write("房间 JSON 必须包含 version 1 和非空 members。\n");
        return 2;
      }
      if (room.id !== roomId) {
        process.stderr.write(`房间 JSON 的 id (${room.id}) 与 --room (${roomId}) 不一致。\n`);
        return 2;
      }
      room.updatedAt = new Date().toISOString();
      store.writeRoom(room);
      process.stdout.write(`房间已更新: ${store.roomDir(room.id)}\n`);
      return 0;
    }
    case "replay": {
      const events = store.readEvents(roomId);
      if (parsed.values.json) {
        for (const event of events) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        return 0;
      }
      replay(events);
      return 0;
    }
    case "export": {
      const out = parsed.values.out;
      if (!out) {
        process.stderr.write("缺少 --out <目录>。\n");
        return 2;
      }
      const target = store.exportRoom(roomId, out);
      process.stdout.write(`已导出到 ${target}\n`);
      return 0;
    }
    case "platforms": {
      const platforms = loadPlatforms(store);
      const health = new HealthChecker();
      const rows = [];
      for (const platform of platforms) {
        const checked = parsed.values.health ? await health.check(platform) : undefined;
        rows.push({ ...platform, health: checked });
      }
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${row.id}\t${row.name}\t${row.kind}\t${row.enabled === false ? "disabled" : "enabled"}\t${row.health?.status ?? ""}\t${row.health?.detail ?? ""}\n`,
          );
        }
      }
      return 0;
    }
    case "models": {
      if (parsed.positionals[1] === "sync") {
        const result = syncModelsFromAiWorkGate(store);
        process.stdout.write(`模型目录已同步: 新增 ${result.added}，跳过 ${result.skipped}，总数 ${result.total}\n`);
        return 0;
      }
      const models = loadModels(store);
      const filtered = parsed.values.platform
        ? models.filter((model) => model.platformId === parsed.values.platform)
        : models;
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
      } else {
        for (const model of filtered) {
          const vision = model.input?.includes("image") ? "vision" : "text";
          process.stdout.write(
            `${model.platformId}\t${model.modelId}\t${model.displayName}\t${model.contextWindow ?? "?"}\t${vision}\t${model.thinkingLevels?.join("/") ?? "-"}\n`,
          );
        }
      }
      return 0;
    }
    case "capabilities": {
      const manifest = scanCapabilities();
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
        return 0;
      }
      const bySource = new Map<string, number>();
      for (const skill of manifest.skills) {
        bySource.set(skill.source, (bySource.get(skill.source) ?? 0) + 1);
      }
      process.stdout.write(
        `技能 ${manifest.skills.length} 个（${[...bySource].map(([source, count]) => `${source} ${count}`).join("，")}），MCP ${manifest.mcpServers.length} 个\n`,
      );
      for (const server of manifest.mcpServers) {
        process.stdout.write(`MCP\t${server.name}\t${server.source}\n`);
      }
      return 0;
    }
    case "vision": {
      const imagePath = parsed.values.image?.[0] ?? parsed.positionals[1];
      if (!imagePath) {
        process.stderr.write("缺少 --image <图片路径>。\n");
        return 2;
      }
      const timeoutMs = parsed.values.timeout ? Number(parsed.values.timeout) : undefined;
      const result = await describeImage({
        imagePath,
        prompt: parsed.values.prompt,
        command: parsed.values.command,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        cacheDir: join(store.profilesDir, "vision-cache"),
      });
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.status === "completed") {
        process.stdout.write(`${result.description}\n`);
      } else {
        process.stderr.write(`${result.error ?? "vision failed"}\n`);
      }
      return result.status === "completed" ? 0 : 1;
    }
    case "mark-stopped": {
      const reason = parsed.values.reason ?? "human_stop";
      const stopReasons = [
        "done",
        "human_mention",
        "autonomy_low",
        "max_handoffs",
        "budget",
        "context_limit",
        "no_eligible_speaker",
        "human_stop",
        "error",
      ];
      if (!stopReasons.includes(reason)) {
        process.stderr.write(`--reason 必须是 ${stopReasons.join(" / ")} 之一。\n`);
        return 2;
      }
      const events = store.readEvents(roomId);
      if (events.at(-1)?.type === "room_stopped") {
        return 0;
      }
      store.appendEvent(roomId, {
        type: "room_stopped",
        reason: reason as StopReason,
        detail: parsed.values.detail,
      });
      return 0;
    }
    case "help":
    default:
      process.stdout.write(HELP);
      return command === "help" ? 0 : 2;
  }
}

async function runCommand(
  store: RoomStore,
  roomId: string,
  values: {
    prompt?: string;
    workspace?: string;
    real?: boolean;
    fake?: boolean;
    "json-events"?: boolean;
    autonomy?: string;
    "max-handoffs"?: string;
    image?: string[];
  },
): Promise<number> {
  if (!values.prompt?.trim()) {
    process.stderr.write("缺少 --prompt \"...\"。\n");
    return 2;
  }
  const rulesOverride: Partial<RoomRules> = {};
  if (values.autonomy) {
    if (values.autonomy !== "low" && values.autonomy !== "medium" && values.autonomy !== "high") {
      process.stderr.write("--autonomy 只能是 low、medium 或 high。\n");
      return 2;
    }
    rulesOverride.autonomy = values.autonomy;
  }
  if (values["max-handoffs"]) {
    const value = Number(values["max-handoffs"]);
    if (!Number.isInteger(value) || value < 1) {
      process.stderr.write("--max-handoffs 必须是正整数。\n");
      return 2;
    }
    rulesOverride.maxHandoffs = value;
  }

  let room: RoomConfig;
  try {
    room = store.readRoom(roomId);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n先运行 room init --real。\n`);
    return 2;
  }

  const platforms = loadPlatforms(store);
  const models = loadModels(store);
  const sessions = new SessionStore(store, roomId);
  const health = new HealthChecker();
  const router = new RoomBackendRouter({
    store,
    roomId,
    platforms,
    models,
    sessions,
    health,
    fakeBackend: createDemoFakeBackend(),
  });
  const allFake = room.members.every((member) => member.binding.platformId === "fake");
  const useFake = values.fake === true || allFake;
  const backend = useFake ? createDemoFakeBackend() : router;
  const summaryMember = useFake ? undefined : buildSummaryMember(models);
  const summarizer = summaryMember ? createRoomSummarizer(router, summaryMember) : undefined;

  const controller = new AbortController();
  const onSigint = (): void => {
    process.stderr.write("\n收到 Ctrl+C，正在停止房间...\n");
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  const jsonEvents = values["json-events"] === true;
  try {
    const result = await runRoom({
      store,
      roomId,
      prompt: values.prompt,
      images: values.image,
      backend,
      rulesOverride,
      signal: controller.signal,
      summarizer,
      onEvent: (event) => {
        if (jsonEvents) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } else {
          prettyEvent(event);
        }
      },
    });
    if (!jsonEvents) {
      process.stdout.write(
        `\n状态: ${result.status}，停止原因: ${result.stopReason}，agent 回合: ${result.agentTurns}，费用: ¥${result.costYuan.toFixed(2)}\n`,
      );
      process.stdout.write(`事件日志: ${store.roomDir(roomId)}/events.jsonl\n`);
    }
    return result.status === "failed" ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function buildSummaryMember(models: ReturnType<typeof loadModels>): RoomMember | undefined {
  const model = findModel(models, "codex-cli", "glm-5.3-flash")
    ?? models.find((candidate) => candidate.platformId === "codex-cli" && candidate.enabled !== false);
  if (!model) {
    return undefined;
  }
  return {
    id: "__summarizer__",
    name: "摘要器",
    role: "摘要",
    instructions: "压缩房间记录，保留目标、结论、未决问题和约束。",
    binding: {
      platformId: model.platformId,
      modelId: model.modelId,
      thinking: model.defaultThinking,
      contextWindow: model.contextWindow,
      contextBudget: model.contextWindow ? Math.floor(model.contextWindow * 0.7) : undefined,
    },
    behavior: { weight: 0 },
  };
}

function prettyEvent(event: RoomEvent): void {
  switch (event.type) {
    case "user_message":
      process.stdout.write(`\n你: ${event.text}\n`);
      break;
    case "turn_started":
      process.stdout.write(`\n── ${event.memberName} · ${event.platformId}/${event.modelId} ──\n`);
      break;
    case "agent_delta":
      process.stdout.write(event.text);
      break;
    case "agent_message":
      process.stdout.write("\n");
      break;
    case "handoff":
      process.stdout.write(`  ↪ ${event.fromMemberId} → ${event.toMemberId}（${event.reason}）\n`);
      break;
    case "binding_used":
      process.stdout.write(
        `  ⚠ 模型切换: ${event.requested.platformId}/${event.requested.modelId} → ${event.used.platformId}/${event.used.modelId}\n`,
      );
      break;
    case "summary_updated":
      process.stdout.write(`  [摘要已更新] ${event.path}\n`);
      break;
    case "room_stopped":
      process.stdout.write(`\n[停止] ${event.reason}${event.detail ? `：${event.detail}` : ""}\n`);
      break;
    case "error":
      process.stderr.write(`\n[错误] ${event.message}\n`);
      break;
    default:
      break;
  }
}

function replay(events: RoomEvent[]): void {
  for (const event of events) {
    const time = new Date(event.ts).toLocaleTimeString("zh-CN", { hour12: false });
    switch (event.type) {
      case "user_message":
        process.stdout.write(`[${time}] 你: ${event.text}\n`);
        break;
      case "agent_message":
        process.stdout.write(`[${time}] ${event.memberName}: ${event.text}\n`);
        break;
      case "handoff":
        process.stdout.write(`[${time}]   ↪ ${event.fromMemberId} → ${event.toMemberId}（${event.reason}）\n`);
        break;
      case "binding_used":
        process.stdout.write(`[${time}]   ⚠ 模型切换 ${event.used.platformId}/${event.used.modelId}\n`);
        break;
      case "summary_updated":
        process.stdout.write(`[${time}]   [摘要已更新]\n`);
        break;
      case "room_stopped":
        process.stdout.write(`[${time}] [停止] ${event.reason}${event.detail ? `：${event.detail}` : ""}\n`);
        break;
      case "error":
        process.stdout.write(`[${time}] [错误] ${event.message}\n`);
        break;
      default:
        break;
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
