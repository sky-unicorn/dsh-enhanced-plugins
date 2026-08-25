#Requires -Version 5.1

# Compatible with the inbox Windows PowerShell 5.1 on Windows 10 and 11,
# and with newer PowerShell versions when invoked directly.

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string] $Profile = 'web',

  [ValidateNotNullOrEmpty()]
  [string] $DshCommand = 'dsh',

  [string] $DshCheckout = '',

  [string] $PluginPath = '',

  [string[]] $Features = @('all'),

  [switch] $CreateLauncherDesktopShortcut,

  [switch] $SkipLauncherSystemIntegration,

  [switch] $ListFeatures
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ProfileDependencies {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Executable,

    [string[]] $PrefixArguments = @(),

    [Parameter(Mandatory = $true)]
    [string] $ProfileName
  )

  $outputLines = @(
    & $Executable @PrefixArguments plugin --profile $ProfileName list --depth 0 --json
  )
  $listExitCode = $LASTEXITCODE
  if ($listExitCode -ne 0) {
    throw "Cannot inspect DSH profile '$ProfileName'; list exited with code $listExitCode."
  }

  $output = $outputLines -join [Environment]::NewLine
  $jsonStart = $output.IndexOf('[')
  $jsonEnd = $output.LastIndexOf(']')
  if ($jsonStart -lt 0 -or $jsonEnd -lt $jsonStart) {
    throw "Cannot parse the dependency list returned for DSH profile '$ProfileName'."
  }

  try {
    $inventory = $output.Substring($jsonStart, $jsonEnd - $jsonStart + 1) |
      ConvertFrom-Json
  } catch {
    throw "Cannot parse the dependency list returned for DSH profile '$ProfileName': $($_.Exception.Message)"
  }

  $profileInventory = @($inventory)[0]
  $dependencyNames = @()
  $dependenciesProperty = $profileInventory.PSObject.Properties['dependencies']
  if ($null -ne $dependenciesProperty) {
    $dependencyNames += @($dependenciesProperty.Value.PSObject.Properties | ForEach-Object { $_.Name })
  }

  # pnpm omits missing or stale-linked direct dependencies from its resolved
  # inventory. The profile manifest is the ownership source for uninstalling
  # those historical packages, so merge its declared keys before deciding
  # whether a retired bundle is absent.
  $profilePathProperty = $profileInventory.PSObject.Properties['path']
  if ($null -ne $profilePathProperty -and $profilePathProperty.Value -is [string]) {
    $profileManifestPath = Join-Path $profilePathProperty.Value 'package.json'
    if (Test-Path -LiteralPath $profileManifestPath -PathType Leaf) {
      $profileManifest = Get-Content -Raw -LiteralPath $profileManifestPath | ConvertFrom-Json
      $declaredDependencies = $profileManifest.PSObject.Properties['dependencies']
      if ($null -ne $declaredDependencies) {
        $dependencyNames += @($declaredDependencies.Value.PSObject.Properties | ForEach-Object { $_.Name })
      }
    }
  }

  $dependencyNames | Select-Object -Unique
}

function Get-ProfileConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Executable,

    [string[]] $PrefixArguments = @(),

    [Parameter(Mandatory = $true)]
    [string] $ProfileName
  )

  $outputLines = @(
    & $Executable @PrefixArguments --profile $ProfileName --dump-config
  )
  $dumpExitCode = $LASTEXITCODE
  if ($dumpExitCode -ne 0) {
    throw "Cannot inspect the assembled DSH profile '$ProfileName'; --dump-config exited with code $dumpExitCode."
  }
  $outputLines -join [Environment]::NewLine
}

function Test-RetiredReferencedFileConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Config
  )

  return $Config -match '(?m)^\s*-\s+id:\s*[''"]?referenced-file[''"]?\s*$' -or
    $Config -match '(?m)^\s*name:\s*[''"]?(?:dsh-enhanced-plugins/referenced-file|dsh-enhanced-referenced-file|dsh-referenced-file)[''"]?\s*$'
}

function Get-RetiredFeatureCatalog {
  param(
    [Parameter(Mandatory = $true)]
    [object] $Manifest
  )

  $metadata = $Manifest.PSObject.Properties['dshEnhanced']
  if ($null -eq $metadata) {
    return
  }
  $retiredProperty = $metadata.Value.PSObject.Properties['retiredFeatures']
  if ($null -eq $retiredProperty) {
    return
  }

  foreach ($retired in @($retiredProperty.Value)) {
    if ($retired.feature -isnot [string] -or $retired.feature -notmatch '^[a-z0-9][a-z0-9-]*$') {
      throw 'The aggregate manifest has an invalid dshEnhanced.retiredFeatures feature id.'
    }
    $packageNames = @($retired.packageNames)
    if ($packageNames.Count -eq 0 -or @($packageNames | Where-Object { $_ -isnot [string] -or $_ -eq '' }).Count -gt 0) {
      throw "Retired feature '$($retired.feature)' must declare packageNames."
    }
    if ($retired.notice -isnot [string] -or $retired.notice -eq '') {
      throw "Retired feature '$($retired.feature)' must declare a notice."
    }
    [pscustomobject]@{
      Feature = $retired.feature
      PackageNames = $packageNames
      Notice = $retired.notice
    }
  }
}

