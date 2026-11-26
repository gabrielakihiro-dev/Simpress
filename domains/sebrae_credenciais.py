"""Senhas dos chamados SEBRAE para a aba Chamados (F5): exceção à máscara de LGPD autorizada pelo usuário em 19/11/2026.

Só os valores que ``omitir_credenciais`` esconde são guardados, por chamado, em ``data/state/sebrae_credenciais.json``
(nunca a descrição inteira). O resto do sistema continua mascarado: ``sebrae_novos.json``, cache dos antigos, coluna H
do Dashboard, histórico, logs e Assistente. A tela só recebe o valor quando o usuário clica em "Mostrar senha"
(``GET /api/sebrae/chamados/{numero}/credenciais``). A entrada é apagada quando a rotina ``fechar`` finaliza o chamado
no SoftExpert (``ok``) e, na importação do Dashboard, quando o chamado vem com D ``FINALIZADO`` ou sai da coluna C depois
de estar aberto (``remover_encerrados``; FINALIZADO apaga sempre, a trava de quantidade vale só para os que saíram da coluna C). Finalizado por outro técnico não apaga (preserva o Desfazer finalização;
decisão do usuário 25/11/2026). Chamado novo, ainda fora da coluna C, e chamado aberto mantêm a senha.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

from core.integrity import atomic_write_json, lock_paths
from domains.sebrae_arquivo import STATUS_FINALIZADO
from domains.sebrae_dashboard import OMITIDO, omitir_credenciais

logger = logging.getLogger(__name__)
ARQUIVO = "sebrae_credenciais.json"
MAX_VALORES = 10
MAX_VALOR = 200
LIMITE_SENHAS_APAGADAS = 5  # a importação nunca apaga mais que isso de uma vez de chamados que saíram da coluna C (decisão do usuário, 26/11/2026)
LIMITE_FRACAO_APAGADAS = 0.5  # nem mais que esta fração das guardadas (só vale com 2 ou mais a apagar)


def caminho(state_dir: Path) -> Path:
    return Path(state_dir) / ARQUIVO


def extrair(*textos: Any) -> List[str]:
    """Os trechos que ``omitir_credenciais`` troca por ``OMITIDO``, na ordem, sem repetir.

    Compara cada linha original com a mascarada: a detecção continua num lugar só (``sebrae_dashboard``)."""
    valores: List[str] = []
    for texto in textos:
        original = str(texto or "").splitlines()
        mascarado = omitir_credenciais(texto).splitlines()
        for linha, linha_mascarada in zip(original, mascarado):
            if linha == linha_mascarada or OMITIDO not in linha_mascarada:
                continue
            molde = "(.+?)".join(re.escape(parte) for parte in linha_mascarada.split(OMITIDO))
            achado = re.fullmatch(molde, linha, re.DOTALL)
            for valor in (achado.groups() if achado else ()):
                valor = valor.strip()[:MAX_VALOR]
                if valor and valor != OMITIDO and valor not in valores:
                    valores.append(valor)
    return valores[:MAX_VALORES]


class CredenciaisIlegiveisError(RuntimeError):
    """O arquivo de senhas existe mas não pôde ser lido; nada é regravado para não perder o que havia nele.

    ``tipo`` é só o nome da exceção de leitura (para o log); nunca carrega conteúdo."""

    def __init__(self, tipo: str = "") -> None:
        super().__init__("Não foi possível ler o arquivo de senhas guardadas dos chamados; nada foi gravado nele.")
        self.tipo = tipo


def _ler_tudo(arquivo: Path) -> Dict[str, List[str]]:
    """Senhas por chamado. Arquivo ausente vale vazio; ilegível levanta ``CredenciaisIlegiveisError`` (sem conteúdo na mensagem)."""
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as erro:  # JSON inválido, texto não UTF-8 ou arquivo travado: nada é regravado
        raise CredenciaisIlegiveisError(type(erro).__name__) from None
    if not isinstance(dados, dict) or not all(isinstance(vs, list) for vs in dados.values()):
        raise CredenciaisIlegiveisError("EstruturaInvalida")
    return {str(n): [str(v) for v in vs] for n, vs in dados.items()}


def _ler_para_tela(arquivo: Path) -> Dict[str, List[str]]:
    """Leitura para a tela: ilegível vale vazio e nunca regrava."""
    try:
        return _ler_tudo(arquivo)
    except CredenciaisIlegiveisError as erro:
        logger.warning("Arquivo de senhas guardadas ilegível (%s); nada foi alterado nele.", erro.tipo)
        return {}


def guardar(state_dir: Path, numero: str, *textos: Any) -> bool:
    """Guarda as senhas achadas nos textos do chamado; sem senha, nada muda. True quando gravou.

    Arquivo ilegível: levanta ``CredenciaisIlegiveisError`` sem tocar nele (nenhuma cópia: seria um segundo arquivo com senhas)."""
    valores = extrair(*textos)
    if not numero or not valores:
        return False
    arquivo = caminho(state_dir)
    with lock_paths([arquivo]):
        dados = _ler_tudo(arquivo)
        dados[numero] = valores
        arquivo.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(arquivo, dados)
    return True


def ler(state_dir: Path, numero: str) -> List[str]:
    return _ler_para_tela(caminho(state_dir)).get(numero, [])


def numeros(state_dir: Path) -> frozenset:
    """Chamados com senha guardada (sem os valores): a tela só mostra o botão nesses."""
    return frozenset(_ler_para_tela(caminho(state_dir)))


def remover(state_dir: Path, *numeros: str) -> None:
    """Apaga as senhas dos chamados; arquivo ilegível levanta ``CredenciaisIlegiveisError`` sem regravar."""
    arquivo = caminho(state_dir)
    with lock_paths([arquivo]):
        dados = _ler_tudo(arquivo)
        removidos = [numero for numero in numeros if dados.pop(numero, None) is not None]
        if removidos:
            atomic_write_json(arquivo, dados)


@dataclass(frozen=True)
class ResultadoLimpeza:
    """O que ``remover_encerrados`` fez: só contagens, nunca números de chamado nem valores.

    ``apagadas``: senhas de fato apagadas (FINALIZADO, mais as que saíram da coluna C quando a trava não pulou).
    ``previstas_saida``: senhas de chamados que saíram da coluna C (o que a trava mede). ``pulado``: essas não foram apagadas."""

    apagadas: int
    pulado: bool
    previstas_saida: int
    guardadas: int


def remover_encerrados(
    state_dir: Path, mapa: Mapping[str, Mapping[str, str]], abertos_antes: Sequence[Mapping[str, Any]],
) -> ResultadoLimpeza:
    """Na importação do Dashboard: apaga a senha de quem tem D ``FINALIZADO`` no ``mapa`` (número -> status do novo
    Dashboard) ou estava em ``abertos_antes`` e sumiu da coluna C (mesma regra de ``sebrae_arquivo.registrar_saidas``).
    Chamado ausente do ``mapa`` que não estava aberto antes é novo e mantém a senha.

    FINALIZADO é sinal explícito: a senha sai sempre, sem trava (decisão do usuário, 26/11/2026). A trava vale só para
    os que saíram da coluna C (``saiu_alvo``, só as que existem no arquivo), sintoma de planilha errada ou cortada: se passam
    de ``LIMITE_SENHAS_APAGADAS`` ou de ``LIMITE_FRACAO_APAGADAS`` das guardadas, nenhuma delas é apagada (``pulado``;
    os FINALIZADO da mesma importação são apagados). A fração só vale com 2 ou mais: apagar a única senha guardada
    (1 de 1) é normal. Efeito aceito: com a trava pulada e a planilha certa, essas senhas ficam guardadas."""
    guardadas = numeros(state_dir)
    finalizados_alvo = {numero for numero, atual in mapa.items() if atual.get("status") == STATUS_FINALIZADO} & guardadas
    saiu_alvo = ({str(a.get("numero") or "") for a in abertos_antes} - set(mapa)) & guardadas
    previstas, total = len(saiu_alvo), len(guardadas)
    pulado = previstas > LIMITE_SENHAS_APAGADAS or (previstas >= 2 and previstas > total * LIMITE_FRACAO_APAGADAS)
    alvo = sorted(finalizados_alvo if pulado else finalizados_alvo | saiu_alvo)
    if alvo:
        remover(state_dir, *alvo)
    return ResultadoLimpeza(apagadas=len(alvo), pulado=pulado, previstas_saida=previstas, guardadas=total)
