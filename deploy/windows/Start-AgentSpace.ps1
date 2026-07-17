param(
  [ValidateSet("dev", "start")]
  [string]$Mode = "dev",
  [string]$Hostname = "0.0.0.0",
  [int]$Port = 1455,
  [switch]$Install,
  [switch]$NoBrowser,
  [string]$DatabaseUrl = "",
  [switch]$StartDaemon,
  [ValidateSet("local", "remote")]
  [string]$DaemonMode = "local",
  [string]$DaemonId = "",
  [string]$DeviceName = "",
  [string]$RuntimeName = "",
  [string]$ServerUrl = "",
  [string]$DaemonToken = ""
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

function Test-TcpPortAvailable {
  param(
    [string]$ListenHostname,
    [int]$ListenPort
  )

  $parsedAddress = [System.Net.IPAddress]::Any
  $address = if ($ListenHostname -eq "0.0.0.0") {
    [System.Net.IPAddress]::Any
  } elseif ($ListenHostname -eq "localhost") {
    [System.Net.IPAddress]::Loopback
  } elseif ([System.Net.IPAddress]::TryParse($ListenHostname, [ref]$parsedAddress)) {
    $parsedAddress
  } else {
    [System.Net.IPAddress]::Any
  }

  $listener = [System.Net.Sockets.TcpListener]::new($address, $ListenPort)
  try {
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    $listener.Stop()
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$webNodeModules = Join-Path $repoRoot "apps\web\node_modules"
$nextBuildDir = Join-Path $repoRoot "apps\web\.next"
$logDir = Join-Path $repoRoot ".tmp\launcher"
$preflightScript = Join-Path $scriptDir "Test-AgentSpaceRuntime.ps1"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$npm = Resolve-RequiredCommand @("npm.cmd", "npm")
$node = Resolve-RequiredCommand @("node.exe", "node")

Write-LauncherStep "Repository: $repoRoot"
Write-LauncherStep "Mode: $Mode"

if ($DatabaseUrl.Trim()) {
  $env:AGENT_SPACE_DEPLOYMENT_MODE = "self_hosted"
  $env:SELF_HOSTED_DATABASE_URL = $DatabaseUrl.Trim()
  $env:SELF_HOSTED_DATABASE_DIRECT_URL = $DatabaseUrl.Trim()
}

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
  & $preflightScript -Mode $Mode -RepoRoot $repoRoot -DatabaseUrl $DatabaseUrl
  if ($LASTEXITCODE -ne 0) {
    throw "Runtime preflight failed with exit code $LASTEXITCODE."
  }
}

if ($StartDaemon) {
  $cliEntry = Join-Path $repoRoot "apps\cli\src\index.ts"
  $daemonArgs = @("--experimental-strip-types", $cliEntry, "daemon", "start", "--mode", $DaemonMode)

  if ($DaemonId.Trim()) {
    $daemonArgs += @("--daemon-id", $DaemonId.Trim())
  }
  if ($DeviceName.Trim()) {
    $daemonArgs += @("--device-name", $DeviceName.Trim())
  }
  if ($RuntimeName.Trim()) {
    $daemonArgs += @("--runtime-name", $RuntimeName.Trim())
  }
  if ($ServerUrl.Trim()) {
    $daemonArgs += @("--server-url", $ServerUrl.Trim())
  }
  if ($DaemonToken.Trim()) {
    $daemonArgs += @("--daemon-token", $DaemonToken.Trim())
  }

  Write-LauncherStep "Starting native daemon ($DaemonMode)..."
  & $node @daemonArgs
  if ($LASTEXITCODE -ne 0) {
    Write-LauncherStep "Daemon start returned exit code $LASTEXITCODE. Continuing with web startup."
  }
}

$stdoutLog = Join-Path $logDir "web.stdout.log"
$stderrLog = Join-Path $logDir "web.stderr.log"
$browserHost = if ($Hostname -eq "0.0.0.0") { "127.0.0.1" } else { $Hostname }
$url = "http://$browserHost`:$Port"

if (-not (Test-TcpPortAvailable -ListenHostname $Hostname -ListenPort $Port)) {
  throw "Port $Port is already in use on $Hostname. Stop the existing process or start AgentSpace with -Port <another-port>."
}

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
