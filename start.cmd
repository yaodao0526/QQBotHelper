@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title QQ Persona Bot
cd /d "%~dp0"

rem Keep this file ASCII-only: cmd.exe re-reads a batch file by byte offset, and
rem multi-byte characters shift those offsets and corrupt the following lines.
rem All user-facing Chinese text comes from the Node / Electron side.

if not defined BOT_PORT set "BOT_PORT=7800"
set "HEALTH=http://127.0.0.1:%BOT_PORT%/health"
set "CURL=%SystemRoot%\System32\curl.exe"
set "READY=%TEMP%\qq-persona-bot-ready.txt"
set "RUNTIME=%LOCALAPPDATA%\qq-persona-bot\runtime"
set "PROJECT=%~dp0"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "node_modules\ws\package.json" (
  echo First run: installing dependencies, this can take a few minutes...
  call npm install --no-audit --no-fund
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing desktop shell ^(Electron^), one time only...
  call npm install --no-audit --no-fund
)

set "EXE=%PROJECT%\node_modules\electron\dist\electron.exe"

rem Chromium cannot start from files marked Low integrity (sync drives, folders
rem hardened by security tools, sandboxed workspaces). Use a copy in
rem %LOCALAPPDATA% for those.
icacls "%PROJECT%" 2>nul | findstr /I /C:"Low Mandatory Level" >nul
if not errorlevel 1 call :ensure_runtime
if exist "%RUNTIME%\electron.exe" if defined RUNTIME_LOWIL set "EXE=%RUNTIME%\electron.exe"

if not exist "%EXE%" goto :browser

set "ELECTRON_RUN_AS_NODE="
set "BOT_READY_FILE=%READY%"
del /q "%READY%" 2>nul
echo Starting desktop window...
start "" "%EXE%" "%PROJECT%"
call :wait_window
if not errorlevel 1 goto :done

if exist "%RUNTIME%\electron.exe" (
  echo Retrying with the local runtime copy...
  set "EXE=%RUNTIME%\electron.exe"
  del /q "%READY%" 2>nul
  start "" "%EXE%" "%PROJECT%"
  call :wait_window
  if not errorlevel 1 goto :done
)

echo Desktop window did not start, falling back to the browser panel...
goto :browser

:done
echo Panel is running: http://127.0.0.1:%BOT_PORT%
exit /b 0

:browser
"%CURL%" -s -m 2 -o nul "%HEALTH%"
if not errorlevel 1 (
  start "" "http://127.0.0.1:%BOT_PORT%"
  exit /b 0
)
set "BOT_OPEN=1"
node server/index.js
echo.
echo Bot stopped.
pause
exit /b 0

:no_node
echo [ERROR] Node.js not found.
echo Install Node.js 22 LTS or newer from https://nodejs.org/ then double-click this file again.
pause
exit /b 1

:ensure_runtime
set "RUNTIME_LOWIL=1"
if exist "%RUNTIME%\electron.exe" exit /b 0
echo Preparing the desktop runtime in %RUNTIME% ^(one time, about 260 MB^)...
xcopy "node_modules\electron\dist" "%RUNTIME%" /E /I /H /Y /Q >nul
exit /b 0

rem Success means the window really loaded the panel (the shell writes %READY%).
rem The HTTP server alone is not enough: it can outlive a crashed shell.
:wait_window
echo Waiting for the panel window...
set /a tries=0
:wait_loop
set /a tries+=1
if exist "%READY%" exit /b 0
if !tries! GEQ 40 exit /b 1
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | findstr /I "electron.exe" >nul
if errorlevel 1 if !tries! GEQ 3 exit /b 1
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
goto :wait_loop
