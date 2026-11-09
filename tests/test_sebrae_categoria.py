import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.sax.saxutils import escape

from domains import sebrae_categoria as C
from tests.test_sebrae_dashboard_gravacao import montar, partes_de, texto
from tests.test_sebrae_dashboard_router import RotasBase

OPCOES = ["CONFIGURAÇÃO", "DADOS", "DESLIGAMENTO", "ENDPOINT CENTER", "INSTALAÇÃO", "LENTIDÃO", "NOVO USUÁRIO", "OUTRO", "PERIFÉRICO"]
TODAS = OPCOES + list(C.CATEGORIAS_NOVAS)
CPF_VALIDO = "529.982.247-25"


def caso(titulo="", descricao="", atendimento="", solicitante="Fulana Souza", b="", j=""):
    return {"G": titulo, "H": descricao, "F": atendimento, "I": solicitante, "B": b, "J": j}


def planilha_de(casos):
    """Dashboard de verdade (aba CHAMADOS) com uma linha por caso, preenchendo B, F, G, H, I e J."""
    ids = tuple(f"UTIC-2026-{n:04d}" for n in range(1, len(casos) + 1))
    base = montar(ids, ultima=len(casos) + 3, status=("EM ABERTO",) * len(casos))
    partes = partes_de(base)
    folha = partes["xl/worksheets/sheet4.xml"].decode()
    for n, (chamado, dados) in enumerate(zip(ids, casos), start=2):
        folha = folha.replace(f"titulo {chamado}", escape(dados["G"]), 1)
        extra = "".join(texto(f"{letra}{n}", escape(dados[letra])) for letra in "BFHIJ" if dados[letra])
        folha = folha.replace(f'<c r="P{n}"', extra + f'<c r="P{n}"', 1)
    partes["xl/worksheets/sheet4.xml"] = folha.encode()
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
        for nome, dados in partes.items():
            arquivo.writestr(nome, dados)
    return saida.getvalue()


def documentos(b_ou_j, palavras, quantos, chave="b"):
    return [{"tokens": list(palavras), "b": b_ou_j if chave == "b" else "", "j": b_ou_j if chave == "j" else ""} for _ in range(quantos)]


def indice_b():
    """Naive Bayes de B com duas classes bem separadas, só com palavras que nenhuma regra conhece."""
    return C.treinar(documentos("LENTIDÃO", ("zebra", "girafa"), 6) + documentos("DADOS", ("banana", "laranja"), 6))


def indice_j():
    return C.treinar(documentos("INCIDENTE", ("zebra", "girafa"), 6, "j") + documentos("SOLICITAÇÃO", ("banana", "laranja"), 6, "j"))


