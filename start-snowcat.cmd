@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title QQ Persona Bot - SnowCat

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "SHELL=%ROOT%\protocol\snowcat\SnowCat.9.9.37.Shell"
set "QQEXE=%SHELL%\QQ.exe"
set "CURL=%SystemRoot%\System32\curl.exe"
set "HEALTH=http://127.0.0.1:7800/health"

if not exist "%QQEXE%" (
  echo.
  echo [x] SnowCat runtime not found:
  echo     %QQEXE%
  echo     Put the SnowCat shell under protocol\snowcat\ first.
  echo     See README.md: Deploy from GitHub.
  echo.
  pause
  exit /b 1
)

rem ---- make sure the panel is running ----
"%CURL%" -s -m 2 -o nul "%HEALTH%"
if errorlevel 1 (
  if exist "%ROOT%\node_modules\electron\dist\electron.exe" (
    echo Starting panel...
    set "ELECTRON_RUN_AS_NODE="
    start "" "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%"
    for /l %%i in (1,1,20) do (
      "%CURL%" -s -m 1 -o nul "%HEALTH%" && goto panel_ready
      "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
    )
    echo [w] Panel did not answer in time, starting QQ anyway.
  ) else (
    echo [w] node_modules\electron not found, skip panel startup.
  )
)

:panel_ready
echo.
echo Starting QQ ^(SnowCat^) ...
set "ELECTRON_RUN_AS_NODE="
start "" "%QQEXE%" --user-data-dir="%SHELL%\.qqdata"

echo.
echo   Panel   : http://127.0.0.1:7800
echo   WebUI   : http://127.0.0.1:6099/webui/
echo   Login   : use WebUI if QQ asks for a scan; after the first login it stays signed in.
echo.
echo Close this window anytime; QQ and the panel keep running.
pause
