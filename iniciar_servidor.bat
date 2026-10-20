@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "PROJECT_ROOT=%PROJECT_DIR%."
set "PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"
set "MAIN=%PROJECT_DIR%main.py"
set "BOOTSTRAPPER=%PROJECT_DIR%scripts\bootstrap_environment.py"
set "PORT_SELECTOR=%PROJECT_DIR%scripts\select_server_port.py"
set "MIGRATOR=%PROJECT_DIR%scripts\migrate_local_data.py"
set "CLEANER=%PROJECT_DIR%scripts\cleanup_local_temps.py"
set "UPDATER=%PROJECT_DIR%scripts\check_update.py"
set "SIMPRESS_PORT=8000"

title Simpress - Servidor FastAPI
chcp 65001 > nul

echo ========================================================
echo   Iniciando Servidor Simpress (FastAPI / Uvicorn)...
echo   Projeto:      %PROJECT_DIR%
echo ========================================================

if not exist "%MAIN%" goto missing_main
if not exist "%BOOTSTRAPPER%" goto missing_bootstrapper

if exist "%PYTHON%" goto bootstrap_using_project_python
where py >nul 2>nul
if not errorlevel 1 goto bootstrap_using_python_launcher
where python >nul 2>nul
if not errorlevel 1 goto bootstrap_using_python
goto missing_python

:bootstrap_using_project_python
set "BOOTSTRAP_LAUNCHER=%PYTHON%"
set "BOOTSTRAP_PREFIX="
goto bootstrap_environment

:bootstrap_using_python_launcher
set "BOOTSTRAP_LAUNCHER=py"
set "BOOTSTRAP_PREFIX=-3"
goto bootstrap_environment

:bootstrap_using_python
set "BOOTSTRAP_LAUNCHER=python"
set "BOOTSTRAP_PREFIX="

:bootstrap_environment
rem Atualizacao opcional: so para a tag vX.Y.Z mais nova do origin/main, por
rem fast-forward (git merge --ff-only); nunca reset/clean/stash/force.
rem Sem tag publicada, nenhuma atualizacao e oferecida.
rem O bloco abaixo e lido inteiro antes de executar; se o proprio .bat mudar,
rem ele se reinicia uma vez em vez de continuar lendo o arquivo alterado.
if exist "%UPDATER%" if not defined SIMPRESS_ATUALIZACAO_VERIFICADA (
    set "SIMPRESS_ATUALIZACAO_VERIFICADA=1"
    "%BOOTSTRAP_LAUNCHER%" %BOOTSTRAP_PREFIX% "%UPDATER%" --project-root "%PROJECT_ROOT%"
    if errorlevel 3 if not errorlevel 4 (
        echo.
        call "%~f0" %*
        exit /b
    )
    echo.
)
"%BOOTSTRAP_LAUNCHER%" %BOOTSTRAP_PREFIX% "%BOOTSTRAPPER%" --project-root "%PROJECT_ROOT%"
if errorlevel 1 goto bootstrap_failed
if not exist "%PYTHON%" goto bootstrap_failed
if not exist "%PORT_SELECTOR%" goto missing_port_selector
if not exist "%MIGRATOR%" goto missing_migrator
if not exist "%CLEANER%" goto missing_cleaner

cd /d "%PROJECT_DIR%"
call :select_server_port
if errorlevel 11 goto outdated_running
if errorlevel 10 goto already_running
if errorlevel 1 goto port_selection_failed

"%PYTHON%" "%MIGRATOR%"
if errorlevel 1 goto migration_failed
"%PYTHON%" "%CLEANER%" --apply
if errorlevel 1 goto cleanup_failed

call :select_server_port
if errorlevel 11 goto outdated_running
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
echo ERRO: Python 3.12 ou superior nao foi encontrado.
echo Instale Python 3.12 ou superior e execute este inicializador novamente.
pause
exit /b 1

:missing_bootstrapper
echo ERRO: configurador inicial do ambiente nao encontrado:
echo %BOOTSTRAPPER%
pause
exit /b 1

:bootstrap_failed
echo ERRO: nao foi possivel preparar o ambiente Python.
echo Confira a versao do Python e a conexao com a internet; depois tente novamente.
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

:outdated_running
echo.
echo ERRO: ja existe um servidor Simpress DESATUALIZADO na porta %SIMPRESS_PORT%.
echo Nenhuma segunda copia foi iniciada. Feche a janela desse servidor (ou encerre o
echo processo indicado acima) e execute este inicializador novamente.
pause
exit /b 1

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
if /i "%SERVER_ACTION%"=="OUTDATED" exit /b 11
if /i "%SERVER_ACTION%"=="RUNNING" exit /b 10
if /i "%SERVER_ACTION%"=="PORT" exit /b 0
exit /b 1
