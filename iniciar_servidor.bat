@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"
set "MAIN=%PROJECT_DIR%main.py"
set "PORT_SELECTOR=%PROJECT_DIR%scripts\select_server_port.py"
set "MIGRATOR=%PROJECT_DIR%scripts\migrate_local_data.py"
set "CLEANER=%PROJECT_DIR%scripts\cleanup_local_temps.py"
set "TEMPLATE=%PROJECT_DIR%data\planilhas_entrada\(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
set "SIMPRESS_PORT=8000"

title Simpress - Servidor FastAPI
chcp 65001 > nul

echo ========================================================
echo   Iniciando Servidor Simpress (FastAPI / Uvicorn)...
echo   Projeto:      %PROJECT_DIR%
echo ========================================================

if not exist "%PYTHON%" goto missing_python
if not exist "%MAIN%" goto missing_main
if not exist "%PORT_SELECTOR%" goto missing_port_selector
if not exist "%MIGRATOR%" goto missing_migrator
if not exist "%CLEANER%" goto missing_cleaner

cd /d "%PROJECT_DIR%"
call :select_server_port
if errorlevel 10 goto already_running
if errorlevel 1 goto port_selection_failed

"%PYTHON%" "%MIGRATOR%"
if errorlevel 1 goto migration_failed
"%PYTHON%" "%CLEANER%" --apply
if errorlevel 1 goto cleanup_failed
if not exist "%TEMPLATE%" goto missing_template

call :select_server_port
if errorlevel 10 goto already_running
if errorlevel 1 goto port_selection_failed

echo   Site:         http://127.0.0.1:%SIMPRESS_PORT%
echo   Documentacao: http://127.0.0.1:%SIMPRESS_PORT%/docs
echo.

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

:missing_port_selector
echo ERRO: ferramenta para verificar a porta local nao encontrada:
echo %PORT_SELECTOR%
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

:already_running
echo.
echo [INFO] O Simpress ja esta em execucao na porta %SIMPRESS_PORT%.
echo Abrindo a instancia existente sem iniciar uma segunda copia.
start "" "http://127.0.0.1:%SIMPRESS_PORT%"
exit /b 0

:port_selection_failed
echo.
echo ERRO: nao foi possivel encontrar uma porta local livre entre 8000 e 8099.
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

:select_server_port
set "SERVER_ACTION="
set "PORT_RESULT_FILE=%TEMP%\simpress_port_%RANDOM%_%RANDOM%.txt"
"%PYTHON%" "%PORT_SELECTOR%" > "%PORT_RESULT_FILE%"
if errorlevel 1 (
    del /q "%PORT_RESULT_FILE%" > nul 2>&1
    exit /b 1
)
for /f "usebackq tokens=1,2 delims=:" %%A in ("%PORT_RESULT_FILE%") do (
    set "SERVER_ACTION=%%A"
    set "SIMPRESS_PORT=%%B"
)
del /q "%PORT_RESULT_FILE%" > nul 2>&1
if /i "%SERVER_ACTION%"=="RUNNING" exit /b 10
if /i "%SERVER_ACTION%"=="PORT" exit /b 0
exit /b 1
