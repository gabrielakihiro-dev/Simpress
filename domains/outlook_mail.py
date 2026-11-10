"""E-mails por modelo pelo Outlook (classic) na Home (F1): modelos locais, contatos do Entra e envio por COM.

Escrita externa (criar ou enviar e-mail no Outlook do usuário) só por clique explícito; escrita local só em
``data/state/outlook_email_modelos.json``. Nenhum log leva corpo, destinatários, nomes, nome de modelo ou termo
buscado: só modo, id da conta e código ou classe do erro.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import subprocess
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

from core.integrity import FileBusyError, FileTransactionError, atomic_write_json, lock_paths
from domains import entra_users
from domains.equipment_search import normalize_search_term
from domains.sebrae_observacoes import agora_iso

T = TypeVar("T")
logger = logging.getLogger(__name__)

SCRIPT_PS1 = Path(__file__).with_name("outlook_mail.ps1")
VAR_SEM_ENVIO = "SIMPRESS_OUTLOOK_SEM_ENVIO"
TIMEOUT_S = 60

CONTA_PADRAO = "sebrae"
# O front recebe as contas só pela API: o teste de privacidade proíbe estes domínios no HTML e no JS.
CONTAS_REMETENTE: dict[str, dict[str, str]] = {
    "sebrae": {"email": "gakihiro@pr.sebrae.com.br", "rotulo": "Sebrae"},
    "simpress": {"email": "gansouza@simpress.com.br", "rotulo": "Simpress"},
}
MARCADOR_NOME = "[Nome da pessoa]"
MARCADOR_SETOR = "[Setor]"

MAX_MODELOS = 50
LIMITES = {"nome": 80, "para": 1000, "cc": 1000, "assunto": 200, "corpo": 4000}
LIMITE_PESSOA = 200  # Nome da pessoa e Setor do envio (não salvos)
MAX_CONTATOS = 8
MAX_TOKENS = 50
PADRAO_ID = re.compile(r"^[a-z0-9_-]{1,40}$")
ROTULOS = {
    "nome": "Nome do modelo", "para": "Para", "cc": "Cc", "assunto": "Assunto", "corpo": "Mensagem",
    "nome_pessoa": "Nome da pessoa", "setor": "Setor",
}

# Textos aprovados (docs/planos/email-outlook-modelos.md); os códigos viajam junto no JSON.
MSG_ULTIMO_MODELO = "Mantenha ao menos um modelo."
MSG_NOME_DUPLICADO = "Já existe um modelo com esse nome."
MSG_CONTA_AUSENTE = "A conta {conta} não está configurada no Outlook. Escolha outra conta ou adicione-a no Outlook."
MSG_DESTINATARIO = "Alguns destinatários não foram reconhecidos no Outlook. Confira os nomes antes de enviar."
MSG_INDISPONIVEL = "Outlook (classic) indisponível. Abra o Outlook clássico e tente de novo."
MSG_FECHADO = "O Outlook (classic) não está aberto. Abra o Outlook e tente enviar de novo."
MSG_RECUSADO = "O Outlook recusou o envio e nada foi enviado. Confira os destinatários e tente de novo."
MSG_SEM_RESPOSTA = "O Outlook não respondeu e nada foi enviado. Tente de novo."
MSG_INCERTO = "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo."
MSG_ABRIR_DEMORA = (
    "O Outlook demorou a responder. A janela do e-mail pode aparecer em instantes; confira antes de tentar de novo."
)
MSG_MARCADOR = "Preencha o nome da pessoa e o setor antes de enviar."
MSG_OCUPADO = "Já há um e-mail sendo preparado. Aguarde."
MSG_SEM_ENVIO = "O envio real está desativado neste computador."
# Sem texto aprovado: mensagens técnicas, escolhidas aqui.
MSG_CONFIRMAR = "O envio exige confirmação."
MSG_MODELOS_ILEGIVEIS = (
    "O arquivo de modelos de e-mail está ilegível e foi preservado. Restaure uma cópia válida antes de alterar os modelos."
)
MSG_MODELOS_OCUPADOS = "O arquivo de modelos de e-mail está ocupado no momento. Tente novamente em instantes."
MSG_MODELOS_GRAVACAO = "Não foi possível gravar o modelo de e-mail. Nada foi alterado; tente de novo."
MSG_LIMITE = f"Limite de {MAX_MODELOS} modelos atingido. Exclua um modelo antes de criar outro."
MSG_SEM_PADRAO = "Só o Modelo 1 - Cabo tem texto padrão para restaurar."
MSG_MODELO_INEXISTENTE = "Modelo de e-mail não encontrado."
MSG_CONSULTA_CURTA = "Digite ao menos 2 caracteres para buscar."


class ErroOutlook(Exception):
    """Erro com status HTTP e código; o router o devolve como ``{detail, codigo}``."""

    def __init__(self, status: int, mensagem: str, *, codigo: str) -> None:
        super().__init__(mensagem)
        self.status = status
        self.codigo = codigo


# ---------------------------------------------------------------- validação


def _invalido(mensagem: str) -> ErroOutlook:
    return ErroOutlook(422, mensagem, codigo="campo_invalido")


def _texto(valor: Any, chave: str, maximo: int, *, permitidos: str = "") -> str:
    """Texto sem caractere de controle (exceto os de ``permitidos``) e dentro do limite."""
    rotulo = ROTULOS[chave]
    if not isinstance(valor, str):
        raise _invalido(f"O campo {rotulo} precisa ser um texto.")
    if any(unicodedata.category(c) == "Cc" and c not in permitidos for c in valor):
        raise _invalido(f"O campo {rotulo} não pode ter caracteres de controle.")
    if len(valor) > maximo:
        raise _invalido(f"O campo {rotulo} passa de {maximo} caracteres.")
    return valor


def _campo_modelo(chave: str, valor: Any) -> str:
    if chave == "conta":
        if not isinstance(valor, str) or valor not in CONTAS_REMETENTE:
            raise _invalido("Escolha uma conta remetente válida.")
        return valor
    if chave == "nome":
        nome = _texto(valor, "nome", LIMITES["nome"]).strip()
        if not nome:
            raise _invalido("Informe o nome do modelo.")
        return nome
    if chave in LIMITES:
        return _texto(valor, chave, LIMITES[chave], permitidos="\n\t" if chave == "corpo" else "")
    raise _invalido("Campo desconhecido.")


def _id_valido(modelo_id: Any) -> str:
    if not isinstance(modelo_id, str) or not PADRAO_ID.fullmatch(modelo_id):
        raise ErroOutlook(404, MSG_MODELO_INEXISTENTE, codigo="modelo_inexistente")
    return modelo_id


# ---------------------------------------------------------------- modelos

CORPO_CABO = "\n".join([
    "Allex, ",
    "Solicito a instalação de um cabo de segurança para o(a) {nome} - {setor}",
    "O cabo já está com o(a) colaborador(a).",
    "Qualquer dúvida estarei à disposição. ",
    "Att. Gabriel Akihiro",
])
ID_CABO = "cabo"
CAMPOS_PADRAO_CABO = {
    "conta": "sebrae",
    "para": "Allex Fernando Deretti;",
    "cc": "Fabio Neves; Robinson Luiz de Souza Kriki Silvestre;",
    "assunto": "Instalação do Cabo de Segurança",
    "corpo": CORPO_CABO,
}
def contas_publicas() -> list[dict[str, Any]]:
    return [
        {"id": chave, "email": dados["email"], "rotulo": dados["rotulo"], "padrao": chave == CONTA_PADRAO}
        for chave, dados in CONTAS_REMETENTE.items()
    ]


CAMPOS_MODELO = ("id", "nome", "conta", "para", "cc", "assunto", "corpo", "atualizado_em")


def semente_cabo() -> dict[str, str]:
    return {"id": ID_CABO, "nome": "Modelo 1 - Cabo", **CAMPOS_PADRAO_CABO, "atualizado_em": ""}


def _modelo_valido(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and all(isinstance(item.get(campo), str) for campo in CAMPOS_MODELO)
        and bool(PADRAO_ID.fullmatch(item["id"]))
        and item["conta"] in CONTAS_REMETENTE
    )


class ModelosEmail:
    """Modelos em um JSON local: leitura sem trava, escrita atômica sob trava de arquivo."""

    def __init__(self, arquivo: Path, agora: Callable[[], str] = agora_iso) -> None:
        self.arquivo = Path(arquivo)
        self._agora = agora

    def _carregar(self) -> list[dict[str, str]]:
        try:
            bruto = self.arquivo.read_text(encoding="utf-8")
        except FileNotFoundError:
            return [semente_cabo()]
        except (OSError, UnicodeDecodeError) as erro:
            raise ErroOutlook(503, MSG_MODELOS_ILEGIVEIS, codigo="modelos_ilegiveis") from erro
        try:
            dados = json.loads(bruto)
        except ValueError as erro:
            raise ErroOutlook(503, MSG_MODELOS_ILEGIVEIS, codigo="modelos_ilegiveis") from erro
        modelos = dados.get("modelos") if isinstance(dados, dict) else None
        if (
            not isinstance(dados, dict)
            or dados.get("version") != 1
            or not isinstance(modelos, list)
            or not modelos
            or not all(_modelo_valido(item) for item in modelos)
            or len({item["id"] for item in modelos}) != len(modelos)
        ):
            raise ErroOutlook(503, MSG_MODELOS_ILEGIVEIS, codigo="modelos_ilegiveis")
        return [{campo: item[campo] for campo in CAMPOS_MODELO} for item in modelos]

    def listar(self) -> list[dict[str, str]]:
        return self._carregar()

    def _transacao(self, acao: Callable[[list[dict[str, str]]], T]) -> T:
        """Lê, aplica ``acao`` e grava; qualquer falha deixa o arquivo como estava."""
        try:
            with lock_paths([self.arquivo]):
                modelos = self._carregar()
                resultado = acao(modelos)
                self.arquivo.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(self.arquivo, {"version": 1, "modelos": modelos})
                return resultado
        except FileBusyError as erro:
            raise ErroOutlook(503, MSG_MODELOS_OCUPADOS, codigo="modelos_ocupados") from erro
        except (OSError, FileTransactionError) as erro:
            raise ErroOutlook(503, MSG_MODELOS_GRAVACAO, codigo="modelos_gravacao") from erro

    @staticmethod
    def _achar(modelos: list[dict[str, str]], modelo_id: Any) -> dict[str, str]:
        for modelo in modelos:
            if modelo["id"] == _id_valido(modelo_id):
                return modelo
        raise ErroOutlook(404, MSG_MODELO_INEXISTENTE, codigo="modelo_inexistente")

    @staticmethod
    def _nome_em_uso(modelos: list[dict[str, str]], nome: str, ignorar: Optional[str] = None) -> bool:
        return any(m["nome"].casefold() == nome.casefold() for m in modelos if m["id"] != ignorar)

    def _nome_livre(self, modelos: list[dict[str, str]], base: str, sufixo: str = "") -> str:
        for numero in range(1, MAX_MODELOS + 2):
            fim = f"{sufixo}{'' if numero == 1 else f' {numero}'}"
            candidato = f"{base[: LIMITES['nome'] - len(fim)]}{fim}"
            if not self._nome_em_uso(modelos, candidato):
                return candidato
        raise ErroOutlook(422, MSG_LIMITE, codigo="limite_modelos")  # inalcançável com o limite de 50 modelos

    def criar(self, nome: Any = None, copiar_de: Any = None) -> dict[str, str]:
        nome_pedido = None if nome is None or (isinstance(nome, str) and not nome.strip()) else _campo_modelo("nome", nome)

        def acao(modelos: list[dict[str, str]]) -> dict[str, str]:
            if len(modelos) >= MAX_MODELOS:
                raise ErroOutlook(422, MSG_LIMITE, codigo="limite_modelos")
            if copiar_de is not None:
                origem = self._achar(modelos, copiar_de)
                base = {campo: origem[campo] for campo in ("conta", "para", "cc", "assunto", "corpo")}
                padrao = self._nome_livre(modelos, origem["nome"], " (cópia)")
            else:
                base = {"conta": CONTA_PADRAO, "para": "", "cc": "", "assunto": "", "corpo": ""}
                padrao = self._nome_livre(modelos, "Novo modelo")
            if nome_pedido is not None and self._nome_em_uso(modelos, nome_pedido):
                raise ErroOutlook(422, MSG_NOME_DUPLICADO, codigo="nome_duplicado")
            ids = {m["id"] for m in modelos}
            novo_id = secrets.token_hex(6)
            while novo_id in ids:
                novo_id = secrets.token_hex(6)
            modelo = {"id": novo_id, "nome": nome_pedido or padrao, **base, "atualizado_em": self._agora()}
            modelos.append(modelo)
            return dict(modelo)

        return self._transacao(acao)

    def atualizar(self, modelo_id: Any, campos: dict[str, Any]) -> dict[str, str]:
        novos = {chave: _campo_modelo(chave, valor) for chave, valor in campos.items()}
        if not novos:
            return dict(self._achar(self._carregar(), modelo_id))

        def acao(modelos: list[dict[str, str]]) -> dict[str, str]:
            modelo = self._achar(modelos, modelo_id)
            if "nome" in novos and self._nome_em_uso(modelos, novos["nome"], ignorar=modelo["id"]):
                raise ErroOutlook(422, MSG_NOME_DUPLICADO, codigo="nome_duplicado")
            modelo.update(novos)
            modelo["atualizado_em"] = self._agora()
            return dict(modelo)

        return self._transacao(acao)

    def excluir(self, modelo_id: Any) -> None:
        def acao(modelos: list[dict[str, str]]) -> None:
            modelo = self._achar(modelos, modelo_id)
            if len(modelos) <= 1:
                raise ErroOutlook(422, MSG_ULTIMO_MODELO, codigo="ultimo_modelo")
            modelos.remove(modelo)

        self._transacao(acao)

    def restaurar(self, modelo_id: Any) -> dict[str, str]:
        def acao(modelos: list[dict[str, str]]) -> dict[str, str]:
            modelo = self._achar(modelos, modelo_id)
            if modelo["id"] != ID_CABO:
                raise ErroOutlook(422, MSG_SEM_PADRAO, codigo="sem_padrao")
            modelo.update(CAMPOS_PADRAO_CABO)  # o nome fica
            modelo["atualizado_em"] = self._agora()
            return dict(modelo)

        return self._transacao(acao)


# ---------------------------------------------------------------- contatos (base do Entra)


def _normalizar(valor: str) -> str:
    return " ".join(normalize_search_term(valor).split())


def _palavras(valor: str) -> frozenset[str]:
    return frozenset(p for p in re.split(r"\W+", valor) if p)


@dataclass(frozen=True)
class Pessoa:
    nome: str
    email: str
    nome_n: str
    chave_n: str
    palavras: frozenset[str]

    def como_dict(self) -> dict[str, str]:
        return {"nome": self.nome, "email": self.email}


class Diretorio:
    """Pessoas da base do Entra já importada (só leitura de ``entra_users``)."""

    def __init__(self, arquivo: Path) -> None:
        self.arquivo = Path(arquivo)

    def pessoas(self) -> list[Pessoa]:
        try:
            usuarios = entra_users.read_directory(self.arquivo)["users"]
        except (OSError, ValueError) as erro:
            logger.warning("Base do Entra ilegível no autocompletar: %s", type(erro).__name__)
            return []
        pessoas = []
        for chave, nome in usuarios.items():
            if not isinstance(chave, str) or not isinstance(nome, str) or not chave or not nome.strip():
                continue
            # Máquinas ($) e convidados (#EXT#) nunca são destinatários.
            if chave.endswith("$") or "#ext#" in chave.casefold() or "#ext#" in nome.casefold():
                continue
            nome_n = _normalizar(nome)
            pessoas.append(Pessoa(
                nome.strip(), f"{chave}@{entra_users.DOMAIN}", nome_n, chave.upper(), _palavras(nome_n),
            ))
        return pessoas

    def resumo(self) -> dict[str, Any]:
        total = len(self.pessoas())
        return {"disponivel": total > 0, "total": total}

    def buscar(self, termo: Any) -> list[dict[str, str]]:
        consulta = _normalizar(termo) if isinstance(termo, str) else ""
        if len(consulta) < 2:
            raise ErroOutlook(422, MSG_CONSULTA_CURTA, codigo="consulta_curta")
        consulta = consulta[:100]
        inicio_de_palavra = re.compile(r"(?<!\w)" + re.escape(consulta))
        achados: list[tuple[int, str, str, Pessoa]] = []
        for pessoa in self.pessoas():
            if inicio_de_palavra.search(pessoa.nome_n) or pessoa.chave_n.startswith(consulta):
                achados.append((0, pessoa.nome_n, pessoa.email, pessoa))
            elif consulta in pessoa.nome_n or consulta in pessoa.chave_n:
                achados.append((1, pessoa.nome_n, pessoa.email, pessoa))
        achados.sort(key=lambda item: item[:3])
        return [item[3].como_dict() for item in achados[:MAX_CONTATOS]]

    def resolver(self, tokens: Any) -> list[dict[str, Any]]:
        if not isinstance(tokens, list) or len(tokens) > MAX_TOKENS or not all(
            isinstance(t, str) and len(t) <= LIMITE_PESSOA for t in tokens
        ):
            raise _invalido(f"Envie até {MAX_TOKENS} nomes de até {LIMITE_PESSOA} caracteres.")
        pessoas = self.pessoas() if any("@" not in t for t in tokens) else []
        return [self._resolver_um(token, pessoas) for token in tokens]

    @staticmethod
    def _resolver_um(token: str, pessoas: list[Pessoa]) -> dict[str, Any]:
        texto = token.strip()
        if "@" in texto:
            return {"token": token, "status": "unico", "email": texto}
        alvo = _normalizar(texto)
        # Nome igual ao digitado vale mais que nomes que só contêm as palavras:
        # "Fabio Neves" é uma pessoa, mesmo havendo "Fabio Neves Silva". Dois nomes idênticos continuam ambíguos.
        exatos = [p for p in pessoas if alvo and p.nome_n == alvo]
        candidatos = exatos
        if not exatos and len(alvo) >= 2:
            palavras = _palavras(alvo)
            candidatos = sorted((p for p in pessoas if palavras <= p.palavras), key=lambda p: (p.nome_n, p.email))
        if not candidatos:
            return {"token": token, "status": "nenhum"}
        if len(candidatos) == 1:
            return {"token": token, "status": "unico", **candidatos[0].como_dict()}
        return {"token": token, "status": "ambiguo", "opcoes": [p.como_dict() for p in candidatos[:MAX_CONTATOS]]}


# ---------------------------------------------------------------- envio pelo Outlook (PowerShell 5.1 + COM)

Executor = Callable[..., "subprocess.CompletedProcess[bytes]"]


@dataclass(frozen=True)
class SaidaPowerShell:
    linhas: tuple[str, ...]
    expirou: bool

    @property
    def antes_send(self) -> bool:
        return "PASSO:antes_send" in self.linhas

    def valor(self, prefixo: str) -> Optional[str]:
        return next((linha[len(prefixo):] for linha in reversed(self.linhas) if linha.startswith(prefixo)), None)


def _decodificar(valor: Any) -> str:
    if isinstance(valor, bytes):
        return valor.decode("utf-8-sig", errors="replace")
    return valor if isinstance(valor, str) else ""


def _linhas(saida: str) -> tuple[str, ...]:
    return tuple(linha.strip() for linha in saida.splitlines() if linha.strip())


def _substituir(texto: str, valores: dict[str, str]) -> str:
    """Uma só passada: um nome que contenha ``{setor}`` não é substituído de novo."""
    return re.sub(r"\{(nome|setor)\}", lambda achado: valores[achado.group(1)], texto)


def envio_desativado() -> bool:
    """Lido a cada pedido: com SIMPRESS_OUTLOOK_SEM_ENVIO=1 o envio real é recusado; o ``abrir`` continua."""
    return os.environ.get(VAR_SEM_ENVIO, "").strip().lower() in ("1", "true", "sim", "yes")


class EmailOutlook:
    """Valida o pedido e o entrega ao script fixo ``outlook_mail.ps1``; uma preparação por vez."""

    def __init__(self, *, executar: Executor = subprocess.run, script: Path = SCRIPT_PS1) -> None:
        self._executar = executar
        self._script = Path(script)
        self._trava = threading.Lock()

    def _validar(self, dados: dict[str, Any]) -> dict[str, str]:
        modo = dados.get("modo")
        if modo not in ("abrir", "enviar"):
            raise _invalido("Informe o modo: abrir ou enviar.")
        conta = dados.get("conta")
        if not isinstance(conta, str) or conta not in CONTAS_REMETENTE:
            raise ErroOutlook(
                422, MSG_CONTA_AUSENTE.format(conta=str(conta)[:80]), codigo="conta_ausente",
            )
        campos = {
            "para": _texto(dados.get("para") or "", "para", LIMITES["para"]),
            "cc": _texto(dados.get("cc") or "", "cc", LIMITES["cc"]),
            "assunto": _texto(dados.get("assunto") or "", "assunto", LIMITES["assunto"]),
            "corpo": _texto(dados.get("corpo") or "", "corpo", LIMITES["corpo"], permitidos="\n\t"),
            "nome_pessoa": _texto(dados.get("nome") or "", "nome_pessoa", LIMITE_PESSOA).strip(),
            "setor": _texto(dados.get("setor") or "", "setor", LIMITE_PESSOA).strip(),
        }
        if modo == "enviar" and not campos["para"].replace(";", "").strip():
            raise _invalido("Informe o destinatário no campo Para.")
        return {"modo": modo, "conta": conta, **campos}

    def _chamar(self, pedido: dict[str, str]) -> SaidaPowerShell:
        comando = [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(self._script.resolve()),
        ]
        # Dados só por stdin, em UTF-8 de verdade (ensure_ascii=False); nada vai nos argumentos nem no texto do script.
        opcoes: dict[str, Any] = {
            "input": json.dumps(pedido, ensure_ascii=False).encode("utf-8"),
            "capture_output": True,
            "timeout": TIMEOUT_S,
        }
        if os.name == "nt":
            opcoes["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            processo = self._executar(comando, **opcoes)
        except subprocess.TimeoutExpired as expirou:
            return SaidaPowerShell(_linhas(_decodificar(expirou.stdout)), expirou=True)
        except OSError as erro:  # sem powershell.exe (sistema não Windows) ou falha ao iniciar
            raise ErroOutlook(503, MSG_INDISPONIVEL, codigo="outlook_indisponivel") from erro
        return SaidaPowerShell(_linhas(_decodificar(processo.stdout)), expirou=False)

    def _interpretar(self, modo: str, conta: str, saida: SaidaPowerShell) -> dict[str, Any]:
        erro = saida.valor("ERRO:")
        ok = saida.valor("OK:")
        if ok == ("aberto" if modo == "abrir" else "enviado") and erro is None:
            resposta: dict[str, Any] = {"status": ok, "conta": conta}
            if saida.valor("AVISO:") == "destinatario_nao_resolvido":
                resposta["aviso"] = MSG_DESTINATARIO
            return resposta
        if erro is not None:
            return self._mapear_erro(erro, conta, saida)
        # Sem OK nem ERRO: o script expirou, caiu ou não respondeu direito.
        if modo == "abrir":
            if saida.expirou:
                return {"status": "aberto", "conta": conta, "aviso": MSG_ABRIR_DEMORA}
            raise ErroOutlook(503, MSG_INDISPONIVEL, codigo="outlook_indisponivel")
        if saida.antes_send:
            return {"status": "incerto", "conta": conta, "aviso": MSG_INCERTO}
        if saida.expirou:
            raise ErroOutlook(504, MSG_SEM_RESPOSTA, codigo="outlook_sem_resposta")
        raise ErroOutlook(503, MSG_INDISPONIVEL, codigo="outlook_indisponivel")

    @staticmethod
    def _mapear_erro(codigo: str, conta: str, saida: SaidaPowerShell) -> dict[str, Any]:
        if saida.antes_send and codigo != "envio_recusado":
            # Depois do marcador só o ``envio_recusado`` prova que nada foi enviado.
            return {"status": "incerto", "conta": conta, "aviso": MSG_INCERTO}
        if codigo == "conta_ausente":
            email = CONTAS_REMETENTE[conta]["email"]
            raise ErroOutlook(422, MSG_CONTA_AUSENTE.format(conta=email), codigo="conta_ausente")
        if codigo == "destinatario_nao_resolvido":
            raise ErroOutlook(422, MSG_DESTINATARIO, codigo="destinatario_nao_resolvido")
        if codigo == "outlook_fechado":
            raise ErroOutlook(503, MSG_FECHADO, codigo="outlook_fechado")
        if codigo == "envio_recusado":
            raise ErroOutlook(502, MSG_RECUSADO, codigo="envio_recusado")
        raise ErroOutlook(503, MSG_INDISPONIVEL, codigo="outlook_indisponivel")

    def processar(self, dados: dict[str, Any]) -> dict[str, Any]:
        # O log só leva ids conhecidos: valor livre vindo do pedido nunca entra nele.
        modo = dados.get("modo") if dados.get("modo") in ("abrir", "enviar") else "invalido"
        conta = dados.get("conta") if isinstance(dados.get("conta"), str) and dados["conta"] in CONTAS_REMETENTE else "desconhecida"
        try:
            resposta = self._processar(dados)
        except ErroOutlook as erro:
            logger.warning("Outlook e-mail: modo=%s conta=%s codigo=%s", modo, conta, erro.codigo)
            raise
        logger.info("Outlook e-mail: modo=%s conta=%s status=%s", modo, conta, resposta["status"])
        return resposta

    def _processar(self, dados: dict[str, Any]) -> dict[str, Any]:
        pedido = self._validar(dados)
        modo, conta = pedido["modo"], pedido["conta"]
        valores = {"nome": pedido.pop("nome_pessoa") or MARCADOR_NOME, "setor": pedido.pop("setor") or MARCADOR_SETOR}
        pedido["assunto"] = _substituir(pedido["assunto"], valores)
        pedido["corpo"] = _substituir(pedido["corpo"], valores)
        if modo == "enviar":
            if dados.get("confirmado") is not True:
                raise ErroOutlook(422, MSG_CONFIRMAR, codigo="confirmacao_necessaria")
            if envio_desativado():
                raise ErroOutlook(422, MSG_SEM_ENVIO, codigo="envio_desativado")
            # No abrir o marcador é aceito (o usuário edita no Outlook); no enviar ele bloqueia.
            if any(m in pedido[campo] for m in (MARCADOR_NOME, MARCADOR_SETOR) for campo in ("assunto", "corpo")):
                raise ErroOutlook(422, MSG_MARCADOR, codigo="marcador_pendente")
        if not self._trava.acquire(blocking=False):
            raise ErroOutlook(409, MSG_OCUPADO, codigo="ocupado")
        try:
            saida = self._chamar({
                "modo": modo, "conta_email": CONTAS_REMETENTE[conta]["email"],
                "para": pedido["para"], "cc": pedido["cc"], "assunto": pedido["assunto"], "corpo": pedido["corpo"],
            })
        finally:
            self._trava.release()
        return self._interpretar(modo, conta, saida)