function Get-MissingRuntimeEntries {
  param(
    [Parameter(Mandatory = $true)]
    [string] $PackageRoot,

    [Parameter(Mandatory = $true)]
    [object] $Manifest
  )

  $metadata = $Manifest.PSObject.Properties['dshEnhanced']
  $kindProperty = if ($null -eq $metadata) { $null } else { $metadata.Value.PSObject.Properties['kind'] }
  $kind = if ($null -eq $kindProperty) { 'bundle' } else { [string] $kindProperty.Value }
  if ($kind -eq 'companion') {
    $runtimeProperty = $metadata.Value.PSObject.Properties['runtimeEntries']
    if ($null -eq $runtimeProperty) {
      throw "Companion package '$($Manifest.name)' has no dshEnhanced.runtimeEntries."
    }
    $runtimeTargets = @($runtimeProperty.Value)
  } else {
    $runtimeTargets = @($Manifest.main)
    $exportsProperty = $Manifest.PSObject.Properties['exports']
    if ($null -ne $exportsProperty) {
      $runtimeTargets += @(
        $exportsProperty.Value.PSObject.Properties |
          ForEach-Object { $_.Value } |
          Where-Object { $_ -is [string] -and $_.StartsWith('./lib/', [System.StringComparison]::Ordinal) }
      )
    }
  }

  foreach ($target in @($runtimeTargets | Sort-Object -Unique)) {
    if ($target -isnot [string] -or -not $target.StartsWith('./lib/', [System.StringComparison]::Ordinal)) {
      continue
    }
    $entryPath = Join-Path $PackageRoot $target.Substring(2)
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
      $target
    }
  }
}

function Get-FeatureCatalog {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepositoryRoot
  )

  $packagesRoot = Join-Path $RepositoryRoot 'packages'
  if (-not (Test-Path -LiteralPath $packagesRoot -PathType Container)) {
    throw "Cannot find selective feature packages at '$packagesRoot'."
  }

  $catalog = @(
    Get-ChildItem -LiteralPath $packagesRoot -Directory | ForEach-Object {
      $manifestPath = Join-Path $_.FullName 'package.json'
      if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return
      }
      $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
      $metadata = $manifest.PSObject.Properties['dshEnhanced']
      if ($null -eq $metadata) {
        return
      }
      $feature = $metadata.Value.PSObject.Properties['feature']
      if ($null -eq $feature -or $feature.Value -isnot [string] -or $feature.Value -notmatch '^[a-z0-9][a-z0-9-]*$') {
        throw "Selective package manifest '$manifestPath' has an invalid dshEnhanced.feature."
      }
      if ($manifest.name -isnot [string] -or $manifest.name -eq '') {
        throw "Selective package manifest '$manifestPath' has no package name."
      }
      $kindProperty = $metadata.Value.PSObject.Properties['kind']
      $kind = if ($null -eq $kindProperty) { 'bundle' } else { [string] $kindProperty.Value }
      if ($kind -notin @('bundle', 'companion')) {
        throw "Selective package manifest '$manifestPath' has unsupported dshEnhanced.kind '$kind'."
      }
      $platformsProperty = $metadata.Value.PSObject.Properties['platforms']
      $runtimeEntriesProperty = $metadata.Value.PSObject.Properties['runtimeEntries']
      if ($kind -eq 'companion') {
        if ($null -eq $platformsProperty -or @($platformsProperty.Value) -notcontains 'win32') {
          throw "Companion package '$manifestPath' must declare the win32 platform."
        }
        if ($null -eq $runtimeEntriesProperty -or @($runtimeEntriesProperty.Value).Count -eq 0) {
          throw "Companion package '$manifestPath' must declare runtimeEntries."
        }
      }
      $legacyProperty = $metadata.Value.PSObject.Properties['legacyPackages']
      [pscustomobject]@{
        Feature = $feature.Value
        Kind = $kind
        PackageName = $manifest.name
        Root = $_.FullName
        Manifest = $manifest
        Description = $manifest.description
        LegacyPackages = if ($null -eq $legacyProperty) { @() } else { @($legacyProperty.Value) }
        Platforms = if ($null -eq $platformsProperty) { @() } else { @($platformsProperty.Value) }
        RuntimeEntries = if ($null -eq $runtimeEntriesProperty) { @() } else { @($runtimeEntriesProperty.Value) }
      }
    }
  )

  $duplicateFeatures = @(
    $catalog | Group-Object -Property Feature | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }
  )
  if ($duplicateFeatures.Count -gt 0) {
    throw "Selective package feature ids are duplicated: $($duplicateFeatures -join ', ')."
  }
  $duplicatePackages = @(
    $catalog | Group-Object -Property PackageName | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }
  )
  if ($duplicatePackages.Count -gt 0) {
    throw "Selective package names are duplicated: $($duplicatePackages -join ', ')."
  }
  if ($catalog.Count -eq 0) {
    throw "No selective feature packages were found below '$packagesRoot'."
  }
  @($catalog | Sort-Object -Property Feature)
}

