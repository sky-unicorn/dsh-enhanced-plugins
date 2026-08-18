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
$action = "remove legacy plugins ($packageList), then install dsh-enhanced-plugins from '$pluginRoot'"

if (-not $PSCmdlet.ShouldProcess($target, $action)) {
  return
}

[string] $executable = ''
[string[]] $prefixArguments = @()

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
  $prefixArguments = @('--dir', $checkout, 'dsh')
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

Write-Host "Migrated profile '$Profile' to dsh-enhanced-plugins."
