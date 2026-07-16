import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before } from "node:test";
import {
  bindEmployeeRuntimeSync,
  claimNextQueuedTaskForRuntimeSync,
  createAgentTaskAttemptSync,
  createWorkspaceSync,
  enqueueNativeTaskSync,
  getDatabase,
  listAgentRouterEventsSync,
  listAgentTaskAttemptsSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
} from "./index.ts";
import { getPostgresSchemaStatements } from "./postgres-schema.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-task-queue-"));
const dbModuleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "index.ts")).href;

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("claim returns only after creating one active attempt", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("claim-attempt");
  const queued = enqueueTask(workspaceId);

  const claimed = claimNextQueuedTaskForRuntimeSync(runtimeId, workspaceId);

  assert.equal(claimed?.id, queued.id);
  assert.deepEqual(
    listAgentTaskAttemptsSync({ taskQueueId: queued.id }).map((attempt) => attempt.status),
    ["claimed"],
  );
});

test("a second claim does not return or duplicate an already claimed task", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("claim-repeat");
  const queued = enqueueTask(workspaceId);

  assert.equal(claimNextQueuedTaskForRuntimeSync(runtimeId, workspaceId)?.id, queued.id);
  assert.equal(claimNextQueuedTaskForRuntimeSync(runtimeId, workspaceId), null);
  assert.equal(listAgentTaskAttemptsSync({ taskQueueId: queued.id }).length, 1);
});

test("attempt insertion conflict rolls the queue claim back", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("claim-rollback");
  const queued = enqueueTask(workspaceId);
  createAgentTaskAttemptSync({
    workspaceId,
    taskQueueId: queued.id,
    routerSessionId: queued.routerSessionId!,
    runtimeId,
    provider: "codex",
    status: "claimed",
  });

  assert.throws(
    () => claimNextQueuedTaskForRuntimeSync(runtimeId, workspaceId),
    /duplicate key|unique constraint/i,
  );
  assert.equal(readQueuedTaskSync(queued.id)?.status, "queued");
  assert.equal(listAgentTaskAttemptsSync({ taskQueueId: queued.id }).length, 1);
  const eventTypes = listAgentRouterEventsSync({ taskQueueId: queued.id }).map((event) => event.type);
  assert.equal(eventTypes.includes("runtime_selected"), false);
  assert.equal(eventTypes.includes("task.assigned"), false);
});

test("committed claim survives lifecycle event insertion failure", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("claim-event-failure");
  const queued = enqueueTask(workspaceId);
  const db = getDatabase();
  db.exec(`
    CREATE OR REPLACE FUNCTION test_fail_agent_router_event_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'forced agent router event failure';
    END;
    $$;
    DROP TRIGGER IF EXISTS test_fail_agent_router_event_insert ON agent_router_event;
    CREATE TRIGGER test_fail_agent_router_event_insert
      BEFORE INSERT ON agent_router_event
      FOR EACH ROW
      EXECUTE FUNCTION test_fail_agent_router_event_insert();
  `);
  const originalConsoleError = console.error;
  const loggedErrors: string[] = [];
  console.error = (...values: unknown[]) => {
    loggedErrors.push(values.map(String).join(" "));
  };

  try {
    const claimed = claimNextQueuedTaskForRuntimeSync(runtimeId, workspaceId);

    assert.equal(claimed?.id, queued.id);
    assert.equal(readQueuedTaskSync(queued.id)?.status, "claimed");
    assert.equal(listAgentTaskAttemptsSync({ taskQueueId: queued.id }).length, 1);
    assert.match(loggedErrors.join("\n"), new RegExp(queued.id));
  } finally {
    console.error = originalConsoleError;
    db.exec(`
      DROP TRIGGER IF EXISTS test_fail_agent_router_event_insert ON agent_router_event;
      DROP FUNCTION IF EXISTS test_fail_agent_router_event_insert();
    `);
  }
});

test("schema upgrade converges duplicate active attempts before adding the unique index", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("active-attempt-upgrade");
  const queued = enqueueTask(workspaceId);
  const db = getDatabase();
  const statements = getPostgresSchemaStatements();
  const uniqueIndexStatement = statements.find((statement) =>
    statement.includes("idx_agent_task_attempt_one_active_per_task"),
  );
  assert.ok(uniqueIndexStatement, "active-attempt unique index statement is required");
  const convergenceStatements = statements.filter((statement) =>
    statement.includes("ranked_active_attempts"),
  );
  try {
    db.exec("DROP INDEX IF EXISTS idx_agent_task_attempt_one_active_per_task");
    const older = createAgentTaskAttemptSync({
      workspaceId,
      taskQueueId: queued.id,
      routerSessionId: queued.routerSessionId!,
      runtimeId,
      provider: "codex",
      status: "claimed",
    });
    const newer = createAgentTaskAttemptSync({
      workspaceId,
      taskQueueId: queued.id,
      routerSessionId: queued.routerSessionId!,
      runtimeId,
      provider: "codex",
      status: "running",
    });
    db.prepare("UPDATE agent_task_attempt SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", older.id);
    db.prepare("UPDATE agent_task_attempt SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", newer.id);

    for (const statement of [...convergenceStatements, uniqueIndexStatement]) {
      db.exec(statement);
    }

    const attempts = listAgentTaskAttemptsSync({ taskQueueId: queued.id });
    assert.equal(attempts.find((attempt) => attempt.id === newer.id)?.status, "running");
    assert.equal(attempts.find((attempt) => attempt.id === older.id)?.status, "failed");
    assert.match(attempts.find((attempt) => attempt.id === older.id)?.errorText ?? "", /schema v19 migration/i);

    for (const statement of convergenceStatements) {
      db.exec(statement);
    }
    assert.equal(
      listAgentTaskAttemptsSync({ taskQueueId: queued.id }).filter((attempt) =>
        attempt.status === "claimed" || attempt.status === "running"
      ).length,
      1,
    );
  } finally {
    try {
      for (const statement of convergenceStatements) {
        db.exec(statement);
      }
    } finally {
      db.exec(uniqueIndexStatement);
    }
  }
});

