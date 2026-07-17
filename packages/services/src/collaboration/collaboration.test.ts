import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import { createWorkspaceSync, readWorkspaceSync } from "@agent-space/db";
import {
  acceptCollaborationChangeProposalSync,
  addCollaborationCommentSync,
  createChannelDocumentSync,
  createCollaborationChangeProposalSync,
  createCollaborationCommentThreadSync,
  createEmployeeSync,
  createPanelDiscussionSync,
  createTaskSync,
  initializeOrganizationSync,
  listCollaborationActivitiesSync,
  listCollaborationChangeProposalsSync,
  listCollaborationCommentThreadsSync,
  listPanelDiscussionsSync,
  readWorkspaceStateSync,
  recordPanelDecisionSync,
  recordPanelOpinionSync,
  rejectCollaborationChangeProposalSync,
  resetWorkspaceStateSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-collaboration-"));
const WORKSPACE_ID = "workspace-collab";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  rmSync(join(tempRoot, "data", "workspaces"), { recursive: true, force: true });
  seedWorkspace(undefined, "Default Labs", "default-ops");
  seedWorkspace(WORKSPACE_ID, "Collab Labs", "collab-ops");
});

test("comment threads are scoped by workspace and collaborative object", () => {
  const document = createChannelDocumentSync(
    {
      channelName: "collab-ops",
      title: "Launch memo",
      contentMarkdown: "# Launch\n",
      createdBy: "Mina",
      createdByType: "human",
    },
    WORKSPACE_ID,
  ).document;
  const task = createTaskSync(
    {
      title: "Review launch memo",
      channel: "collab-ops",
      assignee: "Atlas",
      priority: "high",
    },
    WORKSPACE_ID,
  ).tasks[0];
  assert.ok(task);

  const thread = createCollaborationCommentThreadSync(
    {
      objectType: "channel_document",
      objectId: document.id,
      anchor: { blockId: "intro" },
      createdBy: { type: "human", id: "Mina" },
      body: "Can Atlas tighten the opening?",
    },
    WORKSPACE_ID,
  );
  addCollaborationCommentSync(
    {
      threadId: thread.id,
      author: { type: "agent", id: "Atlas" },
      body: "I will prepare a suggested revision.",
    },
    WORKSPACE_ID,
  );
  createCollaborationCommentThreadSync(
    {
      objectType: "task",
      objectId: task.id,
      createdBy: { type: "human", id: "Mina" },
      body: "Track reviewer signoff here.",
    },
    WORKSPACE_ID,
  );

  assert.equal(readWorkspaceStateSync().collaborationCommentThreads.length, 0);
  assert.equal(readWorkspaceStateSync(WORKSPACE_ID).collaborationCommentThreads.length, 2);
  assert.equal(readWorkspaceStateSync(WORKSPACE_ID).collaborationComments.length, 3);

  const documentThreads = listCollaborationCommentThreadsSync(
    { objectType: "channel_document", objectId: document.id },
    WORKSPACE_ID,
  );
  assert.equal(documentThreads.length, 1);
  assert.equal(documentThreads[0]?.id, thread.id);
  assert.equal(documentThreads[0]?.comments.length, 2);
  assert.deepEqual(documentThreads[0]?.anchor, { blockId: "intro" });
});

