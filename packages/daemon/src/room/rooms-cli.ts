#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { askBtw, listBtw, promoteBtw } from "./btw.ts";
import { createDemoFakeBackend } from "./backends/fake.ts";
import { RoomBackendRouter } from "./backends/router.ts";
import { scanCapabilities } from "./capabilities.ts";
import { describeImage } from "./vision.ts";
import { findModel, loadModels, syncModelsFromAiWorkGate } from "./catalog.ts";
import { graphImpact, graphQuery, graphStatus, graphSync } from "./codegraph.ts";
import { createRoomFromInput } from "./create-room.ts";
import { createDemoRoom } from "./demo.ts";
import {
  applyDraft,
  cleanupDrafts,
  createDraft,
  discardDraft,
  findDraft,
  listDrafts,
  refreshDraft,
  workDirOf,
} from "./drafts.ts";
import { runRoom } from "./engine.ts";
import { HealthChecker } from "./health.ts";
import { detectTools, gitDiff, gitStatus, listFiles, listTree, readWorkspaceFile, searchWorkspace } from "./inspector.ts";
import { loadPlatforms, savePlatforms, readPlatformNumber, readPlatformString } from "./platforms.ts";
import {
  createLibraryMember,
  loadMemberLibrary,
  removeLibraryMember,
  restoreLibraryMember,
  updateLibraryMember,
  type LibraryMemberInput,
} from "./member-library.ts";
import { createRealRoom } from "./real-room.ts";
import { SessionStore } from "./sessions.ts";
import { RoomStore, resolveRoomDataDir } from "./store.ts";
import { createFallbackSummarizer, createRoomSummarizer } from "./summary.ts";
import { computeRoomStats, cacheHitRate, roomSpent } from "./stats.ts";
import {
  archiveTask,
  createTask,
  findTask,
  loadTasks,
  readTaskEvents,
  readTaskReport,
  recoverRunningTasks,
  restoreTask,
  setTaskStatus,
  updateTask,
  type CreateTaskInput,
  type TaskStatus,
} from "./tasks.ts";
import { cleanupTaskWorktrees, discardTask, mergeTask, retryTask, runTask } from "./task-runner.ts";
import { addWorkspace, findWorkspaceByPath, listWorkspaceSummaries, removeWorkspace, renameWorkspace } from "./workspaces.ts";
import type { RoomConfig, RoomEvent, RoomMember, RoomRules, StopReason } from "./types.ts";

