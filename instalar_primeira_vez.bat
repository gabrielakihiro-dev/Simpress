@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "PROJECT_ROOT=%PROJECT_DIR%."
set "PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"
set "BOOTSTRAPPER=%PROJECT_DIR%scripts\bootstrap_environment.py"
set "MIGRATOR=%PROJECT_DIR%scripts\migrate_local_data.py"
set "STARTER=%PROJECT_DIR%iniciar_servidor.bat"
set "PENDENCIAS=0"
set "PYTHONUTF8=1"

title Simpress - Instalacao da primeira execucao
chcp 65001 > nul

echo ========================================================
echo   Simpress - Instalacao da primeira execucao
echo   Projeto: %PROJECT_DIR%
echo   Pode ser executado de novo com seguranca: so instala o que falta.
echo ========================================================
echo.

if not exist "%BOOTSTRAPPER%" goto missing_bootstrapper

rem ---------------------------------------------------------------
rem 1/5 Python 3.12 ou superior
rem ---------------------------------------------------------------
echo [1/5] Procurando Python 3.12 ou 3.13 ^(versoes com pacotes prontos para as dependencias fixadas^)...
set "BOOTSTRAP_LAUNCHER="
set "BOOTSTRAP_PREFIX="
set "PY_MAX=14"
if exist "%PYTHON%" call :testar_python "%PYTHON%" ""
if not defined BOOTSTRAP_LAUNCHER call :testar_python py "-3.12"
if not defined BOOTSTRAP_LAUNCHER call :testar_python py "-3.13"
if not defined BOOTSTRAP_LAUNCHER call :testar_python python ""
if defined BOOTSTRAP_LAUNCHER goto python_ok

echo   Python 3.12 ou 3.13 nao encontrado.
where winget >nul 2>nul
if errorlevel 1 goto python_sem_winget
echo   Instalando Python 3.12 pelo winget ^(pode pedir permissao do Windows^)...
winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
rem O PATH desta janela nao enxerga o Python recem-instalado; tenta os caminhos padrao.
call :testar_python "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" ""
if not defined BOOTSTRAP_LAUNCHER call :testar_python py "-3.12"
if defined BOOTSTRAP_LAUNCHER goto python_ok
echo.
echo   Python instalado, mas esta janela ainda nao o reconhece.
echo   Feche esta janela e execute instalar_primeira_vez.bat novamente.
pause
exit /b 1

:python_sem_winget
rem Sem winget: aceita qualquer Python 3.12+, ciente de que versoes mais novas podem exigir compilador.
set "PY_MAX=99"
call :testar_python py "-3"
if not defined BOOTSTRAP_LAUNCHER call :testar_python python ""
if defined BOOTSTRAP_LAUNCHER (
    echo   [AVISO] Usando um Python mais novo que 3.13; se a instalacao das dependencias falhar,
    echo           instale o Python 3.12 em https://www.python.org/downloads/ e execute novamente.
    goto python_ok
)

:python_manual
echo.
echo ERRO: Python 3.12 ou superior nao encontrado e o winget nao esta disponivel.
echo Baixe em https://www.python.org/downloads/ ^(marque "Add python.exe to PATH"^)
echo e execute este instalador novamente.
pause
exit /b 1

:python_ok
echo   OK: Python encontrado ^(%BOOTSTRAP_LAUNCHER%^).
echo.

rem ---------------------------------------------------------------
rem 2/5 Ambiente virtual .venv + dependencias fixadas (inclui o Playwright)
rem ---------------------------------------------------------------
echo [2/5] Preparando o ambiente Python ^(.venv e dependencias; requer internet^)...
"%BOOTSTRAP_LAUNCHER%" %BOOTSTRAP_PREFIX% "%BOOTSTRAPPER%" --project-root "%PROJECT_ROOT%"
if errorlevel 1 goto bootstrap_failed
if not exist "%PYTHON%" goto bootstrap_failed
"%PYTHON%" -c "import playwright, fastapi, uvicorn, openpyxl" >nul 2>nul
if errorlevel 1 goto bootstrap_failed
echo   OK: dependencias instaladas ^(FastAPI, Uvicorn, openpyxl, Playwright^).
echo.

rem ---------------------------------------------------------------
rem 3/5 Chromium do Playwright
rem ---------------------------------------------------------------
echo [3/5] Baixando o Chromium do Playwright ^(so baixa se ainda nao estiver instalado^)...
"%PYTHON%" -m playwright install chromium
if errorlevel 1 goto chromium_failed
echo   OK: Chromium do Playwright pronto.
echo.

rem ---------------------------------------------------------------
rem 4/5 Google Chrome (usado pela automacao de OS e inventarios) e pastas de dados
rem ---------------------------------------------------------------
echo [4/5] Conferindo o Google Chrome e as pastas de dados...
set "CHROME_EXE="
if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined CHROME_EXE (
    echo   OK: Google Chrome encontrado.
) else (
    set /a PENDENCIAS+=1
    echo   [PENDENTE] Google Chrome nao encontrado. A automacao ^(executar_automacao.bat^) usa o Chrome instalado.
    echo              Instale em https://www.google.com/chrome/ ou rode: winget install -e --id Google.Chrome
)
if exist "%MIGRATOR%" (
    "%PYTHON%" "%MIGRATOR%"
    if errorlevel 1 goto migration_failed
    echo   OK: pastas de dados verificadas.
)
echo.

