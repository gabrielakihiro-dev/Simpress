"""The regional reads of the assistant's API (`RegionaisMixin`, mixed into `SimpressApi` in `assistant_api`).

Regional representatives (F2), Cobertura (F10) and regional backups (Resumo F3): reads only, plus the builder of the
representative change card; the writes (`alterar_`/`restaurar_representante_regional`) stay in the class.
Leaf module: shared helpers come from `assistant_api_comum`; nothing here may import `assistant_api` or another mixin.
"""

import re
from collections import Counter
from datetime import date
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

from domains.assistant_api_comum import MAX_ITENS_LISTA, _aparar
from domains.assistant_transporte import ArquivoUpload
from domains.assistant_validacao import (
    _dict, montar_representante_regional, representante_efetivo, representante_padrao, resolver_cidade_representante,
)
from domains.coverage import dobrar
from domains.local_setup import REGIONAL_REPRESENTATIVE_CITIES


class RegionaisMixin:
    if TYPE_CHECKING:  # members of `SimpressApi` used here; declared for mypy only, never defined at runtime
        def _chamar(
            self, metodo: str, caminho: str, params: Optional[Dict[str, Any]] = None, corpo: Union[Dict[str, Any], ArquivoUpload, None] = None,
        ) -> Tuple[bool, Any]: ...

    def _representantes_salvos(self) -> Tuple[Dict[str, Any], bool, Dict[str, Any]]:
        """(changes saved by city, whether the file is unreadable, effective defaults by city); ValueError when the route fails.

        The defaults come from the route (`padroes`: code plus the local defaults file); an answer without them leaves the code's.
        """
        ok, dados = self._chamar("GET", "/api/config/representantes-regionais")
        if not ok:
            raise ValueError(dados)
        dados = _dict(dados)
        padroes = {str(item.get("cidade")): _dict(item) for item in dados.get("padroes") or [] if isinstance(item, dict)}
        return _dict(dados.get("alteracoes")), bool(dados.get("arquivo_invalido")), padroes

    def representante_regional_atual(self, cidade: Any) -> Tuple[str, Dict[str, str], bool, Dict[str, str]]:
        """(city, effective values, whether a change is saved, default of the city); real values: only for the card and the merge. ValueError (pt-BR)."""
        cidade = resolver_cidade_representante(cidade)
        salvos, _, padroes = self._representantes_salvos()
        return (cidade, *representante_efetivo(cidade, salvos, padroes), representante_padrao(cidade, padroes))

    def ver_representantes_regionais(self, cidade: Any = None) -> Dict[str, Any]:
        """Values go out under sensitive keys (nome, email, retirada_telefone), so the conversation's mask turns them into markers."""
        try:
            cidade = resolver_cidade_representante(cidade) if str(cidade or "").strip() else None
            salvos, invalido, padroes = self._representantes_salvos()
        except ValueError as falha:
            return {"erro": str(falha)}
        if cidade is None:
            return {"cidades": [{"cidade": c, "alterada": isinstance(salvos.get(c), dict)} for c in REGIONAL_REPRESENTATIVE_CITIES], "arquivo_invalido": invalido}
        valores, alterada = representante_efetivo(cidade, salvos, padroes)
        return {
            "cidade": cidade, "nome": valores["nome"], "email": valores["email"], "retirada_telefone": valores["telefone"],
            "horario": valores["horario"], "almoco": valores["almoco"], "pausa": valores["pausaDuracao"],
            "alterada": alterada, "arquivo_invalido": invalido,
        }

    def listar_cobertura(self, cidade: Any = None, data: Any = None, ate: Any = None, perfil: Any = None) -> Dict[str, Any]:
        """Painel Cobertura (F10), só leitura: o mesmo GET /api/cobertura da tela (build_coverage), filtrado aqui.

        Allowlist: só vagas, contagens e séries; os `casos` (com quem recebeu, observações e cópias da transferência) nunca saem.
        """
        datas: Dict[str, str] = {}
        for nome, valor in (("data", data), ("ate", ate)):
            texto = str(valor or "").strip()
            if not texto:
                continue
            try:
                datas[nome] = date.fromisoformat(texto).isoformat() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", texto) else ""
            except ValueError:
                datas[nome] = ""
            if not datas[nome]:
                return {"erro": f"Data inválida em `{nome}`: use AAAA-MM-DD (ex.: 2026-11-20)."}
        ok, dados = self._chamar("GET", "/api/cobertura")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        todas = [v for v in dados.get("vagas") or [] if isinstance(v, dict)]
        alvo_cidade, alvo_perfil = dobrar(cidade), dobrar(perfil)
        vagas = [
            v for v in todas
            if (not alvo_cidade or dobrar(v.get("cidade")) == alvo_cidade)
            and (not alvo_perfil or alvo_perfil in dobrar(v.get("perfil")))
            and (not datas.get("data") or str(v.get("data")) == datas["data"])
            and (not datas.get("ate") or str(v.get("data")) <= datas["ate"])
        ]
        filtro = {k: v for k, v in (("cidade", cidade), ("perfil", perfil), *datas.items()) if str(v or "").strip()}
        if not todas:
            return {"hoje": dados.get("hoje"), "mensagem": "Nenhuma necessidade cadastrada na Cobertura.", "faltam": 0}
        if not vagas:
            return {
                "hoje": dados.get("hoje"), "filtro": filtro,
                "mensagem": "Nenhuma vaga corresponde ao filtro; isso não quer dizer que não vai faltar. Confira cidade, data e perfil.",
                "cidades_existentes": sorted({str(v.get("cidade") or "") for v in todas}),
                "datas_existentes": sorted({str(v.get("data") or "") for v in todas}),
                "perfis_existentes": sorted({str(v.get("perfil") or "") for v in todas} - {""}),
            }
        contagens = {situacao: 0 for situacao in ("atendivel", "condicionada", "sem_cobertura", "entregue")}
        for vaga in vagas:
            if vaga.get("situacao") in contagens:
                contagens[vaga["situacao"]] += 1
        disponiveis = [
            {k: s.get(k) for k in ("serie", "cidade", "valida_ate", "sinal")}
            for s in dados.get("disponiveis") or []
            if isinstance(s, dict) and (not alvo_cidade or dobrar(s.get("cidade")) == alvo_cidade)
        ]
        manutencao = _dict(dados.get("manutencao"))
        return _aparar({
            "hoje": dados.get("hoje"), "filtro": filtro, "contagens": contagens, "faltam": contagens["sem_cobertura"],
            "vagas": [{k: v.get(k) for k in ("data", "cidade", "perfil", "monitor", "situacao", "serie", "selos", "motivo")} for v in vagas],
            "disponiveis": disponiveis,
            "reservas_vencidas": len(dados.get("reservas_vencidas") or []),
            "manutencao_verificada": bool(manutencao.get("verificada", True)),
            "aviso_manutencao": str(manutencao.get("aviso") or ""),
        })

    def listar_backups_regionais(self, cidade: Any = None) -> Dict[str, Any]:
        """Backups regionais (Resumo F3, sub-aba Backups), só leitura: o `backups_regionais` do GET /api/painel, filtrado aqui.

        Allowlist: nunca o `apelido` (pode ser nome de pessoa), nem a `conferencia` e os `excluidos` em detalhe (só contagens).
        `outras_candidatos` (cidades sem mínimo) segue o mesmo filtro de cidade e o mesmo corte das demais listas.
        """
        ok, dados = self._chamar("GET", "/api/painel")
        if not ok:
            return {"erro": dados}
        bruto = _dict(_dict(dados).get("backups_regionais"))
        if bruto.get("indisponivel") or not isinstance(bruto.get("prioritarias"), list):
            return {"erro": "Os Backups regionais não puderam ser calculados agora. Não há números para informar."}
        alvo = dobrar(cidade)
        das_cidades = [_dict(g) for g in bruto["prioritarias"] if not alvo or dobrar(_dict(g).get("cidade")) == alvo]

        def cortar(itens: Any, campos: Tuple[str, ...]) -> Tuple[List[Dict[str, Any]], int]:
            validos = [i for i in itens or [] if isinstance(i, dict)]
            return [{k: i.get(k) for k in campos} for i in validos[:MAX_ITENS_LISTA]], max(0, len(validos) - MAX_ITENS_LISTA)

        def contar(itens: Any) -> Dict[str, Any]:
            validos = [i for i in itens or [] if isinstance(i, dict)]
            return {"total": len(validos), "por_motivo": dict(Counter(str(i.get("motivo") or "") for i in validos))}

        prioritarias = []
        for g in das_cidades:
            backups, backups_omitidos = cortar(g.get("backups"), ("serie", "origem", "ultima_verificacao", "confirmado_ate", "confirmacao"))
            for b in backups:
                # Confirmação nova não tem prazo (`confirmado_ate` None): quem diz se há confirmação é `confirmacao`; só flags saem.
                conf = _dict(b.pop("confirmacao"))
                b["confirmado"] = conf.get("estado") == "vigente"
                b["decisao_pendente"] = bool(conf.get("decisao_pendente"))
            candidatos, candidatos_omitidos = cortar(g.get("candidatos"), ("serie", "motivo", "dias_sem_verificacao"))
            prioritarias.append({
                **{k: g.get(k) for k in ("cidade", "status", "contados", "minimo", "excedente")},
                "backups": backups, "backups_omitidos": backups_omitidos,
                "candidatos": candidatos, "candidatos_omitidos": candidatos_omitidos,
                "conferencia": contar(g.get("conferencia")), "excluidos": contar(g.get("excluidos")),
            })
        sobras_todas = [
            _dict(g) for g in bruto.get("sobras") or []
            if isinstance(g, dict) and (not alvo or dobrar(g.get("cidade")) == alvo)
        ]
        sobras = []
        for g in sobras_todas[:MAX_ITENS_LISTA]:
            series = [x for x in g.get("series") or [] if isinstance(x, str)]
            sobras.append({
                "cidade": g.get("cidade"), "quantidade": g.get("quantidade"), "prioritaria": bool(g.get("prioritaria")),
                "series": series[:MAX_ITENS_LISTA], "series_omitidas": max(0, len(series) - MAX_ITENS_LISTA),
            })
        # Candidates in cities without a minimum: the number a user asks for when the city is not one of the five.
        outras_todas = [
            _dict(g) for g in bruto.get("outras_candidatos") or []
            if isinstance(g, dict) and (not alvo or dobrar(g.get("cidade")) == alvo)
        ]
        outras = []
        for g in outras_todas[:MAX_ITENS_LISTA]:
            candidatos, omitidos = cortar(g.get("candidatos"), ("serie", "motivo", "dias_sem_verificacao"))
            outras.append({"cidade": g.get("cidade"), "candidatos": candidatos, "candidatos_omitidos": omitidos})
        pendencias = {
            tipo: [c for c in _dict(bruto.get("pendencias")).get(tipo) or [] if isinstance(c, str) and (not alvo or dobrar(c) == alvo)]
            for tipo in ("sem_backup", "conferir")
        }
        resultado: Dict[str, Any] = {
            "gerado_em": bruto.get("gerado_em"), "minimo": bruto.get("minimo"),
            "fontes": {k: v for k, v in _dict(bruto.get("fontes")).items() if v is None or isinstance(v, (bool, str))},
            "limitacoes": [x for x in bruto.get("limitacoes") or [] if isinstance(x, str)][:MAX_ITENS_LISTA],
            "pendencias": pendencias, "prioritarias": prioritarias,
            "sobras": sobras, "sobras_omitidas": max(0, len(sobras_todas) - MAX_ITENS_LISTA),
            "outras_candidatos": outras, "outras_candidatos_omitidas": max(0, len(outras_todas) - MAX_ITENS_LISTA),
        }
        if alvo and not prioritarias:
            resultado["mensagem"] = (
                "Esta cidade não é uma das regionais com mínimo de backup; só as sobras e os candidatos dela (se houver) aparecem. "
                "Isso não quer dizer que não há notebook de backup lá."
            )
            resultado["cidades_prioritarias"] = [str(_dict(g).get("cidade") or "") for g in bruto["prioritarias"]]
        return _aparar(resultado)

    def montar_alteracao_representante(self, cidade: Any, *novos: Any) -> Tuple[str, Dict[str, str], List[Tuple[str, str, str]]]:
        """(city, body for the route, changes) of `alterar_representante_regional`; ValueError (pt-BR) when it cannot run."""
        cidade, efetivo, *_ = self.representante_regional_atual(cidade)
        return (cidade, *montar_representante_regional(efetivo, *novos))
