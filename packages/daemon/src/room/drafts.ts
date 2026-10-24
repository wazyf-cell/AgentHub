import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { RoomStore } from "./store.ts";
import { assertInside } from "./worktrees.ts";

const DRAFT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_SCOPE_FILES = 2000;
const MAX_SCOPE_FILE_BYTES = 8 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".agenthub", ".next", "dist", "build"]);

export type DraftStatus = "open" | "applied" | "discarded";
export type DraftChangeKind = "added" | "modified" | "deleted";

export interface DraftChange {
  path: string;
  kind: DraftChangeKind;
  baselineHash?: string;
  currentHash?: string;
  size?: number;
}

export interface DraftRecord {
  version: 1;
  id: string;
  runId: string;
  roomId?: string;
  workspaceId: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  status: DraftStatus;
  scope: string[];
  baseline: Record<string, string>;
  changes: DraftChange[];
  drift: string[];
  skipped: string[];
  appliedAt?: string;
}

export interface DraftSummary extends DraftRecord {
  draftDir: string;
  workDir: string;
}

export interface DraftInput {
  store: RoomStore;
  workspaceId: string;
  workspacePath: string;
  roomId?: string;
  runId?: string;
  scope?: string[];
}

export interface DraftApplyResult {
  status: "applied" | "partial" | "nothing";
  applied: string[];
  conflicts: Array<{ path: string; reason: string }>;
  backupDir?: string;
}

export function draftRoot(store: RoomStore): string {
  if (process.env.AGENT_SPACE_DRAFT_DIR) {
    return resolve(process.env.AGENT_SPACE_DRAFT_DIR);
  }
  return join(dirname(store.dataDir), "drafts");
}

