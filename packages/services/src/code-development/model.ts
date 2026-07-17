import type { CodeDevelopmentPatchRecord, CodeDevelopmentSession } from "@agent-space/domain";
import type { AgentSpaceState } from "@agent-space/domain/workspace";

const SESSION_STATUSES = new Set(["planned", "running", "patch_ready", "reviewed", "merged", "blocked", "cancelled"]);
const PATCH_REVIEW_STATUSES = new Set(["approved", "rejected", "needs_revision"]);
const ACTOR_TYPES = new Set(["human", "agent", "system"]);

export function normalizeCodeDevelopmentSessions(
  sessions: AgentSpaceState["codeDevelopmentSessions"] | undefined,
  fallback: AgentSpaceState["codeDevelopmentSessions"],
): AgentSpaceState["codeDevelopmentSessions"] {
  if (!Array.isArray(sessions)) {
    return fallback;
  }

  return sessions
    .map((session) => normalizeCodeDevelopmentSession(session))
    .filter((session): session is CodeDevelopmentSession => session !== null)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function normalizeCodeDevelopmentSession(session: unknown): CodeDevelopmentSession | null {
  if (!session || typeof session !== "object") {
    return null;
  }

  const candidate = session as Partial<CodeDevelopmentSession>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.goal !== "string" ||
    typeof candidate.repositoryRoot !== "string" ||
    typeof candidate.worktreePath !== "string" ||
    typeof candidate.branchName !== "string" ||
    !isActorType(candidate.createdByType) ||
    typeof candidate.createdById !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    title: candidate.title,
    goal: candidate.goal,
    repositoryRoot: candidate.repositoryRoot,
    worktreePath: candidate.worktreePath,
    branchName: candidate.branchName,
    baseRef: typeof candidate.baseRef === "string" ? candidate.baseRef : undefined,
    assignedAgentIds: readStringArray(candidate.assignedAgentIds),
    status: SESSION_STATUSES.has(candidate.status ?? "") ? candidate.status! : "planned",
    createdByType: candidate.createdByType,
    createdById: candidate.createdById,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    patch: normalizeCodeDevelopmentPatch(candidate.patch),
    mergeNotes: typeof candidate.mergeNotes === "string" ? candidate.mergeNotes : undefined,
    blockedReason: typeof candidate.blockedReason === "string" ? candidate.blockedReason : undefined,
  };
}

function normalizeCodeDevelopmentPatch(patch: unknown): CodeDevelopmentPatchRecord | undefined {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return undefined;
  }

  const candidate = patch as Partial<CodeDevelopmentPatchRecord>;
  if (
    typeof candidate.summary !== "string" ||
    !isActorType(candidate.createdByType) ||
    typeof candidate.createdById !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return undefined;
  }

  return {
    summary: candidate.summary,
    patchRef: typeof candidate.patchRef === "string" ? candidate.patchRef : undefined,
    changedFiles: readStringArray(candidate.changedFiles),
    riskNotes: readStringArray(candidate.riskNotes),
    createdByType: candidate.createdByType,
    createdById: candidate.createdById,
    createdAt: candidate.createdAt,
    review: normalizePatchReview(candidate.review),
  };
}

function normalizePatchReview(review: unknown): CodeDevelopmentPatchRecord["review"] | undefined {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return undefined;
  }

  const candidate = review as NonNullable<CodeDevelopmentPatchRecord["review"]>;
  if (
    !PATCH_REVIEW_STATUSES.has(candidate.status) ||
    !isActorType(candidate.reviewerType) ||
    typeof candidate.reviewerId !== "string" ||
    typeof candidate.comment !== "string" ||
    typeof candidate.reviewedAt !== "string"
  ) {
    return undefined;
  }

  return {
    status: candidate.status,
    reviewerType: candidate.reviewerType,
    reviewerId: candidate.reviewerId,
    comment: candidate.comment,
    reviewedAt: candidate.reviewedAt,
  };
}

function isActorType(value: unknown): value is CodeDevelopmentSession["createdByType"] {
  return typeof value === "string" && ACTOR_TYPES.has(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
