# Constellation Editor - Wails Setup Script
# Run this once to set up the development environment

$ErrorActionPreference = "Stop"

Write-Host @"
╔══════════════════════════════════════════════════════════╗
║   Constellation Editor - Wails Setup                     ║
║   Setting up Go/Wails development environment            ║
╚══════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

# Check prerequisites
Write-Host "`n[Prerequisites Check]" -ForegroundColor Yellow

# Check Go
Write-Host -NoNewline "Checking Go... "
try {
    $goVersion = go version
    Write-Host "✓ $goVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Go not found" -ForegroundColor Red
    Write-Host "Please install Go 1.21 or higher from https://go.dev/dl/" -ForegroundColor Yellow
    exit 1
}

# Check Node.js
Write-Host -NoNewline "Checking Node.js... "
try {
    $nodeVersion = node --version
    Write-Host "✓ $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Node.js not found" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check npm
Write-Host -NoNewline "Checking npm... "
try {
    $npmVersion = npm --version
    Write-Host "✓ v$npmVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ npm not found" -ForegroundColor Red
    exit 1
}

# Check/Install Wails
Write-Host -NoNewline "Checking Wails CLI... "
try {
    $null = wails version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Installed" -ForegroundColor Green
    } else {
        throw
    }
} catch {
    Write-Host "✗ Not found" -ForegroundColor Red
    Write-Host "Installing Wails CLI..." -ForegroundColor Yellow
    go install github.com/wailsapp/wails/v2/cmd/wails@latest
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install Wails CLI" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ Wails CLI installed" -ForegroundColor Green
}

Write-Host "`n[Setup Steps]" -ForegroundColor Yellow

# Step 1: Generate protobuf
Write-Host "`n1. Generating protobuf Go bindings..."
& .\gen-proto.ps1
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Protobuf generation failed" -ForegroundColor Red
    exit 1
}

# Step 2: Go dependencies
Write-Host "`n2. Installing Go dependencies..."
go mod tidy
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Go mod tidy failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Go dependencies installed" -ForegroundColor Green

# Step 3: Frontend dependencies
Write-Host "`n3. Installing frontend dependencies..."
npm --prefix ../ui install
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ npm install failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Frontend dependencies installed" -ForegroundColor Green

# Step 4: Verify
Write-Host "`n4. Verifying setup..."
$protoExists = Test-Path "internal\proto\proto\constellation\v1\*.pb.go"
$goModExists = Test-Path "go.mod"
$nodeModulesExists = Test-Path "..\ui\node_modules"

if ($protoExists -and $goModExists -and $nodeModulesExists) {
    Write-Host "✓ All files in place" -ForegroundColor Green
} else {
    Write-Host "⚠ Some files may be missing:" -ForegroundColor Yellow
    if (-not $protoExists) { Write-Host "  - Protobuf bindings" }
    if (-not $goModExists) { Write-Host "  - go.mod" }
    if (-not $nodeModulesExists) { Write-Host "  - node_modules" }
}

Write-Host @"

╔══════════════════════════════════════════════════════════╗
║   Setup Complete! ✓                                      ║
╚══════════════════════════════════════════════════════════╝

Next Steps:
  • Run 'wails dev' to start development mode
  • Or run '.\build.ps1' to create a production build

Documentation:
  • README.md        - Complete documentation
  • QUICKSTART.md    - Quick reference guide
  • MIGRATION_GUIDE.md - Tauri to Wails migration

Happy coding! 🚀

"@ -ForegroundColor Cyan
