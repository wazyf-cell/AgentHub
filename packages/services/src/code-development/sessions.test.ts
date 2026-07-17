import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import { createWorkspaceSync, readWorkspaceSync } from "@agent-space/db";
import {
  allocateCodeDevelopmentSessionSync,
  createCodeDevelopmentSessionSync,
  listCodeDevelopmentSessionsSync,
  markCodeDevelopmentSessionMergedSync,
  recordCodeDevelopmentMergePreflightSync,
  recordCodeDevelopmentPatchManifestSync,
  recordCodeDevelopmentPatchSync,
  recordCodeDevelopmentWorktreeMergePreflightSync,
  recordCodeDevelopmentWorktreePatchManifestSync,
  resetWorkspaceStateSync,
  reviewCodeDevelopmentPatchSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-code-development-"));
const WORKSPACE_ID = "workspace-code-dev";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  rmSync(join(tempRoot, "data", "workspaces"), { recursive: true, force: true });
  ensureWorkspaceRecord(WORKSPACE_ID, "Code Dev Labs");
  resetWorkspaceStateSync(WORKSPACE_ID);
});

test("code development sessions require isolated worktrees and approved patch reviews before merge", () => {
  assert.throws(
    () =>
      createCodeDevelopmentSessionSync(
        {
          title: "Unsafe shared tree",
          goal: "Should not use repository root as worktree.",
          repositoryRoot: "F:/repo",
          worktreePath: "F:/repo",
          branchName: "feature/shared",
          assignedAgentIds: ["Atlas"],
          createdBy: { type: "human", id: "Mina" },
        },
        WORKSPACE_ID,
      ),
    /isolated worktree/,
  );

  const session = createCodeDevelopmentSessionSync(
    {
      title: "Implement parser hardening",
      goal: "Let Atlas work in an isolated branch and return a patch for review.",
      repositoryRoot: "F:/repo",
      worktreePath: "F:/repo/.worktrees/parser-hardening",
      branchName: "feature/parser-hardening",
      baseRef: "main",
      assignedAgentIds: ["Atlas", "Nova", "Atlas"],
      createdBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );

  assert.deepEqual(session.assignedAgentIds, ["Atlas", "Nova"]);
  assert.equal(session.status, "planned");
  assert.throws(
    () =>
      markCodeDevelopmentSessionMergedSync(
        {
          sessionId: session.id,
          mergedBy: { type: "human", id: "Mina" },
        },
        WORKSPACE_ID,
      ),
    /approved patch review/,
  );

  const patchReady = recordCodeDevelopmentPatchSync(
    {
      sessionId: session.id,
      summary: "Parser validation now rejects unsafe paths.",
      patchRef: "patches/parser-hardening.diff",
      changedFiles: ["packages/parser/src/index.ts", "../ignored.ts", "packages/parser/src/index.ts"],
      riskNotes: ["Needs focused parser tests."],
      createdBy: { type: "agent", id: "Atlas" },
    },
    WORKSPACE_ID,
  );
  assert.equal(patchReady.status, "patch_ready");
  assert.deepEqual(patchReady.patch?.changedFiles, ["packages/parser/src/index.ts", "ignored.ts"]);

  const reviewed = reviewCodeDevelopmentPatchSync(
    {
      sessionId: session.id,
      status: "approved",
      reviewer: { type: "human", id: "Mina" },
      comment: "Patch is safe to merge manually.",
    },
    WORKSPACE_ID,
  );
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.patch?.review?.status, "approved");

  assert.throws(
    () =>
      markCodeDevelopmentSessionMergedSync(
        {
          sessionId: session.id,
          mergedBy: { type: "human", id: "Mina" },
        },
        WORKSPACE_ID,
      ),
    /clean merge preflight/,
  );

  const preflight = recordCodeDevelopmentMergePreflightSync(
    {
      sessionId: session.id,
      targetBranch: "main",
      checkedBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );
  assert.equal(preflight.mergePreflight?.status, "clean");
  assert.deepEqual(preflight.mergePreflight?.checkedFiles, ["packages/parser/src/index.ts", "ignored.ts"]);

  const merged = markCodeDevelopmentSessionMergedSync(
    {
      sessionId: session.id,
      mergedBy: { type: "human", id: "Mina" },
      notes: "Merged after manual review.",
    },
    WORKSPACE_ID,
  );
  assert.equal(merged.status, "merged");
  assert.equal(merged.mergeNotes, "Merged after manual review.");

  const listed = listCodeDevelopmentSessionsSync(WORKSPACE_ID);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, session.id);
});

