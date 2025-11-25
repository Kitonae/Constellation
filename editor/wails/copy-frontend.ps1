# Copy built frontend assets from ui/dist to wails/frontend/dist
# Run this after building the frontend

$ErrorActionPreference = "Stop"

$source = "..\ui\dist"
$dest = "frontend\dist"

if (-not (Test-Path $source)) {
    Write-Host "Error: Frontend not built. Run 'npm --prefix ../ui run build' first." -ForegroundColor Red
    exit 1
}

Write-Host "Copying frontend assets..." -ForegroundColor Yellow

# Remove old dist if exists
if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
}

# Copy the built frontend
Copy-Item -Recurse -Force $source $dest

Write-Host "✓ Frontend assets copied to $dest" -ForegroundColor Green
