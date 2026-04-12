# Copy built frontend assets from ui/dist to wails/frontend/dist.
# The tracked .keep file is recreated so clean checkouts always retain an
# embeddable frontend/dist directory for Go builds.

$ErrorActionPreference = "Stop"

$source = "..\ui\dist"
$dest = "frontend\dist"
$keep = Join-Path $dest ".keep"

if (-not (Test-Path $source)) {
    Write-Host "Error: Frontend not built. Run 'npm --prefix ../ui run build' first." -ForegroundColor Red
    exit 1
}

Write-Host "Copying frontend assets..." -ForegroundColor Yellow

# Remove old dist if exists
if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Copy the built frontend contents
Copy-Item -Recurse -Force "$source\*" $dest

# Restore the tracked placeholder file
Set-Content -Path $keep -Value "Keep this directory tracked for clean Go/Wails builds."

Write-Host "✓ Frontend assets copied to $dest" -ForegroundColor Green
