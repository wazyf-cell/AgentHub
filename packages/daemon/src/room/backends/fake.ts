import type { AgentBackend, AgentTurnRequest, AgentTurnResult, RoomMember } from "../types.ts";

export interface FakeBackendOptions {
  replies?: Record<string, string | string[]>;
  defaultReply?: (member: RoomMember) => string;
  failFor?: string[];
  costPerTurnYuan?: number;
  delayMs?: number;
}

export class FakeBackend implements AgentBackend {
  readonly id = "fake";
  private readonly options: FakeBackendOptions;
  private readonly calls = new Map<string, number>();

  constructor(options: FakeBackendOptions = {}) {
    this.options = options;
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.signal?.aborted) {
      return { text: "", status: "failed", error: "aborted" };
    }
    if (this.options.failFor?.includes(request.member.id)) {
      return { text: "", status: "failed", error: `fake backend failed for ${request.member.id}` };
    }
    if (this.options.delayMs && this.options.delayMs > 0) {
      await sleep(this.options.delayMs, request.signal);
    }
    if (request.signal?.aborted) {
      return { text: "", status: "failed", error: "aborted" };
    }

    const callIndex = this.calls.get(request.member.id) ?? 0;
    this.calls.set(request.member.id, callIndex + 1);
    const configured = this.options.replies?.[request.member.id];
    const reply = Array.isArray(configured)
      ? configured[Math.min(callIndex, configured.length - 1)]
      : configured ?? this.options.defaultReply?.(request.member) ?? `${request.member.name} 收到。DONE`;

    request.onDelta?.(reply);
    return {
      text: reply,
      status: "completed",
      usage: {
        inputTokens: Math.ceil(request.prompt.length / 4),
        outputTokens: Math.ceil(reply.length / 4),
        totalTokens: Math.ceil((request.prompt.length + reply.length) / 4),
      },
      costYuan: this.options.costPerTurnYuan ?? 0,
    };
  }
}

export function createDemoFakeBackend(): FakeBackend {
  return new FakeBackend({
    replies: {
      planner: "计划：先把任务拆成实现和审查两步，并记录风险。@implementer 请开始实现。",
      implementer: "实现思路：先定义房间和角色卡的数据结构，再做回合路由。@reviewer 请审查。",
      reviewer: "审查结论：结构完整，没有阻塞问题；下一步可以接真实 CLI。DONE",
    },
    defaultReply: (member) => `${member.name} 没有更多补充。DONE`,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
