import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { RoomStore } from "./store.ts";

const WORKSPACES_FILE = "workspaces.json";
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary extends WorkspaceConfig {
  available: boolean;
  roomCount: number;
}

interface WorkspaceFile {
  version: 1;
  workspaces: WorkspaceConfig[];
}

export function workspacesFilePath(store: RoomStore): string {
  return join(store.dataDir, WORKSPACES_FILE);
}

export function normalizeWorkspacePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function loadWorkspaces(store: RoomStore): WorkspaceConfig[] {
  const filePath = workspacesFilePath(store);
  if (!existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Workspace registry ${filePath} must be a JSON object.`);
  }
  const record = parsed as Partial<WorkspaceFile>;
  if (record.version !== 1 || !Array.isArray(record.workspaces)) {
    throw new Error(`Workspace registry ${filePath} must contain version 1 and a workspaces array.`);
  }
  return record.workspaces as WorkspaceConfig[];
}

export function saveWorkspaces(store: RoomStore, workspaces: WorkspaceConfig[]): void {
  mkdirSync(store.dataDir, { recursive: true });
  writeFileSync(workspacesFilePath(store), `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`, "utf8");
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 3 ? slug : `${fallback}-${randomUUID().slice(0, 6)}`;
}

function uniqueId(base: string, workspaces: WorkspaceConfig[]): string {
  let id = base;
  let suffix = 2;
  while (workspaces.some((workspace) => workspace.id === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid workspace id "${id}".`);
  }
  return id;
}

function uniqueName(base: string, workspaces: WorkspaceConfig[], excludeId?: string): string {
  let name = base.trim();
  let suffix = 2;
  const taken = (value: string): boolean => workspaces.some(
    (workspace) => workspace.id !== excludeId && workspace.name.trim().toLowerCase() === value.trim().toLowerCase(),
  );
  while (taken(name)) {
    name = `${base.trim()} (${suffix})`;
    suffix += 1;
  }
  return name;
}

function assertDirectory(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`Workspace folder does not exist: ${target}`);
  }
}

export function findWorkspaceByPath(workspaces: WorkspaceConfig[], target: string): WorkspaceConfig | undefined {
  const normalized = normalizeWorkspacePath(target);
  return workspaces.find((workspace) => normalizeWorkspacePath(workspace.path) === normalized);
}

/**
 * Existing rooms predate the registry. Register their paths once so the
 * sidebar can group them without mutating the folders themselves.
 */
export function syncWorkspacesFromRooms(store: RoomStore): WorkspaceConfig[] {
  const workspaces = loadWorkspaces(store);
  let changed = !existsSync(workspacesFilePath(store));
  for (const room of store.listRooms()) {
    if (!room.workspace) {
      continue;
    }
    const path = resolve(room.workspace);
    let workspace = room.workspaceId
      ? workspaces.find((item) => item.id === room.workspaceId)
      : undefined;
    workspace ??= findWorkspaceByPath(workspaces, path);
    if (!workspace) {
      const baseName = basename(path) || room.name;
      const now = new Date().toISOString();
      workspace = {
        id: uniqueId(slugify(baseName, "workspace"), workspaces),
        name: uniqueName(baseName, workspaces),
        path,
        createdAt: room.createdAt || now,
        updatedAt: now,
      };
      workspaces.push(workspace);
      changed = true;
    }
    if (room.workspaceId !== workspace.id) {
      room.workspaceId = workspace.id;
      store.writeRoom(room);
    }
  }
  if (changed) {
    saveWorkspaces(store, workspaces);
  }
  return workspaces;
}

export function listWorkspaceSummaries(store: RoomStore): WorkspaceSummary[] {
  const workspaces = syncWorkspacesFromRooms(store);
  const rooms = store.listRooms();
  return workspaces.map((workspace) => ({
    ...workspace,
    available: existsSync(workspace.path) && statSync(workspace.path).isDirectory(),
    roomCount: rooms.filter((room) => room.workspaceId === workspace.id
      || (!room.workspaceId && room.workspace && normalizeWorkspacePath(room.workspace) === normalizeWorkspacePath(workspace.path))).length,
  }));
}

export interface AddWorkspaceInput {
  name: string;
  path: string;
}

export function addWorkspace(store: RoomStore, input: AddWorkspaceInput): WorkspaceConfig {
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Workspace name is required.");
  }
  if (!input.path) {
    throw new Error("Workspace path is required.");
  }
  const workspaces = loadWorkspaces(store);
  const path = resolve(input.path);
  assertDirectory(path);
  if (findWorkspaceByPath(workspaces, path)) {
    throw new Error(`This folder is already registered: ${path}`);
  }
  if (workspaces.some((workspace) => workspace.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error(`Workspace name already exists: ${name}`);
  }
  const now = new Date().toISOString();
  const workspace: WorkspaceConfig = {
    id: uniqueId(slugify(name, "workspace"), workspaces),
    name,
    path,
    createdAt: now,
    updatedAt: now,
  };
  workspaces.push(workspace);
  saveWorkspaces(store, workspaces);
  return workspace;
}

export function renameWorkspace(store: RoomStore, workspaceId: string, nextName: string): WorkspaceConfig {
  const id = String(workspaceId || "").trim();
  const name = String(nextName || "").trim();
  if (!name) {
    throw new Error("Workspace name is required.");
  }
  const workspaces = loadWorkspaces(store);
  const workspace = workspaces.find((item) => item.id === id);
  if (!workspace) {
    throw new Error(`Workspace not found: ${id}`);
  }
  if (workspaces.some((item) => item.id !== id && item.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error(`Workspace name already exists: ${name}`);
  }
  workspace.name = name;
  workspace.updatedAt = new Date().toISOString();
  saveWorkspaces(store, workspaces);
  return workspace;
}

export function removeWorkspace(store: RoomStore, workspaceId: string): WorkspaceConfig {
  const id = String(workspaceId || "").trim();
  const workspaces = loadWorkspaces(store);
  const workspace = workspaces.find((item) => item.id === id);
  if (!workspace) {
    throw new Error(`Workspace not found: ${id}`);
  }
  const referenced = store.listRooms().filter((room) => room.workspaceId === id
    || (!room.workspaceId && room.workspace && normalizeWorkspacePath(room.workspace) === normalizeWorkspacePath(workspace.path)));
  if (referenced.length > 0) {
    throw new Error(`Workspace is used by ${referenced.map((room) => room.name || room.id).join(", ")}.`);
  }
  saveWorkspaces(store, workspaces.filter((item) => item.id !== id));
  return workspace;
}
