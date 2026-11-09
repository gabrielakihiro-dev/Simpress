"""Testes das marcas de OS finalizada (``domains/os_marcas_finalizacao.py``)."""

import json
import tempfile
import unittest
from pathlib import Path

from core.errors import DomainBusyError, DomainValidationError
from domains import os_marcas_finalizacao as marcas
from domains.os_observacoes import chave_os

VINCULO = {"fonte": "simpress", "serie": "SN-1", "os": "7285070", "origem": "manual"}


def finalizado(os_vinculada="ausente", status="ok", em="2026-11-08T10:00:00"):
    item = {"finalizacao": {"status": status, "em": em}}
    if os_vinculada != "ausente":
        item["os_vinculada"] = os_vinculada
    return item


def vinculos(tabela):
    return lambda numero: tabela.get(numero)


class MarcasBase(unittest.TestCase):
    def setUp(self):
        pasta = tempfile.TemporaryDirectory()
        self.addCleanup(pasta.cleanup)
        self.arquivo = marcas.caminho_marcas(Path(pasta.name))

    def ler(self, **fontes):
        return marcas.ler_marcas(self.arquivo, marcas.FontesMarcas(**fontes))

    def gravado(self):
        return json.loads(self.arquivo.read_text(encoding="utf-8"))


class ResolvedorTests(unittest.TestCase):
    MANUAIS = [{"fonte": "simpress", "serie": "SN-1", "os": "100", "ano": 2026, "numero": "1", "chamado": "UTIC-2026-1"}]
    DERIVADOS = [
        {"fonte": "oracle", "serie": "SN-2", "os": "200", "chamado": "UTIC-2026-2", "origem": "dashboard"},
        {"fonte": "oracle", "serie": "SN-1", "os": "999", "chamado": "UTIC-2026-1", "origem": "dashboard"},
    ]

    def test_manual_wins_over_derived(self):
        resolver = marcas.resolvedor(self.MANUAIS, lambda: self.DERIVADOS)
        self.assertEqual(resolver("UTIC-2026-1"), {"fonte": "simpress", "serie": "SN-1", "os": "100", "origem": "manual"})

    def test_derived_is_used_without_manual_and_marks_the_origin(self):
        resolver = marcas.resolvedor([], lambda: self.DERIVADOS)
        self.assertEqual(resolver("UTIC-2026-2"), {"fonte": "oracle", "serie": "SN-2", "os": "200", "origem": "dashboard"})

    def test_no_link_or_ambiguous_gives_none(self):
        self.assertIsNone(marcas.resolvedor([], lambda: self.DERIVADOS)("UTIC-2026-9"))

    def test_several_os_pick_the_highest(self):
        manuais = [
            {"fonte": "simpress", "serie": "SN-1", "os": "7285070", "chamado": "UTIC-2026-1"},
            {"fonte": "oracle", "serie": "SN-1", "os": "7285999", "chamado": "UTIC-2026-1"},
        ]
        self.assertEqual(marcas.resolvedor(manuais, lambda: [])("UTIC-2026-1")["os"], "7285999")

    def test_derived_link_of_an_os_relinked_by_hand_to_another_ticket_is_dropped(self):
        manuais = [{"fonte": "oracle", "serie": "sn 9", "os": "90 0", "chamado": "UTIC-2026-A"}]
        derivados = [
            {"fonte": "oracle", "serie": "SN-9", "os": "900", "chamado": "UTIC-2026-B", "origem": "dashboard"},
            {"fonte": "oracle", "serie": "SN-8", "os": "800", "chamado": "UTIC-2026-C", "origem": "dashboard"},
        ]
        resolver = marcas.resolvedor(manuais, lambda: derivados)
        self.assertEqual(resolver("UTIC-2026-A")["os"], "90 0")
        self.assertIsNone(resolver("UTIC-2026-B"))
        self.assertEqual(resolver("UTIC-2026-C")["os"], "800")

    def test_derived_failure_leaves_only_the_manual_links(self):
        def quebra():
            raise ValueError("relatório ilegível")

        resolver = marcas.resolvedor(self.MANUAIS, quebra)
        self.assertEqual(resolver("UTIC-2026-1")["os"], "100")
        self.assertIsNone(resolver("UTIC-2026-2"))

    def test_derived_are_computed_only_once_and_only_when_needed(self):
        chamadas = []
        resolver = marcas.resolvedor(self.MANUAIS, lambda: chamadas.append(1) or self.DERIVADOS)
        resolver("UTIC-2026-1")
        self.assertEqual(chamadas, [])
        resolver("UTIC-2026-2")
        resolver("UTIC-2026-9")
        self.assertEqual(len(chamadas), 1)


