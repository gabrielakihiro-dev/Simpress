"""Hand edits of the Dashboard in SharePoint between "Atualizar Dashboard" and "Enviar ao SharePoint".

The automatic import (routine ``dashboard``) must not deadlock when someone sorted the sheet or filled a row by hand:
the pending output is preserved (never deleted, never sent) and the downloaded file becomes the new base."""
import hashlib
import io
import json
import re
import tempfile
import unittest
import zipfile
from pathlib import Path

from core.errors import DomainConflictError, DomainValidationError
from domains import sebrae_dashboard_gravacao as G
from domains import sebrae_finalizacao as fin
from domains import sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from domains.sebrae_dashboard import ler_coluna_c
from routers.sebrae_dashboard import (
    NOME_ATUALIZADO, AtualizarPayload, ChamadoManual, SebraeDashboardServices, create_sebrae_dashboard_router,
)
from tests.test_sebrae_dashboard_gravacao import montar, partes_de, texto

FOLHA = "xl/worksheets/sheet4.xml"
TICKETS = ("UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003", "UTIC-2026-0004")  # rows 2 to 5
TICKET_A_MAO = "UTIC-2026-0777"
TITULO_A_MAO = "Titulo digitado no Excel"

_LINHA = re.compile(r'(<row r="(\d+)"[^>]*>)(.*?)(</row>)', re.DOTALL)
_CELULA = re.compile(r'<c r="([A-Z]+)\d+"[^>]*?/>|<c r="([A-Z]+)\d+"[^>]*>.*?</c>', re.DOTALL)


def dashboard(ultima=10):
    """Four open tickets in rows 2 to 5 and free rows after them."""
    return montar(TICKETS, ultima=ultima, status=("EM ABERTO",) * len(TICKETS))


def regravar(conteudo: bytes, alterar) -> bytes:
    """Same workbook with the CHAMADOS sheet XML transformed by ``alterar``."""
    partes = partes_de(conteudo)
    partes[FOLHA] = alterar(partes[FOLHA].decode()).encode()
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
        for nome, dados in partes.items():
            arquivo.writestr(nome, dados)
    return saida.getvalue()


def preencher(conteudo: bytes, linha: int, valores: dict) -> bytes:
    """What a colleague does in Excel: types ``valores`` (column letter -> text) into one row of the sheet."""
    def trocar(achado):
        if int(achado.group(2)) != linha:
            return achado.group(0)
        celulas = {m.group(1) or m.group(2): m.group(0) for m in _CELULA.finditer(achado.group(3))}
        for letra, valor in valores.items():
            celulas[letra] = texto(f"{letra}{linha}", valor)
        ordenadas = sorted(celulas.items(), key=lambda item: (len(item[0]), item[0]))
        return achado.group(1) + "".join(xml for _, xml in ordenadas) + achado.group(4)

    return regravar(conteudo, lambda folha: _LINHA.sub(trocar, folha))


def reordenar(conteudo: bytes, origem) -> bytes:
    """What sorting a column does: row ``2 + i`` receives the cells of row ``origem[i]`` (row 1 and the others stay)."""
    def alterar(folha: str) -> str:
        corpos = {int(m.group(2)): m.group(3) for m in _LINHA.finditer(folha)}

        def trocar(achado):
            numero = int(achado.group(2))
            if not 2 <= numero < 2 + len(origem):
                return achado.group(0)
            fonte = origem[numero - 2]
            corpo = re.sub(rf'(<c r="[A-Z]+){fonte}"', rf'\g<1>{numero}"', corpos[fonte])
            return achado.group(1) + corpo + achado.group(4)

        return _LINHA.sub(trocar, folha)

    return regravar(conteudo, alterar)


def linha_preenchida_a_mao(conteudo: bytes, linha: int = 9) -> bytes:
    return preencher(conteudo, linha, {"A": "CLIENTE", "C": TICKET_A_MAO, "D": "EM ABERTO", "G": TITULO_A_MAO})


