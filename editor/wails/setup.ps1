# Constellation Editor - Wails Setup Script
# Run this once to install the Wails shell and UI dependencies.

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
    Write-Host "Please install Go 1.22 or higher from https://go.dev/dl/" -ForegroundColor Yellow
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
    $null = wails3 version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Installed" -ForegroundColor Green
    } else {
        throw
    }
} catch {
    Write-Host "✗ Not found" -ForegroundColor Red
    Write-Host "Installing Wails CLI..." -ForegroundColor Yellow
    go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install Wails CLI" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ Wails CLI installed" -ForegroundColor Green
}

Write-Host "`nChecking Task..." -NoNewline
try {
    $null = task --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Installed" -ForegroundColor Green
    } else {
        throw
    }
} catch {
    Write-Host "✗ Not found" -ForegroundColor Red
    Write-Host "Installing Task..." -ForegroundColor Yellow
    go install github.com/go-task/task/v3/cmd/task@latest
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install Task" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ Task installed" -ForegroundColor Green
}

Write-Host "`n[Setup Steps]" -ForegroundColor Yellow

# Step 1: Go dependencies
Write-Host "`n1. Downloading Go dependencies..."
go mod download
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Go mod download failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Go dependencies installed" -ForegroundColor Green

# Step 2: Frontend dependencies
Write-Host "`n2. Installing frontend dependencies..."
npm --prefix ../ui ci
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ npm ci failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Frontend dependencies installed" -ForegroundColor Green

# Step 3: Verify
Write-Host "`n3. Verifying setup..."
$goModExists = Test-Path "go.mod"
$nodeModulesExists = Test-Path "..\ui\node_modules"
$frontendPlaceholderExists = Test-Path "frontend\dist\.keep"

if ($goModExists -and $nodeModulesExists -and $frontendPlaceholderExists) {
    Write-Host "✓ All files in place" -ForegroundColor Green
} else {
    Write-Host "⚠ Some files may be missing:" -ForegroundColor Yellow
    if (-not $goModExists) { Write-Host "  - go.mod" }
    if (-not $nodeModulesExists) { Write-Host "  - node_modules" }
    if (-not $frontendPlaceholderExists) { Write-Host "  - frontend/dist/.keep" }
}

Write-Host @"

╔══════════════════════════════════════════════════════════╗
║   Setup Complete! ✓                                      ║
╚══════════════════════════════════════════════════════════╝

Next Steps:
  • Run 'task dev' to start development mode
  • Build the native renderer from '..\renderer' if you are working on native output
  • Or run 'task package' to create a production Wails shell build

Documentation:
  • README.md        - Architecture and workflow
  • QUICKSTART.md    - Quick reference guide

Happy coding! 🚀

"@ -ForegroundColor Cyan
