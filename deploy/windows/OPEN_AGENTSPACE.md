# 如何在 Windows 打开 AgentSpace

## 优先推荐：单人本地轻量模式

如果你当前只想单人本地运行多 agent、多 provider，不想启动 PostgreSQL、团队 workspace 或完整 Web 平台，优先双击：

```text
deploy\windows\AgentSpaceLocal.cmd
```

如果你想打开图形界面版的本地轻量模式，双击：

```text
deploy\windows\AgentSpaceLocalDesktop.cmd
```

或者打包本地轻量 exe：

```powershell
npm run desktop:local:dir
```

然后打开：

```text
dist-electron-local-out\win-unpacked\AgentSpaceLocal.exe
```

注意：不要只单独复制这个 exe；它需要和 `win-unpacked` 目录里的 DLL、resources 一起使用。

它会进入交互菜单：

- 初始化 `agentspace.local.json`
- 检测 `codex` / `claude` 等 provider CLI
- 输入任务并运行本地多 Agent

运行结果会写入：

```text
.agentspace\runs\*.json
```

当前最稳定的本机打开方式是使用 P5-A 的 Windows 启动器。真正的 `AgentSpace.exe` 桌面包已经有构建入口，但当前环境在下载 Electron/GitHub 打包二进制时超时，所以 exe 还没有成功产出。

## 方式一：双击启动 Web 版

双击这个文件：

```text
deploy\windows\AgentSpace.cmd
```

它会启动 `apps/web`，默认访问：

```text
http://127.0.0.1:1455
```

如果浏览器没有自动打开，手动打开上面的地址。

## 方式二：PowerShell 启动

在项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1
```

首次运行或依赖缺失时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1 -Install
```

只启动服务、不自动打开浏览器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1 -NoBrowser
```

如果不想写 `.env`，也可以临时传入数据库 URL：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1 -DatabaseUrl "postgres://agent_space:agent_space@127.0.0.1:5432/agent_space"
```

可选：启动 Web 前先启动本机 daemon：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1 -StartDaemon
```

如果 daemon 启动失败，启动器会显示 warning，但不会阻止 Web 界面打开。

## 启动前检查

可以先运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1
```

它会检查 Node/npm、依赖、`.env`、PostgreSQL URL、provider CLI、daemon pid 和 daemon log。

如果 PostgreSQL URL 缺失或 PostgreSQL 端口不可连接，启动器会直接失败。这是预期行为，因为 AgentSpace 首页会立即访问数据库。

## 本地 PostgreSQL 初始化

### 方案 A：Docker Desktop

在项目根目录运行：

```powershell
docker compose -f deploy\postgres\docker-compose.yml up -d
Copy-Item .env.example .env
npm run db:pg:init
```

`.env.example` 默认使用：

```text
SELF_HOSTED_DATABASE_URL=postgres://agent_space:agent_space@127.0.0.1:5432/agent_space
```

这和 `deploy/postgres/docker-compose.yml` 里的默认账号一致。

### 方案 B：已有本机 PostgreSQL

创建数据库和用户后，在项目根目录新建 `.env`，至少写入：

```text
AGENT_SPACE_DEPLOYMENT_MODE=self_hosted
SELF_HOSTED_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/<database>
SELF_HOSTED_DATABASE_DIRECT_URL=postgres://<user>:<password>@127.0.0.1:5432/<database>
```

然后初始化 schema：

```powershell
npm run db:pg:init
```

如果要检查桌面 exe 构建条件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1 -Mode start -Desktop
```

## 构建 exe

先确保 PostgreSQL 配置和 Web production build 可用，然后安装 root 依赖：

```powershell
npm install --no-audit --no-fund
npm run setup
```

确认项目根目录存在 `.env`，并且 PostgreSQL 能连接：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1 -Mode start -Desktop
```

Electron 本地打包会把当前 `.env` 一起放进 `resources\app`，用于桌面版读取数据库配置。后续如果要公开分发安装包，不建议把真实密钥直接打包进去，应改成首次启动配置或外置 `.env`。

优先尝试生成 unpacked exe：

```powershell
npm run desktop:dir
```

成功后打开：

```text
dist-electron-out\win-unpacked\AgentSpace.exe
```

如果桌面版白屏，先看日志：

```powershell
Get-Content -Tail 120 "$env:APPDATA\AgentSpace\agent-space-desktop.log"
```

常见原因：

- `resources\app\.env` 不存在；
- `.env` 里的 PostgreSQL URL 无法连接；
- `AGENT_SPACE_APP_URL` 端口和桌面实际端口不一致。

再尝试生成单文件 portable exe：

```powershell
npm run desktop:build
```

成功后打开：

```text
dist-electron-out\AgentSpace.exe
```

## 当前已知限制

- 当前环境 Electron 二进制/打包辅助文件下载超时，暂时还没有生成新的 `AgentSpace.exe`。
- `.cmd/.ps1` Web 启动器已经可用，是目前最快试用路径。
- 默认端口是 `1455`；如果端口被占用，启动器会直接报错。可以用 `-Port 1456` 等参数换端口。
- `.env` 或 `-DatabaseUrl` 必须提供 PostgreSQL URL，否则 Web 首页会报 `PostgreSQL database URL is required`。
- PostgreSQL 服务必须已启动并可连接，否则 Web 首页无法读取数据。
- 多 agent runtime / daemon 的完整一键启动还没并入桌面壳，后续 P5 继续完善。
- `-StartDaemon` 只是可选启动 native daemon，不会自动配置 provider CLI、模型密钥或 PostgreSQL。

## 日志位置

Web 启动器日志：

```text
.tmp\launcher\web.stdout.log
.tmp\launcher\web.stderr.log
```

Electron 桌面壳日志在 Electron userData 目录下：

```text
agent-space-desktop.log
```
