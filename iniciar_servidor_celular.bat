@echo off
rem Inicia o Simpress com acesso pelo celular (mesmo Wi-Fi). O link com token aparece na janela.
rem Primeira vez: libere a porta no Firewall (ver docs/guias/acesso-celular.md).
set "SIMPRESS_ACESSO_REDE=1"
call "%~dp0iniciar_servidor.bat" %*
