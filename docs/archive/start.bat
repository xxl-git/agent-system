@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title Agent System v0.9.2 - Desktop Launcher

set "AGENT_DIR=D:\QClaw_Workspace\agent-system"
set "NODE_EXE=D:\software\Common\nodejs\node.exe"
set "PORT=19701"
set "SERVER_JS=%AGENT_DIR%\dist\server\agent-server.js"

echo.
echo ====================================
echo   Agent System v0.9.2 - Desktop
echo ====================================
echo.

cd /d "%AGENT_DIR%"

:: --- Check node executable ---
if not exist "%NODE_EXE%" (
    echo [ERR] Node.js not found at:
    echo       %NODE_EXE%
    exit /b 1
)
echo [OK] Node.js found

:: --- Check dependencies ---
if not exist "node_modules" (
    echo [..] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERR] npm install failed
        exit /b 1
    )
)
echo [OK] Dependencies ready

:: --- Auto compile if needed ---
if not exist "%SERVER_JS%" (
    echo [..] Compiling TypeScript...
    call npm run build
    if errorlevel 1 (
        echo [ERR] Compilation failed
        exit /b 1
    )
)
echo [OK] Server module ready

:: --- Port check ---
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel! equ 0 (
    echo.
    echo [OK] Server already running
    echo      http://127.0.0.1:%PORT%/agent-ui.html
    start "" "http://127.0.0.1:%PORT%/agent-ui.html"
    goto :end
)

:: --- Start server ---
echo [..] Starting server (port %PORT%)...
start "Agent System Server" "%NODE_EXE%" "%SERVER_JS%"

:: Wait for it to come up
echo [..] Waiting for server...
set "WAIT_MAX=10"
set "WAITED=0"
:wait_loop
timeout /t 1 /nobreak >nul
set /a WAITED+=1
netstat -ano | findstr ":%PORT% " >nul 2>&1
if !errorlevel! equ 0 goto :ready
if !WAITED! lss !WAIT_MAX! goto :wait_loop

echo [ERR] Server didn't start within %WAIT_MAX% seconds
echo       Check %AGENT_DIR%\logs if any
exit /b 1

:ready
echo [OK] Server started on port %PORT%
echo.
echo  Chat UI:     http://127.0.0.1:%PORT%/agent-ui.html
echo  Admin Panel: http://127.0.0.1:%PORT%/admin-panel.html
echo  Audit:       http://127.0.0.1:%PORT%/audit-dashboard.html
echo.

start "" "http://127.0.0.1:%PORT%/agent-ui.html"

:end
echo.
echo --- Agent System is running ---
exit
