# 当前分支变更总结

> 分支: `agentspace-orchestration-p0`  
> 基于: `33a03e6 feat: add windows local launcher`  
> 生成时间: 2026-07-01

---

## 一、你的真实需求 vs AgentSpace 的定位

读完 README 后发现一个关键错位：

| 你想要的是 | AgentSpace 做的是 |
|---|---|
| **单人**使用，无服务器 | **团队**协作平台，需要 PostgreSQL + Web Server + Daemon |
| 本地多 agent、多 provider | 组织级多租户 workspace、审批流、权限、审计 |
| 轻量 CLI / 本地工具 | 完整的 Next.js Web + CLI + Daemon + DB 架构 |

AgentSpace 是一个**团队协作平台**，不是个人用的轻量 agent runner。它的核心能力（调度、能力共享、多 Agent 协作、治理）全都建立在 PostgreSQL + Web Server 基础设施之上。

如果你只需要**单人本地多 agent 多 provider**，`agent-router` CLI 可能是你真正需要的部分——它是 AgentSpace 的 provider harness 归一化层，可以独立使用：

```bash
agent-router harnesses        # 列出可用的 harness
agent-router run --harness claude --cwd /project "summarize this repo"
agent-router run --harness codex --cwd /project --model gpt-5.1 "fix tests"
```

---

## 二、本分支文件变更清单

### 2.1 新增文件

| 文件 | 说明 |
|------|------|
| `packages/daemon/src/process-launch.ts` | Windows 兼容：判断可执行文件是否为 .cmd/.bat/.ps1，决定是否用 shell 模式启动子进程 |
| `ORCHESTRATION_P0_IMPLEMENTATION_PLAN.md` | P0-A 实施计划：修复队列 claim/attempt 原子性 + 引入 ExecutionBinding |
| `reasonix.toml` | Reasonix AI 编码助手的项目配置 |
| `.tmp/` | 启动器日志临时目录（Start-AgentSpace.ps1 产生） |
| `dist-electron-out/` | Electron 桌面打包输出 |

### 2.2 修改文件

| 文件 | 变更内容 |
|------|----------|
| `packages/daemon/src/agent-router/adapters/versions.ts` | `spawn()` 调用增加 `shell` 参数，Windows 下 .cmd/.bat 可执行文件走 shell 启动 |
| `packages/daemon/src/agent-router/subprocess.ts` | 同上 |
| `packages/daemon/src/runtime-apps.ts` | 3 处 `spawn()` / `spawnSync()` 调用增加 `shell` 参数 |
| `package.json` | `files` 字段增加 `deploy/install-remote-daemon.sh`（打包包含该脚本） |
| `apps/web/next-env.d.ts` | routes.d.ts 路径从 `.next/types/` 改为 `.next/dev/types/`（Next.js dev 模式适配） |
| `packages/daemon/bin/*.js` | 上述 TS 源码的编译产物（3 个 .js 文件） |
| 各 `package-lock.json` | 依赖锁文件自动更新（5 个文件，非人工修改） |

### 2.3 变更意图

核心变更是 **`process-launch.ts` + 3 个调用点的 `shell` 参数**：

在 Windows 上通过 Node.js `child_process.spawn()` 启动 `.cmd` / `.bat` / `.ps1` 可执行文件时，如果不设置 `shell: true`，Windows 无法直接执行这些文件类型，会导致 `ENOENT` 或启动失败。这个修复让 daemon 在 Windows 上能正确启动 provider CLI（如 `codex.cmd`、`claude.cmd` 等）。

其余文件变更是附带的（lockfile 更新、Next.js dev 路径适配、打包配置）。

---

## 三、关于启动失败

你运行 `Start-AgentSpace.ps1` 时端口 1455 报错，原因有两个：

1. **Windows 端口排除范围**：`netsh int ipv4 show excludedportrange` 显示 **1373-1572** 被系统保留（通常是 Hyper-V / WSL 导致），1455 刚好在范围内
2. **PowerShell 执行策略**：你的电脑禁止运行 .ps1 脚本

绕过方式：直接用 npm 启动，换一个端口（如 3000）：

```bash
npm --prefix apps/web run dev -- --hostname 127.0.0.1 --port 3000
```

---

## 四、建议

如果你的目标是**单人本地多 agent 多 provider**，有两个方向：

1. **只用 `agent-router` CLI**（轻量）— 独立使用，不需要 PostgreSQL、Web Server、daemon
2. **接受完整 AgentSpace**（重量）— 需要启动 PostgreSQL + Web + Daemon 全套基础设施

请告诉我你倾向于哪个方向，我可以帮你进一步配置。
