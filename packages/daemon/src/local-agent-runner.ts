import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRouterEvent, AgentRouterHarness, AgentRouterRunResult } from "./agent-router/index.ts";
import { detectAgentRouterHarnesses, isAgentRouterHarness, runAgentRouter } from "./agent-router/router.ts";

export const DEFAULT_LOCAL_AGENT_CONFIG_FILE = "agentspace.local.json";

export interface LocalAgentRunnerConfig {
  version?: 1;
  cwd?: string;
  outputDir?: string;
  agents: LocalAgentDefinition[];
}

export interface LocalAgentDefinition {
  id: string;
  name?: string;
  harness: AgentRouterHarness;
  model?: string;
  mode?: string;
  executablePath?: string;
  role?: string;
  timeoutMs?: number;
}

export interface LocalAgentRunOptions {
  configPath?: string;
  cwd?: string;
  outputDir?: string;
  selectedAgentIds?: string[];
  taskMode?: LocalAgentTaskMode;
  jsonEvents?: boolean;
  onEvent?: (event: LocalAgentRunnerEvent) => void;
}

export type LocalAgentTaskMode = "auto" | "smoke-test" | "analysis" | "development";

export type LocalAgentRunnerEvent =
  | { type: "run_started"; runId: string; cwd: string; agentIds: string[] }
  | { type: "agent_started"; agentId: string; harness: AgentRouterHarness }
  | { type: "agent_event"; agentId: string; event: AgentRouterEvent }
  | { type: "agent_finished"; agentId: string; status: AgentRouterRunResult["status"] }
  | { type: "run_finished"; runId: string; status: LocalAgentRunResult["status"]; artifactPath: string };

export interface LocalAgentRunResult {
  runId: string;
  status: "completed" | "failed";
  prompt: string;
  taskMode: LocalAgentTaskMode;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  agents: LocalAgentStepResult[];
  artifactPath: string;
}

export interface LocalAgentStepResult {
  agent: LocalAgentDefinition;
  status: AgentRouterRunResult["status"];
  outputText?: string;
  diagnostics: AgentRouterRunResult["diagnostics"];
  startedAt: string;
  finishedAt: string;
}

export function readLocalAgentRunnerConfig(configPath = DEFAULT_LOCAL_AGENT_CONFIG_FILE): LocalAgentRunnerConfig {
  const resolvedPath = resolve(configPath);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  return normalizeLocalAgentRunnerConfig(parsed, resolvedPath);
}

export async function detectLocalAgentProviders(): ReturnType<typeof detectAgentRouterHarnesses> {
  return detectAgentRouterHarnesses();
}

export async function runLocalAgents(prompt: string, options: LocalAgentRunOptions = {}): Promise<LocalAgentRunResult> {
  const configPath = options.configPath ?? DEFAULT_LOCAL_AGENT_CONFIG_FILE;
  const config = readLocalAgentRunnerConfig(configPath);
  const cwd = resolve(options.cwd ?? config.cwd ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? config.outputDir ?? ".agentspace/runs");
  const agents = selectLocalAgents(config.agents, options.selectedAgentIds);
  const taskMode = resolveLocalAgentTaskMode(prompt, options.taskMode ?? "auto");
  const runId = `local-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const results: LocalAgentStepResult[] = [];

  options.onEvent?.({ type: "run_started", runId, cwd, agentIds: agents.map((agent) => agent.id) });

  let priorContext = "";
  for (const agent of agents) {
    options.onEvent?.({ type: "agent_started", agentId: agent.id, harness: agent.harness });
    const agentPrompt = buildAgentPrompt(prompt, agent, priorContext, taskMode);
    const result = await runAgentRouter({
      version: 1,
      harness: agent.harness,
      prompt: agentPrompt,
      cwd,
      executablePath: agent.executablePath,
      model: agent.model,
      mode: agent.mode,
      timeoutMs: agent.timeoutMs,
      outputFormat: "text",
    }, {
      emit: (event) => {
        options.onEvent?.({ type: "agent_event", agentId: agent.id, event });
      },
    });

    results.push({
      agent,
      status: result.status,
      outputText: result.outputText,
      diagnostics: result.diagnostics,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    });
    options.onEvent?.({ type: "agent_finished", agentId: agent.id, status: result.status });

    if (result.outputText?.trim()) {
      priorContext += `\n\n## ${agent.name ?? agent.id}\n${result.outputText.trim()}`;
    }
    if (result.status !== "completed") {
      break;
    }
  }

  const finishedAt = new Date().toISOString();
  const status = results.every((result) => result.status === "completed") ? "completed" : "failed";
  mkdirSync(outputDir, { recursive: true });
  const artifactPath = resolve(outputDir, `${runId}.json`);
  const runResult: LocalAgentRunResult = {
    runId,
    status,
    prompt,
    taskMode,
    cwd,
    startedAt,
    finishedAt,
    agents: results,
    artifactPath,
  };
  writeFileSync(artifactPath, `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  options.onEvent?.({ type: "run_finished", runId, status, artifactPath });
  return runResult;
}

export function writeDefaultLocalAgentConfig(configPath = DEFAULT_LOCAL_AGENT_CONFIG_FILE): string {
  const resolvedPath = resolve(configPath);
  if (existsSync(resolvedPath)) {
    throw new Error(`${resolvedPath} already exists.`);
  }
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(buildDefaultLocalAgentConfig(), null, 2)}\n`, "utf8");
  return resolvedPath;
}

