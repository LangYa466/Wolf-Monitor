# wolf-node one-click installer (Windows).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iwr 'https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.ps1' -UseBasicParsing -OutFile 'install.ps1'; & '.\install.ps1' '-e' 'https://lg.langya.io' '-t' 'YOUR_TOKEN'"
#
# Optional GitHub proxy:
#   & '.\install.ps1' '-e' 'https://lg.langya.io' '-t' 'YOUR_TOKEN' '-Proxy' 'https://ghfast.top'

param(
  [Parameter(Mandatory = $true)][Alias("e")][string]$Endpoint,
  [Parameter(Mandatory = $true)][Alias("t")][string]$Token,
  [Alias("p")][string]$Proxy = "",
  [Alias("T")][string]$Transport = "ws",
  [Alias("i")][int]$Interval = 3,
  [Alias("V")][string]$Version = "latest",
  [switch]$Insecure
)

$ErrorActionPreference = "Stop"
$Repo = if ($env:WOLF_REPO) { $env:WOLF_REPO } else { "LangYa466/Wolf-Monitor" }
$InstallDir = "$env:ProgramData\wolf"
$Bin = Join-Path $InstallDir "wolf-node.exe"
$ServiceName = "wolf-node"

function Info($m) { Write-Host "[wolf] $m" }

# ── require admin (service install) ─────────────────────────────────────────
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "please run this in an elevated (Administrator) PowerShell"
}

# ── detect arch ─────────────────────────────────────────────────────────────
$arch = if ([Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -match "ARM") { "arm64" } else { "amd64" }
} else { "amd64" }
$asset = "wolf-node_windows_$arch.exe"

# ── download URL (+ optional proxy) ─────────────────────────────────────────
if ($Version -eq "latest") {
  $url = "https://github.com/$Repo/releases/latest/download/$asset"
} else {
  $url = "https://github.com/$Repo/releases/download/$Version/$asset"
}
if ($Proxy) { $url = ($Proxy.TrimEnd('/')) + "/" + $url }

Info "platform: windows/$arch"
Info "download:  $url"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Stop any existing service before overwriting the binary.
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Info "stopping existing service"
  Stop-Service $ServiceName -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}

Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $Bin

# ── build argument string ───────────────────────────────────────────────────
$argList = "-e `"$Endpoint`" -t `"$Token`" -transport $Transport -interval $Interval"
if ($Insecure) { $argList += " -insecure" }
$binPath = "`"$Bin`" $argList"

# ── install as a Windows service ────────────────────────────────────────────
Info "creating service '$ServiceName'"
# start= auto registers the service for automatic start at every boot.
sc.exe create $ServiceName binPath= "$binPath" start= auto DisplayName= "Wolf-Monitor node" | Out-Null
sc.exe description $ServiceName "Wolf-Monitor monitoring probe" | Out-Null
sc.exe failure $ServiceName reset= 0 actions= restart/5000 | Out-Null
Start-Service $ServiceName

Info "installed '$ServiceName' — started now AND set to auto-start on boot"
Info "manage with: Get-Service $ServiceName ; Stop-Service $ServiceName"
Info "done."
