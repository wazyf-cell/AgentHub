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

## Next step

P5-B should wrap this launcher into a Windows `.exe` or desktop shell.
