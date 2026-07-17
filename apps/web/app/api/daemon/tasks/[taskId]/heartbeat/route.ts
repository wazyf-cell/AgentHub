import { readTaskForWorkspace, heartbeatTaskLeaseForRequest, requireDaemonAuth } from "../../../_lib/auth";

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

  return Response.json({
    task: {
      id: task.id,
      activeAttemptId: lease.attemptId,
    },
  });
}