rem ---------------------------------------------------------------
rem 5/5 Ferramentas opcionais para desenvolvimento: ripgrep e Node.js (nunca bloqueiam)
rem ---------------------------------------------------------------
echo [5/5] Conferindo ferramentas opcionais ^(ripgrep, RTK e Node.js; so para desenvolvimento^)...
where rg >nul 2>nul
if not errorlevel 1 (
    echo   OK: ripgrep ^(rg^) encontrado.
    goto checar_rtk
)
where winget >nul 2>nul
if errorlevel 1 (
    echo   ripgrep ^(rg^) nao encontrado e o winget nao esta disponivel. O "rtk rg" dos agentes precisa dele:
    echo   instale em https://github.com/BurntSushi/ripgrep/releases ou use "rtk grep -rn" enquanto isso.
    goto checar_rtk
)
echo   ripgrep ^(rg^) nao encontrado; instalando pelo winget ^(usado pelo "rtk rg" dos agentes^)...
winget install -e --id BurntSushi.ripgrep.MSVC --scope user --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo   [AVISO] Nao foi possivel instalar o ripgrep; o servidor nao e afetado. Use "rtk grep -rn" no lugar de "rtk rg".
) else (
    echo   OK: ripgrep instalado. Abra um terminal novo para ele entrar no PATH.
)

:checar_rtk
where rtk >nul 2>nul
if errorlevel 1 goto instalar_rtk
rtk gain >nul 2>nul
if errorlevel 1 (
    echo   [AVISO] Existe um "rtk" no PATH, mas nao e o Rust Token Killer ^("rtk gain" falhou^).
    echo           Pode ser outro pacote de mesmo nome; desinstale-o antes de instalar o RTK de rtk-ai.
) else (
    echo   OK: RTK ^(Rust Token Killer^) encontrado.
)
goto checar_node

:instalar_rtk
where winget >nul 2>nul
if errorlevel 1 (
    echo   RTK nao encontrado e o winget nao esta disponivel. Baixe o binario em https://github.com/rtk-ai/rtk/releases ^(opcional^).
    goto checar_node
)
echo   RTK ^(Rust Token Killer^) nao encontrado; instalando pelo winget ^(reduz o consumo de tokens dos agentes^)...
winget install -e --id rtk-ai.rtk --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo   [AVISO] Nao foi possivel instalar o RTK; o servidor nao e afetado.
) else (
    echo   OK: RTK instalado. Abra um terminal novo e rode "rtk gain" para confirmar.
    echo   Para ativar o hook do Claude Code, rode uma vez: rtk init -g ^(altera ~/.claude/settings.json; nao e feito aqui^).
)

:checar_node
where npm >nul 2>nul
if errorlevel 1 (
    echo   Node.js nao encontrado. O servidor e a automacao funcionam sem ele.
    echo   Para rodar "npm run test:ui:e2e", instale o Node.js LTS ^(winget install -e --id OpenJS.NodeJS.LTS^).
    goto resumo
)
if not exist "%PROJECT_DIR%package-lock.json" goto resumo
pushd "%PROJECT_DIR%"
call npm ci --no-audit --no-fund
if errorlevel 1 (
    echo   [AVISO] npm ci falhou; os testes de interface nao estao prontos. O servidor nao e afetado.
    popd
    goto resumo
)
call npx playwright install chromium
if errorlevel 1 echo   [AVISO] Chromium dos testes de interface nao foi baixado; o servidor nao e afetado.
popd
echo   OK: dependencias dos testes de interface instaladas.

:resumo
echo.
echo ========================================================
if "%PENDENCIAS%"=="0" (
    echo   Instalacao concluida. Tudo pronto.
) else (
    echo   Instalacao concluida com %PENDENCIAS% pendencia^(s^) acima.
)
echo   Para o uso diario, abra iniciar_servidor.bat.
echo ========================================================
echo.
if /i "%SIMPRESS_INSTALADOR_SEM_PERGUNTA%"=="1" exit /b 0
set "RESPOSTA="
set /p "RESPOSTA=Iniciar o servidor agora? (S/N): "
if /i "%RESPOSTA%"=="S" call "%STARTER%"
endlocal
exit /b 0

rem ---------------------------------------------------------------
rem Sub-rotinas e erros
rem ---------------------------------------------------------------
:testar_python
rem %1 = executavel, %2 = prefixo (ex.: -3.12). Define BOOTSTRAP_* se a versao for 3.12 ate PY_MAX (exclusivo).
"%~1" %~2 -c "import sys; sys.exit(0 if (3, 12) <= sys.version_info[:2] < (3, %PY_MAX%) else 1)" >nul 2>nul
rem Codigos negativos (ex.: py sem runtime) nao passam em "if errorlevel 1"; compara com 0.
if not "%errorlevel%"=="0" exit /b 0
set "BOOTSTRAP_LAUNCHER=%~1"
set "BOOTSTRAP_PREFIX=%~2"
exit /b 0

:missing_bootstrapper
echo ERRO: configurador inicial do ambiente nao encontrado:
echo %BOOTSTRAPPER%
pause
exit /b 1

:bootstrap_failed
echo.
echo ERRO: nao foi possivel preparar o ambiente Python.
echo Confira a conexao com a internet e tente novamente.
pause
exit /b 1

:chromium_failed
echo.
echo ERRO: nao foi possivel baixar o Chromium do Playwright.
echo Confira a conexao com a internet ^(ou proxy/antivirus^) e execute este instalador novamente.
pause
exit /b 1

:migration_failed
echo.
echo ERRO: dados locais nao foram alterados com seguranca.
echo Resolva o aviso acima e execute novamente.
pause
exit /b 1
