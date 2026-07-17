param(
  [ValidateSet("dev", "start")]
  [string]$Mode = "dev",
  [string]$Hostname = "0.0.0.0",
  [int]$Port = 1455,
  [switch]$Install,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

function Write-LauncherStep {
  param([string]$Message)
  Write-Host "[AgentSpace] $Message"
}

function Resolve-RequiredCommand {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }
  throw "Required command not found: $($Names -join ' or '). Install Node.js 22+ and make sure npm is on PATH."
}

function Wait-ForHttpEndpoint {
  param(
    [string]$Url,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 800
    }
  }
  return $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$webNodeModules = Join-Path $repoRoot "apps\web\node_modules"
$nextBuildDir = Join-Path $repoRoot "apps\web\.next"
$logDir = Join-Path $repoRoot ".tmp\launcher"
$preflightScript = Join-Path $scriptDir "Test-AgentSpaceRuntime.ps1"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$npm = Resolve-RequiredCommand @("npm.cmd", "npm")

Write-LauncherStep "Repository: $repoRoot"
Write-LauncherStep "Mode: $Mode"

if ($Install -or -not (Test-Path $webNodeModules)) {
  Write-LauncherStep "Installing dependencies with npm run setup..."
  & $npm --prefix $repoRoot run setup
  if ($LASTEXITCODE -ne 0) {
    throw "npm run setup failed with exit code $LASTEXITCODE."
  }
}

if ($Mode -eq "start" -and -not (Test-Path $nextBuildDir)) {
  Write-LauncherStep "Production build is missing. Building apps/web first..."
  & $npm --prefix (Join-Path $repoRoot "apps\web") run build
  if ($LASTEXITCODE -ne 0) {
    throw "apps/web build failed with exit code $LASTEXITCODE."
  }
}

if (Test-Path $preflightScript) {
  Write-LauncherStep "Running runtime preflight..."
  & $preflightScript -Mode $Mode -RepoRoot $repoRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Runtime preflight failed with exit code $LASTEXITCODE."
  }
}

$stdoutLog = Join-Path $logDir "web.stdout.log"
$stderrLog = Join-Path $logDir "web.stderr.log"
$browserHost = if ($Hostname -eq "0.0.0.0") { "127.0.0.1" } else { $Hostname }
$url = "http://$browserHost`:$Port"

$webArgs = if ($Mode -eq "dev") {
  @("--prefix", "apps/web", "run", "dev", "--", "--hostname", $Hostname, "--port", "$Port")
} else {
  @("--prefix", "apps/web", "run", "start", "--", "--hostname", $Hostname, "--port", "$Port")
}

Write-LauncherStep "Starting web server..."
Write-LauncherStep "Logs: $stdoutLog"
Write-LauncherStep "Errors: $stderrLog"

$webProcess = Start-Process `
  -FilePath $npm `
  -ArgumentList $webArgs `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

try {
  $ready = Wait-ForHttpEndpoint -Url $url -TimeoutSeconds 60
  if ($ready) {
    Write-LauncherStep "AgentSpace is available at $url"
    if (-not $NoBrowser) {
      Start-Process $url | Out-Null
    }
  } else {
    Write-LauncherStep "Server did not become ready within 60 seconds. Check logs before closing this window."
  }

  Write-LauncherStep "Press Ctrl+C to stop this launcher. Web server PID: $($webProcess.Id)"
  Wait-Process -Id $webProcess.Id
} finally {
  if (-not $webProcess.HasExited) {
    Stop-Process -Id $webProcess.Id -Force
  }
}
