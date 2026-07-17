import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildRemoteDaemonConfig,
  buildRemoteDaemonRelaunchCommand,
  resolveCodeDevelopmentExecutionCwd,
  resolveRemoteTaskProviderSessionId,
} from "./remote-daemon.ts";

test("buildRemoteDaemonConfig reads env-backed defaults without repository state", () => {
  const config = buildRemoteDaemonConfig(
    {},
    {
      environment: {
        HOME: "/tmp/daemon-home",
        HOSTNAME: "daemon-box",
        AGENT_SPACE_SERVER_URL: "https://agentspace.example",
        AGENT_SPACE_DAEMON_TOKEN: "adt_test",
      },
    },
  );

  assert.equal(config.stateDir, join("/tmp/daemon-home", ".agent-space-daemon"));
  assert.equal(config.daemonKey, "daemon-box");
  assert.equal(config.deviceName, "daemon-box");
  assert.equal(config.runtimeName, "Remote Agent");
  assert.equal(config.serverUrl, "https://agentspace.example");
  assert.equal(config.daemonToken, "adt_test");
  assert.equal(config.taskTimeoutMs, 12 * 60 * 60 * 1000);
});

test("buildRemoteDaemonConfig prefers explicit flags over env", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
      "device-name": "gpu-box-1",
      "runtime-name": "GPU Agent",
      "server-url": "https://override.example",
      "daemon-token": "adt_override",
      "heartbeat-interval": "20000",
      "poll-interval": "5000",
      "task-timeout": "28800000",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
        HOSTNAME: "daemon-box",
        AGENT_SPACE_SERVER_URL: "https://agentspace.example",
        AGENT_SPACE_DAEMON_TOKEN: "adt_test",
      },
    },
  );

  assert.equal(config.stateDir, "/srv/daemon-state");
  assert.equal(config.daemonKey, "daemon-prod-01");
  assert.equal(config.deviceName, "gpu-box-1");
  assert.equal(config.runtimeName, "GPU Agent");
  assert.equal(config.serverUrl, "https://override.example");
  assert.equal(config.daemonToken, "adt_override");
  assert.equal(config.heartbeatIntervalMs, 20000);
  assert.equal(config.taskPollIntervalMs, 5000);
  assert.equal(config.taskTimeoutMs, 28800000);
});

test("buildRemoteDaemonRelaunchCommand reuses the installed daemon bin without strip-types", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
      "device-name": "gpu-box-1",
      "runtime-name": "GPU Agent",
      "server-url": "https://agentspace.example",
      "daemon-token": "adt_override",
      "heartbeat-interval": "20000",
      "poll-interval": "5000",
      "task-timeout": "28800000",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "/opt/agent-space/bin/agent-space-daemon.js"],
    execPath: "/usr/bin/node",
  });

  assert.equal(command.command, "/usr/bin/node");
  assert.equal(command.args[0], "/opt/agent-space/bin/agent-space-daemon.js");
  assert.equal(command.args.includes("--experimental-strip-types"), false);
  assert.deepEqual(command.args.slice(1, 8), [
    "start",
    "--foreground",
    "--state-dir",
    "/srv/daemon-state",
    "--daemon-id",
    "daemon-prod-01",
    "--device-name",
  ]);
  assert.equal(command.args.includes("--server-url"), true);
  assert.equal(command.args.includes("https://agentspace.example"), true);
  assert.equal(command.args.includes("--daemon-token"), true);
  assert.equal(command.args.includes("adt_override"), true);
});

test("buildRemoteDaemonRelaunchCommand resolves relative daemon bin paths before changing cwd", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "runtime/bin/agent-space-daemon.js"],
    execPath: "/usr/bin/node",
  });

  assert.equal(command.args[0], resolve("runtime/bin/agent-space-daemon.js"));
});

test("buildRemoteDaemonRelaunchCommand preserves strip-types only for source TypeScript entrypoints", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "packages/daemon/src/cli.ts"],
    execPath: "/usr/bin/node",
  });

  assert.deepEqual(command.args.slice(0, 4), [
    "--experimental-strip-types",
    resolve("packages/daemon/src/cli.ts"),
    "start",
    "--foreground",
  ]);
});

test("resolveRemoteTaskProviderSessionId reads channel session from task payload", () => {
  assert.equal(
    resolveRemoteTaskProviderSessionId(JSON.stringify({ channelSessionId: " session-1 " })),
    "session-1",
  );
  assert.equal(resolveRemoteTaskProviderSessionId(JSON.stringify({ channelSessionId: "" })), undefined);
  assert.equal(resolveRemoteTaskProviderSessionId("{not-json"), undefined);
});

test("resolveCodeDevelopmentExecutionCwd marks valid worktrees active", () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "agent-space-valid-worktree-"));
  try {
    const resolution = resolveCodeDevelopmentExecutionCwd(buildInputBundle({
      sessionId: "code-session-1",
      worktreePath,
    }));

    assert.equal(resolution.status, "active");
    assert.equal(resolution.executionCwd, resolve(worktreePath));
    assert.equal(resolution.requestedWorktreePath, resolve(worktreePath));
    assert.equal(resolution.warning, undefined);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("resolveCodeDevelopmentExecutionCwd reports invalid worktrees instead of silently falling back", () => {
  const missingPath = resolve(join(tmpdir(), "agent-space-missing-worktree"));
  const missing = resolveCodeDevelopmentExecutionCwd(buildInputBundle({
    sessionId: "code-session-missing",
    worktreePath: missingPath,
  }));
  assert.equal(missing.status, "invalid");
  assert.equal(missing.executionCwd, undefined);
  assert.equal(missing.requestedWorktreePath, missingPath);
  assert.equal(missing.invalidReason, "worktree path does not exist or is not a directory");
  assert.match(missing.warning ?? "", /code-session-missing/);

  const relative = resolveCodeDevelopmentExecutionCwd(buildInputBundle({
    sessionId: "code-session-relative",
    worktreePath: "relative/worktree",
  }));
  assert.equal(relative.status, "invalid");
  assert.equal(relative.executionCwd, undefined);
  assert.equal(relative.invalidReason, "worktree path is not absolute");
  assert.match(relative.warning ?? "", /staging work directory/);
});

test("resolveCodeDevelopmentExecutionCwd ignores tasks without code development metadata", () => {
  const resolution = resolveCodeDevelopmentExecutionCwd(buildInputBundle(undefined));
  assert.equal(resolution.status, "none");
  assert.equal(resolution.executionCwd, undefined);
  assert.equal(resolution.warning, undefined);
});

function buildInputBundle(codeDevelopment: { sessionId?: string; worktreePath?: string } | undefined) {
  return {
    metadata: {
      codeDevelopment,
    },
  } as Parameters<typeof resolveCodeDevelopmentExecutionCwd>[0];
}
