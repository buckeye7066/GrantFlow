@echo off
echo === Committing and Pushing Changes ===
echo.

echo Adding all files...
git add -A

echo.
echo Current status:
git status --short

echo.
echo Creating commit...
git commit -m "Fix: Major improvements - Auth fixes, Anya AI enhancements, missing packages"

echo.
echo Pushing to GitHub...
git push origin main

echo.
echo === Done! ===
pause