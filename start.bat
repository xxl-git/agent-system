@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ═══════════════════════════════════════════════════
::   Agent System v0.9.2 — 一键启动 / 重启脚本
::   双击即可运行：已运行则重启，未运行则启动
:: ═══════════════════════════════════════════════════

cd /d "%~dp0"
set "PORT=19701"
set "LMS_PORT=1234"
set "SERVER_JS=dist\server\agent-server.js"

echo.
echo ========================================
echo   Agent System v0.9.2
echo   One-Click Start / Restart
echo ========================================
echo.

:: ─── Step 1: 检测并停止已运行的服务器 ───
set "WAS_RUNNING=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING" 2^>nul') do (
    if not "%%p"=="0" (
        if !WAS_RUNNING!==0 (
            echo [INFO] Server is running (PID: %%p), restarting...
            set "WAS_RUNNING=1"
        )
        taskkill /PID %%p /F >nul 2>&1
    )
)
if !WAS_RUNNING!==1 (
    echo [OK] Old process stopped
    timeout /t 2 /nobreak >nul
) else (
    echo [INFO] Server not running, starting fresh...
)
echo.

:: ─── Step 2: 编译 TypeScript (避免 dist 过期) ───
echo [BUILD] Compiling TypeScript...
call npx tsc >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Build failed! Output:
    echo ----------------------------------------
    call npx tsc
    echo ----------------------------------------
    echo.
    echo Press any key to exit...
    pause >nul
    exit /b 1
)
echo [OK] Build complete
echo.

:: ─── Step 3: 检查 dist 产物 ───
if not exist "%SERVER_JS%" (
    echo [ERROR] Server module not found: %SERVER_JS%
    echo         Build may have failed silently.
    pause
    exit /b 1
)

:: ─── Step 4: 检查 LM Studio ───
set "LMS_OK=0"
curl -s --max-time 2 http://127.0.0.1:%LMS_PORT%/v1/models >nul 2>&1
if !errorlevel! equ 0 (
    set "LMS_OK=1"
    echo [OK] LM Studio online (port %LMS_PORT%)
) else (
    echo [WARN] LM Studio not running!
    echo        Web UI will load, but chat won't work.
    echo        Please start LM Studio and load a model.
)
echo.

:: ─── Step 5: 启动服务器 (新窗口显示日志) ───
echo [START] Launching Agent Server on port %PORT%...
start "Agent System Server" /D "%~dp0" cmd /k "title Agent System Server && node %SERVER_JS%"

:: 等待服务器就绪
set "RETRIES=0"
:wait_ready
timeout /t 1 /nobreak >nul
set /a RETRIES+=1
curl -s --max-time 1 http://127.0.0.1:%PORT%/api/models >nul 2>&1
if !errorlevel! equ 0 (
    echo [OK] Server is ready
    goto :server_ready
)
if !RETRIES! lss 10 (
    goto :wait_ready
)
echo [WARN] Server may still be starting up...
:server_ready
echo.

:: ─── Step 6: 打开浏览器 ───
start http://127.0.0.1:%PORT%/

:: ─── 完成 ───
echo ========================================
if !WAS_RUNNING!==1 (
    echo   Server restarted successfully!
) else (
    echo   Server started successfully!
)
echo.
echo   Web UI:  http://127.0.0.1:%PORT%/
echo   Stop:    Close the server window
echo   Restart: Run this script again
echo ========================================
echo.
echo This window will close in 3 seconds...
timeout /t 3 /nobreak >nul
endlocal
exit