class RegrasDeCategoriaTest(unittest.TestCase):
    def test_regras_do_usuario(self):
        casos = (
            ("Desligamento do colaborador Marcos", "DESLIGAMENTO"),
            ("Remover o acesso de quem saiu", "DESLIGAMENTO"),
            ("Criar login para o novo colaborador", "NOVO USUÁRIO"),
            ("Criação de usuário para a nova estagiária", "NOVO USUÁRIO"),
            ("Instalar o programa de edição", "INSTALAÇÃO"),
            ("Reinstalação do Windows", "INSTALAÇÃO"),
            ("O teclado parou de funcionar", "PERIFÉRICO"),
            ("Trocar o mouse e o monitor", "PERIFÉRICO"),
            ("Computer added", "ENDPOINT CENTER"),
            ("Central inactivity alerta", "ENDPOINT CENTER"),
            ("Impressora sem toner", "IMPRESSORA"),
            ("Licença do Acrobat vencida", "LICENÇA"),
            ("Erro ao abrir o SAP", "SISTEMA"),
            ("VPN não conecta", "REDE"),
            ("Sem internet na sala", "REDE"),
        )
        for titulo, esperado in casos:
            with self.subTest(titulo):
                self.assertEqual(C.sugerir(titulo, "", "", "Fulana Souza", TODAS, None), esperado)

    def test_atendimento_e_descricao_tambem_valem(self):
        self.assertEqual(C.sugerir("Pedido", "Preciso instalar o Teams", "", "Fulana Souza", TODAS, None), "INSTALAÇÃO")
        self.assertEqual(C.sugerir("Pedido", "", "Encaminhado para o desligamento", "Fulana Souza", TODAS, None), "DESLIGAMENTO")

    def test_prioridade_segue_a_ordem_das_regras(self):
        self.assertEqual(C.sugerir("Instalar impressora", "", "", "Fulana Souza", TODAS, None), "INSTALAÇÃO")
        self.assertEqual(C.sugerir("Desligamento: devolver teclado", "", "", "Fulana Souza", TODAS, None), "DESLIGAMENTO")

    def test_sistema_operacional_nao_e_sistema(self):
        self.assertEqual(C.sugerir("Atualizar o sistema operacional", "", "", "Fulana Souza", TODAS, None), "OUTRO")
        self.assertEqual(C.sugerir("O sistema de ponto caiu", "", "", "Fulana Souza", TODAS, None), "SISTEMA")

    def test_devolve_a_grafia_exata_das_opcoes_sem_distinguir_acento_nem_caixa(self):
        opcoes = ["Instalacao", "novo usuario", "Outro"]
        self.assertEqual(C.sugerir("Instalar programa", "", "", "Fulana Souza", opcoes, None), "Instalacao")
        self.assertEqual(C.sugerir("Novo usuário", "", "", "Fulana Souza", opcoes, None), "novo usuario")
        self.assertEqual(C.sugerir("Assunto qualquer", "", "", "Fulana Souza", opcoes, None), "Outro")

    def test_regra_com_rotulo_fora_das_opcoes_e_ignorada(self):
        opcoes = ["PERIFÉRICO", "OUTRO"]
        self.assertEqual(C.sugerir("Instalar o teclado", "", "", "Fulana Souza", opcoes, None), "PERIFÉRICO")
        self.assertEqual(C.sugerir("Impressora sem toner", "", "", "Fulana Souza", opcoes, None), "OUTRO")
        self.assertIsNone(C.sugerir("Impressora sem toner", "", "", "Fulana Souza", ["PERIFÉRICO"], None))

    def test_solicitante_api_sebrae_nunca_recebe_sugestao(self):
        for solicitante in ("API SEBRAE", "  api   sebrae "):
            with self.subTest(solicitante):
                self.assertIsNone(C.sugerir("Instalar programa", "", "", solicitante, TODAS, indice_b()))
                self.assertIsNone(C.sugerir_tipo("Instalar programa", "", "", solicitante, indice_j(), "INSTALAÇÃO"))
                self.assertIsNone(C.sugerir_tipo("Notebook não liga", "", "", solicitante, None))

    def test_texto_com_cpf_e_email_nao_vira_palavra_de_regra(self):
        titulo = f"Assunto geral do CPF {CPF_VALIDO} e do e-mail impressora@empresa.com.br"
        self.assertEqual(C.sugerir(titulo, "", "", "Fulana Souza", TODAS, None), "OUTRO")


class NaiveBayesTest(unittest.TestCase):
    def test_sugere_a_classe_do_texto(self):
        self.assertEqual(C.sugerir("zebra girafa", "", "", "Fulana Souza", TODAS, indice_b()), "LENTIDÃO")
        self.assertEqual(C.sugerir("banana laranja", "", "", "Fulana Souza", TODAS, indice_b()), "DADOS")

    def test_so_considera_classes_que_estao_nas_opcoes(self):
        sem_lentidao = [opcao for opcao in TODAS if opcao != "LENTIDÃO"]
        self.assertEqual(C.sugerir("zebra girafa", "", "", "Fulana Souza", sem_lentidao, indice_b()), "DADOS")
        so_outro = ["OUTRO", "REDE"]
        self.assertEqual(C.sugerir("zebra girafa", "", "", "Fulana Souza", so_outro, indice_b()), "OUTRO")

    def test_abaixo_do_limite_cai_em_outro_ou_em_nada(self):
        iguais = C.treinar(sum((documentos(nome, ("alfa", "beta"), 3) for nome in ("W", "X", "Y", "Z")), []))
        opcoes = ["W", "X", "Y", "Z", "OUTRO"]
        self.assertEqual(C.sugerir("alfa beta", "", "", "Fulana Souza", opcoes, iguais), "OUTRO")
        self.assertIsNone(C.sugerir("alfa beta", "", "", "Fulana Souza", opcoes[:-1], iguais))
        with patch.object(C, "LIMITE_NB", 0.2):
            self.assertIn(C.sugerir("alfa beta", "", "", "Fulana Souza", opcoes, iguais), {"W", "X", "Y", "Z"})

    def test_sem_indice_ou_com_indice_invalido_cai_em_outro(self):
        for indice in (None, {}, {"versao": 99, "b": {}, "j": {}, "mapa_b_j": {}}, {"versao": C.VERSAO_INDICE}):
            with self.subTest(indice):
                self.assertEqual(C.sugerir("zebra girafa", "", "", "Fulana Souza", TODAS, indice), "OUTRO")
                self.assertIsNone(C.sugerir("zebra girafa", "", "", "Fulana Souza", ["DADOS"], indice))

    def test_pontuar_soma_um_e_devolve_vazio_sem_classe_permitida(self):
        modelo = indice_b()["b"]
        probabilidades = C.pontuar(modelo, ["zebra"], OPCOES)
        self.assertAlmostEqual(sum(probabilidades.values()), 1.0)
        self.assertEqual(set(probabilidades), {"LENTIDÃO", "DADOS"})
        self.assertEqual(C.pontuar(modelo, ["zebra"], ["REDE"]), {})
        self.assertEqual(C.pontuar({}, ["zebra"], OPCOES), {})


