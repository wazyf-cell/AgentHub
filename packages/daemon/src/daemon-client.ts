import type {
  ClaimTaskResponse,
  CompleteTaskRequest,
  CreateRuntimeApprovalRequest,
  CreateRuntimeApprovalResponse,
  DaemonTaskInputBundle,
  DaemonTaskOutputBundle,
  FailTaskRequest,
  ClaimRuntimeAppOperationResponse,
  CompleteRuntimeAppOperationRequest,
  FailRuntimeAppOperationRequest,
  GetRuntimeApprovalResponse,
  HeartbeatDaemonResponse,
  HeartbeatDaemonRequest,
  RegisterDaemonRequest,
  RegisterDaemonResponse,
  ReportTaskMessagesRequest,
  StartRuntimeAppOperationRequest,
} from "./daemon-api.ts";

interface TaskLeaseHeaders {
  attemptId: string;
  leaseToken: string;
}

export type {
  ClaimTaskResponse,
  CompleteTaskRequest,
  CreateRuntimeApprovalRequest,
  CreateRuntimeApprovalResponse,
  DaemonTaskInputBundle,
  DaemonTaskOutputBundle,
  FailTaskRequest,
  ClaimRuntimeAppOperationResponse,
  CompleteRuntimeAppOperationRequest,
  FailRuntimeAppOperationRequest,
  GetRuntimeApprovalResponse,
  HeartbeatDaemonResponse,
  HeartbeatDaemonRequest,
  RegisterDaemonRequest,
  RegisterDaemonResponse,
  ReportTaskMessagesRequest,
  StartRuntimeAppOperationRequest,
} from "./daemon-api.ts";

export class HttpDaemonClient {
  private readonly serverUrl: string;
  private readonly daemonToken: string;
  private readonly retryDelayMs: number;
  private readonly maxRetryAttempts: number;
  private readonly taskLeases = new Map<string, TaskLeaseHeaders>();

  constructor(
    serverUrl: string,
    daemonToken: string,
    options?: {
      retryDelayMs?: number;
      maxRetryAttempts?: number;
    },
  ) {
    this.serverUrl = serverUrl;
    this.daemonToken = daemonToken;
    this.retryDelayMs = options?.retryDelayMs ?? 250;
    this.maxRetryAttempts = Math.max(1, options?.maxRetryAttempts ?? 3);
  }

  async register(request: RegisterDaemonRequest): Promise<RegisterDaemonResponse> {
    return this.postJson("/api/daemon/register", request);
  }

  async sendHeartbeat(daemonKey: string): Promise<HeartbeatDaemonResponse> {
    return this.postJson("/api/daemon/heartbeat", { daemonKey }, { retryable: true });
  }

  async sendHeartbeatWithMetadata(
    daemonKey: string,
    metadata: Record<string, unknown>,
    runtimes?: HeartbeatDaemonRequest["runtimes"],
  ): Promise<HeartbeatDaemonResponse> {
    return this.postJson("/api/daemon/heartbeat", { daemonKey, metadata, runtimes }, { retryable: true });
  }

  async claimTask(runtimeId: string): Promise<ClaimTaskResponse> {
    const response = await this.postJson<ClaimTaskResponse>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/tasks/claim`,
      {},
      { retryable: true },
    );
    if (response.task) {
      this.taskLeases.set(response.task.id, {
        attemptId: response.task.activeAttemptId,
        leaseToken: response.task.leaseToken,
      });
    }
    return response;
  }

  async claimRuntimeAppOperation(runtimeId: string): Promise<ClaimRuntimeAppOperationResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/apps/operations/claim`, {}, { retryable: true });
  }

  async startRuntimeAppOperation(operationId: string, body: StartRuntimeAppOperationRequest = {}): Promise<void> {
    await this.postJson(`/api/daemon/runtime-app-operations/${encodeURIComponent(operationId)}/start`, body);
  }

  async completeRuntimeAppOperation(operationId: string, body: CompleteRuntimeAppOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/runtime-app-operations/${encodeURIComponent(operationId)}/complete`, body);
  }

  async failRuntimeAppOperation(operationId: string, body: FailRuntimeAppOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/runtime-app-operations/${encodeURIComponent(operationId)}/fail`, body);
  }

  async startTask(taskId: string): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/start`, {}, { taskId });
  }

  async heartbeatTask(taskId: string): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/heartbeat`, {}, { taskId, retryable: true });
  }

  async getInputBundle(taskId: string): Promise<DaemonTaskInputBundle> {
    return this.getJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/input-bundle`, { retryable: true, taskId });
  }

  async reportMessages(taskId: string, body: ReportTaskMessagesRequest): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/messages`, body, { taskId });
  }

  async createRuntimeApproval(taskId: string, body: CreateRuntimeApprovalRequest): Promise<CreateRuntimeApprovalResponse> {
    return this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/runtime-approvals`, body, { taskId });
  }

  async getRuntimeApproval(taskId: string, approvalId: string): Promise<GetRuntimeApprovalResponse> {
    return this.getJson(
      `/api/daemon/tasks/${encodeURIComponent(taskId)}/runtime-approvals/${encodeURIComponent(approvalId)}`,
      { retryable: true, taskId },
    );
  }

  async uploadOutputBundle(taskId: string, bundle: DaemonTaskOutputBundle): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/output-bundle`, bundle, { taskId });
  }

  async completeTask(taskId: string, body: CompleteTaskRequest): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/complete`, body, { taskId });
    this.taskLeases.delete(taskId);
  }

  async failTask(taskId: string, body: FailTaskRequest): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/fail`, body, { taskId });
    this.taskLeases.delete(taskId);
  }

  async deregister(daemonKey: string, lastError?: string): Promise<void> {
    await this.postJson("/api/daemon/deregister", {
      daemonKey,
      lastError,
    });
  }

  private async getJson<T>(path: string, options?: { retryable?: boolean; taskId?: string }): Promise<T> {
    return this.requestJson<T>(path, {
      method: "GET",
      retryable: options?.retryable,
      taskId: options?.taskId,
    });
  }

  private async postJson<T>(path: string, body: unknown, options?: { retryable?: boolean; taskId?: string }): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      retryable: options?.retryable,
      taskId: options?.taskId,
    });
  }

  private buildHeaders(taskId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.daemonToken}`,
      "content-type": "application/json",
    };
    const lease = taskId ? this.taskLeases.get(taskId) : undefined;
    if (lease) {
      headers["x-agent-space-attempt-id"] = lease.attemptId;
      headers["x-agent-space-lease-token"] = lease.leaseToken;
    }
    return headers;
  }

  private resolveUrl(path: string): string {
    return new URL(path, this.serverUrl).toString();
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string;
      retryable?: boolean;
      taskId?: string;
    },
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      try {
        const response = await fetch(this.resolveUrl(path), {
          method: options.method,
          headers: this.buildHeaders(options.taskId),
          body: options.body,
        });

        if (options.retryable && response.status >= 500 && attempt < this.maxRetryAttempts) {
          await sleep(this.retryDelayMs);
          continue;
        }

        return this.readJson<T>(response);
      } catch (error) {
        lastError = error;
        if (!options.retryable || attempt >= this.maxRetryAttempts) {
          throw error;
        }
        await sleep(this.retryDelayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Daemon client request failed.");
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid error payloads.
      }
      throw new Error(message);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
