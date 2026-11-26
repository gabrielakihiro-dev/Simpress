@echo off
rem Inicia o Simpress com acesso pelo celular via Tailscale (funciona com dados moveis). Link com token na janela.
rem Requer Tailscale no PC e no celular (mesma conta). Ver docs/guias/acesso-celular.md.
set "SIMPRESS_ACESSO_TAILSCALE=1"
call "%~dp0iniciar_servidor.bat" %*
