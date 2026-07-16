import { isDaemonProvider } from "@agent-space/domain";
import { getDatabase, withTransaction, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { EmployeeRuntimeBindingRecord } from "./types.ts";

export function bindEmployeeRuntimeSync(input: {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
}): EmployeeRuntimeBindingRecord {
  return bindEmployeeExecutionSync(input);
}

export function bindEmployeeExecutionSync(input: {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
  modelId?: string;
  capabilityIds?: string[];
}): EmployeeRuntimeBindingRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeName = input.employeeName.trim();
  const runtimeId = input.runtimeId.trim();
  const modelId = normalizeModelId(input.modelId);
  const capabilityIds = normalizeCapabilityIds(input.capabilityIds ?? []);
  const now = new Date().toISOString();

  if (!employeeName) {
    throw new Error("employeeName is required.");
  }
  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }

  const runtime = db
    .prepare(
      `SELECT
        id,
        provider,
        name
      FROM agent_runtime
      WHERE id = ? AND workspace_id = ?`,
    )
    .get(runtimeId, workspaceId) as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime.provider !== "string" || typeof runtime.name !== "string") {
    throw new Error(`Runtime "${runtimeId}" does not exist.`);
  }

  db.prepare(
    `INSERT INTO employee_runtime_binding (
      workspace_id,
      employee_name,
      runtime_id,
      binding_version,
      capability_ids_json,
      model_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, employee_name) DO UPDATE SET
      runtime_id = excluded.runtime_id,
      binding_version = excluded.binding_version,
      model_id = excluded.model_id,
      capability_ids_json = excluded.capability_ids_json,
      updated_at = excluded.updated_at`,
  ).run(workspaceId, employeeName, runtimeId, 1, JSON.stringify(capabilityIds), modelId ?? null, now, now);

  return readEmployeeRuntimeBindingSync(employeeName, workspaceId)!;
}

export function unbindEmployeeRuntimeSync(employeeName: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      `DELETE FROM employee_runtime_binding
       WHERE workspace_id = ? AND employee_name = ?`,
    )
    .run(workspaceId, employeeName.trim());
  return result.changes > 0;
}

export function deleteEmployeeExecutionStateSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): { removedBinding: boolean; removedQueuedTasks: number } {
  const db = getDatabase();
  const normalizedEmployeeName = employeeName.trim();
  let removedBinding = false;
  let removedQueuedTasks = 0;

  withTransaction(db, () => {
    const bindingResult = db
      .prepare(
        `DELETE FROM employee_runtime_binding
         WHERE workspace_id = ? AND employee_name = ?`,
      )
      .run(workspaceId, normalizedEmployeeName);
    removedBinding = bindingResult.changes > 0;

    const queueResult = db
      .prepare(
        `DELETE FROM agent_task_queue
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .run(workspaceId, normalizedEmployeeName);
    removedQueuedTasks = Number(queueResult.changes);
  });

  return { removedBinding, removedQueuedTasks };
}

export function readEmployeeRuntimeBindingSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeRuntimeBindingRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
        erb.workspace_id AS workspaceId,
        erb.employee_name AS employeeName,
        erb.runtime_id AS runtimeId,
        erb.binding_version AS bindingVersion,
        erb.model_id AS modelId,
        erb.capability_ids_json AS capabilityIdsJson,
        ar.provider AS provider,
        ar.name AS runtimeName,
        erb.created_at AS boundAt,
        erb.updated_at AS updatedAt
      FROM employee_runtime_binding erb
      JOIN agent_runtime ar ON ar.id = erb.runtime_id
      WHERE erb.workspace_id = ? AND erb.employee_name = ?`,
    )
    .get(workspaceId, employeeName.trim()) as Record<string, unknown> | undefined;

  return row ? mapEmployeeRuntimeBindingRecord(row) : null;
}

export function listEmployeeRuntimeBindingsSync(workspaceId = DEFAULT_WORKSPACE_ID): EmployeeRuntimeBindingRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
        erb.workspace_id AS workspaceId,
        erb.employee_name AS employeeName,
        erb.runtime_id AS runtimeId,
        erb.binding_version AS bindingVersion,
        erb.model_id AS modelId,
        erb.capability_ids_json AS capabilityIdsJson,
        ar.provider AS provider,
        ar.name AS runtimeName,
        erb.created_at AS boundAt,
        erb.updated_at AS updatedAt
      FROM employee_runtime_binding erb
      JOIN agent_runtime ar ON ar.id = erb.runtime_id
      WHERE erb.workspace_id = ?
      ORDER BY erb.employee_name ASC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapEmployeeRuntimeBindingRecord(row))
    .filter((row): row is EmployeeRuntimeBindingRecord => row !== null);
}

function mapEmployeeRuntimeBindingRecord(value: Record<string, unknown>): EmployeeRuntimeBindingRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.runtimeId !== "string" ||
    !isDaemonProvider(value.provider as string) ||
    typeof value.runtimeName !== "string" ||
    typeof value.boundAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: value.workspaceId,
    employeeName: value.employeeName,
    runtimeId: value.runtimeId,
    provider: value.provider as EmployeeRuntimeBindingRecord["provider"],
    runtimeName: value.runtimeName,
    executionBinding: {
      version: 1,
      runtimeId: value.runtimeId,
      provider: value.provider as EmployeeRuntimeBindingRecord["provider"],
      ...normalizeStoredModelId(value.modelId),
      capabilityIds: parseCapabilityIdsJson(value.capabilityIdsJson),
    },
    boundAt: value.boundAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeModelId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeStoredModelId(value: unknown): { modelId?: string } {
  if (typeof value !== "string") {
    return {};
  }
  const modelId = normalizeModelId(value);
  return modelId ? { modelId } : {};
}

function normalizeCapabilityIds(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ).sort();
}

function parseCapabilityIdsJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeCapabilityIds(value.filter((item): item is string => typeof item === "string"));
  }
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeCapabilityIds(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}
