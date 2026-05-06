@echo off
setlocal
cd /d "%~dp0\.."
echo KobiChat: NSIS kurulum paketi uretiliyor...
call npm run setup
if errorlevel 1 exit /b 1
echo Bitti.
exit /b 0
