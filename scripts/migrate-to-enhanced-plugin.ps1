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

  [string] $ProjectSourceBinding = '',

  [string[]] $Features = @('all'),

  [switch] $CreateLauncherDesktopShortcut,

  [switch] $SkipLauncherSystemIntegration,

  [switch] $SkipLauncherInstall,

  [switch] $RestartLauncherAfterUpdate,

  [switch] $SkipBuild,

  [switch] $UninstallLauncher,

  [switch] $ListFeatures,

  [switch] $CheckCompatibility
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($CheckCompatibility -and ($UninstallLauncher -or $ListFeatures)) {
  throw '-CheckCompatibility cannot be combined with -UninstallLauncher or -ListFeatures.'
}

function Assert-DshCompatibility {
  param(
    [Parameter(Mandatory = $true)][object] $PluginManifest,
    [Parameter(Mandatory = $true)][string] $Checkout,
    [Parameter(Mandatory = $true)][object[]] $Catalog
  )

  # The aggregate manifest is the release's sole compatibility authority.
  # Check before builds, profile commands, service stops, or companion writes.
  $metadata = $PluginManifest.PSObject.Properties['dshEnhanced']
  $compatibility = if ($null -eq $metadata) { $null } else { $metadata.Value.PSObject.Properties['compatibility'] }
  if ($null -eq $compatibility) {
    throw 'Plugin release has no dshEnhanced.compatibility declaration; cannot safely install it.'
  }
  $versionProperty = $compatibility.Value.PSObject.Properties['dshVersion']
  $commitProperty = $compatibility.Value.PSObject.Properties['sourceCommit']
  if ($null -eq $versionProperty -or $versionProperty.Value -isnot [string] -or
      $versionProperty.Value -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or
      $null -eq $commitProperty -or $commitProperty.Value -isnot [string] -or
      $commitProperty.Value -notmatch '^[0-9a-f]{40}$') {
    throw 'Plugin release has an invalid DSH compatibility declaration.'
  }
  $expectedVersion = [string] $versionProperty.Value
  $expectedCommit = [string] $commitProperty.Value
  foreach ($feature in $Catalog) {
    if ($feature.Manifest.version -ne $PluginManifest.version) {
      throw "Mixed plugin release: '$($feature.PackageName)' is $($feature.Manifest.version), expected $($PluginManifest.version). Re-extract or update the complete plugin release."
    }
  }
  $dshManifestPath = Join-Path $Checkout 'package.json'
  if (-not (Test-Path -LiteralPath $dshManifestPath -PathType Leaf)) {
    throw "Cannot check DSH compatibility: '$dshManifestPath' is missing. Pass -DshCheckout with the DSH source directory."
  }
  $dshManifest = Get-Content -Raw -LiteralPath $dshManifestPath -Encoding UTF8 | ConvertFrom-Json
  $name = $dshManifest.PSObject.Properties['name']
  $version = $dshManifest.PSObject.Properties['version']
  if ($null -eq $name -or $name.Value -ne '@deepseek-ai/dsh-root' -or
      $null -eq $version -or $version.Value -isnot [string]) {
    throw "Cannot identify the DSH source version at '$Checkout'; expected @deepseek-ai/dsh-root."
  }
  if ($version.Value -cne $expectedVersion) {
    throw "Incompatible DSH: plugin $($PluginManifest.version) requires DSH $expectedVersion, but '$Checkout' is $($version.Value). Use the matching DSH release or plugin tag '$($PluginManifest.version)/dsh-$expectedVersion'. Nothing was installed or removed."
  }
  Write-Host "Compatibility OK: plugin $($PluginManifest.version) -> DSH $expectedVersion."

  $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $git -or -not (Test-Path -LiteralPath (Join-Path $Checkout '.git'))) {
    Write-Warning "DSH version matches, but source commit cannot be verified (no Git checkout). Verified commit: $expectedCommit."
    return
  }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $headOutput = @(& $git.Source -C $Checkout rev-parse --verify HEAD 2>&1)
    $headCode = $LASTEXITCODE
    $dirtyOutput = @(& $git.Source -C $Checkout status --porcelain --untracked-files=no 2>&1)
    $dirtyCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $head = ($headOutput -join '').Trim()
  if ($headCode -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
    Write-Warning "DSH version matches, but Git commit could not be read. Verified commit: $expectedCommit."
  } elseif ($head -cne $expectedCommit) {
    Write-Warning "DSH version matches, but commit $head differs from verified $expectedCommit; this source revision is unverified."
  }
  if ($dirtyCode -ne 0) {
    Write-Warning 'DSH source worktree status could not be verified.'
  } elseif ($dirtyOutput.Count -gt 0) {
    Write-Warning 'DSH has local tracked changes; compatibility of those source changes is unverified.'
  }
}

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
      $profileManifest = Get-Content -Raw -LiteralPath $profileManifestPath -Encoding UTF8 | ConvertFrom-Json
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
      $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
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
    return @($Catalog)
  }
  if ($normalized -contains 'none') {
    if ($normalized.Count -ne 1) {
      throw "Feature 'none' cannot be combined with individual feature ids."
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
    Write-Host 'Installing the exact locked dependencies for dsh-enhanced-plugins...'
    & $npm.Source ci --no-audit --no-fund --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed for dsh-enhanced-plugins with exit code $LASTEXITCODE."
    }
    Write-Host 'Running type checks, tests, and all source builds before changing any Profile...'
    & $npm.Source run check
    if ($LASTEXITCODE -ne 0) {
      throw "npm run check failed for dsh-enhanced-plugins with exit code $LASTEXITCODE."
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
      Write-Host 'The full check left runtime entries missing; rebuilding explicitly...'
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
    Write-Host "Replacing the previous Launcher DSH command '$existingCommand' with the validated source-checkout invoker."
  }

  $launcherCommand = $Executable
  $launcherSourceDirectory = ''
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
    $launcherSourceDirectory = $checkout
  }

  $settings | Add-Member -NotePropertyName DshCommand -NotePropertyValue $launcherCommand -Force
  $settings | Add-Member -NotePropertyName DshSourceDirectory -NotePropertyValue $launcherSourceDirectory -Force
  $settingsTemporary = $settingsPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText(
    $settingsTemporary,
    ($settings | ConvertTo-Json -Depth 8),
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $settingsTemporary -Destination $settingsPath -Force
  Write-Host "Configured Windows Launcher to invoke DSH through '$launcherCommand'."
  if (-not [string]::IsNullOrWhiteSpace($launcherSourceDirectory)) {
    Write-Host "Configured Windows Launcher DSH source build root '$launcherSourceDirectory'."
  }
}

