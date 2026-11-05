"""Fase 4: memória do motor_ia, em 3 camadas (o dossiê antigo confundia L1-L5 com L1-L3).

L1 (scratchpad da missão): histórico de iteração (plano, tentativas de código, erros do
harness) que já existia em `pipeline.executar_missao` como lista local (`mensagens_codigo`);
aqui só ganha nome/tipo claro (`HistoricoL1`). Vive só em memória, nunca é persistido, e é
descartado ao fim de cada `executar_missao` — não sobrevive entre chamadas.

L2 (resumo de sessão): ao fim da missão (sucesso ou falha), resume em poucas linhas via um
modelo barato já configurado (reusa `config.modelos.planejador`/`codificador`, nunca cria
modelo novo) e persiste em JSONL separado do `usage_log.py`. Hoje cada `executar_missao` é
isolada, sem conceito de "sessão com várias missões"; o resumo já fica pronto em disco pra
quando esse conceito existir.

L3 (persistente): só grava por ação explícita (`aprovado_por_humano=True`), nunca
automaticamente a partir do fluxo da missão. Registra origem (missão, timestamp) e é
reversível: `revogar_memoria_persistente` remove o registro pelo mesmo id.

L4/L5: não implementadas nem estudadas nesta fase. Decisão adiada até L1-L3 rodarem de
verdade (ver o comentário no hook de L2 em pipeline.executar_missao).
"""

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

from . import usage_log
from .config import MOTOR_IA_DIR

# L1: histórico de iteração da missão (mensagens no formato {"role": ..., "content": ...}).
# Tipo só documental — a lista continua local a `executar_missao`, nunca persistida nem
# compartilhada entre missões.
HistoricoL1 = List[Dict[str, Any]]

# Caminhos padrão (dentro de `motor_ia/data/`, já fora do Git pelo .gitignore existente —
# mesma pasta do usage_log.jsonl da Fase 0).
CAMINHO_PADRAO_SESSAO = MOTOR_IA_DIR / "data" / "memoria_sessao.jsonl"
CAMINHO_PADRAO_PERSISTENTE = MOTOR_IA_DIR / "data" / "memoria_persistente.jsonl"


@dataclass(frozen=True)
class ResumoSessao:
    timestamp: float
    missao_id: str
    tarefa: str
    ok: bool
    resumo: str


def registrar_resumo_sessao(
    caminho: Path,
    missao_id: str,
    tarefa: str,
    resultado: Any,  # ResultadoMissao; Any pra evitar import circular com pipeline.py
    chamador: Callable,
    modelo: str,
    log_path: Path,
) -> ResumoSessao:
    """Gera o resumo (L2) com `modelo` (barato, já configurado) e persiste em `caminho`."""
    mensagens = [
        {
            "role": "system",
            "content": "Resuma em até 3 linhas, sem JSON: o que foi pedido, o que foi feito/decidido, o resultado.",
        },
        {
            "role": "user",
            "content": (
                f"Tarefa: {tarefa}\nResultado: {'sucesso' if resultado.ok else 'falha'}\n"
                f"Motivo: {resultado.motivo}\nIterações: {resultado.iteracoes}"
            ),
        },
    ]
    resposta = chamador(modelo, mensagens, 256, 0.2, missao_id)
    usage_log.registrar(log_path, missao_id, "resumo_sessao", resposta)

    registro = ResumoSessao(
        timestamp=time.time(), missao_id=missao_id, tarefa=tarefa, ok=resultado.ok,
        resumo=resposta.conteudo.strip(),
    )
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with caminho.open("a", encoding="utf-8") as arquivo:
        arquivo.write(json.dumps(asdict(registro), ensure_ascii=False) + "\n")
    return registro


def ler_resumos_sessao(caminho: Path) -> Iterator[Dict]:
    if not caminho.exists():
        return
    with caminho.open(encoding="utf-8") as arquivo:
        for linha in arquivo:
            linha = linha.strip()
            if linha:
                yield json.loads(linha)


@dataclass(frozen=True)
class RegistroMemoriaPersistente:
    id: str
    timestamp: float
    missao_id: str
    origem: str
    conteudo: str
    aprovado_por_humano: bool


def gravar_memoria_persistente(
    caminho: Path, missao_id: str, conteudo: str, origem: str, *, aprovado_por_humano: bool,
) -> Optional[RegistroMemoriaPersistente]:
    """L3: só grava com `aprovado_por_humano=True` (nomeado, pra nunca passar por acidente
    na posição). Qualquer outro valor (`False`, `None`, string truthy) não grava nada (`None`)."""
    if aprovado_por_humano is not True:
        return None
    registro = RegistroMemoriaPersistente(
        id=uuid.uuid4().hex[:12], timestamp=time.time(), missao_id=missao_id,
        origem=origem, conteudo=conteudo, aprovado_por_humano=True,
    )
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with caminho.open("a", encoding="utf-8") as arquivo:
        arquivo.write(json.dumps(asdict(registro), ensure_ascii=False) + "\n")
    return registro


def ler_memoria_persistente(caminho: Path) -> Iterator[Dict]:
    if not caminho.exists():
        return
    with caminho.open(encoding="utf-8") as arquivo:
        for linha in arquivo:
            linha = linha.strip()
            if linha:
                yield json.loads(linha)


def revogar_memoria_persistente(caminho: Path, registro_id: str) -> bool:
    """Remove o registro `registro_id` (reversibilidade do L3). `True` se removeu algo.

    Escreve num `.tmp` e troca com `os.replace` (atômico): uma falha no meio da escrita
    nunca deixa `caminho` truncado, com registros aprovados perdidos.
    """
    registros = list(ler_memoria_persistente(caminho))
    restantes = [r for r in registros if r["id"] != registro_id]
    if len(restantes) == len(registros):
        return False
    temporario = caminho.with_suffix(caminho.suffix + ".tmp")
    with temporario.open("w", encoding="utf-8") as arquivo:
        for registro in restantes:
            arquivo.write(json.dumps(registro, ensure_ascii=False) + "\n")
    os.replace(temporario, caminho)
    return True
