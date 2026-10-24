import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { RoomStore } from "./store.ts";
import type { AgentBackend, RoomConfig, RoomMember } from "./types.ts";
import { graphImpact, graphStatus, graphSync } from "./codegraph.ts";
import {
  appendTaskEvent,
  buildTaskPrompt,
  findTask,
  loadTasks,
  readTaskReport,
  recordTaskReport,
  requireTask,
  saveTasks,
  setTaskStatus,
  type RoomTask,
  type TaskReport,
  type TaskReview,
  type TaskStatus,
  type TaskVerification,
} from "./tasks.ts";
import {
  changedPaths,
  commitAll,
  createTaskWorktree,
  currentBranch,
  diffStat,
  diffText,
  discardWorktree,
  mergeFastForward,
  rebaseOnto,
  abortRebase,
  requireGitRoot,
} from "./worktrees.ts";

const MAX_ACTIVE_TASKS = 2;
const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface TaskRunOptions {
  store: RoomStore;
  roomId: string;
  taskId: string;
  backend: AgentBackend;
  signal?: AbortSignal;
  verificationTimeoutMs?: number;
  roomBudgetYuan?: number;
  priorRoomCostYuan?: number;
  onProgress?: (message: string) => void;
}

export interface TaskRunResult {
  task: RoomTask;
  report?: TaskReport;
  error?: string;
}

interface Slot {
  release: () => void;
}

function acquireSlot(store: RoomStore, roomId: string, taskId: string): Slot {
  const lockDir = join(store.roomDir(roomId), "locks");
  mkdirSync(lockDir, { recursive: true });
  const now = Date.now();
  for (const entry of readdirSync(lockDir)) {
    const filePath = join(lockDir, entry);
    try {
      if (now - statSync(filePath).mtimeMs > LOCK_MAX_AGE_MS) {
        unlinkSync(filePath);
      }
    } catch {
      // Another process may have removed it.
    }
  }
  const active = readdirSync(lockDir).filter((entry) => entry.endsWith(".lock"));
  if (active.length >= MAX_ACTIVE_TASKS) {
    throw new Error(`本房间已有 ${active.length} 个任务在运行；上限 ${MAX_ACTIVE_TASKS}。`);
  }
  const lockPath = join(lockDir, `${taskId}.lock`);
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
  } catch {
    throw new Error(`任务 ${taskId} 已在运行。`);
  }
  return {
    release: () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Lock may already be gone.
      }
    },
  };
}

function patchTask(store: RoomStore, roomId: string, taskId: string, patch: Partial<RoomTask>): RoomTask {
  const tasks = loadTasks(store, roomId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  saveTasks(store, roomId, tasks);
  return task;
}

function pickMember(room: RoomConfig, memberId: string): RoomMember {
  const member = room.members.find((item) => item.id === memberId);
  if (!member) throw new Error(`成员 ${memberId} 不在房间里。`);
  return member;
}

function extractList(text: string, keyword: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const results: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (keyword.test(line)) {
      collecting = true;
      const inline = line.replace(keyword, "").replace(/^[:：\s]+/, "").trim();
      if (inline && !/^[（(]?$/.test(inline)) results.push(inline);
      continue;
    }
    if (collecting) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (results.length > 0) break;
        continue;
      }
      if (/^[-*•]\s+/.test(trimmed)) {
        results.push(trimmed.replace(/^[-*•]\s+/, ""));
      } else {
        break;
      }
    }
  }
  return results.slice(0, 6);
}

function summarizeText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 600 ? `${cleaned.slice(0, 600)}…` : cleaned;
}

