"""The Sebrae / F5 tools of the assistant's API (`SebraeMixin`, mixed into `SimpressApi` in `assistant_api`).

Leaf module: shared helpers come from `assistant_api_comum`; nothing here may import `assistant_api`.
"""

import re
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

from domains import sebrae_finalizacao as fin
from domains.assistant_api_comum import MAX_ITENS_LISTA, MAX_TEXTO_CHAMADO, _ID_ROTA, _aparar, _marcas_de, _motivo_codigo, _observacao_de
from domains.assistant_lgpd import limpar_texto_sensivel
from domains.assistant_transporte import ArquivoUpload
from domains.assistant_validacao import _dict
from domains.coverage import dobrar
from domains.inventory_comparison import normalize_reference_value
from domains.sebrae_observacoes import numero_observacao_valido

MAX_DESCRICAO_FINALIZACAO = 4000  # same limit as domains.sebrae_finalizacao.MAX_DESCRICAO


def _os_nova_publica(valor: Any) -> Optional[Dict[str, str]]:
    """``{os, tipo}`` of the F5's ``os_nova`` (OS newer than the one in E, or found for a ticket without OS; ``sem_relacao``: the OS in E itself); ``None`` without it."""
    sugestao = _dict(valor)
    alvo = _dict(sugestao.get("atual") if sugestao.get("tipo") == "sem_relacao" else sugestao.get("nova"))
    return {"os": str(alvo.get("os") or ""), "tipo": str(sugestao.get("tipo") or "")} if alvo.get("os") else None


# --- Sebrae: leitura dos antigos e aviso da cópia pendente (allowlist, só contagens e códigos) -------------
ORIENTACAO_SHAREPOINT = (
    "O envio manual ao SharePoint (Enviar ao SharePoint / Tentar substituir de novo) é feito por você na tela Chamados; "
    "o Assistente não dispara esse envio. Já a finalização de um chamado (finalizar_chamado_softexpert), quando dá certo, "
    "grava no Dashboard e o substitui no SharePoint, ou deixa uma cópia pendente se o envio falhar."
)


_DATA_HORA_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$")


def _contagem(valor: Any) -> Optional[int]:
    """A count only: a non-negative int, or the size of a list/dict (``lidos`` is a list of numbers, ``falhas`` a dict)."""
    if isinstance(valor, (list, dict)):
        return len(valor)
    return valor if isinstance(valor, int) and not isinstance(valor, bool) and valor >= 0 else None


def _leitura_antigos_segura(dados: Dict[str, Any]) -> Dict[str, Any]:
    """GET /api/sebrae/antigos/ler reduced to the current state plus counts of the last read (sebrae_antigos_resultado.json)."""
    rodando = bool(dados.get("em_andamento"))
    resposta: Dict[str, Any] = {"em_andamento_agora": rodando, "fonte_em_andamento": "estado_atual"}
    resultado = dados.get("resultado")
    if not isinstance(resultado, dict):
        resposta["ultima_leitura"] = None
        resposta["mensagem"] = ("Nenhuma leitura dos chamados antigos registrada ainda." if not rodando else
                                "A primeira leitura dos chamados antigos está em andamento; ainda não há resultado registrado.")
        return resposta
    ultima: Dict[str, Any] = {"fonte": "ultima_leitura_registrada", "concluida": resultado.get("concluido") is True}
    for chave in ("total", "lidos", "falhas", "sem_utic", "ja_lidos"):
        ultima[chave] = _contagem(resultado.get(chave))
    em = resultado.get("em")
    ultima["iniciada_em"] = em if isinstance(em, str) and _DATA_HORA_ISO.fullmatch(em) else None
    resposta["ultima_leitura"] = ultima
    if rodando:
        resposta["mensagem"] = ("Há uma leitura dos antigos em andamento agora; as contagens podem ser parciais desta leitura "
                                "ou ainda da anterior.")
    elif ultima["concluida"]:
        resposta["mensagem"] = "Última leitura dos antigos concluída (histórico, não é o estado de agora)."
    else:
        resposta["mensagem"] = "A última leitura dos antigos não terminou (cancelada, com falha ou servidor reiniciado); as contagens são parciais."
    return resposta