class TipoTest(unittest.TestCase):
    def sugerir(self, titulo, indice=None, categoria=None, solicitante="Fulana Souza"):
        return C.sugerir_tipo(titulo, "", "", solicitante, indice, categoria)

    def test_pedido_explicito_vale_solicitacao(self):
        for titulo in ("Instalar o Office", "Reinstalação do antivírus", "Criar login para novo colaborador", "Nova conta de e-mail", "Desligamento de usuário"):
            with self.subTest(titulo):
                self.assertEqual(self.sugerir(titulo), C.SOLICITACAO)

    def test_falha_explicita_vale_incidente(self):
        for titulo in ("Notebook não liga", "Erro ao abrir a planilha", "Sem internet", "O sistema está lento", "Mouse quebrado"):
            with self.subTest(titulo):
                self.assertEqual(self.sugerir(titulo), C.INCIDENTE)

    def test_solicitacao_explicita_vence_incidente(self):
        self.assertEqual(self.sugerir("Instalar o programa que deu erro"), C.SOLICITACAO)

    def test_sem_indicio_e_sem_indice_nao_sugere(self):
        self.assertIsNone(self.sugerir("Assunto geral"))
        self.assertIsNone(self.sugerir("Assunto geral", {"versao": 99, "b": {}, "j": {}, "mapa_b_j": {}}))

    def test_sem_indicio_usa_o_naive_bayes_de_j(self):
        self.assertEqual(self.sugerir("zebra girafa", indice_j()), C.INCIDENTE)
        self.assertEqual(self.sugerir("banana laranja", indice_j()), C.SOLICITACAO)

    def test_regra_vence_o_naive_bayes(self):
        self.assertEqual(self.sugerir("banana laranja instalar", indice_j()), C.SOLICITACAO)
        self.assertEqual(self.sugerir("zebra girafa não liga", indice_j()), C.INCIDENTE)

    def test_etapa_mapa_usa_o_j_majoritario_da_categoria(self):
        indice = {**indice_j(), "mapa_b_j": {"DADOS": C.SOLICITACAO}}
        with patch.object(C, "ETAPA_FINAL_J", "mapa"):
            self.assertEqual(self.sugerir("zebra girafa", indice, "dados"), C.SOLICITACAO)
            self.assertEqual(self.sugerir("zebra girafa", indice, "REDE"), C.INCIDENTE)
            self.assertEqual(self.sugerir("zebra girafa", indice), C.INCIDENTE)
        self.assertEqual(self.sugerir("zebra girafa", indice, "dados"), C.INCIDENTE)  # etapa final "nb" ignora o mapa

    def test_mapa_so_guarda_categoria_com_casos_e_maioria_suficientes(self):
        docs = (
            [{"tokens": ["a"], "b": "FORTE", "j": "INCIDENTE"}] * 5
            + [{"tokens": ["a"], "b": "POUCOS", "j": "INCIDENTE"}] * 4
            + [{"tokens": ["a"], "b": "DIVIDIDA", "j": "INCIDENTE"}] * 3 + [{"tokens": ["a"], "b": "DIVIDIDA", "j": "SOLICITAÇÃO"}] * 3
            + [{"tokens": ["a"], "b": "SEMTIPO", "j": ""}] * 6
        )
        self.assertEqual(C.treinar(docs)["mapa_b_j"], {"FORTE": "INCIDENTE"})


