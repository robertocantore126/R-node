@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  R-node dev launcher
rem  Double-click this file to start `cargo tauri dev` in its
rem  own window. Live output is shown in the window AND written
rem  to tauri-dev.log in this folder (UTF-8, replaced each run).
rem ============================================================

rem Make sure cargo is reachable (fall back to the default cargo bin dir)
where cargo >nul 2>nul
if errorlevel 1 set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem If an instance is already running, ask before starting a duplicate
tasklist /FI "IMAGENAME eq r-node.exe" 2>nul | find /I "r-node.exe" >nul
if not errorlevel 1 (
  echo [WARN] r-node.exe is already running.
  choice /C YN /M "Start another dev instance anyway"
  if errorlevel 2 exit /b
)

echo Starting R-node dev...
echo Log file: %~dp0tauri-dev.log
echo Close this window (or press Ctrl+C) to stop the app.
echo.

start "R-node dev" powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -Path tauri-dev.log -Force -ErrorAction SilentlyContinue; cargo tauri dev 2>&1 | ForEach-Object { Write-Host $_; Add-Content -Path tauri-dev.log -Value $_ -Encoding utf8 }; if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host ('R-node exited with code ' + $LASTEXITCODE); Read-Host 'Press Enter to close this window' }"

endlocal