class ArquivoTests(MarcasBase):
    def test_missing_file_is_normal(self):
        marcas.validar_legivel(self.arquivo)
        self.assertEqual(self.ler(), [])

    def test_unreadable_or_invalid_file_is_preserved_and_busy(self):
        for conteudo in ("{não é json", json.dumps([]), json.dumps({"marcas": [], "historico": []}), json.dumps({"marcas": {"x": 1}, "historico": []})):
            with self.subTest(conteudo=conteudo):
                self.arquivo.write_text(conteudo, encoding="utf-8")
                with self.assertRaises(DomainBusyError):
                    marcas.validar_legivel(self.arquivo)
                with self.assertRaises(DomainBusyError):
                    self.ler()
                with self.assertRaises(DomainBusyError):
                    marcas.registrar_saidas(self.arquivo, [{"serie": "SN-1", "os": "1", "chamado": "UTIC-2026-1"}])
                with self.assertRaises(DomainBusyError):
                    marcas.alterar_marca(self.arquivo, marcas.FontesMarcas(), "SN-1", "1", "UTIC-2026-1", "desfazer")
                self.assertEqual(self.arquivo.read_text(encoding="utf-8"), conteudo)


class FonteSiteTests(MarcasBase):
    def test_finalized_ticket_with_frozen_os_becomes_an_active_site_mark(self):
        [marca] = self.ler(finalizacao={"UTIC-2026-7": finalizado({**VINCULO, "em": "x"})})
        self.assertEqual(
            {k: marca[k] for k in ("serie", "os", "chamado", "origem", "motivo", "finalizado_em", "ativa", "conferido_em")},
            {"serie": "SN-1", "os": "7285070", "chamado": "UTIC-2026-7", "origem": "site", "motivo": "",
             "finalizado_em": "2026-11-08T10:00:00", "ativa": True, "conferido_em": ""},
        )
        self.assertEqual(marca["historico"], [{"acao": "marcada", "origem": "auto", "em": "2026-11-08T10:00:00"}])

    def test_site_mark_is_calculated_on_read_and_never_written(self):
        self.ler(finalizacao={"UTIC-2026-7": finalizado(VINCULO)})
        self.assertFalse(self.arquivo.exists())

    def test_only_status_ok_marks(self):
        for status in ("erro", "pendente", "nao_encontrado", "executando"):
            with self.subTest(status=status):
                self.assertEqual(self.ler(finalizacao={"UTIC-2026-7": finalizado(VINCULO, status)}), [])
        self.assertEqual(self.ler(finalizacao={"UTIC-2026-7": {"descricao": "sem finalizacao"}}), [])

    def test_frozen_photo_wins_over_a_later_link(self):
        outra = {"fonte": "simpress", "serie": "SN-9", "os": "555", "origem": "manual"}
        [marca] = self.ler(
            finalizacao={"UTIC-2026-7": finalizado(VINCULO)}, vinculo_atual=vinculos({"UTIC-2026-7": outra}),
        )
        self.assertEqual((marca["serie"], marca["os"]), ("SN-1", "7285070"))

    def test_frozen_null_means_no_link_at_request_time_and_no_mark(self):
        atual = vinculos({"UTIC-2026-7": VINCULO})
        self.assertEqual(self.ler(finalizacao={"UTIC-2026-7": finalizado(None)}, vinculo_atual=atual), [])

    def test_old_finalization_without_photo_uses_the_current_link_best_effort(self):
        [marca] = self.ler(finalizacao={"UTIC-2026-7": finalizado()}, vinculo_atual=vinculos({"UTIC-2026-7": VINCULO}))
        self.assertEqual((marca["origem"], marca["os"]), ("site", "7285070"))
        self.assertEqual(self.ler(finalizacao={"UTIC-2026-7": finalizado()}), [])

    def test_failure_resolving_the_current_link_only_removes_the_mark(self):
        def quebra(_numero):
            raise RuntimeError("vínculos ilegíveis")

        self.assertEqual(self.ler(finalizacao={"UTIC-2026-7": finalizado()}, vinculo_atual=quebra), [])


