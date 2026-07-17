import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HttpDaemonClient } from "./daemon-client.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));

test("HttpDaemonClient retries retryable requests after transient server failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ task: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    const result = await client.claimTask("runtime-1");
    assert.equal(result.task, null);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient does not retry non-retryable task completion requests", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    await assert.rejects(
      () => client.completeTask("task-1", { outputText: "done" }),
      /boom/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient sends cached task lease headers until terminal report succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const seenHeaders: Array<Record<string, string | null>> = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seenHeaders.push({
      attemptId: headers.get("x-agent-space-attempt-id"),
      leaseToken: headers.get("x-agent-space-lease-token"),
    });
    if (url.endsWith("/api/daemon/runtimes/runtime-1/tasks/claim")) {
      return new Response(JSON.stringify({
        task: {
          id: "task-1",
          workspaceId: "default",
          agentId: "Atlas",
          runtimeId: "runtime-1",
          activeAttemptId: "attempt-1",
          leaseToken: "lease-1",
          leaseExpiresAt: "2026-01-01T00:05:00.000Z",
          heartbeatAt: "2026-01-01T00:00:00.000Z",
          triggerType: "manual",
          priority: 0,
          status: "claimed",
          inputJson: "{}",
          queuedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/daemon/tasks/task-1/complete")) {
      return new Response(JSON.stringify({ error: "temporary terminal failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 1,
    });

    await client.claimTask("runtime-1");
    await client.startTask("task-1");
    await assert.rejects(
      () => client.completeTask("task-1", { outputText: "done" }),
      /temporary terminal failure/,
    );
    await client.failTask("task-1", { errorText: "fallback failure report" });

    assert.deepEqual(seenHeaders.map((headers) => headers.attemptId), [
      null,
      "attempt-1",
      "attempt-1",
      "attempt-1",
    ]);
    assert.deepEqual(seenHeaders.map((headers) => headers.leaseToken), [
      null,
      "lease-1",
      "lease-1",
      "lease-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built library surface exports HttpDaemonClient", async (t) => {
  const builtIndexPath = resolve(sourceDir, "../dist/index.js");
  const builtClientPath = resolve(sourceDir, "../dist/daemon-client.js");

  if (!existsSync(builtIndexPath) || !existsSync(builtClientPath)) {
    t.skip("Run `npm --prefix packages/daemon run build` to verify the built daemon client surface.");
    return;
  }

  const indexModule = (await import(pathToFileURL(builtIndexPath).href)) as {
    HttpDaemonClient?: unknown;
  };
  const clientModule = (await import(pathToFileURL(builtClientPath).href)) as {
    HttpDaemonClient?: unknown;
  };

  assert.equal(typeof indexModule.HttpDaemonClient, "function");
  assert.equal(typeof clientModule.HttpDaemonClient, "function");
});
