@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   hoyo-files launcher (background mode)
echo   data server  : http://localhost:8787
echo   web frontend : http://localhost:8600
echo   logs         : server.log / web.log
echo   stop         : double-click stop.cmd
echo ============================================
echo.

rem NOTE: keep this file pure ASCII. cmd.exe reads .cmd in the OEM code page,
rem so non-ASCII comments can swallow line breaks and corrupt the whole script.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js 18+ first.
  pause
  exit /b 1
)

rem The frontend no longer goes through pnpm: we call the local vite binary
rem directly, which is exactly what package.json's "dev" script does. This
rem bypasses pnpm's packageManager version switch, which previously failed as a
rem whole ("Failed to switch pnpm to v10.13.1") when its store link directory
rem had been left half-created (node_modules present, bin/pnpm missing).
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
rem RedirectStandardOutput/Error matters: without it the child process inherits
rem this script's stdout, so "background mode" never actually returns and the
rem console window cannot be closed.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8600' -WorkingDirectory '%~dp0' -RedirectStandardOutput '%~dp0web.log' -RedirectStandardError '%~dp0web.err.log' -WindowStyle Hidden"

rem --- verify: poll until both ports listen (up to ~60s) ---
rem A fixed 5s wait was too short (vite cold start measured 8.9s here) and used
rem to report a false "FAILED" while the server was still booting.
set V8787=1
set V8600=1
for /l %%i in (1,1,30) do (
  if "!V8787!"=="0" if "!V8600!"=="0" goto booted
  netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul && set V8787=0
  netstat -ano | findstr /r /c:":8600 .*LISTENING" >nul && set V8600=0
  ping -n 3 127.0.0.1 >nul
)
:booted
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
