import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoomStore } from "./store.ts";
import type { AgentBackend, RoomConfig, RoomEvent, RoomMember } from "./types.ts";
import { formatConversation } from "./transcript.ts";

const MAX_BTW_PER_ROOM = 20;
const MAX_CONCURRENT = 2;
const BTW_LOCK_STALE_MS = 30 * 60 * 1000;

export interface BtwRecord {
  id: string;
  roomId: string;
  question: string;
  answer: string;
  status: "completed" | "failed";
  memberId: string;
  memberName: string;
  platformId: string;
  modelId: string;
  costYuan?: number;
  usageTokens?: number;
  error?: string;
  createdAt: string;
  promotedMessageId?: string;
}

export function btwFilePath(store: RoomStore, roomId: string): string {
  return join(store.roomDir(roomId), "btw.jsonl");
}

export function listBtw(store: RoomStore, roomId: string): BtwRecord[] {
  const filePath = btwFilePath(store, roomId);
  if (!existsSync(filePath)) return [];
  const byId = new Map<string, BtwRecord>();
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as BtwRecord;
      const previous = byId.get(record.id);
      byId.set(record.id, previous ? { ...previous, ...record } : record);
    } catch {
      // Skip corrupt lines.
    }
  }
  return [...byId.values()];
}

function appendBtw(store: RoomStore, roomId: string, record: BtwRecord): void {
  mkdirSync(store.roomDir(roomId), { recursive: true });
  appendFileSync(btwFilePath(store, roomId), `${JSON.stringify(record)}\n`, "utf8");
}

const activeLocks = new Set<string>();

export function acquireBtwSlot(store: RoomStore, roomId: string): () => void {
  const lockDir = join(store.roomDir(roomId), "btw-locks");
  mkdirSync(lockDir, { recursive: true });
  const now = Date.now();
  for (const entry of readdirSync(lockDir)) {
    const filePath = join(lockDir, entry);
    try {
      if (now - statSync(filePath).mtimeMs > BTW_LOCK_STALE_MS) rmSync(filePath, { force: true });
    } catch {
      // Another process may have cleaned it.
    }
  }
  if (readdirSync(lockDir).filter((entry) => entry.endsWith(".lock")).length >= MAX_CONCURRENT) {
    throw new Error(`btw 最多同时 ${MAX_CONCURRENT} 个；请等当前问题结束。`);
  }
  const token = `${roomId}-${randomUUID()}`;
  activeLocks.add(token);
  const lockPath = join(lockDir, `${token}.lock`);
  try {
    writeFileSync(lockPath, "", { flag: "wx" });
  } catch {
    activeLocks.delete(token);
    throw new Error("btw 正在启动，请稍后重试。");
  }
  return () => {
    activeLocks.delete(token);
    rmSync(lockPath, { force: true });
  };
}

export async function askBtw(options: {
  store: RoomStore;
  room: RoomConfig;
  backend: AgentBackend;
  question: string;
  member?: RoomMember;
  contextEvents?: RoomEvent[];
  signal?: AbortSignal;
}): Promise<BtwRecord> {
  const question = String(options.question || "").trim();
  if (!question) throw new Error("btw 问题不能为空。");
  const records = listBtw(options.store, options.room.id);
  if (records.length >= MAX_BTW_PER_ROOM) {
    throw new Error(`本房间 btw 已达上限 ${MAX_BTW_PER_ROOM} 条。`);
  }
  const member = options.member ?? options.room.members[0];
  if (!member) throw new Error("房间没有成员。");
  const context = formatConversation(options.contextEvents ?? [], 12);
  const prompt = [
    "这是一次只读侧问（btw），不要调用工具，不要修改任何文件，也不要 @ 其他成员。",
    `房间：${options.room.name}`,
    context ? `最近对话：\n${context}` : "",
    `问题：\n${question}`,
    "用简洁的中文回答，必要时指出不确定性。",
  ].filter(Boolean).join("\n\n");
  const release = acquireBtwSlot(options.store, options.room.id);
  const startedAt = new Date().toISOString();
  try {
  let answer = "";
  let costYuan: number | undefined;
  let usageTokens: number | undefined;
  let status: BtwRecord["status"] = "failed";
  let error: string | undefined;
  try {
    const result = await options.backend.runTurn({
      room: { ...options.room, workspace: options.room.workspace },
      member,
      prompt,
      turnId: `btw-${randomUUID()}`,
      signal: options.signal,
      writeMode: false,
    });
    answer = result.text;
    costYuan = result.costYuan;
    usageTokens = result.usage?.totalTokens;
    status = result.status === "completed" ? "completed" : "failed";
    error = result.error;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const record: BtwRecord = {
    id: `btw-${Date.now().toString(36)}-${randomUUID().slice(0, 5)}`,
    roomId: options.room.id,
    question,
    answer,
    status,
    memberId: member.id,
    memberName: member.name,
    platformId: member.binding.platformId,
    modelId: member.binding.modelId,
    costYuan,
    usageTokens,
    error,
    createdAt: startedAt,
  };
  appendBtw(options.store, options.room.id, record);
  if (status === "failed") {
    throw new Error(error || "btw 失败。");
  }
  return record;
  } finally {
    release();
  }
}

export function promoteBtw(store: RoomStore, roomId: string, btwId: string): { record: BtwRecord; messageId: string } {
  const records = listBtw(store, roomId);
  const record = records.find((item) => item.id === btwId);
  if (!record) throw new Error(`btw ${btwId} 不存在。`);
  if (record.promotedMessageId) {
    return { record, messageId: record.promotedMessageId };
  }
  const messageId = `msg-${randomUUID()}`;
  store.appendEvent(roomId, {
    type: "user_message",
    messageId,
    text: `[btw] ${record.question}\n\n${record.answer}`,
  });
  record.promotedMessageId = messageId;
  appendFileSync(
    btwFilePath(store, roomId),
    `${JSON.stringify({ ...record, promoted: true, promotedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
  return { record, messageId };
}
