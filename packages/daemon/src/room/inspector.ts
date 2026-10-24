import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { assertInside } from "./worktrees.ts";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 4000;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export interface InspectorEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface ReadResult {
  path: string;
  kind: "text" | "image" | "binary";
  encoding?: string;
  content?: string;
  dataUrl?: string;
  mime?: string;
  size: number;
  offset: number;
  nextOffset?: number;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 30_000): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function workspacePath(root: string): string {
  const value = resolve(root);
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    throw new Error(`工作区目录不存在：${value}`);
  }
  return value;
}

export function listTree(root: string, relativePath = "", maxDepth = 2): InspectorEntry[] {
  const workspace = workspacePath(root);
  const base = assertInside(workspace, relativePath || ".");
  const baseStat = statSync(base);
  if (!baseStat.isDirectory()) {
    throw new Error("不是文件夹。");
  }
  const entries: InspectorEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
    for (const child of children) {
      if (child.name === ".git" || child.name === "node_modules") continue;
      const absolute = join(dir, child.name);
      const rel = absolute.slice(workspace.length + 1).split("\\").join("/");
      if (child.isDirectory()) {
        entries.push({ name: child.name, path: rel, type: "dir" });
        if (depth < maxDepth) walk(absolute, depth + 1);
      } else if (child.isFile()) {
        let size: number | undefined;
        try {
          size = statSync(absolute).size;
        } catch {
          size = undefined;
        }
        entries.push({ name: child.name, path: rel, type: "file", size });
      }
      if (entries.length >= MAX_TREE_ENTRIES) return;
    }
  };
  walk(base, 0);
  return entries;
}

export interface FileMatch {
  path: string;
  name: string;
}

const IGNORED_DIRS = new Set([".git", "node_modules", ".agentspace", "dist", "dist-electron-out", "dist-electron-local-out"]);

export function listFiles(root: string, query = "", limit = 200): FileMatch[] {
  const workspace = workspacePath(root);
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= 5000) return;
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (files.length >= 5000) return;
      if (child.name.startsWith(".")) continue;
      if (child.isDirectory()) {
        if (IGNORED_DIRS.has(child.name)) continue;
        walk(join(dir, child.name));
      } else if (child.isFile()) {
        files.push(join(dir, child.name).slice(workspace.length + 1).split("\\").join("/"));
      }
    }
  };
  walk(workspace);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? files
      .map((path) => ({ path, score: fuzzyScore(path.toLowerCase(), needle) }))
      .filter((entry) => entry.score !== undefined)
      .sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.path.length - right.path.length)
      .map((entry) => entry.path)
    : files.sort((left, right) => left.localeCompare(right, "zh-CN"));
  return matches.slice(0, Math.max(1, Math.min(limit, 500))).map((path) => ({
    path,
    name: path.split("/").pop() ?? path,
  }));
}

function fuzzyScore(path: string, needle: string): number | undefined {
  const direct = path.indexOf(needle);
  if (direct >= 0) return direct;
  let cursor = 0;
  for (const char of path) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 1_000 + path.length;
  }
  return undefined;
}

function decodeBuffer(buffer: Buffer, filePath: string): { text: string; encoding: string } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "UTF-16LE" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buffer.subarray(2)), encoding: "UTF-16BE" };
  }
  const utf8 = buffer.subarray(buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(utf8), encoding: "UTF-8" };
  } catch {
    try {
      return { text: new TextDecoder("gbk").decode(buffer), encoding: "GBK" };
    } catch {
      return { text: buffer.toString("utf8"), encoding: `UTF-8（${extname(filePath) || "未知"}）` };
    }
  }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function readWorkspaceFile(root: string, relativePath: string, offset = 0): ReadResult {
  const workspace = workspacePath(root);
  const target = assertInside(workspace, relativePath);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`文件不存在：${relativePath}`);
  }
  const size = statSync(target).size;
  const mime = IMAGE_MIME[extname(target).toLowerCase()];
  if (mime) {
    if (size > 8 * 1024 * 1024) {
      return { path: relativePath, kind: "binary", mime, size, offset: 0, truncated: true };
    }
    const data = readFileSync(target).toString("base64");
    return { path: relativePath, kind: "image", mime, dataUrl: `data:${mime};base64,${data}`, size, offset: 0, truncated: false };
  }
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, size));
  const length = Math.min(MAX_PAGE_BYTES, Math.max(0, size - safeOffset));
  const buffer = Buffer.alloc(length);
  const fd = openSync(target, "r");
  try {
    readSync(fd, buffer, 0, length, safeOffset);
  } finally {
    closeSync(fd);
  }
  if (looksBinary(buffer)) {
    return { path: relativePath, kind: "binary", mime: "application/octet-stream", size, offset: safeOffset, truncated: safeOffset + length < size };
  }
  const decoded = decodeBuffer(buffer, target);
  return {
    path: relativePath,
    kind: "text",
    encoding: decoded.encoding,
    content: decoded.text,
    size,
    offset: safeOffset,
    nextOffset: safeOffset + length < size ? safeOffset + length : undefined,
    truncated: safeOffset + length < size,
  };
}

