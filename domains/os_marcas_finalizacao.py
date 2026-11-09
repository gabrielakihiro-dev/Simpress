"""Marca de OS finalizada da aba OS (F6), só local, em ``data/state/os_marcas_finalizacao.json``.

A marca avisa que o chamado ligado à OS já foi finalizado. Não escreve no SoftExpert, no SharePoint, no Excel, no Oracle
nem no UX, não reabre chamado ao ser desfeita e não entra em filtros, KPIs, contagens nem na exportação da F6.

Três fontes, sempre calculadas no servidor:

* ``site``: chamado que o site finalizou (``sebrae_finalizacao.json``, ``finalizacao.status == "ok"``). A OS é a foto
  ``os_vinculada`` gravada quando a finalização foi pedida; sem foto (finalizações antigas), vale o vínculo atual.
* ``outro_tecnico`` / ``nao_encontrado_softexpert``: chamado que a última leitura dos antigos não achou no SoftExpert e
  que segue nos abertos do Dashboard. Calculada na leitura: some quando uma leitura seguinte o encontra.
* ``outro_tecnico`` / ``saiu_do_dashboard``: chamado que saiu dos abertos do Dashboard na importação sem ``ok`` do site.
  Gravada na importação, com a OS resolvida na hora (``detectado_em``).

O arquivo guarda ``{"marcas": {<chave>: {...}}, "historico": [...]}``. Em ``marcas`` ficam os registros da fonte
``saiu_do_dashboard`` e, para qualquer fonte, os ajustes do usuário (``desfeita``, ``conferido_em``). O histórico é só
acréscimo; os eventos automáticos de ``site`` e ``nao_encontrado_softexpert`` não são gravados, são montados na leitura.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from core.errors import DomainBusyError, DomainValidationError
from core.integrity import FileBusyError, atomic_write_json, lock_paths
from domains.inventory_comparison import normalize_reference_value
from domains.os_observacoes import chave_os
from domains.sebrae_arquivo import STATUS_FINALIZADO
from domains.sebrae_dashboard_gravacao import CHAVE_DE_LINHA
from domains.sebrae_finalizacao import STATUS_OK
from domains.sebrae_observacoes import agora_iso
from domains.sebrae_vinculos import vinculo_do_chamado

logger = logging.getLogger(__name__)

NOME_ARQUIVO = "os_marcas_finalizacao.json"

ORIGEM_SITE = "site"
ORIGEM_OUTRO_TECNICO = "outro_tecnico"
MOTIVO_SAIU_DO_DASHBOARD = "saiu_do_dashboard"
MOTIVO_NAO_ENCONTRADO = "nao_encontrado_softexpert"

ACAO_DESFAZER = "desfazer"
ACAO_REFAZER = "refazer"
ACAO_CONFERIR = "conferir"
ACOES = (ACAO_DESFAZER, ACAO_REFAZER, ACAO_CONFERIR)

Resolvedor = Callable[[str], Optional[Dict[str, str]]]


def _sem_vinculo(_numero: str) -> Optional[Dict[str, str]]:
    return None


@dataclass(frozen=True)
class FontesMarcas:
    """O que o servidor sabe agora, já lido: o domínio não abre o ``sebrae_*`` por conta própria."""

    finalizacao: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)  # ``sebrae_finalizacao.ler_estado``
    nao_encontrados: Sequence[str] = ()  # ``nao_encontrados`` da última leitura dos antigos
    nao_encontrados_em: str = ""  # ``em`` dessa leitura
    abertos: Sequence[str] = ()  # números dos chamados abertos do Dashboard importado
    vinculo_atual: Resolvedor = _sem_vinculo  # vínculo de hoje (manual vence o derivado); ``None`` sem vínculo


def caminho_marcas(state_dir: Path) -> Path:
    return Path(state_dir) / NOME_ARQUIVO


def _chave_vinculo(vinculo: Mapping[str, Any]) -> tuple:
    """Mesma chave de ``ticket_os_link_key`` (F6, ``routers/operations.py``): fonte, série normalizada e OS sem espaços."""
    return (
        vinculo.get("fonte"), normalize_reference_value(vinculo.get("serie")),
        re.sub(r"\s+", "", str(vinculo.get("os") or "")).upper(),
    )


def resolvedor(
    manuais: Sequence[Mapping[str, Any]], derivados: Callable[[], Sequence[Mapping[str, Any]]],
) -> Resolvedor:
    """Vínculo ``{fonte, serie, os, origem}`` de um chamado: o manual vence o derivado; com várias OS, a maior.

    Sem vínculo (ou ambíguo, que o derivado já descarta) devolve ``None``. Os derivados só são calculados quando algum
    chamado não tem vínculo manual, e uma só vez; se o cálculo falhar, valem só os manuais. Derivado cuja OS (mesma fonte,
    série e OS) foi religada à mão a outro chamado é descartado, como na F6.
    """
    calculados: List[Sequence[Mapping[str, Any]]] = []

    def resolver(numero: str) -> Optional[Dict[str, str]]:
        achado, origem = vinculo_do_chamado(manuais, numero), "manual"
        if achado is None:
            if not calculados:
                try:
                    chaves_manuais = {_chave_vinculo(v) for v in manuais}
                    calculados.append([v for v in derivados() if _chave_vinculo(v) not in chaves_manuais])
                except Exception as erro:  # noqa: BLE001 - só o tipo no log, nunca dados de chamado
                    logger.warning("Vínculos derivados indisponíveis para a marca de OS (erro=%s).", type(erro).__name__)
                    calculados.append([])
            achado, origem = vinculo_do_chamado(calculados[0], numero), "dashboard"
        if achado is None:
            return None
        serie, ordem = str(achado.get("serie") or "").strip(), str(achado.get("os") or "").strip()
        if not serie or not ordem:
            return None
        return {"fonte": str(achado.get("fonte") or ""), "serie": serie, "os": ordem, "origem": origem}

    return resolver


# ---------------------------------------------------------------------------- arquivo

def _estrutura_invalida(dados: Any) -> bool:
    if not isinstance(dados, dict) or not isinstance(dados.get("marcas"), dict) or not isinstance(dados.get("historico"), list):
        return True
    return any(not isinstance(v, dict) for v in dados["marcas"].values()) or any(not isinstance(e, dict) for e in dados["historico"])


def _carregar(arquivo: Path) -> Dict[str, Any]:
    try:
        dados = json.loads(Path(arquivo).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"marcas": {}, "historico": []}
    except (OSError, ValueError, FileBusyError) as error:
        raise DomainBusyError(
            "O registro das marcas de OS finalizada está ilegível e foi preservado. Restaure uma cópia válida antes de reimportar o Dashboard ou alterar as marcas."
        ) from error
    if _estrutura_invalida(dados):
        raise DomainBusyError(
            "O registro das marcas de OS finalizada tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de reimportar o Dashboard ou alterar as marcas."
        )
    return dados


def validar_legivel(arquivo: Path) -> None:
    """Falta de arquivo é normal; arquivo ilegível ou de estrutura inválida levanta ``DomainBusyError`` sem tocar nele."""
    _carregar(arquivo)


def _gravar(arquivo: Path, dados: Mapping[str, Any]) -> None:
    arquivo.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(arquivo, dados)


def _ocupado(error: FileBusyError) -> DomainBusyError:
    return DomainBusyError("O registro das marcas de OS finalizada está ocupado no momento. Tente novamente em instantes.")


# ---------------------------------------------------------------------------- montagem

def _chamado(valor: Any) -> str:
    return str(valor or "").strip().upper()


def _chave(serie: Any, ordem: Any, chamado: Any) -> str:
    """``json.dumps([chave_os(serie, os), chamado])``; 422 sem série, OS ou chamado."""
    numero = _chamado(chamado)
    if not numero:
        raise DomainValidationError("Informe o chamado da marca.", status_code=422)
    return json.dumps([chave_os(serie, ordem), numero], ensure_ascii=False, separators=(",", ":"))


def _vinculo_atual_tolerante(fontes: FontesMarcas, numero: str) -> Optional[Mapping[str, Any]]:
    try:
        return fontes.vinculo_atual(numero)
    except Exception as erro:  # noqa: BLE001 - a marca é auxiliar: sem vínculo legível, só não há marca
        logger.warning("Vínculo do chamado indisponível para a marca de OS (erro=%s).", type(erro).__name__)
        return None


def _montar(dados: Mapping[str, Any], fontes: FontesMarcas) -> Dict[str, Dict[str, Any]]:
    """``{chave: marca}`` das três fontes com os ajustes do usuário e o histórico; vale ``site`` > saiu > não encontrado."""
    candidatas: Dict[str, Dict[str, Any]] = {}
    sinteticas = set()

    def candidata(serie: Any, ordem: Any, chamado: Any, origem: str, motivo: str, em: str, sintetica: bool) -> None:
        try:
            chave = _chave(serie, ordem, chamado)
        except DomainValidationError:
            return  # registro sem série, OS ou chamado não vira marca
        if chave in candidatas:
            return
        candidatas[chave] = {
            "serie": str(serie).strip(), "os": str(ordem).strip(), "chamado": _chamado(chamado), "origem": origem,
            "motivo": motivo, "finalizado_em": em,
        }
        if sintetica:
            sinteticas.add(chave)

    for numero, item in fontes.finalizacao.items():  # a) finalizado pelo site
        fin = item.get("finalizacao")
        if not (isinstance(fin, dict) and fin.get("status") == STATUS_OK):
            continue
        if "os_vinculada" in item:  # foto da hora do pedido; ``None`` = não havia vínculo, vale a foto
            foto = item["os_vinculada"]
            vinculo: Mapping[str, Any] | None = foto if isinstance(foto, dict) else None
        else:  # finalização antiga, sem foto: o vínculo de hoje, se existir
            vinculo = _vinculo_atual_tolerante(fontes, numero)
        if vinculo:
            candidata(vinculo.get("serie"), vinculo.get("os"), numero, ORIGEM_SITE, "", str(fin.get("em") or ""), True)

    for registro in dados["marcas"].values():  # c) saiu do Dashboard, gravado na importação
        if registro.get("origem") == ORIGEM_OUTRO_TECNICO and registro.get("detectado_em"):
            candidata(
                registro.get("serie"), registro.get("os"), registro.get("chamado"), ORIGEM_OUTRO_TECNICO,
                str(registro.get("motivo") or MOTIVO_SAIU_DO_DASHBOARD), str(registro["detectado_em"]), False,
            )

    abertos = {_chamado(n) for n in fontes.abertos}  # b) não achado na última leitura e ainda aberto
    for numero in fontes.nao_encontrados:
        numero = _chamado(numero)
        fin = (fontes.finalizacao.get(numero) or {}).get("finalizacao")
        if isinstance(fin, dict) and fin.get("status") == STATUS_OK:
            continue  # o site finalizou: é a marca ``site``, não a de outro técnico
        vinculo = _vinculo_atual_tolerante(fontes, numero) if numero in abertos else None
        if vinculo:
            candidata(vinculo.get("serie"), vinculo.get("os"), numero, ORIGEM_OUTRO_TECNICO, MOTIVO_NAO_ENCONTRADO, fontes.nao_encontrados_em, True)

    eventos: Dict[str, List[Dict[str, str]]] = {chave: [] for chave in candidatas}
    for chave in sinteticas:
        marca = candidatas[chave]
        eventos[chave].append({"acao": "marcada", "origem": "auto", "em": marca["finalizado_em"]})
    for evento in dados["historico"]:
        if evento.get("chave") in eventos:
            eventos[evento["chave"]].append({k: str(evento.get(k) or "") for k in ("acao", "origem", "em")})

    for chave, marca in candidatas.items():
        ajuste = dados["marcas"].get(chave, {})
        marca["ativa"] = not ajuste.get("desfeita")
        marca["conferido_em"] = str(ajuste.get("conferido_em") or "")
        marca["historico"] = sorted(eventos[chave], key=lambda e: e["em"])  # estável: a marcação automática vem antes na mesma hora
    return candidatas


def _ordenadas(marcas: Mapping[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(marcas.values(), key=lambda m: (m["finalizado_em"], m["chamado"], m["os"]), reverse=True)


def ler_marcas(arquivo: Path, fontes: FontesMarcas) -> List[Dict[str, Any]]:
    """Todas as marcas (ativas e desfeitas), mais recentes primeiro; arquivo ilegível levanta ``DomainBusyError``."""
    return _ordenadas(_montar(_carregar(arquivo), fontes))


def pendentes_outro_tecnico(arquivo: Path, fontes: FontesMarcas) -> List[Dict[str, str]]:
    """Marcas de outro técnico ativas e ainda sem ``Conferido``: o aviso do sino."""
    return [
        {"chamado": m["chamado"], "serie": m["serie"], "os": m["os"], "motivo": m["motivo"]}
        for m in ler_marcas(arquivo, fontes)
        if m["origem"] == ORIGEM_OUTRO_TECNICO and m["ativa"] and not m["conferido_em"]
    ]


# ---------------------------------------------------------------------------- ações do usuário

def alterar_marca(arquivo: Path, fontes: FontesMarcas, serie: Any, ordem: Any, chamado: Any, acao: Any) -> Dict[str, Any]:
    """``desfazer``, ``refazer`` ou ``conferir`` (só ``outro_tecnico``); devolve a marca como o GET.

    422 se a ação é inválida ou a marca não existe. Repetir a ação não muda nada nem acrescenta ao histórico. Só grava
    o ajuste e o evento ``manual``: desfazer nunca mexe no SoftExpert.
    """
    if acao not in ACOES:
        raise DomainValidationError("Ação inválida. Use desfazer, refazer ou conferir.", status_code=422)
    chave = _chave(serie, ordem, chamado)
    try:
        with lock_paths([arquivo]):
            dados = _carregar(arquivo)
            marca = _montar(dados, fontes).get(chave)
            if marca is None:
                raise DomainValidationError("Marca de OS finalizada não encontrada.", status_code=422)
            if acao == ACAO_CONFERIR and marca["origem"] != ORIGEM_OUTRO_TECNICO:
                raise DomainValidationError("Só a marca de chamado finalizado por outro técnico pode ser conferida.", status_code=422)
            ajuste = dados["marcas"].get(chave, {})
            agora = agora_iso()
            if acao == ACAO_DESFAZER and marca["ativa"]:
                ajuste["desfeita"], nome = True, "desfeita"
            elif acao == ACAO_REFAZER and not marca["ativa"]:
                ajuste["desfeita"], nome = False, "refeita"
            elif acao == ACAO_CONFERIR and not marca["conferido_em"]:
                ajuste["conferido_em"], nome = agora, "conferida"
            else:
                return marca  # nada a mudar
            dados["marcas"][chave] = ajuste
            dados["historico"].append({
                "chave": chave, "acao": nome, "origem": "manual", "chamado": marca["chamado"], "serie": marca["serie"],
                "os": marca["os"], "em": agora,
            })
            _gravar(arquivo, dados)
            return _montar(dados, fontes)[chave]
    except FileBusyError as error:
        raise _ocupado(error) from error


# ---------------------------------------------------------------------------- fonte c: importação do Dashboard

def detectar_saidas(
    abertos_antes: Sequence[Mapping[str, Any]], mapa: Mapping[str, Mapping[str, str]],
    finalizacao: Mapping[str, Mapping[str, Any]], resolver: Resolvedor,
) -> List[Dict[str, str]]:
    """Chamados UTIC abertos na importação anterior que não estão mais abertos no novo Dashboard, sem ``ok`` do site e com OS.

    ``mapa``: número -> status do novo Dashboard (``ler_status_chamados``); ausente ou ``FINALIZADO`` não é mais aberto.
    ``resolver`` recebe os abertos ANTIGOS (a linha já saiu do novo Dashboard). Chave ``linha:<n>`` não tem UTIC e é ignorada.
    """
    saidas: List[Dict[str, str]] = []
    for aberto in abertos_antes:
        numero = str(aberto.get("numero") or "").strip()
        if not numero or numero.startswith(CHAVE_DE_LINHA):
            continue
        atual = mapa.get(numero)
        if atual is not None and atual.get("status") != STATUS_FINALIZADO:
            continue  # segue aberto
        fin = (finalizacao.get(numero) or {}).get("finalizacao")
        if isinstance(fin, dict) and fin.get("status") == STATUS_OK:
            continue  # o site finalizou: é a marca ``site``
        vinculo = resolver(numero)
        if vinculo:
            saidas.append({"serie": vinculo["serie"], "os": vinculo["os"], "chamado": numero})
    return saidas


def registrar_saidas(arquivo: Path, saidas: Sequence[Mapping[str, str]], em: str = "") -> int:
    """Grava a fonte ``saiu_do_dashboard`` (sem escrever se não há nada novo). Repetir a mesma importação não duplica.

    Um registro que já tem ``detectado_em`` é mantido como está, inclusive se o usuário desfez a marca. Um que só tinha
    ajustes (de outra fonte) é uma detecção nova: volta ativa e sem ``Conferido``. Saída sem série, OS ou chamado válidos é pulada.
    """
    if not saidas:
        return 0
    em = em or agora_iso()
    novas = 0
    try:
        with lock_paths([arquivo]):
            dados = _carregar(arquivo)
            for saida in saidas:
                try:
                    chave = _chave(saida["serie"], saida["os"], saida["chamado"])
                except DomainValidationError as erro:
                    logger.warning("Saída do Dashboard sem série, OS ou chamado válidos ignorada (erro=%s).", type(erro).__name__)
                    continue
                registro = dados["marcas"].get(chave, {})
                if registro.get("detectado_em"):
                    continue
                if registro:  # só ajustes de outra fonte: o desfazer e o Conferido antigos não valem para esta detecção
                    registro.update(desfeita=False, conferido_em=None)
                chamado = _chamado(saida["chamado"])
                registro.update(
                    serie=str(saida["serie"]).strip(), os=str(saida["os"]).strip(), chamado=chamado,
                    origem=ORIGEM_OUTRO_TECNICO, motivo=MOTIVO_SAIU_DO_DASHBOARD, detectado_em=em,
                )
                dados["marcas"][chave] = registro
                dados["historico"].append({
                    "chave": chave, "acao": "marcada", "origem": "auto", "chamado": chamado, "serie": registro["serie"],
                    "os": registro["os"], "em": em,
                })
                novas += 1
            if novas:
                _gravar(arquivo, dados)
    except FileBusyError as error:
        raise _ocupado(error) from error
    return novas
