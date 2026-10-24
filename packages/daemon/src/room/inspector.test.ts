import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listTree, readWorkspaceFile, searchWorkspace } from "./inspector.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agenthub-inspector-"));
  writeFileSync(join(root, "hello.txt"), "a needle here\nsecond line\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  return root;
}

test("inspector lists trees, reads UTF-8 and GBK, and fences paths", () => {
  const root = setup();
  try {
    const entries = listTree(root, "", 2);
    assert.ok(entries.some((entry) => entry.path === "hello.txt" && entry.type === "file"));
    assert.ok(entries.some((entry) => entry.path === "src" && entry.type === "dir"));
    assert.ok(entries.some((entry) => entry.path === "src/app.ts"));

    const utf8 = readWorkspaceFile(root, "hello.txt");
    assert.equal(utf8.kind, "text");
    assert.equal(utf8.encoding, "UTF-8");
    assert.match(utf8.content ?? "", /needle/);

    writeFileSync(join(root, "gbk.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    const gbk = readWorkspaceFile(root, "gbk.txt");
    assert.equal(gbk.encoding, "GBK");
    assert.equal(gbk.content, "中文");

    assert.throws(() => readWorkspaceFile(root, "../outside.txt"), /越界/);
    assert.throws(() => listTree(root, ".."), /越界/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspector search finds content", () => {
  const root = setup();
  try {
    const result = searchWorkspace(root, "needle");
    assert.ok(result.hits.length >= 1);
    assert.equal(result.hits[0].path, "hello.txt");
    assert.equal(result.hits[0].line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
