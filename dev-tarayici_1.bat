@echo off
REM Oncelikle dev-tarayici.bat ile Vite'i calistirin (http://localhost:5173).
REM Bu dosya ornek sohbet penceresini tarayicida acar.
cd /d "%~dp0"
start "" "http://localhost:5173/?mode=chat&peerId=dev-peer-1&peerUuid=00000000-0000-4000-8000-000000000001&peerName=Test%20Kullanici&peerStatus=available"
