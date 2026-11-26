# Сборка установщика PocketBeacon-Setup-<version>.exe
# 1) копирует приложение в build\staging
# 2) скачивает портативный Node в staging\runtime
# 3) ставит прод-зависимости в staging
# 4) собирает установщик через Inno Setup (ISCC.exe)
#
# Требования: установленный Inno Setup 6 (winget install JRSoftware.InnoSetup)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot -Parent
$build = Join-Path $root "build"
$staging = Join-Path $build "staging"
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ---------- 1. Staging ----------

Write-Step "Готовлю staging (версия $version)"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $staging | Out-Null

foreach ($item in @("server", "public", "scripts", "package.json", "package-lock.json", ".env.example", "LICENSE", "README.md", "start.bat")) {
    Copy-Item (Join-Path $root $item) $staging -Recurse -Force
}
# dev-скрипты в установщике не нужны
Remove-Item "$staging\scripts\build-installer.ps1" -Force -ErrorAction SilentlyContinue
Remove-Item "$staging\scripts\test-socket.js" -Force -ErrorAction SilentlyContinue

# ---------- 2. Портативный Node ----------

$runtimeDir = Join-Path $staging "runtime"
if (-not (Test-Path "$runtimeDir\node.exe")) {
    Write-Step "Скачиваю портативный Node.js"
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $lts = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
    $zip = Join-Path $build "node-$lts.zip"
    if (-not (Test-Path $zip)) {
        Invoke-WebRequest "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip" -OutFile $zip
    }
    $extractTmp = Join-Path $build "node-extract"
    Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip -DestinationPath $extractTmp -Force
    New-Item -ItemType Directory -Force $runtimeDir | Out-Null
    Copy-Item "$extractTmp\node-$lts-win-x64\*" $runtimeDir -Recurse -Force
    Remove-Item $extractTmp -Recurse -Force
}

# ---------- 3. Зависимости в staging ----------

Write-Step "Устанавливаю зависимости в staging"
Push-Location $staging
$ErrorActionPreference = "Continue"
& "$runtimeDir\npm.cmd" install --omit=dev --ignore-scripts
# Проверяем, что модули резолвятся ИМЕННО из staging (Node ищет вверх по дереву
# и может найти node_modules родительского проекта — это ложный успех)
$resolved = & "$runtimeDir\node.exe" -e "try{console.log(require.resolve('better-sqlite3'))}catch(e){process.exit(1)}"
$depsOk = ($LASTEXITCODE -eq 0) -and ($resolved -like "$staging*") -and (Test-Path "$staging\node_modules\leaflet\dist\leaflet.js")
$ErrorActionPreference = "Stop"
Pop-Location
if (-not $depsOk) { throw "Зависимости в staging не работают (resolved: $resolved)" }

# ---------- 4. run-батник ----------

$runBat = "@echo off`r`nchcp 65001 >nul`r`ntitle Pocket Beacon`r`n`"%~dp0runtime\node.exe`" `"%~dp0server\index.js`"`r`npause`r`n"
[IO.File]::WriteAllText((Join-Path $staging "Pocket Beacon.bat"), $runBat, [Text.Encoding]::ASCII)

# ---------- 5. Inno Setup ----------

$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "ISCC.exe не найден. Установите Inno Setup: winget install JRSoftware.InnoSetup" }

Write-Step "Собираю установщик ($iscc)"
& $iscc "/DAppVersion=$version" "$root\installer\pocketbeacon.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC завершился с ошибкой $LASTEXITCODE" }

$exe = Join-Path $build "PocketBeacon-Setup-$version.exe"
if (-not (Test-Path $exe)) { throw "Файл установщика не создан: $exe" }
$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Step "Готово: $exe ($sizeMb МБ)"
