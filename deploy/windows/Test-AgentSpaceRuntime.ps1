param(
  [ValidateSet("dev", "start")]
  [string]$Mode = "dev",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
  [switch]$Desktop
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
if (Test-Path $envPath) {
  Write-Check "ok" "environment file" ".env exists"
} elseif (Test-Path $envExamplePath) {
  Write-Check "warn" "environment file" ".env is missing. Copy .env.example to .env if local secrets or database settings are required."
} else {
  Write-Check "warn" "environment file" "No .env or .env.example found."
}

$postgresConfigured = $env:AGENT_SPACE_PG_URL -or $env:DATABASE_URL -or $env:SELF_HOSTED_DATABASE_URL -or $env:NEON_DATABASE_URL
if ($postgresConfigured) {
  Write-Check "ok" "PostgreSQL config" "A PostgreSQL database URL environment variable is set."
} else {
  Write-Check "warn" "PostgreSQL config" "No PostgreSQL URL env var detected. If this instance needs PostgreSQL, configure AGENT_SPACE_PG_URL or DATABASE_URL."
}

if ($script:ErrorCount -gt 0) {
  Write-Host "[AgentSpace] Runtime preflight failed with $script:ErrorCount error(s), $script:WarningCount warning(s)."
  exit 1
}

Write-Host "[AgentSpace] Runtime preflight passed with $script:WarningCount warning(s)."
