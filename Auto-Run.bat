@echo OFF

setlocal enabledelayedexpansion

ECHO !CD!
start http://localhost:8000
python.exe -m http.server

set /p input= Enter the name of this update: - 


