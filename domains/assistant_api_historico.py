"""The history and comparison reads of the assistant's API (`HistoricoMixin`, mixed into `SimpressApi` in `assistant_api`).

Leaf module: shared helpers come from `assistant_api_comum`; nothing here may import `assistant_api` or `assistant_api_sebrae`.
"""

import calendar
import json
import re
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

from domains.assistant_api_comum import MAX_ITENS_LISTA, _ID_ROTA, _aparar, e_macbook, sanitizar_equipamento
from domains.assistant_lgpd import limpar_texto_sensivel
from domains.assistant_transporte import ArquivoUpload
from domains.assistant_validacao import _dict
from domains.history_insights import PENDING_CATEGORIES, normalize_identifier
from domains.inventory_comparison import is_curitiba_hostname_exception, is_sebrae_owned_notebook_serial

# Annotatable sections of a history event (comparison key -> name shown on screen and on the card).
_SECOES_ANOTAVEIS = {
    "apelidos_sem_atualizacao": "Linhas mantidas para conferência",
    "sem_acesso_7_dias": "Sem acesso há 7 dias ou mais",
    "sem_acesso_60_dias": "Passou de 60 dias sem acesso",
    "ausentes_no_endpoint": "Equipamentos sem correspondência por fonte (Endpoint)",
    "ausentes_em_detalhes": "Equipamentos sem correspondência por fonte (Simpress)",
    "divergencias_local": "Localidade divergente",
    "correspondencias_ambiguas": "Duplicidades e correspondências ambíguas",
    "registros_ambiguos": "Duplicidades e correspondências ambíguas",
    "series_sem_mapeamento": "Séries sem local definido",
    "mudancas_usuarios": "Mudanças de usuário logado",
}
# consultar_ultima_comparacao(): counts taken from the size of these lists in the history view, not from the stored summary.
_LISTAS_CONTADAS_PELA_VISAO = ("ausentes_no_endpoint", "ausentes_em_detalhes", "sem_acesso_7_dias", "divergencias_local", "series_sem_mapeamento")

# comparar_periodos(): examples per list and size of the answer. The chat cuts any result above
# MAX_CARACTERES_RESPOSTA (6000, assistant_chat) in the middle, so the examples shrink first and the JSON stays whole.
MAX_EXEMPLOS_COMPARACAO = 10
ORCAMENTO_COMPARACAO = 5000
_PONTO_PERIODO = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")
_PONTO_EVENTO = re.compile(r"^(?![0-9-]+$)[A-Za-z0-9_-]{1,64}$")
_CAMPOS_EXEMPLO = (
    ("serie", "serie"), ("serial", "serie"), ("computador", "computador"), ("local_previsto", "local_previsto"),
    ("local_detalhes", "local_na_simpress"), ("dias_sem_verificacao", "dias_sem_acesso"), ("motivo", "motivo"),
)

