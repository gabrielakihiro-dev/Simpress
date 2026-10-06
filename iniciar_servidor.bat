@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"
set "MAIN=%PROJECT_DIR%main.py"
set "MIGRATOR=%PROJECT_DIR%scripts\migrate_local_data.py"
set "CLEANER=%PROJECT_DIR%scripts\cleanup_local_temps.py"
set "TEMPLATE=%PROJECT_DIR%data\planilhas_entrada\(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"

title Simpress - Servidor FastAPI
chcp 65001 > nul

echo ========================================================
echo   Iniciando Servidor Simpress (FastAPI / Uvicorn)...
echo   Site:         http://127.0.0.1:8000
echo   Documentacao: http://127.0.0.1:8000/docs
echo   Projeto:      %PROJECT_DIR%
echo ========================================================

if not exist "%PYTHON%" goto missing_python
if not exist "%MAIN%" goto missing_main
if not exist "%MIGRATOR%" goto missing_migrator
if not exist "%CLEANER%" goto missing_cleaner

cd /d "%PROJECT_DIR%"
"%PYTHON%" "%MIGRATOR%"
if errorlevel 1 goto migration_failed
"%PYTHON%" "%CLEANER%" --apply
if errorlevel 1 goto cleanup_failed
if not exist "%TEMPLATE%" goto missing_template

"%PYTHON%" "%MAIN%"
set "SERVER_EXIT=%ERRORLEVEL%"

if not "%SERVER_EXIT%"=="0" (
    echo.
    echo O servidor foi encerrado com erro %SERVER_EXIT%.
)

pause
exit /b %SERVER_EXIT%

:missing_python
echo ERRO: Python do ambiente local nao encontrado:
echo %PYTHON%
pause
exit /b 1

:missing_main
echo ERRO: main.py nao encontrado:
echo %MAIN%
pause
exit /b 1

:missing_template
echo ERRO: modelo de transferencia nao encontrado:
echo %TEMPLATE%
pause
exit /b 1

:missing_migrator
echo ERRO: ferramenta de organizacao dos dados nao encontrada:
echo %MIGRATOR%
pause
exit /b 1

:missing_cleaner
echo ERRO: ferramenta de limpeza segura nao encontrada:
echo %CLEANER%
pause
exit /b 1

:migration_failed
echo ERRO: dados locais nao foram alterados com seguranca.
echo Resolva o aviso acima e execute novamente.
pause
exit /b 1

:cleanup_failed
echo ERRO: a recuperacao ou limpeza dos temporarios nao foi concluida.
echo Arquivos divergentes permanecem preservados para revisao.
pause
exit /b 1