export function draftIdFor(prefix = "draft"): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function assertDraftId(id: string): void {
  if (!DRAFT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid draft id "${id}"; use letters, numbers, dot, underscore or dash.`);
  }
}

export function draftDir(store: RoomStore, workspaceId: string, runId: string): string {
  if (!DRAFT_ID_PATTERN.test(workspaceId)) {
    throw new Error(`Invalid workspace id "${workspaceId}".`);
  }
  assertDraftId(runId);
  return join(draftRoot(store), workspaceId, runId);
}

export function workDirOf(draftDirPath: string): string {
  return join(draftDirPath, "work");
}

function toSummary(store: RoomStore, record: DraftRecord): DraftSummary {
  const dir = draftDir(store, record.workspaceId, record.runId);
  return { ...record, draftDir: dir, workDir: workDirOf(dir) };
}

export function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeRelative(value: string): string {
  return value.split(/[\\/]+/).filter(Boolean).join("/");
}

export function resolveInside(root: string, target: string): string {
  return assertInside(root, target);
}

function walkFiles(root: string, current = ""): string[] {
  const absolute = join(root, current);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [current];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = current ? join(current, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walkFiles(root, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function copyIntoDraft(workspacePath: string, workDir: string, rel: string, skipped: string[]): Record<string, string> {
  const baseline: Record<string, string> = {};
  const source = resolveInside(workspacePath, rel);
  if (!existsSync(source)) {
    skipped.push(`${rel}（不存在）`);
    return baseline;
  }
  const stat = statSync(source);
  const files = stat.isDirectory() ? walkFiles(source) : [source];
  for (const file of files) {
    const absolute = stat.isDirectory() ? join(source, file) : source;
    const relToScope = stat.isDirectory() ? normalizeRelative(relative(source, absolute)) : "";
    const targetRel = stat.isDirectory() && relToScope ? normalizeRelative(join(rel, relToScope)) : normalizeRelative(rel);
    const fileStat = statSync(absolute);
    if (fileStat.size > MAX_SCOPE_FILE_BYTES) {
      skipped.push(`${targetRel}（超过 8 MB）`);
      continue;
    }
    if (Object.keys(baseline).length >= MAX_SCOPE_FILES) {
      skipped.push("（达到 2000 个文件上限）");
      break;
    }
    const target = resolveInside(workDir, targetRel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absolute, target);
    baseline[targetRel] = hashFile(absolute);
  }
  return baseline;
}

export function createDraft(input: DraftInput): DraftSummary {
  const workspacePath = resolve(input.workspacePath);
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new Error(`Workspace folder does not exist: ${workspacePath}`);
  }
  const runId = input.runId ?? draftIdFor("run");
  assertDraftId(runId);
  const dir = draftDir(input.store, input.workspaceId, runId);
  if (existsSync(join(dir, "draft.json"))) {
    throw new Error(`Draft ${input.workspaceId}/${runId} already exists.`);
  }
  const workDir = workDirOf(dir);
  mkdirSync(workDir, { recursive: true });
  const baseline: Record<string, string> = {};
  const skipped: string[] = [];
  for (const scope of input.scope ?? []) {
    const trimmed = scope.trim();
    if (!trimmed) continue;
    Object.assign(baseline, copyIntoDraft(workspacePath, workDir, trimmed, skipped));
  }
  const now = new Date().toISOString();
  const record: DraftRecord = {
    version: 1,
    id: runId,
    runId,
    roomId: input.roomId,
    workspaceId: input.workspaceId,
    workspacePath,
    createdAt: now,
    updatedAt: now,
    status: "open",
    scope: (input.scope ?? []).map((item) => normalizeRelative(item)).filter(Boolean),
    baseline,
    changes: [],
    drift: [],
    skipped,
  };
  saveDraftRecord(input.store, record);
  return toSummary(input.store, record);
}

function readDraftRecord(store: RoomStore, workspaceId: string, runId: string): DraftRecord {
  const filePath = join(draftDir(store, workspaceId, runId), "draft.json");
  if (!existsSync(filePath)) {
    throw new Error(`Draft ${workspaceId}/${runId} not found.`);
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as DraftRecord;
}

export function saveDraftRecord(store: RoomStore, record: DraftRecord): void {
  const dir = draftDir(store, record.workspaceId, record.runId);
  mkdirSync(dir, { recursive: true });
  record.updatedAt = new Date().toISOString();
  writeFileSync(join(dir, "draft.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function loadDraft(store: RoomStore, workspaceId: string, runId: string): DraftSummary {
  return toSummary(store, readDraftRecord(store, workspaceId, runId));
}

export function findDraft(store: RoomStore, runId: string): DraftSummary {
  assertDraftId(runId);
  const root = draftRoot(store);
  if (!existsSync(root)) {
    throw new Error(`Draft ${runId} not found.`);
  }
  for (const workspaceId of readdirSync(root, { withFileTypes: true })) {
    if (!workspaceId.isDirectory()) continue;
    if (!existsSync(join(root, workspaceId.name, runId, "draft.json"))) continue;
    return toSummary(store, readDraftRecord(store, workspaceId.name, runId));
  }
  throw new Error(`Draft ${runId} not found.`);
}

export function listDrafts(store: RoomStore, workspaceId?: string): DraftSummary[] {
  const root = draftRoot(store);
  if (!existsSync(root)) return [];
  const workspaces = workspaceId
    ? [workspaceId]
    : readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const drafts: DraftSummary[] = [];
  for (const id of workspaces) {
    const dir = join(root, id);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !DRAFT_ID_PATTERN.test(entry.name)) continue;
      if (!existsSync(join(dir, entry.name, "draft.json"))) continue;
      try {
        drafts.push(toSummary(store, readDraftRecord(store, id, entry.name)));
      } catch {
        // A corrupt draft should not hide the healthy ones.
      }
    }
  }
  return drafts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function scanChanges(record: DraftRecord, workDir: string): DraftChange[] {
  const workFiles = walkFiles(workDir).map(normalizeRelative);
  const changeMap = new Map<string, DraftChange>();
  for (const rel of workFiles) {
    const hash = hashFile(join(workDir, rel));
    const baselineHash = record.baseline[rel];
    if (!baselineHash) {
      changeMap.set(rel, { path: rel, kind: "added", currentHash: hash, size: statSync(join(workDir, rel)).size });
    } else if (baselineHash !== hash) {
      changeMap.set(rel, { path: rel, kind: "modified", baselineHash, currentHash: hash, size: statSync(join(workDir, rel)).size });
    }
  }
  for (const rel of Object.keys(record.baseline)) {
    if (!workFiles.includes(rel)) {
      changeMap.set(rel, { path: rel, kind: "deleted", baselineHash: record.baseline[rel] });
    }
  }
  return [...changeMap.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function scanDrift(record: DraftRecord): string[] {
  const drift: string[] = [];
  for (const [rel, baselineHash] of Object.entries(record.baseline)) {
    try {
      const target = resolveInside(record.workspacePath, rel);
      if (!existsSync(target)) {
        drift.push(`${rel}（已被删除）`);
      } else if (hashFile(target) !== baselineHash) {
        drift.push(`${rel}（已被修改）`);
      }
    } catch {
      drift.push(`${rel}（越界）`);
    }
  }
  return drift;
}

export function refreshDraft(store: RoomStore, runId: string): DraftSummary {
  const summary = findDraft(store, runId);
  const record = readDraftRecord(store, summary.workspaceId, runId);
  record.changes = scanChanges(record, summary.workDir);
  record.drift = scanDrift(record);
  saveDraftRecord(store, record);
  return loadDraft(store, record.workspaceId, runId);
}

export function applyDraft(store: RoomStore, runId: string, files?: string[]): DraftApplyResult {
  const summary = findDraft(store, runId);
  const record = readDraftRecord(store, summary.workspaceId, runId);
  if (record.status !== "open") {
    throw new Error(`Draft ${runId} is already ${record.status}.`);
  }
  record.changes = scanChanges(record, summary.workDir);
  record.drift = scanDrift(record);
  const wanted = files ? new Set(files.map(normalizeRelative)) : undefined;
  const selected = record.changes.filter((change) => (wanted ? wanted.has(change.path) : change.kind !== "deleted"));
  const backupDir = join(summary.draftDir, "backup");
  const applied: string[] = [];
  const conflicts: Array<{ path: string; reason: string }> = [];

  for (const change of selected) {
    let target: string;
    try {
      target = resolveInside(record.workspacePath, change.path);
    } catch {
      conflicts.push({ path: change.path, reason: "路径越界" });
      continue;
    }
    const targetExists = existsSync(target);
    if (change.kind === "added" && targetExists) {
      conflicts.push({ path: change.path, reason: "目标文件已存在" });
      continue;
    }
    if (change.kind !== "added") {
      if (!targetExists) {
        conflicts.push({ path: change.path, reason: "目标文件已被删除" });
        continue;
      }
      if (change.baselineHash && hashFile(target) !== change.baselineHash) {
        conflicts.push({ path: change.path, reason: "草稿期间目标文件已变化" });
        continue;
      }
    }
    try {
      if (targetExists) {
        const backup = resolveInside(backupDir, change.path);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(target, backup);
      }
      if (change.kind === "deleted") {
        rmSync(target, { force: true });
      } else {
        const source = resolveInside(summary.workDir, change.path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      applied.push(change.path);
    } catch (error) {
      conflicts.push({ path: change.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (conflicts.length > 0) {
    record.changes = scanChanges(record, summary.workDir);
    record.drift = scanDrift(record);
    saveDraftRecord(store, record);
    return { status: applied.length > 0 ? "partial" : "nothing", applied, conflicts, backupDir: existsSync(backupDir) ? backupDir : undefined };
  }

  record.status = "applied";
  record.appliedAt = new Date().toISOString();
  saveDraftRecord(store, record);
  rmSync(summary.draftDir, { recursive: true, force: true });
  return { status: applied.length > 0 ? "applied" : "nothing", applied, conflicts, backupDir: existsSync(backupDir) ? backupDir : undefined };
}

export function discardDraft(store: RoomStore, runId: string): DraftSummary {
  const summary = findDraft(store, runId);
  const record = readDraftRecord(store, summary.workspaceId, runId);
  record.status = "discarded";
  saveDraftRecord(store, record);
  rmSync(summary.draftDir, { recursive: true, force: true });
  return { ...summary, status: "discarded" };
}

export function cleanupDrafts(store: RoomStore, maxAgeDays = 7): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const draft of listDrafts(store)) {
    if (draft.status !== "open") continue;
    const created = new Date(draft.createdAt).getTime();
    if (Number.isFinite(created) && created < cutoff) {
      try {
        rmSync(draft.draftDir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Keep going; a locked draft will be retried next start.
      }
    }
  }
  return removed;
}

export function draftEventPayload(summary: DraftSummary): Record<string, unknown> {
  return {
    draftId: summary.runId,
    workspaceId: summary.workspaceId,
    workspacePath: summary.workspacePath,
    scope: summary.scope,
    changes: summary.changes,
    drift: summary.drift,
    skipped: summary.skipped,
    draftDir: summary.draftDir,
  };
}
