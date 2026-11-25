"""Senhas dos chamados SEBRAE para a aba Chamados (F5): exceção à máscara de LGPD autorizada pelo usuário em 19/11/2026.

Só os valores que ``omitir_credenciais`` esconde são guardados, por chamado, em ``data/state/sebrae_credenciais.json``
(nunca a descrição inteira). O resto do sistema continua mascarado: ``sebrae_novos.json``, cache dos antigos, coluna H
do Dashboard, histórico, logs e Assistente. A tela só recebe o valor quando o usuário clica em "Mostrar senha"
(``GET /api/sebrae/chamados/{numero}/credenciais``). A entrada é apagada quando a rotina ``fechar`` finaliza o chamado
no SoftExpert (``ok``) e, na importação do Dashboard, quando o chamado vem com D ``FINALIZADO`` ou sai da coluna C depois
de estar aberto (``remover_encerrados``). Finalizado por outro técnico não apaga (preserva o Desfazer finalização;
decisão do usuário 25/11/2026). Chamado novo, ainda fora da coluna C, e chamado aberto mantêm a senha.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

from core.integrity import atomic_write_json, lock_paths
from domains.sebrae_arquivo import STATUS_FINALIZADO
from domains.sebrae_dashboard import OMITIDO, omitir_credenciais

ARQUIVO = "sebrae_credenciais.json"
MAX_VALORES = 10
MAX_VALOR = 200


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


def _ler_tudo(arquivo: Path) -> Dict[str, List[str]]:
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(dados, dict):
        return {}
    return {str(n): [str(v) for v in vs] for n, vs in dados.items() if isinstance(vs, list)}


def guardar(state_dir: Path, numero: str, *textos: Any) -> bool:
    """Guarda as senhas achadas nos textos do chamado; sem senha, nada muda. True quando gravou."""
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
    return _ler_tudo(caminho(state_dir)).get(numero, [])


def numeros(state_dir: Path) -> frozenset:
    """Chamados com senha guardada (sem os valores): a tela só mostra o botão nesses."""
    return frozenset(_ler_tudo(caminho(state_dir)))


def remover(state_dir: Path, *numeros: str) -> None:
    arquivo = caminho(state_dir)
    with lock_paths([arquivo]):
        dados = _ler_tudo(arquivo)
        removidos = [numero for numero in numeros if dados.pop(numero, None) is not None]
        if removidos:
            atomic_write_json(arquivo, dados)


def remover_encerrados(
    state_dir: Path, mapa: Mapping[str, Mapping[str, str]], abertos_antes: Sequence[Mapping[str, Any]],
) -> None:
    """Na importação do Dashboard: apaga a senha de quem tem D ``FINALIZADO`` no ``mapa`` (número -> status do novo
    Dashboard) ou estava em ``abertos_antes`` e sumiu da coluna C (mesma regra de ``sebrae_arquivo.registrar_saidas``).
    Chamado ausente do ``mapa`` que não estava aberto antes é novo e mantém a senha."""
    saiu = {str(a.get("numero") or "") for a in abertos_antes} - set(mapa)
    encerrados = saiu | {numero for numero, atual in mapa.items() if atual.get("status") == STATUS_FINALIZADO}
    alvo = sorted(encerrados & numeros(state_dir))
    if alvo:
        remover(state_dir, *alvo)