class IndiceEPrivacidadeTest(unittest.TestCase):
    def casos(self):
        comuns = [
            caso(f"Computador lento {quase}", f"Chamado da Marina Teixeira, CPF {CPF_VALIDO}, e-mail marina.teixeira@sebrae.com.br, fone (41) 98751-2389. {unica}",
                 "Atendimento realizado", "Marina Teixeira", "LENTIDÃO", "INCIDENTE")
            for quase, unica in (("quokka", "wombat"), ("quokka", "pangolim"), ("tucano", "gamba"), ("tucano", "ocapi"), ("tucano", "furao"), ("quokka", "lemure"))
        ]
        automaticos = [caso("apiexclusiva alerta", "apiexclusiva", "", "API SEBRAE", "REDE", "INCIDENTE") for _ in range(3)]
        return comuns + automaticos

    def test_indice_nao_guarda_nome_cpf_email_nem_palavra_de_um_so_chamado(self):
        pasta = Path(tempfile.mkdtemp())
        destino = pasta / "sub" / C.ARQUIVO_INDICE
        indice = C.construir_indice(planilha_de(self.casos()), destino)
        conteudo = destino.read_text(encoding="utf-8")
        self.assertEqual(json.loads(conteudo), indice)
        self.assertEqual(set(indice), {"versao", "b", "j", "mapa_b_j"})
        for proibido in ("marina", "teixeira", "529", "98751", "@", "sebrae", "wombat", "pangolim", "gamba", "ocapi", "furao", "lemure", "apiexclusiva", "ocultad", "oculto"):
            with self.subTest(proibido):
                self.assertNotIn(proibido, conteudo.lower())
        self.assertEqual(set(indice["b"]["vocab"]), {"computador", "lento", "quokka", "tucano", "atendimento", "realizado", "chamado", "cpf", "mail", "fone"})

    def test_email_e_cpf_mascarados_nao_deixam_palavra_nem_marcador(self):
        # Sem as palavras "CPF" e "e-mail" no texto: qualquer "cpf" ou "mail" no vocabulário só poderia vir de um marcador.
        # Os dígitos do CPF nunca viram palavra, porque as palavras seguem [a-z]{3,}.
        casos = [
            caso("Computador lento", f"Contato zorroxpto.qualquer@dominiox.net e documento {CPF_VALIDO} tel (41) 98751-2389", "", "Marina Teixeira", "LENTIDÃO", "INCIDENTE")
            for _ in range(3)
        ]
        pasta = Path(tempfile.mkdtemp())
        C.construir_indice(planilha_de(casos), pasta / C.ARQUIVO_INDICE)
        conteudo = (pasta / C.ARQUIVO_INDICE).read_text(encoding="utf-8").lower()
        for proibido in ("zorroxpto", "qualquer", "dominiox", "net", "cpf", "mail", "ocultad", "oculto", "529", "98751", "@"):
            with self.subTest(proibido):
                self.assertNotIn(f'"{proibido}"' if proibido.isalpha() else proibido, conteudo)
        indice = json.loads(conteudo)
        self.assertEqual(set(indice["b"]["vocab"]), {"computador", "lento", "contato", "documento", "tel"})

    def test_vocabulario_so_tem_palavras_de_pelo_menos_dois_chamados(self):
        indice = C.treinar([
            {"tokens": ["comum", "rara"], "b": "A", "j": "INCIDENTE"},
            {"tokens": ["comum"], "b": "A", "j": "INCIDENTE"},
        ])
        self.assertEqual(indice["b"]["vocab"], ["comum"])
        self.assertEqual(indice["b"]["classes"], {"A": {"docs": 2, "total": 2, "contagens": {"comum": 2}}})
        self.assertNotIn("rara", json.dumps(indice))

    def test_chamado_de_sistema_nao_entra_no_treino(self):
        indice = C.construir_indice(planilha_de(self.casos()), Path(tempfile.mkdtemp()) / C.ARQUIVO_INDICE)
        self.assertEqual(indice["b"]["classes"]["LENTIDÃO"]["docs"], 6)
        self.assertNotIn("REDE", indice["b"]["classes"])
        self.assertEqual(indice["j"]["classes"]["INCIDENTE"]["docs"], 6)

    def test_nome_do_solicitante_nunca_vira_palavra_nem_sai_no_texto_de_outro_chamado(self):
        casos = [caso("Pedido da Camila Prado", "Camila Prado pediu", "", "Camila Prado", "DADOS", "INCIDENTE") for _ in range(3)]
        indice = C.construir_indice(planilha_de(casos), Path(tempfile.mkdtemp()) / C.ARQUIVO_INDICE)
        self.assertNotIn("camila", indice["b"]["vocab"])
        self.assertNotIn("prado", indice["b"]["vocab"])
        self.assertIn("pedido", indice["b"]["vocab"])

    def test_nome_de_tecnico_ou_representante_fora_da_coluna_i_nao_vira_palavra(self):
        casos = [caso("Notebook do Rafael Moura", "Rafael Moura trocou o teclado", "", "Ana Lima", "PERIFÉRICO", "INCIDENTE") for _ in range(3)]
        sem = C.construir_indice(planilha_de(casos), Path(tempfile.mkdtemp()) / C.ARQUIVO_INDICE)
        self.assertIn("rafael", sem["b"]["vocab"])
        indice = C.construir_indice(planilha_de(casos), Path(tempfile.mkdtemp()) / C.ARQUIVO_INDICE, ["Rafael Moura", None, ""])
        self.assertNotIn("rafael", indice["b"]["vocab"])
        self.assertNotIn("moura", indice["b"]["vocab"])
        self.assertIn("teclado", indice["b"]["vocab"])

    def test_ler_linhas_devolve_so_palavras_de_nome_da_coluna_i(self):
        linhas, nomes = C.ler_linhas(planilha_de([caso("Titulo", "Descricao", "Feito", "João da Silva", "DADOS", "INCIDENTE")]))
        self.assertEqual(nomes, frozenset({"joao", "silva"}))
        self.assertEqual(linhas[0].b, "DADOS")
        self.assertEqual(linhas[0].solicitante, "João da Silva")

    def test_documento_da_linha_so_traz_palavras_e_rotulos(self):
        linha = C.Linha("Notebook lento", f"CPF {CPF_VALIDO} fone (41) 98751-2389", "", "Fulana Souza", "lentidão", "incidente")
        documento = C.documento_da_linha(linha, frozenset({"fulana", "souza"}))
        self.assertEqual(set(documento), {"tokens", "b", "j"})
        self.assertEqual((documento["b"], documento["j"]), ("LENTIDÃO", "INCIDENTE"))
        self.assertEqual(documento["tokens"], ["notebook", "lento", "cpf", "fone"])

    def test_construir_indice_grava_de_forma_atomica(self):
        pasta = Path(tempfile.mkdtemp())
        C.construir_indice(planilha_de(self.casos()), pasta / C.ARQUIVO_INDICE)
        self.assertEqual([arquivo.name for arquivo in pasta.iterdir() if arquivo.suffix != ".lock"], [C.ARQUIVO_INDICE])
        self.assertIsNotNone(C.carregar_indice(pasta / C.ARQUIVO_INDICE))

    def test_planilha_ilegivel_sobe_o_erro_e_nao_deixa_arquivo(self):
        pasta = Path(tempfile.mkdtemp())
        with self.assertRaises(Exception):
            C.construir_indice(b"isto nao e uma planilha", pasta / C.ARQUIVO_INDICE)
        self.assertFalse((pasta / C.ARQUIVO_INDICE).exists())


