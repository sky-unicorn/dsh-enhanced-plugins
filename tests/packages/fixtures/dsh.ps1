# Test-only DSH command shim for the standalone Windows Launcher integration check.
$ErrorActionPreference = 'Stop'
$ChineseResult = -join @([char] 0x4E2D, [char] 0x6587, [char] 0x7ED3, [char] 0x679C)
$ChineseListening = -join @([char] 0x4E2D, [char] 0x6587, [char] 0x76D1, [char] 0x542C)

if ($args.Count -eq 1 -and $args[0] -eq '--version') {
  Write-Output "dsh-launcher-fixture $ChineseResult 0.1.0"
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq 'web') {
  $port = 0
  for ($index = 1; $index -lt $args.Count - 1; $index++) {
    if ($args[$index] -eq '--port') { $port = [int] $args[$index + 1] }
  }
  if ($port -le 0) { throw 'fixture web requires a positive --port' }
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
  try {
    $listener.Start()
    Write-Output "fixture web $ChineseListening on $port"
    while ($true) { Start-Sleep -Milliseconds 250 }
  } finally {
    $listener.Stop()
  }
}

if ($args.Count -ge 3 -and $args[0] -eq '--profile' -and $args[1] -eq 'headless') {
  Write-Output ('HEADLESS:' + $ChineseResult + ':' + [string] $args[2])
  exit 0
}

if ($args.Count -ge 2 -and $args[0] -eq '--profile') {
  Write-Output ('PROFILE:' + $ChineseResult + ':' + [string] $args[1])
  exit 0
}

throw ('Unsupported fixture arguments: ' + ($args -join ' | '))
