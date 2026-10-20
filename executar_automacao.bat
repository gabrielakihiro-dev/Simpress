@echo off
setlocal
chcp 65001 >nul
title Automacao Simpress - Google Chrome
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PY=%~dp0.venv\Scripts\python.exe"
set "vazias=0"

if not exist "%PY%" (
    echo [ERRO] Ambiente Python nao encontrado em "%PY%".
    echo Rode a instalacao do projeto antes de usar a automacao.
    pause
    exit /b 1
)

:menu
cls
echo =======================================================================
echo          AUTOMACAO SIMPRESS - ORDEM DE SERVICO E INVENTARIOS
echo =======================================================================
echo.
echo  O Chrome de automacao usa perfil proprio e a porta local 9333.
echo  Ele fica aberto entre as execucoes para manter os logins.
echo.
echo   [1] Executar Rotina de OS (Oracle Service Cloud + UX Simpress)
echo   [2] Executar Rotina de Inventarios (UX Simpress + Endpoint Central)
echo   [3] Executar Ambas as Rotinas (OS + Inventarios)
echo   [4] Abrir Chrome de Automacao para Login / Autenticacao
echo   [5] Sair
echo.
set "opcao="
set /p "opcao=Digite o numero da opcao desejada [1-5]: "

rem Tres respostas vazias seguidas indicam fim da entrada (sem teclado); evita repetir o menu sem fim.
if not defined opcao (set /a vazias+=1) else (set "vazias=0")
if %vazias% GEQ 3 goto sair

if "%opcao%"=="1" set "rotina=os" & goto executar
if "%opcao%"=="2" set "rotina=inventarios" & goto executar
if "%opcao%"=="3" set "rotina=ambas" & goto executar
if "%opcao%"=="4" set "rotina=login" & goto executar
if "%opcao%"=="5" goto sair

echo.
echo [ERRO] Opcao invalida: "%opcao%". Tente novamente.
timeout /t 2 >nul 2>nul
goto menu

:executar
echo.
echo =======================================================================
echo Iniciando rotina: %rotina%   (Ctrl+C cancela)
echo =======================================================================
rem O script nao le o teclado; <nul impede que consuma a resposta do proximo menu.
"%PY%" scripts\automacao_rotinas_chrome.py --rotina %rotina% <nul
set "codigo=%errorlevel%"
echo.
echo =======================================================================
if "%codigo%"=="0" (
    echo Execucao finalizada com sucesso.
) else (
    echo Execucao finalizada com falha ^(codigo %codigo%^). Veja as mensagens acima.
)
echo =======================================================================
pause
goto menu

:sair
echo Saindo...
endlocal
exit /b 0
