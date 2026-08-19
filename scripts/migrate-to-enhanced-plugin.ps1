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

  [string] $PluginPath = ''
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
    [string] $PluginRoot,

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
    $entryPath = Join-Path $PluginRoot $target.Substring(2)
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
      $target
    }
  }
}

function Ensure-PluginBuild {
  param(
    [Parameter(Mandatory = $true)]
    [string] $PluginRoot,

    [Parameter(Mandatory = $true)]
    [object] $Manifest
  )

  $npm = Get-Command -Name 'npm' -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  $originalDirectory = (Get-Location).Path
  try {
    Set-Location -LiteralPath $PluginRoot
    Write-Host "Preparing dsh-enhanced-plugins and its runtime entries..."
    & $npm.Source install --no-audit --no-fund --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed for dsh-enhanced-plugins with exit code $LASTEXITCODE."
    }
  } finally {
    Set-Location -LiteralPath $originalDirectory
  }

  $missingEntries = @(Get-MissingRuntimeEntries -PluginRoot $PluginRoot -Manifest $Manifest)
  if ($missingEntries.Count -gt 0) {
    try {
      Set-Location -LiteralPath $PluginRoot
      Write-Host "prepare left runtime entries missing; rebuilding explicitly..."
      & $npm.Source run build
      if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed for dsh-enhanced-plugins with exit code $LASTEXITCODE."
      }
    } finally {
      Set-Location -LiteralPath $originalDirectory
    }
    $missingEntries = @(Get-MissingRuntimeEntries -PluginRoot $PluginRoot -Manifest $Manifest)
  }

  if ($missingEntries.Count -gt 0) {
    throw "dsh-enhanced-plugins build completed without required runtime entries: $($missingEntries -join ', ')."
  }
}

# The dsh-sub-agent source repository publishes this package name.
$legacyPackages = @(
  'dsh-mcp-server-manager'
  'dsh-plugin-market'
  'dsh-referenced-file'
  'dsh-sub-agent-toggle'
)

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

$packageList = $legacyPackages -join ', '
$target = "DSH profile '$Profile'"
$action = "prepare dsh-enhanced-plugins, remove legacy plugins ($packageList), then install and validate it from '$pluginRoot'"

if (-not $PSCmdlet.ShouldProcess($target, $action)) {
  return
}

# Build and validate before changing the profile so a missing local lib cannot
# leave DSH pointing at a partially installed bundle.
Ensure-PluginBuild -PluginRoot $pluginRoot -Manifest $pluginManifest

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
$packagesToRemove = @(
  $legacyPackages | Where-Object { $installedDependencies -contains $_ }
)

if ($packagesToRemove.Count -gt 0) {
  Write-Host "Removing installed legacy plugins from profile '$Profile': $($packagesToRemove -join ', ')..."
  & $executable @prefixArguments plugin --profile $Profile remove @packagesToRemove --yes

  if ($LASTEXITCODE -ne 0) {
    throw "DSH plugin removal failed for profile '$Profile' with exit code $LASTEXITCODE."
  }
} else {
  Write-Host "No removable legacy plugin dependencies found in profile '$Profile'; continuing with installation."
}

Write-Host "Installing dsh-enhanced-plugins from '$pluginRoot'..."
& $executable @prefixArguments plugin --profile $Profile add $pluginRoot --yes

if ($LASTEXITCODE -ne 0) {
  throw "Legacy plugins were removed, but dsh-enhanced-plugins installation failed for profile '$Profile' with exit code $LASTEXITCODE. Retry from '$pluginRoot'."
}

$finalDependencies = @(
  Get-ProfileDependencies `
    -Executable $executable `
    -PrefixArguments $prefixArguments `
    -ProfileName $Profile
)
if ($finalDependencies -notcontains 'dsh-enhanced-plugins') {
  throw "DSH reported a successful install, but dsh-enhanced-plugins is not a direct dependency of profile '$Profile'."
}
$remainingLegacyPackages = @(
  $legacyPackages | Where-Object { $finalDependencies -contains $_ }
)
if ($remainingLegacyPackages.Count -gt 0) {
  throw "Migration finished with legacy dependencies still present in profile '$Profile': $($remainingLegacyPackages -join ', ')."
}

Write-Host "Validating the assembled DSH profile..."
& $executable @prefixArguments --profile $Profile --dump-config | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "dsh-enhanced-plugins is installed, but DSH failed to load profile '$Profile' with exit code $LASTEXITCODE."
}

Write-Host "Migrated profile '$Profile' to dsh-enhanced-plugins."
} finally {
  if ($runnerWorkingDirectory -ne '') {
    Set-Location -LiteralPath $originalWorkingDirectory
  }
}