function Resolve-RequestedFeatures {
  param(
    [Parameter(Mandatory = $true)]
    [object[]] $Catalog,

    [object[]] $RetiredCatalog = @(),

    [string[]] $Requested = @('all')
  )

  $normalized = @(
    $Requested |
      ForEach-Object { $_ -split '[,\s]+' } |
      ForEach-Object { $_.Trim().ToLowerInvariant() } |
      Where-Object { $_ -ne '' } |
      Select-Object -Unique
  )
  if ($normalized.Count -eq 0) {
    $normalized = @('all')
  }
  if ($normalized -contains 'all') {
    if ($normalized.Count -ne 1) {
      throw "Feature 'all' cannot be combined with individual feature ids."
    }
    return @()
  }

  $retiredRequested = @($RetiredCatalog | Where-Object { $normalized -contains $_.Feature })
  if ($retiredRequested.Count -gt 0) {
    $retiredNames = $retiredRequested.Feature -join ', '
    $retiredNotices = @($retiredRequested.Notice | Select-Object -Unique) -join ' '
    $label = if ($retiredRequested.Count -eq 1) { 'Feature' } else { 'Features' }
    throw "$label '$retiredNames' is retired and cannot be installed. $retiredNotices"
  }

  $known = @($Catalog | ForEach-Object { $_.Feature })
  $unknown = @($normalized | Where-Object { $known -notcontains $_ })
  if ($unknown.Count -gt 0) {
    throw "Unknown feature(s): $($unknown -join ', '). Run with -ListFeatures to see valid ids."
  }
  @($Catalog | Where-Object { $normalized -contains $_.Feature })
}

function Ensure-PluginBuild {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [object[]] $Packages
  )

  $npm = Get-Command -Name 'npm' -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  $originalDirectory = (Get-Location).Path
  try {
    Set-Location -LiteralPath $RepositoryRoot
    Write-Host 'Preparing selected dsh-enhanced-plugins packages and their runtime entries...'
    & $npm.Source install --no-audit --no-fund --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed for dsh-enhanced-plugins with exit code $LASTEXITCODE."
    }
  } finally {
    Set-Location -LiteralPath $originalDirectory
  }

  $missing = @()
  foreach ($package in $Packages) {
    $entries = @(Get-MissingRuntimeEntries -PackageRoot $package.Root -Manifest $package.Manifest)
    $missing += @($entries | ForEach-Object { "$($package.PackageName):$_" })
  }
  if ($missing.Count -gt 0) {
    try {
      Set-Location -LiteralPath $RepositoryRoot
      Write-Host 'prepare left runtime entries missing; rebuilding explicitly...'
      & $npm.Source run build
      if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed for dsh-enhanced-plugins with exit code $LASTEXITCODE."
      }
    } finally {
      Set-Location -LiteralPath $originalDirectory
    }
    $missing = @()
    foreach ($package in $Packages) {
      $entries = @(Get-MissingRuntimeEntries -PackageRoot $package.Root -Manifest $package.Manifest)
      $missing += @($entries | ForEach-Object { "$($package.PackageName):$_" })
    }
  }
  if ($missing.Count -gt 0) {
    throw "Build completed without required runtime entries: $($missing -join ', ')."
  }
}

function Get-WindowsLauncherInstallRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_HARNESS_LAUNCHER_HOME)) {
    return [System.IO.Path]::GetFullPath($env:DEEPSEEK_HARNESS_LAUNCHER_HOME).TrimEnd('\')
  }
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required to install the Windows Launcher companion.'
  }
  [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\Launcher')).TrimEnd('\')
}

function Assert-LauncherOwnedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $InstallRoot
  )

  $root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $candidate = [System.IO.Path]::GetFullPath($Path)
  if (-not $candidate.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify launcher path outside '$root': '$candidate'."
  }
  $candidate
}

function New-WindowsLauncherShortcut {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Executable,

    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $directory)
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $null
  try {
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Executable
    $shortcut.WorkingDirectory = Split-Path -Parent $Executable
    $shortcut.IconLocation = $Executable + ',0'
    $shortcut.Description = 'DeepSeek Harness Windows Launcher'
    $shortcut.Save()
  } finally {
    if ($null -ne $shortcut) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
}

