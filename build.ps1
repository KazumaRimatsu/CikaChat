# CikaChat Tauri Build Script
# 用法: .\build.ps1 [-OutputDir <输出目录>]
# 示例: .\build.ps1 -OutputDir "E:\Release"
#       .\build.ps1                       # 默认输出到 .\dist

param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"

# 读取产品名称
$configPath = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$productName = $config.productName

Write-Host "==============================" -ForegroundColor Cyan
Write-Host "  CikaChat Tauri Build Script" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host "产品名称: $productName"
Write-Host "输出目录: $OutputDir"
Write-Host "==============================" -ForegroundColor Cyan

# 创建输出目录
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Host "已创建输出目录: $OutputDir" -ForegroundColor Green
}

# 时间戳，用于清理旧文件
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$buildDir = Join-Path $OutputDir $timestamp

Write-Host "`n开始编译..." -ForegroundColor Yellow

# 设置 TAURI_OUTPUT_DIR 环境变量并执行构建
$env:TAURI_OUTPUT_DIR = $OutputDir

Push-Location $PSScriptRoot
try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri 构建失败，退出码: $LASTEXITCODE"
    }
    Write-Host "`n编译完成!" -ForegroundColor Green
}
finally {
    Pop-Location
    $env:TAURI_OUTPUT_DIR = $null
}

# 收集构建产物到带时间戳的子目录
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

$sourceBundle = Join-Path $PSScriptRoot "src-tauri\target\release\bundle"

if (Test-Path $sourceBundle) {
    # msi 安装包
    $msiDir = Join-Path $sourceBundle "msi"
    if (Test-Path $msiDir) {
        Copy-Item "$msiDir\*.msi" $buildDir -ErrorAction SilentlyContinue
    }

    # nsis 安装包
    $nsisDir = Join-Path $sourceBundle "nsis"
    if (Test-Path $nsisDir) {
        Copy-Item "$nsisDir\*.exe" $buildDir -ErrorAction SilentlyContinue
    }

    Write-Host "构建产物已复制到: $buildDir" -ForegroundColor Green
}
else {
    # TAURI_OUTPUT_DIR 生效时直接检查输出目录
    Write-Host "构建产物在输出目录中: $OutputDir" -ForegroundColor Green
}

# 显示产物列表
Write-Host "`n产物列表:" -ForegroundColor Cyan
$outputFiles = Get-ChildItem -Path $OutputDir -Recurse -File |
    Where-Object { $_.Extension -match '\.(exe|msi)$' }
foreach ($file in $outputFiles) {
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    Write-Host "  $($file.FullName) ($sizeMB MB)" -ForegroundColor White
}

Write-Host "`n完成!" -ForegroundColor Cyan

# 清理编译缓存
$targetDir = Join-Path $PSScriptRoot "src-tauri\target"
if (Test-Path $targetDir) {
    Write-Host "`n清理编译缓存..." -ForegroundColor Yellow
    Remove-Item -Path $targetDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "编译缓存已清理: $targetDir" -ForegroundColor Green
}