function normalizeLocalAgentRunnerConfig(value: unknown, configPath: string): LocalAgentRunnerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${configPath} must contain a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const agentsValue = record.agents;
  if (!Array.isArray(agentsValue) || agentsValue.length === 0) {
    throw new Error(`${configPath} must define a non-empty agents array.`);
  }
  return {
    version: record.version === 1 ? 1 : undefined,
    cwd: readOptionalString(record.cwd),
    outputDir: readOptionalString(record.outputDir),
    agents: agentsValue.map((agent, index) => normalizeLocalAgentDefinition(agent, `${configPath}:agents[${index}]`)),
  };
}

function normalizeLocalAgentDefinition(value: unknown, path: string): LocalAgentDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const id = readRequiredString(record.id, `${path}.id`);
  const harness = readRequiredString(record.harness, `${path}.harness`);
  if (!isAgentRouterHarness(harness)) {
    throw new Error(`${path}.harness must be one of claude, codex, opencode, openclaw, hermes.`);
  }
  return {
    id,
    name: readOptionalString(record.name),
    harness,
    model: readOptionalString(record.model),
    mode: readOptionalString(record.mode),
    executablePath: readOptionalString(record.executablePath),
    role: readOptionalString(record.role),
    timeoutMs: readOptionalNumber(record.timeoutMs),
  };
}

function selectLocalAgents(agents: LocalAgentDefinition[], selectedAgentIds: string[] | undefined): LocalAgentDefinition[] {
  if (!selectedAgentIds || selectedAgentIds.length === 0) {
    return agents;
  }
  const selected = new Set(selectedAgentIds);
  const result = agents.filter((agent) => selected.has(agent.id));
  const missing = [...selected].filter((id) => !agents.some((agent) => agent.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown local agent id(s): ${missing.join(", ")}.`);
  }
  return result;
}

function buildAgentPrompt(
  originalPrompt: string,
  agent: LocalAgentDefinition,
  priorContext: string,
  taskMode: LocalAgentTaskMode,
): string {
  const modeInstruction = buildTaskModeInstruction(taskMode, agent);
  const parts = [
    `Local AgentSpace agent: ${agent.name ?? agent.id}.`,
    agent.role ? `Role: ${agent.role}.` : undefined,
    modeInstruction,
    priorContext.trim() ? `Previous agent outputs: ${compactForCliArgument(priorContext)}` : undefined,
    `User task: ${compactForCliArgument(originalPrompt)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

function resolveLocalAgentTaskMode(prompt: string, requested: LocalAgentTaskMode): LocalAgentTaskMode {
  if (requested !== "auto") {
    return requested;
  }
  const compact = compactForCliArgument(prompt).toLowerCase();
  if (
    compact.length <= 80
    && /(你好|hello|hi|test|测试|模型|ping|smoke)/i.test(compact)
    && !/(代码|修复|实现|开发|计划|分析项目|review|bug|文件|仓库|repo)/i.test(compact)
  ) {
    return "smoke-test";
  }
  if (/(修复|实现|开发|代码|bug|测试用例|commit|patch|改动|文件)/i.test(compact)) {
    return "development";
  }
  return "analysis";
}

function buildTaskModeInstruction(taskMode: LocalAgentTaskMode, agent: LocalAgentDefinition): string {
  const agentId = agent.id.toLowerCase();
  if (taskMode === "smoke-test") {
    return "Task mode: smoke-test. The user is checking whether the model and local runner work. Reply directly to the requested test. Do not invent missing development obligations. If prior agents already answered correctly, confirm the chain worked in one short sentence.";
  }
  if (taskMode === "analysis") {
    return agentId.includes("review")
      ? "Task mode: analysis. Review prior outputs for correctness and add missing practical next steps. Do not report bugs merely because a simple user request did not need code changes."
      : "Task mode: analysis. Analyze the user task and produce concrete findings or next steps. Inspect the cwd only if it materially improves the answer.";
  }
  return agentId.includes("planner")
    ? "Task mode: development. Produce a concise implementation plan with risks and verification steps."
    : agentId.includes("review")
      ? "Task mode: development. Review prior outputs for concrete defects, missing verification, and safe next actions. Distinguish real bugs from task-scope choices."
      : "Task mode: development. Use prior outputs to implement or specify the concrete change. If you cannot edit, explain exact files and changes needed.";
}

function buildDefaultLocalAgentConfig(): LocalAgentRunnerConfig {
  return {
    version: 1,
    cwd: ".",
    outputDir: ".agentspace/runs",
    agents: [
      {
        id: "planner",
        name: "Planner",
        harness: "codex",
        role: "Break down the task, identify risks, and produce a short implementation plan.",
      },
      {
        id: "implementer",
        name: "Implementer",
        harness: "codex",
        role: "Use the plan and prior output to implement or explain the concrete change.",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        harness: "codex",
        role: "Review the result for bugs, missing verification, and next steps.",
      },
    ],
  };
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function compactForCliArgument(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
