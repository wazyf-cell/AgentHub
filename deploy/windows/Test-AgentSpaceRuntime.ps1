param(
  [ValidateSet("dev", "start")]
  [string]$Mode = "dev",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
  [switch]$Desktop,
  [string]$DatabaseUrl = ""
)

$ErrorActionPreference = "Stop"

$script:ErrorCount = 0
$script:WarningCount = 0

function Write-Check {
  param(
    [ValidateSet("ok", "warn", "error")]
    [string]$Status,
    [string]$Name,
    [string]$Message
  )

  $label = $Status.ToUpperInvariant().PadRight(5)
  Write-Host "[AgentSpace][$label] $Name - $Message"

  if ($Status -eq "error") {
    $script:ErrorCount += 1
  } elseif ($Status -eq "warn") {
    $script:WarningCount += 1
  }
}

function Resolve-OptionalCommand {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }
  return $null
}

function Test-PathCheck {
  param(
    [string]$Name,
    [string]$Path,
    [string]$MissingMessage,
    [ValidateSet("warn", "error")]
    [string]$MissingStatus = "warn"
  )

  if (Test-Path $Path) {
    Write-Check "ok" $Name $Path
  } else {
    Write-Check $MissingStatus $Name $MissingMessage
  }
}

function Read-DotEnvFile {
  param([string]$Path)

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")
    if ($separatorIndex -le 0) {
      continue
    }

    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    if ($key.StartsWith("export ")) {
      $key = $key.Substring("export ".Length).Trim()
    }

    $value = $trimmed.Substring($separatorIndex + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if ($key) {
      $values[$key] = $value
    }
  }

  return $values
}