function Get-ProjectSourceRevision {
  param([Parameter(Mandatory = $true)][string] $RepositoryRoot)
  $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $git -and (Test-Path -LiteralPath (Join-Path $RepositoryRoot '.git'))) {
    $revision = @(& $git.Source -C $RepositoryRoot rev-parse HEAD 2>$null) -join ''
    $status = @(& $git.Source -C $RepositoryRoot status --porcelain=v1 --untracked-files=normal 2>$null) -join [Environment]::NewLine
    if ($LASTEXITCODE -eq 0 -and $revision -match '^[0-9a-fA-F]{40}$' -and
      [string]::IsNullOrWhiteSpace($status)) {
      return $revision.ToLowerInvariant()
    }
  }
  $installRoot = Get-WindowsLauncherInstallRoot
  $ownedSources = [System.IO.Path]::GetFullPath((Join-Path $installRoot 'sources')).TrimEnd('\') + '\'
  $ownedUpdates = [System.IO.Path]::GetFullPath((Join-Path $installRoot 'updates')).TrimEnd('\') + '\'
  $fullRoot = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\') + '\'
  if ($fullRoot.StartsWith($ownedSources, [System.StringComparison]::OrdinalIgnoreCase) -or
    $fullRoot.StartsWith($ownedUpdates, [System.StringComparison]::OrdinalIgnoreCase)) {
    $markerPath = Join-Path $RepositoryRoot '.dsh-enhanced-source.json'
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
      $marker = Get-Content -Raw -LiteralPath $markerPath -Encoding UTF8 | ConvertFrom-Json
      $markedRevision = [string]$marker.revision
      if ($markedRevision -match '^(?:[0-9a-fA-F]{40}|local-[0-9a-fA-F]{64})$') {
        return $markedRevision.ToLowerInvariant()
      }
    }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $relativePaths = @('package.json', 'package-lock.json', 'build.mjs', 'scripts\migrate-to-enhanced-plugin.ps1') + @(
      Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot 'packages') -File -Recurse | Where-Object {
        $_.FullName -notmatch '[\\/](?:node_modules|lib)[\\/]'
      } | ForEach-Object { $_.FullName.Substring($RepositoryRoot.Length).TrimStart('\') }
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $RepositoryRoot $_) -PathType Leaf }
    foreach ($relative in @($relativePaths | Sort-Object -Unique)) {
      $relativeBytes = [System.Text.Encoding]::UTF8.GetBytes($relative.ToLowerInvariant() + "`n")
      [void]$sha.TransformBlock($relativeBytes, 0, $relativeBytes.Length, $relativeBytes, 0)
      $path = Join-Path $RepositoryRoot $relative
      $bytes = [System.IO.File]::ReadAllBytes($path)
      [void]$sha.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
    }
    [void]$sha.TransformFinalBlock(@(), 0, 0)
    return 'local-' + ([BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant())
  } finally { $sha.Dispose() }
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string] $Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Save-LauncherInstallState {
  param(
    [Parameter(Mandatory = $true)][string] $InstallRoot,
    [Parameter(Mandatory = $true)][string] $DshCheckoutPath,
    [Parameter(Mandatory = $true)][string] $RepositoryRoot,
    [Parameter(Mandatory = $true)][string] $AppliedSourceRoot,
    [Parameter(Mandatory = $true)][string] $ProfileName,
    [Parameter(Mandatory = $true)][object[]] $Catalog,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $DesiredFeatures
  )

  $statePath = Join-Path $InstallRoot 'install-state.json'
  [void](Assert-LauncherOwnedPath -Path $statePath -InstallRoot $InstallRoot)
  $state = if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try { Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json }
    catch {
      $backup = Join-Path $InstallRoot ('install-state.corrupt-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.json')
      [void](Assert-LauncherOwnedPath -Path $backup -InstallRoot $InstallRoot)
      Move-Item -LiteralPath $statePath -Destination $backup
      Write-Warning "The damaged Launcher install state was preserved at '$backup'; recoverable bindings and the current Profile will be rebuilt."
      [pscustomobject][ordered]@{ schemaVersion = 1; profiles = [pscustomobject]@{} }
    }
  } else {
    [pscustomobject][ordered]@{ schemaVersion = 1; profiles = [pscustomobject]@{} }
  }
  $revision = Get-ProjectSourceRevision -RepositoryRoot $AppliedSourceRoot
  $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $isGit = $null -ne $git -and (Test-Path -LiteralPath (Join-Path $RepositoryRoot '.git'))
  $repositoryUrl = ''
  $ref = 'master'
  if ($isGit) {
    $repositoryUrl = @(& $git.Source -C $RepositoryRoot config --get remote.origin.url 2>$null) -join ''
    $branch = @(& $git.Source -C $RepositoryRoot branch --show-current 2>$null) -join ''
    if (-not [string]::IsNullOrWhiteSpace($branch)) { $ref = $branch.Trim() }
  } else {
    $rootManifest = Get-Content -Raw -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Encoding UTF8 | ConvertFrom-Json
    $repositoryProperty = $rootManifest.PSObject.Properties['repository']
    if ($null -ne $repositoryProperty) {
      if ($repositoryProperty.Value -is [string]) { $repositoryUrl = [string]$repositoryProperty.Value }
      else {
        $urlProperty = $repositoryProperty.Value.PSObject.Properties['url']
        if ($null -ne $urlProperty) { $repositoryUrl = [string]$urlProperty.Value }
      }
    }
    $enhanced = $rootManifest.PSObject.Properties['dshEnhanced']
    if ($null -ne $enhanced) {
      $manager = $enhanced.Value.PSObject.Properties['manager']
      if ($null -ne $manager) {
        $defaultRef = $manager.Value.PSObject.Properties['defaultRef']
        if ($null -ne $defaultRef) { $ref = [string]$defaultRef.Value }
      }
    }
  }
  $invoker = Join-Path $InstallRoot 'dsh-checkout-invoker.ps1'
  $dshVersion = ''
  if (Test-Path -LiteralPath $invoker -PathType Leaf) {
    $dshVersion = @(& $invoker --version 2>$null) -join [Environment]::NewLine
  }
  $state | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 1 -Force
  $state | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject][ordered]@{
    mode = 'source'
    checkout = [System.IO.Path]::GetFullPath($DshCheckoutPath)
    invoker = $invoker
    home = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
      Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
    } else { [System.IO.Path]::GetFullPath($env:DSH_HOME) }
    validatedVersion = $dshVersion.Trim()
  }) -Force
  $state | Add-Member -NotePropertyName projectSource -NotePropertyValue ([pscustomobject][ordered]@{
    mode = if ($isGit) { 'git-checkout' } else { 'source-snapshot' }
    boundPath = [System.IO.Path]::GetFullPath($RepositoryRoot)
    repositoryUrl = $repositoryUrl.Trim()
    ref = $ref
    lastSuccessfulRevision = $revision
    lastCheckedRevision = $revision
  }) -Force
  $profilesProperty = $state.PSObject.Properties['profiles']
  if ($null -eq $profilesProperty -or $null -eq $profilesProperty.Value) {
    $state | Add-Member -NotePropertyName profiles -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $profileValue = [pscustomobject][ordered]@{
    managed = $true
    desiredFeatures = @($DesiredFeatures | Sort-Object -Unique)
    knownFeatures = @($Catalog | Where-Object { $_.Kind -eq 'bundle' } | ForEach-Object { $_.Feature } | Sort-Object -Unique)
    lastAppliedRevision = $revision
    lastAppliedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  $state.profiles | Add-Member -NotePropertyName $ProfileName -NotePropertyValue $profileValue -Force
  $currentPath = Join-Path $InstallRoot 'current.json'
  $current = if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
    Get-Content -Raw -LiteralPath $currentPath -Encoding UTF8 | ConvertFrom-Json
  } else { $null }
  $state | Add-Member -NotePropertyName launcher -NotePropertyValue ([pscustomobject][ordered]@{
    required = $true
    lastAppliedRevision = $revision
    executableSha256 = if ($null -eq $current) { '' } else { [string]$current.hash }
  }) -Force
  $temporary = $statePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
  Write-Host "Recorded Launcher source and Profile state at '$statePath'."
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

    [switch] $SkipSystemIntegration,

    [switch] $RestartAfterUpdate
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
  $hash = Get-FileSha256 -Path $executableSource.FullName
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
  $previousCurrent = $null
  $previousCurrentJson = $null
  if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
    try {
      $previousCurrentJson = Get-Content -Raw -LiteralPath $currentPath -Encoding UTF8
      $previousCurrent = $previousCurrentJson | ConvertFrom-Json
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
  if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $installRoot)
  }
  $currentTemporary = $currentPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $launcherChanged = $null -ne $previousExecutable -and
    -not $previousExecutable.Equals($executable, [System.StringComparison]::OrdinalIgnoreCase)
  $previousVersionRoot = if ($launcherChanged) {
    Split-Path -Parent $previousExecutable
  } elseif ($null -ne $previousCurrent -and $previousCurrent.PSObject.Properties['previousVersionRoot']) {
    [string]$previousCurrent.previousVersionRoot
  } else { '' }
  $previousHash = if ($launcherChanged -and $null -ne $previousCurrent -and $previousCurrent.PSObject.Properties['hash']) {
    [string]$previousCurrent.hash
  } elseif ($null -ne $previousCurrent -and $previousCurrent.PSObject.Properties['previousHash']) {
    [string]$previousCurrent.previousHash
  } else { '' }
  $previousRollbackExecutable = if ([string]::IsNullOrWhiteSpace($previousVersionRoot)) { '' }
    else { Join-Path $previousVersionRoot 'DSH-Launcher.exe' }
  $currentDocument = [ordered]@{
    version = $version
    hash = $hash
    versionRoot = $versionRoot
    executable = $executable
    previousVersionRoot = $previousVersionRoot
    previousExecutable = $previousRollbackExecutable
    previousHash = $previousHash
    installedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText(
    $currentTemporary,
    ($currentDocument | ConvertTo-Json),
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
      $quotedOwnedPrefix = '"' + $installRoot + '\'
      $plainOwnedPrefix = $installRoot + '\'
      if ($existingValue.StartsWith($quotedOwnedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        $existingValue.StartsWith($plainOwnedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $startupArguments = if ($existingValue -match '(?i)(?:^|\s)--start-dsh(?:\s|$)') {
          ' --tray --start-dsh'
        } else {
          ' --tray'
        }
        Set-ItemProperty -Path $runKey -Name $runName -Value ('"' + $executable + '"' + $startupArguments)
      } else {
        Write-Warning "Preserved an unowned '$runName' login-startup entry."
      }
    }
  }

  if ($launcherChanged -and $RestartAfterUpdate) {
    $readyPath = Join-Path $versionRoot ('.ready-' + [Guid]::NewGuid().ToString('N') + '.txt')
    [void](Assert-LauncherOwnedPath -Path $readyPath -InstallRoot $installRoot)
    try {
      $newLauncher = Start-Process -FilePath $executable `
        -ArgumentList @('--activate-update', '--tray', '--ready-file', ('"' + $readyPath + '"')) `
        -PassThru
      # The candidate may spend up to 15 seconds waiting for the previous
      # singleton to release its mutex; leave additional time for tray setup.
      $readyDeadline = [DateTime]::UtcNow.AddSeconds(20)
      do {
        Start-Sleep -Milliseconds 200
        $ready = Test-Path -LiteralPath $readyPath -PathType Leaf
      } while (-not $ready -and -not $newLauncher.HasExited -and [DateTime]::UtcNow -lt $readyDeadline)
      if ($ready -and -not $newLauncher.HasExited) {
        # Readiness is emitted after the replacement tray/context is created.
        # Require a short stable interval so an immediately terminating UI
        # process cannot leave behind a successful update and a shell ghost.
        Start-Sleep -Seconds 2
        $newLauncher.Refresh()
      }
      if ($newLauncher.HasExited -or -not $ready) {
        $code = if ($newLauncher.HasExited) { [string]$newLauncher.ExitCode } else {
          try {
            $newLauncher.Kill()
            [void]$newLauncher.WaitForExit(3000)
          } catch {
            Write-Warning "Unable to stop the failed Windows Launcher candidate: $($_.Exception.Message)"
          }
          'still running without readiness signal'
        }
        throw "The new Windows Launcher failed its readiness check: $code."
      }
      $newLauncher.Dispose()
      Write-Host 'Started the updated Windows Launcher and completed the readiness check.'
    } catch {
      $launchFailure = $_.Exception.Message
      if (-not [string]::IsNullOrWhiteSpace($previousCurrentJson) -and
        -not [string]::IsNullOrWhiteSpace($previousExecutable) -and
        (Test-Path -LiteralPath $previousExecutable -PathType Leaf)) {
        $rollbackTemporary = $currentPath + '.' + [Guid]::NewGuid().ToString('N') + '.rollback'
        [System.IO.File]::WriteAllText($rollbackTemporary, $previousCurrentJson, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $rollbackTemporary -Destination $currentPath -Force
        if (-not $SkipSystemIntegration) {
          New-WindowsLauncherShortcut -Executable $previousExecutable -Path $startShortcut
          if ($CreateDesktopShortcut) { New-WindowsLauncherShortcut -Executable $previousExecutable -Path $desktopShortcut }
          $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
          $runName = 'DeepSeekHarnessLauncher'
          $existing = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
          if ($null -ne $existing) {
            $startupArguments = if ([string]$existing.$runName -match '(?i)(?:^|\s)--start-dsh(?:\s|$)') {
              ' --tray --start-dsh'
            } else { ' --tray' }
            Set-ItemProperty -Path $runKey -Name $runName -Value ('"' + $previousExecutable + '"' + $startupArguments)
          }
        }
        [void](Start-Process -FilePath $previousExecutable -ArgumentList '--tray')
      }
      throw "The Windows Launcher update was rolled back: $launchFailure"
    } finally {
      if (Test-Path -LiteralPath $readyPath -PathType Leaf) { Remove-Item -LiteralPath $readyPath -Force }
    }
  } elseif ($launcherChanged) {
    Write-Host 'Installed the updated Windows Launcher without starting it; the new version will be used the next time Launcher starts.'
  }

  foreach ($oldVersion in @(Get-ChildItem -LiteralPath $versionsRoot -Directory -Force)) {
    if ($oldVersion.FullName.Equals($versionRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not [string]::IsNullOrWhiteSpace($previousVersionRoot) -and
      $oldVersion.FullName.Equals($previousVersionRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
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
      $current = Get-Content -Raw -LiteralPath $currentPath -Encoding UTF8 | ConvertFrom-Json
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

$pluginManifest = Get-Content -Raw -LiteralPath $pluginManifestPath -Encoding UTF8 | ConvertFrom-Json
if ($pluginManifest.name -ne 'dsh-enhanced-plugins') {
  throw "Expected dsh-enhanced-plugins at '$pluginRoot', found '$($pluginManifest.name)'."
}

$catalog = @(Get-FeatureCatalog -RepositoryRoot $pluginRoot)
$retiredCatalog = @(Get-RetiredFeatureCatalog -Manifest $pluginManifest)
if ($UninstallLauncher) {
  if ($PSCmdlet.ShouldProcess('Windows Launcher companion', 'stop and remove Launcher program files and system integration')) {
    Uninstall-WindowsLauncher -SkipSystemIntegration:$SkipLauncherSystemIntegration
  }
  return
}
if ($ListFeatures) {
  Write-Output "all`tInstall every independent Profile feature and the required Windows Launcher."
  Write-Output "none`tRemove every Profile feature from this project while keeping the required Windows Launcher."
  foreach ($feature in $catalog) {
    Write-Output "$($feature.Feature)`t$($feature.Description)"
  }
  return
}

$checkoutCandidate = if ($DshCheckout -ne '') { $DshCheckout }
  else { Join-Path $pluginRoot '..\deepseek-harness' }
$checkout = [System.IO.Path]::GetFullPath($checkoutCandidate)
Assert-DshCompatibility -PluginManifest $pluginManifest -Checkout $checkout -Catalog $catalog
if ($CheckCompatibility) { return }

$requestedFeatures = @(
  Resolve-RequestedFeatures -Catalog $catalog -RetiredCatalog $retiredCatalog -Requested $Features
)
$requiredCompanions = @($catalog | Where-Object { $_.Kind -eq 'companion' -and $_.Feature -eq 'windows-launcher' })
if ($requiredCompanions.Count -ne 1) {
  throw 'The catalog must contain exactly one required windows-launcher companion.'
}
$requestedFeatureIds = @($requestedFeatures | ForEach-Object { $_.Feature })
$selectedFeatures = @($requestedFeatures) + @(
  $requiredCompanions | Where-Object { $requestedFeatureIds -notcontains $_.Feature }
)
$selectedBundles = @($selectedFeatures | Where-Object { $_.Kind -eq 'bundle' })
$selectedCompanions = @($selectedFeatures | Where-Object { $_.Kind -eq 'companion' })
$selectedPackages = @($selectedBundles)
$buildPackages = @($selectedPackages) + @($selectedCompanions)
$selectedBundleFeatures = @($selectedBundles | ForEach-Object { $_.Feature })
$selectedCompanionFeatures = @($selectedCompanions | ForEach-Object { $_.Feature })
$selectedPackageNames = @($selectedPackages | ForEach-Object { $_.PackageName })
$selectedLabel = if ($selectedBundleFeatures.Count -eq 0) { 'none (+required windows-launcher)' }
  else { ($selectedFeatures.Feature -join ',') }
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
if (-not $SkipBuild) {
  Ensure-PluginBuild -RepositoryRoot $pluginRoot -Packages $buildPackages
} else {
  $missingPreparedEntries = @()
  foreach ($package in $buildPackages) {
    $missingPreparedEntries += @(Get-MissingRuntimeEntries -PackageRoot $package.Root -Manifest $package.Manifest |
      ForEach-Object { "$($package.PackageName):$_" })
  }
  if ($missingPreparedEntries.Count -gt 0) {
    throw "The external coordinator marked the source as built, but runtime entries are missing: $($missingPreparedEntries -join ', ')."
  }
}

[string] $executable = ''
[string[]] $prefixArguments = @()
[string] $runnerWorkingDirectory = ''

foreach ($requiredDshPath in @(
  'package.json',
  'tsconfig.json',
  'apps\cli\src\bin.ts',
  'node_modules\tsx\dist\esm\index.mjs'
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $checkout $requiredDshPath) -PathType Leaf)) {
    throw "The DSH source checkout at '$checkout' is missing '$requiredDshPath'. First-version plugin management only supports a prepared local DSH checkout."
  }
}
$pnpm = Get-Command -Name 'pnpm' -CommandType Application -ErrorAction Stop | Select-Object -First 1
$executable = $pnpm.Source
$prefixArguments = @('dsh')
$runnerWorkingDirectory = $checkout

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

  $launcherSelected = $selectedCompanionFeatures -contains 'windows-launcher'
  $launcherInstallRoot = Get-WindowsLauncherInstallRoot
  $launcherCurrent = Join-Path $launcherInstallRoot 'current.json'
  $launcherVersions = Join-Path $launcherInstallRoot 'versions'

  $unselectedFeaturePackages = @(
    $catalog |
      Where-Object { $_.Kind -eq 'bundle' -and $selectedBundleFeatures -notcontains $_.Feature } |
      ForEach-Object { $_.PackageName }
  )
  $selectedLegacyPackages = @(
    $selectedBundles | ForEach-Object { $_.LegacyPackages } | Select-Object -Unique
  )
  $conflictingPackages = @($pluginManifest.name) + $unselectedFeaturePackages + $selectedLegacyPackages + $retiredPackageNames
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

  Write-Host 'Validating the assembled DSH profile...'
  $finalConfig = Get-ProfileConfig `
    -Executable $executable `
    -PrefixArguments $prefixArguments `
    -ProfileName $Profile
  if (Test-RetiredReferencedFileConfig -Config $finalConfig) {
    throw "Feature migration finished with the retired # file-reference Loader entry still active in profile '$Profile'."
  }

  if (-not $SkipLauncherInstall) {
    foreach ($companion in $selectedCompanions) {
      switch ($companion.Feature) {
        'windows-launcher' {
          Install-WindowsLauncher `
            -Package $companion `
            -DshExecutable $executable `
            -DshPrefixArguments $prefixArguments `
            -DshRunnerWorkingDirectory $runnerWorkingDirectory `
            -CreateDesktopShortcut:$CreateLauncherDesktopShortcut `
            -SkipSystemIntegration:$SkipLauncherSystemIntegration `
            -RestartAfterUpdate:$RestartLauncherAfterUpdate
          break
        }
        default { throw "No installer owns companion feature '$($companion.Feature)'." }
      }
    }
  }
  if ($launcherSelected) {
    $launcherManifest = Get-Content -Raw -LiteralPath $launcherCurrent -Encoding UTF8 | ConvertFrom-Json
    if ($launcherManifest.executable -isnot [string] -or -not (Test-Path -LiteralPath $launcherManifest.executable -PathType Leaf)) {
      throw 'Feature migration finished without a valid Windows Launcher installation.'
    }
  }

  Save-LauncherInstallState `
    -InstallRoot (Get-WindowsLauncherInstallRoot) `
    -DshCheckoutPath $checkout `
    -RepositoryRoot $(if ([string]::IsNullOrWhiteSpace($ProjectSourceBinding)) {
      $pluginRoot
    } else { [System.IO.Path]::GetFullPath($ProjectSourceBinding) }) `
    -AppliedSourceRoot $pluginRoot `
    -ProfileName $Profile `
    -Catalog $catalog `
    -DesiredFeatures $selectedBundleFeatures

  Write-Host "Installed enhanced feature set '$selectedLabel' for profile '$Profile'."
  Write-Host 'Use the compatible official DSH release and type @ in the conversation input for workspace file references.'
} finally {
  if ($runnerWorkingDirectory -ne '') {
    Set-Location -LiteralPath $originalWorkingDirectory
  }
}
