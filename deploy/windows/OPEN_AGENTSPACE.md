# 如何在 Windows 打开 AgentSpace

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

优先尝试生成 unpacked exe：

```powershell
npm run desktop:dir
```

成功后打开：

```text
dist-electron-out\win-unpacked\AgentSpace.exe
```

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
