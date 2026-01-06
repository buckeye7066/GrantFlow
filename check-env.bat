@echo off
echo === Checking Environment Variables ===
echo.
echo ANTHROPIC_API_KEY:
if defined ANTHROPIC_API_KEY (
    echo Set: %ANTHROPIC_API_KEY:~0,15%...
) else (
    echo NOT SET - This is the problem!
)
echo.
echo OPENAI_API_KEY:
if defined OPENAI_API_KEY (
    echo Set: %OPENAI_API_KEY:~0,15%...
) else (
    echo NOT SET
)
echo.
echo === What to do ===
echo.
echo If ANTHROPIC_API_KEY is NOT SET:
echo 1. Go to Railway Dashboard
echo 2. Click Variables tab
echo 3. Add: ANTHROPIC_API_KEY=sk-ant-your-key
echo 4. Get key from: https://console.anthropic.com/
echo.
pause