import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoomStore } from "./store.ts";
import type { RoomEventDraft } from "./types.ts";

const TASK_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export type TaskStatus =
  | "backlog"
  | "ready"
  | "running"
  | "review"
  | "merge_ready"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled"
  | "conflict"
  | "budget_paused"
  | "interrupted";

export interface TaskVerification {
  command: string;
  exitCode: number | null;
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface TaskReview {
  reviewerMemberId?: string;
  verdict: "approved" | "rejected" | "skipped";
  notes: string;
}

export interface TaskReport {
  version: 1;
  taskId: string;
  summary: string;
  risks: string[];
  nextSteps: string[];
  commit?: string;
  files: string[];
  diffstat: string;
  verification?: TaskVerification;
  review?: TaskReview;
  costYuan?: number;
  usageTokens?: number;
  agentText?: string;
  generatedAt: string;
}

export interface RoomTask {
  id: string;
  title: string;
  description: string;
  ownerMemberId: string;
  acceptance: string;
  dependsOn: string[];
  status: TaskStatus;
  sourceMessageId?: string;
  verificationCommand?: string;
  allowedPaths?: string[];
  pinnedMessages?: string[];
  budgetYuan?: number;
  autoMerge?: boolean;
  reviewerMemberId?: string;
  attempt: number;
  worktreePath?: string;
  branch?: string;
  costYuan?: number;
  usageTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  lastError?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface TaskFile {
  version: 1;
  tasks: RoomTask[];
}

export interface CreateTaskInput {
  title: string;
  description: string;
  ownerMemberId: string;
  acceptance: string;
  dependsOn?: string[];
  sourceMessageId?: string;
  verificationCommand?: string;
  allowedPaths?: string[];
  pinnedMessages?: string[];
  budgetYuan?: number;
  autoMerge?: boolean;
  reviewerMemberId?: string;
  id?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  ownerMemberId?: string;
  acceptance?: string;
  dependsOn?: string[];
  verificationCommand?: string | null;
  allowedPaths?: string[] | null;
  pinnedMessages?: string[] | null;
  budgetYuan?: number | null;
  autoMerge?: boolean;
  reviewerMemberId?: string | null;
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready", "cancelled"],
  ready: ["backlog", "running", "cancelled"],
  running: ["review", "failed", "blocked", "cancelled", "conflict", "budget_paused", "interrupted"],
  interrupted: ["ready", "cancelled"],
  review: ["merge_ready", "failed", "blocked", "cancelled"],
  merge_ready: ["done", "conflict", "failed"],
  failed: ["ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  conflict: ["ready", "cancelled"],
  budget_paused: ["ready", "cancelled"],
  done: [],
  cancelled: [],
};

export function tasksFilePath(store: RoomStore, roomId: string): string {
  return join(store.roomDir(roomId), "tasks.json");
}

export function taskDir(store: RoomStore, roomId: string, taskId: string): string {
  assertTaskId(taskId);
  return join(store.roomDir(roomId), "tasks", taskId);
}

export function taskEventsPath(store: RoomStore, roomId: string, taskId: string): string {
  return join(taskDir(store, roomId, taskId), "events.jsonl");
}

export function taskReportPath(store: RoomStore, roomId: string, taskId: string): string {
  return join(taskDir(store, roomId, taskId), "report.json");
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Invalid task id "${taskId}"; use letters, numbers, dot, underscore or dash.`);
  }
}

export function loadTasks(store: RoomStore, roomId: string): RoomTask[] {
  const filePath = tasksFilePath(store, roomId);
  if (!existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Task snapshot ${filePath} must be a JSON object.`);
  }
  const record = parsed as Partial<TaskFile>;
  if (record.version !== 1 || !Array.isArray(record.tasks)) {
    throw new Error(`Task snapshot ${filePath} must contain version 1 and a tasks array.`);
  }
  return record.tasks as RoomTask[];
}

export function saveTasks(store: RoomStore, roomId: string, tasks: RoomTask[]): void {
  const roomDir = store.roomDir(roomId);
  mkdirSync(roomDir, { recursive: true });
  const payload: TaskFile = { version: 1, tasks };
  writeFileSync(tasksFilePath(store, roomId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function findTask(store: RoomStore, roomId: string, taskId: string): RoomTask | undefined {
  return loadTasks(store, roomId).find((task) => task.id === taskId);
}

export function requireTask(store: RoomStore, roomId: string, taskId: string): RoomTask {
  const task = findTask(store, roomId, taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" not found in room "${roomId}".`);
  }
  return task;
}

export function appendTaskEvent(store: RoomStore, roomId: string, taskId: string, event: Record<string, unknown>): void {
  mkdirSync(taskDir(store, roomId, taskId), { recursive: true });
  appendFileSync(
    taskEventsPath(store, roomId, taskId),
    `${JSON.stringify({ ...event, ts: new Date().toISOString(), taskId })}\n`,
    "utf8",
  );
}

export function readTaskEvents(store: RoomStore, roomId: string, taskId: string): Array<Record<string, unknown>> {
  const filePath = taskEventsPath(store, roomId, taskId);
  if (!existsSync(filePath)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip a corrupt line; task history is still useful.
    }
  }
  return events;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 3 ? slug : `task-${randomUUID().slice(0, 6)}`;
}

function uniqueTaskId(base: string, tasks: RoomTask[]): string {
  let id = base;
  let suffix = 2;
  while (tasks.some((task) => task.id === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function assertNoCycle(tasks: RoomTask[], taskId: string, dependsOn: string[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depsFor = (id: string): string[] => (id === taskId ? dependsOn : byId.get(id)?.dependsOn ?? []);
  const visit = (id: string, stack: Set<string>): void => {
    if (stack.has(id)) {
      throw new Error(`Task dependency cycle detected at "${id}".`);
    }
    stack.add(id);
    for (const dep of depsFor(id)) {
      visit(dep, stack);
    }
    stack.delete(id);
  };
  for (const dep of dependsOn) {
    if (dep === taskId) {
      throw new Error("A task cannot depend on itself.");
    }
    visit(dep, new Set());
  }
}

function normalizePaths(paths: string[] | undefined): string[] | undefined {
  if (!paths) return undefined;
  const cleaned = paths
    .map((item) => item.trim().split(/[\\/]+/).filter(Boolean).join("/"))
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function dependenciesDone(tasks: RoomTask[], task: RoomTask): boolean {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  return task.dependsOn.every((id) => byId.get(id)?.status === "done");
}

export function createTask(store: RoomStore, roomId: string, input: CreateTaskInput): RoomTask {
  const room = store.readRoom(roomId);
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  const acceptance = String(input.acceptance || "").trim();
  const ownerMemberId = String(input.ownerMemberId || "").trim();
  if (!title) throw new Error("Task title is required.");
  if (!description) throw new Error("Task description is required.");
  if (!acceptance) throw new Error("Task acceptance criteria are required.");
  if (!room.members.some((member) => member.id === ownerMemberId)) {
    throw new Error(`Owner member "${ownerMemberId}" is not in the room.`);
  }
  const tasks = loadTasks(store, roomId);
  const dependsOn = [...new Set((input.dependsOn ?? []).map((id) => id.trim()).filter(Boolean))];
  for (const dep of dependsOn) {
    if (!tasks.some((task) => task.id === dep)) {
      throw new Error(`Dependency "${dep}" does not exist.`);
    }
  }
  const id = input.id ? String(input.id) : uniqueTaskId(slugify(title), tasks);
  assertTaskId(id);
  if (tasks.some((task) => task.id === id)) {
    throw new Error(`Task "${id}" already exists.`);
  }
  assertNoCycle(tasks, id, dependsOn);
  const now = new Date().toISOString();
  const task: RoomTask = {
    id,
    title,
    description,
    ownerMemberId,
    acceptance,
    dependsOn,
    status: dependsOn.length === 0 ? "ready" : "backlog",
    sourceMessageId: input.sourceMessageId,
    verificationCommand: input.verificationCommand?.trim() || undefined,
    allowedPaths: normalizePaths(input.allowedPaths),
    pinnedMessages: input.pinnedMessages?.map((item) => String(item).trim()).filter(Boolean).length
      ? input.pinnedMessages.map((item) => String(item).trim()).filter(Boolean)
      : undefined,
    budgetYuan: input.budgetYuan,
    autoMerge: input.autoMerge === true,
    reviewerMemberId: input.reviewerMemberId,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(task);
  saveTasks(store, roomId, tasks);
  store.appendEvent(roomId, {
    type: "task_created",
    taskId: task.id,
    title: task.title,
    status: task.status,
    ownerMemberId: task.ownerMemberId,
    sourceMessageId: task.sourceMessageId,
  });
  appendTaskEvent(store, roomId, task.id, { type: "task_created", status: task.status });
  return task;
}

export function updateTask(store: RoomStore, roomId: string, taskId: string, input: UpdateTaskInput): RoomTask {
  const tasks = loadTasks(store, roomId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  const room = store.readRoom(roomId);
  const locked = task.status === "running" || task.status === "interrupted";
  const fields: string[] = [];
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error("Task title cannot be empty.");
    task.title = title;
    fields.push("title");
  }
  if (input.description !== undefined) {
    const description = input.description.trim();
    if (!description) throw new Error("Task description cannot be empty.");
    task.description = description;
    fields.push("description");
  }
  if (input.acceptance !== undefined) {
    if (locked) throw new Error("Acceptance criteria are locked while the task is running.");
    const acceptance = input.acceptance.trim();
    if (!acceptance) throw new Error("Acceptance criteria cannot be empty.");
    task.acceptance = acceptance;
    fields.push("acceptance");
  }
  if (input.ownerMemberId !== undefined) {
    if (locked) throw new Error("Owner is locked while the task is running.");
    const owner = input.ownerMemberId.trim();
    if (!room.members.some((member) => member.id === owner)) {
      throw new Error(`Owner member "${owner}" is not in the room.`);
    }
    task.ownerMemberId = owner;
    fields.push("ownerMemberId");
  }
  if (input.dependsOn !== undefined) {
    if (locked) throw new Error("Dependencies are locked while the task is running.");
    const dependsOn = [...new Set(input.dependsOn.map((id) => id.trim()).filter(Boolean))];
    for (const dep of dependsOn) {
      if (dep !== task.id && !tasks.some((item) => item.id === dep)) {
        throw new Error(`Dependency "${dep}" does not exist.`);
      }
    }
    assertNoCycle(tasks, task.id, dependsOn);
    task.dependsOn = dependsOn;
    fields.push("dependsOn");
  }
  if (input.verificationCommand !== undefined) {
    task.verificationCommand = input.verificationCommand?.trim() || undefined;
    fields.push("verificationCommand");
  }
  if (input.allowedPaths !== undefined) {
    task.allowedPaths = normalizePaths(input.allowedPaths ?? undefined);
    fields.push("allowedPaths");
  }
  if (input.pinnedMessages !== undefined) {
    task.pinnedMessages = (input.pinnedMessages ?? []).map((item) => String(item).trim()).filter(Boolean);
    if (task.pinnedMessages.length === 0) task.pinnedMessages = undefined;
    fields.push("pinnedMessages");
  }
  if (input.budgetYuan !== undefined) {
    task.budgetYuan = input.budgetYuan ?? undefined;
    fields.push("budgetYuan");
  }
  if (input.autoMerge !== undefined) {
    task.autoMerge = input.autoMerge;
    fields.push("autoMerge");
  }
  if (input.reviewerMemberId !== undefined) {
    const reviewer = input.reviewerMemberId?.trim() || undefined;
    if (reviewer && !room.members.some((member) => member.id === reviewer)) {
      throw new Error(`Reviewer member "${reviewer}" is not in the room.`);
    }
    task.reviewerMemberId = reviewer;
    fields.push("reviewerMemberId");
  }
  task.updatedAt = new Date().toISOString();
  saveTasks(store, roomId, tasks);
  if (fields.length > 0) {
    store.appendEvent(roomId, { type: "task_updated", taskId, fields });
    appendTaskEvent(store, roomId, taskId, { type: "task_updated", fields });
  }
  return task;
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) === true;
}

export function setTaskStatus(  store: RoomStore,
  roomId: string,
  taskId: string,
  to: TaskStatus,
  detail?: string,
): RoomTask {
  const tasks = loadTasks(store, roomId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  const from = task.status;
  if (from === to) return task;
  if (!canTransition(from, to)) {
    throw new Error(`Task cannot move from ${from} to ${to}.`);
  }
  if (to === "ready" && !dependenciesDone(tasks, task)) {
    throw new Error(`Task "${taskId}" still has unfinished dependencies.`);
  }
  task.status = to;
  task.updatedAt = new Date().toISOString();
  if (to === "running") {
    task.startedAt = task.updatedAt;
    task.lastError = undefined;
  }
  if (["done", "cancelled", "failed", "merge_ready"].includes(to)) {
    task.finishedAt = task.updatedAt;
  }
  if (detail && ["failed", "blocked", "conflict", "budget_paused", "interrupted"].includes(to)) {
    task.lastError = detail;
  }
  saveTasks(store, roomId, tasks);
  store.appendEvent(roomId, { type: "task_status", taskId, from, to, detail });
  appendTaskEvent(store, roomId, taskId, { type: "task_status", from, to, detail });
  return task;
}

export function archiveTask(store: RoomStore, roomId: string, taskId: string): RoomTask {
  const tasks = loadTasks(store, roomId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  if (task.status === "running") throw new Error("运行中的任务不能归档。");
  if (task.archivedAt) return task;
  task.archivedAt = new Date().toISOString();
  task.updatedAt = task.archivedAt;
  saveTasks(store, roomId, tasks);
  store.appendEvent(roomId, { type: "task_archived", taskId, status: task.status });
  appendTaskEvent(store, roomId, taskId, { type: "task_archived", status: task.status });
  return task;
}

export function restoreTask(store: RoomStore, roomId: string, taskId: string): RoomTask {
  const tasks = loadTasks(store, roomId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  if (!task.archivedAt) return task;
  delete task.archivedAt;
  task.updatedAt = new Date().toISOString();
  saveTasks(store, roomId, tasks);
  store.appendEvent(roomId, { type: "task_restored", taskId, status: task.status });
  appendTaskEvent(store, roomId, taskId, { type: "task_restored", status: task.status });
  return task;
}

export function recordTaskReport(store: RoomStore, roomId: string, taskId: string, report: TaskReport): RoomTask {
  const tasks = loadTasks(store, roomId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  mkdirSync(taskDir(store, roomId, taskId), { recursive: true });
  writeFileSync(taskReportPath(store, roomId, taskId), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  task.costYuan = report.costYuan;
  task.updatedAt = new Date().toISOString();
  saveTasks(store, roomId, tasks);
  store.appendEvent(roomId, { type: "task_report", taskId, path: "report.json", status: task.status });
  appendTaskEvent(store, roomId, taskId, { type: "task_report", path: "report.json", status: task.status });
  return task;
}

export function readTaskReport(store: RoomStore, roomId: string, taskId: string): TaskReport | undefined {
  const filePath = taskReportPath(store, roomId, taskId);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as TaskReport;
  } catch {
    return undefined;
  }
}

export function recoverRunningTasks(store: RoomStore, roomId: string): number {
  const tasks = loadTasks(store, roomId);
  let recovered = 0;
  for (const task of tasks) {
    if (task.status === "running") {
      task.status = "interrupted";
      task.lastError = "应用上次退出时任务仍在运行";
      task.updatedAt = new Date().toISOString();
      recovered += 1;
      appendTaskEvent(store, roomId, task.id, { type: "task_status", from: "running", to: "interrupted", detail: task.lastError });
    }
  }
  if (recovered > 0) {
    saveTasks(store, roomId, tasks);
    store.appendEvent(roomId, {
      type: "task_status",
      taskId: "__recovery__",
      from: "running",
      to: "interrupted",
      detail: `${recovered} 个任务在上次退出时仍在运行`,
    });
  }
  return recovered;
}

export function readyTasks(store: RoomStore, roomId: string): RoomTask[] {
  const tasks = loadTasks(store, roomId);
  return tasks.filter((task) => task.status === "ready" && dependenciesDone(tasks, task));
}

export function buildTaskPrompt(args: {
  roomName: string;
  brief: string;
  task: RoomTask;
  dependencyReports: Array<{ taskId: string; summary: string; risks: string[] }>;
  allowedPaths?: string[];
  verificationCommand?: string;
  stopToken: string;
  writeRoot: string;
  extraPinned?: string[];
}): string {
  const { task } = args;
  return [
    `你正在执行任务「${task.title}」（${task.id}），房间：${args.roomName}。`,
    "这是隔离的 git worktree；只允许修改当前工作目录内的文件。不要修改主工作区。",
    `工作目录：${args.writeRoot}`,
    `任务描述：\n${task.description}`,
    `验收标准：\n${task.acceptance}`,
    args.allowedPaths && args.allowedPaths.length > 0
      ? `允许修改的路径（相对 worktree）：\n${args.allowedPaths.map((path) => `- ${path}`).join("\n")}`
      : "允许修改整个 worktree，但不要触碰无关文件。",
    args.verificationCommand ? `完成后会运行验证命令：${args.verificationCommand}` : "",
    args.dependencyReports.length > 0
      ? `依赖任务报告：\n${args.dependencyReports.map((item) => `- ${item.taskId}: ${item.summary}${item.risks.length ? `（风险：${item.risks.join("；")}）` : ""}`).join("\n")}`
      : "",
    args.extraPinned && args.extraPinned.length > 0 ? `固定参考消息：\n${args.extraPinned.join("\n")}` : "",
    `房间简报：\n${args.brief || "（空）"}`,
    `请直接完成实现，写出必要文件，运行你认为必要的检查。完成后以 ${args.stopToken} 结尾，并简要说明改了什么、有什么风险。`,
  ].filter(Boolean).join("\n\n");
}

export function taskEventDraft(event: Record<string, unknown>): RoomEventDraft {
  return event as unknown as RoomEventDraft;
}
