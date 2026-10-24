import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RoomConfig, RoomEvent, RoomEventDraft } from "./types.ts";

const ROOM_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function defaultRoomDataDir(): string {
  if (process.env.AGENT_SPACE_ROOM_DATA) {
    return resolve(process.env.AGENT_SPACE_ROOM_DATA);
  }
  if (process.env.APPDATA) {
    return join(process.env.APPDATA, "AgentSpace", "rooms");
  }
  return join(homedir(), ".local", "share", "AgentSpace", "rooms");
}

export function resolveRoomDataDir(explicit?: string): string {
  return explicit ? resolve(explicit) : defaultRoomDataDir();
}

function assertRoomId(roomId: string): void {
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new Error(`Invalid room id "${roomId}"; use letters, numbers, dot, underscore or dash.`);
  }
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export class RoomStore {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  get profilesDir(): string {
    return join(this.dataDir, ".profiles");
  }

  roomDir(roomId: string): string {
    assertRoomId(roomId);
    return join(this.dataDir, roomId);
  }

  hasRoom(roomId: string): boolean {
    return existsSync(join(this.roomDir(roomId), "room.json"));
  }

  createRoom(config: RoomConfig): RoomConfig {
    const roomDir = this.roomDir(config.id);
    if (existsSync(join(roomDir, "room.json"))) {
      throw new Error(`Room "${config.id}" already exists at ${roomDir}.`);
    }
    if (!config.members.length) {
      throw new Error("A room needs at least one member.");
    }
    mkdirSync(join(roomDir, "runs"), { recursive: true });
    const now = new Date().toISOString();
    const room: RoomConfig = {
      ...config,
      createdAt: config.createdAt || now,
      updatedAt: config.updatedAt || now,
    };
    this.writeRoom(room);
    this.writeBrief(config.id, buildBriefTemplate(room));
    this.appendEvent(config.id, { type: "room_created", name: room.name });
    return room;
  }

  readRoom(roomId: string): RoomConfig {
    const filePath = join(this.roomDir(roomId), "room.json");
    if (!existsSync(filePath)) {
      throw new Error(`Room "${roomId}" not found at ${filePath}.`);
    }
    const value = readJsonFile<unknown>(filePath);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Room config ${filePath} must be a JSON object.`);
    }
    const room = value as RoomConfig;
    if (room.version !== 1) {
      throw new Error(`Room config ${filePath} has unsupported version ${String(room.version)}.`);
    }
    if (!Array.isArray(room.members) || room.members.length === 0) {
      throw new Error(`Room config ${filePath} must define a non-empty members array.`);
    }
    if (!room.rules || typeof room.rules !== "object") {
      throw new Error(`Room config ${filePath} must define rules.`);
    }
    return room;
  }

  writeRoom(room: RoomConfig): void {
    const roomDir = this.roomDir(room.id);
    mkdirSync(roomDir, { recursive: true });
    mkdirSync(join(roomDir, "runs"), { recursive: true });
    writeFileSync(join(roomDir, "room.json"), `${JSON.stringify(room, null, 2)}\n`, "utf8");
  }

  listRooms(): RoomConfig[] {
    if (!existsSync(this.dataDir)) {
      return [];
    }
    const rooms: RoomConfig[] = [];
    for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ROOM_ID_PATTERN.test(entry.name)) {
        continue;
      }
      const filePath = join(this.dataDir, entry.name, "room.json");
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        const room = this.readRoom(entry.name);
        if (room.id === entry.name) {
          rooms.push(room);
        }
      } catch {
        // A broken room folder should not hide the healthy ones.
      }
    }
    return rooms.sort((left, right) => left.id.localeCompare(right.id));
  }

  appendEvent(roomId: string, draft: RoomEventDraft): RoomEvent {
    const roomDir = this.roomDir(roomId);
    mkdirSync(roomDir, { recursive: true });
    const event = {
      ...draft,
      v: 1 as const,
      id: `evt-${randomUUID()}`,
      ts: new Date().toISOString(),
      roomId,
    } as RoomEvent;
    appendFileSync(join(roomDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  readEvents(roomId: string): RoomEvent[] {
    const filePath = join(this.roomDir(roomId), "events.jsonl");
    if (!existsSync(filePath)) {
      return [];
    }
    const events: RoomEvent[] = [];
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as RoomEvent;
        if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.type !== "string") {
          throw new Error("event is not a v1 room event");
        }
        events.push(parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid room event at ${filePath}:${index + 1}: ${message}`);
      }
    }
    return events;
  }

  writeRunArtifact(roomId: string, turnId: string, payload: unknown): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(turnId)) {
      throw new Error(`Invalid turn id "${turnId}".`);
    }
    const runsDir = join(this.roomDir(roomId), "runs");
    mkdirSync(runsDir, { recursive: true });
    const filePath = join(runsDir, `${turnId}.json`);
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return filePath;
  }

  readBrief(roomId: string): string {
    return this.readOptionalText(join(this.roomDir(roomId), "brief.md"));
  }

  writeBrief(roomId: string, text: string): void {
    mkdirSync(this.roomDir(roomId), { recursive: true });
    writeFileSync(join(this.roomDir(roomId), "brief.md"), text, "utf8");
  }

  readSummary(roomId: string): string {
    return this.readOptionalText(join(this.roomDir(roomId), "summary.md"));
  }

  writeSummary(roomId: string, text: string): void {
    mkdirSync(this.roomDir(roomId), { recursive: true });
    writeFileSync(join(this.roomDir(roomId), "summary.md"), text, "utf8");
  }

  exportRoom(roomId: string, outDir: string): string {
    const source = this.roomDir(roomId);
    const target = resolve(outDir);
    if (existsSync(target)) {
      throw new Error(`Export target ${target} already exists; choose a new folder.`);
    }
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    return target;
  }

  private readOptionalText(filePath: string): string {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  }
}

function buildBriefTemplate(room: RoomConfig): string {
  const members = room.members.map((member) => `- ${member.name}：${member.role}`).join("\n");
  return [
    "# 房间简报",
    "",
    "## 目标",
    "（写下当前任务的目标；这份简报每回合都会被所有成员看到。）",
    "",
    "## 成员",
    members,
    "",
    "## 已定结论",
    "",
    "## 未决问题",
    "",
    "## 约束与禁止事项",
    "- v1 只读：不修改工作区文件。",
    "- 交接时在回复里写 @成员名；任务完成时以 DONE 结尾。",
    "",
  ].join("\n");
}
