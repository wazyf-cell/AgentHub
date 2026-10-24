import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomCommand, runCustomCliTurn, splitCommandTemplate } from "./custom-cli.ts";

type Built = ReturnType<typeof buildCustomCommand>;

function planOf(built: Built) {
  if ("plan" in built) return built.plan;
  throw new Error(built.error);
}

test("command template substitutes placeholders and appends a missing prompt", () => {
  assert.deepEqual(splitCommandTemplate('my-agent --greeting "hello world" {model}'), [
    "my-agent",
    "--greeting",
    "hello world",
    "{model}",
  ]);

  assert.deepEqual(
    planOf(buildCustomCommand('my-agent --model {model} ask --text "{prompt}"', {
      prompt: "你好 世界",
      model: "gpt-x",
    })),
    { executable: "my-agent", args: ["--model", "gpt-x", "ask", "--text", "你好 世界"] },
  );

  assert.deepEqual(planOf(buildCustomCommand("my-agent --quiet", { prompt: "正文" })).args, ["--quiet", "正文"]);

  assert.deepEqual(
    planOf(buildCustomCommand("my-agent --image {image} {images}", {
      prompt: "看图",
      images: ["a.png", "b.png"],
    })).args,
    ["--image", "a.png", "a.png", "b.png", "看图"],
  );

  const empty = buildCustomCommand("   ", { prompt: "x" });
  assert.ok("error" in empty);
  assert.match(empty.error, /命令模板为空/);
});

test("custom CLI turn runs the command and returns stdout as the reply", async () => {
  const result = await runCustomCliTurn({
    template: `node -e "process.stdout.write('回声:' + process.argv[1])" {prompt}`,
    prompt: "你好",
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "回声:你好");
});

test("custom CLI turn reports a failing command instead of an empty reply", async () => {
  const result = await runCustomCliTurn({
    template: 'node -e "process.stderr.write(\'坏了\'); process.exit(3)" {prompt}',
    prompt: "x",
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /退出码 3/);
});
