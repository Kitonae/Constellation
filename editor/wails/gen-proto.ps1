<#
Generates protobuf Go code for Constellation Editor.
Downloads a local protoc if one isn't available.
#>

$ErrorActionPreference = "Stop"

Write-Host "Installing protoc plugins (go + grpc)..."
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Ensure GOPATH/bin on PATH for this session
if (-not $env:GOPATH) { $env:GOPATH = (go env GOPATH) }
$env:PATH = "$env:GOPATH\bin;$env:PATH"

function Ensure-Protoc {
  try {
    $null = protoc --version 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "✓ Using system protoc"; return }
  } catch {}
  Write-Host "Downloading protoc (win64)..."
  $version = "28.3"
  $zip = "protoc-$version-win64.zip"
  $url = "https://github.com/protocolbuffers/protobuf/releases/download/v$version/$zip"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath .protoc -Force
  Remove-Item $zip -Force
  $env:PATH = (Resolve-Path .protoc\bin).Path + ";" + $env:PATH
  Write-Host "✓ protoc downloaded"
}

Ensure-Protoc

$outDir = "internal/proto"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "Generating protobuf Go code..."
protoc `
  --proto_path=../../ `
  --go_out=$outDir `
  --go_opt=paths=source_relative `
  --go-grpc_out=$outDir `
  --go-grpc_opt=paths=source_relative `
  ../../proto/constellation/v1/scene.proto `
  ../../proto/constellation/v1/control.proto
if ($LASTEXITCODE -ne 0) { Write-Host "✗ Generation failed" -ForegroundColor Red; exit 1 }
Write-Host "✓ Protobuf generation complete" -ForegroundColor Green
