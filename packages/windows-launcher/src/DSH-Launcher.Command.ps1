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

function Invoke-LoggedDsh {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Command,

    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,

    [Parameter(Mandatory = $true)]
    [string] $LogPath,

    [Parameter(Mandatory = $true)]
    [string] $Header,

    [string] $AccessPath = '',

    [string] $RequestId = '',

    [int] $ExpectedPort = 0
  )

  $logDirectory = Split-Path -Parent $LogPath
  if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Force -Path $logDirectory)
  }
  [System.IO.File]::AppendAllText($LogPath, $Header + [Environment]::NewLine, $Utf8NoBom)
  $writer = New-Object System.IO.StreamWriter($LogPath, $true, $Utf8NoBom)
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
    $writer.Dispose()
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
  [System.IO.File]::AppendAllText([string] $request.logPath,
    $Message + [Environment]::NewLine, $Utf8NoBom)
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
if ($mode -notin @('build', 'doctor', 'headless', 'profile', 'web')) {
  throw "Unsupported launcher request mode '$mode'."
}
$dsh = $null
$workingDirectory = if ($mode -eq 'build') {
  [string] $request.sourceDirectory
} else {
  $dsh = Resolve-SafeDshCommand -Path ([string] $request.dshCommand) -Mode $mode
  [string] $request.workingDirectory
}
if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
  throw "Working directory does not exist: $workingDirectory"
}

$originalDirectory = (Get-Location).Path
$originalPnpmVerifyDeps = [Environment]::GetEnvironmentVariable('pnpm_config_verify_deps_before_run', 'Process')
$buildStage = '环境检查'
try {
  Set-Location -LiteralPath $workingDirectory
  switch ($mode) {
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
          [System.IO.File]::AppendAllText($logPath,
            '===== Windows system proxy detected; applying it only to this Git pull =====' +
            [Environment]::NewLine, $Utf8NoBom)
        }
        $gitArguments += @('pull', '--ff-only')
        try {
          $gitResult = Invoke-LoggedDsh `
            -Command $git.Source `
            -Arguments $gitArguments `
            -LogPath $logPath `
            -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) git pull --ff-only ($workingDirectory) ====="
        } finally {
          if ($usesTemporaryGitProxy) {
            [System.IO.File]::AppendAllText($logPath,
              '===== Temporary Git proxy scope ended; no Git proxy setting was persisted =====' +
              [Environment]::NewLine, $Utf8NoBom)
          }
        }
        if ($gitResult.code -ne 0) {
          Write-BuildOutcome $false $gitResult.code (Get-SourceFailureMessage 'Git 拉取' $gitResult)
          exit $gitResult.code
        }
      } else {
        $skipHeader = "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) Skipping Git source update; running clean, frozen install, and build ($workingDirectory) ====="
        [System.IO.File]::AppendAllText($logPath, $skipHeader + [Environment]::NewLine, $Utf8NoBom)
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
          -LogPath $logPath `
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
        -LogPath $logPath `
        -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) dsh --profile $profile ====="
      exit $profileResult.code
    }
    'web' {
      $port = 0
      if (-not [int]::TryParse([string] $request.port, [ref] $port) -or $port -lt 0 -or $port -gt 65535) {
        throw 'Web port must be between 0 and 65535.'
      }
      $arguments = @('web', '--port', [string] $port)
      if ([bool] $request.noOpen) { $arguments += '--no-open' }
      $logPath = [string] $request.logPath
      $webResult = Invoke-LoggedDsh `
        -Command $dsh `
        -Arguments $arguments `
        -LogPath $logPath `
        -Header "===== $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) dsh web --port $port =====" `
        -AccessPath ([string] $request.accessPath) `
        -RequestId ([string] $request.requestId) `
        -ExpectedPort $port
      exit $webResult.code
    }
  }
} catch {
  if ($mode -ne 'build') { throw }
  Write-BuildOutcome $false 1 ($buildStage + '失败：' + $_.Exception.Message)
  exit 1
} finally {
  if ($mode -eq 'build') {
    [Environment]::SetEnvironmentVariable('pnpm_config_verify_deps_before_run', $originalPnpmVerifyDeps, 'Process')
  }
  Set-Location -LiteralPath $originalDirectory
  if ($mode -in @('build', 'doctor', 'headless', 'profile')) {
    Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue
  }
}