class CarregarIndiceTest(unittest.TestCase):
    def setUp(self):
        self.caminho = Path(tempfile.mkdtemp()) / C.ARQUIVO_INDICE

    def test_arquivo_ausente(self):
        self.assertIsNone(C.carregar_indice(self.caminho))

    def test_arquivo_corrompido_ou_vazio(self):
        for conteudo in ("{ nao e json", "", "\x00\x01"):
            with self.subTest(conteudo):
                self.caminho.write_text(conteudo, encoding="utf-8")
                self.assertIsNone(C.carregar_indice(self.caminho))

    def test_bytes_que_nao_sao_utf8(self):
        self.caminho.write_bytes(b"\xff\xfe\x00")
        self.assertIsNone(C.carregar_indice(self.caminho))

    def test_versao_ou_estrutura_diferente(self):
        validos = C.treinar([])
        for indice in ([], "texto", {**validos, "versao": C.VERSAO_INDICE + 1}, {k: v for k, v in validos.items() if k != "mapa_b_j"}, {**validos, "b": []}):
            with self.subTest(indice):
                self.caminho.write_text(json.dumps(indice), encoding="utf-8")
                self.assertIsNone(C.carregar_indice(self.caminho))

    def test_indice_valido_volta_igual(self):
        indice = indice_b()
        self.caminho.write_text(json.dumps(indice), encoding="utf-8")
        self.assertEqual(C.carregar_indice(self.caminho), indice)


