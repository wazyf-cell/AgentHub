import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorktreeInfo {
  repo: string;
  path: string;
  branch: string;
  head: string;
  created: boolean;
}

export interface MergeResult {
  status: "merged" | "conflict" | "dirty" | "error";
  detail?: string;
  stdout?: string;
}

function git(cwd: string, args: string[], timeoutMs = 120_000): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

export function gitRoot(target: string): string | undefined {
  if (!existsSync(target)) return undefined;
  const result = git(target, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolve(root) : undefined;
}

export function requireGitRoot(target: string): string {
  if (!target || !existsSync(target)) {
    throw new Error("房间尚未绑定工作区。");
  }
  if (!statSync(target).isDirectory()) {
    throw new Error("房间工作区不是文件夹。");
  }
  const root = gitRoot(target);
  if (!root) {
    throw new Error("任务需要 git 仓库；这个工作区不是 git 仓库。");
  }
  const expected = resolve(target);
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedExpected = process.platform === "win32" ? expected.toLowerCase() : expected;
  if (normalizedRoot !== normalizedExpected) {
    throw new Error(`请选择 git 仓库根目录（仓库根是 ${root}，当前是子目录）。`);
  }
  return root;
}

export function isGitRepoRoot(target: string): boolean {
  try {
    requireGitRoot(target);
    return true;
  } catch {
    return false;
  }
}

export function isClean(repo: string): boolean {
  const result = git(repo, ["status", "--porcelain"]);
  return result.status === 0 && result.stdout.trim() === "";
}

export function currentBranch(repo: string): string {
  const result = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "无法读取当前分支。");
  }
  return result.stdout.trim();
}

export function headCommit(repo: string): string {
  const result = git(repo, ["rev-parse", "HEAD"]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "无法读取 HEAD。");
  }
  return result.stdout.trim();
}

export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]).status === 0;
}

export function worktreePathFor(repo: string, taskId: string): string {
  const name = basename(repo) || "repo";
  return join(dirname(repo), `${name}-agenthub-worktrees`, taskId);
}

export function listWorktrees(repo: string): Array<{ path: string; branch?: string; head?: string }> {
  const result = git(repo, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return [];
  const entries: Array<{ path: string; branch?: string; head?: string }> = [];
  let current: { path: string; branch?: string; head?: string } | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: resolve(line.slice("worktree ".length).trim()) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function createTaskWorktree(options: {
  repo: string;
  taskId: string;
  base?: string;
  branch?: string;
  requireClean?: boolean;
}): WorktreeInfo {
  const repo = requireGitRoot(options.repo);
  if (options.requireClean !== false && !isClean(repo)) {
    throw new Error("主工作区不干净；请先提交或收起改动，再创建任务 worktree。");
  }
  const branch = options.branch ?? `agenthub/${options.taskId}`;
  const path = worktreePathFor(repo, options.taskId);
  const existing = listWorktrees(repo).find((entry) => entry.path.toLowerCase() === path.toLowerCase());
  if (existing) {
    return {
      repo,
      path,
      branch: existing.branch ?? branch,
      head: existing.head ?? headCommit(repo),
      created: false,
    };
  }
  if (existsSync(path)) {
    throw new Error(`Worktree 目录已存在但不是已注册的 worktree：${path}`);
  }
  const base = options.base ?? headCommit(repo);
  const branchExisted = branchExists(repo, branch);
  const args = branchExisted
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];
  const result = git(repo, args);
  if (result.status !== 0) {
    // Roll back anything this call created, but never delete a pre-existing branch.
    try {
      if (existsSync(path)) {
        git(repo, ["worktree", "remove", "--force", path]);
        rmSync(path, { recursive: true, force: true });
        git(repo, ["worktree", "prune"]);
      }
      if (!branchExisted) {
        git(repo, ["branch", "-D", branch]);
      }
    } catch {
      // Best-effort rollback.
    }
    throw new Error(`创建 worktree 失败：${(result.stderr || result.stdout || result.error || "").trim()}`);
  }
  return {
    repo,
    path,
    branch,
    head: branchExists(repo, branch) ? headCommit(path) : base,
    created: true,
  };
}

export function discardWorktree(repo: string, worktreePath: string, options: { force?: boolean } = {}): void {
  const root = requireGitRoot(repo);
  const args = ["worktree", "remove", worktreePath];
  if (options.force) args.push("--force");
  const result = git(root, args);
  if (result.status !== 0) {
    if (!options.force) {
      throw new Error(result.stderr.trim() || "无法移除 worktree；可能还有未提交改动。");
    }
    rmSync(worktreePath, { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
  }
}

export function changedPaths(worktree: string): string[] {
  const result = git(worktree, ["status", "--porcelain=v1", "-z"]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "无法读取 worktree 状态。");
  }
  const entries = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const next = entries[index] ?? "";
      if (path) paths.push(path);
      if (next) paths.push(next);
    } else if (path) {
      paths.push(path);
    }
  }
  return [...new Set(paths.map((item) => item.split(/[\\/]+/).join("/")))];
}

