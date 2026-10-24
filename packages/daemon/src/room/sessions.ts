import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoomStore } from "./store.ts";

export interface SessionRecord {
  sessionId: string;
  platformId: string;
  modelId: string;
  updatedAt: string;
}

export class SessionStore {
  private readonly filePath: string;

  constructor(store: RoomStore, roomId: string) {
    this.filePath = join(store.roomDir(roomId), "sessions.json");
  }

  get(memberId: string, platformId: string, modelId: string): string | undefined {
    const record = this.read()[memberId];
    if (!record) {
      return undefined;
    }
    // A session belongs to one platform+model pair; resuming it elsewhere can
    // silently replay a different model's history.
    if (record.platformId !== platformId || record.modelId !== modelId) {
      return undefined;
    }
    return record.sessionId;
  }

  set(memberId: string, sessionId: string, platformId: string, modelId: string): void {
    const sessions = this.read();
    sessions[memberId] = {
      sessionId,
      platformId,
      modelId,
      updatedAt: new Date().toISOString(),
    };
    this.write(sessions);
  }

  clear(memberId: string): void {
    const sessions = this.read();
    if (!(memberId in sessions)) {
      return;
    }
    delete sessions[memberId];
    this.write(sessions);
  }

  read(): Record<string, SessionRecord> {
    if (!existsSync(this.filePath)) {
      return {};
    }
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Session file ${this.filePath} must be a JSON object.`);
    }
    return parsed as Record<string, SessionRecord>;
  }

  private write(sessions: Record<string, SessionRecord>): void {
    writeFileSync(this.filePath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  }
}
