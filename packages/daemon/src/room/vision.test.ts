import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeImage, type VisionRunner } from "./vision.ts";

test("vision bridge caches by image and prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-vision-"));
  const imagePath = join(dir, "shot.png");
  const cacheDir = join(dir, "cache");
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
  let calls = 0;
  const runner: VisionRunner = async () => {
    calls += 1;
    return { stdout: JSON.stringify({ summary: "a red button" }), stderr: "", exitCode: 0 };
  };
  try {
    const first = await describeImage({ imagePath, prompt: "focus", cacheDir }, runner);
    assert.equal(first.status, "completed");
    assert.equal(first.description, "a red button");
    assert.equal(first.cached, false);
    assert.equal(calls, 1);

    const second = await describeImage({ imagePath, prompt: "focus", cacheDir }, runner);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);

    const third = await describeImage({ imagePath, prompt: "another focus", cacheDir }, runner);
    assert.equal(third.cached, false);
    assert.equal(calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vision bridge reports missing images and provider failures", async () => {
  const missing = await describeImage({ imagePath: join(tmpdir(), "agenthub-missing-image.png") });
  assert.equal(missing.status, "failed");
  assert.match(missing.error ?? "", /image not found/);

  const dir = mkdtempSync(join(tmpdir(), "agenthub-vision-fail-"));
  const imagePath = join(dir, "shot.png");
  writeFileSync(imagePath, Buffer.from([1]));
  try {
    const failed = await describeImage(
      { imagePath, cacheDir: join(dir, "cache") },
      async () => ({ stdout: "", stderr: "no provider configured", exitCode: 2 }),
    );
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /exited 2/);
    assert.match(failed.error ?? "", /no provider configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
