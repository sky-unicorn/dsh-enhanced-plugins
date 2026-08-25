#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

function Invoke-LoggedDsh {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Command,

    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,

    [Parameter(Mandatory = $true)]
    [string] $LogPath,

    [Parameter(Mandatory = $true)]
    [string] $Header
  )

  $logDirectory = Split-Path -Parent $LogPath
  if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $logDirectory)
  }
  [System.IO.File]::AppendAllText($LogPath, $Header + [Environment]::NewLine, $Utf8NoBom)
  $writer = New-Object System.IO.StreamWriter($LogPath, $true, $Utf8NoBom)
  try {
    & $Command @Arguments 2>&1 | ForEach-Object {
      $writer.WriteLine([string] $_)
      $writer.Flush()
    }
    return $LASTEXITCODE
  } finally {
    $writer.Dispose()
  }
}

function Resolve-SafeDshCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Mode
  )

  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $extension = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
  if ($extension -eq '.cmd') {
    $powershellShim = [System.IO.Path]::ChangeExtension($resolved, '.ps1')
    if (Test-Path -LiteralPath $powershellShim -PathType Leaf) {
      return (Resolve-Path -LiteralPath $powershellShim).Path
    }
    if ($Mode -ne 'web') {
      throw 'The located dsh.cmd has no sibling dsh.ps1; interactive input cannot be forwarded safely.'
    }
  }
  if ($extension -notin @('.ps1', '.cmd', '.exe')) {
    throw "Unsupported dsh launcher extension '$extension'."
  }
  return $resolved
}

if (-not (Test-Path -LiteralPath $RequestPath -PathType Leaf)) {
  throw "Launcher request does not exist: $RequestPath"
}

$request = Get-Content -Raw -LiteralPath $RequestPath -Encoding UTF8 | ConvertFrom-Json
$mode = [string] $request.mode
if ($mode -notin @('doctor', 'headless', 'profile', 'web')) {
  throw "Unsupported launcher request mode '$mode'."
}
$dsh = Resolve-SafeDshCommand -Path ([string] $request.dshCommand) -Mode $mode
$workingDirectory = [string] $request.workingDirectory
if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
  throw "Working directory does not exist: $workingDirectory"
}

$originalDirectory = (Get-Location).Path
try {
  Set-Location -LiteralPath $workingDirectory
  switch ($mode) {
    'doctor' {
      & $dsh --version
      exit $LASTEXITCODE
    }
    'headless' {
      $task = [string] $request.task
      if ([string]::IsNullOrWhiteSpace($task)) { throw 'Headless task cannot be empty.' }
      & $dsh --profile headless $task
      exit $LASTEXITCODE
    }
    'profile' {
      $profile = [string] $request.profile
      if ($profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Profile name is invalid.' }
      $logPath = [string] $request.logPath
      if ([string]::IsNullOrWhiteSpace($logPath)) { throw 'Profile log path is missing.' }
      $code = Invoke-LoggedDsh `
        -Command $dsh `
        -Arguments @('--profile', $profile) `
        -LogPath $logPath `
        -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) dsh --profile $profile ====="
      exit $code
    }
    'web' {
      $port = 0
      if (-not [int]::TryParse([string] $request.port, [ref] $port) -or $port -lt 0 -or $port -gt 65535) {
        throw 'Web port must be between 0 and 65535.'
      }
      $arguments = @('web', '--port', [string] $port)
      if ([bool] $request.noOpen) { $arguments += '--no-open' }
      $logPath = [string] $request.logPath
      $code = Invoke-LoggedDsh `
        -Command $dsh `
        -Arguments $arguments `
        -LogPath $logPath `
        -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) dsh web --port $port ====="
      exit $code
    }
  }
} finally {
  Set-Location -LiteralPath $originalDirectory
  if ($mode -in @('doctor', 'headless', 'profile')) {
    Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue
  }
}