const HELP = `AgentHub room CLI

用法:
  room init [--real] [--data-dir <dir>] [--workspace <path>]
  room create --name <名称> [--id <id>] [--workspace <path> | --workspace-id <id> | --no-workspace] [--copy-from <roomId>] [--json]
  room workspace list [--json]
  room workspace add --name <名称> --workspace <path> [--json]
  room workspace rename --id <id> --name <名称> [--json]
  room workspace remove --id <id> [--json]
  room run --prompt "..." [--room real] [--data-dir <dir>] [--autonomy low|medium|high] [--max-handoffs 8] [--image <path> ...] [--fake] [--json-events]
  room run --draft --prompt "..." [--scope <相对路径> ...] [--run-id <id>]
  room draft begin --workspace <path> --workspace-id <id> [--scope <相对路径> ...] [--run-id <id>] [--json]
  room draft list [--workspace-id <id>] [--json]
  room draft show --run-id <id> [--json]
  room draft apply --run-id <id> [--file <相对路径> ...] [--json]
  room draft discard --run-id <id>
  room draft cleanup [--days 7]
  room task create --title <标题> --description <描述> --owner <memberId> --acceptance <验收> [--depends-on <taskId> ...] [--verification <命令>] [--allowed-path <相对路径> ...] [--pin <消息文本> ...] [--budget 2] [--auto-merge] [--reviewer <memberId>] [--json]
  room task list|all [--all] [--json]
  room task archive|restore-archive --task <id>
  room task show [--task <id>] [--json]
  room task update --task <id> [--title ...] [--description ...] [--owner ...] [--acceptance ...] [--depends-on ...] [--verification ...] [--allowed-path ...] [--budget ...] [--auto-merge]
  room task move --task <id> --status ready
  room task run --task <id>
  room task merge|discard|retry|events --task <id> [--force]
  room task recover [--json]
  room task cleanup-worktrees [--force] [--json]
  room delete --room <id> [--force] [--json]
  room member list [--all] [--json]
  room member add --name <名称> [--role <角色>] [--category <分类>] [--avatar <emoji>] [--description <一句话>] --instructions <提示词> [--tag ...] [--skill ...] [--mcp ...] [--json]
  room member update --id <id> [--name ...] [--role ...] [--category ...] [--avatar ...] [--description ...] [--instructions ...] [--tag ...] [--hidden|--visible]
  room member remove --id <id> | room member restore --id <id>
  room inspect tree [--path <相对路径>] [--depth 2] [--json]
  room inspect files [--query <关键字>] [--limit 200] [--json]
  room inspect read --file <相对路径> [--offset 0] [--json]
  room inspect git-status|git-diff [--file <相对路径>] [--staged] [--json]
  room inspect search --query <关键字> [--limit 200] [--json]
  room inspect doctor [--json]
  room graph status|sync [--json]
  room graph query --query <关键字> [--json]
  room graph impact --target <符号或文件> [--json]
  room btw ask --question <问题> [--member <id>] [--json]
  room btw list [--json]
  room btw promote --btw <id>
  room platform add --id <id> --name <名称> --kind cli|openai-compatible|fake [--harness codex] [--base-url ...] [--api-key-env ...] [--sandbox-mode ...] [--timeout 600000] [--disabled]
  room platform update --id <id> [--name ...] [--kind ...] [--harness ...] [--base-url ...] [--api-key-env ...] [--sandbox-mode ...] [--timeout ...] [--enabled|--disabled]
  room platform remove --id <id>
  room list [--json]
  room show [--json] [--room <id>]
  room update --json-file <room.json> [--room <id>]
  room replay [--room <id>] [--json]
  room stats [--room <id>] [--since 7d] [--json]
  room compact [--room <id>] [--json]
  room brief show|set --text "..." [--room <id>] [--json]
  room export --out <dir> [--room <id>]
  room platforms [--json] [--health]
  room models [--json] [--platform <id>]
  room models sync [--data-dir <dir>]
  room capabilities [--json]
  room vision --image <path> [--prompt "..."] [--command modlens] [--json]

说明:
  init         创建假后端演示房间；加 --real 创建三个真实模型的房间。
  create       新建命名房间；工作区可复用已有登记，也可用 --workspace 直接登记该文件夹。
  workspace    管理工作区登记：list / add / rename / remove；remove 不会删除磁盘文件夹。
  draft        沙盒草稿：按工作范围复制原文件，agent 只写草稿目录；应用/丢弃后才落地。
  task         任务：worktree 隔离执行、验证、审查、合并；主工作区不会被 agent 直接写。
  member       全局成员库：内置 12 个角色，可增改、隐藏、恢复；加入房间时复制，不共享模型绑定。
  inspect      只读检查器：文件树、文本/图片预览、git 状态/diff、ripgrep 查找、外部工具检测。
  graph        可选 codegraph：status / query / impact / sync；不可用时降级。
  btw          只读侧问：不打断主对话，可提升为普通用户消息。
  platform     平台新增/更新/移除；密钥仍走环境变量名，不写明文。
  run          默认自动选择后端：成员全是 fake 时用假后端，否则走平台路由。
  run --image  附带图片；只有声明支持图片的模型会收到图片，其他成员只收到附件说明。
  stats        按天、成员、模型聚合 token 与费用；--since 支持 24h、7d、all 或 ISO 日期。
  compact      立即让摘要模型压缩房间上下文，写入 summary.md。
  brief        查看或保存房间简报（目标、结论、约束）；会随下一轮注入所有成员。
  models sync  从 AIWorkGate 的本地目录导入模型能力（需要 Node 24 的 node:sqlite）。
  capabilities 只读扫描本机 Claude skills、Codex/Claude 的 MCP 服务名，供角色卡参考。
  vision       调用本机 ModLens（需自行安装）把图片转成文字证据，结果按图片+提示词缓存；不随应用打包。
`;

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      room: { type: "string", default: "demo" },
      prompt: { type: "string" },
      workspace: { type: "string" },
      "workspace-id": { type: "string" },
      "no-workspace": { type: "boolean", default: false },
      "copy-from": { type: "string" },
      "library-member": { type: "string", multiple: true },
      name: { type: "string" },
      id: { type: "string" },
      role: { type: "string" },
      avatar: { type: "string" },
      category: { type: "string" },
      instructions: { type: "string" },
      tag: { type: "string", multiple: true },
      skill: { type: "string", multiple: true },
      mcp: { type: "string", multiple: true },
      hidden: { type: "boolean", default: false },
      visible: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      model: { type: "string" },
      real: { type: "boolean", default: false },
      fake: { type: "boolean", default: false },
      "json-events": { type: "boolean", default: false },
      autonomy: { type: "string" },
      "max-handoffs": { type: "string" },
      image: { type: "string", multiple: true },
      command: { type: "string" },
      timeout: { type: "string" },
      reason: { type: "string" },
      detail: { type: "string" },
      out: { type: "string" },
      "json-file": { type: "string" },
      platform: { type: "string" },
      health: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      task: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      owner: { type: "string" },
      acceptance: { type: "string" },
      "depends-on": { type: "string", multiple: true },
      verification: { type: "string" },
      "allowed-path": { type: "string", multiple: true },
      pin: { type: "string", multiple: true },
      budget: { type: "string" },
      "auto-merge": { type: "boolean", default: false },
      reviewer: { type: "string" },
      "source-message": { type: "string" },
      status: { type: "string" },
      scope: { type: "string", multiple: true },
      "run-id": { type: "string" },
      draft: { type: "boolean", default: false },
      file: { type: "string", multiple: true },
      offset: { type: "string" },
      "run-id-flag": { type: "boolean", default: false },
      days: { type: "string" },
      path: { type: "string" },
      depth: { type: "string" },
      query: { type: "string" },
      target: { type: "string" },
      staged: { type: "boolean", default: false },
      limit: { type: "string" },
      btw: { type: "string" },
      since: { type: "string" },
      text: { type: "string" },
      question: { type: "string" },
      member: { type: "string" },
      kind: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      harness: { type: "string" },
      "sandbox-mode": { type: "string" },
      "permission-mode": { type: "string" },
      enabled: { type: "boolean", default: false },
      disabled: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = parsed.positionals[0] ?? "help";
  const store = new RoomStore(resolveRoomDataDir(parsed.values["data-dir"]));
  const roomId = parsed.values.room ?? "demo";

  switch (command) {
    case "init": {
      loadPlatforms(store);
      loadModels(store);
      const room = parsed.values.real
        ? createRealRoom(store, parsed.values.workspace ?? process.cwd())
        : createDemoRoom(store, parsed.values.workspace ?? process.cwd());
      process.stdout.write(`房间已就绪: ${store.roomDir(room.id)}\n`);
      return 0;
    }
    case "create": {
      try {
        const models = loadModels(store).filter((model) => model.enabled !== false);
        const knownGood = ["deepseek-v4.1-flash", "glm-5.3-flash", "kimi-k2.6"];
        const preferred = knownGood.map((id) => models.find((model) => model.modelId === id)).find(Boolean)
          ?? models.find((model) => model.platformId === "codex-cli")
          ?? models[0];
        if ((parsed.values.platform && !parsed.values.model) || (!parsed.values.platform && parsed.values.model)) {
          process.stderr.write("--platform 和 --model 必须同时提供。\n");
          return 2;
        }
        const defaultBinding = parsed.values.platform && parsed.values.model
          ? { platformId: parsed.values.platform, modelId: parsed.values.model }
          : preferred
            ? { platformId: preferred.platformId, modelId: preferred.modelId }
            : undefined;
        const room = createRoomFromInput(store, {
          id: parsed.values.id,
          name: parsed.values.name ?? "",
          workspaceId: parsed.values["workspace-id"],
          workspacePath: parsed.values.workspace,
          noWorkspace: parsed.values["no-workspace"] === true,
          copyFromRoomId: parsed.values["copy-from"],
          libraryMemberIds: parsed.values["library-member"],
          defaultBinding,
        });
        if (parsed.values.json) {
          process.stdout.write(`${JSON.stringify(room, null, 2)}\n`);
        } else {
          process.stdout.write(`房间已创建: ${room.id}\t${room.name}\t${room.workspace || "纯聊天"}\n`);
        }
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case "workspace": {
      const sub = parsed.positionals[1] ?? "list";
      try {
        if (sub === "list") {
          const rows = listWorkspaceSummaries(store);
          if (parsed.values.json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          } else if (rows.length === 0) {
            process.stdout.write("没有登记的工作区。\n");
          } else {
            for (const row of rows) {
              process.stdout.write(`${row.id}\t${row.name}\t${row.path}\t${row.roomCount} 个房间\t${row.available ? "" : "目录缺失"}\n`);
            }
          }
          return 0;
        }
        if (sub === "add") {
          const workspace = addWorkspace(store, {
            name: parsed.values.name ?? "",
            path: parsed.values.workspace ?? "",
          });
          process.stdout.write(parsed.values.json ? `${JSON.stringify(workspace, null, 2)}\n` : `工作区已登记: ${workspace.id}\t${workspace.name}\t${workspace.path}\n`);
          return 0;
        }
        if (sub === "rename") {
          const workspace = renameWorkspace(store, parsed.values.id ?? "", parsed.values.name ?? "");
          process.stdout.write(parsed.values.json ? `${JSON.stringify(workspace, null, 2)}\n` : `工作区已重命名: ${workspace.id}\t${workspace.name}\n`);
          return 0;
        }
        if (sub === "remove") {
          const workspace = removeWorkspace(store, parsed.values.id ?? "");
          process.stdout.write(parsed.values.json ? `${JSON.stringify({ removed: workspace.id })}\n` : `工作区已注销: ${workspace.id}\n`);
          return 0;
        }
        process.stderr.write("workspace 子命令必须是 list、add、rename 或 remove。\n");
        return 2;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case "run":
      return runCommand(store, roomId, {
        ...parsed.values,
      });
    case "stats": {
      try {
        const room = store.readRoom(roomId);
        const stats = computeRoomStats(room, store.readEvents(roomId), loadModels(store), {
          since: parsed.values.since,
          tasks: loadTasks(store, roomId),
        });
        if (parsed.values.json) {
          writeJson(stats);
        } else {
          const rate = cacheHitRate(stats.totals);
          process.stdout.write(
            `房间 ${room.name} · ${stats.since}\n`
            + `请求 ${stats.totals.requests}（失败 ${stats.totals.failed}）· 输入 ${stats.totals.inputTokens} · 输出 ${stats.totals.outputTokens}`
            + ` · 缓存 ${stats.totals.cacheReadTokens}${rate === undefined ? "" : `（${(rate * 100).toFixed(1)}%）`}`
            + ` · 合计 ${stats.totals.totalTokens} tok · ¥${stats.totals.costYuan.toFixed(2)}\n`
            + `任务 ${stats.tasks.tasks}（完成 ${stats.tasks.done} / 失败 ${stats.tasks.failed}）· 任务费用 ¥${stats.tasks.costYuan.toFixed(2)}\n`,
          );
          for (const bucket of stats.byModel) {
            process.stdout.write(`  ${bucket.label}\t${bucket.requests} 次\t${bucket.inputTokens}/${bucket.outputTokens} tok\t¥${bucket.costYuan.toFixed(2)}\n`);
          }
        }
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case "compact":
      return await compactCommand(store, roomId, parsed.values);
    case "brief": {
      try {
        const sub = parsed.positionals[1] ?? "show";
        const room = store.readRoom(roomId);
        if (sub === "show") {
          const brief = store.readBrief(roomId);
          if (parsed.values.json) writeJson({ roomId, brief });
          else process.stdout.write(brief);
          return 0;
        }
        if (sub === "set") {
          const text = parsed.values.text ?? "";
          store.writeBrief(roomId, text.endsWith("\n") || !text ? text : `${text}\n`);
          if (parsed.values.json) writeJson({ roomId, saved: true });
          else process.stdout.write(`简报已保存: ${room.name}\n`);
          return 0;
        }
        process.stderr.write("brief 子命令必须是 show 或 set。\n");
        return 2;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case "draft":
      return draftCommand(store, roomId, parsed.values, parsed.positionals[1] ?? "list");
    case "task":
      return await taskCommand(store, roomId, parsed.values, parsed.positionals[1] ?? "list");
    case "member":
      return memberCommand(store, parsed.values, parsed.positionals[1] ?? "list");
    case "inspect":
      return inspectCommand(store, roomId, parsed.values, parsed.positionals[1] ?? "tree");
    case "graph":
      return graphCommand(store, roomId, parsed.values, parsed.positionals[1] ?? "status");
    case "btw":
      return await btwCommand(store, roomId, parsed.values, parsed.positionals[1] ?? "list");
    case "platform":
      return platformCommand(store, parsed.values, parsed.positionals[1] ?? "list");
    case "list": {
      const rooms = store.listRooms();
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(rooms, null, 2)}\n`);
        return 0;
      }
      if (rooms.length === 0) {
        process.stdout.write(`没有房间。数据目录: ${store.dataDir}\n`);
        return 0;
      }
      for (const room of rooms) {
        process.stdout.write(`${room.id}\t${room.name}\t${room.members.length} 个成员\t${room.updatedAt}\n`);
      }
      return 0;
    }
    case "delete": {
      try {
        const target = String(parsed.values.room || "").trim();
        if (!target) throw new Error("缺少 --room <id>。");
        const room = store.readRoom(target);
        const running = loadTasks(store, target).filter((task) => task.status === "running");
        if (running.length > 0 && parsed.values.force !== true) {
          throw new Error(`房间还有 ${running.length} 个运行中的任务；先停止，或加 --force。`);
        }
        const worktrees = cleanupTaskWorktrees(store, target, { force: parsed.values.force === true });
        store.deleteRoom(target);
        if (parsed.values.json) writeJson({ deleted: target, name: room.name, worktrees });
        else process.stdout.write(`房间已删除: ${target}（清理 worktree ${worktrees.removed} 个）\n`);
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case "show": {
      const room = store.readRoom(roomId);
      process.stdout.write(`${JSON.stringify(room, null, 2)}\n`);
      return 0;
    }
    case "update": {
      const filePath = parsed.values["json-file"];
      if (!filePath) {
        process.stderr.write("缺少 --json-file <room.json>。\n");
        return 2;
      }
      const room = JSON.parse(readFileSync(filePath, "utf8")) as RoomConfig;
      if (!room || room.version !== 1 || !Array.isArray(room.members) || room.members.length === 0) {
        process.stderr.write("房间 JSON 必须包含 version 1 和非空 members。\n");
        return 2;
      }
      if (room.id !== roomId) {
        process.stderr.write(`房间 JSON 的 id (${room.id}) 与 --room (${roomId}) 不一致。\n`);
        return 2;
      }
      room.updatedAt = new Date().toISOString();
      store.writeRoom(room);
      process.stdout.write(`房间已更新: ${store.roomDir(room.id)}\n`);
      return 0;
    }
    case "replay": {
      const events = store.readEvents(roomId);
      if (parsed.values.json) {
        for (const event of events) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        return 0;
      }
      replay(events);
      return 0;
    }
    case "export": {
      const out = parsed.values.out;
      if (!out) {
        process.stderr.write("缺少 --out <目录>。\n");
        return 2;
      }
      const target = store.exportRoom(roomId, out);
      process.stdout.write(`已导出到 ${target}\n`);
      return 0;
    }
    case "platforms": {
      const platforms = loadPlatforms(store);
      const health = new HealthChecker();
      const rows = [];
      for (const platform of platforms) {
        const checked = parsed.values.health ? await health.check(platform) : undefined;
        rows.push({ ...platform, health: checked });
      }
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${row.id}\t${row.name}\t${row.kind}\t${row.enabled === false ? "disabled" : "enabled"}\t${row.health?.status ?? ""}\t${row.health?.detail ?? ""}\n`,
          );
        }
      }
      return 0;
    }
    case "models": {
      if (parsed.positionals[1] === "sync") {
        const result = syncModelsFromAiWorkGate(store);
        process.stdout.write(`模型目录已同步: 新增 ${result.added}，跳过 ${result.skipped}，总数 ${result.total}\n`);
        return 0;
      }
      const models = loadModels(store);
      const filtered = parsed.values.platform
        ? models.filter((model) => model.platformId === parsed.values.platform)
        : models;
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
      } else {
        for (const model of filtered) {
          const vision = model.input?.includes("image") ? "vision" : "text";
          process.stdout.write(
            `${model.platformId}\t${model.modelId}\t${model.displayName}\t${model.contextWindow ?? "?"}\t${vision}\t${model.thinkingLevels?.join("/") ?? "-"}\n`,
          );
        }
      }
      return 0;
    }
    case "capabilities": {
      const manifest = scanCapabilities();
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
        return 0;
      }
      const bySource = new Map<string, number>();
      for (const skill of manifest.skills) {
        bySource.set(skill.source, (bySource.get(skill.source) ?? 0) + 1);
      }
      process.stdout.write(
        `技能 ${manifest.skills.length} 个（${[...bySource].map(([source, count]) => `${source} ${count}`).join("，")}），MCP ${manifest.mcpServers.length} 个\n`,
      );
      for (const server of manifest.mcpServers) {
        process.stdout.write(`MCP\t${server.name}\t${server.source}\n`);
      }
      return 0;
    }
    case "vision": {
      const imagePath = parsed.values.image?.[0] ?? parsed.positionals[1];
      if (!imagePath) {
        process.stderr.write("缺少 --image <图片路径>。\n");
        return 2;
      }
      const timeoutMs = parsed.values.timeout ? Number(parsed.values.timeout) : undefined;
      const result = await describeImage({
        imagePath,
        prompt: parsed.values.prompt,
        command: parsed.values.command,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        cacheDir: join(store.profilesDir, "vision-cache"),
      });
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.status === "completed") {
        process.stdout.write(`${result.description}\n`);
      } else {
        process.stderr.write(`${result.error ?? "vision failed"}\n`);
      }
      return result.status === "completed" ? 0 : 1;
    }
    case "mark-stopped": {
      const reason = parsed.values.reason ?? "human_stop";
      const stopReasons = [
        "done",
        "human_mention",
        "autonomy_low",
        "max_handoffs",
        "budget",
        "context_limit",
        "no_eligible_speaker",
        "human_stop",
        "error",
      ];
      if (!stopReasons.includes(reason)) {
        process.stderr.write(`--reason 必须是 ${stopReasons.join(" / ")} 之一。\n`);
        return 2;
      }
      const events = store.readEvents(roomId);
      if (events.at(-1)?.type === "room_stopped") {
        return 0;
      }
      store.appendEvent(roomId, {
        type: "room_stopped",
        reason: reason as StopReason,
        detail: parsed.values.detail,
      });
      return 0;
    }
    case "help":
    default:
      process.stdout.write(HELP);
      return command === "help" ? 0 : 2;
  }
}

