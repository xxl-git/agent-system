@echo off
cd /d D:\QClaw_Workspace\agent-system
.\node_modules\.bin\tsc
if %ERRORLEVEL% NEQ 0 (
    echo Compilation failed with error level %ERRORLEVEL%
) else (
    echo Compilation succeeded!
)
pause
