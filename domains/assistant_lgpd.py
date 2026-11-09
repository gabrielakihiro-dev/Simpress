"""Reversible masking of personal data between the assistant and the language model (LGPD).

Sensitive values (logged user, nickname, names) become markers such as `[PESSOA_1]` before
anything is sent to OpenRouter. The marker map lives only in process memory and is never
written to disk. Markers go back to the real value in tool arguments and in the text shown
on screen. CPF numbers are always replaced by a fixed mask, never by a marker.

First name visible (user request of 08/11/2026): a person's name made of 2+ plain words, found under a
person-name key or in the Simpress base, is shown as its first name plus a marker for the whole name
("Marina Beatriz Teixeira da Costa" -> "Marina [PESSOA_3]"), so the user can say "the ticket of Marina" and the
model can follow. Logins, DOMAIN-slash-user pairs, e-mails, nicknames, computer names and one-word names keep the full
mask (the one-word rule is what protects `usuario`, which often holds a login). The first name alone never becomes
a marker, so a lone "Marina" in free text stays as it is; the other parts of 4+ letters do. When a first name equals
a one-word value already masked (a login, another person's surname) the whole name stays masked, whatever the order
the values were seen in; text already sent keeps what it showed. The web search uses the full mask
(`completo=True`): a first name must not reach an outside search engine.
"""

import re
import unicodedata
from typing import Any, Dict, List, Set, Tuple

EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# Phone numbers need a DDD, +55 or a hyphen so that ticket numbers (e.g. 12345678) stay intact.
PHONE_PATTERN = re.compile(
    r"(?<![\w-])(?:"
    r"(?:\+55\s?)?\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}"
    r"|(?:\+55\s?)?\d{2}\s9?\d{4}[-\s]?\d{4}"
    r"|9?\d{4}-\d{4}"
    r")(?![\w-])"
)
TOKEN_PATTERN = re.compile(r"\[PESSOA_\d+\]")
# A formatted CPF is always masked; 11 loose digits only when the check digits match.
CPF_FORMATADO_PATTERN = re.compile(r"(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)")
CPF_SOLTO_PATTERN = re.compile(r"(?<![\w-])\d{11}(?![\w-])")
SENHA_PATTERN = re.compile(
    r"\b(senha|password|passwd|pwd)\b"
    r"(?:[ \t]+(?:atual|nova|antiga|tempor[aá]ria|padr[aã]o|fict[ií]cia|de[ \t]+(?:acesso|teste))\b)?"
    r"(?P<separador>"
    r"(?:[ \t]+(?:é|eh|foi(?:[ \t]+alterada[ \t]+para)?|ser[aá])\b)?[ \t]*[:=-][ \t]*"
    r"|(?P<verbal>[ \t]+(?:é|eh|(?P<atribuicao>foi[ \t]+alterada[ \t]+para)|foi|ser[aá])\b[ \t]*"
    r")|(?P<conjuncao>[ \t]+e[ \t]+)"
    r"|[ \t]*(?=[\r\n]|$)"
    r"|(?P<sem_separador>[ \t]+))(?P<valor>[^\r\n]*)",
    re.IGNORECASE,
)
CPF_MASCARA = "***.***.***-**"
DADO_OMITIDO = "[DADO SENSÍVEL OMITIDO]"

