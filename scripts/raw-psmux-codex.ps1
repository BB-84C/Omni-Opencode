$ErrorActionPreference = "Stop"

& "C:\Program Files\nodejs\node.exe" "C:\Users\Administrator\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js" exec --json "Reply with the word hello only."
$probeExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
Write-Output ("EXIT:" + $probeExit)
Start-Sleep -Seconds 20
exit $probeExit