function Get-WindowsLauncherShortcutTarget {
  param([Parameter(Mandatory = $true)][string] $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $null
  try {
    $shortcut = $shell.CreateShortcut($Path)
    return [string] $shortcut.TargetPath
  } finally {
    if ($null -ne $shortcut) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
}

function Set-WindowsLauncherDshCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $InstallRoot,

    [Parameter(Mandatory = $true)]
    [string] $Executable,

    [string[]] $PrefixArguments = @(),

    [string] $RunnerWorkingDirectory = ''
  )

  $settingsPath = Join-Path $InstallRoot 'settings.json'
  $managedInvoker = Join-Path $InstallRoot 'dsh-checkout-invoker.ps1'
  [void](Assert-LauncherOwnedPath -Path $settingsPath -InstallRoot $InstallRoot)
  [void](Assert-LauncherOwnedPath -Path $managedInvoker -InstallRoot $InstallRoot)

  $settings = if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try { Get-Content -Raw -LiteralPath $settingsPath -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "Cannot read Windows Launcher settings at '$settingsPath': $($_.Exception.Message)" }
  } else {
    [pscustomobject]@{}
  }
  $commandProperty = $settings.PSObject.Properties['DshCommand']
  $existingCommand = if ($null -eq $commandProperty) { '' } else { [string] $commandProperty.Value }
  $isManagedCommand = $existingCommand.Equals($managedInvoker, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not [string]::IsNullOrWhiteSpace($existingCommand) -and -not $isManagedCommand) {
    Write-Host "Preserved the user-configured Launcher DSH command '$existingCommand'."
    return
  }

  $launcherCommand = $Executable
  if ($PrefixArguments.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($RunnerWorkingDirectory)) {
    if ($PrefixArguments.Count -ne 1 -or $PrefixArguments[0] -ne 'dsh' -or
      [string]::IsNullOrWhiteSpace($RunnerWorkingDirectory)) {
      throw 'The selected DSH checkout invocation cannot be represented safely for Windows Launcher.'
    }
    $checkout = [System.IO.Path]::GetFullPath($RunnerWorkingDirectory)
    $tsxConfig = Join-Path $checkout 'tsconfig.json'
    $tsxLoader = Join-Path $checkout 'node_modules\tsx\dist\esm\index.mjs'
    $cliEntry = Join-Path $checkout 'apps\cli\src\bin.ts'
    $node = Get-Command -Name 'node' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not (Test-Path -LiteralPath $tsxConfig -PathType Leaf) -or
      -not (Test-Path -LiteralPath $tsxLoader -PathType Leaf) -or
      -not (Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
      throw "The DSH checkout at '$checkout' is missing its CLI runtime entries."
    }
    $nodeLiteral = "'" + $node.Source.Replace("'", "''") + "'"
    $tsxConfigLiteral = "'" + $tsxConfig.Replace("'", "''") + "'"
    $loaderUrlLiteral = "'" + ([System.Uri] $tsxLoader).AbsoluteUri.Replace("'", "''") + "'"
    $cliLiteral = "'" + $cliEntry.Replace("'", "''") + "'"
    $invokerContent = @(
      '# Generated by dsh-enhanced-plugins. Re-run the installer after moving the DSH checkout.'
      '# Arguments remain an array and are forwarded directly to the DSH CLI.'
      "`$env:TSX_TSCONFIG_PATH = $tsxConfigLiteral"
      "& $nodeLiteral '--import' $loaderUrlLiteral $cliLiteral @args"
      'exit $LASTEXITCODE'
    ) -join [Environment]::NewLine
    $invokerTemporary = $managedInvoker + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [System.IO.File]::WriteAllText($invokerTemporary, $invokerContent, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $invokerTemporary -Destination $managedInvoker -Force

    $originalDirectory = (Get-Location).Path
    try {
      Set-Location -LiteralPath $InstallRoot
      $versionOutput = @(& $managedInvoker --version) -join [Environment]::NewLine
      $versionExitCode = $LASTEXITCODE
    } finally {
      Set-Location -LiteralPath $originalDirectory
    }
    if ($versionExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($versionOutput)) {
      throw 'The generated Windows Launcher DSH checkout invoker failed validation.'
    }
    $launcherCommand = $managedInvoker
  }

  $settings | Add-Member -NotePropertyName DshCommand -NotePropertyValue $launcherCommand -Force
  $settingsTemporary = $settingsPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText(
    $settingsTemporary,
    ($settings | ConvertTo-Json -Depth 8),
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $settingsTemporary -Destination $settingsPath -Force
  Write-Host "Configured Windows Launcher to invoke DSH through '$launcherCommand'."
}

function Install-WindowsLauncher {
  param(
    [Parameter(Mandatory = $true)]
    [object] $Package,

    [Parameter(Mandatory = $true)]
    [string] $DshExecutable,

    [string[]] $DshPrefixArguments = @(),

    [string] $DshRunnerWorkingDirectory = '',

    [switch] $CreateDesktopShortcut,

    [switch] $SkipSystemIntegration
  )

  if ($env:OS -ne 'Windows_NT') {
    throw 'The windows-launcher feature can only be installed on Windows.'
  }
  $runtimeFiles = @()
  foreach ($entry in @($Package.RuntimeEntries)) {
    if ($entry -isnot [string] -or -not $entry.StartsWith('./lib/', [System.StringComparison]::Ordinal)) {
      throw "Windows Launcher runtime entry is invalid: '$entry'."
    }
    $source = Join-Path $Package.Root $entry.Substring(2)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Windows Launcher runtime entry is missing: '$source'."
    }
    $runtimeFiles += Get-Item -LiteralPath $source
  }

  $executableSource = @($runtimeFiles | Where-Object { $_.Name -eq 'DSH-Launcher.exe' })[0]
  if ($null -eq $executableSource) { throw 'Windows Launcher executable is missing from runtimeEntries.' }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $executableSource.FullName).Hash.ToLowerInvariant()
  $version = [string] $Package.Manifest.version
  if ($version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-[0-9A-Za-z.-]+)?$') {
    throw "Windows Launcher package version '$version' is invalid."
  }
  $expectedFileVersion = "$($Matches.major).$($Matches.minor).$($Matches.patch).0"

  $installRoot = Get-WindowsLauncherInstallRoot
  $versionsRoot = Join-Path $installRoot 'versions'
  $versionRoot = Join-Path $versionsRoot ($version + '-' + $hash.Substring(0, 12))
  [void](Assert-LauncherOwnedPath -Path $versionsRoot -InstallRoot $installRoot)
  [void](Assert-LauncherOwnedPath -Path $versionRoot -InstallRoot $installRoot)
  $startShortcut = $null
  $desktopShortcut = $null
  if (-not $SkipSystemIntegration) {
    $programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DeepSeek Harness'
    $startShortcut = Join-Path $programs 'DeepSeek Harness Launcher.lnk'
    if ($CreateDesktopShortcut) {
      $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness Launcher.lnk'
    }
    foreach ($shortcut in @($startShortcut, $desktopShortcut | Where-Object { $null -ne $_ })) {
      $existingTarget = Get-WindowsLauncherShortcutTarget -Path $shortcut
      if (-not [string]::IsNullOrWhiteSpace($existingTarget) -and
        -not ([System.IO.Path]::GetFullPath($existingTarget)).StartsWith($installRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace an unowned Windows Launcher shortcut at '$shortcut'."
      }
    }
  }
  if (-not (Test-Path -LiteralPath $versionRoot -PathType Container)) {
    if (-not (Test-Path -LiteralPath $versionsRoot -PathType Container)) {
      [void](New-Item -ItemType Directory -Force -Path $versionsRoot)
    }
    $staging = Join-Path $versionsRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))
    [void](Assert-LauncherOwnedPath -Path $staging -InstallRoot $installRoot)
    [void](New-Item -ItemType Directory -Path $staging)
    try {
      foreach ($file in $runtimeFiles) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $staging $file.Name)
      }
      $stagedExe = Join-Path $staging 'DSH-Launcher.exe'
      $versionInfo = (Get-Item -LiteralPath $stagedExe).VersionInfo
      if ($versionInfo.ProductName -ne 'DeepSeek Harness Launcher' -or $versionInfo.FileVersion -ne $expectedFileVersion) {
        throw 'Windows Launcher executable metadata validation failed.'
      }
      Move-Item -LiteralPath $staging -Destination $versionRoot
    } finally {
      if (Test-Path -LiteralPath $staging -PathType Container) {
        Remove-Item -LiteralPath $staging -Recurse -Force
      }
    }
  }

  foreach ($file in $runtimeFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $versionRoot $file.Name) -PathType Leaf)) {
      throw "Installed Windows Launcher version is incomplete: '$($file.Name)'."
    }
  }
  $executable = Join-Path $versionRoot 'DSH-Launcher.exe'
  $selfTestPath = Join-Path $versionRoot '.install-self-test.txt'
  [void](Assert-LauncherOwnedPath -Path $selfTestPath -InstallRoot $installRoot)
  try {
    $selfTest = Start-Process `
      -FilePath $executable `
      -ArgumentList @('--self-test', ('"' + $selfTestPath + '"')) `
      -PassThru `
      -Wait `
      -WindowStyle Hidden
    $selfTestOutput = if (Test-Path -LiteralPath $selfTestPath -PathType Leaf) {
      (Get-Content -Raw -LiteralPath $selfTestPath).Trim()
    } else { '' }
    if ($selfTest.ExitCode -ne 0 -or $selfTestOutput -ne 'SELF_TEST_OK') {
      throw 'Installed Windows Launcher failed its self-test; the current version was not changed.'
    }
  } finally {
    if (Test-Path -LiteralPath $selfTestPath -PathType Leaf) {
      Remove-Item -LiteralPath $selfTestPath -Force
    }
  }
  Set-WindowsLauncherDshCommand `
    -InstallRoot $installRoot `
    -Executable $DshExecutable `
    -PrefixArguments $DshPrefixArguments `
    -RunnerWorkingDirectory $DshRunnerWorkingDirectory
  $currentPath = Join-Path $installRoot 'current.json'
  $previousExecutable = $null
  if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
    try {
      $previousCurrent = Get-Content -Raw -LiteralPath $currentPath -Encoding UTF8 | ConvertFrom-Json
      if ($previousCurrent.executable -is [string]) {
        $previousCandidate = Assert-LauncherOwnedPath -Path $previousCurrent.executable -InstallRoot $installRoot
        if (Test-Path -LiteralPath $previousCandidate -PathType Leaf) {
          $previousExecutable = $previousCandidate
        }
      }
    } catch {
      Write-Warning "Unable to inspect the previous Windows Launcher version: $($_.Exception.Message)"
    }
  }
  if ($null -ne $previousExecutable -and
    -not $previousExecutable.Equals($executable, [System.StringComparison]::OrdinalIgnoreCase)) {
    try {
      $shutdown = Start-Process -FilePath $previousExecutable -ArgumentList '--shutdown' -PassThru -Wait -WindowStyle Hidden
      if ($shutdown.ExitCode -ne 0) {
        Write-Warning "Previous Windows Launcher shutdown exited with code $($shutdown.ExitCode)."
      }
      Start-Sleep -Milliseconds 600
    } catch {
      Write-Warning "Unable to request shutdown of the previous Windows Launcher: $($_.Exception.Message)"
    }
  }
  if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $installRoot)
  }
  $currentTemporary = $currentPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText(
    $currentTemporary,
    ([ordered]@{
      version = $version
      hash = $hash
      versionRoot = $versionRoot
      executable = $executable
      installedAtUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $currentTemporary -Destination $currentPath -Force

  if (-not $SkipSystemIntegration) {
    New-WindowsLauncherShortcut -Executable $executable -Path $startShortcut
    if ($CreateDesktopShortcut) {
      New-WindowsLauncherShortcut -Executable $executable -Path $desktopShortcut
    }

    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $runName = 'DeepSeekHarnessLauncher'
    $existing = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
      $existingValue = [string] $existing.$runName
      if ($existingValue.StartsWith('"' + $installRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        Set-ItemProperty -Path $runKey -Name $runName -Value ('"' + $executable + '" --tray')
      } else {
        Write-Warning "Preserved an unowned '$runName' login-startup entry."
      }
    }
  }

  foreach ($oldVersion in @(Get-ChildItem -LiteralPath $versionsRoot -Directory -Force)) {
    if ($oldVersion.FullName.Equals($versionRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    [void](Assert-LauncherOwnedPath -Path $oldVersion.FullName -InstallRoot $installRoot)
    try {
      Remove-Item -LiteralPath $oldVersion.FullName -Recurse -Force
    } catch {
      Write-Warning "Unable to remove previous Windows Launcher version '$($oldVersion.FullName)': $($_.Exception.Message)"
    }
  }

  Write-Host "Installed Windows Launcher companion at '$versionRoot'."
  if (-not $SkipSystemIntegration) {
    Write-Host 'Open it from the Start menu: DeepSeek Harness Launcher.'
  }
}

function Uninstall-WindowsLauncher {
  param([switch] $SkipSystemIntegration)
  $installRoot = Get-WindowsLauncherInstallRoot
  $versionsRoot = Join-Path $installRoot 'versions'
  [void](Assert-LauncherOwnedPath -Path $versionsRoot -InstallRoot $installRoot)
  $currentPath = Join-Path $installRoot 'current.json'
  $executable = $null
  if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
    try {
      $current = Get-Content -Raw -LiteralPath $currentPath | ConvertFrom-Json
      if ($current.executable -is [string]) {
        $candidate = Assert-LauncherOwnedPath -Path $current.executable -InstallRoot $installRoot
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $executable = $candidate }
      }
    } catch {
      Write-Warning "Unable to read the existing Windows Launcher manifest: $($_.Exception.Message)"
    }
  }
  if ($null -ne $executable) {
    try {
      $shutdown = Start-Process -FilePath $executable -ArgumentList '--shutdown' -PassThru -Wait -WindowStyle Hidden
      if ($shutdown.ExitCode -ne 0) { Write-Warning "Windows Launcher shutdown exited with code $($shutdown.ExitCode)." }
      Start-Sleep -Milliseconds 600
    } catch {
      Write-Warning "Unable to request Windows Launcher shutdown: $($_.Exception.Message)"
    }
  }

  if (-not $SkipSystemIntegration) {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $runName = 'DeepSeekHarnessLauncher'
    $runValue = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    if ($null -ne $runValue -and ([string] $runValue.$runName).StartsWith('"' + $installRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    }
    $shortcuts = @(
      (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DeepSeek Harness\DeepSeek Harness Launcher.lnk'),
      (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness Launcher.lnk')
    )
    foreach ($shortcut in $shortcuts) {
      $target = Get-WindowsLauncherShortcutTarget -Path $shortcut
      if (-not [string]::IsNullOrWhiteSpace($target) -and
        ([System.IO.Path]::GetFullPath($target)).StartsWith($installRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $shortcut -Force
      }
    }
  }
  if (Test-Path -LiteralPath $versionsRoot -PathType Container) {
    Remove-Item -LiteralPath $versionsRoot -Recurse -Force
  }
  foreach ($owned in @(
    $currentPath,
    (Join-Path $installRoot 'dsh-checkout-invoker.ps1'),
    (Join-Path $installRoot 'requests'),
    (Join-Path $installRoot 'run')
  )) {
    if (-not (Test-Path -LiteralPath $owned)) { continue }
    if ((Get-Item -LiteralPath $owned) -is [System.IO.DirectoryInfo]) {
      [void](Assert-LauncherOwnedPath -Path $owned -InstallRoot $installRoot)
      Remove-Item -LiteralPath $owned -Recurse -Force
    } else {
      Remove-Item -LiteralPath $owned -Force
    }
  }
  Write-Host 'Removed the Windows Launcher companion. Logs and user settings were preserved.'
}

$pluginCandidate = if ($PluginPath -ne '') {
  $PluginPath
} else {
  Join-Path $PSScriptRoot '..'
}
$pluginRoot = [System.IO.Path]::GetFullPath($pluginCandidate)
$pluginManifestPath = Join-Path $pluginRoot 'package.json'
if (-not (Test-Path -LiteralPath $pluginManifestPath -PathType Leaf)) {
  throw "Cannot find the enhanced plugin manifest at '$pluginManifestPath'."
}

$pluginManifest = Get-Content -Raw -LiteralPath $pluginManifestPath | ConvertFrom-Json
if ($pluginManifest.name -ne 'dsh-enhanced-plugins') {
  throw "Expected dsh-enhanced-plugins at '$pluginRoot', found '$($pluginManifest.name)'."
}

$catalog = @(Get-FeatureCatalog -RepositoryRoot $pluginRoot)
$retiredCatalog = @(Get-RetiredFeatureCatalog -Manifest $pluginManifest)
if ($ListFeatures) {
  Write-Output "all`tInstall the aggregate DSH bundle and every available companion feature."
  foreach ($feature in $catalog) {
    Write-Output "$($feature.Feature)`t$($feature.Description)"
  }
  return
}

