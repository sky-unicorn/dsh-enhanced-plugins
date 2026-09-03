#Requires -Version 5.1
param([string] $ManagerScript, [string] $TestRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ManagerScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
# Load the actual production functions without invoking the coordinator entrypoint.
foreach ($definition in $ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $false)) { Invoke-Expression $definition.Extent.Text }

function Assert-Test {
  param([bool] $Condition, [string] $Message)
  if (-not $Condition) { throw $Message }
}
function New-OldUpdate {
  $path = Join-Path $updates ([Guid]::NewGuid().ToString('D'))
  [void](New-Item -ItemType Directory -Path $path)
  [System.IO.File]::WriteAllText((Join-Path $path 'source.zip'), 'old source')
  $path
}
function Write-Record {
  param([string] $Directory, [int] $ProcessId, [DateTime] $StartedAt)
  Write-JsonFile (Join-Path $Directory 'pending.json') ([pscustomobject]@{
    requestId = Split-Path -Leaf $Directory
    coordinatorPid = $ProcessId
    startedAtUtc = $StartedAt.ToString('o')
  })
}

$launcher = Join-Path $TestRoot 'launcher'
$env:DEEPSEEK_HARNESS_LAUNCHER_HOME = $launcher
$updates = Join-Path $launcher 'updates'
$current = Join-Path $updates 'current'
$logPath = Join-Path $current 'logs\update.log'
$env:DSH_HOME = Join-Path $TestRoot 'dsh-home'
$recordedHome = Join-Path $TestRoot 'other-dsh-home'
$profileRoot = Join-Path $env:DSH_HOME 'profiles\web'
[void](New-Item -ItemType Directory -Force -Path $current, $profileRoot)
$finished = New-OldUpdate
Write-Record $finished ([int]::MaxValue) ([DateTime]::UtcNow)
Write-JsonFile (Join-Path $finished 'result.json') @{ success = $true }
$abandoned = New-OldUpdate
$reusedPid = New-OldUpdate
Write-Record $reusedPid $PID ([DateTime]::UtcNow.AddDays(-1))
$running = New-OldUpdate
Write-Record $running $PID ([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime())
Write-JsonFile (Join-Path $running 'result.json') @{ success = $true }
$linked = New-OldUpdate
$relative = New-OldUpdate
$fileUrl = New-OldUpdate
$otherHome = New-OldUpdate
$bound = New-OldUpdate
$malformed = New-OldUpdate
[System.IO.File]::WriteAllText((Join-Path $malformed 'pending.json'), '{bad json')
$unrelated = Join-Path $updates 'user-files'
[void](New-Item -ItemType Directory -Path $unrelated)
$outside = Join-Path $TestRoot 'outside'
[void](New-Item -ItemType Directory -Path $outside)
[System.IO.File]::WriteAllText((Join-Path $outside 'keep.txt'), 'keep')
$rootLink = Join-Path $updates ([Guid]::NewGuid().ToString('D'))
[void](New-Item -ItemType Junction -Path $rootLink -Target $outside)
[void](New-Item -ItemType Junction -Path (Join-Path $finished 'linked-dependency') -Target $outside)
$deepPath = '\\?\' + $finished + '\build-source\node_modules'
1..9 | ForEach-Object { $deepPath += '\a-very-long-dependency-directory-name' }
[void][System.IO.Directory]::CreateDirectory($deepPath)
$deepFile = $deepPath + '\readonly.txt'
[System.IO.File]::WriteAllText($deepFile, 'old build')
[System.IO.File]::SetAttributes($deepFile, [System.IO.FileAttributes]::ReadOnly)

$statePath = Join-Path $launcher 'install-state.json'
Write-JsonFile $statePath @{ projectSource = @{ boundPath = (Join-Path $bound 'build-source') }; dsh = @{ home = $recordedHome } }
$manifestPath = Join-Path $profileRoot 'package.json'
Write-JsonFile (Join-Path $recordedHome 'profiles\unmanaged\package.json') @{
  dependencies = @{ 'other-profile' = ('link:' + $otherHome.Replace('\', '/') + '/build-source') }
}
# A broken inventory must cancel all deletions, even for apparently unused trees.
[System.IO.File]::WriteAllText($manifestPath, '{broken')
Remove-LegacyUpdateDirectories $launcher @($current) $logPath
Assert-Test (Test-Path -LiteralPath $finished) 'Cleanup proceeded with a corrupt Profile manifest.'
Write-JsonFile $manifestPath @{
  dependencies = @{ absolute = ('link:' + $linked.Replace('\', '/') + '/build-source') }
  devDependencies = @{ relative = ('link:../../../launcher/updates/' + (Split-Path -Leaf $relative) + '/build-source') }
  optionalDependencies = @{ uri = ([Uri]($fileUrl + '\build-source')).AbsoluteUri }
}
Remove-LegacyUpdateDirectories $launcher @($current) $logPath
foreach ($removed in @($finished, $abandoned, $reusedPid)) {
  Assert-Test (-not (Test-Path -LiteralPath $removed)) "Obsolete tree was not deleted: $removed"
}
foreach ($retained in @($current, $running, $linked, $relative, $fileUrl, $otherHome, $bound, $malformed, $unrelated, $rootLink)) {
  Assert-Test (Test-Path -LiteralPath $retained) "In-use or unrelated directory was removed: $retained"
}
Assert-Test ((Get-Content -LiteralPath (Join-Path $outside 'keep.txt') -Raw) -eq 'keep') 'Cleanup followed a directory junction.'
Assert-Test ((Get-Content -LiteralPath $logPath -Raw).Contains('Legacy update cleanup warning')) 'Cleanup warnings were not logged.'

# Later successful updates retire directories once their final references disappear.
Write-Record $running ([int]::MaxValue) ([DateTime]::UtcNow)
Write-JsonFile $manifestPath @{ dependencies = @{} }
Write-JsonFile (Join-Path $recordedHome 'profiles\unmanaged\package.json') @{ dependencies = @{} }
Write-JsonFile $statePath @{ projectSource = @{ boundPath = (Join-Path $launcher 'sources\active') }; dsh = @{ home = $recordedHome } }
Remove-LegacyUpdateDirectories $launcher @($current) $logPath
foreach ($released in @($running, $linked, $relative, $fileUrl, $otherHome, $bound)) {
  Assert-Test (-not (Test-Path -LiteralPath $released)) "Released legacy directory was not retried: $released"
}
Remove-LegacyUpdateDirectories $launcher @($current) $logPath
Assert-Test (Test-Path -LiteralPath $current) 'Repeated cleanup removed the current workspace.'

# Exercise the shipped machine operation and its cross-process update lock.
$startupStale = New-OldUpdate
$machineResult = Join-Path $TestRoot 'cleanup-result.json'
$mutex = New-Object System.Threading.Mutex($false, 'Local\DSH.Enhanced.WindowsLauncher.UpdateWorkspace')
$taken = $false
try {
  $taken = $mutex.WaitOne(0)
  Assert-Test $taken 'Could not acquire fixture update mutex.'
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ManagerScript -Operation Cleanup -OutputPath $machineResult
  Assert-Test ($LASTEXITCODE -eq 0) 'Cleanup machine operation failed while busy.'
  Assert-Test ((Read-JsonFile $machineResult).stage -eq 'busy') 'Cleanup did not respect the update workspace lock.'
  Assert-Test (Test-Path -LiteralPath $startupStale) 'Busy cleanup deleted a directory.'
} finally {
  if ($taken) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ManagerScript -Operation Cleanup -OutputPath $machineResult
Assert-Test ($LASTEXITCODE -eq 0 -and (Read-JsonFile $machineResult).stage -eq 'complete') 'Idle cleanup machine operation failed.'
Assert-Test (-not (Test-Path -LiteralPath $startupStale)) 'Startup cleanup did not remove a stale update.'
Write-Output 'LEGACY_UPDATE_CLEANUP_OK'
