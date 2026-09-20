#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$gitProxyHelper = Join-Path $PSScriptRoot 'DSH-Launcher.GitProxy.ps1'
if (-not (Test-Path -LiteralPath $gitProxyHelper -PathType Leaf)) {
  throw "Launcher Git proxy helper does not exist: $gitProxyHelper"
}
. $gitProxyHelper

function Publish-WebAccess {
  param(
    [string] $Line,
    [string] $AccessPath,
    [string] $RequestId,
    [int] $ExpectedPort
  )

  if ([string]::IsNullOrWhiteSpace($AccessPath) -or
    [string]::IsNullOrWhiteSpace($RequestId) -or $ExpectedPort -le 0) { return }
  $escapedPort = [regex]::Escape([string] $ExpectedPort)
  $match = [regex]::Match($Line,
    '^dsh web: http://127\.0\.0\.1:' + $escapedPort + '/\?token=([A-Za-z0-9_-]{20,256})(?:\s|$)')
  if (-not $match.Success) { return }

  $directory = Split-Path -Parent $AccessPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $directory)
  }
  $temporary = $AccessPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $value = [ordered]@{
    requestId = $RequestId
    port = $ExpectedPort
    token = $match.Groups[1].Value
    readyAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), $Utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $AccessPath -Force
}

function Protect-LoggedWebUrl {
  param([string] $Line)
  return [regex]::Replace($Line, '([?&]token=)[A-Za-z0-9_-]+', '$1<redacted>')
}

function Write-RequestLog {
  param([string] $Text)
  $script:requestLogWriter.Write($Text)
  $script:requestLogWriter.Flush()
}

function Invoke-LoggedDsh {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Command,

    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,

    [Parameter(Mandatory = $true)]
    [string] $Header,

    [string] $AccessPath = '',

    [string] $RequestId = '',

    [int] $ExpectedPort = 0
  )

  $writer = $script:requestLogWriter
  Write-RequestLog ($Header + [Environment]::NewLine)
  $tail = New-Object 'System.Collections.Generic.Queue[string]'
  $originalErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 wraps native stderr in ErrorRecord objects. Git
    # progress and pnpm warnings are not failures: preserve both streams and
    # decide only after the child has exited. Keep Stop everywhere else.
    $ErrorActionPreference = 'Continue'
    & $Command @Arguments 2>&1 | ForEach-Object {
      $line = [string] $_
      Publish-WebAccess $line $AccessPath $RequestId $ExpectedPort
      $logLine = Protect-LoggedWebUrl $line
      $writer.WriteLine($logLine)
      $writer.Flush()
      $tail.Enqueue($logLine)
      if ($tail.Count -gt 24) { [void] $tail.Dequeue() }
    }
    $code = $LASTEXITCODE
    $writer.WriteLine("===== exit=$code =====")
    return [pscustomobject]@{ code = $code; output = ($tail.ToArray() -join [Environment]::NewLine) }
  } finally {
    $ErrorActionPreference = $originalErrorActionPreference
    $writer.Flush()
  }
}

function Write-BuildOutcome {
  param([bool] $Success, [int] $ExitCode, [string] $Message)

  $outcome = [ordered]@{
    requestId = [string] $request.requestId
    success = $Success
    exitCode = $ExitCode
    message = $Message
  }
  Write-RequestLog ($Message + [Environment]::NewLine)
  $resultProperty = $request.PSObject.Properties['resultPath']
  if ($null -ne $resultProperty -and -not [string]::IsNullOrWhiteSpace([string] $resultProperty.Value)) {
    [System.IO.File]::WriteAllText([string] $resultProperty.Value,
      ($outcome | ConvertTo-Json -Compress), $Utf8NoBom)
  }
}

function Get-SourceFailureMessage {
  param([string] $Stage, [object] $Result)

  $message = "$Stage" + "失败（退出码 $($Result.code)）。"
  if ($Stage -eq 'Git 拉取') {
    $message += '未执行清理、依赖安装或构建。'
    if ($Result.output -match '(?i)connection (?:was )?reset|recv failure|could not resolve host|failed to connect|timed out|network is unreachable') {
      $message += '请检查网络或 Git 代理后重试。'
    } elseif ($Result.output -match '(?i)not possible to fast-forward|diverg|would be overwritten|local changes') {
      $message += '请先处理本地修改或分叉；Launcher 不会强制覆盖源码。'
    } elseif ($Result.output -match '(?i)no tracking information|not currently on a branch') {
      $message += '请先为当前分支设置上游。'
    }
  } elseif ($Stage -in @('清理构建产物', '依赖安装')) {
    $message += '未执行后续步骤。'
  }
  return $message + '详细原因见运行日志。'
}

