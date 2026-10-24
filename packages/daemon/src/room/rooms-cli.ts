#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createDemoFakeBackend } from "./backends/fake.ts";
import { createDemoRoom } from "./demo.ts";
import { runRoom } from "./engine.ts";
import { RoomStore, resolveRoomDataDir } from "./store.ts";
import type { RoomEvent, RoomRules } from "./types.ts";

const HELP = `AgentHub room CLI (Phase 1, fake backend)

用法:
  room init [--data-dir <dir>] [--workspace <path>]
  room run --prompt "..." [--room demo] [--data-dir <dir>] [--autonomy low|medium|high] [--max-handoffs 8] [--json-events]
  room list [--data-dir <dir>]
  room replay [--room demo] [--data-dir <dir>] [--json]
  room export --out <dir> [--room demo] [--data-dir <dir>]

说明:
  Phase 1 使用假后端，只验证回合、交接、上限、JSONL 记录和回放。
`;

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      room: { type: "string", default: "demo" },
      prompt: { type: "string" },
      workspace: { type: "string" },
      "json-events": { type: "boolean", default: false },
      autonomy: { type: "string" },
      "max-handoffs": { type: "string" },
      out: { type: "string" },
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
      const room = createDemoRoom(store, parsed.values.workspace ?? process.cwd());
      process.stdout.write(`房间已就绪: ${store.roomDir(room.id)}\n`);
      return 0;
    }
    case "run":
      return runCommand(store, roomId, parsed.values);
    case "list": {
      const rooms = store.listRooms();
      if (rooms.length === 0) {
        process.stdout.write(`没有房间。数据目录: ${store.dataDir}\n`);
        return 0;
      }
      for (const room of rooms) {
        process.stdout.write(`${room.id}\t${room.name}\t${room.members.length} 个成员\t${room.updatedAt}\n`);
      }
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
    "json-events"?: boolean;
    autonomy?: string;
    "max-handoffs"?: string;
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
      backend: createDemoFakeBackend(),
      rulesOverride,
      signal: controller.signal,
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

function prettyEvent(event: RoomEvent): void {
  switch (event.type) {
    case "user_message":
      process.stdout.write(`\n你: ${event.text}\n`);
      break;
    case "turn_started":
      process.stdout.write(`\n── ${event.memberName} · ${event.modelId} ──\n`);
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