$requestedFeatures = @(
  Resolve-RequestedFeatures -Catalog $catalog -RetiredCatalog $retiredCatalog -Requested $Features
)
$installAggregate = $requestedFeatures.Count -eq 0
$selectedFeatures = if ($installAggregate) { @($catalog) } else { @($requestedFeatures) }
$selectedBundles = @($selectedFeatures | Where-Object { $_.Kind -eq 'bundle' })
$selectedCompanions = @($selectedFeatures | Where-Object { $_.Kind -eq 'companion' })
$aggregatePackage = [pscustomobject]@{
  Feature = 'all'
  Kind = 'bundle'
  PackageName = $pluginManifest.name
  Root = $pluginRoot
  Manifest = $pluginManifest
  Description = $pluginManifest.description
  LegacyPackages = @($catalog | Where-Object { $_.Kind -eq 'bundle' } | ForEach-Object { $_.LegacyPackages } | Select-Object -Unique)
  Platforms = @()
  RuntimeEntries = @()
}
$selectedPackages = @(if ($installAggregate) { $aggregatePackage } else { $selectedBundles })
$buildPackages = @($selectedPackages) + @($selectedCompanions)
$selectedBundleFeatures = @($selectedBundles | ForEach-Object { $_.Feature })
$selectedCompanionFeatures = @($selectedCompanions | ForEach-Object { $_.Feature })
$selectedPackageNames = @($selectedPackages | ForEach-Object { $_.PackageName })
$selectedLabel = if ($installAggregate) { 'all' } else { ($selectedFeatures.Feature -join ',') }
$allFeaturePackageNames = @($catalog | Where-Object { $_.Kind -eq 'bundle' } | ForEach-Object { $_.PackageName })
$retiredPackageNames = @($retiredCatalog | ForEach-Object { $_.PackageNames } | Select-Object -Unique)
$allLegacyPackages = @(
  @($catalog | Where-Object { $_.Kind -eq 'bundle' } | ForEach-Object { $_.LegacyPackages }) + $retiredPackageNames | Select-Object -Unique
)

