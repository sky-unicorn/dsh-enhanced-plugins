#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Catalog', 'Snapshot', 'CheckUpdate', 'Bind', 'ImportZip', 'Plan', 'Apply')]
  [string] $Operation,

  [string] $RepositoryRoot = '',

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string] $Profile = 'web',

  [string] $RequestPath = '',

  [Parameter(Mandatory = $true)]
  [string] $OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

function Get-LauncherRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_HARNESS_LAUNCHER_HOME)) {
    return [System.IO.Path]::GetFullPath($env:DEEPSEEK_HARNESS_LAUNCHER_HOME).TrimEnd('\')
  }
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable.' }
  [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\Launcher')).TrimEnd('\')
}

function Assert-OwnedPath {
  param([string] $Path, [string] $Root)
  $owner = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidate = [System.IO.Path]::GetFullPath($Path)
  if (-not $candidate.StartsWith($owner + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside '$owner': '$candidate'."
  }
  $candidate
}

function Read-JsonFile {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "Cannot read JSON '$Path': $($_.Exception.Message)" }
}

function Read-InstallState {
  param([string] $Path, [string] $LauncherRoot)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Read-JsonFile $Path }
  catch {
    $backup = Join-Path $LauncherRoot ('install-state.corrupt-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.json')
    [void](Assert-OwnedPath $backup $LauncherRoot)
    Move-Item -LiteralPath $Path -Destination $backup
    return [pscustomobject][ordered]@{
      schemaVersion = 1
      profiles = [pscustomobject]@{}
      recovery = [pscustomobject][ordered]@{
        required = $true
        backupPath = $backup
        message = '安装状态文件已损坏；可恢复文件已备份，请重新绑定项目源码。Profile 实际状态将从 DSH inventory 读取。'
      }
    }
  }
}

function Write-JsonFile {
  param([string] $Path, [object] $Value)
  $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $directory)
  }
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 16), $Utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-OptionalProperty {
  param([object] $Value, [string] $Name, $Default = $null)
  if ($null -eq $Value) { return $Default }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  $property.Value
}

function Resolve-RepositoryRoot {
  param([string] $ExplicitRoot, [object] $State)
  $candidate = $ExplicitRoot
  if ([string]::IsNullOrWhiteSpace($candidate) -and $null -ne $State) {
    $project = Get-OptionalProperty $State 'projectSource'
    $candidate = [string](Get-OptionalProperty $project 'boundPath' '')
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $recovery = Get-OptionalProperty $State 'recovery'
    $recoveryMessage = [string](Get-OptionalProperty $recovery 'message' '')
    if (-not [string]::IsNullOrWhiteSpace($recoveryMessage)) { throw $recoveryMessage }
    throw '尚未绑定 dsh-enhanced-plugins 项目源码，请先重新运行安装脚本或选择源码目录。'
  }
  $root = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidate.Trim().Trim('"')))
  $manifestPath = Join-Path $root 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "项目源码目录不存在或缺少 package.json：'$root'。"
  }
  $manifest = Read-JsonFile $manifestPath
  if ($manifest.name -ne 'dsh-enhanced-plugins') {
    throw "选择的目录不是 dsh-enhanced-plugins 项目源码：'$root'。"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'package-lock.json') -PathType Leaf)) {
    throw "项目源码缺少 package-lock.json：'$root'。"
  }
  $root
}

function Get-LocalizedText {
  param([object] $Dictionary, [string] $Fallback)
  if ($null -eq $Dictionary) { return $Fallback }
  $zh = Get-OptionalProperty $Dictionary 'zh-CN'
  if ($zh -is [string] -and -not [string]::IsNullOrWhiteSpace($zh)) { return $zh }
  $en = Get-OptionalProperty $Dictionary 'en-US'
  if ($en -is [string] -and -not [string]::IsNullOrWhiteSpace($en)) { return $en }
  $Fallback
}

