import { appendTaskMessageSync, failQueuedTaskSync } from "@agent-space/db";
import { parseTaskPayload } from "agent-space-daemon";
import type { FailTaskRequest } from "@agent-space/domain";
import {
  continueAutoContinuationAfterTaskSync,
  failChannelDocumentRunStepSync,
  formatConversationFailureSummary,
  formatTaskFailureSummary,
  postMessageSync,
  readWorkspaceStateSync,
  replacePendingChannelMessageSync,
  resolveCompatibleDirectChannelRecord,
  writeConversationExecutionWorkspaceStateSync,
  upsertDirectConversationStateSync,
  updateTaskStatusSync,
  writeWorkspaceStateSync,
} from "@agent-space/services";
import { heartbeatTaskLeaseForRequest, readTaskForWorkspace, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId } = await context.params;
  const task = readTaskForWorkspace(taskId, auth.workspaceId);
  if (task instanceof Response) {
    return task;
  }
  const lease = heartbeatTaskLeaseForRequest(request, task);
  if (lease instanceof Response) {
    return lease;
  }

  const body = (await request.json()) as Partial<FailTaskRequest>;
  if (!body.errorText?.trim()) {
    return Response.json({ error: "errorText is required." }, { status: 400 });
  }

  const payload = parseTaskPayload(task);
  const workspaceState = readWorkspaceStateSync(task.workspaceId);
  const effectiveChannelName =
    payload.channelName
      ?? (payload.contactId ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name : undefined);
  failQueuedTaskSync({
    taskId: task.id,
    attemptId: lease.attemptId,
    leaseToken: lease.leaseToken,
    errorText: body.errorText.trim(),
    sessionId: body.sessionId,
    workDir: body.workDir,
    errorCode: body.errorCode,
    errorCategory: body.errorCategory,
    provider: body.provider,
    rawProviderMessage: body.rawProviderMessage,
  });
  const providerDiagnosticMessage = formatProviderDiagnosticMessage(body);
  if (providerDiagnosticMessage) {
    appendTaskMessageSync({
      taskId: task.id,
      type: "status",
      content: providerDiagnosticMessage,
    });
  }

  if (payload.taskId) {
    updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
  }
  if (payload.orchestrationStepId) {
    writeWorkspaceStateSync(
      failChannelDocumentRunStepSync({
        queuedTaskId: task.id,
        errorText: body.errorText.trim(),
      }, task.workspaceId),
      task.workspaceId,
    );
  }
  if (effectiveChannelName && payload.channel) {
    replacePendingChannelMessageSync({
      channel: payload.channel,
      pendingSpeaker: payload.assignee ?? task.agentId,
      speaker: "系统提示",
      role: "agent",
      summary: formatConversationFailureSummary({
        agentName: payload.assignee ?? task.agentId,
        channelName: payload.channel,
        errorText: body.errorText.trim(),
        isDirectConversation: Boolean(payload.contactId),
      }),
      status: "error",
    }, task.workspaceId);
    writeConversationExecutionWorkspaceStateSync({
      channelName: payload.channel,
      agentId: payload.assignee ?? task.agentId,
      contactId: payload.contactId,
      sessionId: body.sessionId,
      workDir: body.workDir,
      lastTaskQueueId: task.id,
      lastError: body.errorText.trim(),
    }, task.workspaceId);
    if (payload.contactId) {
      upsertDirectConversationStateSync(
        {
          contactId: payload.contactId,
          sessionId: body.sessionId,
          workDir: body.workDir,
        },
        task.workspaceId,
      );
    }
  } else if (payload.contactId) {
    writeConversationExecutionWorkspaceStateSync({
      channelName: effectiveChannelName ?? payload.channel ?? payload.contactId,
      agentId: payload.contactId,
      contactId: payload.contactId,
      sessionId: body.sessionId,
      workDir: body.workDir,
      lastTaskQueueId: task.id,
      lastError: body.errorText.trim(),
    }, task.workspaceId);
    upsertDirectConversationStateSync(
      {
        contactId: payload.contactId,
        sessionId: body.sessionId,
        workDir: body.workDir,
      },
      task.workspaceId,
    );
  } else if (payload.channel) {
    postMessageSync({
      channel: payload.channel,
      speaker: "系统提示",
      role: "agent",
      summary: formatTaskFailureSummary({
        title: payload.title || task.id,
        errorText: body.errorText.trim(),
      }),
      status: "error",
    }, task.workspaceId);
    writeConversationExecutionWorkspaceStateSync({
      channelName: payload.channel,
      agentId: payload.assignee ?? task.agentId,
      sessionId: body.sessionId,
      workDir: body.workDir,
      lastTaskQueueId: task.id,
      lastError: body.errorText.trim(),
    }, task.workspaceId);
  }
  tryContinueAutoContinuation({
    taskId: task.id,
    workspaceId: task.workspaceId,
    sessionId: body.sessionId,
    workDir: body.workDir,
  });

  return Response.json({
    task: {
      id: task.id,
      status: "failed",
      errorText: body.errorText.trim(),
    },
  });
}

function formatProviderDiagnosticMessage(body: Partial<FailTaskRequest>): string | undefined {
  const parts = [
    body.errorCode ? `code=${body.errorCode}` : undefined,
    body.errorCategory ? `category=${body.errorCategory}` : undefined,
    body.provider ? `provider=${body.provider}` : undefined,
    body.rawProviderMessage?.trim() ? `raw=${body.rawProviderMessage.trim()}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `provider diagnostic: ${parts.join("; ")}` : undefined;
}

function tryContinueAutoContinuation(input: {
  taskId: string;
  workspaceId: string;
  sessionId?: string;
  workDir?: string;
}): void {
  try {
    continueAutoContinuationAfterTaskSync(input);
  } catch {
    // Failure reporting should not fail if the best-effort continuation enqueue fails.
  }
}
