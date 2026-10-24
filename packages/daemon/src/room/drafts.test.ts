import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyDraft, createDraft, discardDraft, listDrafts, refreshDraft } from "./drafts.ts";
import { RoomStore } from "./store.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agenthub-drafts-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "one");
  writeFileSync(join(workspace, "sub", "b.txt"), "two");
  const store = new RoomStore(join(root, "data"));
  return { root, workspace, store };
}

test("drafts copy scope, report changes and apply only selected files", () => {
  const { root, workspace, store } = setup();
  try {
    const draft = createDraft({ store, workspaceId: "ws", workspacePath: workspace, scope: ["a.txt", "sub"] });
    assert.equal(readFileSync(join(draft.workDir, "a.txt"), "utf8"), "one");
    assert.equal(readFileSync(join(draft.workDir, "sub", "b.txt"), "utf8"), "two");

    writeFileSync(join(draft.workDir, "a.txt"), "changed");
    writeFileSync(join(draft.workDir, "new.txt"), "new");
    rmSync(join(draft.workDir, "sub", "b.txt"));

    const refreshed = refreshDraft(store, draft.runId);
    const kinds = Object.fromEntries(refreshed.changes.map((change) => [change.path, change.kind]));
    assert.equal(kinds["a.txt"], "modified");
    assert.equal(kinds["new.txt"], "added");
    assert.equal(kinds["sub/b.txt"], "deleted");

    const result = applyDraft(store, draft.runId);
    assert.equal(result.conflicts.length, 0);
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "changed");
    assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(workspace, "sub", "b.txt"), "utf8"), "two", "deletions are not applied by default");
    assert.equal(existsSync(draft.draftDir), false);
    assert.deepEqual(listDrafts(store), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("draft apply skips conflicting targets and keeps the draft", () => {
  const { root, workspace, store } = setup();
  try {
    const draft = createDraft({ store, workspaceId: "ws", workspacePath: workspace, scope: ["a.txt"] });
    writeFileSync(join(draft.workDir, "a.txt"), "draft");
    writeFileSync(join(workspace, "a.txt"), "external");
    const result = applyDraft(store, draft.runId);
    assert.equal(result.applied.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0].reason, /已变化/);
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "external");
    assert.equal(existsSync(join(draft.draftDir, "draft.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discarding a draft never touches the workspace", () => {
  const { root, workspace, store } = setup();
  try {
    const draft = createDraft({ store, workspaceId: "ws", workspacePath: workspace, scope: ["a.txt"] });
    writeFileSync(join(draft.workDir, "a.txt"), "draft");
    const discarded = discardDraft(store, draft.runId);
    assert.equal(discarded.status, "discarded");
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "one");
    assert.equal(existsSync(draft.draftDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
