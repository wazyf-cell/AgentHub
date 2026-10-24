import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFileReferenceAppendix, extractFileReferences } from "./file-refs.ts";

function withWorkspace(run: (workspace: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agenthub-refs-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("extractFileReferences finds @paths and skips punctuation", () => {
  const refs = extractFileReferences("看下 @src/a.ts，以及 @docs/b.md。还有邮箱 a@b.com");
  assert.deepEqual(refs, ["src/a.ts", "docs/b.md"]);
  assert.deepEqual(extractFileReferences('打开 @"my file.txt" 看看'), ["my file.txt"]);
});

test("buildFileReferenceAppendix embeds workspace files and refuses escapes", () => {
  withWorkspace((workspace) => {
    mkdirSync(join(workspace, "src"));
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(workspace, "node_modules", "hidden.js"), "nope");
    writeFileSync(join(workspace, "big.txt"), "x".repeat(30_000));

    const appendix = buildFileReferenceAppendix(
      workspace,
      "请参考 @src/a.ts 和 @node_modules/hidden.js 和 @../secret.txt",
    );
    assert.ok(appendix?.includes("### src/a.ts"));
    assert.ok(appendix?.includes("export const a = 1;"));
    assert.ok(!appendix?.includes("hidden.js"));
    assert.ok(!appendix?.includes("secret"));

    const truncated = buildFileReferenceAppendix(workspace, "看 @big.txt", { maxFileBytes: 100 });
    assert.ok(truncated?.includes("已截断"));
    assert.ok((truncated ?? "").length < 1_000);
  });
});

test("buildFileReferenceAppendix returns undefined without workspace or matches", () => {
  assert.equal(buildFileReferenceAppendix(undefined, "@a.ts"), undefined);
  withWorkspace((workspace) => {
    assert.equal(buildFileReferenceAppendix(workspace, "@missing.ts"), undefined);
    assert.equal(buildFileReferenceAppendix(workspace, "no refs here"), undefined);
  });
});