# Sections of the latest sheet comparison served by listar_secao_comparacao().
# "correspondencias_ambiguas" adds two fields because the screen moves serial duplicates from
# "correspondencias_ambiguas" to "registros_ambiguos" (see comparison_history_for_display).
_SECOES_COMPARACAO = {
    "correspondencias_ambiguas": ("correspondencias_ambiguas", "registros_ambiguos"),
    "series_sem_mapeamento": ("series_sem_mapeamento",),
    "apelidos_atualizados": ("apelidos_atualizados",),
    "divergencias_apelidos_manuais": ("divergencias_apelidos_manuais",),
    "mudancas_usuarios": ("mudancas_usuarios",),
    "sem_acesso_60_dias": ("sem_acesso_60_dias",),
}
# explicar_divergencia(): same size budget as comparar_periodos (the section items shrink first).
_SERIE_VALIDA = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
_HOSTNAME_VALIDO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
_ROTULOS_EXTRA_SECAO = {
    "apelidos_atualizados": "Apelidos atualizados",
    "divergencias_apelidos_manuais": "Apelidos manuais divergentes",
    "mudancas_usuarios": "Mudanças de usuário",
}
_TEXTO_AMBIGUA = "A série ou o hostname aparece em mais de uma linha, ou a correspondência não é única; confira os duplicados."
# Sections of the last comparison that explain a divergence: section -> (cause code, fixed text).
# The texts never carry a hostname, user or nickname, so the privacy mask has nothing to miss.
_CAUSAS_SECAO = {
    "ausentes_no_endpoint": ("ausente_no_endpoint", "Na última comparação a série ficou sem correspondência no Endpoint: existe na Simpress, mas não foi achada no Endpoint."),
    "ausentes_em_detalhes": ("ausente_na_simpress", "Na última comparação a série ficou sem correspondência na Simpress: existe no Endpoint, mas não foi achada na Simpress."),
    "sem_acesso_7_dias": ("sem_acesso_7_dias", "Sem acesso há 7 dias ou mais: a última verificação no Endpoint foi há 7 dias ou mais."),
    "apelidos_sem_atualizacao": ("linha_mantida_para_conferencia", "A linha ficou em 'Linhas mantidas para conferência': o hostname do Endpoint não foi aplicado como apelido (veja o motivo)."),
    "divergencias_local": ("localidade_divergente", "A localidade esperada pelo hostname é diferente da localidade cadastrada na Simpress."),
    "correspondencias_ambiguas": ("ocorrencia_ambigua", _TEXTO_AMBIGUA),
    "registros_ambiguos": ("ocorrencia_ambigua", _TEXTO_AMBIGUA),
    "series_sem_mapeamento": ("serie_sem_local_definido", "A série não tem local definido no mapeamento de localidades."),
    "divergencias_apelidos_manuais": ("apelido_manual_diverge", "O apelido manual é diferente do apelido na Simpress ou do hostname no Endpoint."),
}
_SECOES_EXPLICACAO = (*_CAUSAS_SECAO, "apelidos_atualizados", "mudancas_usuarios")
# What the current record says about the Endpoint (invall_alias_status); anything else is unknown.
_ENDPOINT_PELO_STATUS = {
    "aplicado": "presente", "serie_invall_duplicada": "presente", "hostname_vazio": "presente",
    "serie_nao_encontrada": "ausente",
}
_CAUSAS_STATUS = {
    "serie_nao_encontrada": ("ausente_no_endpoint", "O Endpoint ativo não tem esta série."),
    "hostname_vazio": ("hostname_vazio_no_endpoint", "O Endpoint tem a série, mas o hostname está vazio."),
    "serie_invall_duplicada": ("serie_duplicada_no_endpoint", "A série aparece mais de uma vez no Endpoint."),
    "serie_detalhes_duplicada": ("serie_duplicada_na_simpress", "A série aparece mais de uma vez na Simpress."),
    "indisponivel": ("endpoint_indisponivel", "O Endpoint ativo não pôde ser lido; não dá para dizer se a série está nele."),
}
# Approved labels (docs/operacao/regras-cadastro-historico.md, "Rótulos do Histórico de Planilhas"): EquipamentosDetalhes is "na Simpress", InvAll is "no Endpoint".
_ROTULOS_SECAO = {
    "apelido_equipamentos_detalhes": "apelido_na_simpress",
    "apelido_invall": "apelido_no_endpoint",
    "detalhes_encontrado": "encontrado_na_simpress",
    "invall_encontrado": "encontrado_no_endpoint",
    "diverge_detalhes": "diverge_na_simpress",
    "diverge_invall": "diverge_no_endpoint",
}



def _rotular_item(dados: Any) -> Any:
    """Apply the approved labels and drop internal ids and empty annotations."""
    if isinstance(dados, dict):
        resultado: Dict[str, Any] = {}
        for k, v in dados.items():
            if k == "anotacao_id":
                continue
            if k == "anotacao" and not v:
                continue
            if k == "arquivos_origem" and isinstance(v, dict):
                v = {("na simpress" if kk == "detalhes" else kk): vv for kk, vv in v.items()}
            resultado[_ROTULOS_SECAO.get(str(k), str(k))] = _rotular_item(v)
        return resultado
    if isinstance(dados, list):
        return [_rotular_item(v) for v in dados]
    return dados


def _instante(horario: Any) -> float:
    try:
        valor = datetime.fromisoformat(str(horario or "").replace("Z", "+00:00"))
        if valor.tzinfo is None:
            valor = valor.replace(tzinfo=timezone.utc)
        return valor.timestamp()
    except (TypeError, ValueError, OverflowError):
        return float("-inf")


def _limite_do_ponto(ponto: str) -> Optional[str]:
    """Last day (AAAA-MM-DD) covered by a month or date point; None for an event id. ValueError for a date that does not exist."""
    if not _PONTO_PERIODO.match(ponto):
        return None
    if len(ponto) == 7:
        return f"{ponto}-{calendar.monthrange(int(ponto[:4]), int(ponto[5:]))[1]:02d}"
    date.fromisoformat(ponto)
    return ponto


def _exemplo_comparacao(item: Dict[str, Any]) -> Dict[str, Any]:
    """A history row reduced to serial, hostname, place and reason (notes and users stay out)."""
    exemplo: Dict[str, Any] = {}
    for origem, destino in _CAMPOS_EXEMPLO:
        valor = item.get(origem)
        if valor not in (None, "", [], {}):
            exemplo[destino] = valor if isinstance(valor, int) else limpar_texto_sensivel(valor)[:80]
    if "serie" not in exemplo and "computador" not in exemplo and item.get("chave"):
        # Ambiguity rows only carry `chave`: a serial when duplicated, otherwise a hostname (masked as such).
        duplicada = "série" in str(item.get("tipo") or "").lower()
        exemplo["serie" if duplicada else "computador"] = limpar_texto_sensivel(item["chave"])[:80]
        exemplo["tipo"] = limpar_texto_sensivel(item.get("tipo"))[:80]
    return exemplo