test("panel discussions capture opinions and a final decision", () => {
  const task = createTaskSync(
    {
      title: "Choose implementation path",
      channel: "collab-ops",
      assignee: "Atlas",
      priority: "medium",
    },
    WORKSPACE_ID,
  ).tasks[0];
  assert.ok(task);

  const discussion = createPanelDiscussionSync(
    {
      objectType: "task",
      objectId: task.id,
      goal: "Decide whether to reuse comments or add a new panel table.",
      participantAgentIds: ["Atlas", "Nova", "Atlas"],
      createdBy: { type: "human", id: "Mina" },
      initialOpinion: "Keep the first version lightweight.",
    },
    WORKSPACE_ID,
  );
  recordPanelOpinionSync(
    {
      discussionId: discussion.id,
      author: { type: "agent", id: "Atlas" },
      stance: "support",
      body: "Reuse comment threads for the minimal protocol.",
    },
    WORKSPACE_ID,
  );
  recordPanelOpinionSync(
    {
      discussionId: discussion.id,
      author: { type: "agent", id: "Nova" },
      stance: "concern",
      body: "Document the metadata-in-comment-body debt.",
    },
    WORKSPACE_ID,
  );
  const decided = recordPanelDecisionSync(
    {
      discussionId: discussion.id,
      decidedBy: { type: "human", id: "Mina" },
      body: "Ship the lightweight panel protocol and track metadata debt.",
    },
    WORKSPACE_ID,
  );

  assert.equal(readWorkspaceStateSync().collaborationCommentThreads.length, 0);
  assert.equal(decided.status, "decided");
  assert.deepEqual(decided.participantAgentIds, ["Atlas", "Nova"]);
  assert.equal(decided.opinions.length, 3);
  assert.equal(decided.opinions[1]?.stance, "support");
  assert.equal(decided.decision?.body, "Ship the lightweight panel protocol and track metadata debt.");

  const listed = listPanelDiscussionsSync(WORKSPACE_ID);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, discussion.id);
  assert.equal(listed[0]?.status, "decided");

  const activities = listCollaborationActivitiesSync({ objectType: "task", objectId: task.id }, WORKSPACE_ID);
  assert.equal(activities.some((activity) => activity.verb === "panel.created"), true);
  assert.equal(activities.some((activity) => activity.verb === "panel.opinion_recorded"), true);
  assert.equal(activities.some((activity) => activity.verb === "panel.decision_recorded"), true);
  assert.throws(
    () =>
      recordPanelOpinionSync(
        {
          discussionId: discussion.id,
          author: { type: "agent", id: "Atlas" },
          stance: "neutral",
          body: "Late addition.",
        },
        WORKSPACE_ID,
      ),
    /already been decided/,
  );
});

test("change proposals can be accepted or rejected exactly once", () => {
  const document = createChannelDocumentSync(
    {
      channelName: "collab-ops",
      title: "Agent draft",
      contentMarkdown: "# Draft\n",
      createdBy: "Mina",
      createdByType: "human",
      triggerType: "agent",
    },
    WORKSPACE_ID,
  ).document;

  const accepted = createCollaborationChangeProposalSync(
    {
      objectType: "channel_document",
      objectId: document.id,
      proposedBy: { type: "agent", id: "Atlas" },
      title: "Tighten intro",
      summary: "Replace the opening with a shorter version.",
      patch: { format: "markdown", replacement: "# Draft\n\nShorter intro." },
    },
    WORKSPACE_ID,
  );
  const rejected = createCollaborationChangeProposalSync(
    {
      objectType: "channel_document",
      objectId: document.id,
      proposedBy: { type: "agent", id: "Atlas" },
      title: "Add appendix",
      summary: "Append source material.",
      patch: { format: "markdown", append: "\n\n## Appendix" },
    },
    WORKSPACE_ID,
  );

  const acceptedResult = acceptCollaborationChangeProposalSync(
    { proposalId: accepted.id, decidedByUserId: "user-mina" },
    WORKSPACE_ID,
  );
  assert.equal(acceptedResult.status, "accepted");
  assert.equal(acceptedResult.decidedByUserId, "user-mina");
  assert.ok(acceptedResult.decidedAt);
  assert.throws(
    () => rejectCollaborationChangeProposalSync({ proposalId: accepted.id, decidedByUserId: "user-mina" }, WORKSPACE_ID),
    /already accepted/,
  );

  const rejectedResult = rejectCollaborationChangeProposalSync(
    { proposalId: rejected.id, decidedByUserId: "user-mina" },
    WORKSPACE_ID,
  );
  assert.equal(rejectedResult.status, "rejected");

  const proposals = listCollaborationChangeProposalsSync(
    { objectType: "channel_document", objectId: document.id },
    WORKSPACE_ID,
  );
  assert.deepEqual(
    proposals.map((proposal) => proposal.status).sort(),
    ["accepted", "rejected"],
  );

  const activities = listCollaborationActivitiesSync(
    { objectType: "channel_document", objectId: document.id },
    WORKSPACE_ID,
  );
  assert.equal(activities.some((activity) => activity.verb === "proposal.accepted"), true);
  assert.equal(activities.some((activity) => activity.verb === "proposal.rejected"), true);
});

function seedWorkspace(workspaceId: string | undefined, organizationName: string, firstChannelName: string): void {
  ensureWorkspaceRecord(workspaceId ?? "default", organizationName);
  resetWorkspaceStateSync(workspaceId);
  initializeOrganizationSync(
    {
      organizationName,
      ownerName: "Mina",
      ownerRole: "Founder",
      firstChannelName,
    },
    workspaceId,
  );
  createEmployeeSync(
    {
      name: "Atlas",
      role: "Research Agent",
      summary: "Collaboration test agent",
    },
    workspaceId,
  );
}

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
