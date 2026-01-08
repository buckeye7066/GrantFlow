@echo off
echo Running reattach users script...
node scripts/reattach-users-simple.mjs
echo.
echo Exit code: %ERRORLEVEL%
echo.
if exist reattach-summary.json (
    echo === SUMMARY FILE ===
    type reattach-summary.json
    echo.
)
echo Running verification...
node scripts/verify-reattach.mjs
echo.
if exist verify-reattach-results.json (
    echo === VERIFICATION RESULTS ===
    type verify-reattach-results.json
)
pause