# Keys whose value identifies a person or was chosen by one.
CHAVES_SENSIVEIS = frozenset({
    "ultimo_logon",
    "usuario_logado", "usuarios_logados", "usuario_manual", "usuario", "apelido",
    "nome", "nome_pessoa", "solicitante", "responsavel", "login", "email",
    "entrega_contato", "retirada_contato", "retirada_telefone",
    "usuario_anterior", "usuario_novo", "nome_pessoa_anterior", "nome_pessoa_novo",
    "apelido_manual", "apelido_anterior", "apelido_novo",
    "apelido_na_simpress", "apelido_no_endpoint",
    "apelido_equipamentos_detalhes", "apelido_invall", "computador",
})
# Free text written by people, where a known name can appear in the middle of a sentence.
CHAVES_TEXTO_LIVRE = frozenset({
    "anotacao", "descricao", "observacao", "motivo", "detalhes", "comentario", "mensagem", "erro",
    "texto_pagina", "rotulo", "titulo", "texto_anexo", "nome_arquivo", "texto", "esqueleto",
})
# Keys holding a person's name: each word of the name also becomes a marker ("o Bruno" inside a text).
CHAVES_NOME_PESSOA = frozenset({
    "ultimo_logon",
    "nome", "nome_pessoa", "solicitante", "responsavel", "usuario_logado", "usuarios_logados", "usuario_manual",
    "usuario", "usuario_anterior", "usuario_novo", "nome_pessoa_anterior", "nome_pessoa_novo",
})
PARTICULAS_NOME = frozenset({"de", "da", "do", "das", "dos", "e"})
# A name shown with its first name: only letters separated by spaces (no dot, hyphen, backslash or @).
_NOME_COMPOSTO = re.compile(r"[^\W\d_]+(?:\s+[^\W\d_]+)+")
# "<word> <marker>": when the word is the first name of that marker, `restaurar` restores both as one name.
# Entre os dois: espaços, ênfase de fechamento ("**Marina** [PESSOA_1]", grupo `fecho`), quebra de linha ou parêntese
# de abertura ("Marina ([PESSOA_1])", grupo `abre`, que exige o parêntese de fechamento logo após o marcador).
_NOME_E_MARCADOR = re.compile(
    r"(?:(?<![^\W_])(?P<antes>[^\W\d_]+)"
    r"(?P<espaco>[ \t]+|(?P<fecho>\*{1,3}|_{1,3})[ \t]*|[ \t]*\r?\n[ \t]*|[ \t]*(?P<abre>\()[ \t]*)"
    r")?(?P<marcador>\[PESSOA_\d+\])(?(abre)[ \t]*\))"
)
# Solicitantes de sistema (não são pessoas): ficam fora da base de nomes e da máscara. Comparação sem caixa e sem acento.
SOLICITANTES_SISTEMA = frozenset({"api sebrae"})
# Stands for a first name left alone in the full mask; it is not a marker (nothing restores it).
PRIMEIRO_NOME_OMITIDO = "[PESSOA]"
SEM_USUARIO = "Sem usuário registrado"
MIN_NOME_BASE = 3
MIN_PARTE_NOME = 4  # a loose "Ana" or "Li" would replace pieces of other words


def e_solicitante_sistema(valor: Any) -> bool:
    sem_acento = unicodedata.normalize("NFKD", str(valor or "")).encode("ascii", "ignore").decode()
    return " ".join(sem_acento.casefold().split()) in SOLICITANTES_SISTEMA


def _cpf_valido(digitos: str) -> bool:
    if len(set(digitos)) == 1:
        return False
    for tamanho in (9, 10):
        soma = sum(int(d) * (tamanho + 1 - i) for i, d in enumerate(digitos[:tamanho]))
        if int(digitos[tamanho]) != (soma * 10 % 11) % 10:
            return False
    return True


def _parece_credencial(valor: str, *, campo: bool) -> bool:
    """Conservative first-token check; a lone word after a label can be a password."""
    token = valor.split(maxsplit=1)[0] if valor.strip() else ""
    if token.casefold() == "2fa":
        return False
    return (
        (any(c.isalpha() for c in token) and any(c.isdigit() for c in token))
        or (token.isdecimal() and len(token) >= 6)
        or (len(token) >= 7 and token.isalpha() and token.isupper())
        or (len(token) >= 6 and token.isalpha() and not token.islower() and not token.isupper())
        or (campo and token.isalpha() and valor.strip() == token)
        # Ordinary sentence endings alone are not a credential signal.
        or any(not c.isalnum() for c in token.rstrip("?.,;:"))
    )