def _aviso_pendente_seguro(aviso: Any) -> Optional[Dict[str, Any]]:
    """The pending-copy notice without its local path, free-text reason or suggestions; ``None`` when nothing is pending."""
    if not isinstance(aviso, dict) or not aviso:
        return None
    return {
        "pendente": True,
        "copia_no_sharepoint": aviso.get("copia_sharepoint") is True,
        "motivo_codigo": _motivo_codigo("falha", None, [str(aviso.get("motivo") or "")]),
        "orientacao": "O Dashboard não foi substituído no SharePoint e há uma cópia pendente. " + ORIENTACAO_SHAREPOINT,
    }


_STATUS_FINALIZACAO = frozenset({fin.STATUS_OK, fin.STATUS_OUTRO_TECNICO, fin.STATUS_JA_FINALIZADO, fin.STATUS_NAO_ENCONTRADO, fin.STATUS_ERRO,
                                 fin.STATUS_INCERTO, fin.STATUS_SEM_DESCRICAO, fin.STATUS_SEM_ENCERRAMENTO, fin.STATUS_PRONTO})


# Codes `sebrae_fechar`/`sebrae_softexpert` write in `motivo` (scripts/sebrae_softexpert.py MOTIVO_*); anything else is matched as text.
_MOTIVOS_FINALIZACAO = frozenset({"numero_nao_confere", "titulo_nao_confere", "nao_encontrado_na_lista", "formulario_indisponivel",
                                  "confirmacao_inesperada", "erro_inesperado", "softexpert_indisponivel", "sessao_expirada"})


_ENCERRADO_EM = re.compile(r"^\d{2}/\d{2}/\d{4} \d{2}:\d{2}$")


def _resultado_finalizacao_seguro(item: Dict[str, Any]) -> Dict[str, Any]:
    """One item of the last `fechar` run, allowlisted: UTIC number, known status, reason code; no free text."""
    numero = str(item.get("numero") or "")
    status = str(item.get("status") or "")
    status = status if status in _STATUS_FINALIZACAO else "desconhecido"
    motivo_codigo: Optional[str] = None
    if status == fin.STATUS_ERRO:
        motivo = str(item.get("motivo") or "")
        motivo_codigo = motivo if motivo in _MOTIVOS_FINALIZACAO else _motivo_codigo("falha", None, [motivo, str(item.get("mensagem") or "")])
    encerrado = str(item.get("encerrado_em") or "")
    return {
        "numero": numero if re.fullmatch(r"UTIC-\d{4}-\d{1,24}", numero) else None,
        "status": status,
        "motivo_codigo": motivo_codigo,
        "encerrado_em": encerrado if _ENCERRADO_EM.fullmatch(encerrado) else None,
    }


