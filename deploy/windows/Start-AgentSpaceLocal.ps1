param(
  [switch]$Init,
  [switch]$Detect,
  [string]$Prompt = "",
  [string]$Config = "",
  [string]$Cwd = "",
  [string]$Agents = "",
  [switch]$JsonEvents
)

$ErrorActionPreference = "Stop"

function Write-LocalStep {
  param([string]$Message)
  Write-Host "[AgentSpace Local] $Message"
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

function Invoke-LocalAgents {
  param([string[]]$Arguments)

  & $npm --prefix $repoRoot run local:agents -- @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "local:agents failed with exit code $LASTEXITCODE."
  }
}

function Build-CommonArgs {
  $args = @()
  if ($Config.Trim()) {
    $args += @("--config", $Config.Trim())
  }
  if ($Cwd.Trim()) {
    $args += @("--cwd", $Cwd.Trim())
  }
  if ($Agents.Trim()) {
    $args += @("--agents", $Agents.Trim())
  }
  if ($JsonEvents) {
    $args += "--json-events"
  }
  return $args
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$configPath = if ($Config.Trim()) { $Config.Trim() } else { Join-Path $repoRoot "agentspace.local.json" }
$npm = Resolve-RequiredCommand @("npm.cmd", "npm")

Write-LocalStep "Repository: $repoRoot"

if ($Init) {
  $args = @("init")
  if ($Config.Trim()) {
    $args += @("--config", $Config.Trim())
  }
  Invoke-LocalAgents -Arguments $args
  exit 0
}

if ($Detect) {
  Invoke-LocalAgents -Arguments @("detect")
  exit 0
}

$taskPrompt = $Prompt.Trim()
if (-not $taskPrompt) {
  Write-Host ""
  Write-Host "AgentSpace Local"
  Write-Host "1. Init agentspace.local.json"
  Write-Host "2. Detect provider CLI"
  Write-Host "3. Run a local multi-agent task"
  Write-Host ""
  $choice = Read-Host "Choose 1/2/3, press Enter for 3"
  if (-not $choice.Trim()) {
    $choice = "3"
  }

  if ($choice -eq "1") {
    if (Test-Path $configPath) {
      Write-LocalStep "Config already exists: $configPath"
    } else {
      $args = @("init")
      if ($Config.Trim()) {
        $args += @("--config", $Config.Trim())
      }
      Invoke-LocalAgents -Arguments $args
    }
    exit 0
  }

  if ($choice -eq "2") {
    Invoke-LocalAgents -Arguments @("detect")
    exit 0
  }

  if (-not (Test-Path $configPath)) {
    Write-LocalStep "Config not found: $configPath"
    $create = Read-Host "Create default config now? Type y to create"
    if ($create.Trim().ToLowerInvariant() -eq "y") {
      $args = @("init")
      if ($Config.Trim()) {
        $args += @("--config", $Config.Trim())
      }
      Invoke-LocalAgents -Arguments $args
    } else {
      throw "Local config is required before running tasks."
    }
  }

  $taskPrompt = Read-Host "Enter the task for local agents"
  if (-not $taskPrompt.Trim()) {
    throw "Task prompt is required."
  }
}

$runArgs = @("run") + (Build-CommonArgs) + @($taskPrompt)
Invoke-LocalAgents -Arguments $runArgs