class FonteNaoEncontradoTests(MarcasBase):
    BASE = dict(
        nao_encontrados=["UTIC-2026-8"], nao_encontrados_em="2026-11-08T09:00:00", abertos=["UTIC-2026-8"],
        vinculo_atual=vinculos({"UTIC-2026-8": {"fonte": "oracle", "serie": "SN-2", "os": "200", "origem": "dashboard"}}),
    )

    def test_not_found_and_still_open_with_link_marks_other_technician(self):
        [marca] = self.ler(**self.BASE)
        self.assertEqual(
            (marca["origem"], marca["motivo"], marca["finalizado_em"], marca["serie"], marca["os"], marca["ativa"]),
            ("outro_tecnico", "nao_encontrado_softexpert", "2026-11-08T09:00:00", "SN-2", "200", True),
        )

    def test_needs_to_be_open_and_to_have_a_link(self):
        self.assertEqual(self.ler(**{**self.BASE, "abertos": []}), [])
        self.assertEqual(self.ler(**{**self.BASE, "vinculo_atual": vinculos({})}), [])
        self.assertEqual(self.ler(**{**self.BASE, "nao_encontrados": []}), [])

    def test_a_ticket_finalized_by_the_site_is_never_also_other_technician(self):
        # foto sem vínculo (``None``): a fonte site não marca, e a fonte b também não pode marcar o mesmo chamado
        self.assertEqual(self.ler(finalizacao={"UTIC-2026-8": finalizado(None)}, **self.BASE), [])
        [marca] = self.ler(finalizacao={"UTIC-2026-8": finalizado(None, status="erro")}, **self.BASE)
        self.assertEqual(marca["origem"], "outro_tecnico")

    def test_disappears_when_the_next_read_finds_it(self):
        self.assertEqual(len(self.ler(**self.BASE)), 1)
        self.assertEqual(self.ler(**{**self.BASE, "nao_encontrados": []}), [])


