# Acesso pelo celular (Wi-Fi local)

Opcional e desligado por padrão. Só liga ao abrir `iniciar_servidor_celular.bat` (define `SIMPRESS_ACESSO_REDE=1` e chama o `iniciar_servidor.bat`).

## Como usar

1. Feche qualquer Simpress aberto e execute `iniciar_servidor_celular.bat`.
2. Na janela aparece `CELULAR (mesmo Wi-Fi): http://<IP-do-PC>:<porta>/bootstrap?t=<token>`.
3. Abra esse link no celular, na mesma rede Wi-Fi do PC.
4. Se não abrir, libere a porta no Firewall (PowerShell como administrador, só rede privada):
   `New-NetFirewallRule -DisplayName "Simpress LAN" -Direction Inbound -Protocol TCP -LocalPort 8000 -Profile Private -Action Allow`

## O que muda no modo rede

- O servidor escuta em `0.0.0.0` e aceita só IPs privados da LAN (nunca públicos nem link-local); proxy continua recusado.
- O Host precisa ser `localhost`, `127.0.0.1` ou o IP do PC na rede.
- `/api/*` continua exigindo o cookie de sessão, criado pelo link com token. O token muda a cada reinício; ele aparece só no console, nunca no log.
- Quem tem o link tem acesso total (CPF, SoftExpert, Outlook): use só em rede confiável.

Código: `security/network.py`, `security/local_requests.py`, `main.py`. Testes: `tests/test_acesso_rede.py`.
