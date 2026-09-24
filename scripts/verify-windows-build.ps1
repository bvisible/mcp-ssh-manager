param([string]$Directory = "desktop/electron/dist", [switch]$RequireSigned)
$ErrorActionPreference = "Stop"
$files = @(Get-ChildItem $Directory -Filter "*-setup.exe")
if ($files.Count -ne 1) { throw "Expected exactly one Windows installer" }
$files += @(Get-ChildItem $Directory -Recurse -Filter "SSH Manager.exe")
if ($files.Count -lt 3) { throw "Missing packaged x64/arm64 executables" }
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne "Valid") {
    if ($RequireSigned) { throw "Invalid Authenticode signature: $($file.Name) ($($signature.Status))" }
    Write-Warning "DRY RUN / PRERELEASE ONLY: $($file.Name) is not validly signed ($($signature.Status))"
  } else {
    Write-Host "Valid Authenticode signature: $($file.Name), publisher $($signature.SignerCertificate.Subject)"
  }
}
