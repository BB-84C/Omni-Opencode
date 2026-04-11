$ErrorActionPreference = "Stop"

& "C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\claude.exe" -p "Reply with the word hello only." --output-format stream-json --verbose --include-partial-messages
$probeExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
Write-Output ("EXIT:" + $probeExit)
Start-Sleep -Seconds 20
exit $probeExit
