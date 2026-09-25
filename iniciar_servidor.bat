@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"
set "MAIN=%PROJECT_DIR%main.py"
set "TEMPLATE=%PROJECT_DIR%planilhas_entrada\(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"

title Simpress - Servidor FastAPI
chcp 65001 > nul

echo ========================================================
echo   Iniciando Servidor Simpress (FastAPI / Uvicorn)...
echo   Site:         http://127.0.0.1:8000
echo   Documentacao: http://127.0.0.1:8000/docs
echo   Projeto:      %PROJECT_DIR%
echo ========================================================

if not exist "%PYTHON%" (
    echo ERRO: Python do ambiente local nao encontrado:
    echo %PYTHON%
    pause
    exit /b 1
)

if not exist "%MAIN%" (
    echo ERRO: main.py nao encontrado:
    echo %MAIN%
    pause
    exit /b 1
)

if not exist "%TEMPLATE%" (
    echo ERRO: modelo de transferencia nao encontrado:
    echo %TEMPLATE%
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"
"%PYTHON%" "%MAIN%"
set "SERVER_EXIT=%ERRORLEVEL%"

if not "%SERVER_EXIT%"=="0" (
    echo.
    echo O servidor foi encerrado com erro %SERVER_EXIT%.
)

pause
exit /b %SERVER_EXIT%
