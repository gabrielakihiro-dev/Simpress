"""Reversible masking of personal data between the assistant and the language model (LGPD).

Sensitive values (logged user, nickname, names) become markers such as `[PESSOA_1]` before
anything is sent to OpenRouter. The marker map lives only in process memory and is never
written to disk. Markers go back to the real value in tool arguments and in the text shown
on screen. CPF numbers are always replaced by a fixed mask, never by a marker.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

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
# shortcut: only "label: value" / "label=value" (value up to the next space); "senha é x" passes through.
SENHA_PATTERN = re.compile(r"\b(senha|password|passwd)([ \t]*[:=][ \t]*)\S+", re.IGNORECASE)
CPF_MASCARA = "***.***.***-**"
DADO_OMITIDO = "[DADO SENSÍVEL OMITIDO]"

# Keys whose value identifies a person or was chosen by one.
CHAVES_SENSIVEIS = frozenset({
    "usuario_logado", "usuarios_logados", "usuario_manual", "usuario", "apelido",
    "nome", "nome_pessoa", "solicitante", "responsavel", "login", "email",
    "entrega_contato", "retirada_contato",
    "usuario_anterior", "usuario_novo", "nome_pessoa_anterior", "nome_pessoa_novo",
    "apelido_manual", "apelido_anterior", "apelido_novo",
    "apelido_na_simpress", "apelido_no_endpoint",
    "apelido_equipamentos_detalhes", "apelido_invall", "computador",
})
# Free text written by people, where a known name can appear in the middle of a sentence.
CHAVES_TEXTO_LIVRE = frozenset({
    "anotacao", "descricao", "observacao", "motivo", "detalhes", "comentario", "mensagem", "erro",
    "texto_pagina", "rotulo", "titulo",
})
# Keys holding a person's name: each word of the name also becomes a marker ("o Bruno" inside a text).
CHAVES_NOME_PESSOA = frozenset({
    "nome", "nome_pessoa", "solicitante", "responsavel", "usuario_logado", "usuarios_logados", "usuario_manual",
    "usuario", "usuario_anterior", "usuario_novo", "nome_pessoa_anterior", "nome_pessoa_novo",
})
PARTICULAS_NOME = frozenset({"de", "da", "do", "das", "dos", "e"})
SEM_USUARIO = "Sem usuário registrado"
MIN_NOME_BASE = 3
MIN_PARTE_NOME = 4  # a loose "Ana" or "Li" would replace pieces of other words


def _cpf_valido(digitos: str) -> bool:
    if len(set(digitos)) == 1:
        return False
    for tamanho in (9, 10):
        soma = sum(int(d) * (tamanho + 1 - i) for i, d in enumerate(digitos[:tamanho]))
        if int(digitos[tamanho]) != (soma * 10 % 11) % 10:
            return False
    return True


def limpar_texto_sensivel(texto: Any) -> str:
    """Remove passwords, CPFs, e-mails and phones from free text (CPF before phone)."""
    if not texto:
        return ""
    limpo = SENHA_PATTERN.sub(lambda m: f"{m.group(1)}{m.group(2)}{DADO_OMITIDO}", str(texto))
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
        self._busca: Optional[Tuple["re.Pattern[str]", Dict[str, str]]] = None

    def _marcador(self, valor: str) -> str:
        chave = valor.strip()
        if chave not in self._por_valor:
            marcador = f"[PESSOA_{len(self._por_valor) + 1}]"
            self._por_valor[chave] = marcador
            self._por_marcador[marcador] = chave
            self._busca = None
        return self._por_valor[chave]

    def registrar_base(self, nomes: List[str]) -> None:
        """Names from the Simpress base: become markers at once and survive `limpar()`."""
        # Names of 1-2 letters ("TI") would replace common pieces of text.
        self._base = [n.strip() for n in nomes if len(n.strip()) >= MIN_NOME_BASE and n.strip() != SEM_USUARIO]
        for nome in self._base:
            self._marcador(nome)

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
        elif isinstance(obj, str) and chave in CHAVES_SENSIVEIS and obj.strip() and obj != SEM_USUARIO:
            self._marcador(obj)
            if chave in CHAVES_NOME_PESSOA:
                for parte in re.findall(r"[^\W\d_]+", obj):
                    if len(parte) >= MIN_PARTE_NOME and parte.casefold() not in PARTICULAS_NOME:
                        self._marcador(parte)

    def _trocar(self, obj: Any, chave: str) -> Any:
        if isinstance(obj, dict):
            return {k: self._trocar(v, str(k).lower()) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._trocar(v, chave) for v in obj]
        if isinstance(obj, str):
            if chave in CHAVES_SENSIVEIS and obj.strip() and obj != SEM_USUARIO:
                return self._marcador(obj)
            limpo = limpar_texto_sensivel(obj)
            return self.ocultar_conhecidos(limpo) if chave in CHAVES_TEXTO_LIVRE else limpo
        return obj

    def ocultar_conhecidos(self, texto: str) -> str:
        """Replace already known values found in the text (whole words only).

        shortcut: only names already seen in this conversation are recognised; a name never
        queried, typed or quoted stays as it is. Upgrade by loading the full people list.
        """
        if not self._por_valor:
            return texto
        if self._busca is None:
            # One expression (the base may hold thousands of names); longest first: "Maria Souza" before "Maria".
            valores = sorted(self._por_valor, key=len, reverse=True)
            padrao = r"(?<!\w)(?:" + "|".join(re.escape(v) for v in valores) + r")(?!\w)"
            self._busca = (re.compile(padrao, re.IGNORECASE), {v.casefold(): m for v, m in self._por_valor.items()})
        busca, por_valor = self._busca
        return busca.sub(lambda m: por_valor.get(m.group(0).casefold(), m.group(0)), texto)

    def restaurar(self, obj: Any) -> Any:
        """Swap known markers for the real value, in text, dict or list."""
        if isinstance(obj, dict):
            return {k: self.restaurar(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self.restaurar(v) for v in obj]
        if isinstance(obj, str):
            return TOKEN_PATTERN.sub(lambda m: self._por_marcador.get(m.group(0), m.group(0)), obj)
        return obj

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
        self._busca = None
        for nome in self._base:
            self._marcador(nome)
