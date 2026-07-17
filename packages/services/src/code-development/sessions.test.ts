import assert from "node:assert/strict";
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
  recordCodeDevelopmentPatchManifestSync,
  recordCodeDevelopmentPatchSync,
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