class HelpersDeEdicaoTests(unittest.TestCase):
    """The simulated Excel edits must really look like the real ones to the readers the site uses."""

    def test_preencher_adds_a_row_the_readers_see(self):
        editado = linha_preenchida_a_mao(dashboard())
        self.assertEqual(ler_coluna_c(editado), ler_coluna_c(dashboard()) | {TICKET_A_MAO})
        valores = G.valores_dos_chamados(editado)
        self.assertEqual(sorted(valores), [2, 3, 4, 5, 9])
        self.assertEqual(valores[9][G.COLUNAS_DE_DADO.index("C")], TICKET_A_MAO)

    def test_reordenar_keeps_the_same_rows_in_another_order(self):
        base = G.valores_dos_chamados(dashboard())
        ordenado = G.valores_dos_chamados(reordenar(dashboard(), [5, 4, 3, 2]))
        self.assertNotEqual(ordenado, base)
        self.assertEqual(sorted(ordenado.values()), sorted(base.values()))
        self.assertEqual(ordenado[2], base[5])


class RunnerFalso:
    """Only the state the router reads: free by default, or the routine the test says is running."""

    def __init__(self):
        self.estado = {"estado": "livre"}

    def state(self):
        return self.estado


class EdicaoManualNoSharePointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.caminhos = sebrae_novos.caminhos_padrao(Path(self.tmp.name))
        self.runner = RunnerFalso()
        router = create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: self.caminhos, max_upload_bytes=lambda: 10_000_000, registros=lambda: [],
            relatorio_chamados=lambda: None, runner=lambda: self.runner))
        endpoint = next(route.endpoint for route in router.routes if route.path == "/api/sebrae/dashboard")
        escopo = dict(zip(endpoint.__code__.co_freevars, (cell.cell_contents for cell in endpoint.__closure__)))
        self.importar_bloqueado = escopo["_importar_bloqueado"]
        self.rotas = {route.path: route.endpoint for route in router.routes if "POST" in route.methods}
        self.saida = sebrae_novos.caminho_saida(self.caminhos, NOME_ATUALIZADO)
        self.preservados = self.saida.parent / "preservados"
        self.base = dashboard()

    def importar(self, conteudo: bytes, automatico: bool) -> dict:
        resposta = self.importar_bloqueado(conteudo, ler_coluna_c(conteudo), "Dashboard.xlsx", automatico)
        return json.loads(resposta.body)

    def versao(self) -> str:
        return sebrae_novos.ler_existentes(self.caminhos.existentes)["versao"]

    def atualizar(self, **corpo) -> dict:
        resposta = self.rotas["/api/sebrae/dashboard/atualizar"](AtualizarPayload(versao_importacao=self.versao(), **corpo))
        return json.loads(resposta.body)

    def importar_e_gerar_saida_pendente(self) -> bytes:
        """The user imported the Dashboard and clicked "Atualizar Dashboard": a real output waits to be sent."""
        self.importar(self.base, False)
        self.atualizar(edicoes=[ChamadoManual(numero=TICKETS[0], B="REDE")])
        self.assertTrue(sebrae_novos.dashboard_saida_pendente(self.caminhos))
        return self.saida.read_bytes()

    def assertSaidaPreservada(self, pendente: bytes):
        self.assertEqual([p.read_bytes() for p in self.preservados.glob("*.xlsx")], [pendente])
        self.assertFalse(self.saida.exists())
        self.assertFalse(sebrae_novos.dashboard_saida_pendente(self.caminhos))

    def assertNovaBaseIgual(self, baixado: bytes):
        importado = sebrae_novos.ler_existentes(self.caminhos.existentes)
        self.assertEqual(importado["numeros"], ler_coluna_c(baixado))
        self.assertEqual(sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(self.caminhos), importado["sha256"]), baixado)

    # 1. row added by hand
    def test_row_filled_in_sharepoint_does_not_block_the_automatic_import(self):
        pendente = self.importar_e_gerar_saida_pendente()
        baixado = linha_preenchida_a_mao(self.base)
        corpo = self.importar(baixado, True)
        self.assertTrue(corpo["saida_anterior_preservada"])
        self.assertTrue(corpo["saida_pendente_substituida"])
        self.assertIn("preservados", corpo["aviso"])
        self.assertIn("Atualizar Dashboard", corpo["aviso"])
        self.assertSaidaPreservada(pendente)
        self.assertNovaBaseIgual(baixado)
        importado = sebrae_novos.ler_existentes(self.caminhos.existentes)
        self.assertIn(TICKET_A_MAO, importado["numeros"])
        self.assertIn(TICKET_A_MAO, {aberto["chamado"] for aberto in importado["abertos"]})
        self.assertNotIn(TICKET_A_MAO, corpo["aviso"])

    # 2. SharePoint equal to the base
    def test_unchanged_sharepoint_keeps_the_pending_output_and_asks_to_send_it(self):
        pendente = self.importar_e_gerar_saida_pendente()
        versao = self.versao()
        with self.assertRaisesRegex(DomainConflictError, "não mudou desde a importação.*Enviar ao SharePoint"):
            self.importar(self.base, True)
        self.assertEqual(self.saida.read_bytes(), pendente)
        self.assertFalse(self.preservados.exists())
        self.assertEqual(self.versao(), versao)

    def test_resaved_base_in_sharepoint_still_counts_as_unchanged(self):
        pendente = self.importar_e_gerar_saida_pendente()
        regravado = regravar(self.base, lambda folha: folha.replace(' s="60"', ' s="61"'))
        self.assertNotEqual(regravado, self.base)
        with self.assertRaises(DomainConflictError):
            self.importar(regravado, True)
        self.assertEqual(self.saida.read_bytes(), pendente)

    # 3. SharePoint equal to the pending output (already sent, or sent and re-saved)
    def test_sharepoint_equal_to_the_pending_output_imports_without_warning(self):
        pendente = self.importar_e_gerar_saida_pendente()
        corpo = self.importar(pendente, True)
        self.assertTrue(corpo["saida_anterior_preservada"])
        self.assertNotIn("aviso", corpo)
        self.assertNotIn("saida_pendente_substituida", corpo)
        self.assertSaidaPreservada(pendente)
        self.assertNovaBaseIgual(pendente)

    def test_sharepoint_resave_of_the_pending_output_imports_without_warning(self):
        pendente = self.importar_e_gerar_saida_pendente()
        resalvo = regravar(pendente, lambda folha: folha.replace(' s="60"', ' s="61"'))
        self.assertNotEqual(resalvo, pendente)
        corpo = self.importar(resalvo, True)
        self.assertNotIn("aviso", corpo)
        self.assertSaidaPreservada(pendente)

    # 3b. SharePoint equal to the file this site sent before, while a newer output waits (O1 sent, O2 pending)
    def test_sharepoint_equal_to_the_last_sent_file_keeps_the_newer_pending_output(self):
        enviado = self.importar_e_gerar_saida_pendente()
        fin.gravar_enviado(Path(self.tmp.name), hashlib.sha256(enviado).hexdigest(), enviado)
        self.atualizar(edicoes=[ChamadoManual(numero=TICKETS[1], B="REDE")])
        pendente = self.saida.read_bytes()
        self.assertNotEqual(pendente, enviado)
        self.assertTrue(sebrae_novos.dashboard_saida_pendente(self.caminhos))
        resalvo = regravar(enviado, lambda folha: folha.replace(' s="60"', ' s="61"'))
        self.assertNotEqual(resalvo, enviado)
        for baixado in (enviado, resalvo):  # the same bytes, and SharePoint's re-save of them
            with self.subTest(re_salvo=baixado is resalvo):
                with self.assertRaisesRegex(DomainConflictError, "Enviar ao SharePoint"):
                    self.importar(baixado, True)
                self.assertEqual(self.saida.read_bytes(), pendente)
                self.assertFalse(self.preservados.exists())

    # 4. only a reorder
    def test_only_reordered_rows_import_and_the_output_is_preserved(self):
        pendente = self.importar_e_gerar_saida_pendente()
        baixado = reordenar(self.base, [5, 4, 3, 2])
        corpo = self.importar(baixado, True)
        self.assertTrue(corpo["saida_pendente_substituida"])
        self.assertSaidaPreservada(pendente)
        self.assertNovaBaseIgual(baixado)

    # 5. reorder plus a filled row (the real case)
    def test_reorder_plus_filled_row_imports_and_keeps_the_new_ticket(self):
        pendente = self.importar_e_gerar_saida_pendente()
        baixado = linha_preenchida_a_mao(reordenar(self.base, [5, 4, 3, 2]))
        corpo = self.importar(baixado, True)
        self.assertIn("aviso", corpo)
        self.assertSaidaPreservada(pendente)
        self.assertNovaBaseIgual(baixado)
        self.assertIn(TICKET_A_MAO, sebrae_novos.ler_existentes(self.caminhos.existentes)["numeros"])

    def test_the_manual_import_still_replaces_the_pending_output_but_keeps_its_bytes(self):
        pendente = self.importar_e_gerar_saida_pendente()
        corpo = self.importar(linha_preenchida_a_mao(self.base), False)
        self.assertTrue(corpo["saida_anterior_preservada"])
        self.assertNotIn("aviso", corpo)  # only the automatic import explains a replaced pending output
        self.assertSaidaPreservada(pendente)

    # 6. manual cell kept when the form field is blank
    def test_manual_cell_filled_in_sharepoint_survives_a_blank_form_field(self):
        self.importar_e_gerar_saida_pendente()
        baixado = preencher(self.base, 2, {"J": "INCIDENTE", "S": "OUTRO"})
        self.importar(baixado, True)
        aberto = next(a for a in sebrae_novos.ler_existentes(self.caminhos.existentes)["abertos"] if a["chamado"] == TICKETS[0])
        self.assertEqual((aberto["valores"]["J"], aberto["valores"]["S"]), ("INCIDENTE", "OUTRO"))
        self.atualizar(edicoes=[ChamadoManual(numero=TICKETS[0], B="REDE")])  # J and S left blank in the form
        linha = G.valores_dos_chamados(self.saida.read_bytes())[2]
        self.assertEqual(linha[G.COLUNAS_DE_DADO.index("J")], "INCIDENTE")
        self.assertEqual(linha[G.COLUNAS_DE_DADO.index("S")], "OUTRO")
        self.assertEqual(linha[G.COLUNAS_DE_DADO.index("B")], "REDE")
        self.assertEqual(linha[G.COLUNAS_DE_DADO.index("C")], TICKETS[0])  # column C is never rewritten

    # 6b. a running finalization wins over the classification of the downloaded file
    def test_active_routine_blocks_the_import_even_when_sharepoint_equals_the_base(self):
        pendente = self.importar_e_gerar_saida_pendente()
        for rotina in ("fechar", "enviar"):
            with self.subTest(rotina=rotina):
                self.runner.estado = {"estado": "em_andamento", "rotina": rotina}
                with self.assertRaisesRegex(DomainConflictError, "Aguarde a finalização"):
                    self.importar(self.base, True)
        self.assertEqual(self.saida.read_bytes(), pendente)
        self.assertFalse(self.preservados.exists())

    def test_waiting_finalization_job_blocks_the_import_even_when_sharepoint_equals_the_base(self):
        pendente = self.importar_e_gerar_saida_pendente()
        fin.gravar_job(Path(self.tmp.name), [TICKETS[0]])
        with self.assertRaisesRegex(DomainConflictError, "Aguarde a finalização"):
            self.importar(self.base, True)
        self.assertEqual(self.saida.read_bytes(), pendente)
        self.assertFalse(self.preservados.exists())

    # 7. draft ticket typed into SharePoint by hand
    def test_draft_ticket_typed_by_hand_gets_the_specific_message(self):
        novo = ChamadoSoftExpert(
            TICKET_A_MAO, titulo=TITULO_A_MAO, descricao="Descricao do chamado", solicitante="Camila Lopes",
            habilitada_em="26/10/2026, 17:25:23",
        )
        sebrae_novos.salvar_novos(self.caminhos.novos, [novo], [], 0, {})
        self.importar(self.base, False)
        self.importar(linha_preenchida_a_mao(self.base), False)  # typed after the search, then imported
        with self.assertRaises(DomainValidationError) as erro:
            self.rotas["/api/sebrae/dashboard/atualizar"](AtualizarPayload(
                versao_importacao=self.versao(), chamados=[ChamadoManual(numero=TICKET_A_MAO, A="CLIENTE", D="EM ABERTO", J="INCIDENTE")]))
        self.assertEqual(erro.exception.status_code, 422)
        detalhe = str(erro.exception.detail)
        self.assertIn(f"{TICKET_A_MAO} já está no Dashboard (incluído à mão depois da busca)", detalhe)
        self.assertIn("Chamados antigos em aberto", detalhe)
        self.assertNotIn(TITULO_A_MAO, detalhe)
        self.assertFalse(self.saida.exists())

    def test_ticket_unknown_to_both_the_search_and_the_dashboard_keeps_the_old_message(self):
        sebrae_novos.salvar_novos(self.caminhos.novos, [], [], 0, {})
        self.importar(self.base, False)
        with self.assertRaisesRegex(DomainValidationError, "UTIC-2026-4242 não está entre os chamados novos"):
            self.rotas["/api/sebrae/dashboard/atualizar"](AtualizarPayload(
                versao_importacao=self.versao(), chamados=[ChamadoManual(numero="UTIC-2026-4242", A="CLIENTE", D="EM ABERTO", J="INCIDENTE")]))


if __name__ == "__main__":
    unittest.main()
