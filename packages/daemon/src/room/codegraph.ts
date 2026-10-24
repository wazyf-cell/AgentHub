import { spawnSync } from "node:child_process";

export interface GraphToolStatus {
  available: boolean;
  command: string;
  detail?: string;
  index?: unknown;
  stale?: boolean;
}

function runGraph(command: string, args: string[], cwd: string, timeoutMs: number): { ok: boolean; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    timedOut: result.error?.message?.toLowerCase().includes("timed out") === true,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function graphBinary(): string {
  return process.env.CODEGRAPH_BIN || "codegraph";
}

export function graphStatus(workspace: string): GraphToolStatus {
  const command = graphBinary();
  const result = runGraph(command, ["status", "--json"], workspace, 15_000);
  if (!result.ok && !result.stdout.trim()) {
    return { available: false, command, detail: result.stderr.trim() || "未检测到 codegraph" };
  }
  const data = parseJson(result.stdout);
  return {
    available: true,
    command,
    detail: result.stderr.trim() || undefined,
    index: data,
    stale: readStale(data),
  };
}

function readStale(data: unknown): boolean | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const value = record.stale ?? record.isStale ?? record.outdated;
  return typeof value === "boolean" ? value : undefined;
}

export function graphQuery(workspace: string, query: string, limit = 40): { ok: boolean; data?: unknown; error?: string } {
  const result = runGraph(graphBinary(), ["query", query, "--json", "--limit", String(limit)], workspace, 30_000);
  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || "codegraph query 失败" };
  }
  const data = parseJson(result.stdout);
  return data === undefined
    ? { ok: false, error: "codegraph 输出不是 JSON" }
    : { ok: true, data };
}

export function graphImpact(workspace: string, target: string): { ok: boolean; data?: unknown; error?: string } {
  const result = runGraph(graphBinary(), ["impact", target, "--json"], workspace, 30_000);
  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || "codegraph impact 失败" };
  }
  const data = parseJson(result.stdout);
  return data === undefined
    ? { ok: false, error: "codegraph 输出不是 JSON" }
    : { ok: true, data };
}

export function graphSync(workspace: string, timeoutMs = 60_000): { ok: boolean; detail: string; timedOut: boolean } {
  const result = runGraph(graphBinary(), ["sync", "--json"], workspace, timeoutMs);
  return {
    ok: result.ok,
    detail: (result.stdout || result.stderr).trim(),
    timedOut: result.timedOut,
  };
}