$target = "DSH profile '$Profile' and selected companion applications"
$action = "build and install enhanced feature set '$selectedLabel' from '$pluginRoot', remove conflicting enhanced/legacy bundles, then validate the profile"
if (-not $PSCmdlet.ShouldProcess($target, $action)) {
  return
}

# Build and validate every selected package before changing the profile. The
# repository prepare builds all feature packages, while the check below fences
# the exact package roots this invocation will install.
Ensure-PluginBuild -RepositoryRoot $pluginRoot -Packages $buildPackages

[string] $executable = ''
[string[]] $prefixArguments = @()
[string] $runnerWorkingDirectory = ''

$dsh = if ($DshCheckout -eq '') {
  Get-Command -Name $DshCommand -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

if ($null -ne $dsh) {
  $executable = $dsh.Source
} else {
  $checkoutCandidate = if ($DshCheckout -ne '') {
    $DshCheckout
  } else {
    Join-Path $PSScriptRoot '..\..\deepseek-harness'
  }
  $checkout = [System.IO.Path]::GetFullPath($checkoutCandidate)
  if (-not (Test-Path -LiteralPath (Join-Path $checkout 'package.json') -PathType Leaf)) {
    throw "Cannot find '$DshCommand' on PATH or a DSH checkout at '$checkout'."
  }

  $pnpm = Get-Command -Name 'pnpm' -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  $executable = $pnpm.Source
  $prefixArguments = @('dsh')
  $runnerWorkingDirectory = $checkout
}

$originalWorkingDirectory = (Get-Location).Path
try {
  if ($runnerWorkingDirectory -ne '') {
    # Corepack selects pnpm before pnpm can process --dir. Enter the DSH
    # checkout first so its packageManager pin controls the selected version.
    Set-Location -LiteralPath $runnerWorkingDirectory
  }

  $installedDependencies = @(
    Get-ProfileDependencies `
      -Executable $executable `
      -PrefixArguments $prefixArguments `
      -ProfileName $Profile
  )
  $installedConfig = Get-ProfileConfig `
    -Executable $executable `
    -PrefixArguments $prefixArguments `
    -ProfileName $Profile
  $installedRetiredPackages = @(
    $retiredPackageNames | Where-Object { $installedDependencies -contains $_ }
  )
  $installedAggregate = $installedDependencies -contains $pluginManifest.name
  if ($installedRetiredPackages.Count -gt 0 -or (Test-RetiredReferencedFileConfig -Config $installedConfig)) {
    Write-Warning (
      "Detected the retired # workspace-file reference feature in profile '$Profile'. " +
      'It will be uninstalled during this migration. Official DSH now supports @ workspace file references; ' +
      'update DSH to the latest release before using the replacement.'
    )
  } elseif ($installedAggregate) {
    Write-Host (
      "Refreshing the installed aggregate bundle also guarantees removal of its former # file-reference contribution. " +
      'Official DSH now supports @ workspace file references; keep DSH updated to the latest release.'
    )
  }

  if ($selectedPackages.Count -gt 0) {
    $packageRoots = @($selectedPackages | ForEach-Object { $_.Root })
    Write-Host "Installing selected DSH bundles for feature set '$selectedLabel' into profile '$Profile'..."
    & $executable @prefixArguments plugin --profile $Profile add @packageRoots --yes
    if ($LASTEXITCODE -ne 0) {
      throw "DSH plugin installation failed for profile '$Profile' with exit code $LASTEXITCODE; existing bundles and companions were not removed."
    }
  } else {
    Write-Host "Feature set '$selectedLabel' contains no DSH bundles to add."
  }

  $dependenciesAfterAdd = @(
    Get-ProfileDependencies `
      -Executable $executable `
      -PrefixArguments $prefixArguments `
      -ProfileName $Profile
  )
  $missingSelected = @(
    $selectedPackages | Where-Object { $dependenciesAfterAdd -notcontains $_.PackageName } | ForEach-Object { $_.PackageName }
  )
  if ($missingSelected.Count -gt 0) {
    throw "DSH reported a successful install, but selected packages are missing from profile '$Profile': $($missingSelected -join ', ')."
  }

  foreach ($companion in $selectedCompanions) {
    switch ($companion.Feature) {
      'windows-launcher' {
        Install-WindowsLauncher `
          -Package $companion `
          -DshExecutable $executable `
          -DshPrefixArguments $prefixArguments `
          -DshRunnerWorkingDirectory $runnerWorkingDirectory `
          -CreateDesktopShortcut:$CreateLauncherDesktopShortcut `
          -SkipSystemIntegration:$SkipLauncherSystemIntegration
        break
      }
      default { throw "No installer owns companion feature '$($companion.Feature)'." }
    }
  }
  $launcherSelected = $selectedCompanionFeatures -contains 'windows-launcher'
  $launcherInstallRoot = Get-WindowsLauncherInstallRoot
  $launcherCurrent = Join-Path $launcherInstallRoot 'current.json'
  $launcherVersions = Join-Path $launcherInstallRoot 'versions'
  if (-not $launcherSelected -and (
    (Test-Path -LiteralPath $launcherCurrent -PathType Leaf) -or
    (Test-Path -LiteralPath $launcherVersions -PathType Container)
  )) {
    Uninstall-WindowsLauncher -SkipSystemIntegration:$SkipLauncherSystemIntegration
  }

  $conflictingPackages = if ($installAggregate) {
    @($allFeaturePackageNames + $allLegacyPackages)
  } else {
    $unselectedFeaturePackages = @(
      $catalog |
        Where-Object { $_.Kind -eq 'bundle' -and $selectedBundleFeatures -notcontains $_.Feature } |
        ForEach-Object { $_.PackageName }
    )
    $selectedLegacyPackages = @(
      $selectedBundles | ForEach-Object { $_.LegacyPackages } | Select-Object -Unique
    )
    @($pluginManifest.name) + $unselectedFeaturePackages + $selectedLegacyPackages + $retiredPackageNames
  }
  $packagesToRemove = @(
    $conflictingPackages |
      Select-Object -Unique |
      Where-Object { $dependenciesAfterAdd -contains $_ -and $selectedPackageNames -notcontains $_ }
  )

  if ($packagesToRemove.Count -gt 0) {
    Write-Host "Removing bundles outside feature set '$selectedLabel': $($packagesToRemove -join ', ')..."
    & $executable @prefixArguments plugin --profile $Profile remove @packagesToRemove --yes
    if ($LASTEXITCODE -ne 0) {
      throw "Selected packages were installed, but removal of conflicting bundles failed for profile '$Profile' with exit code $LASTEXITCODE."
    }
  } else {
    Write-Host "No conflicting enhanced or legacy bundles found in profile '$Profile'."
  }

  $finalDependencies = @(
    Get-ProfileDependencies `
      -Executable $executable `
      -PrefixArguments $prefixArguments `
      -ProfileName $Profile
  )
  $missingSelected = @(
    $selectedPackages | Where-Object { $finalDependencies -notcontains $_.PackageName } | ForEach-Object { $_.PackageName }
  )
  if ($missingSelected.Count -gt 0) {
    throw "Feature migration finished with selected packages missing from profile '$Profile': $($missingSelected -join ', ')."
  }
  $remainingConflicts = @(
    $conflictingPackages |
      Select-Object -Unique |
      Where-Object { $finalDependencies -contains $_ -and $selectedPackageNames -notcontains $_ }
  )
  if ($remainingConflicts.Count -gt 0) {
    throw "Feature migration finished with conflicting bundles still present in profile '$Profile': $($remainingConflicts -join ', ')."
  }

  if ($launcherSelected) {
    $launcherManifest = Get-Content -Raw -LiteralPath $launcherCurrent | ConvertFrom-Json
    if ($launcherManifest.executable -isnot [string] -or -not (Test-Path -LiteralPath $launcherManifest.executable -PathType Leaf)) {
      throw 'Feature migration finished without a valid Windows Launcher installation.'
    }
  } elseif (Test-Path -LiteralPath $launcherCurrent -PathType Leaf) {
    throw 'Feature migration finished with the unselected Windows Launcher still installed.'
  }

  Write-Host 'Validating the assembled DSH profile...'
  $finalConfig = Get-ProfileConfig `
    -Executable $executable `
    -PrefixArguments $prefixArguments `
    -ProfileName $Profile
  if (Test-RetiredReferencedFileConfig -Config $finalConfig) {
    throw "Feature migration finished with the retired # file-reference Loader entry still active in profile '$Profile'."
  }

  Write-Host "Installed enhanced feature set '$selectedLabel' for profile '$Profile'."
  Write-Host 'Use the latest official DSH and type @ in the conversation input for workspace file references.'
} finally {
  if ($runnerWorkingDirectory -ne '') {
    Set-Location -LiteralPath $originalWorkingDirectory
  }
}