function Get-SourceRevision {
  param([string] $Root)
  $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $git -and (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    $revision = @(& $git.Source -C $Root rev-parse HEAD 2>$null) -join ''
    $status = @(& $git.Source -C $Root status --porcelain=v1 --untracked-files=normal 2>$null) -join [Environment]::NewLine
    if ($LASTEXITCODE -eq 0 -and $revision -match '^[0-9a-fA-F]{40}$' -and
      [string]::IsNullOrWhiteSpace($status)) { return $revision.ToLowerInvariant() }
  }
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $sourcesRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-LauncherRoot) 'sources')).TrimEnd($separator) + $separator
  $updatesRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-LauncherRoot) 'updates')).TrimEnd($separator) + $separator
  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd($separator) + $separator
  if ($fullRoot.StartsWith($sourcesRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $fullRoot.StartsWith($updatesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $marker = Read-JsonFile (Join-Path $Root '.dsh-enhanced-source.json')
    $markedRevision = [string](Get-OptionalProperty $marker 'revision' '')
    if ($markedRevision -match '^(?:[0-9a-fA-F]{40}|local-[0-9a-fA-F]{64})$') {
      return $markedRevision.ToLowerInvariant()
    }
  }
  Get-LocalSourceRevision $Root
}

function Get-LocalSourceRevision {
  param([string] $Root)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $paths = @('package.json', 'package-lock.json', 'build.mjs', 'scripts\migrate-to-enhanced-plugin.ps1') + @(
      Get-ChildItem -LiteralPath (Join-Path $Root 'packages') -File -Recurse | Where-Object {
        $_.FullName -notmatch '[\\/](?:node_modules|lib)[\\/]'
      } | ForEach-Object { $_.FullName.Substring($Root.Length).TrimStart('\') }
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $Root $_) -PathType Leaf }
    foreach ($relative in @($paths | Sort-Object -Unique)) {
      $relativeBytes = [System.Text.Encoding]::UTF8.GetBytes($relative.ToLowerInvariant() + "`n")
      [void]$sha.TransformBlock($relativeBytes, 0, $relativeBytes.Length, $relativeBytes, 0)
      $bytes = [System.IO.File]::ReadAllBytes((Join-Path $Root $relative))
      [void]$sha.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
    }
    [void]$sha.TransformFinalBlock(@(), 0, 0)
    'local-' + ([BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant())
  } finally { $sha.Dispose() }
}

function Write-SourceRevisionMarker {
  param([string] $Root, [string] $Revision, [string] $Repository, [string] $Ref)
  if ($Revision -notmatch '^(?:[0-9a-fA-F]{40}|local-[0-9a-fA-F]{64})$') { throw '不能为源码快照写入无效 revision。' }
  Write-JsonFile (Join-Path $Root '.dsh-enhanced-source.json') ([pscustomobject][ordered]@{
    schemaVersion = 1
    revision = $Revision.ToLowerInvariant()
    repository = $Repository
    ref = $Ref
  })
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string] $Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-Catalog {
  param([string] $Root)
  $rootManifest = Read-JsonFile (Join-Path $Root 'package.json')
  $rootMetadata = Get-OptionalProperty $rootManifest 'dshEnhanced'
  $manager = Get-OptionalProperty $rootMetadata 'manager'
  $protocolVersion = [int](Get-OptionalProperty $manager 'protocolVersion' 1)
  $catalogVersion = [int](Get-OptionalProperty $manager 'catalogVersion' 1)
  if ($protocolVersion -ne 1) { throw "不支持项目目录协议版本 $protocolVersion，请先升级 Launcher。" }
  $features = @()
  foreach ($directory in @(Get-ChildItem -LiteralPath (Join-Path $Root 'packages') -Directory | Sort-Object Name)) {
    $manifestPath = Join-Path $directory.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
    $manifest = Read-JsonFile $manifestPath
    $metadata = Get-OptionalProperty $manifest 'dshEnhanced'
    if ($null -eq $metadata) { continue }
    $id = [string](Get-OptionalProperty $metadata 'feature' '')
    if ($id -notmatch '^[a-z0-9][a-z0-9-]*$') { throw "功能包 '$manifestPath' 的 feature id 无效。" }
    $packageName = [string]$manifest.name
    if ([string]::IsNullOrWhiteSpace($packageName)) { throw "功能包 '$manifestPath' 缺少 name。" }
    $kind = [string](Get-OptionalProperty $metadata 'kind' 'bundle')
    if ($kind -notin @('bundle', 'companion')) { throw "功能 '$id' 的 kind '$kind' 不受支持。" }
    $featureManager = Get-OptionalProperty $metadata 'manager'
    if ($null -eq $featureManager) { throw "功能 '$id' 缺少 dshEnhanced.manager 元数据。" }
    $scope = [string](Get-OptionalProperty $featureManager 'scope' $(if ($kind -eq 'bundle') { 'profile' } else { 'global' }))
    $required = [bool](Get-OptionalProperty $featureManager 'required' $false)
    $defaultSelected = [bool](Get-OptionalProperty $featureManager 'defaultSelected' $true)
    if ($scope -notin @('profile', 'global')) { throw "功能 '$id' 的 manager.scope '$scope' 无效。" }
    if ($required -and ($id -ne 'windows-launcher' -or $scope -ne 'global' -or $kind -ne 'companion')) {
      throw "第一版只允许 windows-launcher 声明为全局必选组件。"
    }
    $features += [pscustomobject][ordered]@{
      id = $id
      packageName = $packageName
      kind = $kind
      scope = $scope
      required = $required
      defaultSelected = $defaultSelected
      order = [int](Get-OptionalProperty $featureManager 'order' 1000)
      category = [string](Get-OptionalProperty $featureManager 'category' 'other')
      name = Get-LocalizedText (Get-OptionalProperty $featureManager 'name') $id
      description = Get-LocalizedText (Get-OptionalProperty $featureManager 'description') ([string](Get-OptionalProperty $manifest 'description' ''))
      legacyPackages = @((Get-OptionalProperty $metadata 'legacyPackages' @()))
      root = $directory.FullName
    }
  }
  $duplicateIds = @($features | Group-Object id | Where-Object Count -gt 1)
  $duplicatePackages = @($features | Group-Object packageName | Where-Object Count -gt 1)
  if ($duplicateIds.Count -gt 0) { throw '功能目录包含重复 feature id。' }
  if ($duplicatePackages.Count -gt 0) { throw '功能目录包含重复 package name。' }
  $launcher = @($features | Where-Object { $_.id -eq 'windows-launcher' -and $_.required })
  if ($launcher.Count -ne 1) { throw '功能目录必须且只能包含一个必选 windows-launcher。' }
  $retired = @()
  foreach ($item in @((Get-OptionalProperty $rootMetadata 'retiredFeatures' @()))) {
    $retired += [pscustomobject][ordered]@{
      id = [string]$item.feature
      packageNames = @($item.packageNames)
      notice = [string]$item.notice
    }
  }
  [pscustomobject][ordered]@{
    protocolVersion = $protocolVersion
    catalogVersion = $catalogVersion
    repository = [string](Get-OptionalProperty $manager 'repository' '')
    defaultRef = [string](Get-OptionalProperty $manager 'defaultRef' 'master')
    sourcePath = $Root
    sourceRevision = Get-SourceRevision $Root
    features = @($features | Sort-Object order, id)
    retiredFeatures = $retired
  }
}

function Get-DshHome {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    return [System.IO.Path]::GetFullPath($env:DSH_HOME)
  }
  Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
}

function Get-ProfileDependencies {
  param([string] $ProfileName, [object] $State)
  $dependencies = @()
  $manifestInventoryAvailable = $false
  $profileRoot = Join-Path (Join-Path (Get-DshHome) 'profiles') $ProfileName
  $manifestPath = Join-Path $profileRoot 'package.json'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifest = Read-JsonFile $manifestPath
    $property = $manifest.PSObject.Properties['dependencies']
    if ($null -ne $property) {
      $manifestInventoryAvailable = $true
      $dependencies += @($property.Value.PSObject.Properties | ForEach-Object { $_.Name })
    }
  }
  $dsh = if ($null -eq $State) { $null } else { Get-OptionalProperty $State 'dsh' }
  $invoker = [string](Get-OptionalProperty $dsh 'invoker' '')
  # The profile manifest is the local installation inventory written by DSH.
  # Starting the full CLI as well made every control-center visit noticeably
  # slower on Win10/Win11, so keep the CLI only as a recovery fallback.
  if (-not $manifestInventoryAvailable -and -not [string]::IsNullOrWhiteSpace($invoker) -and
    (Test-Path -LiteralPath $invoker -PathType Leaf)) {
    try {
      $output = @(& $invoker plugin --profile $ProfileName list --depth 0 --json 2>$null) -join [Environment]::NewLine
      if ($LASTEXITCODE -eq 0) {
        $start = $output.IndexOf('[')
        $finish = $output.LastIndexOf(']')
        if ($start -ge 0 -and $finish -ge $start) {
          $inventory = $output.Substring($start, $finish - $start + 1) | ConvertFrom-Json
          $first = @($inventory)[0]
          $property = $first.PSObject.Properties['dependencies']
          if ($null -ne $property) {
            $dependencies += @($property.Value.PSObject.Properties | ForEach-Object { $_.Name })
          }
        }
      }
    } catch {
      # The profile manifest remains a usable inventory fallback. The snapshot
      # reports this distinction instead of failing the whole control center.
    }
  }
  @($dependencies | Select-Object -Unique)
}

function Get-Profiles {
  $profilesRoot = Join-Path (Get-DshHome) 'profiles'
  $names = @('web')
  if (Test-Path -LiteralPath $profilesRoot -PathType Container) {
    $names += @(Get-ChildItem -LiteralPath $profilesRoot -Directory | Where-Object {
      $_.Name -match '^[A-Za-z0-9][A-Za-z0-9._-]*$' -and $_.Name -ne 'node_modules'
    } | ForEach-Object { $_.Name })
  }
  @($names | Select-Object -Unique | Sort-Object)
}

function Get-ProfileState {
  param([object] $State, [string] $ProfileName)
  if ($null -eq $State) { return $null }
  $profiles = Get-OptionalProperty $State 'profiles'
  if ($null -eq $profiles) { return $null }
  $property = $profiles.PSObject.Properties[$ProfileName]
  if ($null -eq $property) { return $null }
  $property.Value
}

function Get-Snapshot {
  param([string] $Root, [string] $ProfileName, [object] $State)
  $catalog = Get-Catalog $Root
  $dependencies = @(Get-ProfileDependencies $ProfileName $State)
  $profileState = Get-ProfileState $State $ProfileName
  $desired = @((Get-OptionalProperty $profileState 'desiredFeatures' @()))
  $known = @((Get-OptionalProperty $profileState 'knownFeatures' @()))
  $managed = [bool](Get-OptionalProperty $profileState 'managed' $false)
  $aggregateInstalled = $dependencies -contains 'dsh-enhanced-plugins'
  $actual = @($catalog.features | Where-Object {
    $_.scope -eq 'profile' -and $dependencies -contains $_.packageName
  } | ForEach-Object { $_.id })
  if (-not $managed) {
    if ($aggregateInstalled) { $desired = @($catalog.features | Where-Object scope -eq 'profile' | ForEach-Object id) }
    elseif ($actual.Count -gt 0) { $desired = @($actual) }
    else { $desired = @($catalog.features | Where-Object { $_.scope -eq 'profile' -and $_.defaultSelected } | ForEach-Object id) }
  }
  $currentLauncher = Read-JsonFile (Join-Path (Get-LauncherRoot) 'current.json')
  $currentLauncherExecutable = [string](Get-OptionalProperty $currentLauncher 'executable' '')
  $launcherInstalled = -not [string]::IsNullOrWhiteSpace($currentLauncherExecutable) -and
    (Test-Path -LiteralPath $currentLauncherExecutable -PathType Leaf)
  $featureRows = @()
  foreach ($feature in @($catalog.features)) {
    $isNew = $managed -and $known -notcontains $feature.id
    $selected = if ($feature.required) { $true }
      elseif ($isNew -and $feature.defaultSelected) { $true }
      else { $desired -contains $feature.id }
    $featureRows += [pscustomobject][ordered]@{
      id = $feature.id
      packageName = $feature.packageName
      kind = $feature.kind
      scope = $feature.scope
      required = $feature.required
      defaultSelected = $feature.defaultSelected
      order = $feature.order
      category = $feature.category
      name = $feature.name
      description = $feature.description
      installed = if ($feature.scope -eq 'global') { $launcherInstalled } else { $actual -contains $feature.id -or $aggregateInstalled }
      selected = $selected
      isNew = $isNew
    }
  }
  $savedComparable = @($desired | Sort-Object)
  $actualComparable = @($actual | Sort-Object)
  [pscustomobject][ordered]@{
    protocolVersion = 1
    success = $true
    profile = $ProfileName
    profiles = @(Get-Profiles)
    managed = $managed
    lastAppliedRevision = [string](Get-OptionalProperty $profileState 'lastAppliedRevision' '')
    aggregateInstalled = $aggregateInstalled
    externalChange = $managed -and (($savedComparable -join "`n") -ne ($actualComparable -join "`n"))
    source = [pscustomobject][ordered]@{
      path = $Root
      revision = $catalog.sourceRevision
      repository = $catalog.repository
      ref = $catalog.defaultRef
    }
    features = $featureRows
    retiredFeatures = $catalog.retiredFeatures
  }
}

