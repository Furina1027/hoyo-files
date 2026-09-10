@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   hoyo-files launcher (background mode)
echo   data server  : http://localhost:8787
echo   web frontend : http://localhost:8600
echo   logs         : server.log / web.log
echo   stop         : double-click stop.cmd
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js 18+ first.
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found. Run: npm install -g pnpm
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo [ERROR] node_modules missing. Run "pnpm install" once in this folder.
  pause
  exit /b 1
)

rem --- already running? ---
netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul
set P8787=%errorlevel%
netstat -ano | findstr /r /c:":8600 .*LISTENING" >nul
set P8600=%errorlevel%
if "%P8787%"=="0" if "%P8600%"=="0" (
  echo Already running: http://127.0.0.1:8600
  exit /b 0
)

echo [1/2] starting data server on 8787 ...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'server/server.mjs --port 8787' -WorkingDirectory '%~dp0' -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server.err.log' -WindowStyle Hidden"

echo [2/2] starting web frontend on 8600 ...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c pnpm dev --host 127.0.0.1 --port 8600 > web.log 2>&1' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

rem --- verify (wait ~5s for boot) ---
ping -n 6 127.0.0.1 >nul
netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul
set V8787=%errorlevel%
netstat -ano | findstr /r /c:":8600 .*LISTENING" >nul
set V8600=%errorlevel%
echo.
if "%V8787%"=="0" ( echo data server  : OK ) else ( echo data server  : FAILED )
if "%V8600%"=="0" ( echo web frontend : OK ) else ( echo web frontend : FAILED )
if "%V8787%"=="0" if "%V8600%"=="0" (
  echo.
  echo Started in background. Open http://127.0.0.1:8600
  echo To stop the services later, run stop.cmd
  exit /b 0
)
echo.
echo [ERROR] startup failed. Check server.err.log / web.log in this folder.
pause
exit /b 1
