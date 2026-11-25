"""Configuração local pelo site (Prontidão da base): contas das automações, links internos e chaves de IA.

Grava só ``config/contas_automacao.json`` (chaves conhecidas; as demais ficam como estão) e as linhas
``OPENROUTER_API_KEY=`` e ``DEEPSEEK_API_KEY=`` do ``.env``. Variável de ambiente vence o arquivo e o campo fica só
leitura. Senha e MFA nunca passam por aqui. As chaves de IA nunca saem daqui inteiras: só ``configurada``, ``final`` e
``fonte``. O log leva só ``configuracao_local: <seção> gravada``; erros de validação nunca repetem o valor recebido.
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlparse

from core.integrity import atomic_copy_file, atomic_write_bytes, atomic_write_json
from domains.assistant_openrouter import ENV_LINE_PATTERN, MAX_ENV_FILE_BYTES, PLACEHOLDER_KEY_PREFIX, read_env_file
from domains.local_setup import cnpj_valido, load_client_config

logger = logging.getLogger(__name__)

BACKUPS_MANTIDOS = 5
LIMITE_CHAVE_IA = 200

# Cada conta é pedida uma vez e gravada em todas as chaves do grupo (o formato lido pelas automações não muda).
# ``chaves``: (chave no JSON, variável de ambiente). ``outlook``: o espelho opcional para o e-mail pelo Outlook.
CONTAS: tuple[dict[str, Any], ...] = (
    {
        "id": "conta_simpress", "rotulo": "Conta Simpress (e-mail)", "placeholder": "nome@simpress.com.br",
        "usado_para": "Dashboard, UX Simpress, Oracle", "ajuda": "Usada para: Dashboard, UX Simpress, Oracle",
        "tipo": "email", "chaves": (("dashboard_email", "SIMPRESS_DASHBOARD_EMAIL"),),
        "outlook": ("outlook_email_simpress", "SIMPRESS_OUTLOOK_EMAIL_SIMPRESS"),
    },
    {
        "id": "conta_sebrae", "rotulo": "Conta Sebrae (e-mail)", "placeholder": "nome@sebrae.com.br",
        "usado_para": "SoftExpert", "ajuda": "Usada para: SoftExpert",
        "tipo": "email", "chaves": (("softexpert_email", "SIMPRESS_SOFTEXPERT_EMAIL"),),
        "outlook": ("outlook_email_sebrae", "SIMPRESS_OUTLOOK_EMAIL_SEBRAE"),
    },
    {
        "id": "usuario_endpoint", "rotulo": "Usuário do Endpoint Central (login, sem domínio)",
        "placeholder": "nome.usuario", "usado_para": "Endpoint Central", "ajuda": "Usada para: Endpoint Central",
        "tipo": "usuario", "chaves": (("endpoint_usuario", "SIMPRESS_ENDPOINT_USUARIO"),), "outlook": None,
    },
)

# Links internos: um link novo (UX, Endpoint, Oracle, SoftExpert, Notion) entra com uma linha aqui, com a mesma
# validação https://. ``obrigatorio`` decide se a falta dele deixa o status Pendente.
LINKS: tuple[dict[str, Any], ...] = (
    {
        "chave": "dashboard_pasta_url", "variavel": "SIMPRESS_DASHBOARD_PASTA_URL",
        "rotulo": "Link da pasta do Dashboard (SharePoint)",
        "placeholder": "https://exemplo.invalid/sites/pasta-do-dashboard",
        "usado_para": "Dashboard", "ajuda": "Usado para: Dashboard", "obrigatorio": True,
    },
    {
        "chave": "endpoint_url", "variavel": "SIMPRESS_ENDPOINT_URL",
        "rotulo": "Link do Endpoint Central (Computadores)",
        "placeholder": "https://exemplo.invalid/webclient#/uems/inventory/computers",
        "usado_para": "Endpoint Central", "ajuda": "Usado para: Endpoint Central (em branco usa o link padrão)",
        "obrigatorio": False,
    },
)

CHAVES_IA = {
    "openrouter": ("OPENROUTER_API_KEY", "Chave do OpenRouter"),
    "deepseek": ("DEEPSEEK_API_KEY", "Chave do DeepSeek"),
}

# Mesma regra de TransferenciaPayload.validate_email (domains não importa routers).
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_CONTRATO = re.compile(r"[1-9]\d{0,11}")


def validar_valor(tipo: str, valor: str) -> Optional[str]:
    """Mensagem de erro (nunca o valor) ou None quando o valor é aceito."""
    if not valor.isprintable():
        return "o valor tem caractere inválido."
    if tipo == "email" and (len(valor) > 254 or not _EMAIL.fullmatch(valor)):
        return "informe um e-mail válido."
    if tipo == "usuario" and (len(valor) > 100 or re.search(r"[@\\\s]", valor)):
        return "informe só o login, sem domínio, sem @, sem \\ e sem espaço."
    if tipo == "link":
        try:
            partes = urlparse(valor)
        except ValueError:
            partes = None
        if partes is None or len(valor) > 2000 or partes.scheme != "https" or not partes.netloc or re.search(r"\s", valor):
            return "informe um link que comece com https://."
    return None


def validar_chave_ia(valor: str) -> Optional[str]:
    if len(valor) > LIMITE_CHAVE_IA or re.search(r"[\s=#]", valor) or not valor.isprintable():
        return f"use até {LIMITE_CHAVE_IA} caracteres, sem espaço, quebra de linha, = ou #."
    return None


def _ler_json(arquivo: Path) -> tuple[dict, bool]:
    """(conteúdo, ilegível). Arquivo ausente conta como vazio e legível."""
    try:
        guardado = json.loads(Path(arquivo).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}, False
    except (OSError, ValueError):
        return {}, True
    return (guardado, False) if isinstance(guardado, dict) else ({}, True)


def _ambiente(variavel: str, env: Mapping[str, str]) -> str:
    return str(env.get(variavel) or "").strip()


def _resolver(variavel: str, chave: str, guardado: Mapping[str, Any], env: Mapping[str, str]) -> tuple[str, str]:
    """Valor efetivo e fonte: variável de ambiente, depois o arquivo, depois vazio."""
    do_ambiente = _ambiente(variavel, env)
    if do_ambiente:
        return do_ambiente, "ambiente"
    do_arquivo = guardado.get(chave)
    do_arquivo = do_arquivo.strip() if isinstance(do_arquivo, str) else ""
    return (do_arquivo, "arquivo") if do_arquivo else ("", "")


def _usa_outlook(conta: Mapping[str, Any], valor: str, guardado: Mapping[str, Any], env: Mapping[str, str]) -> Optional[bool]:
    """Caixa "Usar também no Outlook": marcada por padrão e quando o espelho já é igual à conta."""
    if not conta["outlook"]:
        return None
    chave, variavel = conta["outlook"]
    espelho, _ = _resolver(variavel, chave, guardado, env)
    return (not valor and not espelho) or espelho == valor


def estado_assistente(arquivo_env: Path, ambiente: Optional[Mapping[str, str]] = None) -> dict:
    """Por chave de IA: ``configurada``, ``final`` (4 últimos caracteres) e ``fonte``. Nunca a chave inteira."""
    env = os.environ if ambiente is None else ambiente
    do_arquivo = read_env_file(Path(arquivo_env))
    estado = {}
    for identificador, (variavel, _) in CHAVES_IA.items():
        valor = _ambiente(variavel, env)
        fonte = "ambiente" if valor else "arquivo"
        valor = valor or str(do_arquivo.get(variavel) or "").strip()
        if not valor or valor.startswith(PLACEHOLDER_KEY_PREFIX):
            estado[identificador] = {"configurada": False, "final": "", "fonte": ""}
        else:
            # Chave curta demais mostraria quase tudo: só as reticências.
            estado[identificador] = {
                "configurada": True, "final": "…" + valor[-4:] if len(valor) >= 12 else "…", "fonte": fonte,
            }
    return estado


def ler_configuracao(arquivo_contas: Path, arquivo_cliente: Path, arquivo_env: Path,
                     ambiente: Optional[Mapping[str, str]] = None) -> dict:
    """Status de cada seção para o modal. E-mails e usuário voltam inteiros (são do usuário, nesta máquina)."""
    env = os.environ if ambiente is None else ambiente
    guardado, contas_ilegivel = _ler_json(arquivo_contas)

    contas = []
    for conta in CONTAS:
        chave, variavel = conta["chaves"][0]
        valor, fonte = _resolver(variavel, chave, guardado, env)
        contas.append({
            **{campo: conta[campo] for campo in ("id", "rotulo", "placeholder", "usado_para", "ajuda", "tipo")},
            "valor": valor, "fonte": fonte, "somente_leitura": fonte == "ambiente",
            "usar_no_outlook": _usa_outlook(conta, valor, guardado, env),
            "valido": not valor or validar_valor(conta["tipo"], valor) is None,
        })

    links = []
    for link in LINKS:
        valor, fonte = _resolver(link["variavel"], link["chave"], guardado, env)
        links.append({
            **{campo: link[campo] for campo in ("chave", "rotulo", "placeholder", "usado_para", "ajuda", "obrigatorio")},
            "valor": valor, "fonte": fonte, "somente_leitura": fonte == "ambiente",
            "valido": not valor or validar_valor("link", valor) is None,
        })

    dados = load_client_config(arquivo_cliente, env)
    contrato_ok = not dados["contrato"] or bool(_CONTRATO.fullmatch(dados["contrato"]))
    cnpj_ok = not dados["cnpj_faturamento"] or cnpj_valido(dados["cnpj_faturamento"])
    cliente = {
        "configurado": dados["cliente_configurado"], "arquivo_invalido": dados["cliente_arquivo_invalido"],
        "valido": not dados["cliente_arquivo_invalido"] and contrato_ok and cnpj_ok,
    }

    assistente = estado_assistente(arquivo_env, env)
    return {
        "status": _status(contas, links, cliente, contas_ilegivel, any(item["configurada"] for item in assistente.values())),
        "contas": contas,
        "links": links,
        "contas_arquivo_invalido": contas_ilegivel,
        "cliente": cliente,
        "assistente": assistente,
    }


def _status(contas: list, links: list, cliente: dict, contas_ilegivel: bool, assistente_ia: bool) -> dict:
    """``state`` ready|pending|invalid; ``faltando`` só com identificadores. A chave de IA nunca deixa Pendente."""
    recusados = [item["rotulo"] for item in (*contas, *links) if not item["valido"]]
    if contas_ilegivel or cliente["arquivo_invalido"] or recusados or not cliente["valido"]:
        if contas_ilegivel:
            motivo = "config/contas_automacao.json não é um JSON válido."
        elif cliente["arquivo_invalido"]:
            motivo = "config/cliente.json não é um JSON válido."
        else:
            motivo = "Valor recusado em: " + ", ".join(recusados or ["Dados do cliente"]) + "."
        return {"state": "invalid", "faltando": [], "reason": motivo, "assistente_ia": assistente_ia}
    faltas = [(item["id"], item["rotulo"]) for item in contas if not item["valor"]]
    faltas += [(item["chave"], item["rotulo"]) for item in links if item["obrigatorio"] and not item["valor"]]
    if not cliente["configurado"]:
        faltas.append(("dados_cliente", "Dados do cliente"))
    if faltas:
        return {
            "state": "pending", "faltando": [identificador for identificador, _ in faltas],
            "reason": "Falta: " + ", ".join(rotulo for _, rotulo in faltas), "assistente_ia": assistente_ia,
        }
    return {"state": "ready", "faltando": [], "reason": "", "assistente_ia": assistente_ia}


def status_configuracao(arquivo_contas: Path, arquivo_cliente: Path, arquivo_env: Path,
                        ambiente: Optional[Mapping[str, str]] = None) -> dict:
    """A chave ``configuracao_local`` de GET /api/prontidao."""
    return ler_configuracao(arquivo_contas, arquivo_cliente, arquivo_env, ambiente)["status"]


def _backup(arquivo: Path, pasta: Path, agora: datetime) -> None:
    """Copia o arquivo atual para <pasta>/<nome>.<AAAAMMDD-HHMMSS>.bak e mantém os 5 mais recentes."""
    if not arquivo.is_file():
        return
    pasta.mkdir(parents=True, exist_ok=True)
    existentes = [antigo.name for antigo in pasta.glob(f"{arquivo.name}.*.bak")]
    momento = agora
    # O nome novo é sempre maior que o de qualquer backup existente (salvar duas vezes no mesmo segundo, ou com o
    # relógio atrasado, avança 1 s): a ordem por nome é a ordem do tempo e a poda nunca apaga o mais novo.
    while any(nome >= f"{arquivo.name}.{momento:%Y%m%d-%H%M%S}.bak" for nome in existentes):
        momento += timedelta(seconds=1)
    destino = pasta / f"{arquivo.name}.{momento:%Y%m%d-%H%M%S}.bak"
    atomic_copy_file(arquivo, destino)
    for antigo in sorted(pasta.glob(f"{arquivo.name}.*.bak"))[:-BACKUPS_MANTIDOS]:
        antigo.unlink(missing_ok=True)


def gravar_contas(arquivo: Path, pasta_backups: Path, contas: Mapping[str, str], links: Mapping[str, str],
                  usar_no_outlook: Mapping[str, bool], ambiente: Optional[Mapping[str, str]] = None,
                  agora: Callable[[], datetime] = datetime.now) -> None:
    """Valida e grava as contas e os links. Valor em branco mantém o atual; variável de ambiente nunca é sobreposta.

    shortcut: leitura, backup e gravação não ficam sob uma trava única, uso de uma pessoa nesta máquina; trocar por
    trava se um segundo gravador aparecer.
    """
    env = os.environ if ambiente is None else ambiente
    conhecidos = {link["chave"] for link in LINKS}
    if any(chave not in conhecidos for chave in links):
        raise ValueError("Link desconhecido em Links internos.")
    guardado, _ = _ler_json(arquivo)
    novos: dict[str, str] = {}
    remover: set[str] = set()
    for conta in CONTAS:
        chave, variavel = conta["chaves"][0]
        valor = str(contas.get(conta["id"]) or "").strip()
        if valor and (erro := validar_valor(conta["tipo"], valor)):
            raise ValueError(f'{conta["rotulo"]}: {erro}')
        atual, fonte = _resolver(variavel, chave, guardado, env)
        if valor and not _ambiente(variavel, env):
            novos[chave] = valor
        # Campo em branco só mexe no espelho do Outlook quando a caixa veio no pedido (ausente = deixa como está).
        if not conta["outlook"] or not (valor or conta["id"] in usar_no_outlook):
            continue
        chave_outlook, variavel_outlook = conta["outlook"]
        if _ambiente(variavel_outlook, env):
            continue
        if usar_no_outlook.get(conta["id"], True):
            # Conta vinda do ambiente não é copiada para o arquivo: valeria mesmo depois de a variável sair.
            espelho = valor or (atual if fonte != "ambiente" else "")
            if espelho:
                novos[chave_outlook] = espelho
        elif guardado.get(chave_outlook) == atual:
            # Desmarcar tira só o espelho (igual à conta); e-mail do Outlook diferente da conta foi escolhido à mão e fica.
            remover.add(chave_outlook)
    for link in LINKS:
        valor = str(links.get(link["chave"]) or "").strip()
        if not valor:
            continue
        if (erro := validar_valor("link", valor)):
            raise ValueError(f'{link["rotulo"]}: {erro}')
        if not _ambiente(link["variavel"], env):
            novos[link["chave"]] = valor

    resultado = {**{chave: valor for chave, valor in guardado.items() if chave not in remover}, **novos}
    if resultado == guardado:
        return
    arquivo = Path(arquivo)
    _backup(arquivo, Path(pasta_backups), agora())
    arquivo.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(arquivo, resultado)
    logger.info("configuracao_local: contas gravada")


def _aplicar_env(arquivo: Path, pasta_backups: Path, alteracoes: Mapping[str, Optional[str]], agora: datetime,
                 com_backup: bool = True) -> bool:
    """Troca só as linhas ``CHAVE=`` afetadas (None remove); comentários e demais linhas ficam como estão."""
    try:
        bruto = arquivo.read_bytes() if arquivo.exists() else b""
        if len(bruto) > MAX_ENV_FILE_BYTES:
            raise ValueError("O arquivo .env é grande demais para ser editado pelo site.")
        texto = bruto.decode("utf-8-sig")
    except UnicodeDecodeError as erro:
        raise ValueError("O arquivo .env não está em UTF-8.") from erro
    quebra = "\r\n" if "\r\n" in texto else "\n"
    linhas: list[str] = []
    vistas: set[str] = set()
    for linha in texto.splitlines(keepends=True):
        corpo = linha.rstrip("\r\n")
        achada = ENV_LINE_PATTERN.match(corpo)
        variavel = achada.group(1) if achada and not corpo.lstrip().startswith("#") else ""
        if variavel not in alteracoes:
            linhas.append(linha)
            continue
        vistas.add(variavel)
        if (valor := alteracoes[variavel]) is not None:
            linhas.append(f"{variavel}={valor}{linha[len(corpo):]}")
    for variavel, valor in alteracoes.items():
        if valor is None or variavel in vistas:
            continue
        if linhas and not linhas[-1].endswith(("\n", "\r")):
            linhas[-1] += quebra
        linhas.append(f"{variavel}={valor}{quebra}")
    novo = "".join(linhas)
    if novo == texto:
        return False
    if com_backup:
        _backup(arquivo, pasta_backups, agora)
    arquivo.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(arquivo, novo.encode("utf-8"))
    logger.info("configuracao_local: assistente gravada")
    return True


def _recusar_ambiente(variavel: str, rotulo: str, env: Mapping[str, str]) -> None:
    """Variável de ambiente vence o arquivo: gravar ou remover pelo site não teria efeito, então é recusado."""
    if _ambiente(variavel, env):
        raise ValueError(f"{rotulo}: definida por variável de ambiente; altere a variável, não o site.")


def gravar_assistente(arquivo_env: Path, pasta_backups: Path, chaves: Mapping[str, Optional[str]],
                      ambiente: Optional[Mapping[str, str]] = None,
                      agora: Callable[[], datetime] = datetime.now) -> None:
    """Grava as chaves de IA preenchidas no ``.env``. Em branco (ou ausente) mantém a atual; chave que vem de
    variável de ambiente é recusada e nada é gravado."""
    env = os.environ if ambiente is None else ambiente
    if any(identificador not in CHAVES_IA for identificador in chaves):
        raise ValueError("Chave de IA desconhecida.")
    alteracoes: dict[str, Optional[str]] = {}
    for identificador, (variavel, rotulo) in CHAVES_IA.items():
        valor = str(chaves.get(identificador) or "").strip()
        if not valor:
            continue
        _recusar_ambiente(variavel, rotulo, env)
        if (erro := validar_chave_ia(valor)):
            raise ValueError(f"{rotulo}: {erro}")
        alteracoes[variavel] = valor
    if alteracoes:
        _aplicar_env(Path(arquivo_env), Path(pasta_backups), alteracoes, agora())


def remover_chave_ia(arquivo_env: Path, pasta_backups: Path, identificador: str,
                     ambiente: Optional[Mapping[str, str]] = None,
                     agora: Callable[[], datetime] = datetime.now) -> None:
    """Remove a linha da chave do ``.env`` (sem a linha, nada a fazer). Sem backup: a cópia guardaria a chave removida."""
    if identificador not in CHAVES_IA:
        raise ValueError("Chave de IA desconhecida.")
    variavel, rotulo = CHAVES_IA[identificador]
    _recusar_ambiente(variavel, rotulo, os.environ if ambiente is None else ambiente)
    arquivo = Path(arquivo_env)
    if arquivo.exists():
        _aplicar_env(arquivo, Path(pasta_backups), {variavel: None}, agora(), com_backup=False)


# Assinatura do técnico nos PDFs dos Termos (``data/state/assinatura_tecnico.json``, seção opcional: vazia não deixa Pendente).
ESTILOS_ASSINATURA = ("desenho", "digitada", "great-vibes", "dancing-script", "allura", "alex-brush", "sacramento")
ASSINATURA_PADRAO = {"estilo": "desenho", "nome": ""}
LIMITE_NOME_ASSINATURA = 80
# Só as letras que as 6 fontes da assinatura cobrem (tests/e2e/assinatura-fontes.spec.cjs); espelho de LETRAS em
# frontend/src/componentes/assinatura-medida.ts. Outras letras (cirílico, hebraico, matemáticas) cairiam em fonte do sistema.
_MAIUSCULAS_ASSINATURA = "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÂÃÄÉÊËÍÎÓÔÕÖÚÛÜÇÑ"
LETRAS_ASSINATURA = frozenset(_MAIUSCULAS_ASSINATURA + _MAIUSCULAS_ASSINATURA.lower())


class AssinaturaInvalida(ValueError):
    """``codigo`` e ``detail`` são frases fixas: nunca repetem o nome recebido."""

    def __init__(self, codigo: str, detail: str) -> None:
        super().__init__(detail)
        self.codigo, self.detail = codigo, detail


def normalizar_nome_assinatura(valor: Any) -> str:
    if not isinstance(valor, str) or any(unicodedata.category(c) == "Cc" for c in valor):
        raise AssinaturaInvalida("assinatura_nome_invalido", "Nome da assinatura inválido.")
    nome = " ".join(unicodedata.normalize("NFC", valor).replace("’", "'").replace("‘", "'").split())
    if len(nome) > LIMITE_NOME_ASSINATURA or any(c not in LETRAS_ASSINATURA and c not in " .'-" for c in nome) \
            or (nome and not any(c in LETRAS_ASSINATURA for c in nome)):
        raise AssinaturaInvalida(
            "assinatura_nome_invalido",
            "Use até 80 caracteres: só letras, espaço, ponto, apóstrofo e hífen.",
        )
    return nome


def validar_assinatura(estilo: Any, nome: Any) -> dict:
    if estilo not in ESTILOS_ASSINATURA:
        raise AssinaturaInvalida("assinatura_estilo_invalido", "Estilo de assinatura inválido.")
    nome = normalizar_nome_assinatura(nome)
    if estilo != "desenho" and not nome:
        raise AssinaturaInvalida("assinatura_nome_invalido", "Informe o nome para esse estilo de assinatura.")
    return {"estilo": estilo, "nome": nome}


def ler_assinatura(arquivo: Path) -> dict:
    """Só arquivo ausente devolve o padrão (desenho). Ilegível ou inválido levanta ``assinatura_config_ilegivel``:
    nunca vira desenho, que sairia no PDF com o SVG de outra pessoa. O PUT seguinte grava por cima, com backup."""
    guardado, ilegivel = _ler_json(arquivo)
    if not ilegivel and not Path(arquivo).exists():
        return dict(ASSINATURA_PADRAO)
    try:
        if ilegivel:
            raise AssinaturaInvalida("", "")
        return validar_assinatura(guardado.get("estilo"), guardado.get("nome", ""))
    except AssinaturaInvalida:
        raise AssinaturaInvalida("assinatura_config_ilegivel", "A configuração da assinatura está ilegível. Salve de novo para substituí-la.") from None


def gravar_assinatura(arquivo: Path, pasta_backups: Path, estilo: Any, nome: Any,
                      agora: Callable[[], datetime] = datetime.now) -> dict:
    novo = validar_assinatura(estilo, nome)
    arquivo = Path(arquivo)
    _backup(arquivo, Path(pasta_backups), agora())
    atomic_write_json(arquivo, novo)
    logger.info("configuracao_local: assinatura_tecnico gravada")
    return novo