class FonteSaiuDoDashboardTests(MarcasBase):
    SAIDA = {"serie": "SN-3", "os": "300", "chamado": "UTIC-2026-3"}

    def test_exit_is_written_frozen_and_read_back(self):
        self.assertEqual(marcas.registrar_saidas(self.arquivo, [self.SAIDA], em="2026-11-08T11:00:00"), 1)
        chave = json.dumps([chave_os("SN-3", "300"), "UTIC-2026-3"], ensure_ascii=False, separators=(",", ":"))
        arquivo = self.gravado()
        self.assertEqual(arquivo["marcas"][chave], {
            "serie": "SN-3", "os": "300", "chamado": "UTIC-2026-3", "origem": "outro_tecnico",
            "motivo": "saiu_do_dashboard", "detectado_em": "2026-11-08T11:00:00",
        })
        self.assertEqual(arquivo["historico"], [{
            "chave": chave, "acao": "marcada", "origem": "auto", "chamado": "UTIC-2026-3", "serie": "SN-3", "os": "300",
            "em": "2026-11-08T11:00:00",
        }])
        [marca] = self.ler()
        self.assertEqual((marca["origem"], marca["motivo"], marca["finalizado_em"]), ("outro_tecnico", "saiu_do_dashboard", "2026-11-08T11:00:00"))
        self.assertEqual(marca["historico"], [{"acao": "marcada", "origem": "auto", "em": "2026-11-08T11:00:00"}])

    def test_repeating_the_import_does_not_duplicate_or_rewrite(self):
        marcas.registrar_saidas(self.arquivo, [self.SAIDA], em="2026-11-08T11:00:00")
        antes = self.arquivo.read_text(encoding="utf-8")
        self.assertEqual(marcas.registrar_saidas(self.arquivo, [self.SAIDA], em="2026-11-09T08:00:00"), 0)
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), antes)

    def test_nothing_to_register_does_not_create_the_file(self):
        self.assertEqual(marcas.registrar_saidas(self.arquivo, []), 0)
        self.assertFalse(self.arquivo.exists())

    def test_a_mark_the_user_undid_is_not_registered_again(self):
        marcas.registrar_saidas(self.arquivo, [self.SAIDA], em="2026-11-08T11:00:00")
        marcas.alterar_marca(self.arquivo, marcas.FontesMarcas(), "SN-3", "300", "UTIC-2026-3", "desfazer")
        marcas.registrar_saidas(self.arquivo, [self.SAIDA], em="2026-11-09T08:00:00")
        [marca] = self.ler()
        self.assertFalse(marca["ativa"])
        self.assertEqual(marca["finalizado_em"], "2026-11-08T11:00:00")

    def test_exit_whose_series_normalizes_to_empty_is_skipped_and_the_others_are_saved(self):
        saidas = [
            {"serie": serie, "os": "1", "chamado": f"UTIC-2026-{n}"} for n, serie in enumerate(("-", "/", "—"), start=10)
        ] + [self.SAIDA]
        with self.assertLogs(marcas.logger, level="WARNING") as log:
            self.assertEqual(marcas.registrar_saidas(self.arquivo, saidas, em="2026-11-08T11:00:00"), 1)
        self.assertEqual([r["chamado"] for r in self.gravado()["marcas"].values()], ["UTIC-2026-3"])
        self.assertEqual(len(log.records), 3)
        self.assertTrue(all("erro=DomainValidationError" in r.getMessage() and "UTIC" not in r.getMessage() for r in log.records))

    def test_exit_of_a_key_with_only_adjusts_is_a_new_detection_active_and_unchecked(self):
        fontes = marcas.FontesMarcas(**FonteNaoEncontradoTests.BASE)
        marcas.alterar_marca(self.arquivo, fontes, "SN-2", "200", "UTIC-2026-8", "conferir")
        marcas.alterar_marca(self.arquivo, fontes, "SN-2", "200", "UTIC-2026-8", "desfazer")
        [antes] = marcas.ler_marcas(self.arquivo, fontes)
        self.assertEqual((antes["motivo"], antes["ativa"], bool(antes["conferido_em"])), ("nao_encontrado_softexpert", False, True))
        saida = {"serie": "SN-2", "os": "200", "chamado": "UTIC-2026-8"}
        self.assertEqual(marcas.registrar_saidas(self.arquivo, [saida], em="2026-11-09T08:00:00"), 1)
        [marca] = marcas.ler_marcas(self.arquivo, fontes)
        self.assertEqual((marca["motivo"], marca["ativa"], marca["conferido_em"]), ("saiu_do_dashboard", True, ""))
        self.assertEqual(marca["finalizado_em"], "2026-11-09T08:00:00")
        # já detectada antes: o desfazer do usuário vale e a detecção não se repete
        marcas.alterar_marca(self.arquivo, fontes, "SN-2", "200", "UTIC-2026-8", "desfazer")
        self.assertEqual(marcas.registrar_saidas(self.arquivo, [saida], em="2026-11-10T08:00:00"), 0)
        [marca] = marcas.ler_marcas(self.arquivo, fontes)
        self.assertFalse(marca["ativa"])

    def test_site_beats_exit_which_beats_not_found_for_the_same_key(self):
        marcas.registrar_saidas(self.arquivo, [{"serie": "SN-1", "os": "7285070", "chamado": "UTIC-2026-7"}], em="2026-11-07T10:00:00")
        fontes = dict(
            nao_encontrados=["UTIC-2026-7"], nao_encontrados_em="2026-11-08T09:00:00", abertos=["UTIC-2026-7"],
            vinculo_atual=vinculos({"UTIC-2026-7": VINCULO}),
        )
        [so_c_e_b] = self.ler(**fontes)
        self.assertEqual((so_c_e_b["origem"], so_c_e_b["motivo"]), ("outro_tecnico", "saiu_do_dashboard"))
        [com_site] = self.ler(finalizacao={"UTIC-2026-7": finalizado(VINCULO)}, **fontes)
        self.assertEqual((com_site["origem"], com_site["motivo"]), ("site", ""))

    def test_orphan_override_without_a_source_is_ignored(self):
        self.arquivo.write_text(json.dumps({"marcas": {'["SN1:1","UTIC-2026-1"]': {"desfeita": True}}, "historico": []}), encoding="utf-8")
        self.assertEqual(self.ler(), [])


