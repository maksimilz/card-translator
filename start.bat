@echo off
cd /d "%~dp0"
python run.py
if errorlevel 1 (
    echo [!] Python returned an error, opening index.html directly...
    start "" "index.html"
    pause
)
