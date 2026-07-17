const {
  mockGetWorkspaceContextForIdentifier,
  mockMarkCodeDevelopmentSessionBlockedSync,
  mockMarkCodeDevelopmentSessionMergedSync,
  mockRecordCodeDevelopmentMergePreflightSync,
  mockRecordCodeDevelopmentPatchManifestSync,
  mockRecordCodeDevelopmentWorktreeMergePreflightSync,
  mockRecordCodeDevelopmentWorktreePatchManifestSync,
  mockReviewCodeDevelopmentPatchSync,
} = vi.hoisted(() => ({
  mockGetWorkspaceContextForIdentifier: vi.fn(),
  mockMarkCodeDevelopmentSessionBlockedSync: vi.fn(),
  mockMarkCodeDevelopmentSessionMergedSync: vi.fn(),
  mockRecordCodeDevelopmentMergePreflightSync: vi.fn(),
  mockRecordCodeDevelopmentPatchManifestSync: vi.fn(),
  mockRecordCodeDevelopmentWorktreeMergePreflightSync: vi.fn(),
  mockRecordCodeDevelopmentWorktreePatchManifestSync: vi.fn(),
  mockReviewCodeDevelopmentPatchSync: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceContextForIdentifier: mockGetWorkspaceContextForIdentifier,
}));

vi.mock("@agent-space/services", () => ({
  markCodeDevelopmentSessionBlockedSync: mockMarkCodeDevelopmentSessionBlockedSync,
  markCodeDevelopmentSessionMergedSync: mockMarkCodeDevelopmentSessionMergedSync,
  recordCodeDevelopmentMergePreflightSync: mockRecordCodeDevelopmentMergePreflightSync,
  recordCodeDevelopmentPatchManifestSync: mockRecordCodeDevelopmentPatchManifestSync,
  recordCodeDevelopmentWorktreeMergePreflightSync: mockRecordCodeDevelopmentWorktreeMergePreflightSync,
  recordCodeDevelopmentWorktreePatchManifestSync: mockRecordCodeDevelopmentWorktreePatchManifestSync,
  reviewCodeDevelopmentPatchSync: mockReviewCodeDevelopmentPatchSync,
}));

import { POST } from "./route";

