#Requires -Version 5.1
# Data only: remote compatibility never supplies executable code or install URLs.

function Assert-CompatibilityDocument {
  param([object] $Document)
  $versionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
  if ($Document -isnot [pscustomobject] -or
      $null -eq $Document.PSObject.Properties['schemaVersion'] -or
      $Document.schemaVersion -isnot [int] -or $Document.schemaVersion -ne 1 -or
      $null -eq $Document.PSObject.Properties['releases'] -or $Document.releases -isnot [array]) {
    throw 'Invalid compatibility document: expected schemaVersion 1 and releases array.'
  }
  $plugins = @()
  foreach ($release in $Document.releases) {
    if ($release -isnot [pscustomobject] -or
        $null -eq $release.PSObject.Properties['pluginVersion'] -or
        $release.pluginVersion -isnot [string] -or $release.pluginVersion -cnotmatch $versionPattern -or
        $plugins -ccontains $release.pluginVersion -or
        $null -eq $release.PSObject.Properties['dsh'] -or $release.dsh -isnot [array]) {
      throw 'Invalid compatibility release: expected a unique exact pluginVersion and dsh array.'
    }
    $plugins += $release.pluginVersion
    $versions = @()
    foreach ($target in $release.dsh) {
      if ($target -isnot [pscustomobject] -or
          $null -eq $target.PSObject.Properties['version'] -or
          $target.version -isnot [string] -or $target.version -cnotmatch $versionPattern -or
          $versions -ccontains $target.version -or
          $null -eq $target.PSObject.Properties['commits'] -or $target.commits -isnot [array] -or
          $target.commits.Count -eq 0) {
        throw 'Invalid compatibility target: expected a unique exact DSH version and nonempty commits array.'
      }
      $versions += $target.version
      $commits = @()
      foreach ($commit in $target.commits) {
        if ($commit -isnot [string] -or $commit -cnotmatch '^[0-9a-f]{40}$' -or $commits -ccontains $commit) {
          throw 'Invalid compatibility commits: expected unique lowercase full Git hashes.'
        }
        $commits += $commit
      }
    }
  }
}

function Get-RemoteCompatibilityDocument {
  param([Parameter(Mandatory = $true)][string] $Url)
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref] $uri) -or
      ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) -or
      $uri.UserInfo -ne '' -or $uri.Fragment -ne '') {
    throw 'Compatibility URL must use HTTPS (HTTP is allowed only for a local test server), without credentials or fragment.'
  }
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  if ($uri.IsLoopback) { $handler.UseProxy = $false }
  $client = New-Object System.Net.Http.HttpClient($handler)
  $cancellation = New-Object System.Threading.CancellationTokenSource
  $response = $null
  $stream = $null
  $buffered = New-Object System.IO.MemoryStream
  $oldProtocols = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $oldProtocols -bor [Net.SecurityProtocolType]::Tls12
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('dsh-enhanced-plugins-compatibility/1')
    $client.DefaultRequestHeaders.CacheControl = New-Object System.Net.Http.Headers.CacheControlHeaderValue
    $client.DefaultRequestHeaders.CacheControl.NoCache = $true
    $cancellation.CancelAfter(8000)
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $request = $client.GetAsync($uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token)
    if (-not $request.Wait(8000)) { throw 'Compatibility download timed out.' }
    $response = $request.GetAwaiter().GetResult()
    if ([int] $response.StatusCode -ne 200) { throw "Compatibility download returned HTTP $([int] $response.StatusCode)." }
    $limit = 1MB
    if ($response.Content.Headers.ContentLength -gt $limit) { throw 'Compatibility document exceeds 1 MiB.' }
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $buffer = New-Object byte[] 8192
    do {
      $remaining = [int] [Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token)
      if (-not $read.Wait($remaining)) { throw 'Compatibility download timed out.' }
      $count = $read.GetAwaiter().GetResult()
      if ($buffered.Length + $count -gt $limit) { throw 'Compatibility document exceeds 1 MiB.' }
      $buffered.Write($buffer, 0, $count)
    } while ($count -gt 0)
    $json = [Text.Encoding]::UTF8.GetString($buffered.ToArray())
    $document = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    Assert-CompatibilityDocument $document
    return $document
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    $buffered.Dispose()
    $cancellation.Dispose()
    $client.Dispose()
    [Net.ServicePointManager]::SecurityProtocol = $oldProtocols
  }
}

function Resolve-DshCompatibility {
  param(
    [Parameter(Mandatory = $true)][string] $RepositoryRoot,
    [Parameter(Mandatory = $true)][string] $PluginVersion,
    [Parameter(Mandatory = $true)][string] $DshVersion
  )
  $url = 'https://raw.githubusercontent.com/sky-unicorn/dsh-enhanced-plugins/master/dsh-compatibility.json'
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_COMPATIBILITY_URL)) { $url = $env:DSH_COMPATIBILITY_URL }
  try {
    $document = Get-RemoteCompatibilityDocument $url
    $remoteRelease = @($document.releases | Where-Object { $_.pluginVersion -ceq $PluginVersion })
    if ($remoteRelease.Count -eq 1 -and
        @($remoteRelease[0].dsh | Where-Object { $_.version -ceq $DshVersion }).Count -eq 1) {
      Write-Host 'Compatibility source: remote (latest compatibility document).'
      return $remoteRelease[0]
    }
    Write-Warning 'Remote compatibility document has no matching plugin/DSH version; checking bundled dsh-compatibility.json.'
  } catch {
    # Do not log the response body, URL query, credentials, or transport exception.
    Write-Warning 'Remote compatibility document is unavailable or invalid; using bundled dsh-compatibility.json.'
  }
  $path = Join-Path $RepositoryRoot 'dsh-compatibility.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'Bundled dsh-compatibility.json is missing. Nothing was installed or removed.'
  }
  $document = Get-Content -Raw -LiteralPath $path -Encoding UTF8 | ConvertFrom-Json
  Assert-CompatibilityDocument $document
  Write-Host 'Compatibility source: bundled dsh-compatibility.json.'
  $release = @($document.releases | Where-Object { $_.pluginVersion -ceq $PluginVersion })
  if ($release.Count -ne 1 -or $release[0].dsh.Count -eq 0) {
    throw "No supported DSH versions for plugin $PluginVersion in either compatibility document. Nothing was installed or removed."
  }
  return $release[0]
}