test("independent database workers cannot claim the same task", async () => {
  const databaseUrl = process.env.AGENT_SPACE_TEST_DATABASE_URL?.trim();
  assert.ok(databaseUrl, "AGENT_SPACE_TEST_DATABASE_URL is required for the concurrency regression test.");
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("claim-concurrent");
  const queued = enqueueTask(workspaceId);
  const db = getDatabase();
  db.exec(`
    CREATE OR REPLACE FUNCTION test_delay_agent_task_claim()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_sleep(0.2);
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS test_delay_agent_task_claim ON agent_task_queue;
    CREATE TRIGGER test_delay_agent_task_claim
      BEFORE UPDATE OF status ON agent_task_queue
      FOR EACH ROW
      WHEN (NEW.status = 'claimed')
      EXECUTE FUNCTION test_delay_agent_task_claim();
  `);

  try {
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const workers = [
      createClaimWorker({ databaseUrl, workspaceId, runtimeId, barrier }),
      createClaimWorker({ databaseUrl, workspaceId, runtimeId, barrier }),
    ];
    try {
      const resultsPromise = Promise.all(workers.map(readWorkerResult));
      await Promise.race([
        waitForWorkersToBeReady(barrier, workers),
        resultsPromise.then(() => {
          throw new Error("Claim workers exited before reaching the start barrier.");
        }),
      ]);
      const signal = new Int32Array(barrier);
      Atomics.store(signal, 1, 1);
      Atomics.notify(signal, 1, workers.length);

      const results = await resultsPromise;
      const claimedIds = results.map((result) => result.taskId).filter((taskId): taskId is string => Boolean(taskId));

      assert.deepEqual(claimedIds, [queued.id]);
      assert.equal(listAgentTaskAttemptsSync({ taskQueueId: queued.id }).length, 1);
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
  } finally {
    db.exec(`
      DROP TRIGGER IF EXISTS test_delay_agent_task_claim ON agent_task_queue;
      DROP FUNCTION IF EXISTS test_delay_agent_task_claim();
    `);
  }
});

function enqueueTask(workspaceId: string): NonNullable<ReturnType<typeof enqueueNativeTaskSync>> {
  const queued = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Atomic claim task",
    priority: "high",
    triggerType: "manual",
  });
  assert.ok(queued?.routerSessionId);
  return queued;
}

function seedWorkspaceRuntime(prefix: string): { workspaceId: string; runtimeId: string } {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const workspace = createWorkspaceSync({
    id: `${prefix}-${suffix}`,
    slug: `${prefix}-${suffix}`,
    name: `${prefix} ${suffix}`,
    createdBy: "test",
  });
  const runtime = registerDaemonRuntimesSync({
    workspaceId: workspace.id,
    daemonKey: `${workspace.id}-daemon`,
    deviceName: `${workspace.id} daemon`,
    runtimes: [{ provider: "codex", name: "Codex Runtime" }],
  }).runtimes[0];
  assert.ok(runtime?.id);
  bindEmployeeRuntimeSync({
    workspaceId: workspace.id,
    employeeName: "Atlas",
    runtimeId: runtime.id,
  });
  return { workspaceId: workspace.id, runtimeId: runtime.id };
}

function createClaimWorker(input: {
  databaseUrl: string;
  workspaceId: string;
  runtimeId: string;
  barrier: SharedArrayBuffer;
}): Worker {
  return new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        process.env.AGENT_SPACE_TEST_DATABASE_URL = workerData.databaseUrl;
        const db = await import(workerData.dbModuleUrl);
        const signal = new Int32Array(workerData.barrier);
        Atomics.add(signal, 0, 1);
        Atomics.notify(signal, 0, 1);
        Atomics.wait(signal, 1, 0);
        const task = db.claimNextQueuedTaskForRuntimeSync(workerData.runtimeId, workerData.workspaceId);
        parentPort.postMessage({ taskId: task?.id ?? null });
      })().catch((error) => {
        parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
      });
    `,
    {
      eval: true,
      execArgv: ["--experimental-strip-types"],
      workerData: {
        databaseUrl: input.databaseUrl,
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        barrier: input.barrier,
        dbModuleUrl,
      },
    },
  );
}

async function waitForWorkersToBeReady(barrier: SharedArrayBuffer, workers: Worker[]): Promise<void> {
  const signal = new Int32Array(barrier);
  const deadline = Date.now() + 10_000;
  while (Atomics.load(signal, 0) < workers.length) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for claim workers to become ready.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readWorkerResult(worker: Worker): Promise<{ taskId: string | null }> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const finish = async (result: { taskId: string | null } | Error): Promise<void> => {
      cleanup();
      await worker.terminate();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onMessage = (message: { taskId?: string | null; error?: string }): void => {
      if (message.error) {
        void finish(new Error(message.error));
        return;
      }
      void finish({ taskId: message.taskId ?? null });
    };
    const onError = (error: Error): void => {
      void finish(error);
    };
    const onExit = (code: number): void => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`Claim worker exited with code ${code}.`));
      }
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