class DetectarSaidasTests(unittest.TestCase):
    ABERTOS = [{"numero": "UTIC-2026-1"}, {"numero": "UTIC-2026-2"}, {"numero": "linha:4"}, {"numero": "UTIC-2026-3"}]
    VINCULOS = {
        "UTIC-2026-1": {"serie": "SN-1", "os": "10"}, "UTIC-2026-2": {"serie": "SN-2", "os": "20"},
        "UTIC-2026-3": {"serie": "SN-3", "os": "30"},
    }

    def detectar(self, mapa, finalizacao=None, vinculos_=None):
        return marcas.detectar_saidas(self.ABERTOS, mapa, finalizacao or {}, vinculos(self.VINCULOS if vinculos_ is None else vinculos_))

    def test_ticket_absent_from_the_new_dashboard_is_an_exit(self):
        saidas = self.detectar({"UTIC-2026-2": {"status": "EM ABERTO"}, "UTIC-2026-3": {"status": ""}})
        self.assertEqual(saidas, [{"serie": "SN-1", "os": "10", "chamado": "UTIC-2026-1"}])

    def test_still_open_and_row_keys_are_not_exits(self):
        mapa = {n: {"status": "EM ABERTO"} for n in ("UTIC-2026-1", "UTIC-2026-2", "UTIC-2026-3", "linha:4")}
        self.assertEqual(self.detectar(mapa), [])

    def test_finalized_in_the_new_dashboard_without_site_ok_counts_as_an_exit(self):
        mapa = {"UTIC-2026-1": {"status": "FINALIZADO"}, "UTIC-2026-2": {"status": "EM ABERTO"}, "UTIC-2026-3": {"status": "EM ABERTO"}}
        self.assertEqual([s["chamado"] for s in self.detectar(mapa)], ["UTIC-2026-1"])

    def test_site_ok_is_not_an_exit_but_site_error_is(self):
        mapa = {"UTIC-2026-2": {"status": "EM ABERTO"}, "UTIC-2026-3": {"status": "EM ABERTO"}}
        self.assertEqual(self.detectar(mapa, {"UTIC-2026-1": finalizado()}), [])
        self.assertEqual(len(self.detectar(mapa, {"UTIC-2026-1": finalizado(status="erro")})), 1)

    def test_ticket_without_a_link_is_not_an_exit(self):
        mapa = {"UTIC-2026-2": {"status": "EM ABERTO"}, "UTIC-2026-3": {"status": "EM ABERTO"}}
        self.assertEqual(self.detectar(mapa, vinculos_={}), [])


