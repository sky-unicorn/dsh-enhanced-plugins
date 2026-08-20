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
  $dependenciesProperty = $profileInventory.PSObject.Properties['dependencies']
  if ($null -eq $dependenciesProperty) {
    return
  }

  $dependenciesProperty.Value.PSObject.Properties | ForEach-Object { $_.Name }
}

function Get-MissingRuntimeEntries {
  param(
    [Parameter(Mandatory = $true)]
    [string] $PackageRoot,

    [Parameter(Mandatory = $true)]
    [object] $Manifest
  )

  $runtimeTargets = @($Manifest.main)
  $runtimeTargets += @(
    $Manifest.exports.PSObject.Properties |
      ForEach-Object { $_.Value } |
      Where-Object { $_ -is [string] -and $_.StartsWith('./lib/', [System.StringComparison]::Ordinal) }
  )

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
      [pscustomobject]@{
        Feature = $feature.Value
        PackageName = $manifest.name
        Root = $_.FullName
        Manifest = $manifest
        Description = $manifest.description
        LegacyPackages = @($metadata.Value.legacyPackages)
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
if ($ListFeatures) {
  Write-Output "all`tInstall the aggregate bundle with every feature."
  foreach ($feature in $catalog) {
    Write-Output "$($feature.Feature)`t$($feature.Description)"
  }
  return
}

$selectedFeatures = @(Resolve-RequestedFeatures -Catalog $catalog -Requested $Features)
$installAggregate = $selectedFeatures.Count -eq 0
$aggregatePackage = [pscustomobject]@{
  Feature = 'all'
  PackageName = $pluginManifest.name
  Root = $pluginRoot
  Manifest = $pluginManifest
  Description = $pluginManifest.description
  LegacyPackages = @($catalog | ForEach-Object { $_.LegacyPackages } | Select-Object -Unique)
}
$selectedPackages = if ($installAggregate) { @($aggregatePackage) } else { @($selectedFeatures) }
$selectedLabel = if ($installAggregate) { 'all' } else { ($selectedFeatures.Feature -join ',') }
$allFeaturePackageNames = @($catalog | ForEach-Object { $_.PackageName })
$allLegacyPackages = @($catalog | ForEach-Object { $_.LegacyPackages } | Select-Object -Unique)

$target = "DSH profile '$Profile'"
$action = "build and install enhanced feature set '$selectedLabel' from '$pluginRoot', remove conflicting enhanced/legacy bundles, then validate the profile"
if (-not $PSCmdlet.ShouldProcess($target, $action)) {
  return
}

# Build and validate every selected package before changing the profile. The
# repository prepare builds all feature packages, while the check below fences
# the exact package roots this invocation will install.
Ensure-PluginBuild -RepositoryRoot $pluginRoot -Packages $selectedPackages

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

  $packageRoots = @($selectedPackages | ForEach-Object { $_.Root })
  Write-Host "Installing enhanced feature set '$selectedLabel' into profile '$Profile'..."
  & $executable @prefixArguments plugin --profile $Profile add @packageRoots --yes
  if ($LASTEXITCODE -ne 0) {
    throw "DSH plugin installation failed for profile '$Profile' with exit code $LASTEXITCODE; existing bundles were not removed."
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

  $conflictingPackages = if ($installAggregate) {
    @($allFeaturePackageNames + $allLegacyPackages)
  } else {
    $unselectedFeaturePackages = @(
      $catalog | Where-Object { $selectedFeatures.Feature -notcontains $_.Feature } | ForEach-Object { $_.PackageName }
    )
    $selectedLegacyPackages = @(
      $selectedFeatures | ForEach-Object { $_.LegacyPackages } | Select-Object -Unique
    )
    @($pluginManifest.name) + $unselectedFeaturePackages + $selectedLegacyPackages
  }
  $packagesToRemove = @(
    $conflictingPackages |
      Select-Object -Unique |
      Where-Object { $dependenciesAfterAdd -contains $_ -and $selectedPackages.PackageName -notcontains $_ }
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
      Where-Object { $finalDependencies -contains $_ -and $selectedPackages.PackageName -notcontains $_ }
  )
  if ($remainingConflicts.Count -gt 0) {
    throw "Feature migration finished with conflicting bundles still present in profile '$Profile': $($remainingConflicts -join ', ')."
  }

  Write-Host 'Validating the assembled DSH profile...'
  & $executable @prefixArguments --profile $Profile --dump-config | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Enhanced feature set '$selectedLabel' is installed, but DSH failed to load profile '$Profile' with exit code $LASTEXITCODE."
  }

  Write-Host "Installed enhanced feature set '$selectedLabel' in profile '$Profile'."
} finally {
  if ($runnerWorkingDirectory -ne '') {
    Set-Location -LiteralPath $originalWorkingDirectory
  }
}