def omitir_senhas(texto: Any) -> str:
    linhas = []
    valor_pendente = False
    for linha in str(texto or "").splitlines(keepends=True):
        if valor_pendente and linha.strip():
            linhas.append(DADO_OMITIDO + linha[len(linha.rstrip("\r\n")):])
            valor_pendente = False
            continue
        partes: List[str] = []
        copiado = 0
        achado = SENHA_PATTERN.search(linha)
        while achado is not None:
            valor = achado["valor"]
            inicio = achado.start("valor")
            if valor.startswith(DADO_OMITIDO):
                achado = SENHA_PATTERN.search(linha, inicio + len(DADO_OMITIDO))
                continue
            inferido = achado["sem_separador"] is not None
            # Passive completion describes an action, unlike an explicit password assignment.
            descricao = achado["verbal"] is not None and achado["verbal"].strip().casefold() == "foi" and bool(re.fullmatch(r"alterada(?:[ \t]+com[ \t]+sucesso)?[.!?]?", valor.strip(), re.IGNORECASE))
            contexto = None
            if achado["conjuncao"] is not None:
                # shortcut: terminal "para acesso" is context; mask its prefix only when it signals a credential.
                contexto = re.search(r"[ \t]+para[ \t]+acesso[.!?]?$", valor, re.IGNORECASE)
                candidato = valor[:contexto.start()] if contexto is not None else valor
                descricao = not (
                    _parece_credencial(candidato, campo=contexto is not None)
                    or (candidato.strip().isalpha() and candidato.strip().islower())
                    or (contexto is not None and re.fullmatch(r"frase[ \t]+secreta", candidato, re.IGNORECASE))
                )
            if descricao or (inferido and valor.strip() and not _parece_credencial(valor, campo=True)):
                achado = SENHA_PATTERN.search(linha, inicio)
                continue
            valor_pendente = not achado["valor"].strip()
            if valor_pendente:
                break
            fim = achado.end()
            if contexto is not None:
                fim = inicio + contexto.start()
            partes.extend((linha[copiado:inicio], DADO_OMITIDO))
            copiado = fim
            achado = SENHA_PATTERN.search(linha, fim)
        partes.append(linha[copiado:])
        linhas.append("".join(partes))
    return "".join(linhas)


def limpar_texto_sensivel(texto: Any) -> str:
    """Remove passwords, CPFs, e-mails and phones from free text (CPF before phone)."""
    if not texto:
        return ""
    limpo = omitir_senhas(texto)
    limpo = CPF_FORMATADO_PATTERN.sub(CPF_MASCARA, limpo)
    limpo = CPF_SOLTO_PATTERN.sub(lambda m: CPF_MASCARA if _cpf_valido(m.group(0)) else m.group(0), limpo)
    limpo = EMAIL_PATTERN.sub("[E-MAIL OCULTADO]", limpo)
    return PHONE_PATTERN.sub("[TELEFONE OCULTADO]", limpo).strip()