class AcoesTests(MarcasBase):
    FONTES = dict(finalizacao={"UTIC-2026-7": finalizado(VINCULO)})
    OUTRO = dict(
        nao_encontrados=["UTIC-2026-8"], nao_encontrados_em="2026-11-08T09:00:00", abertos=["UTIC-2026-8"],
        vinculo_atual=vinculos({"UTIC-2026-8": {"fonte": "oracle", "serie": "SN-2", "os": "200", "origem": "dashboard"}}),
    )

    def alterar(self, acao, serie="SN-1", os="7285070", chamado="UTIC-2026-7", **fontes):
        return marcas.alterar_marca(self.arquivo, marcas.FontesMarcas(**(fontes or self.FONTES)), serie, os, chamado, acao)

    def test_undo_then_redo_keeps_an_append_only_history_with_manual_events(self):
        desfeita = self.alterar("desfazer")
        self.assertFalse(desfeita["ativa"])
        refeita = self.alterar("refazer")
        self.assertTrue(refeita["ativa"])
        self.assertEqual([(e["acao"], e["origem"]) for e in refeita["historico"]], [("marcada", "auto"), ("desfeita", "manual"), ("refeita", "manual")])
        self.assertEqual([e["acao"] for e in self.gravado()["historico"]], ["desfeita", "refeita"])

    def test_undo_state_shows_in_the_get(self):
        self.alterar("desfazer")
        [marca] = self.ler(**self.FONTES)
        self.assertFalse(marca["ativa"])

    def test_repeating_an_action_changes_nothing(self):
        self.alterar("desfazer")
        self.assertFalse(self.alterar("desfazer")["ativa"])
        self.alterar("refazer")
        self.alterar("refazer")
        self.assertEqual([e["acao"] for e in self.gravado()["historico"]], ["desfeita", "refeita"])

    def test_nothing_is_written_on_a_no_op(self):
        self.alterar("refazer")  # já está ativa
        self.assertFalse(self.arquivo.exists())

    def test_confirm_only_for_other_technician_and_never_reactivates_or_removes(self):
        with self.assertRaises(DomainValidationError) as erro:
            self.alterar("conferir")
        self.assertEqual(erro.exception.status_code, 422)
        marca = self.alterar("conferir", serie="SN-2", os="200", chamado="UTIC-2026-8", **self.OUTRO)
        self.assertTrue(marca["conferido_em"])
        self.assertTrue(marca["ativa"])
        self.assertEqual(marca["historico"][-1]["acao"], "conferida")
        self.assertEqual(self.alterar("conferir", serie="SN-2", os="200", chamado="UTIC-2026-8", **self.OUTRO)["conferido_em"], marca["conferido_em"])

    def test_invalid_action_and_missing_mark_give_422(self):
        for acao, serie, os, chamado in (
            ("apagar", "SN-1", "7285070", "UTIC-2026-7"), ("desfazer", "SN-9", "1", "UTIC-2026-7"),
            ("desfazer", "SN-1", "7285070", "UTIC-2026-99"), ("desfazer", "", "7285070", "UTIC-2026-7"),
            ("desfazer", "SN-1", "7285070", ""),
        ):
            with self.subTest(acao=acao, serie=serie, chamado=chamado):
                with self.assertRaises(DomainValidationError) as erro:
                    self.alterar(acao, serie=serie, os=os, chamado=chamado)
                self.assertEqual(erro.exception.status_code, 422)
        self.assertFalse(self.arquivo.exists())

    def test_chamado_and_serie_are_matched_without_case_or_spacing(self):
        marca = self.alterar("desfazer", serie=" sn-1 ", os="72850 70", chamado=" utic-2026-7 ")
        self.assertFalse(marca["ativa"])

    def test_confirm_works_for_a_mark_written_by_the_import_and_keeps_its_frozen_record(self):
        marcas.registrar_saidas(self.arquivo, [{"serie": "SN-3", "os": "300", "chamado": "UTIC-2026-3"}], em="2026-11-08T11:00:00")
        marca = marcas.alterar_marca(self.arquivo, marcas.FontesMarcas(), "SN-3", "300", "UTIC-2026-3", "conferir")
        self.assertTrue(marca["conferido_em"])
        dados = self.gravado()
        [registro] = dados["marcas"].values()
        self.assertEqual(registro["detectado_em"], "2026-11-08T11:00:00")  # o registro congelado não é reescrito


class PendentesTests(MarcasBase):
    OUTRO = AcoesTests.OUTRO

    def test_only_active_unchecked_other_technician_marks_are_pending(self):
        fontes = marcas.FontesMarcas(finalizacao={"UTIC-2026-7": finalizado(VINCULO)}, **self.OUTRO)
        self.assertEqual(marcas.pendentes_outro_tecnico(self.arquivo, fontes), [
            {"chamado": "UTIC-2026-8", "serie": "SN-2", "os": "200", "motivo": "nao_encontrado_softexpert"},
        ])
        marcas.alterar_marca(self.arquivo, fontes, "SN-2", "200", "UTIC-2026-8", "desfazer")
        self.assertEqual(marcas.pendentes_outro_tecnico(self.arquivo, fontes), [])
        marcas.alterar_marca(self.arquivo, fontes, "SN-2", "200", "UTIC-2026-8", "refazer")
        self.assertEqual(len(marcas.pendentes_outro_tecnico(self.arquivo, fontes)), 1)
        marcas.alterar_marca(self.arquivo, fontes, "SN-2", "200", "UTIC-2026-8", "conferir")
        self.assertEqual(marcas.pendentes_outro_tecnico(self.arquivo, fontes), [])

    def test_unreadable_file_raises_busy(self):
        self.arquivo.write_text("{", encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            marcas.pendentes_outro_tecnico(self.arquivo, marcas.FontesMarcas())


if __name__ == "__main__":
    unittest.main()
