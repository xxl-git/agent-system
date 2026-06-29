@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: --- Agent System v0.6.0 -- Unified Launcher ---
:: Usage: agent.bat [start|stop|restart|status|test|help]

set "AGENT_DIR=%~dp0"
cd /d "%AGENT_DIR%"
set "SERVER_PORT=19701"
set "LMS_PORT=1234"
set "SERVER_JS=dist\server\agent-server.js"

echo.
echo ====================================
echo   Agent System v0.6.0 - Launcher
echo ====================================
echo.

:: --- Path check ---
if not exist "%SERVER_JS%" (
    echo [ERR] Server module not found: %SERVER_JS%
    echo       Run "npm run build" first.
    goto :end
)

:: --- Check LM Studio ---
set "LMS_OK=0"
curl -s --max-time 2 http://127.0.0.1:%LMS_PORT%/v1/models >nul 2>&1
if !errorlevel! equ 0 ( set "LMS_OK=1" ) else ( set "LMS_OK=0" )

:: --- Port check ---
netstat -ano | findstr ":%SERVER_PORT% " >nul 2>&1
if !errorlevel! equ 0 ( set "PORT_BUSY=1" ) else ( set "PORT_BUSY=0" )

:: --- Dispatch mode ---
if /i "%~1"=="start"   goto :start_srv
if /i "%~1"=="stop"    goto :stop_srv
if /i "%~1"=="restart" goto :restart_srv
if /i "%~1"=="status"  goto :status
if /i "%~1"=="test"    goto :run_test
if /i "%~1"=="help"    goto :help
goto :interactive

:start_srv
if "!PORT_BUSY!"=="1" (
    echo [WARN] Port %SERVER_PORT% is in use.
    echo        Current PID:
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%SERVER_PORT% "') do (
        if not "%%p"=="" (
            for /f "usebackq" %%q in (`tasklist /fi "PID eq %%p" /fo csv /nh 2^>nul`) do (
                echo    PID %%p - %%q
            )
        )
    )
    set /p "KILL_YN=Stop and restart? (Y/N): "
    if /i "!KILL_YN!"=="Y" (
        for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%SERVER_PORT% "') do (
            if not "%%p"=="" (
                taskkill /PID %%p /F >nul 2>&1
                echo [OK] Killed PID %%p
            )
        )
        timeout /t 1 /nobreak >nul
        goto :start_srv
    )
    goto :end
)
echo [RUN] Starting Agent Server (port %SERVER_PORT%)...
echo       Web:   http://127.0.0.1:%SERVER_PORT%/
echo       Admin: http://127.0.0.1:%SERVER_PORT%/admin
echo       Audit: http://127.0.0.1:%SERVER_PORT%/audit-dashboard.html
echo.
start "Agent System v0.6.0" node "%AGENT_DIR%\%SERVER_JS%"
if !errorlevel! equ 0 ( echo [OK] Server started ) else ( echo [ERR] Start failed )
timeout /t 1 /nobreak >nul
goto :end

:stop_srv
echo [STOP] Stopping Agent Server...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%SERVER_PORT% "') do (
    if not "%%p"=="" (
        taskkill /PID %%p /F >nul 2>&1
        echo [OK] Stopped PID %%p
    )
)
timeout /t 1 /nobreak >nul
goto :end

:restart_srv
call :stop_srv
timeout /t 2 /nobreak >nul
goto :start_srv

:status
echo [STATUS] System Status Check
echo.
echo --- Server ---
if "!PORT_BUSY!"=="1" (
    echo [OK]  Server running on port %SERVER_PORT%
) else (
    echo [OFF] Server is not running
)
echo.
echo --- LM Studio ---
if "!LMS_OK!"=="1" (
    echo [OK]  LM Studio online (port %LMS_PORT%)
    for /f "delims=" %%i in ('curl -s http://127.0.0.1:%LMS_PORT%/v1/models 2^>nul') do echo       Models: %%i
) else (
    echo [OFF] LM Studio offline
)
echo.
echo --- Files ---
if exist "data\agent.db" ( echo [OK]  Database: data\agent.db ) else ( echo [MISS] Database not found )
echo.
if "!PORT_BUSY!"=="1" (
    for /f "delims=" %%i in ('curl -s --max-time 3 http://127.0.0.1:%SERVER_PORT%/api/dashboard 2^>nul') do set "DASH=%%i"
    if defined DASH ( echo [OK]  API responding ) else ( echo [ERR] API not responding )
)
goto :end

:run_test
echo [TEST] Running tests...
for /f "tokens=*" %%f in ('dir /b dist\test_*.js 2^>nul') do (
    echo   node %%f
    node "dist\%%f" 2>&1
    echo.
)
goto :end

:interactive
echo.
echo  Select mode:
echo    [1] Start server (recommended)
echo    [2] Stop server
echo    [3] Restart server
echo    [4] Status check
echo    [5] Run tests
echo    [q] Quit
echo.
set /p "CHOICE=Enter (1-5/q): "
echo.
if "!CHOICE!"=="1" goto :start_srv
if "!CHOICE!"=="2" goto :stop_srv
if "!CHOICE!"=="3" goto :restart_srv
if "!CHOICE!"=="4" goto :status
if "!CHOICE!"=="5" goto :run_test
goto :end

:help
echo  agent.bat - Agent System Launcher
echo.
echo  Usage:
echo    agent.bat           Interactive menu
echo    agent.bat start     Start server
echo    agent.bat stop      Stop server
echo    agent.bat restart   Restart server
echo    agent.bat status    System status
echo    agent.bat test      Run tests
echo.
goto :end

:end
endlocal