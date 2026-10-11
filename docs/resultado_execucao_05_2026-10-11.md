# Execução 05 — Validar o cliente real no modo local

Data: 11/10/2026. Escopo: achado 5, criticidade alta.
Modelo recomendado no roteiro: GPT-6.1 Sol, raciocínio high.

## Defeito confirmado e correção

Antes da alteração, o teste reproduziu HTTP 200 para quatro clientes remotos
com Host local no modo de arquivos: IPv4 público de documentação, IPv4 privado,
IPv6 e IPv4 remoto mapeado em IPv6. O middleware verificava Host/Origin, mas
somente a barreira do piloto PostgreSQL verificava o IP.

Agora a aplicação verifica `scope.client` antes de encaminhar a requisição,
independentemente do backend. Clientes não locais ou malformados recebem HTTP
403. A barreira PostgreSQL reutiliza a mesma política, evitando divergências.
As verificações existentes de Host, Origin, tamanho do corpo, admissão de
uploads, autenticação e CSRF foram preservadas.

## Política de conexão

- Aceitar IPv4 em `127.0.0.0/8`, IPv6 `::1` e suas representações equivalentes.
- Aceitar IPv4 mapeado em IPv6 somente quando o IPv4 correspondente é loopback,
  por exemplo `::ffff:127.0.0.1` e `::ffff:7f00:1`.
- Rejeitar cliente ausente, estrutura ou porta inválida, hostname no lugar do
  endereço, endereço com porta embutida, IPv6 entre colchetes e identificador de
  zona como `::1%lo`.
- Usar o endereço do peer ASGI, sem resolver nomes nem extrair IP de cabeçalhos.
- Rejeitar `Forwarded`, `X-Real-IP` e toda a família `X-Forwarded-*`, inclusive
  quando a conexão chega por loopback. Os perfis locais não suportam proxies.
- Manter Uvicorn com `proxy_headers=False` / `--no-proxy-headers`.

O inicializador principal, o piloto PostgreSQL e o ensaio de Auth já desativavam
proxy headers. O inicializador HTTP de `scripts/verify_postgres.py` foi corrigido
para fazê-lo também. Uma regressão envolve a aplicação no middleware de proxy
real do Uvicorn, confiando propositalmente em todos os peers na fixture, e
comprova que `X-Forwarded-For: 127.0.0.1` continua sem liberar acesso.

## Arquivos desta execução

| Arquivo | Alteração |
| --- | --- |
| `security/network.py` | Política compartilhada de peer loopback e rejeição de encaminhamento |
| `main.py` | Aplicação da política no middleware local de todos os backends |
| `persistence/boundary.py` | Reutilização da política no piloto PostgreSQL |
| `scripts/verify_postgres.py` | Desativação explícita de proxy headers no servidor de ensaio |
| `tests/test_local_request_security.py` | Seis testes com matrizes de clientes, backends, headers e rotas reais |
| `tests/test_maintenance_contracts.py` | Fixture ASGI existente passa a informar um peer loopback válido |
| `docs/resultado_execucao_05_2026-10-11.md` | Resultado e política documentados |

A alteração anterior do contrato de assets no teste de manutenção, assim como
as demais mudanças locais da correção npm e de outros trabalhos, foi preservada.

## Validação executada

- Antes da correção: o teste de cliente remoto falhou em quatro subcasos do
  modo de arquivos, confirmando o defeito.
- Depois da correção: seis novos testes aprovados, cobrindo os backends de
  arquivos e PostgreSQL, inclusive a barreira PostgreSQL isoladamente.
- Aplicação FastAPI real via TestClient/ASGI: `/login`, arquivo estático e
  `/api/auth/session` acessíveis por IPv4, IPv6 e IPv4 mapeado; clientes remotos
  rejeitados. Perfil autenticado usa serviço sintético; API protegida continua
  exigindo sessão e respondendo 401 sem autenticação.
- Suíte Python completa pelo runner isolado: **305 testes aprovados**.
- Mypy em `main.py`, `security/network.py`, `persistence/boundary.py` e
  `scripts/verify_postgres.py`: sem erros nos quatro arquivos.
- HTTP real com FastAPI/Uvicorn em servidores temporários: **18 verificações
  aprovadas**, nove em `127.0.0.1` e nove em `::1`. Home, login, favicon e API de
  sessão retornaram 200; cabeçalhos encaminhados falsos, Host externo e Origin
  externo retornaram 403. Servidores encerrados ao final.
- `git diff --check`: sem erros.

Os testes HTTP usaram portas efêmeras, `lifespan='off'`, configuração temporária
de autoridades permitidas e bloqueio da carga de planilhas/recuperação de
transações durante a importação. O servidor operacional não foi reiniciado.
Logs e o script descartável do smoke test ficam na pasta ignorada `logs/`.

## Limitações e riscos restantes

O HTTP real validou o backend de arquivos. As verificações do perfil PostgreSQL
e do perfil autenticado foram ASGI com serviços sintéticos: não houve conexão
ao banco, login no Supabase, sincronização compartilhada ou teste de navegador
nesta execução. A simulação de peers remotos foi ASGI, sem expor uma porta à rede.

A inicialização padrão em `127.0.0.1` já mitigava o achado; não foi presumida nem
confirmada exposição remota da instalação atual. O modo de arquivos continua
sem autenticação de usuário: processos locais podem acessá-lo. Esta política
restringe a conexão ao computador, sem distinguir usuários ou processos locais.

Um servidor ASGI ou middleware externo deve preservar o peer e os cabeçalhos
originais. Não é possível recuperar o endereço do socket se uma camada externa
o substituir e remover toda evidência de encaminhamento. Use os inicializadores
documentados, que desativam proxy headers.

Não foram instaladas dependências nem feitos commit, push, deploy ou a etapa 06.
