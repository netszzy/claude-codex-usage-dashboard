$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$phoneStarter = Join-Path $projectRoot 'start-dashboard-phone.bat'
$node = Get-Command node -ErrorAction Stop
$deadline = (Get-Date).AddSeconds(30)
$companionStarted = $false
$lastError = '服务尚未响应。'

if (-not (Test-Path -LiteralPath $phoneStarter)) {
  throw "缺少完整启动器：$phoneStarter"
}

& $phoneStarter

function Get-LocalResponse {
  param([string]$Uri)

  try {
    return Invoke-WebRequest -Uri $Uri -TimeoutSec 2 -SkipHttpErrorCheck
  } catch {
    $script:lastError = $_.Exception.Message
    return $null
  }
}

function Start-PhoneDisplayCompanion {
  $environment = @{
    PORT = '8789'
    HOST = '127.0.0.1'
    PHONE_DISPLAY = 'on'
    PHONE_DISPLAY_PORT = '8788'
    PHONE_DISPLAY_HOST = '0.0.0.0'
    PHONE_DISPLAY_SOURCE_PORT = '8787'
    NODE_NO_WARNINGS = '1'
  }
  Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -Environment $environment | Out-Null
}

while ((Get-Date) -lt $deadline) {
  $health = Get-LocalResponse -Uri 'http://127.0.0.1:8787/healthz'
  $usage = Get-LocalResponse -Uri 'http://127.0.0.1:8787/api/usage'
  $phone = Get-LocalResponse -Uri 'http://127.0.0.1:8788/phone/'

  $desktopReady = $health -and $health.StatusCode -eq 200 -and [string]$health.Headers['x-usage-dashboard'] -eq '1'
  $usageReady = $false
  if ($usage -and $usage.StatusCode -eq 200 -and [string]$usage.Headers['x-usage-dashboard'] -eq '1') {
    try {
      $usageReady = (ConvertFrom-Json -InputObject $usage.Content).PSObject.Properties.Name -contains 'agents'
    } catch {
      $lastError = '本机额度接口返回了无法解析的数据。'
    }
  }
  $phoneReady = $phone -and $phone.StatusCode -eq 200 -and [string]$phone.Headers['x-usage-phone-display'] -eq '1'

  if ($desktopReady -and $usageReady -and $phoneReady) {
    exit 0
  }

  if ($desktopReady -and -not $phoneReady -and -not $companionStarted -and (Get-Date).AddSeconds(22) -gt $deadline) {
    Start-PhoneDisplayCompanion
    $companionStarted = $true
  }

  Start-Sleep -Milliseconds 500
}

throw "Usage Watch 启动自检失败：$lastError"
