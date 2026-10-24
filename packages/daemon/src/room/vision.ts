import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface VisionRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type VisionRunner = (command: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<VisionRunnerResult>;

export interface VisionRequest {
  imagePath: string;
  prompt?: string;
  cacheDir?: string;
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VisionResult {
  status: "completed" | "failed";
  description?: string;
  raw?: string;
  cached: boolean;
  error?: string;
}

export async function describeImage(
  request: VisionRequest,
  runner: VisionRunner = runVisionCommand,
): Promise<VisionResult> {
  if (!existsSync(request.imagePath)) {
    return { status: "failed", cached: false, error: `image not found: ${request.imagePath}` };
  }
  const command = request.command ?? "modlens";
  const key = createHash("sha256")
    .update(readFileSync(request.imagePath))
    .update("\0")
    .update(request.prompt ?? "")
    .update("\0")
    .update([command, ...(request.extraArgs ?? [])].join(" "))
    .digest("hex");

  const cacheFile = request.cacheDir ? join(request.cacheDir, `${key}.json`) : undefined;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { description?: string; raw?: string };
      if (cached.description) {
        return { status: "completed", description: cached.description, raw: cached.raw, cached: true };
      }
    } catch {
      // Ignore a corrupt cache entry and re-run the provider.
    }
  }

  const args = ["analyze", "-i", request.imagePath];
  if (request.prompt?.trim()) {
    args.push("--prompt", request.prompt.trim());
  }
  if (request.extraArgs?.length) {
    args.push(...request.extraArgs);
  }

  let result: VisionRunnerResult;
  try {
    result = await runner(command, args, request.timeoutMs ?? 180_000, request.signal);
  } catch (error) {
    return {
      status: "failed",
      cached: false,
      error: request.signal?.aborted
        ? "aborted"
        : `vision command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      status: "failed",
      cached: false,
      error: `vision command exited ${result.exitCode}: ${result.stderr.trim().slice(-400)}`,
    };
  }

  const raw = result.stdout.trim();
  const description = extractDescription(raw);
  if (!description) {
    return { status: "failed", cached: false, raw, error: "vision command returned no description" };
  }
  const value: VisionResult = { status: "completed", description, raw, cached: false };
  if (cacheFile) {
    try {
      mkdirSync(request.cacheDir!, { recursive: true });
      writeFileSync(cacheFile, `${JSON.stringify({ description, raw, createdAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    } catch {
      // The cache is an optimization; a read-only profile directory must not fail the call.
    }
  }
  return value;
}

function extractDescription(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["description", "summary", "text", "content"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) {
        return (parsed[key] as string).trim();
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function runVisionCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VisionRunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`vision command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill();
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode });
    });
  });
}
