param(
  [Parameter(Mandatory = $true)][string]$Certificate,
  [Parameter(Mandatory = $true)][string]$Password,
  [Parameter(Mandatory = $true)][string]$File,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $signtool) { throw "signtool.exe not found" }
if (-not (Test-Path $Certificate)) { throw "certificate not found" }
if (-not (Test-Path $File)) { throw "file not found: $File" }

& $signtool sign /f $Certificate /p $Password /tr $TimestampUrl /td sha256 /fd sha256 $File
if ($LASTEXITCODE -ne 0) { throw "signing failed for $File" }

& $signtool verify /pa $File
if ($LASTEXITCODE -ne 0) { throw "signature verification failed for $File" }

Write-Output "signed: $File"
