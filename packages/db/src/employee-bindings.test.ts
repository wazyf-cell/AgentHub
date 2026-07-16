import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import * as employeeBindings from "./employee-bindings.ts";
import {
  bindEmployeeRuntimeSync,
  createWorkspaceSync,
  getDatabase,
  readEmployeeRuntimeBindingSync,
  registerDaemonRuntimesSync,
} from "./index.ts";

type ExecutionBindingResult = {
  boundAt: string;
  executionBinding: {
    version: 1;
    runtimeId: string;
    provider: string;
    modelId?: string;
    capabilityIds: string[];
  };
};

type BindEmployeeExecutionSync = (input: {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
  modelId?: string;
  capabilityIds?: string[];
}) => ExecutionBindingResult;

const bindEmployeeExecutionSync = (employeeBindings as unknown as {
  bindEmployeeExecutionSync: BindEmployeeExecutionSync;
}).bindEmployeeExecutionSync;
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-employee-bindings-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("bindEmployeeExecutionSync normalizes and round-trips execution policy", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("execution-policy", "claude");

  const binding = bindEmployeeExecutionSync({
    workspaceId,
    employeeName: " Atlas ",
    runtimeId: ` ${runtimeId} `,
    modelId: " claude-sonnet-4-5 ",
    capabilityIds: [" shell ", "documents", "", "shell", " documents "],
  });

  assert.deepEqual(binding.executionBinding, {
    version: 1,
    runtimeId,
    provider: "claude",
    modelId: "claude-sonnet-4-5",
    capabilityIds: ["documents", "shell"],
  });
  assert.deepEqual(readEmployeeRuntimeBindingSync("Atlas", workspaceId)?.executionBinding, binding.executionBinding);
});

test("legacy runtime binding API stores the default execution policy", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("legacy-policy", "codex");

  const binding = bindEmployeeRuntimeSync({ workspaceId, employeeName: "Atlas", runtimeId });

  assert.deepEqual(binding.executionBinding, {
    version: 1,
    runtimeId,
    provider: "codex",
    capabilityIds: [],
  });
});

test("execution binding provider is derived from the workspace runtime", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("provider-derived", "gemini");

  const binding = bindEmployeeExecutionSync({ workspaceId, employeeName: "Atlas", runtimeId });

  assert.equal(binding.executionBinding.provider, "gemini");
});

test("execution binding rejects a runtime from another workspace", () => {
  const first = seedWorkspaceRuntime("cross-workspace-source", "codex");
  const second = seedWorkspaceRuntime("cross-workspace-target", "codex");

  assert.throws(
    () => bindEmployeeExecutionSync({
      workspaceId: second.workspaceId,
      employeeName: "Atlas",
      runtimeId: first.runtimeId,
    }),
    /runtime .* does not exist/i,
  );
});

test("rebind updates execution policy while preserving boundAt", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("rebind-policy", "codex");
  const first = bindEmployeeExecutionSync({
    workspaceId,
    employeeName: "Atlas",
    runtimeId,
    modelId: "gpt-5.1-codex",
    capabilityIds: ["shell"],
  });

  const rebound = bindEmployeeExecutionSync({
    workspaceId,
    employeeName: "Atlas",
    runtimeId,
    modelId: "  ",
    capabilityIds: ["documents"],
  });

  assert.equal(rebound.boundAt, first.boundAt);
  assert.deepEqual(rebound.executionBinding, {
    version: 1,
    runtimeId,
    provider: "codex",
    capabilityIds: ["documents"],
  });
});

test("binding reads database defaults and tolerates non-array capability JSON", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("binding-defaults", "codex");
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO employee_runtime_binding (
      workspace_id, employee_name, runtime_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(workspaceId, "Legacy", runtimeId, now, now);

  const defaults = db.prepare(
    `SELECT
       binding_version AS bindingVersion,
       model_id AS modelId,
       capability_ids_json AS capabilityIdsJson
     FROM employee_runtime_binding
     WHERE workspace_id = ? AND employee_name = ?`,
  ).get(workspaceId, "Legacy") as Record<string, unknown> | undefined;
  assert.equal(defaults?.bindingVersion, 1);
  assert.equal(defaults?.modelId, null);
  assert.deepEqual(JSON.parse(String(defaults?.capabilityIdsJson)), []);

  db.prepare(
    `UPDATE employee_runtime_binding
     SET capability_ids_json = to_jsonb(?::text)
     WHERE workspace_id = ? AND employee_name = ?`,
  ).run("not-an-array", workspaceId, "Legacy");

  assert.deepEqual(readEmployeeRuntimeBindingSync("Legacy", workspaceId)?.executionBinding.capabilityIds, []);
});

function seedWorkspaceRuntime(prefix: string, provider: "claude" | "codex" | "gemini"): {
  workspaceId: string;
  runtimeId: string;
} {
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
    runtimes: [{ provider, name: `${provider} Runtime` }],
  }).runtimes[0];
  assert.ok(runtime?.id);
  return { workspaceId: workspace.id, runtimeId: runtime.id };
}

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
