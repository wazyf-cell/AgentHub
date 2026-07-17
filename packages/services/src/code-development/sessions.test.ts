import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import { createWorkspaceSync, readWorkspaceSync } from "@agent-space/db";
import {
  createCodeDevelopmentSessionSync,
  listCodeDevelopmentSessionsSync,
  markCodeDevelopmentSessionMergedSync,
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
