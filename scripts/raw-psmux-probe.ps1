param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,

  [string]$ArgsJson,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"

if ($ArgsJson) {
  $Args = @((ConvertFrom-Json -InputObject $ArgsJson))
}

& $Executable @Args
$probeExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
Write-Output ("EXIT:" + $probeExit)
Start-Sleep -Seconds 20
exit $probeExit
