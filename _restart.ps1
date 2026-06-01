$ErrorActionPreference = 'SilentlyContinue'
Get-Process python | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -WindowStyle Hidden -FilePath python -ArgumentList 'server.py' -RedirectStandardOutput _s.log -RedirectStandardError _s.err -WorkingDirectory (Get-Location)
Start-Sleep -Seconds 3
$l = Get-NetTCPConnection -LocalPort 7870 -State Listen
if ($l) { Write-Host "LISTEN pid=$($l.OwningProcess)" } else { Write-Host "not listening!" }
