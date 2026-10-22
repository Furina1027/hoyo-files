@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   hoyo-files stopper
echo   data server : 8787      web frontend : 8600
echo ============================================
echo.

rem Identify targets two ways:
rem   1) whoever is LISTENING on 8787 / 8600
rem   2) node processes whose command line looks like ours
rem      (vite --port 8600 / server/server.mjs --port 8787 / pnpm dev --port 8600)
rem The web side is a nested chain cmd -^> pnpm.mjs -^> pnpm.cjs -^> vite.js,
rem so killing only the listener leaves the pnpm wrappers behind.
rem We therefore also walk up to 4 ancestor levels and kill the node/cmd wrappers.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $ports=@(8787,8600); $ids=@(); foreach($p in $ports){ foreach($c in Get-NetTCPConnection -LocalPort $p -State Listen){ $ids+=[int]$c.OwningProcess } }; $all=Get-CimInstance Win32_Process; foreach($pr in $all){ if($pr.Name -ne 'node.exe'){continue}; $cl=$pr.CommandLine; if(-not $cl){continue}; if(($cl -like '*server.mjs*8787*') -or ($cl -like '*vite*8600*') -or ($cl -like '*pnpm*dev*8600*')){ $ids+=[int]$pr.ProcessId } }; $byId=@{}; foreach($x in $all){ $byId[[int]$x.ProcessId]=$x }; $cur=@($ids); for($k=0;$k -lt 4;$k++){ $next=@(); foreach($i in $cur){ $x=$byId[[int]$i]; if(-not $x){continue}; $px=$byId[[int]$x.ParentProcessId]; if(-not $px){continue}; $pcl=$px.CommandLine; if(-not $pcl){continue}; if(($px.Name -eq 'node.exe') -or (($px.Name -eq 'cmd.exe') -and (($pcl -like '*pnpm*') -or ($pcl -like '*vite*') -or ($pcl -like '*server.mjs*')))){ $ids+=[int]$px.ProcessId; $next+=[int]$px.ProcessId } }; $cur=$next }; $ids=@($ids | Select-Object -Unique); if($ids.Count -eq 0){ Write-Host '  (no running service process found)' } else { foreach($i in $ids){ Write-Host ('  kill PID ' + $i); Stop-Process -Id $i -Force } }; Start-Sleep -Milliseconds 1500; $left=@(); foreach($p in $ports){ foreach($c in Get-NetTCPConnection -LocalPort $p -State Listen){ $left+=($p.ToString() + '(PID ' + $c.OwningProcess + ')') } }; if($left.Count -eq 0){ Write-Host '  OK: ports 8787 / 8600 released'; exit 0 } else { Write-Host ('  WARN: still in use - ' + ($left -join ', ')); exit 1 }"

if errorlevel 1 (
  echo.
  echo [WARN] some port is still held. Run stop.cmd again, or kill the PID shown above manually.
  exit /b 1
)

echo.
echo Stopped. Start again with start.cmd
exit /b 0
