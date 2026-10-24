import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { RoomStore } from "./store.ts";
import { buildMembersFromLibrary } from "./member-library.ts";
import type { RoomConfig, RoomMember, RoomRules } from "./types.ts";
import { addWorkspace, findWorkspaceByPath, loadWorkspaces } from "./workspaces.ts";

const ROOM_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

const DEFAULT_BINDING = {
  platformId: "codex-cli",
  modelId: "deepseek-v4.1-flash",
};

export interface CreateRoomInput {
  id?: string;
  name: string;
  workspaceId?: string;
  workspacePath?: string;
  noWorkspace?: boolean;
  copyFromRoomId?: string;
  members?: RoomMember[];
  libraryMemberIds?: string[];
  defaultBinding?: { platformId: string; modelId: string };
}

function slugifyRoomId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 3 ? slug : `room-${randomUUID().slice(0, 6)}`;
}

function uniqueRoomId(base: string, store: RoomStore): string {
  let id = base;
  let suffix = 2;
  while (store.hasRoom(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  if (!ROOM_ID_PATTERN.test(id)) {
    throw new Error(`Invalid room id "${id}".`);
  }
  return id;
}

function defaultRules(members: RoomMember[]): RoomRules {
  return {
    autonomy: "medium",
    maxHandoffs: 6,
    maxConsecutiveSameSpeaker: 1,
    summarizeAt: 0.7,
    hardStopAt: 0.85,
    budgetYuan: 5,
    stopToken: "DONE",
    planOrder: members.map((member) => member.id),
  };
}

function defaultMember(binding: { platformId: string; modelId: string }): RoomMember {
  return {
    id: `member-${randomUUID().slice(0, 8)}`,
    name: "通用助手",
    role: "助手",
    instructions: "给出具体、可执行的建议；需要交接时写 @成员名，完成任务以 DONE 结束。",
    binding: { ...binding },
    behavior: { weight: 1 },
    permissions: { write: false },
  };
}

function validateMembers(members: RoomMember[]): void {
  if (members.length === 0) {
    throw new Error("A room needs at least one member.");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const member of members) {
    if (!member.id || !member.name?.trim() || !member.binding?.platformId || !member.binding?.modelId) {
      throw new Error("Every member needs an id, name, platform and model.");
    }
    if (ids.has(member.id)) {
      throw new Error(`Duplicate member id: ${member.id}`);
    }
    ids.add(member.id);
    const name = member.name.trim().toLowerCase();
    if (names.has(name)) {
      throw new Error(`Duplicate member name: ${member.name}`);
    }
    names.add(name);
  }
}

function resolveWorkspace(store: RoomStore, input: CreateRoomInput): { workspace: string; workspaceId?: string } {
  if (input.noWorkspace) {
    return { workspace: "" };
  }
  if (input.workspaceId) {
    const workspace = loadWorkspaces(store).find((item) => item.id === input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }
    return { workspace: workspace.path, workspaceId: workspace.id };
  }
  if (!input.workspacePath) {
    throw new Error("Choose a workspace or create a chat-only room.");
  }
  const path = resolve(input.workspacePath);
  const workspaces = loadWorkspaces(store);
  const existing = findWorkspaceByPath(workspaces, path);
  if (existing) {
    return { workspace: existing.path, workspaceId: existing.id };
  }
  let name = basename(path) || "工作区";
  let suffix = 2;
  while (workspaces.some((workspace) => workspace.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    name = `${basename(path) || "工作区"} (${suffix})`;
    suffix += 1;
  }
  const created = addWorkspace(store, { name, path });
  return { workspace: created.path, workspaceId: created.id };
}

export function createRoomFromInput(store: RoomStore, input: CreateRoomInput): RoomConfig {
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Room name is required.");
  }

  let source: RoomConfig | undefined;
  if (input.copyFromRoomId) {
    source = store.readRoom(input.copyFromRoomId);
  }

  let members: RoomMember[];
  if (input.members && input.members.length > 0) {
    members = structuredClone(input.members);
  } else if (input.libraryMemberIds && input.libraryMemberIds.length > 0) {
    members = buildMembersFromLibrary(
      store,
      input.libraryMemberIds,
      input.defaultBinding ?? DEFAULT_BINDING,
    );
  } else if (source) {
    members = structuredClone(source.members);
  } else {
    members = [defaultMember(input.defaultBinding ?? DEFAULT_BINDING)];
  }
  validateMembers(members);

  const rules: RoomRules = source ? structuredClone(source.rules) : defaultRules(members);
  const memberIds = new Set(members.map((member) => member.id));
  rules.planOrder = (rules.planOrder ?? []).filter((id) => memberIds.has(id));
  if (rules.planOrder.length === 0) {
    rules.planOrder = members.map((member) => member.id);
  }

  const { workspace, workspaceId } = resolveWorkspace(store, input);
  const requestedId = String(input.id || "").trim();
  if (requestedId && !ROOM_ID_PATTERN.test(requestedId)) {
    throw new Error(`Invalid room id "${requestedId}"; use letters, numbers, dot, underscore or dash.`);
  }
  let id: string;
  if (requestedId) {
    if (store.hasRoom(requestedId)) {
      throw new Error(`Room "${requestedId}" already exists.`);
    }
    id = requestedId;
  } else {
    id = uniqueRoomId(slugifyRoomId(name), store);
  }

  const now = new Date().toISOString();
  return store.createRoom({
    version: 1,
    id,
    name,
    workspace,
    ...(workspaceId ? { workspaceId } : {}),
    members,
    rules,
    createdAt: now,
    updatedAt: now,
  });
}