function pathAllowed(file: string, allowedPaths: string[] | undefined): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true;
  const normalized = file.split(/[\\/]+/).join("/");
  return allowedPaths.some((allowed) => {
    const prefix = allowed.split(/[\\/]+/).filter(Boolean).join("/");
    return prefix === "" || prefix === "." || normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

async function runVerification(
  worktree: string,
  command: string,
  timeoutMs: number,
): Promise<TaskVerification> {
  const started = Date.now();
  return await new Promise<TaskVerification>((resolve) => {
    const child = spawn(command, [], {
      cwd: worktree,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output += String(chunk);
      if (output.length > 200_000) output = output.slice(0, 200_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
      }
    }, timeoutMs);
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        passed: !timedOut && exitCode === 0,
        output: output.trim(),
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export async function runTask(options: TaskRunOptions): Promise<TaskRunResult> {
  const { store, roomId, taskId, backend } = options;
  const room = store.readRoom(roomId);
  const initial = requireTask(store, roomId, taskId);
  if (initial.status === "running") {
    throw new Error(`任务 ${taskId} 已在运行。`);
  }
  if (initial.status !== "ready" && initial.status !== "interrupted") {
    throw new Error(`任务当前状态是 ${initial.status}；先移到 ready 再运行。`);
  }
  if (!room.workspace) {
    throw new Error("纯聊天房间没有工作区，不能运行任务。");
  }
  if (room.rules.allowTaskWrites === false) {
    throw new Error("房间规则已关闭任务写入。");
  }
  const repo = requireGitRoot(room.workspace);
  const slot = acquireSlot(store, roomId, taskId);
  let worktreePath = "";
  try {
    const worktree = createTaskWorktree({ repo, taskId, requireClean: true });
    worktreePath = worktree.path;
    let task = patchTask(store, roomId, taskId, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      attempt: initial.attempt + 1,
    });
    task = setTaskStatus(store, roomId, taskId, "running");
    options.onProgress?.(`worktree: ${worktree.path}`);

    const ownerBase = pickMember(room, task.ownerMemberId);
    const owner: RoomMember = { ...ownerBase, id: `${ownerBase.id}__task_${taskId}` };
    const dependencyReports = task.dependsOn
      .map((dep) => {
        const report = readTaskReport(store, roomId, dep);
        return report ? { taskId: dep, summary: report.summary, risks: report.risks } : undefined;
      })
      .filter((item): item is { taskId: string; summary: string; risks: string[] } => Boolean(item));
    let graphNote = "";
    try {
      const graph = graphStatus(repo);
      if (graph.available) {
        if (graph.stale) graphSync(repo, 60_000);
        const impact = graphImpact(repo, task.title);
        if (impact.ok && impact.data !== undefined) {
          graphNote = JSON.stringify(impact.data).slice(0, 4000);
        }
      }
    } catch {
      // codegraph is optional; task execution must not depend on it.
    }
    const prompt = buildTaskPrompt({
      roomName: room.name,
      brief: store.readBrief(roomId),
      task,
      dependencyReports,
      allowedPaths: task.allowedPaths,
      verificationCommand: task.verificationCommand,
      stopToken: room.rules.stopToken ?? "DONE",
      writeRoot: worktree.path,
      extraPinned: [
        ...(task.pinnedMessages ?? []),
        ...(graphNote ? [`codegraph 影响范围（自动注入，仅供参考）：${graphNote}`] : []),
      ],
    });

    appendTaskEvent(store, roomId, taskId, { type: "task_turn_started", phase: "owner", memberId: owner.id, attempt: task.attempt });
    let agentText = "";
    let costYuan = 0;
    let usageTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    const usagePatch = (): Record<string, number> => ({
      usageTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
    });
    const result = await backend.runTurn({
      room,
      member: owner,
      prompt,
      turnId: `task-${taskId}-${Date.now()}`,
      signal: options.signal,
      cwd: worktree.path,
      writeMode: true,
      onDelta: (text) => {
        agentText += text;
      },
    });
    costYuan += result.costYuan ?? 0;
    usageTokens += result.usage?.totalTokens ?? 0;
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;
    cacheReadTokens += result.usage?.cacheReadTokens ?? 0;
    if (!agentText && result.text) agentText = result.text;
    appendTaskEvent(store, roomId, taskId, {
      type: "task_turn_finished",
      phase: "owner",
      memberId: owner.id,
      status: result.status,
      error: result.error,
      costYuan,
      usageTokens,
      text: summarizeText(agentText),
    });

    const now = new Date().toISOString();
    const fail = (status: TaskStatus, message: string, verification?: TaskVerification): TaskRunResult => {
      const report: TaskReport = {
        version: 1,
        taskId,
        summary: summarizeText(agentText) || message,
        risks: extractList(agentText, /风险|risks?/i),
        nextSteps: extractList(agentText, /下一步|next steps?/i),
        files: [],
        diffstat: "",
        verification,
        costYuan,
        usageTokens,
        agentText,
        generatedAt: now,
      };
      setTaskStatus(store, roomId, taskId, status, message);
      recordTaskReport(store, roomId, taskId, report);
      patchTask(store, roomId, taskId, { costYuan, ...usagePatch(), lastError: message, finishedAt: now });
      return { task: requireTask(store, roomId, taskId), report, error: message };
    };

    if (options.signal?.aborted) {
      const current = patchTask(store, roomId, taskId, { costYuan, ...usagePatch() });
      if (current.status === "running") setTaskStatus(store, roomId, taskId, "interrupted", "已取消");
      return { task: requireTask(store, roomId, taskId), error: "已取消" };
    }
    if (result.status !== "completed") {
      return fail("failed", result.error || "agent 回合失败");
    }

    const budget = task.budgetYuan ?? 2;
    if (budget > 0 && costYuan > budget) {
      return fail("budget_paused", `任务费用 ¥${costYuan.toFixed(2)} 超过预算 ¥${budget.toFixed(2)}`);
    }
    if (options.roomBudgetYuan !== undefined
      && (options.priorRoomCostYuan ?? 0) + costYuan >= options.roomBudgetYuan) {
      return fail(
        "budget_paused",
        `房间费用 ¥${((options.priorRoomCostYuan ?? 0) + costYuan).toFixed(2)} 达到房间预算 ¥${options.roomBudgetYuan.toFixed(2)}`,
      );
    }

    const changed = changedPaths(worktree.path);
    const violations = task.allowedPaths && task.allowedPaths.length > 0
      ? changed.filter((file) => !pathAllowed(file, task.allowedPaths))
      : [];
    if (violations.length > 0) {
      return fail("failed", `改动超出允许路径：${violations.join("、")}`);
    }

    const commit = commitAll(worktree.path, `task(${task.id}): ${task.title}`);
    if (!commit) {
      return fail("failed", "agent 没有产生文件改动。");
    }
    const targetBranch = currentBranch(repo);
    const stat = diffStat(repo, targetBranch, worktree.branch);
    options.onProgress?.(`commit: ${commit.slice(0, 8)}`);

    let verification: TaskVerification | undefined;
    if (task.verificationCommand) {
      verification = await runVerification(
        worktree.path,
        task.verificationCommand,
        options.verificationTimeoutMs ?? VERIFICATION_TIMEOUT_MS,
      );
      appendTaskEvent(store, roomId, taskId, {
        type: "task_verification",
        command: verification.command,
        exitCode: verification.exitCode,
        passed: verification.passed,
        timedOut: verification.timedOut,
        output: verification.output.slice(0, 4000),
      });
      if (!verification.passed) {
        return fail("failed", verification.timedOut ? "验证命令超时" : `验证失败（exit ${verification.exitCode}）`, verification);
      }
    }

    setTaskStatus(store, roomId, taskId, "review");
    const reviewerId = task.reviewerMemberId && task.reviewerMemberId !== task.ownerMemberId
      ? task.reviewerMemberId
      : room.members.find((member) => member.id !== task.ownerMemberId)?.id;
    let review: TaskReview = { verdict: "skipped", notes: "没有独立审查成员，等待人工合并。" };
    if (reviewerId) {
      const reviewerBase = pickMember(room, reviewerId);
      const reviewer: RoomMember = { ...reviewerBase, id: `${reviewerBase.id}__review_${taskId}` };
      const diff = diffText(repo, targetBranch, worktree.branch);
      const reviewPrompt = [
        `你是审查者 ${reviewer.name}。审查任务「${task.title}」的改动。`,
        `验收标准：\n${task.acceptance}`,
        `实现者说明：\n${summarizeText(agentText)}`,
        `验证：${verification ? (verification.passed ? "通过" : "失败") : "未配置命令"}`,
        `diff：\n${diff || "（空）"}`,
        "如果改动满足验收标准且没有明显问题，第一行只写 APPROVE；否则第一行写 REJECT 并列出原因。不要修改文件。",
      ].join("\n\n");
      const reviewResult = await backend.runTurn({
        room,
        member: reviewer,
        prompt: reviewPrompt,
        turnId: `review-${taskId}-${Date.now()}`,
        signal: options.signal,
        cwd: worktree.path,
        writeMode: false,
      });
      costYuan += reviewResult.costYuan ?? 0;
      usageTokens += reviewResult.usage?.totalTokens ?? 0;
      inputTokens += reviewResult.usage?.inputTokens ?? 0;
      outputTokens += reviewResult.usage?.outputTokens ?? 0;
      cacheReadTokens += reviewResult.usage?.cacheReadTokens ?? 0;
      const verdict = /^\s*APPROVE\b/im.test(reviewResult.text)
        ? "approved"
        : /^\s*REJECT\b/im.test(reviewResult.text)
          ? "rejected"
          : "skipped";
      review = { reviewerMemberId: reviewerBase.id, verdict, notes: summarizeText(reviewResult.text) };
      appendTaskEvent(store, roomId, taskId, { type: "task_review", reviewerId: reviewerBase.id, verdict, notes: review.notes });
      if (verdict === "rejected") {
        const rejectedReport: TaskReport = {
          version: 1, taskId, summary: summarizeText(agentText), risks: extractList(agentText, /风险|risks?/i),
          nextSteps: extractList(agentText, /下一步|next steps?/i), commit, files: changed, diffstat: stat,
          verification, review, costYuan, usageTokens, agentText, generatedAt: new Date().toISOString(),
        };
        setTaskStatus(store, roomId, taskId, "failed", "审查未通过");
        recordTaskReport(store, roomId, taskId, rejectedReport);
        patchTask(store, roomId, taskId, { costYuan, ...usagePatch(), lastError: "审查未通过", finishedAt: new Date().toISOString() });
        return { task: requireTask(store, roomId, taskId), report: rejectedReport, error: "审查未通过" };
      }
    }

    const finalReport: TaskReport = {
      version: 1,
      taskId,
      summary: summarizeText(agentText),
      risks: extractList(agentText, /风险|risks?/i),
      nextSteps: extractList(agentText, /下一步|next steps?/i),
      commit,
      files: changed,
      diffstat: stat,
      verification,
      review,
      costYuan,
      usageTokens,
      agentText,
      generatedAt: new Date().toISOString(),
    };
    setTaskStatus(store, roomId, taskId, "merge_ready");
    recordTaskReport(store, roomId, taskId, finalReport);
    patchTask(store, roomId, taskId, { costYuan, ...usagePatch(), finishedAt: new Date().toISOString() });

    if (task.autoMerge === true && room.rules.allowAutoMerge !== false) {
      const merged = mergeTask(store, roomId, taskId);
      if (merged.status !== "merged") {
        appendTaskEvent(store, roomId, taskId, { type: "task_auto_merge", status: merged.status, detail: merged.detail });
      }
    }
    return { task: requireTask(store, roomId, taskId), report: finalReport };
  } finally {
    slot.release();
    void worktreePath;
  }
}

export function mergeTask(store: RoomStore, roomId: string, taskId: string): { status: "merged" | "conflict" | "dirty" | "error"; detail?: string } {
  const room = store.readRoom(roomId);
  const task = requireTask(store, roomId, taskId);
  if (task.status !== "merge_ready") {
    throw new Error(`任务状态是 ${task.status}；只有 merge_ready 可以合并。`);
  }
  if (!room.workspace) throw new Error("房间没有工作区。");
  const repo = requireGitRoot(room.workspace);
  const branch = task.branch ?? `agenthub/${taskId}`;
  const target = currentBranch(repo);
  if (task.worktreePath && existsSync(task.worktreePath)) {
    const rebase = rebaseOnto(task.worktreePath, target);
    if (!rebase.ok) {
      abortRebase(task.worktreePath);
      setTaskStatus(store, roomId, taskId, "conflict", "rebase 冲突，worktree 已保留");
      return { status: "conflict", detail: rebase.detail };
    }
  }
  const merged = mergeFastForward(repo, branch);
  if (merged.status === "merged") {
    setTaskStatus(store, roomId, taskId, "done");
    if (task.worktreePath && existsSync(task.worktreePath)) {
      try {
        discardWorktree(repo, task.worktreePath, { force: true });
      } catch {
        // Keep the merged worktree if removal fails; branch is never deleted.
      }
    }
    return { status: "merged", detail: merged.stdout };
  }
  if (merged.status === "conflict") {
    setTaskStatus(store, roomId, taskId, "conflict", merged.detail);
    return { status: "conflict", detail: merged.detail };
  }
  if (merged.status === "dirty") {
    return { status: "dirty", detail: merged.detail };
  }
  setTaskStatus(store, roomId, taskId, "conflict", merged.detail);
  return { status: "error", detail: merged.detail };
}

export function discardTask(store: RoomStore, roomId: string, taskId: string, force = false): RoomTask {
  const task = requireTask(store, roomId, taskId);
  if (task.status === "running") {
    throw new Error("运行中的任务不能丢弃；请先取消。");
  }
  const room = store.readRoom(roomId);
  if (task.worktreePath && existsSync(task.worktreePath) && room.workspace) {
    discardWorktree(room.workspace, task.worktreePath, { force });
  }
  if (!["done", "cancelled"].includes(task.status)) {
    setTaskStatus(store, roomId, taskId, "cancelled", "人工丢弃");
  }
  return requireTask(store, roomId, taskId);
}

export function retryTask(store: RoomStore, roomId: string, taskId: string): RoomTask {
  const task = requireTask(store, roomId, taskId);
  if (!["failed", "blocked", "conflict", "budget_paused", "interrupted"].includes(task.status)) {
    throw new Error(`任务状态 ${task.status} 不能重试。`);
  }
  return setTaskStatus(store, roomId, taskId, "ready", "重试");
}

export function moveTask(store: RoomStore, roomId: string, taskId: string, to: TaskStatus): RoomTask {
  return setTaskStatus(store, roomId, taskId, to);
}

export function taskRepoPath(store: RoomStore, roomId: string, taskId: string): string | undefined {
  const task = findTask(store, roomId, taskId);
  if (task?.worktreePath) return task.worktreePath;
  const room = store.readRoom(roomId);
  return room.workspace || undefined;
}

export function taskBranchName(taskId: string): string {
  return `agenthub/${basename(taskId)}`;
}

export interface WorktreeCleanupResult {
  removed: number;
  skipped: number;
  failed: Array<{ taskId: string; error: string }>;
}

export function cleanupTaskWorktrees(
  store: RoomStore,
  roomId: string,
  options: { force?: boolean } = {},
): WorktreeCleanupResult {
  const room = store.readRoom(roomId);
  const tasks = loadTasks(store, roomId);
  const result: WorktreeCleanupResult = { removed: 0, skipped: 0, failed: [] };
  let changed = false;
  for (const task of tasks) {
    if (!task.worktreePath) continue;
    if (task.status === "running") {
      result.skipped += 1;
      continue;
    }
    if (!existsSync(task.worktreePath)) {
      task.worktreePath = undefined;
      changed = true;
      continue;
    }
    if (!room.workspace) {
      result.skipped += 1;
      continue;
    }
    try {
      discardWorktree(room.workspace, task.worktreePath, { force: options.force === true });
      task.worktreePath = undefined;
      task.updatedAt = new Date().toISOString();
      appendTaskEvent(store, roomId, task.id, { type: "worktree_cleaned" });
      result.removed += 1;
      changed = true;
    } catch (error) {
      result.failed.push({
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (changed) saveTasks(store, roomId, tasks);
  return result;
}