class DashboardDeVerdadeTest(unittest.TestCase):
    def test_do_arquivo_xlsx_ate_a_sugestao(self):
        casos = (
            [caso("Computador muito zebra", "girafa na tela", "", "Ana Lima", "LENTIDÃO", "INCIDENTE") for _ in range(6)]
            + [caso("Copiar banana", "laranja no servidor", "", "Bia Reis", "DADOS", "SOLICITAÇÃO") for _ in range(6)]
        )
        pasta = Path(tempfile.mkdtemp())
        C.construir_indice(planilha_de(casos), pasta / C.ARQUIVO_INDICE)
        indice = C.carregar_indice(pasta / C.ARQUIVO_INDICE)
        self.assertEqual(C.sugerir("Máquina com zebra", "girafa", "", "Carla Dias", TODAS, indice), "LENTIDÃO")
        self.assertEqual(C.sugerir("Preciso de banana", "laranja", "", "Carla Dias", TODAS, indice), "DADOS")
        self.assertEqual(C.sugerir_tipo("Máquina com zebra", "girafa", "", "Carla Dias", indice), C.INCIDENTE)
        self.assertEqual(C.sugerir_tipo("Preciso de banana", "laranja", "", "Carla Dias", indice), C.SOLICITACAO)
        self.assertEqual(indice["mapa_b_j"], {"LENTIDÃO": "INCIDENTE", "DADOS": "SOLICITAÇÃO"})


class AtualizacaoDoIndiceNasRotasTest(RotasBase):
    def arquivo(self):
        return self.dir / C.ARQUIVO_INDICE

    def test_importar_cria_o_indice_na_pasta_de_estado(self):
        casos = [caso("Computador zebra", "girafa", "", "Ana Lima", "LENTIDÃO", "INCIDENTE") for _ in range(3)]
        self.assertEqual(self.importar(planilha_de(casos)).status_code, 200)
        indice = C.carregar_indice(self.arquivo())
        self.assertIsNotNone(indice)
        self.assertEqual(indice["b"]["classes"]["LENTIDÃO"]["docs"], 3)
        self.assertNotIn("Ana", self.arquivo().read_text(encoding="utf-8"))

    def test_planilha_sem_leitura_para_a_escrita_nao_cria_indice(self):
        self.assertEqual(self.importar().status_code, 200)  # planilha simples dos testes: sem aba legível
        self.assertFalse(self.arquivo().exists())

    def test_falha_do_indice_na_importacao_so_vai_ao_log(self):
        with patch.object(C, "construir_indice", side_effect=RuntimeError("texto-secreto-do-chamado")):
            with self.assertLogs("routers.sebrae_dashboard", level="WARNING") as registro:
                resposta = self.importar(montar())
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertTrue(resposta.json()["importado"]["atualizavel"])
        saida = "\n".join(registro.output)
        self.assertIn("RuntimeError", saida)
        self.assertNotIn("texto-secreto-do-chamado", saida)

    def test_atualizar_refaz_o_indice_e_a_falha_so_vai_ao_log(self):
        self.importar(montar())
        self.arquivo().unlink(missing_ok=True)
        self.assertEqual(self.post("/api/sebrae/dashboard/atualizar", json={}).status_code, 422)  # nada para gravar
        edicao = {"numero": "UTIC-2026-0001", "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertTrue(self.arquivo().exists())
        self.arquivo().unlink()
        with patch.object(C, "construir_indice", side_effect=RuntimeError("texto-secreto-do-chamado")):
            with self.assertLogs("routers.sebrae_dashboard", level="WARNING") as registro:
                resposta = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [{**edicao, "B": "DADOS"}]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertIn("RuntimeError", "\n".join(registro.output))
        self.assertNotIn("texto-secreto-do-chamado", "\n".join(registro.output))
        self.assertFalse(self.arquivo().exists())


if __name__ == "__main__":
    unittest.main()
