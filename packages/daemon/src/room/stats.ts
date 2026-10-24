import type { ModelDescriptor, RoomConfig, RoomEvent } from "./types.ts";
import type { RoomTask } from "./tasks.ts";

export interface StatsTotals {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costYuan: number;
}

export interface StatsBucket extends StatsTotals {
  key: string;
  label: string;
}

export interface LastTurnStats {
  at: string;
  memberId: string;
  memberName: string;
  platformId: string;
  modelId: string;
  inputTokens: number;
  contextWindow?: number;
}

export interface TaskStats {
  tasks: number;
  done: number;
  failed: number;
  costYuan: number;
  usageTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface RoomStats {
  roomId: string;
  generatedAt: string;
  since: string;
  cutoff?: string;
  totals: StatsTotals;
  tasks: TaskStats;
  byDay: StatsBucket[];
  byMember: StatsBucket[];
  byModel: StatsBucket[];
  lastTurn?: LastTurnStats;
}

export function emptyTotals(): StatsTotals {
  return {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costYuan: 0,
  };
}

export function parseSince(value: string | undefined, now = Date.now()): number | undefined {
  const text = (value ?? "all").trim().toLowerCase();
  if (!text || text === "all") return undefined;
  const relative = /^(\d+)\s*(h|d|w)$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "h" ? 3_600_000 : relative[2] === "d" ? 86_400_000 : 604_800_000;
    return now - amount * unitMs;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function addUsage(totals: StatsTotals, event: Extract<RoomEvent, { type: "turn_finished" }>): void {
  totals.requests += 1;
  if (event.status === "failed") totals.failed += 1;
  const usage = event.usage;
  totals.inputTokens += Number(usage?.inputTokens ?? 0);
  totals.outputTokens += Number(usage?.outputTokens ?? 0);
  totals.cacheReadTokens += Number(usage?.cacheReadTokens ?? 0);
  totals.cacheWriteTokens += Number(usage?.cacheWriteTokens ?? 0);
  totals.totalTokens += Number(usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
  totals.costYuan += Number(event.costYuan ?? 0);
}

function bucketOf(map: Map<string, StatsBucket>, key: string, label: string): StatsBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { key, label, ...emptyTotals() };
    map.set(key, bucket);
  }
  return bucket;
}

function localDateKey(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "unknown";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function computeRoomStats(
  room: RoomConfig,
  events: RoomEvent[],
  models: ModelDescriptor[] = [],
  options: { since?: string; now?: number; tasks?: RoomTask[] } = {},
): RoomStats {
  const now = options.now ?? Date.now();
  const cutoff = parseSince(options.since, now);
  const totals = emptyTotals();
  const taskSummary = summarizeTasks(options.tasks ?? []);
  const byDay = new Map<string, StatsBucket>();
  const byMember = new Map<string, StatsBucket>();
  const byModel = new Map<string, StatsBucket>();
  let lastTurn: LastTurnStats | undefined;

  for (const event of events) {
    if (event.type !== "turn_finished") continue;
    const at = Date.parse(event.ts);
    if (cutoff !== undefined && (Number.isNaN(at) || at < cutoff)) continue;
    const member = room.members.find((candidate) => candidate.id === event.memberId);
    const platformId = event.platformId ?? member?.binding.platformId ?? "unknown";
    const modelId = event.modelId ?? member?.binding.modelId ?? "unknown";
    const memberName = member?.name ?? event.memberId;

    addUsage(totals, event);
    addUsage(bucketOf(byDay, localDateKey(event.ts), localDateKey(event.ts)), event);
    addUsage(bucketOf(byMember, event.memberId, memberName), event);
    addUsage(bucketOf(byModel, `${platformId}/${modelId}`, `${platformId} / ${modelId}`), event);

    if (!lastTurn || Date.parse(lastTurn.at) <= at) {
      const descriptor = models.find((model) => model.platformId === platformId && model.modelId === modelId);
      lastTurn = {
        at: event.ts,
        memberId: event.memberId,
        memberName,
        platformId,
        modelId,
        inputTokens: Number(event.usage?.contextTokens ?? event.usage?.inputTokens ?? 0),
        contextWindow: descriptor?.contextWindow ?? member?.binding.contextWindow,
      };
    }
  }

  const sortBuckets = (map: Map<string, StatsBucket>, byKey: boolean): StatsBucket[] =>
    [...map.values()].sort((left, right) =>
      byKey ? left.key.localeCompare(right.key) : right.totalTokens - left.totalTokens);

  totals.costYuan += taskSummary.costYuan;
  totals.totalTokens += taskSummary.usageTokens;
  totals.inputTokens += taskSummary.inputTokens;
  totals.outputTokens += taskSummary.outputTokens;
  totals.cacheReadTokens += taskSummary.cacheReadTokens;

  return {
    roomId: room.id,
    generatedAt: new Date(now).toISOString(),
    since: options.since ?? "all",
    cutoff: cutoff === undefined ? undefined : new Date(cutoff).toISOString(),
    totals,
    tasks: taskSummary,
    byDay: sortBuckets(byDay, true),
    byMember: sortBuckets(byMember, false),
    byModel: sortBuckets(byModel, false),
    lastTurn,
  };
}

export function summarizeTasks(tasks: RoomTask[]): TaskStats {
  const summary: TaskStats = {
    tasks: tasks.length,
    done: 0,
    failed: 0,
    costYuan: 0,
    usageTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };
  for (const task of tasks) {
    if (task.status === "done") summary.done += 1;
    if (task.status === "failed") summary.failed += 1;
    summary.costYuan += Number(task.costYuan ?? 0);
    summary.usageTokens += Number(task.usageTokens ?? 0);
    summary.inputTokens += Number(task.inputTokens ?? 0);
    summary.outputTokens += Number(task.outputTokens ?? 0);
    summary.cacheReadTokens += Number(task.cacheReadTokens ?? 0);
  }
  return summary;
}

export function roomSpent(events: RoomEvent[], tasks: RoomTask[]): { costYuan: number; totalTokens: number } {
  let costYuan = 0;
  let totalTokens = 0;
  for (const event of events) {
    if (event.type !== "turn_finished") continue;
    costYuan += Number(event.costYuan ?? 0);
    totalTokens += Number(event.usage?.totalTokens ?? 0);
  }
  const taskSummary = summarizeTasks(tasks);
  return {
    costYuan: costYuan + taskSummary.costYuan,
    totalTokens: totalTokens + taskSummary.usageTokens,
  };
}

export function cacheHitRate(totals: StatsTotals): number | undefined {
  if (totals.inputTokens <= 0 || totals.cacheReadTokens <= 0) return undefined;
  return totals.cacheReadTokens / totals.inputTokens;
}