class SebraeMixin:
    if TYPE_CHECKING:  # members of `SimpressApi` used here; declared for mypy only, never defined at runtime
        def _chamar(
            self, metodo: str, caminho: str, params: Optional[Dict[str, Any]] = None, corpo: Union[Dict[str, Any], ArquivoUpload, None] = None,
        ) -> Tuple[bool, Any]: ...

        def _leitura(self, caminho: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]: ...

        @staticmethod
        def _limite(limite: Any, padrao: int) -> int: ...

        def _observacoes_os(self) -> Tuple[Dict[str, str], Optional[str]]: ...

        def _marcas_finalizacao(self) -> Tuple[Dict[str, List[Dict[str, Any]]], Optional[str]]: ...

    def resumo_sebrae(self) -> Dict[str, Any]:
        return self._leitura("/api/automacao/sebrae/resumo")

    def chamados_novos_sebrae(self) -> Dict[str, Any]:
        """New Sebrae tickets read from SoftExpert. Read only: nothing is saved or exported."""
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        importado = dados.get("importado") if isinstance(dados.get("importado"), dict) else None
        novos = dados.get("novos")
        if not isinstance(novos, dict):
            return {"dashboard_importado": importado is not None,
                    "mensagem": "Ainda não há leitura de chamados novos do Sebrae."}

        def texto(valor: Any) -> str:
            return limpar_texto_sensivel(valor)[:MAX_TEXTO_CHAMADO]

        itens = []
        for f in novos.get("formulario") or []:
            if not isinstance(f, dict):
                continue
            linha = _dict(f.get("linha"))
            cruzamento = _dict(f.get("cruzamento"))
            itens.append({
                "numero": str(f.get("numero") or ""),
                "data": str(linha.get("P") or ""),
                "titulo": texto(linha.get("G")),
                "descricao": texto(linha.get("H")),
                "solicitante": texto(linha.get("I")),
                "detalhes": texto(linha.get("F")),
                "serie": str(linha.get("K") or ""),
                "modelo": str(linha.get("L") or ""),
                "cidade": str(linha.get("N") or ""),
                "os": str(linha.get("E") or ""),
                "cruzamento": str(cruzamento.get("status") or ""),
                "candidatos": cruzamento.get("candidatos", 0),
                # Sugestões do programa para A, B e J: o usuário confirma na tela (botão Usar); nada é salvo daqui.
                "sugestao_responsavel": str(f.get("sugestao_responsavel") or ""),
                "sugestao_categoria": str(f.get("sugestao_categoria") or ""),
                "sugestao_tipo": str(f.get("sugestao_tipo") or ""),
            })
        pendentes = [p for p in novos.get("pendentes") or [] if isinstance(p, dict)]
        erros = _dict(novos.get("erros"))
        return _aparar({
            "dashboard_importado": importado and {k: importado.get(k, "") for k in ("arquivo", "importado_em", "total")},
            "lidos_em": novos.get("lidos_em", ""),
            "ignorados": novos.get("ignorados", 0),
            "total_novos": len(itens),
            "chamados": [_aparar(i) for i in itens[:MAX_ITENS_LISTA]],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
            "pendentes_total": len(pendentes),
            "pendentes": [{"numero": str(p.get("numero") or ""), "motivo": str(p.get("motivo") or "")}
                          for p in pendentes[:MAX_ITENS_LISTA]],
            "erros": [{"numero": str(n), "erro": str(m)} for n, m in list(erros.items())[:MAX_ITENS_LISTA]],
        })

    def proximo_passo_sebrae(self) -> Dict[str, Any]:
        """Where the user is in the Dashboard Sebrae flow and what comes next. Read only; the rule is the server's, not the model's."""
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        importado = dados.get("importado") if isinstance(dados.get("importado"), dict) else None
        novos = dados.get("novos") if isinstance(dados.get("novos"), dict) else None
        if importado is None:
            passo, quem = "Rodar \"Baixar, importar e buscar\" (rotina 'dashboard', aba Automação).", "assistente_ou_usuario"
        elif not importado.get("atualizavel"):
            passo, quem = "Importar o Dashboard de novo: a cópia guardada não permite atualizar.", "assistente_ou_usuario"
        elif novos is None:
            passo, quem = "Buscar os chamados novos (\"Buscar chamados novos\" no painel Chamados, ou a rotina 'dashboard').", "assistente_ou_usuario"
        elif not importado.get("saida_pronta"):
            passo, quem = "Preencher os chamados e usar \"Atualizar Dashboard\" no painel Chamados.", "usuario"
        else:
            passo, quem = ("O Dashboard atualizado já foi gerado e \"Atualizar Dashboard\" já tenta enviá-lo ao SharePoint (resultado na aba Automação). "
                           "Se o envio não iniciou ou falhou, usar \"Enviar ao SharePoint\" "
                           "no painel Chamados (o login é manual). Se o envio avisar que o SharePoint mudou, o arquivo gerado não vale mais: "
                           "repetir Baixar, importar e buscar, Atualizar Dashboard e Enviar ao SharePoint.", "usuario")
        return {
            "dashboard_importado": importado is not None,
            "atualizavel": bool(importado and importado.get("atualizavel")),
            "chamados_novos": len(novos.get("formulario") or []) if novos else None,
            "dashboard_atualizado_gerado": bool(importado and importado.get("saida_pronta")),
            "proximo_passo": passo,
            "quem_executa": quem,
        }

    def chamados_antigos_abertos_sebrae(self, busca: Any = None) -> Dict[str, Any]:
        """Old Dashboard tickets with Status EM ABERTO or empty (OS: E in the sheet, `os_sugerida` found by the serial, `os_nova` newer OS of the serial or OS found for a ticket without one: number and kind only). Read only.

        `busca` (optional) keeps only the tickets whose number, title, description, requester, serial or OS has every word of it
        (case and accents ignored). The list keeps the column C order of the F5 and is cut at MAX_ITENS_LISTA.
        """
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        importado = dados.get("importado") if isinstance(dados.get("importado"), dict) else None
        if importado is None:
            return {"dashboard_importado": False, "mensagem": "Ainda não há Dashboard do Sebrae importado."}
        itens = []
        for a in importado.get("abertos") or []:
            if not isinstance(a, dict):
                continue
            v = _dict(a.get("valores"))
            leitura = _dict(a.get("leitura_softexpert"))
            itens.append({
                "numero": str(a.get("numero") or ""),
                # The only opening date an old ticket has (SoftExpert read); empty when it was not read.
                "data": str(leitura.get("habilitada_em") or ""),
                "titulo": limpar_texto_sensivel(a.get("titulo"))[:MAX_TEXTO_CHAMADO],
                "descricao": limpar_texto_sensivel(a.get("descricao"))[:MAX_TEXTO_CHAMADO],
                # Column I of the sheet; the mask needs this key to hide the name wherever it shows up in the free text.
                "solicitante": limpar_texto_sensivel(a.get("usuario") or leitura.get("solicitante"))[:MAX_TEXTO_CHAMADO],
                "responsavel": limpar_texto_sensivel(v.get("A")),
                "categoria": limpar_texto_sensivel(v.get("B")),
                "status": str(v.get("D") or ""),
                "tipo": str(v.get("J") or ""),
                "serie": str(_dict(a.get("automaticos")).get("K") or ""),
                "os": str(_dict(a.get("automaticos")).get("E") or ""),
                "os_sugerida": str(_dict(a.get("automaticos_sugeridos")).get("E") or ""),
                # Only the OS number and the kind (troca, sugestao, sem_os): no OS text, no name; accept/refuse stay on the F5 card.
                "os_nova": _os_nova_publica(a.get("os_nova") or a.get("os_sem_relacao")),
                # True: not in SoftExpert's task center on the last read (e.g. closed by another technician); the F5 card is red.
                "nao_encontrado_softexpert": a.get("nao_encontrado_softexpert") is True,
            })
        palavras = dobrar(busca).split() if isinstance(busca, str) else []
        encontrados = [
            i for i in itens
            if not palavras or all(p in dobrar(" ".join(str(i[k]) for k in ("numero", "titulo", "descricao", "solicitante", "serie", "os"))) for p in palavras)
        ]
        # Same order as the F5 (Tabela3 sorted by column C), cut at the start; the counts come before the list because _msg_tool cuts the end
        # of a big answer at MAX_CARACTERES_RESPOSTA. `busca` finds a ticket that falls outside the first twenty.
        primeiros = encontrados[:MAX_ITENS_LISTA]
        return _aparar({
            "dashboard_importado": {k: importado.get(k, "") for k in ("arquivo", "importado_em", "total")},
            "total_abertos": len(itens),
            "sem_responsavel": sum(1 for i in itens if not i["responsavel"]),
            "encontrados": len(encontrados),
            "omitidos": len(encontrados) - len(primeiros),
            "abertos": [_aparar(i) for i in primeiros],
        })

    def chamados_com_os_sebrae(self) -> Dict[str, Any]:
        """Same pairing rules as montarParesChamadoOs in frontend/src/paineis/paineis-dados/chamados-os.ts, plus the F6 note. Read only (the screen shows one pair at a time in the "Chamado × OS" window)."""
        ok, sebrae = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return {"erro": sebrae}
        ok, relatorio = self._chamar("GET", "/api/operacoes/chamados")
        if not ok:
            return {"erro": relatorio}
        notas, aviso_notas = self._observacoes_os()
        marcas, aviso_marcas = self._marcas_finalizacao()
        sebrae = _dict(sebrae)
        importado = _dict(sebrae.get("importado"))

        def texto(valor: Any) -> str:
            return str(valor if valor is not None else "").strip()

        def ordem(valor: Any) -> str:
            return re.sub(r"\s+", "", str(valor or "")).upper()

        # New and old exclude the tickets the site finalized (importado.finalizados), like the F5.
        finalizados = {str(_dict(f).get("numero")) for f in importado.get("finalizados") or [] if _dict(f).get("numero") is not None}
        candidatos = []
        for f in _dict(sebrae.get("novos")).get("formulario") or []:
            f = _dict(f)
            linha = _dict(f.get("linha"))
            candidatos.append((f.get("numero"), texto(f.get("numero")), texto(linha.get("G")), "novo", texto(linha.get("K")), texto(linha.get("E"))))
        for a in importado.get("abertos") or []:
            a = _dict(a)
            chave, auto, sug = a.get("numero"), _dict(a.get("automaticos")), _dict(a.get("automaticos_sugeridos"))
            numero = texto(a.get("chamado")) if str(chave or "").startswith("linha:") else texto(chave)
            titulo = texto(a.get("titulo")) or texto(_dict(a.get("leitura_softexpert")).get("titulo"))
            candidatos.append((chave, numero, titulo, "em aberto", texto(auto.get("K") or sug.get("K")), texto(auto.get("E") or sug.get("E"))))

        registros: Dict[str, Dict[str, Any]] = {}
        series_por_os: Dict[str, set] = {}
        for r in _dict(relatorio).get("chamados") or []:
            r = _dict(r)
            chave_serie = normalize_reference_value(r.get("serie"))
            if not chave_serie:
                continue
            registros.setdefault(chave_serie, r)
            ordens = [_dict(o).get("ordem_servico") for o in r.get("oracle") or []] + list(_dict(r.get("simpress")).get("ordens_servico") or [])
            for o in ordens:
                if ordem(o):
                    series_por_os.setdefault(ordem(o), set()).add(chave_serie)

        itens = []
        for chave, numero, titulo, situacao, serie, os_ in candidatos:
            if chave is None or str(chave) in finalizados or not os_ or os_ == "—":
                continue
            alvo, chave_serie = ordem(os_), normalize_reference_value(serie)
            # MacBook: the other spelling (with/without the leading `S`) only when the exact serial is not in the report.
            registro = registros.get(chave_serie) or (
                registros.get(chave_serie[1:] if chave_serie.startswith("S") else f"S{chave_serie}") if chave_serie else None) or {}
            if not registro:
                # No serial (or serial not in the report): link by the OS only when it is in a single serial; a found serial without the OS is a real mismatch.
                series = series_por_os.get(alvo) or set()
                registro = registros[next(iter(series))] if len(series) == 1 else {}
            oracle = [o for o in registro.get("oracle") or [] if isinstance(o, dict) and ordem(o.get("ordem_servico")) == alvo]
            simpress = _dict(registro.get("simpress"))
            na_simpress = any(ordem(o) == alvo for o in simpress.get("ordens_servico") or [])
            fontes = (["oracle"] if oracle else []) + (["simpress"] if na_simpress else [])
            encontrada = bool(fontes)
            status_oracle = " / ".join(
                s for s in (" · ".join(str(v) for v in (o.get("status"), o.get("sub_status")) if v) for o in oracle) if s)
            # The F6 saves the note with the report's serial, which differs from K in the MacBook fallback.
            nota = _observacao_de(notas, registro.get("serie") or serie, os_)
            marca = _marcas_de(marcas, registro.get("serie") or serie, os_, numero)
            itens.append({
                "utic": numero,
                "titulo": limpar_texto_sensivel(titulo)[:MAX_TEXTO_CHAMADO],
                "situacao": situacao,
                "serie": serie,
                "serie_relatorio": texto(registro.get("serie")) if encontrada else "",
                "os": os_,
                "encontrada": encontrada,
                "mensagem": "" if encontrada else "Série não encontrada na importação atual.",
                "fontes": fontes,
                "status_oracle": status_oracle,
                # Simpress status is per serial: only shown when this OS is there, so another OS's status never shows.
                "status_simpress": " / ".join(str(s) for s in simpress.get("status") or [] if s) if na_simpress else "",
                "relacao": texto(registro.get("relacao")) if encontrada else "",
                "observacao_os": limpar_texto_sensivel(nota)[:MAX_TEXTO_CHAMADO],
                "marca_finalizacao": marca[0] if marca else None,
            })
        resultado: Dict[str, Any] = {
            "total": len(itens),
            "encontradas": sum(1 for i in itens if i["encontrada"]),
            "chamados": itens[:MAX_ITENS_LISTA],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
        }
        if len(itens) > MAX_ITENS_LISTA:
            resultado["aviso"] = f"Mostrando só os {MAX_ITENS_LISTA} primeiros; peça um chamado específico. Na tela, cada chamado abre ao lado da OS na janela \"Chamado × OS\" (botão da OS no cartão do chamado na aba Chamados, F5, ou UTIC da OS na aba OS, F6)."
        if aviso_notas:
            resultado["aviso_observacoes"] = aviso_notas
        if aviso_marcas:
            resultado["aviso_marcas"] = aviso_marcas
        return _aparar(resultado)

    def chamados_destaque_sebrae(self) -> Dict[str, Any]:
        """Sebrae tickets the user marked as highlight, with the local note. Read only; notes without highlight stay out."""
        ok, dados = self._chamar("GET", "/api/sebrae/observacoes")
        if not ok:
            return {"erro": dados}
        todas = _dict(_dict(dados).get("observacoes"))
        itens = [
            {
                "numero": str(numero)[:40],
                "observacao": limpar_texto_sensivel(e.get("observacao"))[:MAX_TEXTO_CHAMADO],
                "destaque_em": str(e.get("destaque_em") or "")[:40],
            }
            for numero, e in todas.items() if numero_observacao_valido(numero) and isinstance(e, dict) and e.get("destaque") is True
        ]
        itens.sort(key=lambda i: i["destaque_em"], reverse=True)
        return _aparar({
            "total_destaques": len(itens),
            "destaques": [_aparar(i) for i in itens[:MAX_ITENS_LISTA]],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
        })

    def _abertos_sebrae(self) -> Tuple[Optional[List[Dict[str, Any]]], Any]:
        """(open old tickets of the imported Dashboard, None) or (None, error text); [] when no Dashboard is imported."""
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return None, dados
        importado = _dict(dados).get("importado")
        if not isinstance(importado, dict):
            return [], None
        return [{**a, "_versao_importacao": str(importado.get("versao") or "")} for a in importado.get("abertos") or [] if isinstance(a, dict)], None

    def situacao_finalizacao_sebrae(self) -> Dict[str, Any]:
        """Open tickets with a UTIC number: description saved, PDF and SoftExpert result; plus the last `fechar` run. Read only."""
        abertos, erro = self._abertos_sebrae()
        if abertos is None:
            return {"erro": erro}
        itens = []
        for a in abertos:
            numero = str(a.get("numero") or "")
            if not re.fullmatch(r"UTIC-\d{4}-\d+", numero):
                continue
            se = _dict(a.get("softexpert"))
            status_fin = str(_dict(se.get("finalizacao")).get("status") or "")
            itens.append({
                "numero": numero,
                "titulo": limpar_texto_sensivel(a.get("titulo"))[:MAX_TEXTO_CHAMADO],
                "tem_descricao": bool(str(se.get("descricao_finalizacao") or "").strip()),
                "pdf": _dict(se.get("pdf")).get("nome") or "",
                "resultado_softexpert": status_fin if not status_fin or status_fin in _STATUS_FINALIZACAO else "desconhecido",
            })
        ok, dados = self._chamar("GET", "/api/sebrae/finalizar-softexpert")
        ultima: Dict[str, Any] = {}
        if ok:
            dados = _dict(dados)
            resultado = _dict(dados.get("resultado"))
            ultima = {
                "em_andamento": bool(dados.get("em_andamento")),
                "resultados": [
                    _resultado_finalizacao_seguro(r) for r in resultado.get("resultados") or [] if isinstance(r, dict)
                ][:MAX_ITENS_LISTA],
                "aviso_sharepoint": _aviso_pendente_seguro(dados.get("sharepoint")),
            }
        return _aparar({
            "chamados_abertos_com_utic": len(itens),
            "chamados": itens[:MAX_ITENS_LISTA],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
            "ultima_finalizacao": ultima,
        })

    def status_leitura_antigos_sebrae(self) -> Dict[str, Any]:
        """Whether the old-tickets read runs now, plus the counts of the last one (allowlist: no numbers, names or texts)."""
        ok, dados = self._chamar("GET", "/api/sebrae/antigos/ler")
        if not ok:
            return {"erro": dados}
        return _leitura_antigos_segura(_dict(dados))

    def chamado_para_finalizar(self, numero: Any, descricao: Any = "", encerramento: Any = "") -> Dict[str, Any]:
        """The data the card and the action use. ValueError (shown to the user) when the ticket cannot be finalized.

        ``encerramento`` = DT ENCERRAMENTO (R) "dd/MM/aaaa HH:mm" typed by the user (rule of 24/11/2026: never the current time)."""
        numero = str(numero or "").strip().upper()
        if not re.fullmatch(r"UTIC-\d{4}-\d+", numero):
            raise ValueError("Informe o número do chamado no formato UTIC-AAAA-NNNN.")
        abertos, erro = self._abertos_sebrae()
        if abertos is None:
            raise ValueError(str(erro))
        item = next((a for a in abertos if str(a.get("numero") or "") == numero), None)
        if item is None:
            raise ValueError(f"{numero} não está entre os chamados antigos em aberto do Dashboard importado. Nada foi feito.")
        se = _dict(item.get("softexpert"))
        if _dict(se.get("finalizacao")).get("status") in fin.STATUS_FINALIZADOS:
            raise ValueError(f"{numero} já foi finalizado (no SoftExpert ou por outro técnico). Nada foi feito.")
        quando = fin.encerramento_valido(encerramento)
        if not quando:  # vazio, fora do formato ou só a data: a coluna R só é gravada com data e hora
            raise ValueError(
                f"Falta a DT ENCERRAMENTO (coluna R) de {numero}: peça ao usuário a data e a hora de encerramento no formato "
                "dd/MM/aaaa HH:mm (nunca use a hora atual). Nada foi finalizado."
            )
        texto =str(descricao or "").strip() or str(se.get("descricao_finalizacao") or "").strip()
        if not texto:
            raise ValueError(f"Falta a descrição para finalizar {numero}: peça ao usuário o texto de \"Detalhes do Atendimento Realizado\".")
        if len(texto) > MAX_DESCRICAO_FINALIZACAO:
            raise ValueError(f"A descrição pode ter no máximo {MAX_DESCRICAO_FINALIZACAO} caracteres.")
        if re.search(r"\[(?:PESSOA_\d+|E-MAIL OCULTADO|TELEFONE OCULTADO|DADO SENSÍVEL OMITIDO)\]", texto):
            raise ValueError("A descrição tem dado ocultado pela privacidade (nome, e-mail ou telefone); peça ao usuário para escrevê-la no campo do chamado, na tela Chamados.")
        return {
            "versao_importacao": item.get("_versao_importacao", ""), "numero": numero, "descricao": texto, "nova": bool(str(descricao or "").strip()),
            "pdf": str(_dict(se.get("pdf")).get("nome") or ""), "encerramento": quando,
        }

    def _localizar_chamado_sebrae(self, numero: Any) -> Tuple[str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """(number, old open ticket or None, new ticket of the last search or None); at least one is set.

        ValueError (shown to the user) when the number is malformed, the Dashboard was not imported or the ticket is in neither list."""
        numero = str(numero or "").strip().upper()
        if not re.fullmatch(r"UTIC-\d{4}-\d+", numero):
            raise ValueError("Informe o número do chamado no formato UTIC-AAAA-NNNN.")
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            raise ValueError(str(dados))
        dados = _dict(dados)
        importado = _dict(dados.get("importado"))
        if not importado:
            raise ValueError("Importe o Dashboard na tela Chamados antes. Nada foi feito.")
        antigo = next((a for a in importado.get("abertos") or [] if isinstance(a, dict) and a.get("numero") == numero), None)
        novo = next((f for f in _dict(dados.get("novos")).get("formulario") or [] if isinstance(f, dict) and f.get("numero") == numero), None)
        if antigo is None and novo is None:
            raise ValueError(f"{numero} não está entre os chamados em aberto nem entre os novos da última busca. Nada foi feito.")
        return numero, antigo, novo

    def chamado_para_anexar_pdf(self, numero: Any) -> Dict[str, Any]:
        """Data for the card and the action of "anexar PDF ao chamado" (08/11/2026). ValueError (shown to the user) when it cannot be attached.

        Same tickets the screen accepts: old open ticket of the imported Dashboard (read or not) or new ticket of the last search."""
        numero, antigo, novo = self._localizar_chamado_sebrae(numero)
        se = _dict(_dict(antigo if antigo is not None else novo).get("softexpert"))
        if _dict(se.get("finalizacao")).get("status") in fin.STATUS_FINALIZADOS:
            raise ValueError(f"{numero} já foi finalizado (no SoftExpert ou por outro técnico); não dá mais para anexar PDF. Nada foi feito.")
        return {"numero": numero, "pdf_atual": str(_dict(se.get("pdf")).get("nome") or "")}

    def anexar_pdf_chamado_sebrae(self, numero: Any, nome: str, dados: bytes) -> Dict[str, Any]:
        """Same call as the PDF field of the ticket card: the existing route validates, stores and replaces. Local only until the ticket is finalized."""
        try:
            alvo = self.chamado_para_anexar_pdf(numero)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, resposta = self._chamar("POST", f"/api/sebrae/chamados/{alvo['numero']}/anexo", corpo=ArquivoUpload("file", nome, dados))
        if not ok:
            return {"sucesso": False, "erro": resposta}
        return {"sucesso": True, "mensagem": f"PDF anexado a {alvo['numero']}, só neste site. Ele vai ao SoftExpert apenas quando o chamado for finalizado."}

    def chamado_para_editar_descricao(self, numero: Any, descricao: Any = "") -> Dict[str, Any]:
        """Data for the card and the action of "editar descrição" (lápis da tela Chamados). ValueError (shown to the user) when it cannot be edited.

        Works on any old open ticket (read from SoftExpert or not) or on a new ticket of the last search; empty text restores the original.
        The text goes to column H of the Dashboard copy at "Atualizar"; SoftExpert never receives it."""
        numero, antigo, novo = self._localizar_chamado_sebrae(numero)
        if antigo is not None:
            # what the card shows: the edited text, else the Dashboard's column H, else the SoftExpert reading
            se = _dict(antigo.get("softexpert"))
            atual = str(se.get("descricao_editada") or antigo.get("descricao") or _dict(antigo.get("leitura_softexpert")).get("descricao") or "")
        else:
            se, atual = _dict(_dict(novo).get("softexpert")), str(_dict(_dict(novo).get("linha")).get("H") or "")
        if _dict(se.get("finalizacao")).get("status") in fin.STATUS_FINALIZADOS:
            raise ValueError(f"{numero} já foi finalizado (no SoftExpert ou por outro técnico); a descrição não pode mais ser editada. Nada foi feito.")
        texto = str(descricao or "").strip()
        if len(texto) > MAX_DESCRICAO_FINALIZACAO:
            raise ValueError(f"A descrição pode ter no máximo {MAX_DESCRICAO_FINALIZACAO} caracteres.")
        if re.search(r"\[(?:PESSOA_\d+|E-MAIL OCULTADO|TELEFONE OCULTADO|DADO SENSÍVEL OMITIDO)\]", texto):
            raise ValueError("A descrição tem dado ocultado pela privacidade (nome não identificado, e-mail ou telefone); peça ao usuário para editá-la pelo lápis do chamado, na tela Chamados.")
        return {"numero": numero, "descricao": texto, "atual": atual, "editada": bool(str(se.get("descricao_editada") or "").strip())}

    def editar_descricao_chamado_sebrae(self, numero: Any, descricao: Any = "") -> Dict[str, Any]:
        """Same call as the pencil of the Descrição block: the text is kept here and goes to column H of the Dashboard copy at "Atualizar"; SoftExpert is never touched."""
        try:
            alvo = self.chamado_para_editar_descricao(numero, descricao)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, dados = self._chamar("PUT", f"/api/sebrae/chamados/{alvo['numero']}/descricao", corpo={"descricao": alvo["descricao"]})
        if not ok:
            return {"sucesso": False, "erro": dados}
        acao = "editada" if alvo["descricao"] else "restaurada ao texto original"
        return {"sucesso": True, "mensagem": f"Descrição de {alvo['numero']} {acao}. Ela vai à coluna H do Dashboard no próximo Atualizar Dashboard; o SoftExpert não recebe esse texto."}

    def historico_sebrae(self, entrada_id: Any = "", tipo: Any = "", limite: Any = 10) -> Dict[str, Any]:
        """Sebrae imports/searches (counts); with `entrada_id`, one entry with its lists."""
        entrada_id = str(entrada_id or "").strip()
        if entrada_id:
            if not _ID_ROTA.match(entrada_id):
                return {"erro": "Identificador da entrada inválido."}
            return self._leitura(f"/api/sebrae/historico/{entrada_id}")
        params: Dict[str, Any] = {"limite": self._limite(limite, 10)}
        if tipo in ("importacao", "busca"):
            params["tipo"] = tipo
        return self._leitura("/api/sebrae/historico", params)
