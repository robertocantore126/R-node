@echo off
setlocal
cd /d "%~dp0"
title R-node dev launcher

rem ==========================================================================
rem  R-node dev launcher - runs the app FROM SOURCE, in place of the packaged
rem  exe. Double-click it.
rem
rem  Two paths, chosen for you:
rem    FAST  nothing under src-tauri\ is newer than the debug binary, so this
rem          starts Vite and launches that binary directly: a window in a few
rem          seconds, and every save reloads it.
rem    FULL  a Rust file (or Cargo.toml / tauri.conf.json) changed, so it hands
rem          over to `cargo tauri dev`, which recompiles first.
rem
rem  Logs: vite.log (fast) / tauri-dev.log (full). Both replaced each run, both
rem  git-ignored.
rem ==========================================================================

set "EXE=src-tauri\target\debug\r-node.exe"
set "URL=http://127.0.0.1:5173/"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"

rem --- 1 . One R-node at a time --------------------------------------------
rem The app registers a single instance (tauri-plugin-single-instance, keyed on
rem com.rnode.app), so a second one does not open a second window: it focuses
rem the first and exits. Starting the dev build behind the packaged exe would
rem look like "the launcher does nothing".
tasklist /FI "IMAGENAME eq r-node.exe" 2>nul | find /I "r-node.exe" >nul
if not errorlevel 1 (
  echo [STOP] R-node is already running.
  echo        It is a single-instance app: a second copy just focuses the
  echo        window you already have. Close R-node, then run this again.
  echo.
  pause
  exit /b 1
)

rem --- 2 . cargo on PATH ----------------------------------------------------
where cargo >nul 2>nul
if errorlevel 1 set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem --- 3 . Who owns port 5173 ----------------------------------------------
rem Vite is strictPort:5173, so a foreign server there is a hard stop, not a
rem fallback - and the webview would happily load whatever answers.
%PS% "$ErrorActionPreference='SilentlyContinue'; if (-not (Get-NetTCPConnection -LocalPort 5173 -State Listen)) { exit 2 }; try { $r = Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 4 } catch { exit 3 }; if ($r.Content -match 'R-node') { exit 0 } else { exit 3 }"
set "PORT=%ERRORLEVEL%"
if "%PORT%"=="3" (
  echo [STOP] Port 5173 is taken by something that is not R-node.
  echo        Close that dev server ^(the thoughtslibrary launcher uses the
  echo        same port^) and run this again.
  echo.
  pause
  exit /b 1
)

rem --- 4 . Is the compiled shell still current? -----------------------------
%PS% "$exe='%EXE%'; if (-not (Test-Path $exe)) { exit 1 }; $t = (Get-Item $exe).LastWriteTimeUtc; $src = @(); $src += Get-ChildItem -Path 'src-tauri\src','src-tauri\capabilities' -Recurse -File -ErrorAction SilentlyContinue; $src += Get-Item 'src-tauri\Cargo.toml','src-tauri\Cargo.lock','src-tauri\tauri.conf.json','src-tauri\build.rs' -ErrorAction SilentlyContinue; if ($src | Where-Object { $_.LastWriteTimeUtc -gt $t }) { exit 1 }; exit 0"
if errorlevel 1 goto :full

rem ==========================  FAST PATH  ===================================
echo R-node dev  [fast: the debug shell is up to date]
echo.
if "%PORT%"=="0" (
  echo Reusing the dev server already on %URL%
) else (
  echo Starting the dev server ^(npm run dev, log: vite.log^)...
  start "R-node vite" powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item vite.log -Force -ErrorAction SilentlyContinue; npm run dev 2>&1 | ForEach-Object { Write-Host $_; Add-Content -Path vite.log -Value $_ -Encoding utf8 }"
)

echo Waiting for %URL% ...
%PS% "$deadline=(Get-Date).AddSeconds(180); while ((Get-Date) -lt $deadline) { try { if ((Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { exit 0 } } catch { }; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo.
  echo [ERROR] The dev server did not answer in three minutes. Read vite.log.
  pause
  exit /b 1
)

echo Launching %EXE%
start "" "%EXE%"
echo.
echo R-node is starting. Edit anything under src\ and the window reloads.
echo Close the app window to quit; close the "R-node vite" window to stop the
echo dev server. First run only: File ^> Open your .rnode document - the dev
echo build has its own webview origin, so it does not inherit the packaged
echo app's "last opened" pointer.
timeout /t 6 >nul
exit /b 0

rem ==========================  FULL PATH  ===================================
:full
echo R-node dev  [full: src-tauri\ changed, or there is no debug binary yet]
echo.
where cargo >nul 2>nul
if errorlevel 1 (
  echo [STOP] cargo is not on PATH, and this path has to compile.
  echo        Install Rust from https://rustup.rs and run this again.
  echo.
  pause
  exit /b 1
)
cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo [STOP] The Tauri CLI is missing. Install it once with:
  echo            cargo install tauri-cli --version "^^2"
  echo.
  pause
  exit /b 1
)
if "%PORT%"=="0" (
  echo [STOP] A dev server is already on 5173, and `cargo tauri dev` starts its
  echo        own ^(beforeDevCommand^) - two of them fight over strictPort.
  echo        Close the "R-node vite" window, then run this again.
  echo.
  pause
  exit /b 1
)
echo Compiling and starting - first run after a Rust change takes a minute.
echo Log: tauri-dev.log
start "R-node dev" powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item tauri-dev.log -Force -ErrorAction SilentlyContinue; cargo tauri dev 2>&1 | ForEach-Object { Write-Host $_; Add-Content -Path tauri-dev.log -Value $_ -Encoding utf8 }; if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host ('R-node exited with code ' + $LASTEXITCODE); Read-Host 'Press Enter to close this window' }"
timeout /t 4 >nul
exit /b 0
