import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);
const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".ps1", ""];

export function shouldUseWindowsShellForExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const candidate = executable.trim();
  if (!candidate) {
    return false;
  }
  if (hasWindowsShellExtension(candidate)) {
    return true;
  }

  const resolved = resolveWindowsExecutableCandidate(candidate, environment);
  return resolved ? hasWindowsShellExtension(resolved) : false;
}

export function buildWindowsShellCommandLine(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!shouldUseWindowsShellForExecutable(executable, environment)) {
    return undefined;
  }
  return [quoteWindowsShellArg(executable), ...args.map((arg) => quoteWindowsShellArg(arg))].join(" ");
}

function resolveWindowsExecutableCandidate(executable: string, environment: NodeJS.ProcessEnv): string | undefined {
  const extensions = readWindowsExecutableExtensions(environment);
  if (isPathLike(executable)) {
    return resolveExistingCandidate(executable, extensions);
  }

  const pathValue = readEnvPath(environment);
  if (!pathValue) {
    return undefined;
  }
  for (const baseDir of pathValue.split(delimiter).filter(Boolean)) {
    const resolved = resolveExistingCandidate(join(baseDir, executable), extensions);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function resolveExistingCandidate(basePath: string, extensions: string[]): string | undefined {
  if (existsSync(basePath)) {
    return basePath;
  }
  for (const extension of extensions) {
    if (!extension || basePath.toLowerCase().endsWith(extension.toLowerCase())) {
      continue;
    }
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readWindowsExecutableExtensions(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.PATHEXT || environment.PathExt || environment.Pathext;
  const extensions = raw
    ? raw.split(";").map((value) => value.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS;
  return [...new Set([...extensions, ...DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS])];
}

function readEnvPath(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.PATH || environment.Path || environment.path;
}

function hasWindowsShellExtension(value: string): boolean {
  const lower = value.toLowerCase();
  for (const extension of WINDOWS_SHELL_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function quoteWindowsShellArg(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ");
  if (normalized.length === 0) {
    return "\"\"";
  }
  if (/^[A-Za-z0-9_./:@%+=,\-[\]{}]+$/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, "\\\"")}"`;
}
