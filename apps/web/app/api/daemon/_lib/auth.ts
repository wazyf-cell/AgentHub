import {
  readAgentRuntimeSync,
  heartbeatQueuedTaskLeaseSync,
  readDaemonConnectionSync,
  readQueuedTaskSync,
  assertActiveTaskLeaseSync,
  validateDaemonApiTokenSync,
  type AgentRuntimeRecord,
  type DaemonApiTokenRecord,
  type DaemonConnectionRecord,
  type QueuedTaskRecord,
} from "@agent-space/db";
import { tryRecordWorkspaceAuditEventSync } from "@agent-space/services";

export interface DaemonAuthContext {
  token: DaemonApiTokenRecord;
  workspaceId: string;
}

export interface TaskLeaseContext {
  attemptId: string;
  leaseToken: string;
}

export function requireDaemonAuth(request: Request): DaemonAuthContext | Response {
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.startsWith("Bearer ")) {
    return Response.json({ error: "Missing daemon bearer token." }, { status: 401 });
  }

  const tokenValue = header.slice("Bearer ".length).trim();
  const token = validateDaemonApiTokenSync(tokenValue);
  if (!token) {
    return Response.json({ error: "Invalid daemon token." }, { status: 403 });
  }

  return {
    token,
    workspaceId: token.workspaceId,
  };
}

export function readDaemonConnectionForWorkspace(
  daemonKey: string,
  workspaceId: string,
): DaemonConnectionRecord | Response {
  const daemon = readDaemonConnectionSync(daemonKey);
  if (!daemon) {
    return Response.json({ error: `Daemon "${daemonKey}" does not exist.` }, { status: 404 });
  }
  if (daemon.workspaceId !== workspaceId) {
    recordDaemonWorkspaceAccessDenied({
      workspaceId,
      resourceType: "daemon",
      resourceId: daemonKey,
      targetWorkspaceId: daemon.workspaceId,
    });
    return Response.json({ error: "Daemon does not belong to this workspace." }, { status: 403 });
  }
  return daemon;
}

export function readRuntimeForWorkspace(runtimeId: string, workspaceId: string): AgentRuntimeRecord | Response {
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime) {
    return Response.json({ error: `Runtime "${runtimeId}" does not exist.` }, { status: 404 });
  }
  if (runtime.workspaceId !== workspaceId) {
    recordDaemonWorkspaceAccessDenied({
      workspaceId,
      resourceType: "runtime",
      resourceId: runtimeId,
      targetWorkspaceId: runtime.workspaceId,
    });
    return Response.json({ error: "Runtime does not belong to this workspace." }, { status: 403 });
  }
  return runtime;
}

export function readTaskForWorkspace(taskId: string, workspaceId: string): QueuedTaskRecord | Response {
  const task = readQueuedTaskSync(taskId);
  if (!task) {
    return Response.json({ error: `Task "${taskId}" does not exist.` }, { status: 404 });
  }
  if (task.workspaceId !== workspaceId) {
    recordDaemonWorkspaceAccessDenied({
      workspaceId,
      resourceType: "task",
      resourceId: taskId,
      targetWorkspaceId: task.workspaceId,
    });
    return Response.json({ error: "Task does not belong to this workspace." }, { status: 403 });
  }
  return task;
}

export function requireTaskLeaseForRequest(request: Request, task: QueuedTaskRecord): TaskLeaseContext | Response {
  const attemptId = request.headers.get("x-agent-space-attempt-id")?.trim();
  const leaseToken = request.headers.get("x-agent-space-lease-token")?.trim();
  if (!attemptId || !leaseToken) {
    return Response.json({ error: "Task lease headers are required." }, { status: 428 });
  }
  try {
    assertActiveTaskLeaseSync({ taskId: task.id, attemptId, leaseToken });
    return { attemptId, leaseToken };
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}

export function heartbeatTaskLeaseForRequest(request: Request, task: QueuedTaskRecord): TaskLeaseContext | Response {
  const lease = requireTaskLeaseForRequest(request, task);
  if (lease instanceof Response) {
    return lease;
  }
  try {
    heartbeatQueuedTaskLeaseSync({ taskId: task.id, ...lease });
    return lease;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}

function recordDaemonWorkspaceAccessDenied(input: {
  workspaceId: string;
  resourceType: "daemon" | "runtime" | "task";
  resourceId: string;
  targetWorkspaceId: string;
}): void {
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Cross-workspace daemon access denied",
    note:
      `Daemon token for workspace "${input.workspaceId}" was denied access to `
      + `${input.resourceType} "${input.resourceId}" in workspace "${input.targetWorkspaceId}".`,
    code: "workspace.cross_workspace_access_denied",
    data: {
      actorType: "daemon_token",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedWorkspaceId: input.targetWorkspaceId,
    },
  });
}