export function gitStatus(root: string): { branch: string; files: GitFileStatus[]; clean: boolean } {
  const workspace = workspacePath(root);
  const branchResult = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], workspace);
  if (!branchResult.ok) {
    throw new Error("这个工作区不是 git 仓库。");
  }
  const result = run("git", ["status", "--porcelain=v1"], workspace);
  const files: GitFileStatus[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3).trim().split(" -> ").pop() || "";
    if (!path) continue;
    files.push({ path, status, staged: status[0] !== " " && status[0] !== "?" });
  }
  return { branch: branchResult.stdout.trim(), files, clean: files.length === 0 };
}

export function gitDiff(root: string, options: { staged?: boolean; file?: string } = {}): string {
  const workspace = workspacePath(root);
  const args = ["diff"];
  if (options.staged) args.push("--cached");
  if (options.file) args.push("--", options.file);
  const result = run("git", args, workspace, 60_000);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || "git diff 失败。");
  }
  const text = result.stdout;
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…（diff 已截断）` : text || "（没有差异）";
}

export function searchWorkspace(root: string, query: string, limit = 200): { engine: "ripgrep" | "fallback"; hits: SearchHit[]; truncated: boolean } {
  const workspace = workspacePath(root);
  const trimmed = String(query || "").trim();
  if (!trimmed) return { engine: "ripgrep", hits: [], truncated: false };
  const rg = run("rg", [
    "--line-number", "--column", "--no-heading", "--color", "never",
    "--hidden", "--glob", "!.git", "--glob", "!node_modules",
    "--max-count", "20", "--", trimmed, ".",
  ], workspace, 30_000);
  if (!rg.stderr.includes("ENOENT") && (rg.ok || rg.stdout.trim())) {
    const hits: SearchHit[] = [];
    for (const line of rg.stdout.split(/\r?\n/)) {
      if (!line.trim() || hits.length >= limit) continue;
      const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
      if (!match) continue;
      hits.push({
        path: match[1].replace(/^[.][\\/]/, ""),
        line: Number(match[2]),
        column: Number(match[3]),
        text: match[4],
      });
    }
    return { engine: "ripgrep", hits, truncated: hits.length >= limit };
  }
  const hits: SearchHit[] = [];
  const needle = trimmed.toLowerCase();
  const walk = (dir: string): void => {
    if (hits.length >= limit) return;
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (hits.length >= limit) return;
      if (child.name === ".git" || child.name === "node_modules") continue;
      const absolute = join(dir, child.name);
      if (child.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      const size = statSync(absolute).size;
      if (size > 2 * 1024 * 1024) continue;
      let text: string;
      try {
        text = decodeBuffer(readFileSync(absolute), absolute).text;
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      text.split(/\r?\n/).forEach((line, index) => {
        if (hits.length >= limit) return;
        const column = line.toLowerCase().indexOf(needle);
        if (column >= 0) {
          const rel = absolute.slice(workspace.length + 1).split("\\").join("/");
          hits.push({ path: rel, line: index + 1, column: column + 1, text: line });
        }
      });
    }
  };
  walk(workspace);
  return { engine: "fallback", hits, truncated: hits.length >= limit };
}

export function detectTools(): Array<{ id: string; label: string; available: boolean; version?: string }> {
  const probes: Array<{ id: string; label: string; command: string; args: string[] }> = [
    { id: "git", label: "git", command: "git", args: ["--version"] },
    { id: "rg", label: "ripgrep", command: "rg", args: ["--version"] },
    { id: "codegraph", label: "codegraph", command: process.env.CODEGRAPH_BIN || "codegraph", args: ["--version"] },
    { id: "es", label: "Everything es.exe", command: process.env.ES_BIN || "es", args: ["-version"] },
  ];
  return probes.map((probe) => {
    const result = run(probe.command, probe.args, process.cwd(), 5000);
    const line = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim();
    return { id: probe.id, label: probe.label, available: result.ok, version: result.ok ? line : undefined };
  });
}