function Get-ManagementPlan {
  param([string] $Root, [string] $ProfileName, [object] $State, [object] $Request)
  $catalog = Get-Catalog $Root
  $desired = @((Get-OptionalProperty $Request 'desiredFeatures' @()) | ForEach-Object { [string]$_ } | Select-Object -Unique)
  $profileFeatures = @($catalog.features | Where-Object scope -eq 'profile')
  $validIds = @($profileFeatures | ForEach-Object id)
  $unknown = @($desired | Where-Object { $validIds -notcontains $_ })
  if ($unknown.Count -gt 0) { throw "请求包含未知功能：$($unknown -join ', ')。" }
  $dependencies = @(Get-ProfileDependencies $ProfileName $State)
  $actual = @($profileFeatures | Where-Object { $dependencies -contains $_.packageName } | ForEach-Object id)
  $aggregate = $dependencies -contains 'dsh-enhanced-plugins'
  $profileState = Get-ProfileState $State $ProfileName
  $lastAppliedRevision = [string](Get-OptionalProperty $profileState 'lastAppliedRevision' '')
  $revisionChanged = [string]::IsNullOrWhiteSpace($lastAppliedRevision) -or
    $lastAppliedRevision -ne $catalog.sourceRevision
  $install = @($desired | Where-Object { $actual -notcontains $_ })
  $update = @()
  if ($revisionChanged) { $update = @($desired | Where-Object { $actual -contains $_ }) }
  $remove = @($actual | Where-Object { $desired -notcontains $_ })
  $launcherFeature = @($catalog.features | Where-Object { $_.id -eq 'windows-launcher' })[0]
  $candidatePath = Join-Path $launcherFeature.root 'lib\DSH-Launcher.exe'
  $candidateHash = if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
    Get-FileSha256 $candidatePath
  } else { '' }
  $current = Read-JsonFile (Join-Path (Get-LauncherRoot) 'current.json')
  $currentHash = [string](Get-OptionalProperty $current 'hash' '')
  $launcherAction = if ([string]::IsNullOrWhiteSpace($currentHash)) { 'repair' }
    elseif ([string]::IsNullOrWhiteSpace($candidateHash)) { 'evaluate-after-build' }
    elseif ($candidateHash -eq $currentHash) { 'none' }
    else { 'update' }
  $additionalManagedProfiles = @()
  if ([bool](Get-OptionalProperty $Request 'updateSource' $false)) {
    $profilesState = Get-OptionalProperty $State 'profiles'
    if ($null -ne $profilesState) {
      $additionalManagedProfiles = @($profilesState.PSObject.Properties | Where-Object {
        $_.Name -ne $ProfileName -and [bool](Get-OptionalProperty $_.Value 'managed' $false)
      } | ForEach-Object { $_.Name } | Sort-Object)
    }
  }
  [pscustomobject][ordered]@{
    protocolVersion = 1
    success = $true
    sourceRevision = $catalog.sourceRevision
    updateSource = [bool](Get-OptionalProperty $Request 'updateSource' $false)
    additionalManagedProfiles = $additionalManagedProfiles
    launcher = [pscustomobject][ordered]@{
      required = $true
      action = $launcherAction
      currentHash = $currentHash
      candidateHash = $candidateHash
    }
    profile = [pscustomobject][ordered]@{
      name = $ProfileName
      actualFeatures = $actual
      desiredFeatures = $desired
      install = $install
      update = $update
      remove = $remove
      migrateAggregate = $aggregate
    }
  }
}

function Invoke-GitText {
  param([string] $Git, [string] $Root, [string[]] $Arguments, [switch] $AllowFailure)
  $output = @(& $Git -C $Root @Arguments 2>&1) -join [Environment]::NewLine
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "git $($Arguments -join ' ') 失败（退出码 $code）：$output"
  }
  [pscustomobject]@{ code = $code; output = $output.Trim() }
}

