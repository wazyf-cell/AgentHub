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

## 启动前检查

可以先运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1
```

如果要检查桌面 exe 构建条件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1 -Mode start -Desktop
```

## 构建 exe

先安装 root 依赖：

```powershell
npm install --no-audit --no-fund
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
- `.env` 缺失会产生 warning；如果需要本地密钥或数据库配置，从 `.env.example` 复制一份 `.env` 后填写。
- PostgreSQL URL 缺失会产生 warning；如果要使用 PostgreSQL，配置 `AGENT_SPACE_PG_URL` 或 `DATABASE_URL`。
- 多 agent runtime / daemon 的完整一键启动还没并入桌面壳，后续 P5 继续完善。

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
