#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonAtomically {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [object] $Value
  )

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $directory)
  }
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), $Utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Quote-NativeArgument {
  param([Parameter(Mandatory = $true)][string] $Value)
  if ($Value.Contains('"')) { throw 'Launcher paths cannot contain a double quote.' }
  return '"' + $Value + '"'
}

if (-not (Test-Path -LiteralPath $RequestPath -PathType Leaf)) {
  throw "Launcher request does not exist: $RequestPath"
}
$request = Get-Content -Raw -LiteralPath $RequestPath -Encoding UTF8 | ConvertFrom-Json
if ([string] $request.mode -notin @('web', 'desktop')) { throw 'The supervisor accepts only managed Web/Desktop requests.' }
$requestId = [Guid]::Empty
if (-not [Guid]::TryParse([string] $request.requestId, [ref] $requestId)) { throw 'Request id is invalid.' }
$statePath = [string] $request.statePath
$stopPath = [string] $request.stopPath
$accessPath = [string] $request.accessPath
$commandScript = Join-Path $PSScriptRoot 'DSH-Launcher.Command.ps1'
if (-not (Test-Path -LiteralPath $commandScript -PathType Leaf)) { throw 'Launcher command engine is missing.' }

$powershell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $powershell
$startInfo.Arguments = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy Bypass',
  '-File ' + (Quote-NativeArgument -Value $commandScript),
  '-RequestPath ' + (Quote-NativeArgument -Value $RequestPath)
) -join ' '
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$runner = New-Object System.Diagnostics.Process
$runner.StartInfo = $startInfo
if (-not $runner.Start()) { throw 'Unable to start the DSH runner.' }

$startedAt = [DateTime]::UtcNow.ToString('o')
Write-JsonAtomically -Path $statePath -Value ([ordered]@{
  requestId = $requestId.ToString('D')
  status = 'starting'
  desktopBuild = ([string]$request.mode -eq 'desktop' -and [bool]$request.desktopBuild)
  supervisorPid = $PID
  runnerPid = $runner.Id
  startedAtUtc = $startedAt
  port = [int] $request.port
  logPath = [string] $request.logPath
})

$stopping = $false
try {
  while (-not $runner.HasExited) {
    if (Test-Path -LiteralPath $stopPath -PathType Leaf) {
      $stopId = ([string](Get-Content -Raw -LiteralPath $stopPath -ErrorAction SilentlyContinue)).Trim()
      if ($stopId -eq $requestId.ToString('D')) {
        # A busy DSH tree contains short-lived MCP children. taskkill can print
        # "no running instance" for one child and return 255 even after it has
        # successfully terminated the runner and every remaining descendant.
        # Windows PowerShell 5.1 promotes that native stderr to a terminating
        # error under Stop, which used to kill this supervisor mid-command and
        # orphan the still-running Web tree. Let taskkill finish, then use the
        # runner process itself as the authoritative stop result.
        $taskkillErrorActionPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $taskkillOutput = @(& taskkill.exe /PID $runner.Id /T /F 2>&1)
          $taskkillExitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $taskkillErrorActionPreference
        }
        $runner.Refresh()
        if ($runner.HasExited) {
          $stopping = $true
        } else {
          $detail = ($taskkillOutput | Out-String).Trim()
          try {
            [System.IO.File]::AppendAllText(
              [string] $request.logPath,
              "Launcher could not stop the DSH process tree (taskkill exit $taskkillExitCode): $detail`r`n",
              $Utf8NoBom
            )
          } catch { }
        }
        Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Milliseconds 300
    $runner.Refresh()
  }
  $runner.WaitForExit()
  Write-JsonAtomically -Path $statePath -Value ([ordered]@{
    requestId = $requestId.ToString('D')
    status = 'stopped'
    desktopBuild = ([string]$request.mode -eq 'desktop' -and [bool]$request.desktopBuild)
    supervisorPid = $PID
    runnerPid = $runner.Id
    startedAtUtc = $startedAt
    stoppedAtUtc = [DateTime]::UtcNow.ToString('o')
    exitCode = $runner.ExitCode
    stoppedByLauncher = $stopping
    port = [int] $request.port
    logPath = [string] $request.logPath
  })
} finally {
  $runner.Dispose()
  Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($accessPath)) {
    Remove-Item -LiteralPath $accessPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue
}
