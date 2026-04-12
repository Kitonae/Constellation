# Build script for the Constellation Editor Wails shell.
# The native DX12 renderer is built separately from editor/renderer.

$ErrorActionPreference = "Stop"

Write-Host "==> Constellation Editor - Wails Build Script" -ForegroundColor Cyan

# Step 1: Download Go dependencies
Write-Host "`n[1/4] Downloading Go dependencies..." -ForegroundColor Yellow
go mod download
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Go mod download failed" -ForegroundColor Red
    exit 1
}

# Step 2: Install frontend dependencies
Write-Host "`n[2/4] Installing frontend dependencies..." -ForegroundColor Yellow
Push-Location ../ui
try {
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ npm ci failed" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

# Step 3: Build frontend
Write-Host "`n[3/4] Building frontend..." -ForegroundColor Yellow
Push-Location ../ui
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ Frontend build failed" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

# Step 4: Copy frontend assets and build with Wails
Write-Host "`n[4/4] Copying frontend and building Wails application..." -ForegroundColor Yellow
& .\copy-frontend.ps1
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Frontend copy failed" -ForegroundColor Red
    exit 1
}

wails build
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Wails build failed" -ForegroundColor Red
    exit 1
}

Write-Host "`n==> Build complete! ✓" -ForegroundColor Green
Write-Host "Binary location: build\bin\constellation-editor.exe" -ForegroundColor Cyan
Write-Host "Renderer binary location (built separately): ..\renderer\build\Release\constellation-renderer.exe" -ForegroundColor Cyan
