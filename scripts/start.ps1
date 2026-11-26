# Pocket Beacon — установка и запуск одним файлом.
# Если Node.js не установлен — скачивает портативный в .runtime\ (в систему ничего не ставит).
# Затем: npm install -> создание .env со случайными секретами -> запуск сервера.

$ErrorActionPreference = "Stop"
# На случай старых настроек PowerShell 5.1 — принудительно TLS 1.2 для скачивания
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

function New-RandomString($len) {
    $chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    $bytes = New-Object byte[] $len
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

# ---------- 1. Node.js ----------

$nodeExe = $null

# 1a. системный Node версии >= 20
$sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($sysNode) {
    try {
        $v = (& node.exe --version) -replace '^v', ''
        if ([version]($v.Split('-')[0]) -ge [version]"20.0.0") { $nodeExe = $sysNode.Source }
    } catch { }
}

# 1b. ранее скачанный в .runtime
if (-not $nodeExe) {
    $local = Get-ChildItem "$root\.runtime\node-*-win-x64\node.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($local) { $nodeExe = $local.FullName }
}

# 1c. скачиваем портативный Node LTS
if (-not $nodeExe) {
    Write-Step "Node.js не найден — скачиваю портативную версию (~35 МБ)"
    New-Item -ItemType Directory -Force "$root\.runtime" | Out-Null
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $lts = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
    $zip = "$root\.runtime\node.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath "$root\.runtime" -Force
    Remove-Item $zip
    $nodeExe = (Get-ChildItem "$root\.runtime\node-*-win-x64\node.exe" |
        Select-Object -First 1).FullName
}

$nodeDir = Split-Path $nodeExe -Parent
$npmCmd = Join-Path $nodeDir "npm.cmd"
# node в PATH — на случай, если npm или его дочерние процессы ищут node
$env:PATH = "$nodeDir;$env:PATH"
Write-Step "Node.js $(& $nodeExe --version)"

# ---------- 2. Зависимости ----------

# Проверка фактом: код возврата npm ненадёжен (npm 11+ ругается на install-скрипты).
# EAP=Continue внутри — иначе PS 5.1 считает любой stderr нативной команды фатальным.
function Test-Deps {
    $ErrorActionPreference = "Continue"
    & $nodeExe -e "require('express');require('better-sqlite3');require('socket.io')" 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    # leaflet — браузерная библиотека, require() в Node падает; проверяем файл
    return Test-Path "$root\node_modules\leaflet\dist\leaflet.js"
}

if (-not (Test-Path "$root\node_modules\express\package.json")) {
    Write-Step "Устанавливаю зависимости (npm install)"
    # --ignore-scripts: сборка нативных модулей не нужна (better-sqlite3 несёт
    # готовые пребилды в пакете), а без флага npm пытается запустить node-gyp
    # из-за binding.gyp в тарболе и падает на машинах без компилятора.
    $ErrorActionPreference = "Continue"
    & $npmCmd install --omit=dev --ignore-scripts
    $ErrorActionPreference = "Stop"
}

if (-not (Test-Deps)) {
    Write-Host "Зависимости не встали. Пробую ещё раз..." -ForegroundColor Yellow
    $ErrorActionPreference = "Continue"
    & $npmCmd install --omit=dev --ignore-scripts
    $ErrorActionPreference = "Stop"
    if (-not (Test-Deps)) {
        throw "Не удалось установить зависимости. Запустите вручную: npm install"
    }
}

# ---------- 3. .env ----------

if (-not (Test-Path "$root\.env")) {
    Write-Step "Создаю .env со случайными секретами"
    $secret = New-RandomString 48
    $adminPassword = New-RandomString 12
    @"
PORT=3443
HOST_IP=
SESSION_SECRET=$secret
ADMIN_LOGIN=admin
ADMIN_PASSWORD=$adminPassword
"@ | Out-File -Encoding ascii "$root\.env"
    Write-Host ""
    Write-Host "  Логин администратора:  admin" -ForegroundColor Green
    Write-Host "  Пароль администратора: $adminPassword" -ForegroundColor Green
    Write-Host "  (сохранён в .env, поменяйте при желании и перезапустите)" -ForegroundColor Green
} elseif ((Get-Content "$root\.env" -Raw) -match "change-me") {
    Write-Host "ВНИМАНИЕ: в .env остались значения-заглушки (change-me). Замените их!" -ForegroundColor Yellow
}

# ---------- 4. Запуск ----------

Write-Step "Запускаю Pocket Beacon (остановка — Ctrl+C)"
& $nodeExe "$root\server\index.js"
