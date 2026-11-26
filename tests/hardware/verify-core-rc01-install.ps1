$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'VCP-RC01-Validation'
New-Item -ItemType Directory -Force -Path $base | Out-Null
$receipt = Join-Path $base 'receipt.json'
$result = [ordered]@{ platform = 'Windows'; osBuild = [Environment]::OSVersion.Version.Build; account = $env:USERNAME; passed = $false }
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $result.administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($env:USERNAME -ne 'VcpRcUser' -or $result.administrator) { throw 'Expected a standard RC test user' }
    $install = Join-Path $base 'Install'
    $profile = Join-Path $base 'Profile'
    $state = Join-Path $base 'State'
    New-Item -ItemType Directory -Force -Path $profile, $state | Out-Null
    '{"ChatDataServiceEnabled":true,"ChatDataServiceNotifyEnabled":false,"disableUpdateCheck":true}' | Set-Content -Encoding ASCII (Join-Path $profile 'settings.json')
    $env:VCPCHAT_APP_DATA_DIR = $profile
    $env:VCPCHAT_STATE_DIR = $state
    $env:VCPCHAT_BOOTSTRAP_OPERATION_ID = 'rc01-windows'
    $setup = Join-Path $PSScriptRoot 'setup.exe'
    $result.installerSha256 = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
    $process = Start-Process -FilePath $setup -ArgumentList ('/S /D=' + $install) -PassThru -Wait
    $result.installerExit = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw 'Installer failed' }
    $exe = Get-ChildItem $install -Filter '*.exe' | Where-Object Name -NotLike 'Uninstall*' | Select-Object -First 1
    if (!$exe) { throw 'Installed Electron executable missing' }
    $ready = Join-Path $state 'ready-rc01-windows.json'
    if (!(Test-Path $ready)) { Start-Process -FilePath $exe.FullName -ArgumentList '--allow-multiple-instances','--disable-background-networking' }
    $limit = (Get-Date).AddSeconds(120)
    do { Start-Sleep -Milliseconds 500 } until ((Test-Path $ready) -or (Get-Date) -ge $limit)
    if (!(Test-Path $ready)) { throw 'Installed renderer did not produce a ready record' }
    $record = Get-Content $ready -Raw | ConvertFrom-Json
    $result.renderer = $record.checks.renderer
    if ($result.renderer -ne 'ready') { throw 'Installed renderer did not reach ready' }
    $cds = Get-Process vcp_chat_data_service | Where-Object { $_.Path -like ($install + '\*') } | Select-Object -First 1
    if (!$cds) { throw 'Installed CDS process missing' }
    $result.cdsSha256 = (Get-FileHash $cds.Path -Algorithm SHA256).Hash.ToLower()
    $result.installedExecutable = $exe.Name
    $result.passed = $true
} catch {
    $result.error = $_.Exception.Message
}
$result | ConvertTo-Json | Set-Content -Encoding UTF8 $receipt
$result | ConvertTo-Json
$target = Get-PSDrive -PSProvider FileSystem | Where-Object { Test-Path (Join-Path $_.Root 'rc01-marker.txt') } | Select-Object -First 1
if ($target) { Copy-Item $receipt (Join-Path $target.Root 'rc01.json') -Force }