function Get-GitUpdateInfo {
  param([string] $Root, [object] $State, [switch] $Fetch)
  $gitCommand = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $gitCommand -or -not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { return $null }
  $git = $gitCommand.Source
  $status = Invoke-GitText $git $Root @('status', '--porcelain=v1', '--untracked-files=normal')
  $head = (Invoke-GitText $git $Root @('rev-parse', 'HEAD')).output.ToLowerInvariant()
  $branch = (Invoke-GitText $git $Root @('branch', '--show-current')).output
  $upstreamResult = Invoke-GitText $git $Root @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') -AllowFailure
  if ($upstreamResult.code -ne 0 -or [string]::IsNullOrWhiteSpace($upstreamResult.output)) {
    throw '当前 Git 分支没有 upstream，无法安全检查更新。'
  }
  $remote = (Invoke-GitText $git $Root @('config', '--get', 'remote.origin.url')).output
  $boundRemote = [string](Get-OptionalProperty (Get-OptionalProperty $State 'projectSource') 'repositoryUrl' '')
  if (-not [string]::IsNullOrWhiteSpace($boundRemote) -and
    -not $remote.Equals($boundRemote, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Git remote 已变化；绑定为 '$boundRemote'，当前为 '$remote'。请重新绑定源码。"
  }
  if ($Fetch) { [void](Invoke-GitText $git $Root @('fetch', '--prune', 'origin')) }
  $upstream = (Invoke-GitText $git $Root @('rev-parse', '@{u}')).output.ToLowerInvariant()
  $ancestor = Invoke-GitText $git $Root @('merge-base', '--is-ancestor', 'HEAD', '@{u}') -AllowFailure
  $reverse = Invoke-GitText $git $Root @('merge-base', '--is-ancestor', '@{u}', 'HEAD') -AllowFailure
  $relation = if ($head -eq $upstream) { 'current' }
    elseif ($ancestor.code -eq 0) { 'behind' }
    elseif ($reverse.code -eq 0) { 'ahead' }
    else { 'diverged' }
  [pscustomobject][ordered]@{
    mode = 'git-checkout'
    git = $git
    clean = [string]::IsNullOrWhiteSpace($status.output)
    changes = $status.output
    branch = $branch
    upstreamName = $upstreamResult.output
    remote = $remote
    currentRevision = $head
    latestRevision = $upstream
    relation = $relation
    updateAvailable = $relation -eq 'behind'
  }
}

function Get-GitHubCoordinates {
  param([object] $Catalog, [object] $State)
  $repository = [string]$Catalog.repository
  if ($repository -match '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { return $repository }
  $remote = [string](Get-OptionalProperty (Get-OptionalProperty $State 'projectSource') 'repositoryUrl' '')
  if ($remote -match 'github\.com[:/](?<repo>[^/]+/[^/]+?)(?:\.git)?$') { return $Matches.repo }
  throw '无法从项目元数据解析 GitHub 仓库，不能使用无 Git 更新模式。'
}

function Get-RemoteCommit {
  param([string] $Coordinates, [string] $Ref)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  try {
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('DSH-Enhanced-WindowsLauncher/0.1')
    $url = 'https://api.github.com/repos/' + $Coordinates + '/commits/' + [Uri]::EscapeDataString($Ref)
    $json = $client.GetStringAsync($url).GetAwaiter().GetResult() | ConvertFrom-Json
    $sha = [string]$json.sha
    if ($sha -notmatch '^[0-9a-fA-F]{40}$') { throw 'GitHub 返回了无效 commit SHA。' }
    $sha.ToLowerInvariant()
  } finally { $client.Dispose() }
}

function Expand-SafeZip {
  param([string] $ZipPath, [string] $Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [void](New-Item -ItemType Directory -Force -Path $Destination)
  $destinationRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    if ($archive.Entries.Count -gt 20000) { throw '源码 ZIP 条目数超过安全限制。' }
    [long]$total = 0
    foreach ($entry in $archive.Entries) {
      $total += $entry.Length
      if ($total -gt 1024MB) { throw '源码 ZIP 解压后大小超过安全限制。' }
      $target = [System.IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName.Replace('/', '\')))
      if (-not $target.StartsWith($destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "源码 ZIP 包含越界路径 '$($entry.FullName)'。"
      }
      if ([string]::IsNullOrEmpty($entry.Name)) {
        [void](New-Item -ItemType Directory -Force -Path $target)
        continue
      }
      $parent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void](New-Item -ItemType Directory -Force -Path $parent)
      }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally { $archive.Dispose() }
}

function Import-ManualSourceZip {
  param([string] $ZipPath, [string] $LauncherRoot)
  $zip = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($ZipPath.Trim().Trim('"')))
  if (-not (Test-Path -LiteralPath $zip -PathType Leaf) -or
    -not [System.IO.Path]::GetExtension($zip).Equals('.zip', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "手动源码 ZIP 不存在或扩展名无效：'$zip'。"
  }
  if ((Get-Item -LiteralPath $zip).Length -gt 256MB) { throw '手动源码 ZIP 超过安全限制。' }
  $requestId = 'import-' + [Guid]::NewGuid().ToString('N')
  $requestRoot = Join-Path (Join-Path $LauncherRoot 'updates') $requestId
  [void](Assert-OwnedPath $requestRoot $LauncherRoot)
  $extract = Join-Path $requestRoot 'manual-source'
  Expand-SafeZip $zip $extract
  $rootCandidates = @()
  if (Test-Path -LiteralPath (Join-Path $extract 'package.json') -PathType Leaf) {
    $rootCandidates = @((Get-Item -LiteralPath $extract))
  } else {
    $rootCandidates = @(Get-ChildItem -LiteralPath $extract -Directory | Where-Object {
      Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf
    })
  }
  if ($rootCandidates.Count -ne 1) { throw '手动源码 ZIP 必须包含唯一的项目根目录。' }
  $source = Resolve-RepositoryRoot $rootCandidates[0].FullName $null
  $catalog = Get-Catalog $source
  $revision = Get-LocalSourceRevision $source
  $target = Join-Path (Join-Path $LauncherRoot 'sources') $revision
  [void](Assert-OwnedPath $target $LauncherRoot)
  if (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf) {
    Write-SourceRevisionMarker $target $revision $catalog.repository $catalog.defaultRef
    return $target
  }
  Write-SourceRevisionMarker $source $revision $catalog.repository $catalog.defaultRef
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
  Move-Item -LiteralPath $source -Destination $target
  $target
}

function Copy-SafeSourceTree {
  param([string] $Source, [string] $Destination)
  $sourceRoot = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
  $destinationRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
  if (Test-Path -LiteralPath $destinationRoot) { throw "隔离源码目录已经存在：'$destinationRoot'。" }
  [void](New-Item -ItemType Directory -Path $destinationRoot)
  function Copy-DirectoryContents {
    param([string] $CurrentSource, [string] $CurrentDestination)
    foreach ($item in @(Get-ChildItem -LiteralPath $CurrentSource -Force)) {
      if ($item.Name -in @('.git', 'node_modules', 'lib') -or $item.Name -like '.verify-*') { continue }
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "源码包含不允许的 reparse point：'$($item.FullName)'。"
      }
      $target = Join-Path $CurrentDestination $item.Name
      $targetFull = [System.IO.Path]::GetFullPath($target)
      if (-not ($targetFull + $(if ($item.PSIsContainer) { '\' } else { '' })).StartsWith(
        $destinationRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "源码复制目标越界：'$targetFull'。"
      }
      if ($item.PSIsContainer) {
        [void](New-Item -ItemType Directory -Path $targetFull)
        Copy-DirectoryContents $item.FullName $targetFull
      } else {
        [System.IO.File]::Copy($item.FullName, $targetFull, $false)
      }
    }
  }
  Copy-DirectoryContents $sourceRoot $destinationRoot
  $destinationRoot
}

function New-LocalSnapshot {
  param([string] $Root, [string] $LauncherRoot, [string] $RequestId)
  $revision = Get-LocalSourceRevision $Root
  $target = Join-Path (Join-Path $LauncherRoot 'sources') $revision
  [void](Assert-OwnedPath $target $LauncherRoot)
  $catalog = Get-Catalog $Root
  if (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf) {
    Write-SourceRevisionMarker $target $revision $catalog.repository $catalog.defaultRef
    return $target
  }
  $temporary = Join-Path (Join-Path (Join-Path $LauncherRoot 'updates') $RequestId) 'local-snapshot'
  [void](Assert-OwnedPath $temporary $LauncherRoot)
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  [void](Copy-SafeSourceTree $Root $temporary)
  [void](Resolve-RepositoryRoot $temporary $null)
  Write-SourceRevisionMarker $temporary $revision $catalog.repository $catalog.defaultRef
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
  Move-Item -LiteralPath $temporary -Destination $target
  $target
}

function New-CurrentSourceSnapshot {
  param([string] $Root, [string] $LauncherRoot, [string] $RequestId)
  $gitCommand = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $gitCommand -and (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    $git = $gitCommand.Source
    $status = Invoke-GitText $git $Root @('status', '--porcelain=v1', '--untracked-files=normal')
    if ([string]::IsNullOrWhiteSpace($status.output)) {
      $head = (Invoke-GitText $git $Root @('rev-parse', 'HEAD')).output.ToLowerInvariant()
      $remoteResult = Invoke-GitText $git $Root @('config', '--get', 'remote.origin.url') -AllowFailure
      $branchResult = Invoke-GitText $git $Root @('branch', '--show-current') -AllowFailure
      return New-GitSnapshot ([pscustomobject]@{
        git = $git
        latestRevision = $head
        remote = $remoteResult.output
        upstreamName = $branchResult.output
      }) $Root $LauncherRoot $RequestId
    }
  }
  New-LocalSnapshot $Root $LauncherRoot $RequestId
}

function New-BuildWorkspace {
  param([string] $SnapshotRoot, [string] $LauncherRoot, [string] $RequestId)
  $revision = (Get-Catalog $SnapshotRoot).sourceRevision
  if ($revision -notmatch '^(?:[0-9a-fA-F]{40}|local-[0-9a-fA-F]{64})$') {
    throw '不能为无效源码 revision 创建运行时快照。'
  }
  $revisionHash = if ($revision.StartsWith('local-', [System.StringComparison]::OrdinalIgnoreCase)) {
    $revision.Substring(6)
  } else { $revision }
  $revisionToken = $revisionHash.Substring(0, 16).ToLowerInvariant()
  $requestToken = $RequestId.Replace('-', '').Substring(0, 8).ToLowerInvariant()
  $sourcesRoot = Join-Path $LauncherRoot 'sources'
  # Keep this path short enough for the inbox Win10/Win11 C# compiler, whose
  # temporary-file handling can still fail on deeply nested long paths.
  $target = Join-Path $sourcesRoot ("runtime-$revisionToken-$requestToken")
  [void](Assert-OwnedPath $target $LauncherRoot)
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  [void](New-Item -ItemType Directory -Force -Path $sourcesRoot)
  [void](Copy-SafeSourceTree $SnapshotRoot $target)
  [void](Resolve-RepositoryRoot $target $null)
  $target
}

function Remove-UnreferencedRuntimeSources {
  param([string] $LauncherRoot, [string] $CurrentRuntimeRoot)
  $sourcesRoot = [System.IO.Path]::GetFullPath((Join-Path $LauncherRoot 'sources')).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $sourcesRoot -PathType Container)) { return }
  $retained = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [void]$retained.Add([System.IO.Path]::GetFullPath($CurrentRuntimeRoot).TrimEnd('\'))
  $profilesRoot = Join-Path (Get-DshHome) 'profiles'
  if (Test-Path -LiteralPath $profilesRoot -PathType Container) {
    foreach ($manifestPath in @(Get-ChildItem -LiteralPath $profilesRoot -Filter package.json -File -Recurse)) {
      $manifest = Read-JsonFile $manifestPath.FullName
      $dependencies = if ($null -eq $manifest) { $null } else { $manifest.PSObject.Properties['dependencies'] }
      if ($null -eq $dependencies) { continue }
      foreach ($dependency in @($dependencies.Value.PSObject.Properties)) {
        $specification = [string]$dependency.Value
        if (-not $specification.StartsWith('link:', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        try {
          $linkedPath = [System.IO.Path]::GetFullPath(
            $specification.Substring(5).Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        } catch { continue }
        if (-not $linkedPath.StartsWith($sourcesRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $relative = $linkedPath.Substring($sourcesRoot.Length + 1)
        $runtimeDirectoryName = @($relative.Split('\'))[0]
        if ($runtimeDirectoryName -like 'runtime-*') {
          [void]$retained.Add((Join-Path $sourcesRoot $runtimeDirectoryName))
        }
      }
    }
  }
  foreach ($directory in @(Get-ChildItem -LiteralPath $sourcesRoot -Directory -Filter 'runtime-*')) {
    $candidate = [System.IO.Path]::GetFullPath($directory.FullName).TrimEnd('\')
    if ($retained.Contains($candidate)) { continue }
    if (-not $candidate.StartsWith($sourcesRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理 sources 目录外的运行时快照：'$candidate'。"
    }
    [void](Assert-OwnedPath $candidate $LauncherRoot)
    try { Remove-Item -LiteralPath $candidate -Recurse -Force }
    catch {
      # Windows PowerShell 5.1 can fail partway through deeply nested
      # node_modules trees. The validated extended path keeps cleanup inside
      # the Launcher-owned sources directory while bypassing MAX_PATH.
      $extendedPath = if ($candidate.StartsWith('\\')) {
        '\\?\UNC\' + $candidate.Substring(2)
      } else { '\\?\' + $candidate }
      [System.IO.Directory]::Delete($extendedPath, $true)
    }
  }
}

function New-GitSnapshot {
  param([object] $GitInfo, [string] $Root, [string] $LauncherRoot, [string] $RequestId)
  $revision = $GitInfo.latestRevision
  $sourcesRoot = Join-Path $LauncherRoot 'sources'
  $target = Join-Path $sourcesRoot $revision
  [void](Assert-OwnedPath $target $LauncherRoot)
  if (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf) {
    Write-SourceRevisionMarker $target $revision $GitInfo.remote $GitInfo.upstreamName
    return $target
  }
  [void](New-Item -ItemType Directory -Force -Path $sourcesRoot)
  $temporaryRoot = Join-Path (Join-Path $LauncherRoot 'updates') $RequestId
  [void](New-Item -ItemType Directory -Force -Path $temporaryRoot)
  $archivePath = Join-Path $temporaryRoot 'source.zip'
  [void](Invoke-GitText $GitInfo.git $Root @('archive', '--format=zip', '--output', $archivePath, $revision))
  $extract = Join-Path $temporaryRoot 'source'
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  Expand-SafeZip $archivePath $extract
  if (-not (Test-Path -LiteralPath (Join-Path $extract 'package.json') -PathType Leaf)) {
    throw 'Git 源码快照缺少根 package.json。'
  }
  Write-SourceRevisionMarker $extract $revision $GitInfo.remote $GitInfo.upstreamName
  Move-Item -LiteralPath $extract -Destination $target
  $target
}

function New-DownloadedSnapshot {
  param([object] $Catalog, [object] $State, [string] $LauncherRoot, [string] $RequestId)
  $coordinates = Get-GitHubCoordinates $Catalog $State
  $revision = Get-RemoteCommit $coordinates $Catalog.defaultRef
  $target = Join-Path (Join-Path $LauncherRoot 'sources') $revision
  [void](Assert-OwnedPath $target $LauncherRoot)
  if (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf) {
    Write-SourceRevisionMarker $target $revision $coordinates $Catalog.defaultRef
    return $target
  }
  $requestRoot = Join-Path (Join-Path $LauncherRoot 'updates') $RequestId
  [void](New-Item -ItemType Directory -Force -Path $requestRoot)
  $zipPath = Join-Path $requestRoot 'source.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  try {
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('DSH-Enhanced-WindowsLauncher/0.1')
    $bytes = $client.GetByteArrayAsync("https://github.com/$coordinates/archive/$revision.zip").GetAwaiter().GetResult()
    if ($bytes.Length -gt 256MB) { throw '下载的源码 ZIP 超过安全限制。' }
    [System.IO.File]::WriteAllBytes($zipPath, $bytes)
  } finally { $client.Dispose() }
  $extract = Join-Path $requestRoot 'downloaded'
  Expand-SafeZip $zipPath $extract
  $roots = @(Get-ChildItem -LiteralPath $extract -Directory)
  if ($roots.Count -ne 1) { throw '源码 ZIP 顶层目录结构无效。' }
  $source = $roots[0].FullName
  [void](Resolve-RepositoryRoot $source $null)
  Write-SourceRevisionMarker $source $revision $coordinates $Catalog.defaultRef
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
  Move-Item -LiteralPath $source -Destination $target
  $target
}

function Update-StateBinding {
  param([object] $State, [string] $Root, [object] $Catalog)
  if ($null -eq $State) {
    $State = [pscustomobject][ordered]@{ schemaVersion = 1; profiles = [pscustomobject]@{} }
  }
  if ($null -ne $State.PSObject.Properties['recovery']) { $State.PSObject.Properties.Remove('recovery') }
  if ($null -eq $State.PSObject.Properties['dsh']) {
    $settings = Read-JsonFile (Join-Path (Get-LauncherRoot) 'settings.json')
    $dshCheckout = [string](Get-OptionalProperty $settings 'DshSourceDirectory' '')
    $invoker = Join-Path (Get-LauncherRoot) 'dsh-checkout-invoker.ps1'
    if (-not [string]::IsNullOrWhiteSpace($dshCheckout) -and
      (Test-Path -LiteralPath $dshCheckout -PathType Container) -and
      (Test-Path -LiteralPath $invoker -PathType Leaf)) {
      $State | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject][ordered]@{
        mode = 'source'
        checkout = [System.IO.Path]::GetFullPath($dshCheckout)
        invoker = $invoker
        home = Get-DshHome
        validatedVersion = ''
      }) -Force
    }
  }
  $gitInfo = Get-GitUpdateInfo $Root $State
  $rootManifest = Read-JsonFile (Join-Path $Root 'package.json')
  $repositoryMetadata = Get-OptionalProperty $rootManifest 'repository'
  $repositoryUrl = if ($repositoryMetadata -is [string]) { $repositoryMetadata }
    else { [string](Get-OptionalProperty $repositoryMetadata 'url' '') }
  if ($null -ne $gitInfo) { $repositoryUrl = $gitInfo.remote }
  $State | Add-Member -NotePropertyName projectSource -NotePropertyValue ([pscustomobject][ordered]@{
    mode = if ($null -ne $gitInfo) { 'git-checkout' } else { 'source-snapshot' }
    boundPath = $Root
    repositoryUrl = $repositoryUrl
    ref = if ($null -ne $gitInfo) { $gitInfo.branch } else { $Catalog.defaultRef }
    lastSuccessfulRevision = $Catalog.sourceRevision
    lastCheckedRevision = $Catalog.sourceRevision
  }) -Force
  $State
}

function Invoke-LoggedCommand {
  param(
    [string] $Command,
    [string[]] $Arguments,
    [string] $WorkingDirectory,
    [string] $LogPath,
    [string] $Label
  )
  [System.IO.File]::AppendAllText($LogPath,
    "[$([DateTime]::Now.ToString('s'))] START $Label`r`n", $Utf8NoBom)
  $original = (Get-Location).Path
  $originalErrorActionPreference = $ErrorActionPreference
  $code = -1
  try {
    Set-Location -LiteralPath $WorkingDirectory
    # Windows PowerShell 5.1 represents native stderr lines as ErrorRecord
    # objects. npm writes ordinary warnings there, so Stop would abort on the
    # first deprecation notice even when npm ultimately exits successfully.
    $ErrorActionPreference = 'Continue'
    & $Command @Arguments 2>&1 | ForEach-Object {
      [System.IO.File]::AppendAllText($LogPath, ([string]$_ + [Environment]::NewLine), $Utf8NoBom)
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $originalErrorActionPreference
    Set-Location -LiteralPath $original
  }
  [System.IO.File]::AppendAllText($LogPath,
    "[$([DateTime]::Now.ToString('s'))] END $Label exit=$code`r`n", $Utf8NoBom)
  if ($code -ne 0) { throw "$Label 失败（退出码 $code）。" }
}

function Assert-CatalogRuntimeEntries {
  param([object] $Catalog, [string[]] $DesiredFeatures)
  $targets = @($Catalog.features | Where-Object {
    $_.required -or ($_.scope -eq 'profile' -and $DesiredFeatures -contains $_.id)
  })
  $missing = @()
  foreach ($feature in $targets) {
    $manifest = Read-JsonFile (Join-Path $feature.root 'package.json')
    $metadata = Get-OptionalProperty $manifest 'dshEnhanced'
    $runtimeTargets = if ($feature.kind -eq 'companion') {
      @((Get-OptionalProperty $metadata 'runtimeEntries' @()))
    } else {
      @([string](Get-OptionalProperty $manifest 'main' '')) + @(
        (Get-OptionalProperty $manifest 'exports').PSObject.Properties |
          ForEach-Object { $_.Value } | Where-Object { $_ -is [string] -and $_.StartsWith('./lib/') }
      )
    }
    foreach ($entry in @($runtimeTargets | Sort-Object -Unique)) {
      if ($entry -isnot [string] -or -not $entry.StartsWith('./lib/')) { continue }
      $path = Join-Path $feature.root $entry.Substring(2)
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $missing += "$($feature.id):$entry" }
    }
  }
  if ($missing.Count -gt 0) { throw "候选源码缺少 runtime entries：$($missing -join ', ')。" }
}

function Test-LocalPort {
  param([int] $Port)
  if ($Port -lt 1 -or $Port -gt 65535) { return $false }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(250)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

function Stop-LauncherOwnedDsh {
  param([string] $LauncherRoot, [string] $LogPath)
  $settings = Read-JsonFile (Join-Path $LauncherRoot 'settings.json')
  $port = [int](Get-OptionalProperty $settings 'Port' 3080)
  $statePath = Join-Path (Join-Path $LauncherRoot 'run') 'web-state.json'
  $stopPath = Join-Path (Join-Path $LauncherRoot 'run') 'web-stop.txt'
  $webState = Read-JsonFile $statePath
  $owned = $false
  if ($null -ne $webState) {
    $supervisorProcessId = [int](Get-OptionalProperty $webState 'supervisorPid' 0)
    if ($supervisorProcessId -gt 0) {
      $process = Get-Process -Id $supervisorProcessId -ErrorAction SilentlyContinue
      $owned = $null -ne $process -and $process.ProcessName -eq 'powershell'
    }
  }
  if (-not $owned) {
    if (Test-LocalPort $port) {
      throw "端口 $port 上运行的是 Launcher 无法证明所有权的外部 DSH 服务；请先手动关闭后重试。"
    }
    return [pscustomobject]@{ wasRunning = $false; port = $port }
  }
  $requestId = [string](Get-OptionalProperty $webState 'requestId' '')
  if ([string]::IsNullOrWhiteSpace($requestId)) { throw 'Launcher-owned DSH 状态缺少 requestId。' }
  [System.IO.File]::WriteAllText($stopPath, $requestId, $Utf8NoBom)
  [System.IO.File]::AppendAllText($LogPath, "[$([DateTime]::Now.ToString('s'))] requested owned DSH stop`r`n", $Utf8NoBom)
  $deadline = [DateTime]::UtcNow.AddSeconds(18)
  do {
    Start-Sleep -Milliseconds 250
    $process = Get-Process -Id ([int]$webState.supervisorPid) -ErrorAction SilentlyContinue
  } while ($null -ne $process -and [DateTime]::UtcNow -lt $deadline)
  if ($null -ne $process -or (Test-LocalPort $port)) { throw '等待 Launcher-owned DSH 停止超时，未进入 Profile 提交阶段。' }
  [pscustomobject]@{ wasRunning = $true; port = $port }
}

function Release-PluginManagementLock {
  param([object] $LockState)
  if ($null -eq $LockState -or -not [bool]$LockState.taken) { return }
  $LockState.mutex.ReleaseMutex()
  $LockState.taken = $false
}

function Wait-AutomationProcess {
  param(
    [System.Diagnostics.Process] $Process,
    [int] $TimeoutMilliseconds,
    [string] $Description
  )
  try {
    if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
      try { $Process.Kill() } catch { }
      throw "$Description 超时。"
    }
    $Process.ExitCode
  } finally {
    $Process.Dispose()
  }
}

function Restore-LauncherOwnedDsh {
  param([string] $LauncherRoot, [object] $ServiceState, [string] $LogPath)
  if ($null -eq $ServiceState -or -not [bool]$ServiceState.wasRunning) { return $true }
  $current = Read-JsonFile (Join-Path $LauncherRoot 'current.json')
  $executable = [string](Get-OptionalProperty $current 'executable' '')
  if ([string]::IsNullOrWhiteSpace($executable) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    [System.IO.File]::AppendAllText($LogPath, "DSH restore skipped: active Launcher is missing.`r`n", $Utf8NoBom)
    return $false
  }
  $restoreResult = Join-Path (Split-Path -Parent $LogPath) 'restore-result.json'
  $process = Start-Process -FilePath $executable -ArgumentList @('--automation', 'start', ('"' + $restoreResult + '"')) `
    -PassThru -WindowStyle Hidden
  $startExitCode = Wait-AutomationProcess $process 10000 '等待 DSH 恢复请求'
  $result = Read-JsonFile $restoreResult
  $startAccepted = $startExitCode -eq 0 -and $null -ne $result -and [bool]$result.success
  $ownership = [string](Get-OptionalProperty $result 'ownership' '')
  $success = $false
  if ($startAccepted) {
    $statusResult = Join-Path (Split-Path -Parent $LogPath) 'restore-status.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $ownedSince = $null
    do {
      $statusProcess = Start-Process -FilePath $executable `
        -ArgumentList @('--automation', 'status', ('"' + $statusResult + '"')) `
        -PassThru -WindowStyle Hidden
      $statusExitCode = Wait-AutomationProcess $statusProcess 5000 '等待 DSH 恢复状态'
      $status = Read-JsonFile $statusResult
      $ownership = [string](Get-OptionalProperty $status 'ownership' '')
      if ($statusExitCode -eq 0 -and $null -ne $status -and [bool]$status.success -and
        $ownership -eq 'Owned') {
        if ($null -eq $ownedSince) { $ownedSince = [DateTime]::UtcNow }
        elseif (([DateTime]::UtcNow - $ownedSince).TotalSeconds -ge 15) {
          $success = $true
          break
        }
      } else { $ownedSince = $null }
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
  }
  [System.IO.File]::AppendAllText($LogPath,
    "[$([DateTime]::Now.ToString('s'))] DSH restore success=$success ownership=$ownership`r`n", $Utf8NoBom)
  $success
}

function Invoke-Apply {
  param(
    [object] $Request,
    [object] $State,
    [string] $InitialRoot,
    [string] $LauncherRoot,
    [object] $ManagementLock
  )
  $requestId = [string](Get-OptionalProperty $Request 'requestId' ([Guid]::NewGuid().ToString('D')))
  if ($requestId -notmatch '^[0-9a-fA-F-]{36}$') { throw '请求 ID 无效。' }
  $profileName = [string](Get-OptionalProperty $Request 'profile' 'web')
  if ($profileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Profile 名称无效。' }
  $catalog = Get-Catalog $InitialRoot
  $expectedRevision = [string](Get-OptionalProperty $Request 'expectedSourceRevision' '')
  if (-not [string]::IsNullOrWhiteSpace($expectedRevision) -and $catalog.sourceRevision -ne $expectedRevision) {
    throw '项目源码在计划生成后发生变化，请刷新页面并重新确认计划。'
  }
  $desired = @((Get-OptionalProperty $Request 'desiredFeatures' @()) | ForEach-Object { [string]$_ } | Select-Object -Unique)
  $validIds = @($catalog.features | Where-Object scope -eq 'profile' | ForEach-Object id)
  $unknown = @($desired | Where-Object { $validIds -notcontains $_ })
  if ($unknown.Count -gt 0) { throw "请求包含未知功能：$($unknown -join ', ')。" }
  $expectedActual = @((Get-OptionalProperty $Request 'expectedActualFeatures' @()) | ForEach-Object { [string]$_ } | Sort-Object)
  $expectedAggregate = [bool](Get-OptionalProperty $Request 'expectedAggregateInstalled' $false)
  $dependenciesBeforeApply = @(Get-ProfileDependencies $profileName $State)
  $actualBeforeApply = @($catalog.features | Where-Object {
    $_.scope -eq 'profile' -and $dependenciesBeforeApply -contains $_.packageName
  } | ForEach-Object id | Sort-Object)
  $aggregateBeforeApply = $dependenciesBeforeApply -contains 'dsh-enhanced-plugins'
  if (($expectedActual -join "`n") -ne ($actualBeforeApply -join "`n") -or
    $expectedAggregate -ne $aggregateBeforeApply) {
    throw 'Profile 实际安装状态在计划生成后发生变化，请刷新页面并重新确认计划。'
  }
  $updateSource = [bool](Get-OptionalProperty $Request 'updateSource' $false)
  $preflightPlan = Get-ManagementPlan $InitialRoot $profileName $State $Request
  $preflightLauncherAction = [string](Get-OptionalProperty (Get-OptionalProperty $preflightPlan 'launcher') 'action' 'none')
  $preflightProfile = Get-OptionalProperty $preflightPlan 'profile'
  $preflightHasWork = $updateSource -or
    [bool](Get-OptionalProperty $preflightProfile 'migrateAggregate' $false) -or
    @((Get-OptionalProperty $preflightProfile 'install' @())).Count -gt 0 -or
    @((Get-OptionalProperty $preflightProfile 'update' @())).Count -gt 0 -or
    @((Get-OptionalProperty $preflightProfile 'remove' @())).Count -gt 0 -or
    $preflightLauncherAction -ne 'none'
  if (-not $preflightHasWork) {
    return [pscustomobject][ordered]@{
      protocolVersion = 1
      requestId = $requestId
      success = $true
      stage = 'complete'
      message = '当前已是目标状态，没有执行依赖安装、构建或 Profile 修改。'
      sourceRevision = $catalog.sourceRevision
      sourceMode = 'unchanged'
      profile = $profileName
      profiles = @($profileName)
      desiredFeatures = $desired
      launcher = [pscustomobject]@{ required = $true; action = 'none' }
      dshRestored = $true
      statePath = Join-Path $LauncherRoot 'install-state.json'
      logPath = ''
      snapshot = Get-Snapshot $InitialRoot $profileName $State
    }
  }
  $profileTargets = @([pscustomobject]@{ name = $profileName; desired = @($desired) })
  if ($updateSource) {
    $profilesState = Get-OptionalProperty $State 'profiles'
    if ($null -ne $profilesState) {
      foreach ($profileProperty in @($profilesState.PSObject.Properties | Sort-Object Name)) {
        if ($profileProperty.Name -eq $profileName -or
          -not [bool](Get-OptionalProperty $profileProperty.Value 'managed' $false)) { continue }
        if ($profileProperty.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
          throw "安装状态包含无效 Profile 名称 '$($profileProperty.Name)'。"
        }
        $savedDesired = @((Get-OptionalProperty $profileProperty.Value 'desiredFeatures' @()) |
          ForEach-Object { [string]$_ } | Select-Object -Unique)
        $otherDependencies = @(Get-ProfileDependencies $profileProperty.Name $State)
        $otherAggregate = $otherDependencies -contains 'dsh-enhanced-plugins'
        $otherActual = if ($otherAggregate) { @($validIds | Sort-Object) } else {
          @($catalog.features | Where-Object {
            $_.scope -eq 'profile' -and $otherDependencies -contains $_.packageName
          } | ForEach-Object id | Sort-Object)
        }
        $savedComparable = @(($savedDesired | Sort-Object)) -join "`n"
        $actualComparable = $otherActual -join "`n"
        if ($savedComparable -ne $actualComparable) {
          throw "已管理 Profile '$($profileProperty.Name)' 存在外部变更；请先在 Launcher 中导入或重新应用它的目标状态。"
        }
        $profileTargets += [pscustomobject]@{ name = $profileProperty.Name; desired = $savedDesired }
      }
    }
  }
  $source = $InitialRoot
  $bindingRoot = $InitialRoot
  $updateMode = 'current-source'
  if ($updateSource) {
    $gitInfo = Get-GitUpdateInfo $InitialRoot $State -Fetch
    if ($null -ne $gitInfo) {
      if (-not $gitInfo.clean) { throw "Git 工作区存在本地修改，已停止更新：$($gitInfo.changes)" }
      if ($gitInfo.relation -eq 'ahead') { throw '本地分支领先远端，不能自动更新。' }
      if ($gitInfo.relation -eq 'diverged') { throw '本地分支已与远端分叉，不能自动更新。' }
      if ($gitInfo.updateAvailable) {
        [void](Invoke-GitText $gitInfo.git $InitialRoot @('pull', '--ff-only'))
        $gitInfo = Get-GitUpdateInfo $InitialRoot $State
      }
      $source = New-GitSnapshot $gitInfo $InitialRoot $LauncherRoot $requestId
      $updateMode = 'git-snapshot'
    } else {
      $source = New-DownloadedSnapshot $catalog $State $LauncherRoot $requestId
      $bindingRoot = $source
      $updateMode = 'downloaded-snapshot'
    }
    $catalog = Get-Catalog $source
    $validIds = @($catalog.features | Where-Object scope -eq 'profile' | ForEach-Object id)
    $unknown = @($desired | Where-Object { $validIds -notcontains $_ })
    if ($unknown.Count -gt 0) { throw "更新后的源码已不再提供所选功能：$($unknown -join ', ')。" }
    foreach ($targetProfile in $profileTargets) {
      $targetUnknown = @($targetProfile.desired | Where-Object { $validIds -notcontains $_ })
      if ($targetUnknown.Count -gt 0) {
        throw "更新后的源码已不再提供 Profile '$($targetProfile.name)' 所需功能：$($targetUnknown -join ', ')。"
      }
    }
  } else {
    $source = New-CurrentSourceSnapshot $InitialRoot $LauncherRoot $requestId
    $snapshotRevision = (Get-Catalog $source).sourceRevision
    $updateMode = if ($snapshotRevision.StartsWith('local-', [System.StringComparison]::OrdinalIgnoreCase)) {
      'local-source-snapshot'
    } else { 'current-git-snapshot' }
  }
  $sourceSnapshot = $source
  $source = New-BuildWorkspace $sourceSnapshot $LauncherRoot $requestId
  $catalog = Get-Catalog $source
  $validIds = @($catalog.features | Where-Object scope -eq 'profile' | ForEach-Object id)
  foreach ($targetProfile in $profileTargets) {
    $targetUnknown = @($targetProfile.desired | Where-Object { $validIds -notcontains $_ })
    if ($targetUnknown.Count -gt 0) {
      throw "候选源码已不再提供 Profile '$($targetProfile.name)' 所需功能：$($targetUnknown -join ', ')。"
    }
  }
  $dsh = Get-OptionalProperty $State 'dsh'
  $dshCheckout = [string](Get-OptionalProperty $dsh 'checkout' '')
  if ([string]::IsNullOrWhiteSpace($dshCheckout)) { throw '安装状态未绑定 DSH 源码 checkout。' }
  $installer = Join-Path $source 'scripts\migrate-to-enhanced-plugin.ps1'
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw '候选源码缺少安装核心脚本。' }
  $requestRoot = Join-Path (Join-Path $LauncherRoot 'updates') $requestId
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $requestRoot 'logs'))
  $logPath = Join-Path (Join-Path $requestRoot 'logs') 'update.log'
  $featureArgument = if ($desired.Count -eq 0) { 'none' } else { $desired -join ',' }
  [System.IO.File]::AppendAllText($logPath,
    "[$([DateTime]::Now.ToString('s'))] request=$requestId profile=$profileName source=$source revision=$($catalog.sourceRevision)`r`n", $Utf8NoBom)
  $npm = Get-Command -Name 'npm' -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $installerPowerShell = Get-Command -Name 'powershell.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
  Invoke-LoggedCommand $npm.Source @('ci', '--no-audit', '--no-fund', '--ignore-scripts=false') $source $logPath 'npm ci'
  # The repository tsconfig files intentionally resolve DSH types from the
  # sibling development checkout.  This request workspace is isolated under
  # Launcher data, so a repository-wide typecheck would resolve that relative
  # path against the wrong parent directory.  Installation only needs verified
  # publishable artifacts; build them here and validate every selected runtime
  # entry before stopping DSH or changing a Profile.
  Invoke-LoggedCommand $npm.Source @('run', 'build') $source $logPath 'npm run build'
  $allDesired = @($profileTargets | ForEach-Object { $_.desired } | Select-Object -Unique)
  Assert-CatalogRuntimeEntries $catalog $allDesired
  $serviceState = Stop-LauncherOwnedDsh $LauncherRoot $logPath
  $dshRestored = $true
  try {
    try {
      for ($profileIndex = 0; $profileIndex -lt $profileTargets.Count; $profileIndex++) {
        $targetProfile = $profileTargets[$profileIndex]
        $targetFeatureArgument = if ($targetProfile.desired.Count -eq 0) { 'none' }
          else { $targetProfile.desired -join ',' }
        [System.IO.File]::AppendAllText($logPath,
          "[$([DateTime]::Now.ToString('s'))] APPLY profile=$($targetProfile.name) features=$targetFeatureArgument`r`n", $Utf8NoBom)
        # Run the installer as a top-level script, matching the invocation that
        # users run successfully. Calling it in this coordinator's script scope
        # turns DSH's informational stderr into a terminating RemoteException.
        $installerProcessArguments = @(
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', $installer,
          '-Profile', $targetProfile.name,
          '-DshCheckout', $dshCheckout,
          '-PluginPath', $source,
          '-ProjectSourceBinding', $bindingRoot,
          '-Features', $targetFeatureArgument,
          '-SkipBuild'
        )
        if ($profileIndex -lt ($profileTargets.Count - 1)) { $installerProcessArguments += '-SkipLauncherInstall' }
        else { $installerProcessArguments += '-RestartLauncherAfterUpdate' }
        $managerErrorActionPreference = $ErrorActionPreference
        try {
          # DSH writes its echoed native command line to stderr even when the
          # command succeeds. Collect that diagnostic stream in the log and
          # use the installer's real exit code as the success boundary.
          $ErrorActionPreference = 'Continue'
          $lines = @(& $installerPowerShell.Source @installerProcessArguments 2>&1)
          $exitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $managerErrorActionPreference
        }
        [System.IO.File]::AppendAllText($logPath, (($lines | Out-String) + [Environment]::NewLine), $Utf8NoBom)
        if ($exitCode -ne 0) {
          throw "Profile '$($targetProfile.name)' 安装核心执行失败（退出码 $exitCode），请查看日志 '$logPath'。"
        }
      }
      try { Remove-UnreferencedRuntimeSources $LauncherRoot $source }
      catch {
        [System.IO.File]::AppendAllText($logPath,
          ("Runtime source cleanup warning: " + $_.Exception.ToString() + [Environment]::NewLine), $Utf8NoBom)
      }
    } catch {
      [System.IO.File]::AppendAllText($logPath, ($_.Exception.ToString() + [Environment]::NewLine), $Utf8NoBom)
      throw
    }
  } finally {
    # Starting DSH is intentionally blocked while the update mutex is held.
    # Release it only after the Profile commit attempt has finished, then
    # restore the service and wait until the new Launcher reports ownership.
    Release-PluginManagementLock $ManagementLock
    try { $dshRestored = Restore-LauncherOwnedDsh $LauncherRoot $serviceState $logPath }
    catch {
      $dshRestored = $false
      [System.IO.File]::AppendAllText($logPath,
        ("DSH restore failed: " + $_.Exception.ToString() + [Environment]::NewLine), $Utf8NoBom)
    }
  }
  $nextState = Read-JsonFile (Join-Path $LauncherRoot 'install-state.json')
  [pscustomobject][ordered]@{
    protocolVersion = 1
    requestId = $requestId
    success = $true
    stage = 'complete'
    message = if ($dshRestored) { '插件与 Launcher 已按目标状态更新完成。' }
      else { '插件与 Launcher 已更新，但此前运行的 DSH 未能自动恢复，请查看日志后手动启动。' }
    sourceRevision = $catalog.sourceRevision
    sourceMode = $updateMode
    profile = $profileName
    profiles = @($profileTargets | ForEach-Object { $_.name })
    desiredFeatures = $desired
    launcher = [pscustomobject]@{ required = $true; action = 'verified' }
    dshRestored = $dshRestored
    statePath = Join-Path $LauncherRoot 'install-state.json'
    logPath = $logPath
    snapshot = Get-Snapshot (Resolve-RepositoryRoot '' $nextState) $profileName $nextState
  }
}

$launcherRoot = Get-LauncherRoot
[void](New-Item -ItemType Directory -Force -Path $launcherRoot)
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
if ($outputFullPath.StartsWith($launcherRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  [void](Assert-OwnedPath $outputFullPath $launcherRoot)
}
$statePath = Join-Path $launcherRoot 'install-state.json'
$request = $null

try {
  $state = Read-InstallState $statePath $launcherRoot
  $request = if ([string]::IsNullOrWhiteSpace($RequestPath)) { $null } else { Read-JsonFile $RequestPath }
  if ($Operation -eq 'Bind') {
    $root = Resolve-RepositoryRoot $RepositoryRoot $state
    $catalog = Get-Catalog $root
    $state = Update-StateBinding $state $root $catalog
    Write-JsonFile $statePath $state
    $result = Get-Snapshot $root $Profile $state
  } elseif ($Operation -eq 'ImportZip') {
    $root = Import-ManualSourceZip $RepositoryRoot $launcherRoot
    $catalog = Get-Catalog $root
    $state = Update-StateBinding $state $root $catalog
    Write-JsonFile $statePath $state
    $result = Get-Snapshot $root $Profile $state
  } else {
    $root = Resolve-RepositoryRoot $RepositoryRoot $state
    if ($Operation -eq 'Catalog') {
      $result = Get-Catalog $root
    } elseif ($Operation -eq 'Snapshot') {
      $result = Get-Snapshot $root $Profile $state
    } elseif ($Operation -eq 'CheckUpdate') {
      $catalog = Get-Catalog $root
      $gitInfo = Get-GitUpdateInfo $root $state -Fetch
      if ($null -ne $gitInfo) {
        $sourceInfo = $gitInfo
      } else {
        $coordinates = Get-GitHubCoordinates $catalog $state
        $remoteRevision = Get-RemoteCommit $coordinates $catalog.defaultRef
        $sourceInfo = [pscustomobject][ordered]@{
          mode = 'commit-zip'
          clean = $true
          currentRevision = $catalog.sourceRevision
          latestRevision = $remoteRevision
          relation = if ($catalog.sourceRevision -eq $remoteRevision) { 'current' } else { 'behind' }
          updateAvailable = $catalog.sourceRevision -ne $remoteRevision
        }
      }
      $result = [pscustomobject][ordered]@{ protocolVersion = 1; success = $true; source = $sourceInfo }
    } elseif ($Operation -eq 'Plan') {
      if ($null -eq $request) { throw 'Plan 操作缺少 RequestPath。' }
      $result = Get-ManagementPlan $root $Profile $state $request
    } elseif ($Operation -eq 'Apply') {
      if ($null -eq $request) { throw 'Apply 操作缺少 RequestPath。' }
      $mutex = New-Object System.Threading.Mutex($false, 'Local\DSH.Enhanced.WindowsLauncher.PluginManagement')
      $managementLock = [pscustomobject]@{ mutex = $mutex; taken = $false }
      try {
        $managementLock.taken = $mutex.WaitOne(0)
        if (-not $managementLock.taken) { throw '已有插件管理操作正在运行。' }
        $result = Invoke-Apply $request $state $root $launcherRoot $managementLock
      } finally {
        Release-PluginManagementLock $managementLock
        $mutex.Dispose()
      }
    }
  }
  Write-JsonFile $outputFullPath $result
  exit 0
} catch {
  $failureRequestId = if ($null -ne $request) { [string](Get-OptionalProperty $request 'requestId' '') } else { '' }
  $failureLogPath = if ($Operation -eq 'Apply' -and $failureRequestId -match '^[0-9a-fA-F-]{36}$') {
    Join-Path (Join-Path (Join-Path $launcherRoot 'updates') $failureRequestId) 'logs\update.log'
  } else { '' }
  $failure = [pscustomobject][ordered]@{
    protocolVersion = 1
    success = $false
    stage = $Operation.ToLowerInvariant()
    message = $_.Exception.Message
    detail = $_.Exception.ToString()
    logPath = $failureLogPath
  }
  try { Write-JsonFile $outputFullPath $failure } catch { }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
