@echo off
cd /d "%~dp0"
echo Liste penceresi icin Vite: http://localhost:5173
echo Ayrica sohbet onizlemesi: dev-tarayici_1.bat  bildirim onizlemesi: dev-tarayici_2.bat
echo (Once bu pencere acikken Vite calisiyor olmali.)
call npm.cmd run dev:browser
pause
