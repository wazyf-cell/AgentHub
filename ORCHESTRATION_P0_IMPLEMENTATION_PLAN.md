# AgentSpace Orchestration P0-A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the queue claim/attempt atomicity defect and introduce a backward-compatible, persisted `ExecutionBinding` contract as the first safe foundation for durable multi-agent orchestration.

**Architecture:** Keep the existing PostgreSQL queue, router session, provider session, attempt, daemon, and employee binding paths. Make claim and attempt creation one transaction, then version the employee-to-runtime binding with optional model and capability policy while deriving provider identity from the selected runtime. Do not add planner, DAG, capacity greater than one, or lease expiry in this batch.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL 17, AgentSpace domain/db/services packages.

---

## File Map

- `packages/db/src/task-queue.ts`: lock and claim a queue row safely; create its attempt before commit.
- `packages/db/src/agent-router-sessions.ts`: preserve attempt creation APIs and active-attempt invariants.
- `packages/db/src/task-queue.test.ts`: PostgreSQL-backed regression tests for atomic claim behavior.
- `packages/db/src/postgres-schema.ts`: schema version bump and active-attempt uniqueness index.
- `packages/db/src/postgres.test.ts`: schema-level assertion for the new index and binding columns.
- `packages/domain/src/execution-binding.ts`: provider-derived, versioned execution policy contract.
- `packages/domain/src/index.ts`: export the new contract.
- `packages/db/src/types.ts`: expose persisted execution policy on binding records.
- `packages/db/src/employee-bindings.ts`: normalize, persist, and read execution binding policy.
- `packages/db/src/employee-bindings.test.ts`: backward compatibility, normalization, and workspace isolation tests.
- `packages/db/src/index.ts`: export the new DB binding API.
- `packages/services/src/employees/employees.ts`: permission-checked service entry point for execution policy binding.
- `packages/services/src/index.ts`: export the service entry point.

### Task 1: Make Queue Claim And Attempt Creation Atomic

**Files:**

- Create: `packages/db/src/task-queue.test.ts`
- Modify: `packages/db/src/task-queue.ts`
- Modify: `packages/db/src/postgres-schema.ts`
- Modify: `packages/db/src/postgres.test.ts`

- [ ] **Step 1: Write the failing atomic claim tests**

Create PostgreSQL-backed tests that register a runtime, bind `Atlas`, enqueue a task, and assert:

```ts
test("claim creates one active attempt before returning the task", () => {
  const { runtimeId, taskId } = createQueuedTask();

  const claimed = claimNextQueuedTaskForRuntimeSync(runtimeId, TEST_WORKSPACE_ID);

  assert.equal(claimed?.id, taskId);
  assert.equal(readQueuedTaskSync(taskId)?.status, "claimed");
  assert.equal(countActiveAttempts(taskId), 1);
});

test("a second claim cannot create a duplicate active attempt", () => {
  const { runtimeId, taskId } = createQueuedTask();

  const first = claimNextQueuedTaskForRuntimeSync(runtimeId, TEST_WORKSPACE_ID);
  const second = claimNextQueuedTaskForRuntimeSync(runtimeId, TEST_WORKSPACE_ID);

  assert.equal(first?.id, taskId);
  assert.equal(second, null);
  assert.equal(countActiveAttempts(taskId), 1);
});
```

Add a worker-thread regression that imports the real `claimNextQueuedTaskForRuntimeSync` entry point twice against the same `AGENT_SPACE_TEST_DATABASE_URL`. Release both workers from one barrier, collect their results, and assert that a single queued task is returned once and has one active attempt.

Add a rollback test by pre-inserting an active attempt for a still-queued task. The partial unique index must make the attempt insert fail; after the thrown error, the queue row must still be `queued`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
$env:AGENT_SPACE_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/agentspace_p0_test'
node --experimental-strip-types --test --test-isolation=none --test-concurrency=1 packages/db/src/task-queue.test.ts
```

Expected: at least the concurrency/rollback assertion fails because claim currently commits before creating the attempt and does not lock the candidate row with `SKIP LOCKED`.

- [ ] **Step 3: Add the active-attempt schema invariant**

Increment `POSTGRES_SCHEMA_VERSION` by one and add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_attempt_one_active_per_task
  ON agent_task_attempt(task_queue_id)
  WHERE status IN ('claimed', 'running')
```

Extend the schema test with:

```ts
assert.match(
  statements,
  /idx_agent_task_attempt_one_active_per_task[\s\S]*status IN \('claimed', 'running'\)/,
);
```

- [ ] **Step 4: Lock the candidate and create the attempt inside the transaction**

Change direct candidate selection to end in:

```sql
ORDER BY priority DESC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

For fallback candidates, lock only the chosen queue row before reassignment and keep the conditional `status = 'queued'` update. Treat an update as successful only when `changes === 1`.

Within the same `BEGIN`/`COMMIT` block:

1. update the queue row to `claimed`;
2. read its runtime/router-session context;
3. choose the provider session;
4. insert the `agent_task_attempt` row;
5. retain the attempt for lifecycle events after commit.

If any step throws, `ROLLBACK` must leave the queue row queued and without a new attempt. Do not emit lifecycle events until after commit.

- [ ] **Step 5: Run focused and adjacent tests and verify GREEN**

Run:

```powershell
$env:AGENT_SPACE_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/agentspace_p0_test'
node --experimental-strip-types --test --test-isolation=none --test-concurrency=1 packages/db/src/task-queue.test.ts packages/db/src/agent-router-sessions.test.ts packages/db/src/task-execution-events.test.ts
node --experimental-strip-types --test --test-isolation=none --test-name-pattern='postgres schema includes' packages/db/src/postgres.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 6: Commit the atomic claim fix**

