# wolf-node one-click installer (Windows).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; iwr 'https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.ps1' -UseBasicParsing -OutFile 'install.ps1'; & '.\install.ps1' '-e' 'https://lg.langya.io' '-t' 'YOUR_TOKEN'"
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
  [switch]$Insecure,
  [switch]$NoVerifyChecksum
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.x defaults to TLS 1.0/1.1 which github.com / proxies reject.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
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
  $baseUrl = "https://github.com/$Repo/releases/latest/download"
} else {
  $baseUrl = "https://github.com/$Repo/releases/download/$Version"
}
$url = "$baseUrl/$asset"
$sumDirect = "$baseUrl/SHA256SUMS"        # trust anchor — never via proxy first
$sumProxied = $sumDirect
if ($Proxy) {
  $url = ($Proxy.TrimEnd('/')) + "/" + $url
  $sumProxied = ($Proxy.TrimEnd('/')) + "/" + $sumDirect
}

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

$tmp = [System.IO.Path]::Combine($env:TEMP, "wolf-node-$([System.Guid]::NewGuid().ToString('N')).bin")
Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $tmp

# ── verify SHA256 against the release manifest ──────────────────────────────
# Always pull the manifest from github.com directly so a malicious proxy can't
# swap both binary and checksum. Falls back to the proxied manifest with a
# warning when github.com is unreachable; -NoVerifyChecksum is the opt-out.
if ($NoVerifyChecksum) {
  Info "WARNING: -NoVerifyChecksum used — skipping integrity check"
} else {
  $sumFile = [System.IO.Path]::Combine($env:TEMP, "wolf-node-sums-$([System.Guid]::NewGuid().ToString('N')).txt")
  $sumsOk = $false
  try {
    Invoke-WebRequest -Uri $sumDirect -UseBasicParsing -OutFile $sumFile -TimeoutSec 60
    $sumsOk = $true
  } catch {
    if ($Proxy) {
      try {
        Invoke-WebRequest -Uri $sumProxied -UseBasicParsing -OutFile $sumFile -TimeoutSec 60
        Info "WARNING: SHA256SUMS fetched via proxy — checksum is only as trustworthy as the proxy"
        $sumsOk = $true
      } catch { }
    }
  }
  if (-not $sumsOk) {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    throw "failed to fetch SHA256SUMS from $sumDirect (rerun with -NoVerifyChecksum to skip — NOT recommended)"
  }
  $expected = $null
  Get-Content $sumFile | ForEach-Object {
    if ($_ -match "^([0-9a-fA-F]{64})\s+\*?($([regex]::Escape($asset)))\s*$") {
      $expected = $Matches[1].ToLower()
    }
  }
  Remove-Item $sumFile -ErrorAction SilentlyContinue
  if (-not $expected) {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    throw "no SHA256 entry for $asset in manifest"
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
  if ($expected -ne $actual) {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    throw "checksum mismatch! expected=$expected actual=$actual — refusing to install"
  }
  Info "checksum OK (sha256=$actual)"
}

Move-Item -Force -Path $tmp -Destination $Bin

# ── build argument string ───────────────────────────────────────────────────
$argList = "-e `"$Endpoint`" -t `"$Token`" -transport $Transport -interval $Interval"
if ($Insecure) { $argList += " -insecure" }
$binPath = "`"$Bin`" $argList"

# ── install as a Windows service ────────────────────────────────────────────
Info "creating service '$ServiceName'"
# Defense-in-depth: run as the per-service virtual account `NT SERVICE\wolf-node`
# instead of LocalSystem. Virtual accounts have no password, get a per-service
# SID, and on Windows still have enough rights to query WMI/PDH counters that
# gopsutil needs — but cannot tamper with arbitrary system state the way
# LocalSystem can if the binary is ever compromised.
# start= auto registers the service for automatic start at every boot.
sc.exe create $ServiceName binPath= "$binPath" start= auto `
  obj= "NT SERVICE\$ServiceName" `
  DisplayName= "Wolf-Monitor node" | Out-Null
sc.exe description $ServiceName "Wolf-Monitor monitoring probe" | Out-Null
sc.exe failure $ServiceName reset= 0 actions= restart/5000 | Out-Null
# Grant the install dir to the virtual account so the service can read its
# binary and write logs/cache without needing broader filesystem rights.
try {
  $acl = Get-Acl $InstallDir
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "NT SERVICE\$ServiceName",
    "ReadAndExecute,Write",
    "ContainerInherit,ObjectInherit",
    "None",
    "Allow")
  $acl.AddAccessRule($rule)
  Set-Acl -Path $InstallDir -AclObject $acl
} catch {
  Info "WARNING: could not grant ACL to NT SERVICE\$ServiceName ($_) — service may fail to start"
}
Start-Service $ServiceName

Info "installed '$ServiceName' — started now AND set to auto-start on boot"
Info "manage with: Get-Service $ServiceName ; Stop-Service $ServiceName"
Info "done."
