@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    python run.py %*
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 run.py %*
    goto :end
)

echo [!] Python не найден.
echo     Установите Python 3 с https://www.python.org/downloads/ (галочка "Add python.exe to PATH")
echo     и запустите start.bat снова. Открыть index.html напрямую нельзя: браузер блокирует модули страницы.

:end
if errorlevel 1 pause
