import { NextResponse } from "next/server";
import type {
  CodeDevelopmentPatchFileChangeType,
  CodeDevelopmentPatchReviewStatus,
} from "@agent-space/domain";
import {
  markCodeDevelopmentSessionBlockedSync,
  markCodeDevelopmentSessionMergedSync,
  recordCodeDevelopmentMergePreflightSync,
  recordCodeDevelopmentPatchManifestSync,
  reviewCodeDevelopmentPatchSync,
} from "@agent-space/services";
import { getWorkspaceContextForIdentifier } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CodeDevelopmentSessionAction =
  | "record_patch_manifest"
  | "record_merge_preflight"
  | "review_patch"
  | "mark_merged"
  | "mark_blocked";

interface CodeDevelopmentSessionActionBody {
  action?: unknown;
  summary?: unknown;
  patchRef?: unknown;
  patchText?: unknown;
  baseRef?: unknown;
  headRef?: unknown;
  fileChanges?: unknown;
  riskNotes?: unknown;
  targetBranch?: unknown;
  checkedFiles?: unknown;
  conflictFiles?: unknown;
  warnings?: unknown;
  recommendation?: unknown;
  status?: unknown;
  comment?: unknown;
  notes?: unknown;
  reason?: unknown;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; sessionId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await resolveWorkspaceContext(context);
  if (workspaceContext instanceof NextResponse) {
    return workspaceContext;
  }

  try {
    assertWorkspaceRoleForContext(workspaceContext, "admin");
  } catch {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: CodeDevelopmentSessionActionBody;
  try {
    body = await request.json() as CodeDevelopmentSessionActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const action = readAction(body.action);
  if (!action) {
    return NextResponse.json({
      error:
        "Unsupported action. Expected one of: record_patch_manifest, record_merge_preflight, review_patch, mark_merged, mark_blocked.",
    }, { status: 400 });
  }

  const { sessionId } = await context.params;
  const workspaceId = workspaceContext.currentWorkspace.id;
  const humanActor = {
    type: "human" as const,
    id: workspaceContext.currentUser.id,
  };

  try {
    const session = (() => {
      switch (action) {
        case "record_patch_manifest":
          return recordCodeDevelopmentPatchManifestSync({
            sessionId,
            summary: readRequiredString(body.summary, "summary"),
            patchRef: readOptionalString(body.patchRef),
            patchText: readOptionalString(body.patchText),
            baseRef: readOptionalString(body.baseRef),
            headRef: readOptionalString(body.headRef),
            fileChanges: readPatchFileChanges(body.fileChanges),
            riskNotes: readStringArray(body.riskNotes),
            createdBy: humanActor,
          }, workspaceId);
        case "record_merge_preflight":
          return recordCodeDevelopmentMergePreflightSync({
            sessionId,
            targetBranch: readRequiredString(body.targetBranch, "targetBranch"),
            baseRef: readOptionalString(body.baseRef),
            headRef: readOptionalString(body.headRef),
            checkedFiles: readStringArray(body.checkedFiles),
            conflictFiles: readStringArray(body.conflictFiles),
            warnings: readStringArray(body.warnings),
            recommendation: readOptionalString(body.recommendation),
            checkedBy: humanActor,
          }, workspaceId);
        case "review_patch":
          return reviewCodeDevelopmentPatchSync({
            sessionId,
            status: readPatchReviewStatus(body.status),
            comment: readOptionalString(body.comment),
            reviewer: humanActor,
          }, workspaceId);
        case "mark_merged":
          return markCodeDevelopmentSessionMergedSync({
            sessionId,
            notes: readOptionalString(body.notes),
            mergedBy: humanActor,
          }, workspaceId);
        case "mark_blocked":
          return markCodeDevelopmentSessionBlockedSync({
            sessionId,
            reason: readRequiredString(body.reason, "reason"),
            blockedBy: humanActor,
          }, workspaceId);
      }
    })();

    return NextResponse.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function resolveWorkspaceContext(context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId: workspaceIdentifier } = await context.params;
  const workspaceContext = await getWorkspaceContextForIdentifier(workspaceIdentifier);
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (
    workspaceContext.currentWorkspace.id !== workspaceIdentifier
    && workspaceContext.currentWorkspace.slug !== workspaceIdentifier
  ) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  if (workspaceContext.accessScope === "channel") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return workspaceContext;
}

function readAction(input: unknown): CodeDevelopmentSessionAction | undefined {
  if (
    input === "record_patch_manifest"
    || input === "record_merge_preflight"
    || input === "review_patch"
    || input === "mark_merged"
    || input === "mark_blocked"
  ) {
    return input;
  }
  return undefined;
}

function readRequiredString(input: unknown, fieldName: string): string {
  const value = readOptionalString(input);
  if (!value) {
    throw new Error(`${fieldName} is required.`);
  }
  return value;
}

function readOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function readPatchFileChanges(input: unknown): Array<{
  path: string;
  changeType: CodeDevelopmentPatchFileChangeType;
  additions?: number;
  deletions?: number;
  previousPath?: string;
}> {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`fileChanges[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    return {
      path: readRequiredString(record.path, `fileChanges[${index}].path`),
      changeType: readPatchFileChangeType(record.changeType),
      additions: readOptionalNonNegativeNumber(record.additions, `fileChanges[${index}].additions`),
      deletions: readOptionalNonNegativeNumber(record.deletions, `fileChanges[${index}].deletions`),
      previousPath: readOptionalString(record.previousPath),
    };
  });
}

function readPatchFileChangeType(input: unknown): CodeDevelopmentPatchFileChangeType {
  if (input === "added" || input === "modified" || input === "deleted" || input === "renamed") {
    return input;
  }
  return "modified";
}

function readPatchReviewStatus(input: unknown): CodeDevelopmentPatchReviewStatus {
  if (input === "approved" || input === "rejected" || input === "needs_revision") {
    return input;
  }
  throw new Error("status must be one of: approved, rejected, needs_revision.");
}

function readOptionalNonNegativeNumber(input: unknown, fieldName: string): number | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
  return input;
}
