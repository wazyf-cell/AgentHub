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
export type CodeDevelopmentPatchFileChangeType = "added" | "modified" | "deleted" | "renamed";
export type CodeDevelopmentMergePreflightStatus = "clean" | "warning" | "blocked";

export interface CodeDevelopmentPatchReview {
  status: CodeDevelopmentPatchReviewStatus;
  reviewerType: CollaborationActorType;
  reviewerId: string;
  comment: string;
  reviewedAt: string;
}

export interface CodeDevelopmentPatchFileChange {
  path: string;
  changeType: CodeDevelopmentPatchFileChangeType;
  additions?: number;
  deletions?: number;
  previousPath?: string;
}

export interface CodeDevelopmentPatchRecord {
  manifestVersion?: 1;
  summary: string;
  patchRef?: string;
  patchSha256?: string;
  patchSizeBytes?: number;
  baseRef?: string;
  headRef?: string;
  changedFiles: string[];
  fileChanges?: CodeDevelopmentPatchFileChange[];
  riskNotes: string[];
  createdByType: CollaborationActorType;
  createdById: string;
  createdAt: string;
  review?: CodeDevelopmentPatchReview;
}

export interface CodeDevelopmentMergePreflight {
  status: CodeDevelopmentMergePreflightStatus;
  targetBranch: string;
  baseRef?: string;
  headRef?: string;
  checkedFiles: string[];
  conflictFiles: string[];
  warnings: string[];
  recommendation: string;
  checkedByType: CollaborationActorType;
  checkedById: string;
  checkedAt: string;
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
  mergePreflight?: CodeDevelopmentMergePreflight;
  mergeNotes?: string;
  blockedReason?: string;
}