test("code development allocation creates isolated worktree metadata and patch manifests", () => {
  const session = allocateCodeDevelopmentSessionSync(
    {
      title: "Router safety pass",
      goal: "Allocate an isolated worktree for router hardening.",
      repositoryRoot: "F:/repo",
      baseRef: "main",
      assignedAgentIds: ["Atlas"],
      createdBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );

  assert.equal(session.repositoryRoot, "F:/repo");
  assert.equal(session.worktreePath.startsWith("F:/repo/.worktrees/router-safety-pass-"), true);
  assert.equal(session.branchName.startsWith("agent-space/router-safety-pass-"), true);
  assert.notEqual(session.worktreePath, session.repositoryRoot);

  assert.throws(
    () =>
      allocateCodeDevelopmentSessionSync(
        {
          title: "Escaped worktree root",
          goal: "Should not allocate outside the repository.",
          repositoryRoot: "F:/repo",
          worktreeRoot: "F:/repo/..",
          assignedAgentIds: ["Atlas"],
          createdBy: { type: "human", id: "Mina" },
        },
        WORKSPACE_ID,
      ),
    /must stay inside/,
  );

  const allocatedDir = session.worktreePath.split("/").at(-1)!;
  assert.throws(
    () =>
      createCodeDevelopmentSessionSync(
        {
          title: "Duplicate escaped worktree",
          goal: "Should not bypass active worktree detection with traversal.",
          repositoryRoot: "F:/repo",
          worktreePath: `F:/repo/.worktrees/nested/../${allocatedDir}`,
          branchName: "feature/duplicate-escaped",
          assignedAgentIds: ["Nova"],
          createdBy: { type: "human", id: "Mina" },
        },
        WORKSPACE_ID,
      ),
    /already uses worktree/,
  );

  assert.throws(
    () =>
      recordCodeDevelopmentPatchManifestSync(
        {
          sessionId: session.id,
          summary: "Unsafe manifest.",
          fileChanges: [{ path: "../outside.ts" }],
          createdBy: { type: "agent", id: "Atlas" },
        },
        WORKSPACE_ID,
      ),
    /must not traverse/,
  );

  for (const invalidPath of ["", "/absolute.ts", "C:/absolute.ts", "C:relative.ts"]) {
    assert.throws(
      () =>
        recordCodeDevelopmentPatchManifestSync(
          {
            sessionId: session.id,
            summary: "Unsafe manifest.",
            fileChanges: [{ path: invalidPath }],
            createdBy: { type: "agent", id: "Atlas" },
          },
          WORKSPACE_ID,
        ),
      /repository-relative/,
    );
  }

  assert.throws(
    () =>
      recordCodeDevelopmentPatchManifestSync(
        {
          sessionId: session.id,
          summary: "Unsafe rename manifest.",
          fileChanges: [{ path: "packages/daemon/src/router.ts", changeType: "renamed", previousPath: "../old-router.ts" }],
          createdBy: { type: "agent", id: "Atlas" },
        },
        WORKSPACE_ID,
      ),
    /must not traverse/,
  );

  const patchText = "diff --git a/packages/daemon/src/router.ts b/packages/daemon/src/router.ts\n";
  const expectedHash = createHash("sha256").update(patchText).digest("hex");
  const patched = recordCodeDevelopmentPatchManifestSync(
    {
      sessionId: session.id,
      summary: "Router fencing manifest.",
      patchText,
      patchRef: "patches/router-safety.diff",
      headRef: "feature/router-safety",
      fileChanges: [
        { path: "packages/daemon/src/router.ts", changeType: "modified", additions: 12, deletions: 3 },
        { path: "packages/daemon/src/router.ts", changeType: "modified", additions: 1 },
      ],
      riskNotes: ["Requires daemon route regression."],
      createdBy: { type: "agent", id: "Atlas" },
    },
    WORKSPACE_ID,
  );

  assert.equal(patched.status, "patch_ready");
  assert.equal(patched.patch?.manifestVersion, 1);
  assert.equal(patched.patch?.patchText, patchText);
  assert.equal(patched.patch?.patchSha256, expectedHash);
  assert.equal(patched.patch?.patchSizeBytes, Buffer.byteLength(patchText, "utf8"));
  assert.equal(patched.patch?.baseRef, "main");
  assert.equal(patched.patch?.headRef, "feature/router-safety");
  assert.deepEqual(patched.patch?.changedFiles, ["packages/daemon/src/router.ts"]);
  assert.deepEqual(patched.patch?.fileChanges, [
    {
      path: "packages/daemon/src/router.ts",
      changeType: "modified",
      additions: 12,
      deletions: 3,
      previousPath: undefined,
    },
  ]);
});

test("code development merge preflight blocks overlapping active patch files", () => {
  const first = allocateCodeDevelopmentSessionSync(
    {
      title: "Router safety pass",
      goal: "Prepare router hardening in one isolated session.",
      repositoryRoot: "F:/repo",
      baseRef: "main",
      assignedAgentIds: ["Atlas"],
      createdBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );
  recordCodeDevelopmentPatchManifestSync(
    {
      sessionId: first.id,
      summary: "Router manifest.",
      fileChanges: [{ path: "packages/daemon/src/router.ts", additions: 4 }],
      createdBy: { type: "agent", id: "Atlas" },
    },
    WORKSPACE_ID,
  );

  const second = allocateCodeDevelopmentSessionSync(
    {
      title: "Router metrics pass",
      goal: "Prepare another router patch in another isolated session.",
      repositoryRoot: "F:/repo",
      baseRef: "main",
      assignedAgentIds: ["Nova"],
      createdBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );
  recordCodeDevelopmentPatchManifestSync(
    {
      sessionId: second.id,
      summary: "Router metrics manifest.",
      headRef: "agent-space/router-metrics",
      fileChanges: [{ path: "packages/daemon/src/router.ts", additions: 2 }],
      createdBy: { type: "agent", id: "Nova" },
    },
    WORKSPACE_ID,
  );

  const blocked = recordCodeDevelopmentMergePreflightSync(
    {
      sessionId: second.id,
      targetBranch: "main",
      checkedBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );

  assert.equal(blocked.mergePreflight?.status, "blocked");
  assert.deepEqual(blocked.mergePreflight?.conflictFiles, ["packages/daemon/src/router.ts"]);
  assert.deepEqual(blocked.mergePreflight?.checkedFiles, ["packages/daemon/src/router.ts"]);
  assert.equal(blocked.mergePreflight?.headRef, "agent-space/router-metrics");
  assert.match(blocked.mergePreflight?.recommendation ?? "", /Resolve conflicts/);
  assert.throws(
    () =>
      markCodeDevelopmentSessionMergedSync(
        {
          sessionId: second.id,
          mergedBy: { type: "human", id: "Mina" },
        },
        WORKSPACE_ID,
      ),
    /approved patch review/,
  );
});

test("code development can auto-record git worktree patch manifests and preflight target overlap", () => {
  const repositoryRoot = mkdtempSync(join(tempRoot, "repo-"));
  git(repositoryRoot, ["init", "-b", "main"]);
  git(repositoryRoot, ["config", "user.email", "test@example.com"]);
  git(repositoryRoot, ["config", "user.name", "Agent Space Test"]);
  mkdirSync(join(repositoryRoot, "src"), { recursive: true });
  writeFileSync(join(repositoryRoot, "src", "router.ts"), "export const value = 1;\n");
  git(repositoryRoot, ["add", "."]);
  git(repositoryRoot, ["commit", "-m", "initial"]);
  git(repositoryRoot, ["checkout", "-b", "target-main"]);
  writeFileSync(join(repositoryRoot, "src", "router.ts"), "export const value = 2;\n");
  git(repositoryRoot, ["commit", "-am", "target change"]);
  git(repositoryRoot, ["checkout", "main"]);

  const worktreePath = join(repositoryRoot, ".worktrees", "router-session");
  mkdirSync(join(repositoryRoot, ".worktrees"), { recursive: true });
  git(repositoryRoot, ["worktree", "add", worktreePath, "-b", "agent-space/router-session", "main"]);
  git(worktreePath, ["config", "user.email", "test@example.com"]);
  git(worktreePath, ["config", "user.name", "Agent Space Test"]);
  writeFileSync(join(worktreePath, "src", "router.ts"), "export const value = 3;\n");
  writeFileSync(join(worktreePath, "src", "new-file.ts"), "export const created = true;\n");

  const session = createCodeDevelopmentSessionSync(
    {
      title: "Router worktree session",
      goal: "Read real git diff from the isolated worktree.",
      repositoryRoot,
      worktreePath,
      branchName: "agent-space/router-session",
      baseRef: "main",
      assignedAgentIds: ["Atlas"],
      createdBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );

  const patched = recordCodeDevelopmentWorktreePatchManifestSync(
    {
      sessionId: session.id,
      createdBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );

  assert.equal(patched.status, "patch_ready");
  assert.equal(patched.patch?.baseRef, "main");
  assert.equal(patched.patch?.headRef, "agent-space/router-session");
  assert.match(patched.patch?.patchText ?? "", /src\/new-file\.ts/);
  assert.match(patched.patch?.patchText ?? "", /export const created = true/);
  assert.deepEqual([...(patched.patch?.changedFiles ?? [])].sort(), ["src/new-file.ts", "src/router.ts"]);
  assert.deepEqual(
    Object.fromEntries((patched.patch?.fileChanges ?? []).map((change) => [change.path, change.changeType])),
    {
      "src/new-file.ts": "added",
      "src/router.ts": "modified",
    },
  );
  assert.equal(patched.patch?.patchSha256?.length, 64);
  assert.equal((patched.patch?.patchSizeBytes ?? 0) > 0, true);

  const preflighted = recordCodeDevelopmentWorktreeMergePreflightSync(
    {
      sessionId: session.id,
      targetBranch: "target-main",
      checkedBy: { type: "human", id: "Mina" },
    },
    WORKSPACE_ID,
  );

  assert.equal(preflighted.mergePreflight?.status, "blocked");
  assert.deepEqual(preflighted.mergePreflight?.conflictFiles, ["src/router.ts"]);
  assert.match(preflighted.mergePreflight?.warnings.join(" ") ?? "", /Target branch changed files/);
});

function ensureWorkspaceRecord(workspaceId: string, name: string): void {
  if (readWorkspaceSync(workspaceId)) {
    return;
  }

  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name,
    createdBy: "test",
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
