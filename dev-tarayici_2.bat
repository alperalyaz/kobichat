@echo off
REM Oncelikle dev-tarayici.bat ile Vite'i calistirin (http://localhost:5173).
REM Bu dosya Electron mesaj popup'ina benzer onizlemeyi tarayicida acar.
cd /d "%~dp0"
start "" "http://localhost:5173/?mode=dev-popup"