describe("workspace code development session actions route", () => {
  beforeEach(() => {
    mockGetWorkspaceContextForIdentifier.mockReset();
    mockMarkCodeDevelopmentSessionBlockedSync.mockReset();
    mockMarkCodeDevelopmentSessionMergedSync.mockReset();
    mockRecordCodeDevelopmentMergePreflightSync.mockReset();
    mockRecordCodeDevelopmentPatchManifestSync.mockReset();
    mockRecordCodeDevelopmentWorktreeMergePreflightSync.mockReset();
    mockRecordCodeDevelopmentWorktreePatchManifestSync.mockReset();
    mockReviewCodeDevelopmentPatchSync.mockReset();
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext());
  });

  it("records a manual patch manifest with normalized request fields", async () => {
    mockRecordCodeDevelopmentPatchManifestSync.mockReturnValue(buildSession({ status: "patch_ready" }));

    const response = await postAction({
      action: "record_patch_manifest",
      summary: " Parser hardening patch ",
      patchRef: " patches/parser.diff ",
      patchText: "diff --git a/src/parser.ts b/src/parser.ts",
      baseRef: " main ",
      headRef: " feature/parser ",
      fileChanges: [
        {
          path: " src/parser.ts ",
          changeType: "added",
          additions: 12,
          deletions: 0,
          previousPath: "",
        },
      ],
      riskNotes: [" needs parser tests ", "", 42],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.session).toMatchObject({ id: "session-1", status: "patch_ready" });
    expect(mockRecordCodeDevelopmentPatchManifestSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      summary: "Parser hardening patch",
      patchRef: "patches/parser.diff",
      patchText: "diff --git a/src/parser.ts b/src/parser.ts",
      baseRef: "main",
      headRef: "feature/parser",
      fileChanges: [
        {
          path: "src/parser.ts",
          changeType: "added",
          additions: 12,
          deletions: 0,
          previousPath: undefined,
        },
      ],
      riskNotes: ["needs parser tests"],
      createdBy: { type: "human", id: "user-1" },
    }, "workspace-1");
  });

  it("records worktree patch and worktree preflight actions", async () => {
    mockRecordCodeDevelopmentWorktreePatchManifestSync.mockReturnValue(buildSession({ status: "patch_ready" }));
    mockRecordCodeDevelopmentWorktreeMergePreflightSync.mockReturnValue(buildSession({ status: "patch_ready" }));

    const patchResponse = await postAction({
      action: "record_worktree_patch_manifest",
      summary: " Auto patch ",
      baseRef: " main ",
      headRef: " feature/parser ",
      riskNotes: [" large untracked file "],
    });
    const preflightResponse = await postAction({
      action: "record_worktree_merge_preflight",
      targetBranch: " release ",
      baseRef: " main ",
      headRef: " feature/parser ",
    });

    expect(patchResponse.status).toBe(200);
    expect(preflightResponse.status).toBe(200);
    expect(mockRecordCodeDevelopmentWorktreePatchManifestSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      summary: "Auto patch",
      baseRef: "main",
      headRef: "feature/parser",
      riskNotes: ["large untracked file"],
      createdBy: { type: "human", id: "user-1" },
    }, "workspace-1");
    expect(mockRecordCodeDevelopmentWorktreeMergePreflightSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      targetBranch: "release",
      baseRef: "main",
      headRef: "feature/parser",
      checkedBy: { type: "human", id: "user-1" },
    }, "workspace-1");
  });

  it("records manual preflight and review decisions", async () => {
    mockRecordCodeDevelopmentMergePreflightSync.mockReturnValue(buildSession({ status: "patch_ready" }));
    mockReviewCodeDevelopmentPatchSync.mockReturnValue(buildSession({ status: "reviewed" }));

    const preflightResponse = await postAction({
      action: "record_merge_preflight",
      targetBranch: " main ",
      baseRef: " main ",
      headRef: " feature/parser ",
      checkedFiles: [" src/parser.ts ", "", 123],
      conflictFiles: [" src/conflict.ts "],
      warnings: [" whitespace warning "],
      recommendation: " Review conflict ",
    });
    const reviewResponse = await postAction({
      action: "review_patch",
      status: "approved",
      comment: " safe to merge ",
    });

    expect(preflightResponse.status).toBe(200);
    expect(reviewResponse.status).toBe(200);
    expect(mockRecordCodeDevelopmentMergePreflightSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      targetBranch: "main",
      baseRef: "main",
      headRef: "feature/parser",
      checkedFiles: ["src/parser.ts"],
      conflictFiles: ["src/conflict.ts"],
      warnings: ["whitespace warning"],
      recommendation: "Review conflict",
      checkedBy: { type: "human", id: "user-1" },
    }, "workspace-1");
    expect(mockReviewCodeDevelopmentPatchSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "approved",
      comment: "safe to merge",
      reviewer: { type: "human", id: "user-1" },
    }, "workspace-1");
  });

  it("marks sessions merged or blocked through explicit actions", async () => {
    mockMarkCodeDevelopmentSessionMergedSync.mockReturnValue(buildSession({ status: "merged" }));
    mockMarkCodeDevelopmentSessionBlockedSync.mockReturnValue(buildSession({ status: "blocked" }));

    const mergedResponse = await postAction({
      action: "mark_merged",
      notes: " merged manually ",
    });
    const blockedResponse = await postAction({
      action: "mark_blocked",
      reason: " conflicting migration ",
    });

    expect(mergedResponse.status).toBe(200);
    expect(blockedResponse.status).toBe(200);
    expect(mockMarkCodeDevelopmentSessionMergedSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      notes: "merged manually",
      mergedBy: { type: "human", id: "user-1" },
    }, "workspace-1");
    expect(mockMarkCodeDevelopmentSessionBlockedSync).toHaveBeenCalledWith({
      sessionId: "session-1",
      reason: "conflicting migration",
      blockedBy: { type: "human", id: "user-1" },
    }, "workspace-1");
  });

  it("rejects unsupported actions and non-admin workspace members", async () => {
    const unsupportedResponse = await postAction({ action: "delete_everything" });
    expect(unsupportedResponse.status).toBe(400);
    await expect(unsupportedResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unsupported action"),
    });

    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext({ role: "member" }));
    const memberResponse = await postAction({ action: "mark_blocked", reason: "not allowed" });
    expect(memberResponse.status).toBe(403);
    await expect(memberResponse.json()).resolves.toMatchObject({ error: "Forbidden." });
    expect(mockMarkCodeDevelopmentSessionBlockedSync).not.toHaveBeenCalled();
  });

  it("rejects malformed file changes and invalid review statuses", async () => {
    const badFileResponse = await postAction({
      action: "record_patch_manifest",
      summary: "Bad manifest",
      fileChanges: [{ path: "src/a.ts", additions: -1 }],
    });
    expect(badFileResponse.status).toBe(400);
    await expect(badFileResponse.json()).resolves.toMatchObject({
      error: "fileChanges[0].additions must be a non-negative number.",
    });

    const badReviewResponse = await postAction({
      action: "review_patch",
      status: "maybe",
    });
    expect(badReviewResponse.status).toBe(400);
    await expect(badReviewResponse.json()).resolves.toMatchObject({
      error: "status must be one of: approved, rejected, needs_revision.",
    });
  });
});

function postAction(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/workspaces/workspace-alpha/code-development-sessions/session-1/actions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ workspaceId: "workspace-alpha", sessionId: "session-1" }) },
  );
}

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status: "running",
    title: "Parser hardening",
    ...overrides,
  };
}

function buildWorkspaceContext(options: { accessScope?: "workspace" | "channel"; role?: "owner" | "admin" | "member" } = {}) {
  return {
    accessScope: options.accessScope ?? "workspace",
    currentUser: {
      id: "user-1",
      organizationName: "Northstar Labs",
      displayName: "Tianyu",
      role: "owner",
      email: "tianyu@example.com",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-alpha",
      name: "Northstar Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: options.role ?? "owner",
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
  };
}
