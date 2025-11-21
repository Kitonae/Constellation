# Build script for Constellation Editor (Wails)
# Generates protobuf code, installs dependencies, and builds the application

$ErrorActionPreference = "Stop"

Write-Host "==> Constellation Editor - Wails Build Script" -ForegroundColor Cyan

# Step 1: Generate protobuf Go code
Write-Host "`n[1/5] Generating protobuf Go code..." -ForegroundColor Yellow
& .\gen-proto.ps1
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Protobuf generation failed" -ForegroundColor Red
    exit 1
}

# Step 2: Download Go dependencies
Write-Host "`n[2/5] Installing Go dependencies..." -ForegroundColor Yellow
go mod tidy
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Go mod tidy failed" -ForegroundColor Red
    exit 1
}

# Step 3: Install frontend dependencies
Write-Host "`n[3/5] Installing frontend dependencies..." -ForegroundColor Yellow
npm --prefix ../ui install
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ npm install failed" -ForegroundColor Red
    exit 1
}

# Step 4: Build frontend
Write-Host "`n[4/5] Building frontend..." -ForegroundColor Yellow
npm --prefix ../ui run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Frontend build failed" -ForegroundColor Red
    exit 1
}

# Step 5: Copy frontend assets and build with Wails
Write-Host "`n[5/5] Copying frontend and building Wails application..." -ForegroundColor Yellow
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
