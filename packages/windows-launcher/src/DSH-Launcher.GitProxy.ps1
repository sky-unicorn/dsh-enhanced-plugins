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

function Get-DshSystemProxyEnvironment {
  <#
    Supplies a process-only fallback for DSH, which reads proxy environment
    variables but does not read Windows Internet Settings. Explicit launch or
    DSH-home .env proxy configuration always wins, including rejected values:
    DSH remains responsible for validating it. NO_PROXY stays owned by DSH.
    PAC/WPAD and partial protocol maps cannot be represented faithfully by
    DSH's fixed environment policy; do not guess a proxy from a sample URL.
    The result reason contains no URL, credential, or environment-file value.
  #>
  param(
    [System.Collections.IDictionary] $Environment = [Environment]::GetEnvironmentVariables('Process'),
    [scriptblock] $SettingsProvider = {
      Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    }
  )

  $result = @{ environment = @{}; reason = 'none' }
  foreach ($key in $Environment.Keys) {
    if ([string]$key -imatch '^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$') {
      $result.reason = 'explicit-environment'
      return $result
    }
  }
  $dshHome = [string]$Environment['DSH_HOME']
  if ([string]::IsNullOrWhiteSpace($dshHome)) {
    $userDirectory = [string]$Environment['USERPROFILE']
    if ([string]::IsNullOrWhiteSpace($userDirectory)) { $userDirectory = [Environment]::GetFolderPath('UserProfile') }
    $dshHome = Join-Path $userDirectory '.dsh'
  }
  try {
    $envFile = Join-Path $dshHome '.env'
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
      $contents = [System.IO.File]::ReadAllText($envFile)
      if ($contents -imatch '(?m)^\s*(?:export\s+)?(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)\s*(?:=|:\s)') {
        $result.reason = 'explicit-home-env'
        return $result
      }
    }
    $settings = & $SettingsProvider
    $enabled = $settings.PSObject.Properties['ProxyEnable']
    $server = $settings.PSObject.Properties['ProxyServer']
    $pac = $settings.PSObject.Properties['AutoConfigURL']
    $auto = $settings.PSObject.Properties['AutoDetect']
    if (($null -ne $pac -and -not [string]::IsNullOrWhiteSpace([string]$pac.Value)) -or
      ($null -ne $auto -and [int]$auto.Value -eq 1)) {
      $result.reason = 'automatic-policy'
      return $result
    }
    if ($null -eq $enabled -or [int]$enabled.Value -ne 1 -or $null -eq $server) { return $result }
    $value = ([string]$server.Value).Trim()
    if ([string]::IsNullOrWhiteSpace($value)) { return $result }
    $proxies = @{}
    if ($value -match '^(?i)(http|https|ftp|socks)\s*=') {
      foreach ($entry in $value.Split(';')) {
        if ($entry -match '^\s*(http|https)\s*=\s*(.+?)\s*$') {
          $proxies[$Matches[1].ToLowerInvariant()] = $Matches[2]
        }
      }
    } else {
      $proxies['http'] = $value
      $proxies['https'] = $value
    }
    if (-not $proxies.ContainsKey('http') -or -not $proxies.ContainsKey('https')) {
      $result.reason = 'unsupported-policy'
      return $result
    }
    $resolved = @{}
    foreach ($scheme in @('http', 'https')) {
      $address = [string]$proxies[$scheme]
      if ($address -notmatch '^[a-z][a-z0-9+.-]*://') { $address = 'http://' + $address }
      $uri = $null
      if (-not [Uri]::TryCreate($address, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or [string]::IsNullOrWhiteSpace($uri.Host) -or
        $uri.AbsolutePath -ne '/' -or $uri.Query -ne '' -or $uri.Fragment -ne '') {
        $result.reason = 'unsupported-policy'
        return $result
      }
      $resolved[$scheme.ToUpperInvariant() + '_PROXY'] = $uri.AbsoluteUri
    }
    $result.environment = $resolved
    $result.reason = 'windows-system'
    return $result
  } catch {
    # An unreadable .env must not be outranked by a guessed fallback. Do not
    # expose exceptions: registry and file errors may contain sensitive data.
    $result.reason = 'unavailable'
    return $result
  }
}
