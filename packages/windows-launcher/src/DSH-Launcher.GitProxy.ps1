#Requires -Version 5.1

Set-StrictMode -Version Latest

function Invoke-GitQuery {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Command,

    [Parameter(Mandatory = $true)]
    [string[]] $Arguments
  )

  $originalErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 promotes native stderr to ErrorRecord objects.
    # These best-effort discovery calls must not block the real pull.
    $ErrorActionPreference = 'Continue'
    $lines = @(& $Command @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
  } catch {
    return ''
  } finally {
    $ErrorActionPreference = $originalErrorActionPreference
  }
  if ($exitCode -ne 0) { return '' }
  return (($lines | ForEach-Object { [string] $_ }) -join "`n").Trim()
}

function Get-GitPullTargetUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Command,

    [Parameter(Mandatory = $true)]
    [string] $WorkingDirectory
  )

  $branch = Invoke-GitQuery $Command @('-C', $WorkingDirectory, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  $remote = ''
  if (-not [string]::IsNullOrWhiteSpace($branch)) {
    $remote = Invoke-GitQuery $Command @('-C', $WorkingDirectory, 'config', '--get', "branch.$branch.remote")
    if ($remote -eq '.') { return '' }
  }
  if ([string]::IsNullOrWhiteSpace($remote)) { $remote = 'origin' }
  return Invoke-GitQuery $Command @('-C', $WorkingDirectory, 'remote', 'get-url', $remote)
}

function Resolve-SystemGitProxy {
  param(
    [Parameter(Mandatory = $true)]
    [AllowNull()]
    [AllowEmptyString()]
    [string] $TargetUrl,

    [scriptblock] $ProxyFactory = { [System.Net.WebRequest]::GetSystemWebProxy() }
  )

  try {
    $target = $null
    if (-not [Uri]::TryCreate($TargetUrl, [UriKind]::Absolute, [ref] $target) -or
      $target.Scheme -notin @('http', 'https')) { return $null }

    $systemProxy = & $ProxyFactory
    if ($null -eq $systemProxy -or $systemProxy.IsBypassed($target)) { return $null }
    $proxy = $systemProxy.GetProxy($target)
    if ($null -eq $proxy -or $proxy.AbsoluteUri -eq $target.AbsoluteUri -or
      $proxy.Scheme -notin @('http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h')) {
      return $null
    }
    return $proxy.AbsoluteUri
  } catch {
    # Proxy discovery is advisory. A malformed or unavailable system proxy
    # must not prevent Git from attempting its normal direct/configured path.
    return $null
  }
}