export function commitAll(worktree: string, message: string): string | undefined {
  if (changedPaths(worktree).length === 0) {
    return undefined;
  }
  const add = git(worktree, ["add", "-A"]);
  if (add.status !== 0) {
    throw new Error(add.stderr.trim() || "git add 失败。");
  }
  const commit = git(worktree, [
    "-c", "user.name=AgentHub",
    "-c", "user.email=agenthub@local",
    "commit", "-m", message,
  ]);
  if (commit.status !== 0) {
    throw new Error(commit.stderr.trim() || commit.stdout.trim() || "git commit 失败。");
  }
  return headCommit(worktree);
}

export function diffStat(repo: string, base: string, branch: string): string {
  const result = git(repo, ["diff", "--stat", `${base}...${branch}`]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export function diffText(repo: string, base: string, branch: string, maxChars = 40_000): string {
  const result = git(repo, ["diff", `${base}...${branch}`], 60_000);
  const text = result.stdout || "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（diff 已截断）` : text;
}

export function mergeFastForward(repo: string, branch: string): MergeResult {
  const root = requireGitRoot(repo);
  if (!isClean(root)) {
    return { status: "dirty", detail: "主工作区有未提交改动；请先处理后再合并。" };
  }
  const target = currentBranch(root);
  const result = git(root, ["merge", "--ff-only", branch]);
  if (result.status === 0) {
    return { status: "merged", stdout: result.stdout.trim() };
  }
  const detail = (result.stderr || result.stdout || "").trim();
  if (/not possible to fast-forward|diverged|CONFLICT|fatal: Not possible/i.test(detail)) {
    return { status: "conflict", detail, stdout: result.stdout };
  }
  return { status: "error", detail };
}

export function rebaseOnto(worktree: string, target: string): { ok: boolean; detail: string } {
  const result = git(worktree, ["rebase", target], 180_000);
  if (result.status === 0) {
    return { ok: true, detail: result.stdout.trim() };
  }
  return { ok: false, detail: (result.stderr || result.stdout || "").trim() };
}

export function abortRebase(worktree: string): void {
  git(worktree, ["rebase", "--abort"]);
}

export function assertInside(root: string, target: string): string {
  const rootResolved = resolve(root);
  const rootReal = existsSync(rootResolved) ? realpathSync(rootResolved) : rootResolved;
  const candidate = isAbsolute(target) ? resolve(target) : resolve(rootReal, target);
  let candidateReal = candidate;
  if (existsSync(candidate)) {
    candidateReal = realpathSync(candidate);
  } else {
    const parent = existsSync(dirname(candidate)) ? realpathSync(dirname(candidate)) : dirname(candidate);
    candidateReal = join(parent, basename(candidate));
  }
  const rel = relative(rootReal, candidateReal);
  const lowerRel = process.platform === "win32" ? rel.toLowerCase() : rel;
  if (lowerRel === "" || (!lowerRel.startsWith("..") && !isAbsolute(rel))) {
    return candidateReal;
  }
  throw new Error(`路径越界：${target}`);
}

export function normalizeRelative(value: string): string {
  return value.split(/[\\/]+/).filter(Boolean).join(sep);
}
