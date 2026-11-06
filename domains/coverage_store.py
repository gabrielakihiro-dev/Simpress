"""Cobertura de Equipamentos: leitura estrita e gravação transacional do estado operacional.

- ``operacao_cobertura.json`` guarda os casos abertos e os fechados recentes; ``operacao_cobertura_arquivados.json``
  recebe os fechados há mais de 30 dias (D6), movidos dentro da mesma transação de qualquer escrita.
- Arquivo ilegível nunca é sobrescrito: a leitura levanta ``EstadoIlegivel`` (503) e a gravação aborta.
- A gravação não usa lock Python: ``AtomicFileTransaction`` já serializa os escritores (threads e processos).
- Esta camada nunca abre ``EquipamentosDetalhes``; o cadastro chega pronto pelo ``Contexto``.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, Tuple

from core.integrity import AtomicFileTransaction, FileTransactionError
from domains import coverage
from domains.sebrae_novos import ler_existentes
from domains.sebrae_vinculos import vinculos_derivados
from domains.ticket_reporting import _is_closed

Operacao = Callable[[coverage.Estado], Tuple[coverage.Estado, coverage.Registro]]
OperacaoHistorico = Callable[
    [coverage.Estado, Any], Tuple[coverage.Estado, Optional[coverage.Historico], coverage.Registro]
]


class EstadoIlegivel(ValueError):
    """O arquivo existe, mas não é um estado de cobertura válido; ele é preservado como está."""


def validar_estado(valor: Any, nome: str = "operacao_cobertura.json") -> coverage.Estado:
    """Validação estrita: esquema conhecido, só as seções esperadas e registros com ``rev`` inteiro."""
    if not isinstance(valor, dict):
        raise EstadoIlegivel(f"'{nome}' precisa conter um objeto.")
    if valor.get("esquema") != coverage.ESQUEMA:
        raise EstadoIlegivel(f"'{nome}' tem um esquema desconhecido ({valor.get('esquema')!r}).")
    desconhecidas = set(valor) - {"esquema", *coverage.SECOES}
    if desconhecidas:
        raise EstadoIlegivel(f"'{nome}' tem seções desconhecidas: {', '.join(sorted(desconhecidas))}.")
    for secao in coverage.SECOES:
        registros = valor.get(secao, {})
        if not isinstance(registros, dict):
            raise EstadoIlegivel(f"A seção '{secao}' de '{nome}' precisa ser um objeto.")
        for registro_id, registro in registros.items():
            rev = registro.get("rev") if isinstance(registro, dict) else None
            if not isinstance(registro, dict) or isinstance(rev, bool) or not isinstance(rev, int):
                raise EstadoIlegivel(f"O registro '{registro_id}' da seção '{secao}' de '{nome}' é inválido.")
    return {"esquema": coverage.ESQUEMA, **{secao: valor.get(secao, {}) for secao in coverage.SECOES}}


def _ler_estado(caminho: Path) -> coverage.Estado:
    if not caminho.exists():
        return coverage.estado_vazio()
    try:
        bruto = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise EstadoIlegivel(f"'{caminho.name}' está ilegível; os dados foram preservados.") from error
    return validar_estado(bruto, caminho.name)


class CoberturaStore:
    def __init__(self, arquivo: Path, arquivados: Path, transaction_root: Path) -> None:
        self.arquivo = Path(arquivo)
        self.arquivados = Path(arquivados)
        self.transaction_root = Path(transaction_root)

    def ler(self) -> coverage.Estado:
        return _ler_estado(self.arquivo)

    def ler_arquivados(self) -> coverage.Estado:
        return _ler_estado(self.arquivados)

    def escrever(self, operacao: Operacao, hoje: date) -> coverage.Registro:
        """Relê o estado dentro da transação, aplica ``operacao`` e arquiva os casos antigos (D6).

        ``CoberturaErro`` levantado pela operação desfaz a transação sem gravar nada. ``EstadoIlegivel`` também.
        ``FileBusyError`` (arquivo ocupado) e ``FileTransactionError`` (leitura ou gravação) sobem para o router.
        """
        resultado: Dict[str, coverage.Registro] = {}
        movidos: Dict[str, Dict[str, coverage.Registro]] = {}

        def atualizar(atual: Any) -> coverage.Estado:
            estado = validar_estado(atual, self.arquivo.name)
            novo, registro = operacao(estado)
            resultado["registro"] = registro
            restante, saindo = coverage.separar_arquivaveis(novo, hoje)
            movidos.update(saindo)
            return restante

        with AtomicFileTransaction(self.transaction_root, [self.arquivo, self.arquivados]) as transacao:
            transacao.update_json(self.arquivo, atualizar, coverage.estado_vazio())
            if movidos:
                transacao.update_json(
                    self.arquivados,
                    lambda atual: coverage.juntar_arquivados(validar_estado(atual, self.arquivados.name), movidos),
                    coverage.estado_vazio(),
                )
            transacao.commit()
        return resultado["registro"]

    def escrever_com_historico(self, historico: Path, operacao: OperacaoHistorico, hoje: date) -> coverage.Registro:
        """Como ``escrever``, mas numa única transação também sobre o histórico de transferências.

        ``operacao(estado, historico_bruto)`` devolve ``(novo_estado, novo_historico | None, resultado)``; ``None``
        deixa o histórico intocado. Os dois arquivos ficam travados juntos desde o início, então a leitura do
        histórico antes da gravação é consistente.
        """
        historico = Path(historico)
        resultado: Dict[str, Any] = {}
        movidos: Dict[str, Dict[str, coverage.Registro]] = {}
        alvos = [historico, self.arquivo, self.arquivados]
        with AtomicFileTransaction(self.transaction_root, alvos) as transacao:
            bruto: Any = []
            if historico.exists():
                try:
                    bruto = _ler_json(historico)
                except (OSError, UnicodeError, ValueError) as error:
                    raise FileTransactionError(f"Não foi possível ler '{historico.name}' para atualizá-lo com segurança.") from error

            def atualizar(atual: Any) -> coverage.Estado:
                novo, novo_historico, registro = operacao(validar_estado(atual, self.arquivo.name), bruto)
                resultado.update(registro=registro, historico=novo_historico)
                restante, saindo = coverage.separar_arquivaveis(novo, hoje)
                movidos.update(saindo)
                return restante

            transacao.update_json(self.arquivo, atualizar, coverage.estado_vazio())
            if resultado["historico"] is not None:
                transacao.update_json(historico, lambda _atual: resultado["historico"], [])
            if movidos:
                transacao.update_json(
                    self.arquivados,
                    lambda atual: coverage.juntar_arquivados(validar_estado(atual, self.arquivados.name), movidos),
                    coverage.estado_vazio(),
                )
            transacao.commit()
        registro_final: coverage.Registro = resultado["registro"]
        return registro_final


def eh_ilegivel(error: BaseException) -> bool:
    """``FileTransactionError`` de leitura (JSON inválido) ou estado inválido: 503, nunca 500."""
    if isinstance(error, EstadoIlegivel):
        return True
    return isinstance(error, FileTransactionError) and isinstance(error.__cause__, (ValueError, UnicodeError))


# ------------------------------------------------------------------------------------- fonte de manutenção


def _ler_json(caminho: Path) -> Any:
    return json.loads(caminho.read_text(encoding="utf-8"))


def manutencao_de(relatorio: Optional[Mapping[str, Any]], abertos: Sequence[Mapping[str, Any]]) -> coverage.Manutencao:
    """Série com OS aberta no Oracle ou com chamado aberto da aba Chamados ligado por vínculo único bloqueia; chamado
    aberto cuja série não tem vínculo único (ambíguo ou sem OS) só vira sinal."""
    series = set()
    for chamado in (relatorio or {}).get("chamados") or []:
        if not isinstance(chamado, dict):
            continue
        oracle = chamado.get("oracle")
        if any(isinstance(item, dict) and not _is_closed(item) for item in (oracle if isinstance(oracle, list) else [])):
            series.add(coverage.chave_serie(chamado.get("serie")))
    ligadas = {coverage.chave_serie(v.get("serie")) for v in vinculos_derivados(abertos, relatorio)}
    series |= ligadas
    sinais = {coverage.chave_serie((a.get("automaticos") or {}).get("K")) for a in abertos if isinstance(a, dict)}
    series.discard("")
    return coverage.Manutencao(series=frozenset(series), sinais=frozenset(sinais - series - {""}))


def manutencao_dos_chamados(relatorio_path: Path, existentes_path: Path) -> coverage.Manutencao:
    """Fonte de manutenção de produção. Relatório ou Dashboard importado ilegível → ``ilegivel`` (nunca libera em
    silêncio). Arquivo ausente conta como vazio."""
    try:
        relatorio = _ler_json(relatorio_path) if relatorio_path.exists() else {}
        if not isinstance(relatorio, dict):
            raise ValueError("relatório de chamados inválido")
        abertos: Sequence[Mapping[str, Any]] = []
        if existentes_path.exists():
            existentes = ler_existentes(existentes_path)
            if existentes is None:
                raise ValueError("Dashboard importado ilegível")
            abertos = existentes["abertos"]
    except (OSError, UnicodeError, ValueError):
        return coverage.Manutencao(ilegivel=True)
    return manutencao_de(relatorio, abertos)
