import type { CollaborationActorType } from "./collaboration.ts";

export type CodeDevelopmentSessionStatus =
  | "planned"
  | "running"
  | "patch_ready"
  | "reviewed"
  | "merged"
  | "blocked"
  | "cancelled";

export type CodeDevelopmentPatchReviewStatus = "approved" | "rejected" | "needs_revision";

export interface CodeDevelopmentPatchReview {
  status: CodeDevelopmentPatchReviewStatus;
  reviewerType: CollaborationActorType;
  reviewerId: string;
  comment: string;
  reviewedAt: string;
}

export interface CodeDevelopmentPatchRecord {
  summary: string;
  patchRef?: string;
  changedFiles: string[];
  riskNotes: string[];
  createdByType: CollaborationActorType;
  createdById: string;
  createdAt: string;
  review?: CodeDevelopmentPatchReview;
}

export interface CodeDevelopmentSession {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  repositoryRoot: string;
  worktreePath: string;
  branchName: string;
  baseRef?: string;
  assignedAgentIds: string[];
  status: CodeDevelopmentSessionStatus;
  createdByType: CollaborationActorType;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  patch?: CodeDevelopmentPatchRecord;
  mergeNotes?: string;
  blockedReason?: string;
}
