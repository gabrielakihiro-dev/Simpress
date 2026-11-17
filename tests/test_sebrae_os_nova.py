"""OS nova sugerida (F5): casos 1 a 3, recusas, chave forte, ``trocas_e`` e o registro ``sebrae_os_recusadas.json``.

Todos os dados são sintéticos (nenhum nome, texto ou número real)."""

import json
import tempfile
import unittest
from pathlib import Path

from core.errors import DomainBusyError, DomainValidationError
from domains import sebrae_os_recusadas as recusadas_store
from domains.sebrae_os_nova import os_novas, trocas_e


def oracle(os_, assunto="", descricao="", data="2026-11-01T10:00:00"):
    return {"ordem_servico": os_, "assunto": assunto, "descricao": descricao, "data_criacao": data}


def linha(serie, simpress=(), oracle_=(), chamados_cliente=()):
    return {
        "serie": serie, "oracle": list(oracle_),
        "simpress": {"ordens_servico": list(simpress), "chamados_cliente": list(chamados_cliente)},
    }


def aberto(numero="UTIC-2026-0094", K="SER1", E="", titulo="Notebook lento", descricao="", usuario=""):
    return {"numero": numero, "titulo": titulo, "descricao": descricao, "usuario": usuario, "automaticos": {"K": K, "E": E}}


def calcular(abertos, chamados, vinculos=(), recusadas=None, registros=(), indice=None):
    return os_novas(abertos, {"chamados": chamados}, list(vinculos), recusadas or {}, list(registros), indice)


