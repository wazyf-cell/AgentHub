import { createRuntimeToolApprovalRequestSync } from "@agent-space/services";
import type { CreateRuntimeApprovalRequest } from "@agent-space/domain";
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

  const body = (await request.json()) as Partial<CreateRuntimeApprovalRequest>;
  if (!body.provider || !body.runtimeId || !body.toolName || !body.contentPreview) {
    return Response.json({ error: "provider, runtimeId, toolName, and contentPreview are required." }, { status: 400 });
  }
  if (body.runtimeId !== task.runtimeId) {
    return Response.json({ error: "Runtime approval does not match the task runtime." }, { status: 400 });
  }

  const approval = createRuntimeToolApprovalRequestSync({
    sourceId: task.id,
    agentId: task.agentId,
    channelName: resolveTaskChannelName(task.inputJson),
    toolName: body.toolName,
    toolInput: body.toolInput,
    contentPreview: body.contentPreview,
    provider: body.provider,
    runtimeId: body.runtimeId,
    sessionId: body.sessionId,
  }, auth.workspaceId);

  return Response.json({
    approval: {
      approvalId: approval.id,
      status: approval.status,
      reviewerComment: approval.reviewerComment,
    },
  });
}

function resolveTaskChannelName(inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return readString(parsed.channelName) ?? readString(parsed.channel) ?? readString(parsed.contactId) ?? "";
  } catch {
    return "";
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