```powershell
git add packages/db/src/task-queue.ts packages/db/src/task-queue.test.ts packages/db/src/postgres-schema.ts packages/db/src/postgres.test.ts
git commit -m "fix: make task claim and attempt atomic"
```

### Task 2: Persist A Backward-Compatible ExecutionBinding

**Files:**

- Create: `packages/domain/src/execution-binding.ts`
- Create: `packages/db/src/employee-bindings.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/employee-bindings.ts`
- Modify: `packages/db/src/postgres-schema.ts`
- Modify: `packages/db/src/postgres.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/services/src/employees/employees.ts`
- Modify: `packages/services/src/index.ts`

- [ ] **Step 1: Define the desired domain API in a failing test**

The contract is:

```ts
export interface ExecutionBinding {
  version: 1;
  runtimeId: string;
  provider: DaemonProvider;
  modelId?: string;
  capabilityIds: string[];
}
```

Write DB tests for the new API:

```ts
const binding = bindEmployeeExecutionSync({
  workspaceId: TEST_WORKSPACE_ID,
  employeeName: "Atlas",
  runtimeId,
  modelId: "  gpt-5.1  ",
  capabilityIds: [" repo.write ", "repo.read", "repo.write", ""],
});

assert.deepEqual(binding.executionBinding, {
  version: 1,
  runtimeId,
  provider: "codex",
  modelId: "gpt-5.1",
  capabilityIds: ["repo.read", "repo.write"],
});
```

Also test:

- the legacy `bindEmployeeRuntimeSync` produces `modelId: undefined` and `capabilityIds: []`;
- provider always comes from `agent_runtime` and is not accepted from input;
- a runtime from another workspace is rejected;
- rebind updates policy but preserves `boundAt`;
- rows created with schema defaults read as version 1 with an empty capability list.

- [ ] **Step 2: Run the binding test and verify RED**

Run:

```powershell
$env:AGENT_SPACE_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/agentspace_p0_test'
node --experimental-strip-types --test --test-isolation=none --test-concurrency=1 packages/db/src/employee-bindings.test.ts
```

Expected: import/type failure because the execution binding API and fields do not exist.

- [ ] **Step 3: Add the domain contract and persisted columns**

Export `ExecutionBinding` from `packages/domain/src/index.ts`. Add these columns to both the table definition and idempotent upgrade statements:

```sql
binding_version INTEGER NOT NULL DEFAULT 1,
model_id TEXT,
capability_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb
```

Increment `POSTGRES_SCHEMA_VERSION` once for the final combined schema state of this branch. If Task 1 already incremented it, increment it again here. Add schema assertions for all three columns.

- [ ] **Step 4: Implement normalization and backward compatibility**

Add:

```ts
export function bindEmployeeExecutionSync(input: {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
  modelId?: string;
  capabilityIds?: string[];
}): EmployeeRuntimeBindingRecord
```

Normalize `modelId` to trimmed non-empty or `undefined`. Normalize capability IDs by trimming, removing empty values, deduplicating, and sorting. Derive provider from the workspace-scoped runtime row. Persist JSON with `JSON.stringify(capabilityIds)`.

Keep `bindEmployeeRuntimeSync(input)` as a wrapper that calls the new API without model/capabilities. Map malformed stored capability JSON to `[]`; do not throw from list/read paths because older rows must remain readable.

- [ ] **Step 5: Add the permission-checked service entry point**

Expose a service-level `bindEmployeeExecutionSync(employeeName, input, workspaceId?, actorUserId?)`. Reuse the same employee existence, employee management, and runtime usage checks as the legacy service function. Keep existing `bindEmployeeRuntimeSync` behavior and messages unchanged.

- [ ] **Step 6: Run focused tests and type checks**

Run:

```powershell
$env:AGENT_SPACE_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/agentspace_p0_test'
node --experimental-strip-types --test --test-isolation=none --test-concurrency=1 packages/db/src/employee-bindings.test.ts packages/db/src/daemons.test.ts packages/db/src/task-queue.test.ts
node --experimental-strip-types --test --test-isolation=none --test-name-pattern='postgres schema includes' packages/db/src/postgres.test.ts
npm run typecheck:deps
```

Expected: selected tests and dependency type checks pass with zero failures.

- [ ] **Step 7: Commit the execution binding foundation**

```powershell
git add packages/domain/src/execution-binding.ts packages/domain/src/index.ts packages/db/src/types.ts packages/db/src/employee-bindings.ts packages/db/src/employee-bindings.test.ts packages/db/src/postgres-schema.ts packages/db/src/postgres.test.ts packages/db/src/index.ts packages/services/src/employees/employees.ts packages/services/src/index.ts
git commit -m "feat: persist execution binding policy"
```

## Deferred P0-B Boundary

The next plan starts only after both tasks above pass review. It will add cryptographically random lease tokens, `active_attempt_id`, database-clock expiry, task heartbeat, stale-worker fencing on every daemon route, and expired-attempt recovery. Automatic recovery must not be enabled until claim, heartbeat, start, output upload, completion, and failure all carry and validate the same `taskId + attemptId + leaseToken` tuple.

## Self-Review

- Spec coverage: Task 1 fixes the current claim/attempt crash and duplicate-claim boundary; Task 2 makes provider/model/capability policy explicit without changing runtime execution behavior.
- Scope exclusions: planner, DAG, aggregation, `capacity > 1`, lease expiry, provider model override, and UI are intentionally excluded from P0-A.
- Type consistency: the domain name is `ExecutionBinding`; the persisted record exposes it as `executionBinding`; the write API is `bindEmployeeExecutionSync` in DB and services.
- Completeness scan: every implementation and verification step is concrete.