class CasoEPreenchidaTest(unittest.TestCase):
    def test_os_mais_nova_sem_chave_forte_e_sugestao_com_os_dois_textos_e_o_corpo_do_aceitar(self):
        chamados = [linha("SER1", oracle_=[
            oracle("100", "Teclado quebrado", "Troca de teclado", "2026-10-01T08:00:00"),
            oracle("200", "Tela piscando", "Notebook com a tela piscando", "2026-11-05T09:30:00"),
        ])]
        resultado = calcular([aberto(E="100", titulo="Tela do notebook piscando")], chamados)
        self.assertEqual(list(resultado), ["UTIC-2026-0094"])
        sugestao = resultado["UTIC-2026-0094"]
        self.assertEqual(sugestao["tipo"], "sugestao")
        self.assertEqual(sugestao["atual"], {"os": "100", "assunto": "Teclado quebrado", "descricao": "Troca de teclado", "data": "01/10/2026"})
        self.assertEqual(sugestao["nova"], {
            "os": "200", "serie": "SER1", "fonte": "oracle", "assunto": "Tela piscando",
            "descricao": "Notebook com a tela piscando", "data": "05/11/2026",
        })
        self.assertEqual(sugestao["aceitar"], {"fonte": "oracle", "serie": "SER1", "os": "200", "ano": 2026, "numero": "0094"})
        self.assertEqual(sugestao["sinais"], {"mesma_serie": True, "nome": False, "assunto": True, "numero_chamado": False})
        self.assertEqual(set(sugestao), {"tipo", "atual", "nova", "sinais", "aceitar"})

    def test_chave_forte_no_texto_da_os_troca_sozinha_e_a_mais_nova_entre_as_fortes_ganha(self):
        chamados = [linha("SER1", oracle_=[
            oracle("100", "Antiga"),
            oracle("200", "Chamado UTIC-2026-0094 aberto", "Substituir bateria"),
            oracle("250", "Sem relação", "Outro assunto"),
            oracle("300", "Referente ao utic 2026 94", "Mesmo caso"),
            oracle("400", "Sem chave forte", "Última OS da série"),
        ])]
        sugestao = calcular([aberto(E="100")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["tipo"], sugestao["nova"]["os"]), ("troca", "300"))
        self.assertTrue(sugestao["sinais"]["numero_chamado"])
        self.assertEqual(sugestao["atual"]["os"], "100")

    def test_chave_forte_so_de_os_mais_velha_ou_igual_a_e_nao_troca(self):
        chamados = [linha("SER1", oracle_=[oracle("100", "UTIC-2026-0094"), oracle("200", "Sem chave")])]
        self.assertEqual(calcular([aberto(E="200")], chamados), {})

    def test_numero_com_mais_digitos_nao_vale_como_chave_forte(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200", "UTIC-2026-0940")])]
        sugestao = calcular([aberto(E="100")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["tipo"], sugestao["sinais"]["numero_chamado"]), ("sugestao", False))

    def test_chave_forte_no_chamado_cliente_do_ux_de_os_so_da_simpress(self):
        chamados = [linha("SER1", simpress=["100", "200"], chamados_cliente=["UTIC-2026-0094 / outro texto"])]
        sugestao = calcular([aberto(E="100")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["tipo"], sugestao["nova"]["os"], sugestao["nova"]["fonte"]), ("troca", "200", "simpress"))
        self.assertEqual(sugestao["nova"]["assunto"], "")
        self.assertEqual(sugestao["aceitar"]["fonte"], "simpress")

    def test_os_recusada_para_o_chamado_nunca_volta_e_a_proxima_candidata_aparece(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200"), oracle("300")])]
        self.assertEqual(calcular([aberto(E="100")], chamados, recusadas={"UTIC-2026-0094": ["200", "300"]}), {})
        sugestao = calcular([aberto(E="100")], chamados, recusadas={"UTIC-2026-0094": ["300"]})["UTIC-2026-0094"]
        self.assertEqual(sugestao["nova"]["os"], "200")
        outro = calcular([aberto(E="100")], chamados, recusadas={"UTIC-2026-0001": ["300"]})["UTIC-2026-0094"]
        self.assertEqual(outro["nova"]["os"], "300")  # a recusa vale só para o chamado dela

    def test_troca_com_chave_forte_recusada_cai_para_a_sugestao_da_mais_nova(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200", "UTIC-2026-0094"), oracle("300")])]
        sugestao = calcular([aberto(E="100")], chamados, recusadas={"UTIC-2026-0094": ["200"]})["UTIC-2026-0094"]
        self.assertEqual((sugestao["tipo"], sugestao["nova"]["os"]), ("sugestao", "300"))

    def test_e_fora_da_serie_qualquer_os_da_serie_e_candidata_mesmo_com_numero_menor(self):
        chamados = [linha("SER1", oracle_=[oracle("50", "Da série")])]
        sugestao = calcular([aberto(E="999")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["tipo"], sugestao["nova"]["os"]), ("sugestao", "50"))
        self.assertEqual(sugestao["atual"], {"os": "999", "assunto": "", "descricao": "", "data": ""})  # fora do relatório: só o número

    def test_e_fora_da_serie_com_chave_forte_troca(self):
        chamados = [linha("SER1", oracle_=[oracle("50", "UTIC-2026-0094")])]
        self.assertEqual(calcular([aberto(E="999")], chamados)["UTIC-2026-0094"]["tipo"], "troca")

    def test_e_igual_a_unica_os_da_serie_nao_gera_nada(self):
        self.assertEqual(calcular([aberto(E="100")], [linha("SER1", oracle_=[oracle("100")])]), {})

    def test_vinculo_manual_vale_como_e_efetiva_no_lugar_da_planilha(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200"), oracle("300")])]
        vinculo = {"fonte": "oracle", "serie": "SER1", "os": "200", "ano": 2026, "numero": "0094", "chamado": "UTIC-2026-0094", "origem": "manual"}
        sugestao = calcular([aberto(E="100")], chamados, vinculos=[vinculo])["UTIC-2026-0094"]
        self.assertEqual((sugestao["atual"]["os"], sugestao["nova"]["os"]), ("200", "300"))

    def test_macbook_usa_a_outra_grafia_da_serie_so_com_resultado_unico(self):
        chamados = [linha("CXC9F072K1", oracle_=[oracle("100"), oracle("200")])]
        indice = {"unique": {"CXC9F072K1": "PRMAC001"}, "details_serials": {"SCXC9F072K1"}}
        achado = calcular([aberto(K="SCXC9F072K1", E="100")], chamados, indice=indice)["UTIC-2026-0094"]
        self.assertEqual((achado["nova"]["os"], achado["nova"]["serie"], achado["aceitar"]["serie"]), ("200", "CXC9F072K1", "CXC9F072K1"))
        self.assertEqual(calcular([aberto(K="SCXC9F072K1", E="100")], chamados), {})

    def test_sinal_de_nome_na_os_da_mesma_serie(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200", "Mouse", "Equipamento da Camila Lopes sem mouse")])]
        sugestao = calcular([aberto(E="100", usuario="Camila Lopes")], chamados)["UTIC-2026-0094"]
        self.assertTrue(sugestao["sinais"]["nome"])
        sem_nome = calcular([aberto(E="100", usuario="Pedro")], chamados)["UTIC-2026-0094"]
        self.assertFalse(sem_nome["sinais"]["nome"])  # nome com uma palavra só não vale


class CasoEVaziaTest(unittest.TestCase):
    def test_serie_com_os_e_e_vazia_e_preenchimento_automatico_nao_sugestao(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200", "UTIC-2026-0094")])]
        self.assertEqual(calcular([aberto(E="")], chamados), {})

    def test_serie_sem_os_e_sem_chave_forte_nem_nome_nao_gera_nada(self):
        chamados = [linha("OUTRA", oracle_=[oracle("500", "Assunto qualquer", "Sem relação")])]
        self.assertEqual(calcular([aberto(E="", K="SER1", usuario="Camila Lopes")], chamados), {})

    def test_sem_os_pela_chave_forte_em_outra_serie_sem_trocar_nada_sozinha(self):
        chamados = [linha("OUTRA", oracle_=[oracle("500", "UTIC-2026-0094 notebook", "Descrição", "2026-11-10T12:00:00"), oracle("600", "Nada")])]
        sugestao = calcular([aberto(E="", K="SER1")], chamados)["UTIC-2026-0094"]
        self.assertEqual(sugestao["tipo"], "sem_os")
        self.assertIsNone(sugestao["atual"])
        self.assertEqual(sugestao["nova"]["os"], "500")
        self.assertEqual(sugestao["nova"]["serie"], "OUTRA")
        self.assertEqual(sugestao["aceitar"], {"fonte": "oracle", "serie": "OUTRA", "os": "500", "ano": 2026, "numero": "0094"})
        self.assertEqual(sugestao["sinais"], {"mesma_serie": False, "nome": False, "assunto": False, "numero_chamado": True})

    def test_sem_os_pelo_nome_com_duas_palavras_ou_mais(self):
        chamados = [linha("OUTRA", oracle_=[
            oracle("500", "Impressora", "Atendimento a Camila Lopes na regional"), oracle("600", "Outro caso", "Para Pedro Alves"),
        ])]
        sugestao = calcular([aberto(E="", K="SER1", usuario="Camila Lopes")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["tipo"], sugestao["nova"]["os"]), ("sem_os", "500"))
        self.assertTrue(sugestao["sinais"]["nome"])
        self.assertFalse(sugestao["sinais"]["numero_chamado"])
        self.assertEqual(calcular([aberto(E="", K="SER1", usuario="Camila")], chamados), {})  # uma palavra não basta

    def test_mais_de_uma_os_pela_chave_forte_ou_pelo_nome_e_ambiguo_e_nao_gera_nada(self):
        duas_fortes = [linha("A", oracle_=[oracle("500", "UTIC-2026-0094")]), linha("B", oracle_=[oracle("600", "utic-2026-94")])]
        self.assertEqual(calcular([aberto(E="", K="SER1")], duas_fortes), {})
        dois_nomes = [linha("A", oracle_=[oracle("500", "Camila Lopes")]), linha("B", oracle_=[oracle("600", "Camila Lopes")])]
        self.assertEqual(calcular([aberto(E="", K="SER1", usuario="Camila Lopes")], dois_nomes), {})

    def test_chave_forte_tem_prioridade_sobre_o_nome(self):
        chamados = [linha("A", oracle_=[oracle("500", "Camila Lopes"), oracle("600", "UTIC-2026-0094")])]
        sugestao = calcular([aberto(E="", K="SER1", usuario="Camila Lopes")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["nova"]["os"], sugestao["sinais"]["numero_chamado"]), ("600", True))

    def test_solicitante_de_sistema_nao_conta_como_nome_para_achar_a_os(self):
        chamados = [linha("A", oracle_=[oracle("500", "Impressora", "Atendimento a API SEBRAE na regional")])]
        self.assertEqual(calcular([aberto(E="", K="SER1", usuario="API SEBRAE")], chamados), {})
        pessoa = calcular([aberto(E="", K="SER1", usuario="Camila Lopes")], [linha("A", oracle_=[oracle("500", "Camila Lopes")])])
        self.assertEqual(pessoa["UTIC-2026-0094"]["nova"]["os"], "500")  # o mesmo caminho com uma pessoa continua valendo

    def test_os_recusada_nao_volta_no_caso_sem_os(self):
        chamados = [linha("A", oracle_=[oracle("500", "UTIC-2026-0094")])]
        self.assertEqual(calcular([aberto(E="", K="SER1")], chamados, recusadas={"UTIC-2026-0094": ["500"]}), {})

    def test_os_so_da_simpress_com_chamado_cliente_tambem_conta(self):
        chamados = [linha("A", simpress=["500"], chamados_cliente=["UTIC-2026-0094"])]
        sugestao = calcular([aberto(E="", K="SER1")], chamados)["UTIC-2026-0094"]
        self.assertEqual((sugestao["nova"]["os"], sugestao["nova"]["fonte"], sugestao["aceitar"]["fonte"]), ("500", "simpress", "simpress"))

    def test_chamado_sem_serie_e_sem_e_so_procura_no_relatorio_inteiro(self):
        chamados = [linha("A", oracle_=[oracle("500", "UTIC-2026-0094")])]
        self.assertEqual(calcular([aberto(E="", K="")], chamados)["UTIC-2026-0094"]["tipo"], "sem_os")

    def test_vinculo_manual_com_e_vazia_na_planilha_vira_caso_1(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200")])]
        vinculo = {"fonte": "oracle", "serie": "SER1", "os": "100", "ano": 2026, "numero": "0094", "chamado": "UTIC-2026-0094", "origem": "manual"}
        self.assertEqual(calcular([aberto(E="")], chamados, vinculos=[vinculo])["UTIC-2026-0094"]["nova"]["os"], "200")


class OsNaEDeOutroChamadoTest(unittest.TestCase):
    """Uma OS que já está na E efetiva de OUTRO chamado aberto nunca vira sugestão, troca nem "sem OS" (decisão de 17/11/2026)."""

    def vinculo(self, numero, os_):
        return {"fonte": "oracle", "serie": "SER1", "os": os_, "ano": 2026, "numero": numero, "chamado": f"UTIC-2026-{numero}", "origem": "manual"}

    def test_caso_1_os_da_e_de_outro_chamado_da_mesma_serie_nao_e_sugerida(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200")])]
        a, b = aberto("UTIC-2026-0001", E="100"), aberto("UTIC-2026-0002", E="200")
        self.assertEqual(calcular([a, b], chamados), {})
        sozinho = calcular([a], chamados)  # sem o outro chamado a 200 volta a ser a candidata
        self.assertEqual(sozinho["UTIC-2026-0001"]["nova"]["os"], "200")

    def test_caso_1_chave_forte_na_os_de_outro_chamado_tambem_nao_troca(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200", "UTIC-2026-0001 aberto"), oracle("300")])]
        a, b = aberto("UTIC-2026-0001", E="100"), aberto("UTIC-2026-0002", E="200")
        resultado = calcular([a, b], chamados)  # a OS 200 cita o chamado 1, mas é da E do chamado 2: só a 300 resta
        self.assertEqual((resultado["UTIC-2026-0001"]["tipo"], resultado["UTIC-2026-0001"]["nova"]["os"]), ("sugestao", "300"))

    def test_caso_1_vinculo_manual_de_outro_chamado_conta_como_a_e_dele(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200")])]
        a, b = aberto("UTIC-2026-0001", E="100"), aberto("UTIC-2026-0002", E="")
        self.assertEqual(calcular([a, b], chamados, vinculos=[self.vinculo("0002", "200")]), {})

    def test_caso_3_os_achada_pelo_nome_que_ja_esta_na_e_de_outro_chamado_nao_e_sugerida(self):
        chamados = [linha("OUTRA", oracle_=[oracle("500", "Camila Lopes")])]
        sem_dono = calcular([aberto("UTIC-2026-0001", E="", K="SER1", usuario="Camila Lopes")], chamados)
        self.assertEqual(sem_dono["UTIC-2026-0001"]["nova"]["os"], "500")
        a, b = aberto("UTIC-2026-0001", E="", K="SER1", usuario="Camila Lopes"), aberto("UTIC-2026-0002", E="500", K="OUTRA")
        self.assertNotIn("UTIC-2026-0001", calcular([a, b], chamados))

    def test_caso_3_chave_forte_na_os_que_esta_na_e_de_outro_chamado_nao_e_sugerida(self):
        chamados = [linha("OUTRA", oracle_=[oracle("500", "UTIC-2026-0001 notebook")])]
        a, b = aberto("UTIC-2026-0001", E="", K="SER1"), aberto("UTIC-2026-0002", E="500", K="OUTRA")
        self.assertEqual(calcular([a, b], chamados), {})


class EntradasInvalidasTest(unittest.TestCase):
    def test_linha_sem_utic_completo_ou_ano_fora_da_faixa_e_ignorada(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200")])]
        abertos = [aberto("linha:2", E="100"), aberto("27371 / UTIC-2026-0094", E="100"), aberto("UTIC-1999-0001", E="100")]
        self.assertEqual(calcular(abertos, chamados), {})

    def test_sem_relatorio_ou_relatorio_sem_chamados(self):
        self.assertEqual(os_novas([aberto(E="100")], None, [], {}, []), {})
        self.assertEqual(os_novas([aberto(E="100")], {"chamados": "x"}, [], {}, []), {})

    def test_assunto_diferente_nao_acende_o_sinal(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200", "Impressora travada", "Papel preso")])]
        sugestao = calcular([aberto(E="100", titulo="Notebook sem bateria")], chamados)["UTIC-2026-0094"]
        self.assertFalse(sugestao["sinais"]["assunto"])

    def test_um_chamado_por_numero_com_varios_abertos(self):
        chamados = [linha("SER1", oracle_=[oracle("100"), oracle("200")]), linha("SER2", oracle_=[oracle("10"), oracle("20")])]
        resultado = calcular([aberto("UTIC-2026-0001", K="SER1", E="100"), aberto("UTIC-2026-0002", K="SER2", E="10")], chamados)
        self.assertEqual({n: s["nova"]["os"] for n, s in resultado.items()}, {"UTIC-2026-0001": "200", "UTIC-2026-0002": "20"})


class TrocasETest(unittest.TestCase):
    def sugestao(self, tipo, nova="200"):
        return {"tipo": tipo, "nova": {"os": nova}}

    def test_troca_entra_e_sugestao_nao(self):
        abertos = [aberto("UTIC-2026-0001", E="100"), aberto("UTIC-2026-0002", E="100")]
        sugestoes = {"UTIC-2026-0001": self.sugestao("troca"), "UTIC-2026-0002": self.sugestao("sugestao")}
        self.assertEqual(trocas_e(sugestoes, abertos, []), {"UTIC-2026-0001": "200"})

    def test_vinculo_manual_diferente_da_e_preenchida_entra_e_o_igual_ou_com_e_vazia_nao(self):
        abertos = [aberto("UTIC-2026-0001", E="100"), aberto("UTIC-2026-0002", E="300"), aberto("UTIC-2026-0003", E="")]
        vinculos = [
            {"fonte": "oracle", "serie": "S", "os": os_, "ano": 2026, "numero": numero, "chamado": f"UTIC-2026-{numero}", "origem": "manual"}
            for os_, numero in (("200", "0001"), ("300", "0002"), ("400", "0003"))
        ]
        self.assertEqual(trocas_e({}, abertos, vinculos), {"UTIC-2026-0001": "200"})

    def test_troca_vale_mais_que_o_vinculo_manual_e_igual_a_e_gravada_e_filtrada(self):
        abertos = [aberto("UTIC-2026-0001", E="100"), aberto("UTIC-2026-0002", E="200")]
        vinculo = {"fonte": "oracle", "serie": "S", "os": "150", "ano": 2026, "numero": "0001", "chamado": "UTIC-2026-0001", "origem": "manual"}
        sugestoes = {"UTIC-2026-0001": self.sugestao("troca", "300"), "UTIC-2026-0002": self.sugestao("troca", "200")}
        self.assertEqual(trocas_e(sugestoes, abertos, [vinculo]), {"UTIC-2026-0001": "300"})

    def test_chamado_que_nao_esta_em_abertos_e_ignorado(self):
        self.assertEqual(trocas_e({"UTIC-2026-0009": self.sugestao("troca")}, [aberto("UTIC-2026-0001", E="100")], []), {})


class RecusadasTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pasta = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_sem_arquivo_le_vazio_e_recusar_grava_no_formato_do_registro(self):
        self.assertEqual(recusadas_store.ler(self.pasta), {})
        self.assertEqual(recusadas_store.recusar(self.pasta, "utic-2026-0094", "ab12"), {"numero": "UTIC-2026-0094", "os": "AB12"})
        gravado = json.loads((self.pasta / "sebrae_os_recusadas.json").read_text(encoding="utf-8"))
        self.assertEqual(gravado, {"version": 1, "recusadas": {"UTIC-2026-0094": ["AB12"]}})
        self.assertEqual(recusadas_store.ler(self.pasta), {"UTIC-2026-0094": ["AB12"]})

    def test_repetir_a_mesma_recusa_nao_duplica_e_outra_os_e_outro_chamado_se_somam(self):
        recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "7400000")
        recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "7400000")
        recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "7400001")
        recusadas_store.recusar(self.pasta, "linha:5", "7400000")
        self.assertEqual(recusadas_store.ler(self.pasta), {"UTIC-2026-0094": ["7400000", "7400001"], "linha:5": ["7400000"]})

    def test_os_com_espaco_ou_hifen_e_gravada_na_mesma_chave_do_cruzamento(self):
        self.assertEqual(recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "os 100")["os"], "OS100")
        self.assertEqual(recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "os-9")["os"], "OS-9")
        recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "OS100")  # a mesma OS escrita de outro jeito não duplica
        self.assertEqual(recusadas_store.ler(self.pasta), {"UTIC-2026-0094": ["OS100", "OS-9"]})

    def test_os_recusada_com_espaco_no_relatorio_nunca_volta_a_ser_sugerida(self):
        chamados = [linha("SER1", oracle_=[oracle("os 200")])]  # E fora da série: toda OS dela é candidata
        self.assertEqual(calcular([aberto(E="999")], chamados)["UTIC-2026-0094"]["nova"]["os"], "os 200")
        recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "os 200")
        self.assertEqual(calcular([aberto(E="999")], chamados, recusadas=recusadas_store.ler(self.pasta)), {})

    def test_ler_ou_none_devolve_o_registro_ou_none_quando_ilegivel_sem_dado_no_log(self):
        self.assertEqual(recusadas_store.ler_ou_none(self.pasta), {})
        recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "100")
        self.assertEqual(recusadas_store.ler_ou_none(self.pasta), {"UTIC-2026-0094": ["100"]})
        (self.pasta / "sebrae_os_recusadas.json").write_text("{ nao e json", encoding="utf-8")
        with self.assertLogs(recusadas_store.logger, level="WARNING") as log:
            self.assertIsNone(recusadas_store.ler_ou_none(self.pasta))
        self.assertEqual(recusadas_store.ler_ou_vazio(self.pasta), {})
        self.assertNotIn("UTIC", "".join(log.output))

    def test_os_invalida_e_numero_invalido_dao_422_e_nada_e_gravado(self):
        for invalida in ("", "  ", "12_34", "7/1", "a" * 33, "7400000;rm", None):
            with self.assertRaises(DomainValidationError) as erro:
                recusadas_store.recusar(self.pasta, "UTIC-2026-0094", invalida)
            self.assertEqual(erro.exception.status_code, 422)
        with self.assertRaises(DomainValidationError) as erro:
            recusadas_store.recusar(self.pasta, "chamado-qualquer", "100")
        self.assertEqual(erro.exception.status_code, 422)
        self.assertFalse((self.pasta / "sebrae_os_recusadas.json").exists())

    def test_arquivo_ilegivel_ou_de_estrutura_errada_e_preservado_e_recusar_para(self):
        arquivo = self.pasta / "sebrae_os_recusadas.json"
        for conteudo in ("{ nao e json", json.dumps({"version": 2, "recusadas": {}}), json.dumps({"version": 1, "recusadas": {"UTIC-2026-1": "100"}})):
            arquivo.write_text(conteudo, encoding="utf-8")
            with self.assertRaises(DomainBusyError):
                recusadas_store.ler(self.pasta)
            with self.assertRaises(DomainBusyError):
                recusadas_store.recusar(self.pasta, "UTIC-2026-0094", "100")
            self.assertEqual(arquivo.read_text(encoding="utf-8"), conteudo)
            with self.assertLogs(recusadas_store.logger, level="WARNING") as log:
                self.assertEqual(recusadas_store.ler_ou_vazio(self.pasta), {})
            self.assertNotIn("UTIC", "".join(log.output))  # o log leva só o tipo do erro

    def test_chave_fora_do_formato_no_json_editado_a_mao_fica_de_fora(self):
        (self.pasta / "sebrae_os_recusadas.json").write_text(
            json.dumps({"version": 1, "recusadas": {"UTIC-2026-0094": ["100", " "], "qualquer": ["200"]}}), encoding="utf-8",
        )
        self.assertEqual(recusadas_store.ler(self.pasta), {"UTIC-2026-0094": ["100"]})


if __name__ == "__main__":
    unittest.main()
