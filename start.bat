@echo off
chcp 65001 >nul
title AI Character Card Translator & Editor

echo ================================================================
echo    AI Character Card Translator ^& Editor (100%% Client-Side)
echo ================================================================
echo.
echo Запуск локального веб-сервера...

where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Найден Python 3! Запускаем локальный сервер на порту 8000...
    start "" http://localhost:8000
    python -m http.server 8000
) else (
    echo Python не найден в PATH. Открываем index.html напрямую в браузере...
    start "" "index.html"
)

pause
