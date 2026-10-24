import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  branchExists,
  changedPaths,
  commitAll,
  createTaskWorktree,
  currentBranch,
  discardWorktree,
  isClean,
  listWorktrees,
  mergeFastForward,
  requireGitRoot,
} from "./worktrees.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "agenthub-worktrees-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return { root, repo };
}

test("worktrees are created from a clean repo and roll back when dirty", () => {
  const { root, repo } = setupRepo();
  try {
    assert.equal(requireGitRoot(repo), repo);
    mkdirSync(join(repo, "sub"));
    assert.throws(() => requireGitRoot(join(repo, "sub")), /根目录/);

    const info = createTaskWorktree({ repo, taskId: "task-a" });
    assert.equal(info.created, true);
    assert.equal(info.branch, "agenthub/task-a");
    assert.ok(listWorktrees(repo).some((entry) => entry.path === info.path));

    writeFileSync(join(info.path, "b.txt"), "two\n");
    assert.deepEqual(changedPaths(info.path), ["b.txt"]);
    const commit = commitAll(info.path, "add b");
    assert.ok(commit);
    assert.equal(changedPaths(info.path).length, 0);

    writeFileSync(join(repo, "a.txt"), "dirty\n");
    assert.throws(() => createTaskWorktree({ repo, taskId: "task-b" }), /不干净/);
    writeFileSync(join(repo, "a.txt"), "one\n");
    assert.equal(isClean(repo), true);

    const merged = mergeFastForward(repo, info.branch);
    assert.equal(merged.status, "merged");
    assert.equal(readFileSync(join(repo, "b.txt"), "utf8").replace(/\r\n/g, "\n"), "two\n");
    assert.ok(currentBranch(repo).length > 0);

    discardWorktree(repo, info.path, { force: true });
    assert.equal(existsSync(info.path), false);
    assert.equal(branchExists(repo, info.branch), true, "branches are never auto-deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
