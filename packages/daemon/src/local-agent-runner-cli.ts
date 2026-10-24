#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { LocalAgentRunnerEvent } from "./local-agent-runner.ts";
import {
  DEFAULT_LOCAL_AGENT_CONFIG_FILE,
  detectLocalAgentProviders,
  runLocalAgents,
  writeDefaultLocalAgentConfig,
} from "./local-agent-runner.ts";

export async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return 0;
  }

  const [command, ...rest] = args;
  if (command === "init") {
    return initCommand(rest);
  }
  if (command === "detect") {
    console.log(JSON.stringify(await detectLocalAgentProviders(), null, 2));
    return 0;
  }
  if (command === "run") {
    return runCommand(rest);
  }

  console.error(`Unknown agent-space-local command "${command}".`);
  printHelp();
  return 1;
}

function initCommand(args: string[]): number {
  const parsed = parseArgs(args);
  const configPath = getStringFlag(parsed.flags, "config") ?? DEFAULT_LOCAL_AGENT_CONFIG_FILE;
  const written = writeDefaultLocalAgentConfig(configPath);
  console.log(JSON.stringify({ status: "success", summary: "Local agent config created.", artifacts: [written] }, null, 2));
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) {
    console.error("agent-space-local run requires a prompt.");
    return 1;
  }

  const jsonEvents = parsed.flags["json-events"] === true;
  const result = await runLocalAgents(prompt, {
    configPath: getStringFlag(parsed.flags, "config"),
    cwd: getStringFlag(parsed.flags, "cwd"),
    outputDir: getStringFlag(parsed.flags, "output-dir"),
    selectedAgentIds: parseCsvFlag(getStringFlag(parsed.flags, "agents")),
    taskMode: parseTaskModeFlag(getStringFlag(parsed.flags, "mode")),
    jsonEvents,
    onEvent: (event) => emitEvent(event, jsonEvents),
  });

  if (jsonEvents) {
    console.log(JSON.stringify({ type: "result", ...result }));
  } else {
    printTextResult(result);
  }
  return result.status === "completed" ? 0 : 1;
}

function emitEvent(event: LocalAgentRunnerEvent, jsonEvents: boolean): void {
  if (jsonEvents) {
    console.log(JSON.stringify(event));
    return;
  }
  if (event.type === "run_started") {
    console.error(`Local run ${event.runId} started: ${event.agentIds.join(", ")}`);
  }
  if (event.type === "agent_started") {
    console.error(`Agent ${event.agentId} started (${event.harness}).`);
  }
  if (event.type === "agent_finished") {
    console.error(`Agent ${event.agentId} finished: ${event.status}.`);
  }
  if (event.type === "run_finished") {
    console.error(`Local run ${event.runId} finished: ${event.status}. Artifact: ${event.artifactPath}`);
  }
}

function printTextResult(result: Awaited<ReturnType<typeof runLocalAgents>>): void {
  console.log(`Run: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Artifact: ${result.artifactPath}`);
  for (const step of result.agents) {
    console.log(`\n## ${step.agent.name ?? step.agent.id} (${step.status})`);
    if (step.outputText?.trim()) {
      console.log(step.outputText.trim());
    }
    for (const diagnostic of step.diagnostics) {
      console.log(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const booleanFlags = new Set(["json-events"]);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      flags[key] = true;
      continue;
    }

    const nextValue = args[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = nextValue;
    index += 1;
  }
  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function parseCsvFlag(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseTaskModeFlag(value: string | undefined): "auto" | "smoke-test" | "analysis" | "development" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "auto" || value === "smoke-test" || value === "analysis" || value === "development") {
    return value;
  }
  throw new Error("--mode must be one of auto, smoke-test, analysis, development.");
}

export function printHelp(): void {
  console.error(`Usage:
  agent-space-local init [--config agentspace.local.json]
  agent-space-local detect
  agent-space-local run [--config agentspace.local.json] [--cwd <dir>] [--output-dir <dir>] [--agents planner,reviewer] [--mode auto|smoke-test|analysis|development] [--json-events] <prompt>

Examples:
  agent-space-local init
  agent-space-local detect
  agent-space-local run --cwd . "review this repository"
  agent-space-local run --mode smoke-test "测试一下模型，说一下你好"
  agent-space-local run --agents planner,reviewer "make a focused implementation plan"`);
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}