interface CliValues {
  json?: boolean;
  prompt?: string;
  image?: string[];
  "json-events"?: boolean;
  autonomy?: string;
  "max-handoffs"?: string;
  fake?: boolean;
  real?: boolean;
  workspace?: string;
  "workspace-id"?: string;
  room?: string;
  task?: string;
  title?: string;
  description?: string;
  owner?: string;
  acceptance?: string;
  "depends-on"?: string[];
  verification?: string;
  "allowed-path"?: string[];
  pin?: string[];
  budget?: string;
  "auto-merge"?: boolean;
  reviewer?: string;
  "source-message"?: string;
  status?: string;
  scope?: string[];
  "run-id"?: string;
  draft?: boolean;
  file?: string[];
  offset?: string;
  days?: string;
  path?: string;
  depth?: string;
  query?: string;
  target?: string;
  staged?: boolean;
  limit?: string;
  btw?: string;
  question?: string;
  member?: string;
  kind?: string;
  name?: string;
  id?: string;
  role?: string;
  avatar?: string;
  category?: string;
  instructions?: string;
  tag?: string[];
  skill?: string[];
  mcp?: string[];
  hidden?: boolean;
  visible?: boolean;
  all?: boolean;
  "library-member"?: string[];
  "base-url"?: string;
  "api-key-env"?: string;
  harness?: string;
  "sandbox-mode"?: string;
  "permission-mode"?: string;
  timeout?: string;
  enabled?: boolean;
  disabled?: boolean;
  force?: boolean;
  [key: string]: unknown;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveWorkspaceId(store: RoomStore, room: RoomConfig): string {
  if (!room.workspace) throw new Error("房间没有绑定工作区。");
  const summaries = listWorkspaceSummaries(store);
  if (room.workspaceId) {
    const existing = summaries.find((workspace) => workspace.id === room.workspaceId);
    if (existing) return existing.id;
  }
  const byPath = findWorkspaceByPath(summaries, room.workspace);
  if (byPath) {
    if (room.workspaceId !== byPath.id) {
      room.workspaceId = byPath.id;
      store.writeRoom(room);
    }
    return byPath.id;
  }
  const workspace = addWorkspace(store, { name: basename(room.workspace) || room.id, path: room.workspace });
  room.workspaceId = workspace.id;
  store.writeRoom(room);
  return workspace.id;
}

function buildRoomBackend(store: RoomStore, room: RoomConfig): ReturnType<typeof createDemoFakeBackend> | RoomBackendRouter {
  const allFake = room.members.every((member) => member.binding.platformId === "fake");
  if (allFake) return createDemoFakeBackend();
  const platforms = loadPlatforms(store);
  const models = loadModels(store);
  return new RoomBackendRouter({
    store,
    roomId: room.id,
    platforms,
    models,
    sessions: new SessionStore(store, room.id),
    health: new HealthChecker(),
    fakeBackend: createDemoFakeBackend(),
  });
}

function draftCommand(store: RoomStore, roomId: string, values: CliValues, sub: string): number {
  try {
    if (sub === "begin") {
      const room = store.readRoom(roomId);
      const workspacePath = values.workspace || room.workspace;
      if (!workspacePath) throw new Error("缺少工作区；纯聊天房间不能创建草稿。");
      const workspaceId = values["workspace-id"] || resolveWorkspaceId(store, { ...room, workspace: workspacePath });
      const draft = createDraft({
        store,
        workspaceId,
        workspacePath,
        roomId,
        runId: values["run-id"],
        scope: values.scope,
      });
      if (values.json) writeJson(draft);
      else process.stdout.write(`草稿已创建: ${draft.runId}\t${draft.draftDir}\n`);
      return 0;
    }
    if (sub === "list") {
      const drafts = listDrafts(store, values["workspace-id"]);
      if (values.json) writeJson(drafts);
      else if (drafts.length === 0) process.stdout.write("没有草稿。\n");
      else for (const draft of drafts) process.stdout.write(`${draft.runId}\t${draft.status}\t${draft.changes.length} 个变化\t${draft.workspacePath}\n`);
      return 0;
    }
    if (sub === "show") {
      if (!values["run-id"]) throw new Error("缺少 --run-id。");
      const draft = refreshDraft(store, values["run-id"]);
      if (values.json) writeJson(draft);
      else {
        process.stdout.write(`草稿 ${draft.runId}（${draft.status}）\n${draft.draftDir}\n`);
        for (const change of draft.changes) process.stdout.write(`  ${change.kind}\t${change.path}\n`);
        if (draft.drift.length) process.stdout.write(`警告：原目录范围文件已变化：${draft.drift.join("、")}\n`);
      }
      return 0;
    }
    if (sub === "apply") {
      if (!values["run-id"]) throw new Error("缺少 --run-id。");
      const result = applyDraft(store, values["run-id"], values.file);
      if (values.json) writeJson(result);
      else {
        process.stdout.write(`已应用 ${result.applied.length} 个文件。\n`);
        for (const path of result.applied) process.stdout.write(`  ${path}\n`);
        if (result.conflicts.length) {
          process.stdout.write("以下冲突已跳过：\n");
          for (const conflict of result.conflicts) process.stdout.write(`  ${conflict.path}：${conflict.reason}\n`);
        }
      }
      return result.conflicts.length > 0 ? 1 : 0;
    }
    if (sub === "discard") {
      if (!values["run-id"]) throw new Error("缺少 --run-id。");
      const draft = discardDraft(store, values["run-id"]);
      process.stdout.write(`草稿已丢弃: ${draft.runId}\n`);
      return 0;
    }
    if (sub === "cleanup") {
      const days = values.days ? Number(values.days) : 7;
      const removed = cleanupDrafts(store, Number.isFinite(days) ? days : 7);
      process.stdout.write(`已清理 ${removed} 个过期草稿。\n`);
      return 0;
    }
    process.stderr.write("draft 子命令必须是 begin、list、show、apply、discard 或 cleanup。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

function memberCommand(store: RoomStore, values: CliValues, sub: string): number {
  try {
    if (sub === "list") {
      const members = loadMemberLibrary(store).filter((member) => values.all === true || !member.hidden);
      if (values.json) writeJson(members);
      else if (members.length === 0) process.stdout.write("成员库为空。\n");
      else {
        for (const member of members) {
          const flags = [
            member.builtin ? "内置" : "自定义",
            member.hidden ? "已隐藏" : "",
            member.edited ? "已编辑" : "",
          ].filter(Boolean).join("/");
          process.stdout.write(`${member.id}\t${member.category}\t${member.name}\t${member.role}\t${flags}\n`);
        }
      }
      return 0;
    }
    if (sub === "add") {
      const member = createLibraryMember(store, {
        name: values.name,
        role: values.role,
        category: values.category,
        avatar: values.avatar,
        description: values.description,
        instructions: values.instructions,
        tags: values.tag,
        skills: values.skill,
        mcps: values.mcp,
      });
      if (values.json) writeJson(member);
      else process.stdout.write(`成员已加入库: ${member.id}\t${member.name}\t${member.category}\n`);
      return 0;
    }
    if (sub === "update") {
      if (!values.id) throw new Error("缺少 --id。");
      const patch: LibraryMemberInput & { hidden?: boolean } = {};
      for (const key of ["name", "role", "category", "avatar", "description", "instructions"] as const) {
        if (values[key] !== undefined) patch[key] = String(values[key]);
      }
      if (values.tag !== undefined) patch.tags = values.tag;
      if (values.skill !== undefined) patch.skills = values.skill;
      if (values.mcp !== undefined) patch.mcps = values.mcp;
      if (values.hidden === true) patch.hidden = true;
      if (values.visible === true) patch.hidden = false;
      const member = updateLibraryMember(store, String(values.id), patch);
      if (values.json) writeJson(member);
      else process.stdout.write(`成员已更新: ${member.id}\t${member.name}\n`);
      return 0;
    }
    if (sub === "hide" || sub === "show") {
      if (!values.id) throw new Error("缺少 --id。");
      const member = updateLibraryMember(store, String(values.id), { hidden: sub === "hide" });
      if (values.json) writeJson(member);
      else process.stdout.write(`成员已${sub === "hide" ? "隐藏" : "显示"}: ${member.id}\n`);
      return 0;
    }
    if (sub === "remove") {
      if (!values.id) throw new Error("缺少 --id。");
      const member = removeLibraryMember(store, String(values.id));
      if (values.json) writeJson({ removed: member.id });
      else process.stdout.write(`成员已从库中删除: ${member.id}\n`);
      return 0;
    }
    if (sub === "restore") {
      if (!values.id) throw new Error("缺少 --id。");
      const member = restoreLibraryMember(store, String(values.id));
      if (values.json) writeJson(member);
      else process.stdout.write(`已恢复内置成员: ${member.id}\n`);
      return 0;
    }
    process.stderr.write("member 子命令必须是 list、add、update、hide、show、remove 或 restore。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

async function taskCommand(store: RoomStore, roomId: string, values: CliValues, sub: string): Promise<number> {
  try {
    if (sub === "create") {
      const input: CreateTaskInput = {
        title: values.title ?? "",
        description: values.description ?? "",
        ownerMemberId: values.owner ?? "",
        acceptance: values.acceptance ?? "",
        dependsOn: values["depends-on"],
        sourceMessageId: values["source-message"],
        verificationCommand: values.verification,
        allowedPaths: values["allowed-path"],
        pinnedMessages: values.pin,
        budgetYuan: values.budget ? Number(values.budget) : undefined,
        autoMerge: values["auto-merge"] === true,
        reviewerMemberId: values.reviewer,
        id: values.id,
      };
      const task = createTask(store, roomId, input);
      if (values.json) writeJson(task);
      else process.stdout.write(`任务已创建: ${task.id}\t${task.title}\t${task.status}\n`);
      return 0;
    }
    if (sub === "all") {
      const rows = [];
      for (const room of store.listRooms()) {
        for (const task of loadTasks(store, room.id)) {
          if (values.all !== true && task.archivedAt) continue;
          rows.push({ ...task, roomId: room.id, roomName: room.name });
        }
      }
      rows.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
      if (values.json) writeJson(rows);
      else if (rows.length === 0) process.stdout.write("没有任务。\n");
      else for (const task of rows) process.stdout.write(`${task.roomId}\t${task.id}\t${task.status}\t${task.title}${task.archivedAt ? "\t已归档" : ""}\n`);
      return 0;
    }
    if (sub === "list") {
      const tasks = loadTasks(store, roomId).filter((task) => values.all === true || !task.archivedAt);
      if (values.json) writeJson(tasks);
      else if (tasks.length === 0) process.stdout.write("没有任务。\n");
      else for (const task of tasks) process.stdout.write(`${task.id}\t${task.status}\t${task.title}\t${task.ownerMemberId}${task.archivedAt ? "\t已归档" : ""}\n`);
      return 0;
    }
    if (sub === "show") {
      if (!values.task) throw new Error("缺少 --task。");
      const tasks = loadTasks(store, roomId);
      const task = tasks.find((item) => item.id === values.task);
      if (!task) throw new Error(`任务 ${values.task} 不存在。`);
      const payload = {
        task,
        report: readTaskReport(store, roomId, task.id),
        events: readTaskEvents(store, roomId, task.id),
      };
      if (values.json) writeJson(payload);
      else {
        process.stdout.write(`${task.id}\t${task.status}\t${task.title}\n`);
        if (payload.report) process.stdout.write(`报告: ${payload.report.summary}\n`);
      }
      return 0;
    }
    if (sub === "update") {
      if (!values.task) throw new Error("缺少 --task。");
      const patch: Record<string, unknown> = {};
      for (const key of ["title", "description", "owner", "acceptance"]) {
        if (values[key] !== undefined) patch[key === "owner" ? "ownerMemberId" : key] = values[key];
      }
      if (values["depends-on"] !== undefined) patch.dependsOn = values["depends-on"];
      if (values.verification !== undefined) patch.verificationCommand = values.verification;
      if (values["allowed-path"] !== undefined) patch.allowedPaths = values["allowed-path"];
      if (values.pin !== undefined) patch.pinnedMessages = values.pin;
      if (values.budget !== undefined) patch.budgetYuan = values.budget === "" ? null : Number(values.budget);
      if (values["auto-merge"] === true) patch.autoMerge = true;
      if (values.reviewer !== undefined) patch.reviewerMemberId = values.reviewer || null;
      const task = updateTask(store, roomId, values.task, patch);
      if (values.json) writeJson(task);
      else process.stdout.write(`任务已更新: ${task.id}\n`);
      return 0;
    }
    if (sub === "move") {
      if (!values.task || !values.status) throw new Error("缺少 --task 或 --status。");
      const task = setTaskStatus(store, roomId, values.task, values.status as TaskStatus);
      if (values.json) writeJson(task);
      else process.stdout.write(`任务状态: ${task.status}\n`);
      return 0;
    }
    if (sub === "run") {
      if (!values.task) throw new Error("缺少 --task。");
      const room = store.readRoom(roomId);
      if (!room.workspace) throw new Error("纯聊天房间不能运行任务。");
      const priorCost = roomSpent(
        store.readEvents(roomId),
        loadTasks(store, roomId).filter((task) => task.id !== values.task),
      ).costYuan;
      if (room.rules.budgetYuan !== undefined && priorCost >= room.rules.budgetYuan) {
        throw new Error(`房间预算已用完（已花费 ¥${priorCost.toFixed(2)} / 预算 ¥${room.rules.budgetYuan.toFixed(2)}）。`);
      }
      const backend = buildRoomBackend(store, room);
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        const result = await runTask({
          store,
          roomId,
          taskId: values.task,
          backend,
          signal: controller.signal,
          roomBudgetYuan: room.rules.budgetYuan,
          priorRoomCostYuan: priorCost,
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
        if (values.json) writeJson(result);
        else process.stdout.write(`任务 ${result.task.id}: ${result.task.status}${result.error ? `（${result.error}）` : ""}\n`);
        return result.task.status === "failed" || result.error ? 1 : 0;
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    }
    if (sub === "merge") {
      if (!values.task) throw new Error("缺少 --task。");
      const result = mergeTask(store, roomId, values.task);
      if (values.json) writeJson(result);
      else process.stdout.write(`合并: ${result.status}${result.detail ? `\n${result.detail}` : ""}\n`);
      return result.status === "merged" ? 0 : 1;
    }
    if (sub === "discard") {
      if (!values.task) throw new Error("缺少 --task。");
      const task = discardTask(store, roomId, values.task, values.force === true);
      if (values.json) writeJson(task);
      else process.stdout.write(`任务已丢弃: ${task.id}\n`);
      return 0;
    }
    if (sub === "retry") {
      if (!values.task) throw new Error("缺少 --task。");
      const task = retryTask(store, roomId, values.task);
      if (values.json) writeJson(task);
      else process.stdout.write(`任务已回到 ready: ${task.id}\n`);
      return 0;
    }
    if (sub === "events") {
      if (!values.task) throw new Error("缺少 --task。");
      const events = readTaskEvents(store, roomId, values.task);
      if (values.json) writeJson(events);
      else for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
      return 0;
    }
    if (sub === "archive" || sub === "restore-archive") {
      if (!values.task) throw new Error("缺少 --task。");
      const task = sub === "archive"
        ? archiveTask(store, roomId, values.task)
        : restoreTask(store, roomId, values.task);
      if (values.json) writeJson(task);
      else process.stdout.write(`任务${sub === "archive" ? "已归档" : "已恢复"}: ${task.id}\n`);
      return 0;
    }
    if (sub === "cleanup-worktrees") {
      const result = cleanupTaskWorktrees(store, roomId, { force: values.force === true });
      if (values.json) writeJson(result);
      else {
        process.stdout.write(`已清理 ${result.removed} 个 worktree，跳过 ${result.skipped} 个`);
        if (result.failed.length > 0) process.stdout.write(`，失败 ${result.failed.length} 个：${result.failed.map((item) => `${item.taskId}（${item.error}）`).join("；")}`);
        process.stdout.write("\n");
      }
      return result.failed.length > 0 ? 1 : 0;
    }
    if (sub === "recover") {
      const recovered = recoverRunningTasks(store, roomId);
      if (values.json) writeJson({ recovered });
      else process.stdout.write(`已恢复 ${recovered} 个中断任务。\n`);
      return 0;
    }
    process.stderr.write("task 子命令必须是 create、list、all、show、update、move、run、merge、discard、retry、events、archive、restore-archive 或 recover。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

function inspectCommand(store: RoomStore, roomId: string, values: CliValues, sub: string): number {
  try {
    if (sub === "doctor") {
      const tools = detectTools();
      if (values.json) writeJson(tools);
      else for (const tool of tools) process.stdout.write(`${tool.available ? "ok" : "missing"}\t${tool.label}${tool.version ? `\t${tool.version}` : ""}\n`);
      return 0;
    }
    const room = store.readRoom(roomId);
    const workspace = values.workspace || room.workspace;
    if (!workspace) throw new Error("房间没有工作区。");
    if (sub === "tree") {
      const depth = values.depth ? Number(values.depth) : 2;
      const entries = listTree(workspace, values.path ?? "", Number.isFinite(depth) ? depth : 2);
      if (values.json) writeJson(entries);
      else for (const entry of entries) process.stdout.write(`${entry.type === "dir" ? "d" : "f"}\t${entry.path}${entry.size !== undefined ? `\t${entry.size}` : ""}\n`);
      return 0;
    }
    if (sub === "files") {
      const matches = listFiles(workspace, values.query ?? "", values.limit ? Number(values.limit) : 200);
      if (values.json) writeJson(matches);
      else for (const match of matches) process.stdout.write(`${match.path}\n`);
      return 0;
    }
    if (sub === "read") {
      const file = values.file?.[0];
      if (!file) throw new Error("缺少 --file。");
      const offset = values.offset ? Number(values.offset) : 0;
      const result = readWorkspaceFile(workspace, file, Number.isFinite(offset) ? offset : 0);
      if (values.json) writeJson(result);
      else if (result.kind === "text") process.stdout.write(result.content ?? "");
      else process.stdout.write(`${result.kind}\t${result.mime ?? ""}\t${result.size} bytes\n`);
      return 0;
    }
    if (sub === "git-status") {
      const result = gitStatus(workspace);
      if (values.json) writeJson(result);
      else process.stdout.write(`${result.branch}${result.clean ? "（干净）" : ""}\n${result.files.map((file) => `${file.status}\t${file.path}`).join("\n")}\n`);
      return 0;
    }
    if (sub === "git-diff") {
      const diff = gitDiff(workspace, { staged: values.staged === true, file: values.file?.[0] });
      if (values.json) writeJson({ diff });
      else process.stdout.write(diff);
      return 0;
    }
    if (sub === "search") {
      if (!values.query) throw new Error("缺少 --query。");
      const limit = values.limit ? Number(values.limit) : 200;
      const result = searchWorkspace(workspace, values.query, Number.isFinite(limit) ? limit : 200);
      if (values.json) writeJson(result);
      else for (const hit of result.hits) process.stdout.write(`${hit.path}:${hit.line}:${hit.column}\t${hit.text}\n`);
      return 0;
    }
    process.stderr.write("inspect 子命令必须是 tree、read、git-status、git-diff、search 或 doctor。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

function graphCommand(store: RoomStore, roomId: string, values: CliValues, sub: string): number {
  try {
    const room = store.readRoom(roomId);
    const workspace = values.workspace || room.workspace;
    if (!workspace) throw new Error("房间没有工作区。");
    if (sub === "status") {
      const result = graphStatus(workspace);
      if (values.json) writeJson(result);
      else process.stdout.write(`${result.available ? "available" : "missing"}\t${result.detail ?? ""}${result.stale ? "\t索引可能过期" : ""}\n`);
      return 0;
    }
    if (sub === "query") {
      if (!values.query) throw new Error("缺少 --query。");
      const result = graphQuery(workspace, values.query);
      if (values.json) writeJson(result);
      else process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (sub === "impact") {
      if (!values.target) throw new Error("缺少 --target。");
      const result = graphImpact(workspace, values.target);
      if (values.json) writeJson(result);
      else process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (sub === "sync") {
      const result = graphSync(workspace);
      if (values.json) writeJson(result);
      else process.stdout.write(`${result.ok ? "ok" : "failed"}${result.timedOut ? "（超时）" : ""}\t${result.detail}\n`);
      return result.ok ? 0 : 1;
    }
    process.stderr.write("graph 子命令必须是 status、query、impact 或 sync。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

async function btwCommand(store: RoomStore, roomId: string, values: CliValues, sub: string): Promise<number> {
  try {
    if (sub === "list") {
      const records = listBtw(store, roomId);
      if (values.json) writeJson(records);
      else for (const record of records) process.stdout.write(`${record.id}\t${record.status}\t${record.memberName}\t${record.question}\n`);
      return 0;
    }
    if (sub === "promote") {
      if (!values.btw) throw new Error("缺少 --btw。");
      const result = promoteBtw(store, roomId, values.btw);
      if (values.json) writeJson(result);
      else process.stdout.write(`已提升为消息: ${result.messageId}\n`);
      return 0;
    }
    if (sub === "ask") {
      if (!values.question) throw new Error("缺少 --question。");
      const room = store.readRoom(roomId);
      const member = values.member ? room.members.find((item) => item.id === values.member) : undefined;
      if (values.member && !member) throw new Error(`成员 ${values.member} 不在房间里。`);
      const record = await askBtw({
        store,
        room,
        backend: buildRoomBackend(store, room),
        question: values.question,
        member,
        contextEvents: store.readEvents(roomId),
      });
      if (values.json) writeJson(record);
      else process.stdout.write(`${record.memberName}: ${record.answer}\n`);
      return 0;
    }
    process.stderr.write("btw 子命令必须是 ask、list 或 promote。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

function platformCommand(store: RoomStore, values: CliValues, sub: string): number {
  try {
    const platforms = loadPlatforms(store);
    if (sub === "list") {
      if (values.json) writeJson(platforms);
      else for (const platform of platforms) process.stdout.write(`${platform.id}\t${platform.name}\t${platform.kind}\t${platform.enabled === false ? "disabled" : "enabled"}\n`);
      return 0;
    }
    if (sub === "add") {
      const id = String(values.id || "").trim();
      const name = String(values.name || "").trim();
      const kind = String(values.kind || "cli").trim();
      if (!id || !name) throw new Error("--id 和 --name 不能为空。");
      if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("平台 id 只能包含字母、数字、点、下划线或短横线。");
      if (platforms.some((platform) => platform.id === id)) throw new Error(`平台 ${id} 已存在。`);
      if (!["cli", "openai-compatible", "fake", "plugin-bridge"].includes(kind)) throw new Error("平台 kind 无效。");
      const config: Record<string, unknown> = {};
      if (values.harness) config.harness = values.harness;
      if (values["base-url"]) config.baseUrl = values["base-url"];
      if (values["api-key-env"]) config.apiKeyEnv = values["api-key-env"];
      if (values["sandbox-mode"] && values["sandbox-mode"] !== "none") config.sandboxMode = values["sandbox-mode"];
      if (values["permission-mode"] && values["permission-mode"] !== "none") config.permissionMode = values["permission-mode"];
      if (values.timeout) config.timeoutMs = Number(values.timeout);
      platforms.push({ id, name, kind: kind as never, enabled: values.disabled !== true, config });
      savePlatforms(store, platforms);
      if (values.json) writeJson({ id });
      else process.stdout.write(`平台已添加: ${id}\n`);
      return 0;
    }
    if (sub === "update") {
      const id = String(values.id || "").trim();
      const platform = platforms.find((item) => item.id === id);
      if (!platform) throw new Error(`平台 ${id} 不存在。`);
      if (values.name) platform.name = String(values.name);
      if (values.kind) platform.kind = String(values.kind) as never;
      platform.config = { ...(platform.config || {}) };
      if (values.harness) platform.config.harness = values.harness;
      if (values["base-url"]) platform.config.baseUrl = values["base-url"];
      if (values["api-key-env"]) platform.config.apiKeyEnv = values["api-key-env"];
      if (values["sandbox-mode"] === "none") delete platform.config.sandboxMode;
      else if (values["sandbox-mode"]) platform.config.sandboxMode = values["sandbox-mode"];
      if (values["permission-mode"] === "none") delete platform.config.permissionMode;
      else if (values["permission-mode"]) platform.config.permissionMode = values["permission-mode"];
      if (values.timeout) platform.config.timeoutMs = Number(values.timeout);
      if (values.enabled === true) platform.enabled = true;
      if (values.disabled === true) platform.enabled = false;
      savePlatforms(store, platforms);
      if (values.json) writeJson(platform);
      else process.stdout.write(`平台已更新: ${platform.id}\n`);
      return 0;
    }
    if (sub === "remove") {
      const id = String(values.id || "").trim();
      if (!platforms.some((platform) => platform.id === id)) throw new Error(`平台 ${id} 不存在。`);
      const referenced = store.listRooms().filter((room) => room.members.some((member) => member.binding.platformId === id));
      if (referenced.length > 0) {
        throw new Error(`平台仍被房间引用：${referenced.map((room) => room.name || room.id).join("、")}`);
      }
      savePlatforms(store, platforms.filter((platform) => platform.id !== id));
      if (values.json) writeJson({ removed: id });
      else process.stdout.write(`平台已移除: ${id}\n`);
      return 0;
    }
    process.stderr.write("platform 子命令必须是 list、add、update 或 remove。\n");
    return 2;
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  }
}

async function runCommand(
  store: RoomStore,
  roomId: string,
  values: CliValues,
): Promise<number> {
  if (!values.prompt?.trim()) {
    process.stderr.write("缺少 --prompt \"...\"。\n");
    return 2;
  }
  const rulesOverride: Partial<RoomRules> = {};
  if (values.autonomy) {
    if (values.autonomy !== "low" && values.autonomy !== "medium" && values.autonomy !== "high") {
      process.stderr.write("--autonomy 只能是 low、medium 或 high。\n");
      return 2;
    }
    rulesOverride.autonomy = values.autonomy;
  }
  if (values["max-handoffs"]) {
    const value = Number(values["max-handoffs"]);
    if (!Number.isInteger(value) || value < 1) {
      process.stderr.write("--max-handoffs 必须是正整数。\n");
      return 2;
    }
    rulesOverride.maxHandoffs = value;
  }

  let room: RoomConfig;
  try {
    room = store.readRoom(roomId);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n先运行 room init --real。\n`);
    return 2;
  }

  if (room.rules.budgetYuan !== undefined) {
    const spent = roomSpent(store.readEvents(roomId), loadTasks(store, roomId)).costYuan;
    const remaining = room.rules.budgetYuan - spent;
    if (remaining <= 0) {
      process.stderr.write(`房间预算已用完（已花费 ¥${spent.toFixed(2)} / 预算 ¥${room.rules.budgetYuan.toFixed(2)}）。\n`);
      return 2;
    }
    rulesOverride.budgetYuan = remaining;
  }

  const platforms = loadPlatforms(store);
  const models = loadModels(store);
  const sessions = new SessionStore(store, roomId);
  const health = new HealthChecker();
  const router = new RoomBackendRouter({
    store,
    roomId,
    platforms,
    models,
    sessions,
    health,
    fakeBackend: createDemoFakeBackend(),
  });
  const allFake = room.members.every((member) => member.binding.platformId === "fake");
  const useFake = values.fake === true || allFake;
  const backend = useFake ? createDemoFakeBackend() : router;
  const summaryMembers = useFake ? [] : buildSummaryMembers(models);
  const summarizer = summaryMembers.length > 0
    ? createFallbackSummarizer(router, summaryMembers)
    : undefined;
  const fileRefMode = (member: RoomMember): "inline" | "path" => {
    const platform = platforms.find((candidate) => candidate.id === member.binding.platformId);
    return platform?.kind === "openai-compatible" ? "inline" : "path";
  };

  let draftInfo: ReturnType<typeof createDraft> | undefined;
  if (values.draft === true) {
    if (!room.workspace) {
      process.stderr.write("纯聊天房间没有工作区，不能创建草稿。\n");
      return 2;
    }
    const workspaceId = resolveWorkspaceId(store, room);
    draftInfo = createDraft({
      store,
      workspaceId,
      workspacePath: room.workspace,
      roomId,
      runId: values["run-id"],
      scope: values.scope,
    });
    process.stderr.write(`草稿目录: ${draftInfo.draftDir}\n`);
  }

  const controller = new AbortController();
  const onSigint = (): void => {
    process.stderr.write("\n收到 Ctrl+C，正在停止房间...\n");
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  const jsonEvents = values["json-events"] === true;
  try {
    const result = await runRoom({
      store,
      roomId,
      prompt: values.prompt,
      images: values.image,
      backend,
      rulesOverride,
      signal: controller.signal,
      summarizer,
      cwdOverride: draftInfo ? workDirOf(draftInfo.draftDir) : undefined,
      writeMode: Boolean(draftInfo),
      draftMode: Boolean(draftInfo),
      fileRefMode,
      onEvent: (event) => {
        if (jsonEvents) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } else {
          prettyEvent(event);
        }
      },
    });
    if (draftInfo) {
      const refreshed = refreshDraft(store, draftInfo.runId);
      const draftEvent = store.appendEvent(roomId, {
        type: "draft_created",
        draftId: refreshed.runId,
        workspaceId: refreshed.workspaceId,
        changes: refreshed.changes.map((change) => ({ path: change.path, kind: change.kind })),
        drift: refreshed.drift,
        draftDir: refreshed.draftDir,
      });
      if (jsonEvents) {
        process.stdout.write(`${JSON.stringify(draftEvent)}\n`);
      } else {
        const counts = refreshed.changes.reduce<Record<string, number>>((acc, change) => {
          acc[change.kind] = (acc[change.kind] ?? 0) + 1;
          return acc;
        }, {});
        process.stdout.write(
          `\n草稿 ${refreshed.runId}: ${counts.added ?? 0} 新增 / ${counts.modified ?? 0} 修改 / ${counts.deleted ?? 0} 删除`
          + `${refreshed.drift.length ? `；警告：原目录有 ${refreshed.drift.length} 个范围文件在运行期间变化` : ""}\n`
          + `应用: room draft apply --run-id ${refreshed.runId}\n`,
        );
      }
    }
    if (!jsonEvents) {
      process.stdout.write(
        `\n状态: ${result.status}，停止原因: ${result.stopReason}，agent 回合: ${result.agentTurns}，费用: ¥${result.costYuan.toFixed(2)}\n`,
      );
      process.stdout.write(`事件日志: ${store.roomDir(roomId)}/events.jsonl\n`);
    }
    return result.status === "failed" ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function compactCommand(store: RoomStore, roomId: string, values: CliValues): Promise<number> {
  try {
    const room = store.readRoom(roomId);
    const platforms = loadPlatforms(store);
    const models = loadModels(store);
    const sessions = new SessionStore(store, roomId);
    const health = new HealthChecker();
    const router = new RoomBackendRouter({
      store,
      roomId,
      platforms,
      models,
      sessions,
      health,
      fakeBackend: createDemoFakeBackend(),
    });
    const summaryMembers = buildSummaryMembers(models);
    if (summaryMembers.length === 0) {
      process.stderr.write("没有可用于压缩上下文的模型（先在设置里启用至少一个模型）。\n");
      return 1;
    }
    const events = store.readEvents(roomId);
    let summary;
    let lastError = "";
    for (const summaryMember of summaryMembers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      try {
        summary = await createRoomSummarizer(router, summaryMember, { signal: controller.signal })({
          room,
          events,
          member: summaryMember,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (summary?.summary.trim()) break;
      lastError = lastError || `${summaryMember.binding.platformId}/${summaryMember.binding.modelId} 没有返回摘要`;
      summary = undefined;
    }
    if (!summary?.summary.trim()) {
      process.stderr.write(`压缩失败：${lastError || "所有候选模型都没有返回摘要。"}\n`);
      return 1;
    }
    store.writeSummary(roomId, `${summary.summary.trim()}\n`);
    const event = store.appendEvent(roomId, {
      type: "summary_updated",
      path: "summary.md",
      coveredEventId: summary.coveredEventId,
    });
    if (values.json) {
      writeJson({ status: "success", summary: summary.summary.trim(), event });
    } else {
      process.stdout.write(`上下文已压缩（${summary.summary.length} 字），事件 ${event.id}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function buildSummaryMembers(models: ReturnType<typeof loadModels>): RoomMember[] {
  const usable = models.filter((model) => model.enabled !== false && model.platformId !== "fake");
  const ordered: typeof usable = [];
  for (const modelId of ["glm-5.3-flash", "deepseek-v4.1-flash", "kimi-k2.6"]) {
    const match = usable.find((model) => model.modelId === modelId);
    if (match && !ordered.includes(match)) ordered.push(match);
  }
  for (const model of usable) {
    if (!ordered.includes(model)) ordered.push(model);
  }
  return ordered.slice(0, 3).map((model) => ({
    id: "__summarizer__",
    name: "摘要器",
    role: "摘要",
    instructions: "压缩房间记录，保留目标、结论、未决问题和约束。",
    binding: {
      platformId: model.platformId,
      modelId: model.modelId,
      thinking: model.defaultThinking,
      contextWindow: model.contextWindow,
      contextBudget: model.contextWindow ? Math.floor(model.contextWindow * 0.7) : undefined,
    },
    behavior: { weight: 0 },
  }));
}

function prettyEvent(event: RoomEvent): void {
  switch (event.type) {
    case "user_message":
      process.stdout.write(`\n你: ${event.text}\n`);
      break;
    case "turn_started":
      process.stdout.write(`\n── ${event.memberName} · ${event.platformId}/${event.modelId} ──\n`);
      break;
    case "agent_delta":
      process.stdout.write(event.text);
      break;
    case "agent_message":
      process.stdout.write("\n");
      break;
    case "handoff":
      process.stdout.write(`  ↪ ${event.fromMemberId} → ${event.toMemberId}（${event.reason}）\n`);
      break;
    case "binding_used":
      process.stdout.write(
        `  ⚠ 模型切换: ${event.requested.platformId}/${event.requested.modelId} → ${event.used.platformId}/${event.used.modelId}\n`,
      );
      break;
    case "summary_updated":
      process.stdout.write(`  [摘要已更新] ${event.path}\n`);
      break;
    case "room_stopped":
      process.stdout.write(`\n[停止] ${event.reason}${event.detail ? `：${event.detail}` : ""}\n`);
      break;
    case "error":
      process.stderr.write(`\n[错误] ${event.message}\n`);
      break;
    default:
      break;
  }
}

function replay(events: RoomEvent[]): void {
  for (const event of events) {
    const time = new Date(event.ts).toLocaleTimeString("zh-CN", { hour12: false });
    switch (event.type) {
      case "user_message":
        process.stdout.write(`[${time}] 你: ${event.text}\n`);
        break;
      case "agent_message":
        process.stdout.write(`[${time}] ${event.memberName}: ${event.text}\n`);
        break;
      case "handoff":
        process.stdout.write(`[${time}]   ↪ ${event.fromMemberId} → ${event.toMemberId}（${event.reason}）\n`);
        break;
      case "binding_used":
        process.stdout.write(`[${time}]   ⚠ 模型切换 ${event.used.platformId}/${event.used.modelId}\n`);
        break;
      case "summary_updated":
        process.stdout.write(`[${time}]   [摘要已更新]\n`);
        break;
      case "room_stopped":
        process.stdout.write(`[${time}] [停止] ${event.reason}${event.detail ? `：${event.detail}` : ""}\n`);
        break;
      case "error":
        process.stdout.write(`[${time}] [错误] ${event.message}\n`);
        break;
      default:
        break;
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