class HistoricoMixin:
    if TYPE_CHECKING:  # members of `SimpressApi` used here; declared for mypy only, never defined at runtime
        def _chamar(
            self, metodo: str, caminho: str, params: Optional[Dict[str, Any]] = None, corpo: Union[Dict[str, Any], ArquivoUpload, None] = None,
        ) -> Tuple[bool, Any]: ...

        def _leitura(self, caminho: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]: ...

        @staticmethod
        def _limite(limite: Any, padrao: int) -> int: ...

        def _ultimo_evento(self) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[Dict[str, Any]]]: ...

    def consultar_ultima_comparacao(self) -> Dict[str, Any]:
        ultimo, detalhe, problema = self._ultimo_evento()
        if problema is not None:
            return problema
        visao = _dict(_dict(detalhe).get("evento"))
        resumo = {**_dict(_dict(ultimo).get("resumo")), **_dict(visao.get("resumo"))}
        comparacao = _dict(visao.get("comparacao"))
        # The stored summary is the raw import count; the list tools read the filtered view, so count the same lists.
        for chave in _LISTAS_CONTADAS_PELA_VISAO:
            if isinstance(comparacao.get(chave), list):
                resumo[chave] = len(comparacao[chave])
        return {
            "horario": _dict(ultimo).get("horario", ""),
            "tipo": _dict(ultimo).get("tipo", ""),
            "resumo_divergencias": resumo,
        }

    def consultar_historico_comparacao(self, evento_id: str) -> Dict[str, Any]:
        evento_id = evento_id.strip()
        if not evento_id or "/" in evento_id:
            return {"erro": "Identificador do histórico inválido."}
        return self._leitura(f"/api/historico-comparacoes/{evento_id}")

    def _linhas_anotaveis(self, evento_id: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """(rows of the annotatable sections of a history event, error). Rows keep the real ids for the card and the PUT."""
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return [], "Identificador do histórico inválido."
        ok, dados = self._chamar("GET", f"/api/historico-comparacoes/{evento_id}")
        if not ok:
            return [], str(dados)
        comparacao = _dict(_dict(_dict(dados).get("evento")).get("comparacao"))
        linhas = [
            {
                "secao": rotulo, "item_id": item["anotacao_id"],
                "serie": item.get("serie") or "", "computador": item.get("computador") or item.get("chave") or "",
                "anotacao": item.get("anotacao") or "",
            }
            for chave, rotulo in _SECOES_ANOTAVEIS.items() for item in comparacao.get(chave) or []
            if isinstance(item, dict) and item.get("anotacao_id")
        ]
        return linhas, None

    def listar_anotacoes_historico(self, evento_id: str, serie: Any = "", so_anotadas: Any = False) -> Dict[str, Any]:
        """Rows of one history event with their annotation. Needed to get the `item_id` before saving a note."""
        linhas, erro = self._linhas_anotaveis(evento_id)
        if erro:
            return {"erro": erro}
        serie = str(serie or "").strip().upper()
        itens = [
            linha for linha in linhas
            if (not serie or str(linha["serie"]).upper() == serie) and (so_anotadas is not True or linha["anotacao"])
        ]
        return {"total": len(itens), "itens": _aparar(itens), "omitidos": max(0, len(itens) - MAX_ITENS_LISTA)}

    def linha_historico(self, evento_id: str, item_id: str) -> Optional[Dict[str, Any]]:
        """The row of the event with this id (None when it does not exist); for the confirmation card."""
        linhas, _ = self._linhas_anotaveis(evento_id)
        return next((linha for linha in linhas if linha["item_id"] == str(item_id).strip()), None)

    def evento_linha_do_tempo(self, serie: str, evento_id: str, item_id: str) -> Optional[Dict[str, Any]]:
        serie = str(serie or "").strip().upper()
        if not serie or "/" in serie:
            return None
        ok, dados = self._chamar("GET", f"/api/operacoes/chamados/linha-do-tempo/{serie}")
        eventos = _dict(dados).get("eventos") if ok else None
        return next(
            (e for e in eventos or [] if isinstance(e, dict) and e.get("snapshot_id") == evento_id and e.get("item_id") == item_id),
            None,
        )

    def listar_divergencias_localidade(self) -> Dict[str, Any]:
        """Full 'Localidade divergente' section of the latest comparison, plus related transfers."""
        evento, detalhe, falha = self._ultimo_evento()
        if falha is not None or evento is None or detalhe is None:
            return falha or {"erro": "Histórico indisponível."}
        divergencias = [_dict(d) for d in _dict(_dict(detalhe.get("evento")).get("comparacao")).get("divergencias_local") or []]
        itens = [
            {
                "serie": d.get("serie", ""),
                "computador": d.get("computador", ""),
                "local_previsto": d.get("local_previsto", ""),
                "local_na_simpress": d.get("local_detalhes", ""),
            }
            for d in divergencias
        ]
        resultado: Dict[str, Any] = {
            "total": len(itens),
            "horario_comparacao": evento.get("horario", ""),
            "itens": _aparar(itens),
        }
        seriais = {str(d.get("serie", "")).strip().upper() for d in divergencias} - {""}
        if seriais:
            ok, dados_transf = self._chamar("GET", "/api/historico-transferencias")
            if not ok:
                resultado["aviso_transferencias"] = "Não foi possível consultar o histórico de transferências agora."
            else:
                relacionadas = []
                for t in _dict(dados_transf).get("itens") or []:
                    if not isinstance(t, dict):
                        continue
                    serie_t = str(t.get("serial") or "").strip().upper()
                    if serie_t in seriais:
                        relacionadas.append({
                            "serie": serie_t,
                            "de": t.get("retirada_cidade", ""),
                            "para": t.get("entrega_cidade", ""),
                            "contato_entrega": t.get("entrega_contato", ""),
                            "observacao": t.get("entrega_obs", ""),
                        })
                resultado["transferencias_relacionadas"] = _aparar(relacionadas)
        return resultado

    def consultar_divergencia_localidade(self, serial: str) -> Dict[str, Any]:
        serial = serial.strip().upper()
        if not serial:
            return {"erro": "Número de série não informado."}
        evento, detalhe, falha = self._ultimo_evento()
        if falha is not None or evento is None or detalhe is None:
            return falha or {"erro": "Histórico indisponível."}
        divergencias = [_dict(d) for d in _dict(_dict(detalhe.get("evento")).get("comparacao")).get("divergencias_local") or []]
        item = next((d for d in divergencias if str(d.get("serie", "")).strip().upper() == serial), None)
        if not item:
            return {
                "divergente": False,
                "mensagem": f"Série '{serial}' não está na lista de localidade divergente do último cruzamento ({evento.get('horario', '')}).",
            }
        return {
            "divergente": True,
            "serie": serial,
            "computador": item.get("computador", ""),
            "local_previsto": item.get("local_previsto", ""),
            "local_na_simpress": item.get("local_detalhes", ""),
            "horario_comparacao": evento.get("horario", ""),
        }

    def listar_secao_comparacao(self, secao: str) -> Dict[str, Any]:
        campos = _SECOES_COMPARACAO.get(secao)
        if campos is None:
            return {"erro": f"Seção desconhecida: {secao}"}
        evento, detalhe, falha = self._ultimo_evento()
        if falha is not None or evento is None or detalhe is None:
            return falha or {"erro": "Histórico indisponível."}
        evento_detalhe = _dict(detalhe.get("evento"))
        comparacao = _dict(evento_detalhe.get("comparacao"))
        itens: List[Any] = []
        for campo in campos:
            itens.extend(comparacao.get(campo) or [])
        total = len(itens)
        if secao == "correspondencias_ambiguas":
            # The screen shows the total saved in the summary (before duplicates are reclassified).
            total_resumo = _dict(evento_detalhe.get("resumo")).get("correspondencias_ambiguas")
            if isinstance(total_resumo, int):
                total = total_resumo
        return {
            "secao": secao,
            "total": total,
            "horario_comparacao": evento.get("horario", ""),
            "itens": _aparar(_rotular_item(itens)),
        }

    def explicar_divergencia(self, serial: Any = "", hostname: Any = "") -> Dict[str, Any]:
        """Cross what Simpress already knows about one serial and list the probable causes by fixed rules."""
        serie = serial.strip().upper() if isinstance(serial, str) else ""
        host = hostname.strip() if isinstance(hostname, str) else ""
        if not _SERIE_VALIDA.match(serie) or (host and not _HOSTNAME_VALIDO.match(host)):
            return {"erro": "Informe uma série válida (letras, números, ponto, hífen ou sublinhado) e, se quiser, um hostname válido."}
        ok, dados = self._chamar("GET", f"/api/equipamento/{serie}")
        if not ok and not str(dados).startswith("Erro 404"):
            return {"erro": dados}
        registro = dados if ok and isinstance(dados, dict) else None
        com_s: Optional[Dict[str, Any]] = None
        if not serie.startswith("S"):
            ok_s, dados_s = self._chamar("GET", f"/api/equipamento/S{serie}")
            if ok_s and isinstance(dados_s, dict) and e_macbook(dados_s):
                com_s = dados_s  # Endpoint serial without the leading S equals the Simpress one with it (MacBook).
        via_s = registro is None and com_s is not None
        if via_s:
            registro = com_s

        causas: Dict[str, str] = {}
        if is_sebrae_owned_notebook_serial(serie):
            causas["serie_sebrae_ignorada"] = "A série é de notebook do Sebrae e é ignorada nas comparações."
        if is_curitiba_hostname_exception(host) or (registro is not None and is_curitiba_hostname_exception(str(registro.get("apelido") or ""))):
            causas["hostname_curitiba_sem_divergencia_local"] = (
                "Hostnames PRNOTESJP*, PRNOTERL* e PRNOTEARC* são de Curitiba e não geram divergência de localidade."
            )
        if registro is None:
            causas["ausente_na_simpress"] = "A série não consta na Simpress (cadastro atual)."
        elif com_s is not None and not via_s:
            causas["serie_s_ambigua"] = "Existem a série e a mesma série com o prefixo 'S' (MacBook) na Simpress; a correspondência com o Endpoint é ambígua."

        status = str(registro.get("invall_alias_status") or "") if registro else ""
        if status in _CAUSAS_STATUS:
            causas.setdefault(*_CAUSAS_STATUS[status])
        endpoint: Dict[str, Any] = {"situacao": _ENDPOINT_PELO_STATUS.get(status, "desconhecida"), "origem": "cadastro atual"}
        if registro and status:
            endpoint["detalhe"] = limpar_texto_sensivel(registro.get("invall_alias_detail", ""))[:160]

        chaves = {normalize_identifier(serie)}
        if registro is not None:
            chaves.add(normalize_identifier(registro.get("serial")))
            if e_macbook(registro):
                chaves |= {"S" + c for c in chaves} | {c[1:] for c in chaves if c.startswith("S")}
        chaves.discard("")
        host_norm = normalize_identifier(host)

        evento, detalhe, falha = self._ultimo_evento()
        comparacao = _dict(_dict(_dict(detalhe).get("evento")).get("comparacao")) if falha is None else {}
        secoes: List[Dict[str, Any]] = []
        for campo in _SECOES_EXPLICACAO:
            itens = []
            for item in comparacao.get(campo) or []:
                if not isinstance(item, dict):
                    continue
                por_serie = any(normalize_identifier(item.get(k)) in chaves for k in ("serie", "serial", "chave"))
                por_host = bool(host_norm) and host_norm in (normalize_identifier(item.get("computador")), normalize_identifier(item.get("chave")))
                if not (por_serie or por_host):
                    continue
                if por_host and not por_serie and not (item.get("chave") or item.get("serie") or item.get("serial")):
                    causas.setdefault("serie_vazia", "Há uma linha com este hostname e a série vazia na última comparação.")
                itens.append(_exemplo_comparacao(item))
            if not itens:
                continue
            secoes.append({"secao": campo, "rotulo": PENDING_CATEGORIES.get(campo) or _ROTULOS_EXTRA_SECAO[campo], "ocorrencias": len(itens), "itens": itens})
            if campo in _CAUSAS_SECAO:
                codigo, texto = _CAUSAS_SECAO[campo]
                dias = next((i["dias_sem_acesso"] for i in itens if isinstance(i.get("dias_sem_acesso"), int)), None)
                if campo == "sem_acesso_7_dias" and dias is not None:
                    texto = f"Sem acesso há 7 dias ou mais: a última verificação no Endpoint foi há {dias} dias."
                causas.setdefault(codigo, texto)
            if endpoint["situacao"] == "desconhecida" and campo in ("ausentes_no_endpoint", "ausentes_em_detalhes"):
                endpoint = {"situacao": "ausente" if campo == "ausentes_no_endpoint" else "presente", "origem": "última comparação"}
        if not causas:
            causas["sem_causa_conhecida"] = "Sem causa conhecida pelas regras."

        origem_nome = str(registro.get("nome_pessoa_origem") or "") if registro else ""
        tem_usuario = bool(registro and str(registro.get("usuarios_logados") or "").strip())
        entra: Dict[str, Any] = {
            "situacao": "presente" if origem_nome == "entra" else ("ausente" if tem_usuario else "desconhecida"),
            "origem_do_nome": origem_nome or "nenhuma",
        }
        if registro and registro.get("nome_pessoa"):
            entra["nome_pessoa"] = registro["nome_pessoa"]
        na_simpress: Dict[str, Any] = {"presente": False}
        if registro is not None:
            na_simpress = {k: v for k, v in sanitizar_equipamento(registro).items() if k not in ("contrato", "categoria", "uf")}
            na_simpress["computador"] = na_simpress.pop("apelido")
            na_simpress["presente"] = True
            na_simpress["origem_do_usuario"] = str(registro.get("usuarios_logados_origem") or "")
            if via_s:
                na_simpress["observacao"] = "Localizada com o prefixo 'S' (MacBook): a série do Endpoint não tem o S."

        def montar(limite: int) -> Dict[str, Any]:
            resultado: Dict[str, Any] = {
                "serie": serie,
                "fontes": {"na_simpress": na_simpress, "no_endpoint": endpoint, "entra": entra},
                "secoes_da_ultima_comparacao": [{**s, "itens": s["itens"][:limite]} for s in secoes],
                "causas_provaveis": [{"codigo": c, "texto": t} for c, t in causas.items()],
            }
            if host:
                resultado["computador"] = host
            if evento is not None:
                resultado["horario_ultima_comparacao"] = evento.get("horario", "")
            if falha is not None:
                resultado["mensagem"] = str(falha.get("erro") or falha.get("mensagem") or "Histórico indisponível.")
            return resultado

        resultado = montar(MAX_EXEMPLOS_COMPARACAO)
        for limite in (5, 3, 1, 0):
            if len(json.dumps(resultado, ensure_ascii=False)) <= ORCAMENTO_COMPARACAO:
                break
            resultado = montar(limite)
        return resultado

    def listar_transferencias(self) -> Dict[str, Any]:
        resultado = self._leitura("/api/historico-transferencias")
        itens = _dict(resultado.get("dados")).get("itens")
        if isinstance(itens, list):
            seriais = sorted({str(item.get("serial") or "").strip().upper() for item in itens if isinstance(item, dict)} - {""})
            hostnames: Dict[str, str] = {}
            for serial in seriais:
                if "/" in serial:
                    continue
                ok, equip = self._chamar("GET", f"/api/equipamento/{serial}")
                if ok and isinstance(equip, dict):
                    hostnames[serial] = equip.get("apelido", "")
            for item in itens:
                if isinstance(item, dict):
                    item["hostname"] = hostnames.get(str(item.get("serial") or "").strip().upper(), "")
        return resultado

    def listar_historico_alteracoes(self, limite: Any = 10) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/historico-alteracoes")
        if not ok:
            return {"erro": dados}
        eventos = [e for e in _dict(dados).get("eventos") or [] if isinstance(e, dict)]
        itens = []
        for e in eventos[: self._limite(limite, 10)]:
            item = {k: e[k] for k in (
                "id", "tipo", "serial", "equipamento", "horario", "acao", "motivo", "origem",
                "apelido_anterior", "apelido_novo", "usuario_anterior", "usuario_novo",
                "nome_pessoa_anterior", "nome_pessoa_novo",
            ) if e.get(k) not in (None, "")}
            if e.get("valor_anterior"):
                # Loss warning from the Endpoint: the value is a user or a hostname, depending on the reason.
                item["usuario_anterior" if e.get("motivo") == "usuario_removido" else "apelido_anterior"] = e["valor_anterior"]
            itens.append(item)
        return {"total": len(eventos), "eventos": _aparar(itens)}

    def listar_apelidos_modificados(self, limite: Any = MAX_ITENS_LISTA) -> Dict[str, Any]:
        """Hand-typed nicknames. The server sends {serial: nickname}; a list lets the mask see the 'apelido' key."""
        ok, dados = self._chamar("GET", "/api/equipamento/apelidos-modificados")
        if not ok:
            return {"erro": dados}
        apelidos = _dict(_dict(dados).get("apelidos"))
        corte = self._limite(limite, MAX_ITENS_LISTA)
        itens = [{"serial": str(s), "apelido": str(a)} for s, a in apelidos.items()]
        return {"total": len(itens), "itens": _aparar(itens[:corte]), "omitidos": max(0, len(itens) - corte)}

    def evolucao_atualizacoes(self, anterior: str = "", atual: str = "") -> Dict[str, Any]:
        """What appeared and what was resolved between two inventory updates (default: the two latest)."""
        anterior, atual = str(anterior or "").strip(), str(atual or "").strip()
        if bool(anterior) != bool(atual):
            return {"erro": "Informe os dois identificadores (anterior e atual) ou nenhum."}
        if "/" in anterior or "/" in atual:
            return {"erro": "Identificador do histórico inválido."}
        if not anterior:
            ok, hist = self._chamar("GET", "/api/historico-comparacoes")
            if not ok:
                return {"erro": hist}
            eventos = _dict(hist).get("eventos") or []
            ids = [str(e["id"]) for e in eventos if isinstance(e, dict) and e.get("id") and e.get("tipo") != "restauracao"]
            if len(ids) < 2:
                return {"mensagem": "É preciso ter pelo menos duas atualizações no histórico para comparar."}
            atual, anterior = ids[0], ids[1]
        ok, dados = self._chamar("GET", "/api/operacoes/evolucao", params={"anterior": anterior, "atual": atual})
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        mudancas = _dict(dados.get("mudancas"))
        itens = []
        for situacao, chave in (("novo", "novos"), ("resolvido", "resolvidos")):
            for m in mudancas.get(chave) or []:
                m = _dict(m)
                reg = _dict(m.get("item"))
                itens.append({
                    "situacao": situacao, "secao": m.get("secao", ""),
                    "serie": reg.get("serie") or reg.get("serial") or "",
                    "computador": reg.get("computador", ""), "motivo": reg.get("motivo", ""),
                })
        return {
            "anterior": _aparar(dados.get("anterior", {})), "atual": _aparar(dados.get("atual", {})),
            "contagens": dados.get("contagens", {}),
            "total_itens": len(itens),
            "itens": _aparar(itens[:MAX_ITENS_LISTA]),
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
        }

    def comparar_periodos(self, ponto_a: Any = "", ponto_b: Any = "") -> Dict[str, Any]:
        """Difference between two saved inventory updates, picked by event id, month (AAAA-MM) or date (AAAA-MM-DD)."""
        pontos = [str(ponto_a or "").strip(), str(ponto_b or "").strip()]
        limites: List[Optional[str]] = []
        for ponto in pontos:
            try:
                limite = _limite_do_ponto(ponto)
            except ValueError:
                return {"erro": "Data inexistente. Use um mês (AAAA-MM), uma data válida (AAAA-MM-DD) ou o identificador de uma atualização."}
            if limite is None and not _PONTO_EVENTO.match(ponto):
                return {"erro": "Ponto inválido. Informe o identificador de uma atualização, um mês (AAAA-MM) ou uma data (AAAA-MM-DD)."}
            limites.append(limite)
        ok, hist = self._chamar("GET", "/api/historico-comparacoes")
        if not ok:
            return {"erro": hist}
        # Only real inventory updates hold a comparison: no restorations, no events rebuilt from shared notes.
        validos = sorted(
            (e for e in _dict(hist).get("eventos") or []
             if isinstance(e, dict) and e.get("id") and e.get("tipo") != "restauracao"
             and not e.get("somente_anotacoes_sincronizadas") and _instante(e.get("horario")) != float("-inf")),
            key=lambda e: _instante(e.get("horario")), reverse=True,
        )
        disponiveis = [{"id": str(e["id"]), "horario": str(e.get("horario") or "")} for e in validos[:MAX_ITENS_LISTA]]
        eventos: List[Dict[str, Any]] = []
        for ponto, limite in zip(pontos, limites):
            if limite is None:
                evento = next((e for e in validos if str(e["id"]) == ponto), None)
            else:
                evento = next((e for e in validos if str(e["horario"])[:10] <= limite), None)
            if evento is None:
                return {"erro": f"Não há atualização do histórico para o ponto '{ponto}'.", "atualizacoes_disponiveis": disponiveis}
            eventos.append(evento)
        if eventos[0]["id"] == eventos[1]["id"]:
            return {
                "mensagem": "Os dois pontos correspondem à mesma atualização do histórico; não há diferença a mostrar.",
                "atualizacao": {"id": str(eventos[0]["id"]), "horario": str(eventos[0]["horario"])},
            }
        ordenados = sorted(zip(pontos, limites, eventos), key=lambda p: _instante(p[2]["horario"]))
        ok, dados = self._chamar(
            "GET", "/api/operacoes/evolucao",
            params={"anterior": str(ordenados[0][2]["id"]), "atual": str(ordenados[1][2]["id"])},
        )
        if not ok:
            return {"erro": dados}
        mudancas = _dict(_dict(dados).get("mudancas"))
        secoes: Dict[str, Dict[str, Any]] = {}
        for situacao in ("novos", "continuam", "resolvidos"):
            for mudanca in mudancas.get(situacao) or []:
                mudanca = _dict(mudanca)
                item = _dict(mudanca.get("item"))
                if str(mudanca.get("categoria") or "").startswith("ausentes_") and is_sebrae_owned_notebook_serial(item.get("serie") or item.get("serial")):
                    continue  # AGENTS.md: the Sebrae notebook series stay out of the unmatched lists
                secao = secoes.setdefault(str(mudanca.get("secao") or "Outras"), {"novos": [], "continuam": 0, "resolvidos": []})
                if situacao == "continuam":
                    secao["continuam"] += 1
                else:
                    secao[situacao].append(item)
        ordem = list(dict.fromkeys(PENDING_CATEGORIES.values()))
        rotulos = sorted(secoes, key=lambda r: ordem.index(r) if r in ordem else len(ordem))

        def montar(exemplos: int) -> Dict[str, Any]:
            linhas = []
            for rotulo in rotulos:
                novos, resolvidos, continuam = secoes[rotulo]["novos"], secoes[rotulo]["resolvidos"], secoes[rotulo]["continuam"]
                linha: Dict[str, Any] = {
                    "secao": rotulo, "anterior": continuam + len(resolvidos), "atual": continuam + len(novos),
                    "novos": len(novos), "resolvidos": len(resolvidos), "continuam": continuam,
                }
                if novos and exemplos:
                    linha["exemplos_novos"] = [_exemplo_comparacao(i) for i in novos[:exemplos]]
                if resolvidos and exemplos:
                    linha["exemplos_resolvidos"] = [_exemplo_comparacao(i) for i in resolvidos[:exemplos]]
                linhas.append(linha)
            saida_pontos = []
            for ponto, limite, evento in ordenados:
                saida: Dict[str, Any] = {"pedido": ponto, "evento_id": str(evento["id"]), "horario": str(evento["horario"])}
                if limite is not None and str(evento["horario"])[: len(ponto)] != ponto:
                    saida["observacao"] = f"Sem atualização em {ponto}; usada a mais recente até essa data."
                resumo = _dict(evento.get("resumo"))
                for campo, destino in (("total_endpoint", "linhas_no_endpoint"), ("total_detalhes", "linhas_na_simpress")):
                    if isinstance(resumo.get(campo), int):
                        saida[destino] = resumo[campo]
                saida_pontos.append(saida)
            return {
                "ponto_anterior": saida_pontos[0], "ponto_atual": saida_pontos[1],
                "total_novos": sum(len(s["novos"]) for s in secoes.values()),
                "total_resolvidos": sum(len(s["resolvidos"]) for s in secoes.values()),
                "secoes": linhas, "exemplos_por_lista": exemplos,
                "limitacoes": [
                    "Compara só atualizações salvas no histórico de planilhas; mês e data viram a atualização mais recente até o fim do período. Não há retrato do inventário em outras datas.",
                    "novos = apareceram na seção (piora); resolvidos = saíram dela (melhora). Não há lista item a item de apelidos atualizados, de mudanças de usuário nem de alterações de equipamento entre os dois pontos.",
                ],
            }

        resultado = montar(MAX_EXEMPLOS_COMPARACAO)
        for exemplos in (5, 3, 1, 0):
            if len(json.dumps(resultado, ensure_ascii=False)) <= ORCAMENTO_COMPARACAO:
                break
            resultado = montar(exemplos)
        return resultado

    def listar_eventos_comparacao(self, limite: Any = 10) -> Dict[str, Any]:
        """Ids of the history events (newest first); the destructive tools need them."""
        ok, dados = self._chamar("GET", "/api/historico-comparacoes")
        if not ok:
            return {"erro": dados}
        eventos = [e for e in _dict(dados).get("eventos") or [] if isinstance(e, dict)]
        itens = [{k: e.get(k) for k in ("id", "horario", "tipo", "restauravel") if e.get(k) is not None} for e in eventos[: self._limite(limite, 10)]]
        return {"total": len(eventos), "eventos": _aparar(itens)}

    def evento_comparacao(self, evento_id: str) -> Optional[Dict[str, Any]]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return None
        ok, dados = self._chamar("GET", "/api/historico-comparacoes")
        eventos = _dict(dados).get("eventos") if ok else None
        return next((e for e in eventos or [] if isinstance(e, dict) and e.get("id") == evento_id), None)

    def evento_alteracao(self, evento_id: str) -> Optional[Dict[str, Any]]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return None
        ok, dados = self._chamar("GET", "/api/historico-alteracoes")
        eventos = _dict(dados).get("eventos") if ok else None
        return next((e for e in eventos or [] if isinstance(e, dict) and e.get("id") == evento_id), None)

    def _removidos_endpoint(self) -> Optional[List[Dict[str, Any]]]:
        ok, dados = self._chamar("GET", "/api/endpoint/hostnames-removidos")
        if not ok:
            return None
        return [e for e in _dict(dados).get("removidos") or [] if isinstance(e, dict)]

    def listar_hostnames_removidos(self, limite: Any = MAX_ITENS_LISTA) -> Dict[str, Any]:
        removidos = self._removidos_endpoint()
        if removidos is None:
            return {"erro": "Não foi possível consultar os hostnames removidos do Endpoint."}
        corte = self._limite(limite, MAX_ITENS_LISTA)
        itens = [{k: str(e.get(k) or "") for k in ("serie", "hostname", "removido_em")} for e in removidos[:corte]]
        return {"total": len(removidos), "itens": _aparar(itens), "omitidos": max(0, len(removidos) - corte)}

    def hostname_removido(self, serie: str, hostname: str) -> bool:
        """True when the pair is in the discarded list (same case-insensitive match the server uses)."""
        par = (str(serie).strip().casefold(), str(hostname).strip().casefold())
        return any((str(e.get("serie") or "").strip().casefold(), str(e.get("hostname") or "").strip().casefold()) == par for e in self._removidos_endpoint() or [])

    def divergencia_apelido_manual(self, evento_id: str, serial: str) -> Optional[Dict[str, Any]]:
        evento_id, chave = str(evento_id or "").strip(), str(serial or "").strip().upper()
        if not _ID_ROTA.match(evento_id) or not chave:
            return None
        ok, dados = self._chamar("GET", f"/api/historico-comparacoes/{evento_id}")
        if not ok:
            return None
        divergencias = _dict(_dict(_dict(dados).get("evento")).get("comparacao")).get("divergencias_apelidos_manuais") or []
        return next((d for d in divergencias if isinstance(d, dict) and str(d.get("serie") or "").strip().upper() == chave), None)

