import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import type { AgentTurnRequest, ModelDescriptor, PlatformConfig } from "../types.ts";
import { OpenAiBackend } from "./openai.ts";

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    room: { version: 1, id: "r", name: "R", workspace: process.cwd(), members: [], rules: { autonomy: "medium", maxHandoffs: 2 }, createdAt: "", updatedAt: "" },
    member: {
      id: "m",
      name: "M",
      role: "role",
      instructions: "",
      binding: { platformId: "api", modelId: "m1" },
    },
    prompt: "hello",
    turnId: "t1",
    ...overrides,
  };
}

function platform(baseUrl: string): PlatformConfig {
  return {
    id: "api",
    name: "API",
    kind: "openai-compatible",
    config: {
      baseUrl,
      apiKeyEnv: "AGENTHUB_TEST_API_KEY",
      costBaseYuanPerMillion: 100,
      timeoutMs: 5000,
    },
  };
}

const visionModel: ModelDescriptor = {
  platformId: "api",
  modelId: "m1",
  displayName: "M1",
  input: ["text", "image"],
};

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => handler(req, res, body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("openai backend streams deltas and records usage/cost", async () => {
  process.env.AGENTHUB_TEST_API_KEY = "sk-test";
  let received: Record<string, unknown> = {};
  let authorization = "";
  const server = await startServer((req, res, body) => {
    received = JSON.parse(body) as Record<string, unknown>;
    authorization = String(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n');
    res.end("data: [DONE]\n\n");
  });
  try {
    const deltas: string[] = [];
    const backend = new OpenAiBackend({
      platform: platform(server.baseUrl),
      model: visionModel,
      thinking: "high",
    });
    const result = await backend.runTurn(request({ onDelta: (text) => deltas.push(text) }));
    assert.equal(result.status, "completed");
    assert.equal(result.text, "你好");
    assert.deepEqual(deltas, ["你", "好"]);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2, contextTokens: 10, totalTokens: 12 });
    assert.equal(Number((result.costYuan ?? 0).toFixed(6)), 0.0012);
    assert.equal(received.model, "m1");
    assert.equal(received.reasoning_effort, "high");
    assert.equal(authorization, "Bearer sk-test");
  } finally {
    await server.close();
    delete process.env.AGENTHUB_TEST_API_KEY;
  }
});

test("openai backend sends local images as data urls", async () => {
  process.env.AGENTHUB_TEST_API_KEY = "sk-test";
  const dir = mkdtempSync(join(tmpdir(), "agenthub-openai-img-"));
  const imagePath = join(dir, "shot.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let received: Record<string, unknown> = {};
  const server = await startServer((_req, res, body) => {
    received = JSON.parse(body) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"seen"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  try {
    const backend = new OpenAiBackend({ platform: platform(server.baseUrl), model: visionModel });
    const result = await backend.runTurn(request({ images: [imagePath] }));
    assert.equal(result.status, "completed");
    const messages = received.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const imagePart = messages[0].content.find((part) => part.type === "image_url") as {
      image_url: { url: string };
    };
    assert.equal(imagePart.image_url.url, "data:image/png;base64,iVBORw==");
  } finally {
    await server.close();
    delete process.env.AGENTHUB_TEST_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openai backend reports HTTP errors without leaking the key", async () => {
  process.env.AGENTHUB_TEST_API_KEY = "sk-secret";
  const server = await startServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key sk-secret" } }));
  });
  try {
    const backend = new OpenAiBackend({ platform: platform(server.baseUrl), model: visionModel });
    const result = await backend.runTurn(request());
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /HTTP 401/);
    assert.ok(!(result.error ?? "").includes("sk-secret"));
    assert.match(result.error ?? "", /\[redacted\]/);
  } finally {
    await server.close();
    delete process.env.AGENTHUB_TEST_API_KEY;
  }
});
