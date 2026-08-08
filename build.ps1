# KnockChat Tauri Build Script
# �÷�: .\build.ps1 [-OutputDir <���Ŀ¼>]
# ʾ��: .\build.ps1 -OutputDir "E:\Release"
#       .\build.ps1                       # Ĭ������� .\dist

param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"

# ��ȡ��Ʒ����
$configPath = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$productName = $config.productName

Write-Host "==============================" -ForegroundColor Cyan
Write-Host "  KnockChat Tauri Build Script" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host "��Ʒ����: $productName"
Write-Host "���Ŀ¼: $OutputDir"
Write-Host "==============================" -ForegroundColor Cyan

# �������Ŀ¼
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Host "�Ѵ������Ŀ¼: $OutputDir" -ForegroundColor Green
}

# ʱ����������������ļ�
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$buildDir = Join-Path $OutputDir $timestamp

Write-Host "`n��ʼ����..." -ForegroundColor Yellow

# ���� TAURI_OUTPUT_DIR ����������ִ�й���
$env:TAURI_OUTPUT_DIR = $OutputDir

Push-Location $PSScriptRoot
try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri ����ʧ�ܣ��˳���: $LASTEXITCODE"
    }
    Write-Host "`n�������!" -ForegroundColor Green
}
finally {
    Pop-Location
    $env:TAURI_OUTPUT_DIR = $null
}

# �ռ��������ﵽ��ʱ�������Ŀ¼
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

$sourceBundle = Join-Path $PSScriptRoot "src-tauri\target\release\bundle"

if (Test-Path $sourceBundle) {
    # msi ��װ��
    $msiDir = Join-Path $sourceBundle "msi"
    if (Test-Path $msiDir) {
        Copy-Item "$msiDir\*.msi" $buildDir -ErrorAction SilentlyContinue
    }

    # nsis ��װ��
    $nsisDir = Join-Path $sourceBundle "nsis"
    if (Test-Path $nsisDir) {
        Copy-Item "$nsisDir\*.exe" $buildDir -ErrorAction SilentlyContinue
    }

    # ���� exe��release Ŀ¼�µĿ�ִ���ļ���
    $releaseDir = Join-Path $PSScriptRoot "src-tauri\target\release"
    if (Test-Path $releaseDir) {
        Copy-Item "$releaseDir\$productName.exe" $buildDir -ErrorAction SilentlyContinue
    }

    Write-Host "���������Ѹ��Ƶ�: $buildDir" -ForegroundColor Green
}
else {
    # TAURI_OUTPUT_DIR ��Чʱֱ�Ӽ�����Ŀ¼
    Write-Host "�������������Ŀ¼��: $OutputDir" -ForegroundColor Green
}

# ��ʾ�����б�
Write-Host "`n�����б�:" -ForegroundColor Cyan
$outputFiles = Get-ChildItem -Path $OutputDir -Recurse -File |
    Where-Object { $_.Extension -match '\.(exe|msi)$' }
foreach ($file in $outputFiles) {
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    Write-Host "  $($file.FullName) ($sizeMB MB)" -ForegroundColor White
}

Write-Host "`n���!" -ForegroundColor Cyan

# �������뻺��
$targetDir = Join-Path $PSScriptRoot "src-tauri\target"
if (Test-Path $targetDir) {
    Write-Host "`n�������뻺��..." -ForegroundColor Yellow
    Remove-Item -Path $targetDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "���뻺��������: $targetDir" -ForegroundColor Green
}
