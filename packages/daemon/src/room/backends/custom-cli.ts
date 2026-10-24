import { spawnSync } from "node:child_process";
import { runLaunchPlan } from "../../agent-router/subprocess.ts";
import { buildBaseEnv } from "../../agent-router/utils.ts";
import type { HarnessLaunchPlan } from "../../agent-router/types.ts";

export interface CustomCommandValues {
  prompt: string;
  model?: string;
  images?: string[];
}

export function splitCommandTemplate(template: string): string[] {
  const tokens: string[] = [];
  for (const match of template.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Placeholders: {prompt} {model} {image} (first image only) {images} (all images).
 * A bare {images} expands to one argument per image; inside a larger token the
 * images are joined with spaces. A template without {prompt} gets the prompt appended last.
 */
export function buildCustomCommand(
  template: string,
  values: CustomCommandValues,
): { plan: { executable: string; args: string[] } } | { error: string } {
  const tokens = splitCommandTemplate(template);
  if (tokens.length === 0) {
    return { error: "命令模板为空。" };
  }
  const args: string[] = [];
  let hasPrompt = false;

  for (const token of tokens.slice(1)) {
    if (token === "{images}") {
      args.push(...(values.images ?? []));
      continue;
    }
    const filled = token.replace(/\{prompt\}|\{model\}|\{images?\}/g, (placeholder) => {
      if (placeholder === "{prompt}") {
        hasPrompt = true;
        return values.prompt;
      }
      if (placeholder === "{model}") return values.model ?? "";
      if (placeholder === "{image}") return values.images?.[0] ?? "";
      return (values.images ?? []).join(" ");
    });
    if (filled.trim()) args.push(filled);
  }

  if (!hasPrompt) args.push(values.prompt);
  return { plan: { executable: tokens[0], args } };
}

export interface CustomCliTurnInput {
  template: string;
  prompt: string;
  model?: string;
  images?: string[];
  cwd: string;
  platformEnv?: Record<string, string>;
  timeoutMs: number;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface CustomCliTurnResult {
  text: string;
  status: "completed" | "failed";
  error?: string;
}

export async function runCustomCliTurn(input: CustomCliTurnInput): Promise<CustomCliTurnResult> {
  const built = buildCustomCommand(input.template, {
    prompt: input.prompt,
    model: input.model,
    images: input.images,
  });
  if ("error" in built) {
    return { text: "", status: "failed", error: built.error };
  }

  const env = buildBaseEnv(built.plan.executable, input.platformEnv ?? {}, []) as Record<string, string>;
  const plan: HarnessLaunchPlan = {
    executable: built.plan.executable,
    args: built.plan.args,
    cwd: input.cwd,
    env,
    timeoutMs: input.timeoutMs,
    redactions: [],
  };

  let pid: number | undefined;
  const onAbort = (): void => {
    if (pid) killProcessTree(pid);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await runLaunchPlan("custom", plan, {
      observer: {
        emit: (event) => {
          if (event.type === "harness_started") pid = event.pid;
        },
      },
      onStdout: (chunk) => input.onDelta?.(chunk),
    });
    if (input.signal?.aborted) {
      return { text: "", status: "failed", error: "已停止" };
    }
    if (result.timedOut) {
      return { text: "", status: "failed", error: `自定义 CLI 超时（${input.timeoutMs}ms）` };
    }
    const text = (result.stdout || "").trim();
    if (result.exitCode !== 0) {
      const tail = (result.stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
      return { text: "", status: "failed", error: `自定义 CLI 退出码 ${result.exitCode}${tail ? `：${tail}` : ""}` };
    }
    if (!text) {
      return { text: "", status: "failed", error: "自定义 CLI 没有输出内容。" };
    }
    return { text, status: "completed" };
  } catch (error) {
    return {
      text: "",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }
}
