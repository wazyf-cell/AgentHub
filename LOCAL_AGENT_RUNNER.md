# AgentSpace Local Agent Runner

这是 AgentSpace 的轻量本地模式入口，目标是先支持单人本机多 agent、多 provider 编排，不依赖 PostgreSQL、workspace、登录系统或团队协作 UI。

## 当前能力

- 读取本地 `agentspace.local.json`。
- 按配置顺序运行多个 agent。
- 每个 agent 可绑定不同 harness/provider：`codex`、`claude`、`opencode`、`openclaw`、`hermes`。
- 前一个 agent 的输出会作为后一个 agent 的上下文。
- 运行结果写入 `.agentspace/runs/*.json`。

## 快速开始

### 双击方式

在资源管理器里双击：

```text
deploy\windows\AgentSpaceLocal.cmd
```

然后按窗口提示选择：

- `1`：初始化本地 agent 配置；
- `2`：检测本机 provider CLI；
- `3`：输入任务并运行多 agent。

这是当前最适合不熟悉终端操作的入口。

### PowerShell 方式

```powershell
cd F:\Code\Traecncode\Program\program14-AgentHub\.worktrees\agentspace-orchestration-p0
npm run local:agents:init
npm run local:agents:detect
npm run local:agents -- run "分析这个项目下一步应该怎么做"
```

如果要从示例复制：

```powershell
Copy-Item agentspace.local.example.json agentspace.local.json
```

## 只运行部分 agent

```powershell
npm run local:agents -- run --agents planner,reviewer "审查当前变更"
```

## 选择任务模式

默认是 `auto`，会根据任务文本判断模式。

```powershell
npm run local:agents -- run --mode smoke-test "测试一下模型，说一下你好"
npm run local:agents -- run --mode analysis "分析这个项目下一步计划"
npm run local:agents -- run --mode development "修复本地 runner 的 prompt 问题"
```

模式含义：

- `smoke-test`：只验证模型和链路是否正常，不强制 planner/implementer/reviewer 套开发流程。
- `analysis`：做分析、报告、建议。
- `development`：做计划、实现、审查，适合代码修改任务。

## JSON events

```powershell
npm run local:agents -- run --json-events "分析当前项目"
```

这会输出结构化事件，后续可以直接接到 Electron local mode 页面。

## 能不能做成 exe

可以，已经新增轻量 Electron local mode。它不启动 Next.js，不访问 PostgreSQL，只调用本地 `agent-space-local`。

开发态打开 GUI：

```powershell
npm run desktop:local:dev
```

或者双击：

```text
deploy\windows\AgentSpaceLocalDesktop.cmd
```

生成 unpacked exe 目录：

```powershell
npm run desktop:local:dir
```

当前可靠产物：

```text
dist-electron-local-out\win-unpacked\AgentSpaceLocal.exe
```

注意：这个 exe 需要和 `win-unpacked` 目录里的 DLL、resources 放在一起运行，不要只单独拷贝 `AgentSpaceLocal.exe`。

备用：尝试生成 portable exe：

```powershell
npm run desktop:local:build
```

portable 产物位置：

```text
dist-electron-local-out\AgentSpaceLocal.exe
```

如果 portable 打包卡住，先使用 `desktop:local:dir` 生成的 `win-unpacked\AgentSpaceLocal.exe`。

不建议现在直接把完整 AgentSpace Web 平台打成单人版 exe，因为现有桌面入口默认走团队平台，会重新带回 PostgreSQL、workspace 和首页白屏等问题。

## 当前限制

- 现在是顺序执行，不是并行 DAG。
- 现在不自动改代码权限；实际能力取决于 provider CLI 自身权限。
- 现在不做数据库持久化，只写本地 JSON artifact。
- provider CLI 必须已经安装并登录，例如 `codex`、`claude`。
- Windows 下 `.cmd/.bat/.ps1` provider shim 已通过源码层 helper 处理，但仍需要本机 PATH 配置正确。

## 后续方向

1. 支持并行 fan-out / fan-in。
2. 支持本地任务模板，例如 plan -> implement -> review -> summarize。
3. 增加 local Electron 页面 `/local`。
4. 增加 provider 登录态 health 检查。
5. 后续再把本地 runner 接回团队 workspace 编排平台。