function Get-EnvOrDotEnvValue {
  param(
    [string]$Name,
    [hashtable]$DotEnvValues
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($processValue -and $processValue.Trim()) {
    return $processValue.Trim()
  }

  $dotEnvValue = $DotEnvValues[$Name]
  if ($dotEnvValue -and "$dotEnvValue".Trim()) {
    return "$dotEnvValue".Trim()
  }

  return ""
}

function Resolve-ConfiguredDatabaseUrl {
  param(
    [hashtable]$DotEnvValues,
    [string]$ExplicitDatabaseUrl
  )

  if ($ExplicitDatabaseUrl.Trim()) {
    return $ExplicitDatabaseUrl.Trim()
  }

  $testUrl = Get-EnvOrDotEnvValue "AGENT_SPACE_TEST_DATABASE_URL" $DotEnvValues
  if ($testUrl) {
    return $testUrl
  }

  $testLegacyUrl = Get-EnvOrDotEnvValue "AGENT_SPACE_PG_TEST_URL" $DotEnvValues
  if ($testLegacyUrl) {
    return $testLegacyUrl
  }

  $deploymentMode = Get-EnvOrDotEnvValue "AGENT_SPACE_DEPLOYMENT_MODE" $DotEnvValues
  if ($deploymentMode -eq "cloud") {
    $neonUrl = Get-EnvOrDotEnvValue "NEON_DATABASE_URL" $DotEnvValues
    if ($neonUrl) {
      return $neonUrl
    }
  } elseif ($deploymentMode -eq "self_hosted") {
    $selfHostedUrl = Get-EnvOrDotEnvValue "SELF_HOSTED_DATABASE_URL" $DotEnvValues
    if ($selfHostedUrl) {
      return $selfHostedUrl
    }
  }

  $legacyPgUrl = Get-EnvOrDotEnvValue "AGENT_SPACE_PG_URL" $DotEnvValues
  if ($legacyPgUrl) {
    return $legacyPgUrl
  }

  return Get-EnvOrDotEnvValue "DATABASE_URL" $DotEnvValues
}

function Redact-DatabaseUrl {
  param([string]$Url)

  try {
    $uri = [System.Uri]::new($Url)
    if ($uri.UserInfo -and $uri.UserInfo.Contains(":")) {
      return $Url.Replace($uri.UserInfo + "@", ($uri.UserInfo.Split(":")[0] + ":***@"))
    }
  } catch {
    return $Url -replace ":[^:@/]+@", ":***@"
  }

  return $Url
}

function Test-TcpEndpoint {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 2000
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-DatabaseUrlReachability {
  param([string]$Url)

  try {
    $uri = [System.Uri]::new($Url)
  } catch {
    Write-Check "error" "PostgreSQL URL" "Database URL is not a valid URI."
    return
  }

  $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  if (Test-TcpEndpoint -HostName $uri.Host -Port $port) {
    Write-Check "ok" "PostgreSQL TCP" "$($uri.Host):$port is reachable."
  } else {
    Write-Check "error" "PostgreSQL TCP" "$($uri.Host):$port is not reachable. Start PostgreSQL or update SELF_HOSTED_DATABASE_URL / DATABASE_URL."
  }
}

$repo = Resolve-Path $RepoRoot
Write-Host "[AgentSpace] Runtime preflight: $repo"

$node = Resolve-OptionalCommand @("node.exe", "node")
if ($node) {
  $nodeVersionText = (& $node --version).Trim()
  $nodeMajor = 0
  if ($nodeVersionText -match "^v(?<major>\d+)") {
    $nodeMajor = [int]$Matches.major
  }

  if ($nodeMajor -ge 20) {
    Write-Check "ok" "Node.js" "$nodeVersionText at $node"
  } else {
    Write-Check "error" "Node.js" "Found $nodeVersionText. AgentSpace requires Node.js >= 20.20.0; Node.js 24 is recommended."
  }
} else {
  Write-Check "error" "Node.js" "node was not found on PATH."
}

$npm = Resolve-OptionalCommand @("npm.cmd", "npm")
if ($npm) {
  $npmVersionText = (& $npm --version).Trim()
  Write-Check "ok" "npm" "$npmVersionText at $npm"
} else {
  Write-Check "error" "npm" "npm was not found on PATH."
}

Test-PathCheck `
  -Name "web dependencies" `
  -Path (Join-Path $repo "apps\web\node_modules\next") `
  -MissingMessage "apps/web dependencies are missing. Run deploy/windows/Start-AgentSpace.ps1 -Install." `
  -MissingStatus "error"

Test-PathCheck `
  -Name "CLI dependencies" `
  -Path (Join-Path $repo "apps\cli\node_modules") `
  -MissingMessage "apps/cli dependencies are missing. Run deploy/windows/Start-AgentSpace.ps1 -Install." `
  -MissingStatus "warn"

Test-PathCheck `
  -Name "daemon package dependencies" `
  -Path (Join-Path $repo "packages\daemon\node_modules") `
  -MissingMessage "packages/daemon dependencies are missing. Remote daemon packaging may fail until setup runs." `
  -MissingStatus "warn"

if ($Mode -eq "start" -or $Desktop) {
  Test-PathCheck `
    -Name "Next.js production build" `
    -Path (Join-Path $repo "apps\web\.next\BUILD_ID") `
    -MissingMessage "apps/web/.next is missing. Run npm run build before production or desktop startup." `
    -MissingStatus "error"
}

if ($Desktop) {
  Test-PathCheck `
    -Name "Electron dependency" `
    -Path (Join-Path $repo "node_modules\electron") `
    -MissingMessage "Root Electron dependency is missing. Run npm install --no-audit --no-fund before npm run desktop:build." `
    -MissingStatus "error"

  Test-PathCheck `
    -Name "electron-builder dependency" `
    -Path (Join-Path $repo "node_modules\electron-builder") `
    -MissingMessage "Root electron-builder dependency is missing. Run npm install --no-audit --no-fund before npm run desktop:build." `
    -MissingStatus "error"
}

$envPath = Join-Path $repo ".env"
$envExamplePath = Join-Path $repo ".env.example"
$dotEnvValues = Read-DotEnvFile $envPath
if (Test-Path $envPath) {
  Write-Check "ok" "environment file" ".env exists"
} elseif (Test-Path $envExamplePath) {
  Write-Check "warn" "environment file" ".env is missing. Copy .env.example to .env if local secrets or database settings are required."
} else {
  Write-Check "warn" "environment file" "No .env or .env.example found."
}

$postgresConfigured = Resolve-ConfiguredDatabaseUrl -DotEnvValues $dotEnvValues -ExplicitDatabaseUrl $DatabaseUrl
if ($postgresConfigured) {
  Write-Check "ok" "PostgreSQL config" (Redact-DatabaseUrl $postgresConfigured)
  Test-DatabaseUrlReachability $postgresConfigured
} else {
  Write-Check "error" "PostgreSQL config" "PostgreSQL database URL is required. Create .env from .env.example and start PostgreSQL, or pass -DatabaseUrl to Start-AgentSpace.ps1."
}

$providerCommands = @("codex", "claude", "gemini", "opencode", "openclaw", "nanobot", "hermes")
$detectedProviders = @()
foreach ($providerCommand in $providerCommands) {
  $providerPath = Resolve-OptionalCommand @($providerCommand)
  if ($providerPath) {
    $detectedProviders += "$providerCommand=$providerPath"
  }
}

if ($detectedProviders.Count -gt 0) {
  Write-Check "ok" "provider CLI" ($detectedProviders -join "; ")
} else {
  Write-Check "warn" "provider CLI" "No supported provider CLI found on PATH. Multi-agent execution needs codex, claude, gemini, opencode, openclaw, nanobot, or hermes."
}

$daemonStateDir = Join-Path $repo "data\daemon"
$daemonPidPath = Join-Path $daemonStateDir "daemon.pid"
$daemonLogPath = Join-Path $daemonStateDir "daemon.log"
if (Test-Path $daemonPidPath) {
  $daemonPidText = (Get-Content -Raw $daemonPidPath).Trim()
  $daemonPid = 0
  if ([int]::TryParse($daemonPidText, [ref]$daemonPid) -and $daemonPid -gt 0) {
    $daemonProcess = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
    if ($daemonProcess) {
      Write-Check "ok" "native daemon" "Running with pid $daemonPid."
    } else {
      Write-Check "warn" "native daemon" "Stale daemon pid file found at $daemonPidPath. Use agent-space daemon start or Start-AgentSpace.ps1 -StartDaemon."
    }
  } else {
    Write-Check "warn" "native daemon" "Invalid daemon pid file found at $daemonPidPath."
  }
} else {
  Write-Check "warn" "native daemon" "No local daemon pid file found. Use Start-AgentSpace.ps1 -StartDaemon when you want local multi-agent execution."
}

if (Test-Path $daemonLogPath) {
  Write-Check "ok" "daemon logs" $daemonLogPath
} else {
  Write-Check "warn" "daemon logs" "No daemon log file found yet."
}

if ($script:ErrorCount -gt 0) {
  Write-Host "[AgentSpace] Runtime preflight failed with $script:ErrorCount error(s), $script:WarningCount warning(s)."
  exit 1
}

Write-Host "[AgentSpace] Runtime preflight passed with $script:WarningCount warning(s)."
