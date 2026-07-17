# AgentSpace Windows launcher

This is the P5-A minimal local launcher. It is not a packaged `.exe` yet.

## Start in development mode

Double-click:

```text
deploy\windows\AgentSpace.cmd
```

Or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1
```

The launcher starts `apps/web` on:

```text
http://127.0.0.1:1455
```

## First run / dependency install

If dependencies are missing, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1 -Install
```

## Production mode

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Start-AgentSpace.ps1 -Mode start
```

If `.next` is missing, the launcher runs `apps/web` build first.

## Logs

Logs are written to:

```text
.tmp\launcher\web.stdout.log
.tmp\launcher\web.stderr.log
```

## Runtime preflight

The launcher runs a lightweight runtime preflight before starting the web server. You can also run it directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1
```

For desktop packaging checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\Test-AgentSpaceRuntime.ps1 -Mode start -Desktop
```

## Desktop executable path

P5-B adds an Electron desktop shell and package scripts:

```powershell
npm install --no-audit --no-fund
npm run desktop:build
```

The expected portable executable output is:

```text
dist-electron-out\AgentSpace.exe
```

If portable packaging is blocked by network downloads, build the unpacked desktop app first:

```powershell
npm run desktop:dir
```

The expected unpacked executable output is:

```text
dist-electron-out\win-unpacked\AgentSpace.exe
```

This requires root `electron` and `electron-builder` dependencies to be installed. The `.cmd` launcher above remains the lightweight fallback when the desktop package is not built yet.