class Mascara:
    """Swaps sensitive values for markers and undoes the swap when needed."""

    def __init__(self) -> None:
        self._por_valor: Dict[str, str] = {}
        self._por_marcador: Dict[str, str] = {}
        self._base: List[str] = []
        # Marker -> first name, as written, of a plain multi-word name that may be shown ("Marina").
        self._primeiro: Dict[str, str] = {}
        # Casefolded one-word values already masked (logins, name parts): a first name equal to one stays hidden.
        self._unicos: Set[str] = set()
        # Search expression and replacements, one pair per mode (`completo` False/True); empty after any new value.
        self._busca: Dict[bool, Tuple["re.Pattern[str]", Dict[str, str]]] = {}

    def _marcador(self, valor: str) -> str:
        chave = valor.strip()
        if chave not in self._por_valor:
            marcador = f"[PESSOA_{len(self._por_valor) + 1}]"
            self._por_valor[chave] = marcador
            self._por_marcador[marcador] = chave
            if not re.search(r"\s", chave):
                self._unicos.add(chave.casefold())
            self._busca = {}
        return self._por_valor[chave]

    def _primeiro_nome(self, marcador: str, nome: str) -> str:
        """Remember the first name of a plain multi-word name. Returns it, or "" when the whole name stays masked."""
        if _NOME_COMPOSTO.fullmatch(nome):
            primeiro = nome.split(maxsplit=1)[0]
            if primeiro.casefold() not in PARTICULAS_NOME:
                if marcador not in self._primeiro:
                    self._primeiro[marcador] = primeiro
                    self._busca = {}
                return primeiro
        return ""

    def _exibir(self, marcador: str, primeiro: str = "") -> str:
        """The marker alone, or "first name + marker" when that first name may be shown."""
        visivel = self._primeiro.get(marcador)
        if visivel is None or visivel.casefold() in self._unicos:
            return marcador
        return f"{primeiro or visivel} {marcador}"

    def _primeiro_do_marcador(self, achado: "re.Match[str]") -> bool:
        """True when the word in front of the marker is the first name of that very marker."""
        antes = achado["antes"]
        return bool(antes) and antes.casefold() == self._primeiro.get(achado["marcador"], "").casefold()

    def _sem_primeiro_nome(self, achado: "re.Match[str]") -> str:
        """Drop the visible first name in front of its own marker ("Ana [PESSOA_1]" -> "[PESSOA_1]"), any length."""
        if self._primeiro_do_marcador(achado):
            return achado["marcador"] + (achado["fecho"] or "")
        return achado.group(0)

    def _par_normal(self, achado: "re.Match[str]") -> str:
        """Como `_sem_primeiro_nome`, mas só quando esse primeiro nome precisa ficar oculto (um valor de uma palavra igual a ele é conhecido)."""
        if self._primeiro_do_marcador(achado) and self._primeiro[achado["marcador"]].casefold() in self._unicos:
            return achado["marcador"] + (achado["fecho"] or "")
        return achado.group(0)

    def registrar_base(self, nomes: List[str]) -> None:
        """Names from the Simpress base: become markers at once and survive `limpar()`."""
        # Names of 1-2 letters ("TI") would replace common pieces of text.
        self._base = [
            n.strip() for n in nomes
            if len(n.strip()) >= MIN_NOME_BASE and n.strip() != SEM_USUARIO and not e_solicitante_sistema(n)
        ]
        for nome in self._base:
            self._primeiro_nome(self._marcador(nome), nome)

    def mascarar(self, obj: Any, chave: str = "") -> Any:
        """Return a copy of `obj` with sensitive values replaced by markers.

        All sensitive values are registered first, so a note that quotes a name is masked
        even when it comes before the user field.
        """
        self._registrar(obj, chave)
        return self._trocar(obj, chave)

    def _registrar(self, obj: Any, chave: str = "") -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                self._registrar(v, str(k).lower())
        elif isinstance(obj, (list, tuple)):
            for v in obj:
                self._registrar(v, chave)
        elif isinstance(obj, str) and chave in CHAVES_SENSIVEIS and obj.strip() and obj != SEM_USUARIO and not e_solicitante_sistema(obj):
            marcador = self._marcador(obj)
            if chave in CHAVES_NOME_PESSOA:
                partes = re.findall(r"[^\W\d_]+", obj)
                # A first name that may be shown never becomes a marker by itself.
                if self._primeiro_nome(marcador, obj.strip()):
                    partes = partes[1:]
                for parte in partes:
                    if len(parte) >= MIN_PARTE_NOME and parte.casefold() not in PARTICULAS_NOME:
                        self._marcador(parte)

    def _trocar(self, obj: Any, chave: str) -> Any:
        if isinstance(obj, dict):
            return {k: self._trocar(v, str(k).lower()) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._trocar(v, chave) for v in obj]
        if isinstance(obj, str):
            if chave in CHAVES_SENSIVEIS and obj.strip() and obj != SEM_USUARIO and not e_solicitante_sistema(obj):
                marcador = self._marcador(obj)
                return self._exibir(marcador) if chave in CHAVES_NOME_PESSOA else marcador
            limpo = limpar_texto_sensivel(obj)
            return self.ocultar_conhecidos(limpo) if chave in CHAVES_TEXTO_LIVRE else limpo
        return obj

    def ocultar_conhecidos(self, texto: str, completo: bool = False) -> str:
        """Replace already known values found in the text (whole words only).

        A known name that may be shown comes back as "first name + marker", with the first name as written in the
        text. With `completo=True` nothing is shown: the whole name becomes its marker, a first name in front of its own
        marker is dropped (any length) and a lone first name of any length becomes PRIMEIRO_NOME_OMITIDO (for what
        leaves the computer, like the web search and the disk history). In the normal mode a first name in front of
        its own marker is also dropped when a one-word value equal to it is known, so it is never masked twice.

        shortcut: only names already seen in this conversation are recognised; a name never
        queried, typed or quoted stays as it is. Upgrade by loading the full people list.
        """
        if not self._por_valor:
            return texto
        texto = _NOME_E_MARCADOR.sub(self._sem_primeiro_nome if completo else self._par_normal, texto)
        busca = self._busca.get(completo)
        if busca is None:
            # One expression (the base may hold thousands of names); longest first: "Maria Souza" before "Maria".
            valores = set(self._por_valor)
            if completo:
                valores.update(self._primeiro.values())
            padrao = r"(?<!\w)(?:" + "|".join(re.escape(v) for v in sorted(valores, key=len, reverse=True)) + r")(?!\w)"
            busca = self._busca[completo] = (
                re.compile(padrao, re.IGNORECASE), {v.casefold(): m for v, m in self._por_valor.items()},
            )
        padrao_busca, por_valor = busca

        def trocar(achado: "re.Match[str]") -> str:
            trecho = achado.group(0)
            marcador = por_valor.get(trecho.casefold())
            if marcador is None:
                return PRIMEIRO_NOME_OMITIDO if completo else trecho
            return marcador if completo else self._exibir(marcador, trecho.split(maxsplit=1)[0])

        return padrao_busca.sub(trocar, texto)

    def restaurar(self, obj: Any) -> Any:
        """Swap known markers for the real value, in text, dict or list.

        "Marina [PESSOA_3]" and a lone "[PESSOA_3]" both give the whole name once, never "Marina Marina ...".
        """
        if isinstance(obj, dict):
            return {k: self.restaurar(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self.restaurar(v) for v in obj]
        if isinstance(obj, str):
            return _NOME_E_MARCADOR.sub(self._restaurar_trecho, obj)
        return obj

    def _restaurar_trecho(self, achado: "re.Match[str]") -> str:
        marcador = achado["marcador"]
        valor = self._por_marcador.get(marcador, marcador)
        if achado["antes"] is None:
            return valor
        if self._primeiro_do_marcador(achado) and valor != marcador:
            return valor + (achado["fecho"] or "")
        return achado.group(0).replace(marcador, valor, 1)

    @staticmethod
    def tem_marcador(obj: Any) -> bool:
        """True when a marker without a real value is left (invented by the model)."""
        if isinstance(obj, dict):
            return any(Mascara.tem_marcador(v) for v in obj.values())
        if isinstance(obj, (list, tuple)):
            return any(Mascara.tem_marcador(v) for v in obj)
        return isinstance(obj, str) and bool(TOKEN_PATTERN.search(obj))

    def limpar(self) -> None:
        self._por_valor.clear()
        self._por_marcador.clear()
        self._primeiro.clear()
        self._unicos.clear()
        self._busca = {}
        for nome in self._base:
            self._primeiro_nome(self._marcador(nome), nome)
