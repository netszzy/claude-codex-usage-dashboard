param(
  [switch]$Uninstall,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$runner = Join-Path $root 'run-desktop-hidden.vbs'
$legacyRunner = Join-Path $root 'run-hidden.vbs'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcutName = 'AIUsageDashboardDesktop.lnk'
$legacyNames = @('AIUsageDashboard.lnk')
$ownedRunners = @($runner, $legacyRunner)
$ws = New-Object -ComObject WScript.Shell

$locations = @(
  [pscustomobject]@{ Name = 'startup'; Path = [Environment]::GetFolderPath('Startup') },
  [pscustomobject]@{ Name = 'desktop'; Path = [Environment]::GetFolderPath('Desktop') }
)

function Test-OwnedShortcut {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $shortcut = $ws.CreateShortcut($Path)
    $targetMatches = [string]::Equals(
      [IO.Path]::GetFullPath([string]$shortcut.TargetPath),
      [IO.Path]::GetFullPath($wscript),
      [StringComparison]::OrdinalIgnoreCase
    )
    $argumentPath = ([string]$shortcut.Arguments).Trim().Trim('"')
    $runnerMatches = $ownedRunners | Where-Object {
      [string]::Equals(
        [IO.Path]::GetFullPath($_),
        [IO.Path]::GetFullPath($argumentPath),
        [StringComparison]::OrdinalIgnoreCase
      )
    }
    return $targetMatches -and @($runnerMatches).Count -gt 0
  } catch {
    return $false
  }
}

function Assert-ShortcutSlotAvailable {
  param([string]$Directory, [string]$Name)

  if (-not $Directory) { throw "Windows did not return a path for shortcut location: $Name" }
  $path = Join-Path $Directory $Name
  if ((Test-Path -LiteralPath $path) -and -not (Test-OwnedShortcut -Path $path)) {
    throw "Refusing to overwrite a shortcut not owned by this dashboard: $path"
  }
}

function Remove-OwnedShortcut {
  param([string]$Directory, [string]$Name)

  if (-not $Directory) { return }
  $path = Join-Path $Directory $Name
  if (-not (Test-Path -LiteralPath $path)) { return }
  if (-not (Test-OwnedShortcut -Path $path)) {
    Write-Warning "Skipped shortcut not owned by this dashboard: $path"
    return
  }
  Remove-Item -LiteralPath $path -Force
  Write-Host "Removed $path"
}

function New-DashboardShortcut {
  param([string]$Directory)

  if (-not (Test-Path -LiteralPath $Directory)) {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  }

  $path = Join-Path $Directory $shortcutName
  $shortcut = $ws.CreateShortcut($path)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = '"' + $runner + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = $electron + ',0'
  $shortcut.Save()

  if (-not (Test-OwnedShortcut -Path $path)) {
    throw "Shortcut verification failed: $path"
  }
  Write-Host "Installed $path"
}

if ($Uninstall) {
  foreach ($location in $locations) {
    Remove-OwnedShortcut -Directory $location.Path -Name $shortcutName
    foreach ($legacyName in $legacyNames) {
      Remove-OwnedShortcut -Directory $location.Path -Name $legacyName
    }
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $electron)) {
  throw "Missing Electron. Run npm install first: $electron"
}
if (-not (Test-Path -LiteralPath $runner)) {
  throw "Missing launcher: $runner"
}

foreach ($location in $locations) {
  Assert-ShortcutSlotAvailable -Directory $location.Path -Name $shortcutName
}
foreach ($location in $locations) {
  New-DashboardShortcut -Directory $location.Path
}
foreach ($location in $locations) {
  foreach ($legacyName in $legacyNames) {
    Remove-OwnedShortcut -Directory $location.Path -Name $legacyName
  }
}

if (-not $NoStart) {
  Start-Process -FilePath $wscript -ArgumentList ('"' + $runner + '"') -WindowStyle Hidden
}
