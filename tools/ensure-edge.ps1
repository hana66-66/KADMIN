param([int]$Port = 9334, [string]$Profile = 'C:\Users\86475\baimiao-profile')
# Ensure a debuggable Edge is running and the baimiao page is open.
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
function Test-Port {
  try { $r = Invoke-RestMethod ("http://127.0.0.1:" + $Port + "/json/list") -TimeoutSec 4; return ($r.Count -ge 1) } catch { return $false }
}
if (Test-Port) { Write-Output "edge ok (port $Port)"; exit 0 }
Write-Output "edge down -> launching"
Start-Process -FilePath $edge -ArgumentList @("--remote-debugging-port=$Port", "--user-data-dir=$Profile", '--no-first-run', '--no-default-browser-check', 'https://web.baimiaoapp.com/')
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Port) { Write-Output ("edge up after " + ($i + 1) + "s"); exit 0 }
}
Write-Output "edge failed to start"
exit 1