function Resolve-SafeDshCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Mode
  )

  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $extension = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
  if ($extension -eq '.cmd') {
    $powershellShim = [System.IO.Path]::ChangeExtension($resolved, '.ps1')
    if (Test-Path -LiteralPath $powershellShim -PathType Leaf) {
      return (Resolve-Path -LiteralPath $powershellShim).Path
    }
    if ($Mode -ne 'web') {
      throw 'The located dsh.cmd has no sibling dsh.ps1; interactive input cannot be forwarded safely.'
    }
  }
  if ($extension -notin @('.ps1', '.cmd', '.exe')) {
    throw "Unsupported dsh launcher extension '$extension'."
  }
  return $resolved
}

if (-not (Test-Path -LiteralPath $RequestPath -PathType Leaf)) {
  throw "Launcher request does not exist: $RequestPath"
}

$request = Get-Content -Raw -LiteralPath $RequestPath -Encoding UTF8 | ConvertFrom-Json
$mode = [string] $request.mode
if ($mode -notin @('build', 'doctor', 'headless', 'profile', 'web', 'desktop')) {
  throw "Unsupported launcher request mode '$mode'."
}
$dsh = $null
$script:requestLogWriter = $null
$originalDirectory = (Get-Location).Path
$originalPnpmVerifyDeps = [Environment]::GetEnvironmentVariable('pnpm_config_verify_deps_before_run', 'Process')
$proxyEnvironmentBefore = @{}
$buildStage = '环境检查'
try {
  if ($mode -in @('build', 'desktop', 'web', 'profile')) {
    $logPath = [string] $request.logPath
    if ([string]::IsNullOrWhiteSpace($logPath)) { throw 'Execution log path is missing.' }
    [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $logPath))
    # Open with one writer for the whole request. A competing run cannot
    # truncate an active log, and build steps keep appending within this run.
    $logStream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    try { $script:requestLogWriter = New-Object System.IO.StreamWriter($logStream, $Utf8NoBom) }
    catch { $logStream.Dispose(); throw }
    Write-RequestLog ("===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $mode request=$($request.requestId) =====" + [Environment]::NewLine)
  }
  $workingDirectory = if ($mode -in @('build', 'desktop')) {
    [string] $request.sourceDirectory
  } else {
    $dsh = Resolve-SafeDshCommand -Path ([string] $request.dshCommand) -Mode $mode
    [string] $request.workingDirectory
  }
  if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
    throw "Working directory does not exist: $workingDirectory"
  }
  Set-Location -LiteralPath $workingDirectory
  if ($mode -in @('web', 'profile', 'headless', 'desktop')) {
    $proxyFallback = Get-DshSystemProxyEnvironment
    foreach ($key in $proxyFallback.environment.Keys) {
      $proxyEnvironmentBefore[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, [string]$proxyFallback.environment[$key], 'Process')
    }
    $proxyMessage = switch ($proxyFallback.reason) {
      'windows-system' { 'Launcher: using the Windows HTTP/HTTPS proxy for this DSH process; bypass follows DSH NO_PROXY rules.' }
      'explicit-environment' { 'Launcher: preserving explicit proxy environment for DSH.' }
      'explicit-home-env' { 'Launcher: leaving proxy configuration to the DSH home .env file.' }
      'automatic-policy' { 'Launcher: Windows PAC/WPAD requires explicit HTTP_PROXY/HTTPS_PROXY configuration for DSH.' }
      'unsupported-policy' { 'Launcher: Windows proxy policy requires explicit HTTP_PROXY/HTTPS_PROXY configuration for DSH.' }
      'unavailable' { 'Launcher: proxy discovery unavailable; leaving DSH networking unchanged.' }
      default { 'Launcher: no Windows manual proxy found; leaving DSH networking unchanged.' }
    }
    if ($null -ne $script:requestLogWriter) { Write-RequestLog ($proxyMessage + [Environment]::NewLine) }
    else { Write-Host $proxyMessage }
  }
  switch ($mode) {
    'desktop' {
      $manifest = Get-Content -Raw -LiteralPath (Join-Path $workingDirectory 'package.json') -Encoding UTF8 | ConvertFrom-Json
      if ($manifest.name -ne '@deepseek-ai/dsh-root' -or [string]$manifest.packageManager -notmatch '^pnpm@([^+]+)') {
        throw 'Desktop source launch requires the DSH checkout and its declared pnpm version.'
      }
      $expectedPnpm = $Matches[1]
      $desktopScript = if ([bool]$request.desktopBuild) { 'dev:desktop' } else { 'start:desktop' }
      $scriptProperty = $manifest.scripts.PSObject.Properties[$desktopScript]
      if ($null -eq $scriptProperty -or [string]::IsNullOrWhiteSpace([string]$scriptProperty.Value)) {
        throw "DSH does not provide $desktopScript. Update the configured source checkout."
      }
      if (-not [bool]$request.desktopBuild) {
        foreach ($artifact in @('apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js', 'apps/web/dist/index.html')) {
          if (-not (Test-Path -LiteralPath (Join-Path $workingDirectory $artifact) -PathType Leaf)) {
            throw "Desktop build is incomplete ($artifact). Choose Build and start desktop."
          }
        }
      }
      $helper = Join-Path $PSScriptRoot 'DSH-Launcher.Toolchain.cjs'
      $planJson = & ([string]$request.runtimeNode) $helper prepare $RequestPath
      if ($LASTEXITCODE -ne 0) { throw '桌面运行环境准备失败。请查看运行环境和桌面日志。' }
      $toolchain = $planJson | ConvertFrom-Json
      if ($toolchain.summary.manager -ne 'pnpm') { throw 'DSH desktop requires pnpm.' }
      foreach ($entry in $toolchain.environment.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
      }
      $pnpm = Get-Command pnpm -CommandType Application -ErrorAction Stop | Select-Object -First 1
      $actualPnpm = (& $pnpm.Source --version | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $actualPnpm -cne $expectedPnpm) {
        throw "DSH requires pnpm $expectedPnpm; resolved $actualPnpm. Install the declared version or use the Launcher NVM toolchain."
      }
      $toolchain.summary.managerVersion = $actualPnpm
      $toolchain.summary.phase = 'ready'
      $toolchain.summary.message = '桌面工具链已就绪。'
      $runtimeTemporary = ([string]$request.runtimePath) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
      [System.IO.File]::WriteAllText($runtimeTemporary, ($toolchain.summary | ConvertTo-Json -Depth 6), $Utf8NoBom)
      Move-Item -LiteralPath $runtimeTemporary -Destination ([string]$request.runtimePath) -Force
      [Environment]::SetEnvironmentVariable('pnpm_config_verify_deps_before_run', 'false', 'Process')
      if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('DSH_DESKTOP_OPEN_DEVTOOLS', 'Process'))) {
        [Environment]::SetEnvironmentVariable('DSH_DESKTOP_OPEN_DEVTOOLS', '0', 'Process')
      }
      $desktopResult = Invoke-LoggedDsh -Command $pnpm.Source -Arguments @('run', $desktopScript) `
        -Header "===== pnpm run $desktopScript ($workingDirectory) ====="
      exit $desktopResult.code
    }
    'build' {
      $manifestPath = Join-Path $workingDirectory 'package.json'
      if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'The configured DSH source directory has no package.json.'
      }
      $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
      if ([string] $manifest.name -ne '@deepseek-ai/dsh-root' -or
        [string]::IsNullOrWhiteSpace([string] $manifest.scripts.build)) {
        throw 'The configured source directory is not a buildable DSH checkout.'
      }
      $logPath = [string] $request.logPath
      if ([string]::IsNullOrWhiteSpace($logPath)) { throw 'DSH build log path is missing.' }

      if ([bool] $request.updateSource) {
        $buildStage = 'Git 拉取'
        $git = Get-Command -Name 'git' -CommandType Application -ErrorAction Stop |
          Select-Object -First 1
        $gitArguments = @('-C', $workingDirectory)
        $gitRemoteUrl = Get-GitPullTargetUrl $git.Source $workingDirectory
        $gitProxy = Resolve-SystemGitProxy $gitRemoteUrl
        $usesTemporaryGitProxy = -not [string]::IsNullOrWhiteSpace($gitProxy)
        if ($usesTemporaryGitProxy) {
          # -c is scoped to this Git process. It neither overwrites an existing
          # user/repository proxy nor leaves a setting behind when pull fails.
          $gitArguments += @('-c', "http.proxy=$gitProxy")
          Write-RequestLog ('===== Windows system proxy detected; applying it only to this Git pull =====' +
            [Environment]::NewLine)
        }
        $gitArguments += @('pull', '--ff-only')
        try {
          $gitResult = Invoke-LoggedDsh `
            -Command $git.Source `
            -Arguments $gitArguments `
            -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) git pull --ff-only ($workingDirectory) ====="
        } finally {
          if ($usesTemporaryGitProxy) {
            Write-RequestLog ('===== Temporary Git proxy scope ended; no Git proxy setting was persisted =====' +
              [Environment]::NewLine)
          }
        }
        if ($gitResult.code -ne 0) {
          Write-BuildOutcome $false $gitResult.code (Get-SourceFailureMessage 'Git 拉取' $gitResult)
          exit $gitResult.code
        }
      } else {
        $skipHeader = "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) Skipping Git source update; running clean, frozen install, and build ($workingDirectory) ====="
        Write-RequestLog ($skipHeader + [Environment]::NewLine)
      }

      # Pull can change the scripts or lockfile. Validate the updated checkout
      # and toolchain before clean removes any existing build artifacts.
      $buildStage = '环境检查'
      $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
      if ([string] $manifest.name -ne '@deepseek-ai/dsh-root' -or
        [string]::IsNullOrWhiteSpace([string] $manifest.scripts.clean) -or
        [string]::IsNullOrWhiteSpace([string] $manifest.scripts.build)) {
        throw 'The configured DSH checkout must provide clean and build scripts.'
      }
      if (-not (Test-Path -LiteralPath (Join-Path $workingDirectory 'pnpm-lock.yaml') -PathType Leaf)) {
        throw 'The configured DSH checkout has no pnpm-lock.yaml; frozen dependency installation is required.'
      }
      $runtimeNodeProperty = $request.PSObject.Properties['runtimeNode']
      if ($null -ne $runtimeNodeProperty -and -not [string]::IsNullOrWhiteSpace([string]$runtimeNodeProperty.Value)) {
        $helper = Join-Path $PSScriptRoot 'DSH-Launcher.Toolchain.cjs'
        $planJson = & ([string]$runtimeNodeProperty.Value) $helper prepare $RequestPath
        if ($LASTEXITCODE -ne 0) { throw '源码运行环境准备失败。请查看构建日志。' }
        $toolchain = $planJson | ConvertFrom-Json
        if ($toolchain.summary.mode -eq 'sandbox') {
          if ($toolchain.summary.manager -ne 'pnpm') { throw 'DSH source build requires pnpm.' }
          foreach ($entry in $toolchain.environment.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
          }
          Write-RequestLog ("NVM: Node $($toolchain.summary.nodeVersion) [$($toolchain.summary.nodePath)], pnpm $($toolchain.summary.managerVersion)" +
            [Environment]::NewLine)
        }
      }
      $pnpm = Get-Command -Name 'pnpm' -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
      # pnpm 11 otherwise auto-installs before `run clean`, potentially rewriting
      # the lockfile before our explicit frozen install can validate it.
      [Environment]::SetEnvironmentVariable('pnpm_config_verify_deps_before_run', 'false', 'Process')
      $buildSteps = @(
        @{ stage = '清理构建产物'; arguments = @('run', 'clean') },
        @{ stage = '依赖安装'; arguments = @('install', '--frozen-lockfile') },
        @{ stage = 'DSH 构建'; arguments = @('run', 'build') }
      )
      foreach ($step in $buildSteps) {
        $buildStage = $step.stage
        $commandLabel = 'pnpm ' + ($step.arguments -join ' ')
        $stepResult = Invoke-LoggedDsh `
          -Command $pnpm.Source `
          -Arguments $step.arguments `
          -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $commandLabel ($workingDirectory) ====="
        if ($stepResult.code -ne 0) {
          Write-BuildOutcome $false $stepResult.code (Get-SourceFailureMessage $buildStage $stepResult)
          exit $stepResult.code
        }
      }
      $message = if ([bool] $request.updateSource) { 'DSH 源码已更新并构建完成。' } else { 'DSH 源码构建完成（未执行 Git 更新）。' }
      Write-BuildOutcome $true 0 $message
      exit 0
    }
    'doctor' {
      & $dsh --version
      exit $LASTEXITCODE
    }
    'headless' {
      $task = [string] $request.task
      if ([string]::IsNullOrWhiteSpace($task)) { throw 'Headless task cannot be empty.' }
      & $dsh --profile headless $task
      exit $LASTEXITCODE
    }
    'profile' {
      $profile = [string] $request.profile
      if ($profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Profile name is invalid.' }
      $logPath = [string] $request.logPath
      if ([string]::IsNullOrWhiteSpace($logPath)) { throw 'Profile log path is missing.' }
      $profileResult = Invoke-LoggedDsh `
        -Command $dsh `
        -Arguments @('--profile', $profile) `
        -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) dsh --profile $profile ====="
      exit $profileResult.code
    }
    'web' {
      $toolchain = $null
      $runtimeNodeProperty = $request.PSObject.Properties['runtimeNode']
      if ($null -ne $runtimeNodeProperty -and -not [string]::IsNullOrWhiteSpace([string] $runtimeNodeProperty.Value)) {
        $helper = Join-Path $PSScriptRoot 'DSH-Launcher.Toolchain.cjs'
        if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Launcher toolchain component is missing.' }
        $planJson = & ([string] $runtimeNodeProperty.Value) $helper prepare $RequestPath
        if ($LASTEXITCODE -ne 0) { throw '运行环境准备失败，请查看概览页的运行环境状态。' }
        $toolchain = $planJson | ConvertFrom-Json
        if ($toolchain.summary.mode -eq 'sandbox') {
          foreach ($entry in $toolchain.environment.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable($entry.Name, [string] $entry.Value, 'Process')
          }
          $dsh = [string] $toolchain.summary.nodePath
        }
      }
      $port = 0
      if (-not [int]::TryParse([string] $request.port, [ref] $port) -or $port -lt 0 -or $port -gt 65535) {
        throw 'Web port must be between 0 and 65535.'
      }
      $arguments = @('web', '--port', [string] $port)
      if ([bool] $request.noOpen) { $arguments += '--no-open' }
      if ($null -ne $toolchain -and $toolchain.summary.mode -eq 'sandbox') {
        $arguments = @($toolchain.args) + $arguments
      }
      $logPath = [string] $request.logPath
      $webResult = Invoke-LoggedDsh `
        -Command $dsh `
        -Arguments $arguments `
        -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) dsh web --port $port =====" `
        -AccessPath ([string] $request.accessPath) `
        -RequestId ([string] $request.requestId) `
        -ExpectedPort $port
      exit $webResult.code
    }
  }
} catch {
  # Failed acquisition must not write into the other run's active log.
  if ($mode -in @('build', 'desktop', 'web', 'profile') -and $null -eq $script:requestLogWriter) { throw }
  if ($mode -eq 'desktop') {
    Write-RequestLog ('桌面启动失败：' + $_.Exception.Message + [Environment]::NewLine)
    exit 1
  }
  if ($mode -eq 'web') {
    Write-RequestLog ('Web 启动失败：' + $_.Exception.Message + [Environment]::NewLine)
  }
  if ($mode -eq 'profile') {
    Write-RequestLog ('Profile 启动失败：' + $_.Exception.Message + [Environment]::NewLine)
  }
  if ($mode -ne 'build') { throw }
  Write-BuildOutcome $false 1 ($buildStage + '失败：' + $_.Exception.Message)
  exit 1
} finally {
  foreach ($key in $proxyEnvironmentBefore.Keys) {
    [Environment]::SetEnvironmentVariable($key, $proxyEnvironmentBefore[$key], 'Process')
  }
  if ($null -ne $script:requestLogWriter) { $script:requestLogWriter.Dispose() }
  if ($mode -in @('build', 'desktop')) {
    [Environment]::SetEnvironmentVariable('pnpm_config_verify_deps_before_run', $originalPnpmVerifyDeps, 'Process')
  }
  Set-Location -LiteralPath $originalDirectory
  if ($mode -in @('build', 'doctor', 'headless', 'profile')) {
    Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue
  }
}
