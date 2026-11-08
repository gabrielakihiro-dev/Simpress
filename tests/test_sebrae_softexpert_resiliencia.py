"""Regras de "nunca repetir um clique irreversível" do SoftExpert, sem Chrome real (só MagicMock)."""
import unittest
from pathlib import Path
from unittest import mock

from scripts import sebrae_softexpert as S

R = S._rotinas()


def _sem_esperas():
    """Evita as esperas reais (recuperação entre tentativas) e o estado global da página de recuperação."""
    return mock.patch.object(S.time, "sleep")


class AbrirFormularioDepoisDoSimTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(R.definir_pagina_ativa_para_recuperacao, None)

    def test_excecao_generica_depois_do_sim_nao_refaz_o_clique(self):
        respondidas_capturadas = []
        tratar_real = S._tratar_dialogo_nativo

        def capturar(respondidas):
            respondidas_capturadas.append(respondidas)
            return tratar_real(respondidas)

        def esperar_que_falha_depois_do_sim(*_args, **_kwargs):
            respondidas_capturadas[0].append(1.0)  # o "Sim" de associar o chamado já foi respondido
            raise RuntimeError("página fechou")

        linha = mock.MagicMock()
        linha.locator.return_value.count.return_value = 1  # interface atual: o ✓ já abre o formulário
        with (
            mock.patch.object(S, "_tratar_dialogo_nativo", side_effect=capturar),
            mock.patch.object(S, "_conferir_linha"),
            mock.patch.object(S, "_clicar_icone_executar") as clique,
            mock.patch.object(S, "_esperar", side_effect=esperar_que_falha_depois_do_sim),
            mock.patch.object(S, "_log"),
            mock.patch.object(R, "log"),
            mock.patch.object(R, "verificar_cancelamento"),
            _sem_esperas(),
        ):
            with self.assertRaises(S.SoftExpertErro) as contexto:
                S._abrir_formulario(mock.MagicMock(), mock.MagicMock(), linha, "UTIC-2026-1")

        self.assertNotIsInstance(contexto.exception, R.EtapaInstavel)
        self.assertEqual(contexto.exception.motivo, S.MOTIVO_FORMULARIO_INDISPONIVEL)
        self.assertEqual(clique.call_count, 1)

    def test_etapa_instavel_depois_do_sim_tambem_nao_refaz_o_clique(self):
        respondidas_capturadas = []
        tratar_real = S._tratar_dialogo_nativo

        def capturar(respondidas):
            respondidas_capturadas.append(respondidas)
            return tratar_real(respondidas)

        def esperar_que_pede_nova_tentativa(*_args, **_kwargs):
            respondidas_capturadas[0].append(1.0)
            raise S.EtapaInstavelSX("navegação instável depois do Sim")

        linha = mock.MagicMock()
        linha.locator.return_value.count.return_value = 1
        with (
            mock.patch.object(S, "_tratar_dialogo_nativo", side_effect=capturar),
            mock.patch.object(S, "_conferir_linha"),
            mock.patch.object(S, "_clicar_icone_executar") as clique,
            mock.patch.object(S, "_esperar", side_effect=esperar_que_pede_nova_tentativa),
            mock.patch.object(S, "_log"),
            mock.patch.object(R, "log"),
            mock.patch.object(R, "verificar_cancelamento"),
            _sem_esperas(),
        ):
            with self.assertRaises(S.SoftExpertErro) as contexto:
                S._abrir_formulario(mock.MagicMock(), mock.MagicMock(), linha, "UTIC-2026-1")

        self.assertNotIsInstance(contexto.exception, R.EtapaInstavel)
        self.assertEqual(clique.call_count, 1)

    def test_excecao_generica_antes_do_sim_ainda_e_refeita(self):
        # Contraprova: sem "Sim" respondido, a falha continua recuperável (3 tentativas, 1 clique cada).
        linha = mock.MagicMock()
        linha.locator.return_value.count.return_value = 1
        with (
            mock.patch.object(S, "_conferir_linha"),
            mock.patch.object(S, "_clicar_icone_executar") as clique,
            mock.patch.object(S, "_esperar", side_effect=RuntimeError("página fechou")),
            mock.patch.object(S, "_log"),
            mock.patch.object(R, "log"),
            mock.patch.object(R, "verificar_cancelamento"),
            _sem_esperas(),
        ):
            with self.assertRaises(S.EtapaInstavelSX):
                S._abrir_formulario(mock.MagicMock(), mock.MagicMock(), linha, "UTIC-2026-1")
        self.assertEqual(clique.call_count, 3)


class ProximaPaginaTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(R.definir_pagina_ativa_para_recuperacao, None)

    def test_nao_clica_de_novo_se_a_lista_ja_mudou_e_nao_pula_pagina(self):
        estado = {"textos": ["pagina 1"]}
        cliques = []

        def clicar_e_cair(_botao, _descricao):
            cliques.append(1)
            estado["textos"] = ["pagina 2"]  # o clique funcionou...
            if len(cliques) == 1:
                raise RuntimeError("a conexão com a página caiu")  # ...mas a etapa falhou depois dele

        itens_por_rodada = iter(["UTIC-2026-1", "UTIC-2026-2"])

        def ler_pagina(_page, itens, *, acumular=False):
            numero = next(itens_por_rodada)
            itens[numero] = S.ItemLista(numero=numero, texto=estado["textos"][0])
            return 1

        with (
            mock.patch.object(S, "_aguardar_lista"),
            mock.patch.object(S, "_esperar", return_value=True),
            mock.patch.object(S, "_cancelamento"),
            mock.patch.object(S, "_textos_linhas", side_effect=lambda _page: list(estado["textos"])),
            mock.patch.object(S, "_botao_proxima", return_value=mock.MagicMock()),
            mock.patch.object(S, "_proxima_disponivel", side_effect=[True, False]),
            mock.patch.object(S, "_ler_pagina", side_effect=ler_pagina) as ler,
            mock.patch.object(S, "clicar", side_effect=clicar_e_cair),
            mock.patch.object(S, "_aguardar_sem_carregamento"),
            mock.patch.object(R, "log"),
            mock.patch.object(R, "verificar_cancelamento"),
            _sem_esperas(),
        ):
            itens = S.listar_chamados(mock.MagicMock())

        self.assertEqual(len(cliques), 1)  # a tentativa 2 viu a lista já mudada e não clicou
        self.assertEqual(ler.call_count, 2)  # cada página lida uma única vez: nenhuma pulada
        self.assertEqual([i.numero for i in itens], ["UTIC-2026-1", "UTIC-2026-2"])

    def test_paginacao_que_volta_a_pagina_ja_lida_recomeca_do_mesmo_link(self):
        paginas = [["UTIC-2026-1 - a"], ["UTIC-2026-2 - b"], ["UTIC-2026-3 - c"]]
        estado = {"pagina": 0, "cliques": 0}

        def clicar_proxima(_botao, _descricao):
            estado["cliques"] += 1
            # No 2º clique o usuário clicou na página 1 ao mesmo tempo: a lista mudou, mas para trás.
            estado["pagina"] = 0 if estado["cliques"] == 2 else estado["pagina"] + 1

        page = mock.MagicMock()
        page.goto.side_effect = lambda *_a, **_k: estado.update(pagina=0)
        with (
            mock.patch.object(S, "_aguardar_lista"),
            mock.patch.object(S, "_esperar", side_effect=lambda _p, condicao, *_a, **_k: condicao()),
            mock.patch.object(S, "_cancelamento"),
            mock.patch.object(S, "_textos_linhas", side_effect=lambda _p: list(paginas[estado["pagina"]])),
            mock.patch.object(S, "_botao_proxima", return_value=mock.MagicMock()),
            mock.patch.object(S, "_proxima_disponivel", side_effect=lambda _b: estado["pagina"] < 2),
            mock.patch.object(S, "clicar", side_effect=clicar_proxima),
            mock.patch.object(S, "_aguardar_sem_carregamento"),
            mock.patch.object(R, "log"),
            mock.patch.object(R, "verificar_cancelamento"),
            _sem_esperas(),
        ):
            itens = S.listar_chamados(page)

        self.assertEqual(
            [(i.numero, i.ocorrencias) for i in itens], [("UTIC-2026-1", 1), ("UTIC-2026-2", 1), ("UTIC-2026-3", 1)]
        )
        page.goto.assert_called_once()
        self.assertEqual(page.goto.call_args.args[0], S.SOFTEXPERT_URL)


class ListaComInterferenciaTests(unittest.TestCase):
    """O usuário mexe na aba durante a leitura (rolagem, como na lista real): volta ao mesmo link e recomeça."""

    TODOS = [f"UTIC-2026-{i} - chamado {i}" for i in range(1, 7)]

    def setUp(self):
        self.addCleanup(R.definir_pagina_ativa_para_recuperacao, None)

    def _pagina(self, interferir):
        """Lista que carrega lotes de 2 a cada rolagem; ``interferir(n)`` troca a tela (True) ou levanta na n-ésima."""
        estado = {"linhas": list(self.TODOS[:2]), "rolagens": 0}

        def carregar(*_a, **_k):
            estado["linhas"] = list(self.TODOS[:2])

        def rolar(*_a):
            estado["rolagens"] += 1
            efeito = interferir(estado["rolagens"])
            if efeito:
                estado["linhas"] = ["Outra tela aberta pelo usuário"]  # clicou em outro link
                if isinstance(efeito, Exception):
                    raise efeito
            elif estado["linhas"][0] in self.TODOS:  # fora da central de tarefas a rolagem não faz nada
                estado["linhas"] = list(self.TODOS[: len(estado["linhas"]) + 2])

        page = mock.MagicMock()
        page.goto.side_effect = carregar
        page.evaluate.side_effect = rolar
        return page, estado

    def _listar(self, page, estado, **kwargs):
        with (
            mock.patch.object(S, "_aguardar_lista"),
            mock.patch.object(S, "_esperar", side_effect=lambda _p, condicao, *_a, **_k: condicao()),
            mock.patch.object(S, "_cancelamento"),
            mock.patch.object(S, "_textos_linhas", side_effect=lambda _p: list(estado["linhas"])),
            mock.patch.object(S, "_botao_proxima", return_value=None),
            mock.patch.object(S, "_lista_declarada_vazia", return_value=False),
            mock.patch.object(R, "log"),
            mock.patch.object(R, "verificar_cancelamento"),
            _sem_esperas(),
        ):
            return S.listar_chamados(page, **kwargs)

    def _numeros(self):
        return [texto.split(" - ")[0] for texto in self.TODOS]

    def test_outro_link_no_meio_da_rolagem_volta_ao_mesmo_link_e_le_tudo(self):
        page, estado = self._pagina(lambda n: n == 2)
        itens = self._listar(page, estado)
        self.assertEqual([i.numero for i in itens], self._numeros())
        page.goto.assert_called_once()
        self.assertEqual(page.goto.call_args.args[0], S.SOFTEXPERT_URL)

    def test_erro_do_navegador_ao_rolar_volta_ao_mesmo_link_e_le_tudo(self):
        page, estado = self._pagina(lambda n: RuntimeError("Execution context was destroyed") if n == 2 else False)
        itens = self._listar(page, estado)
        self.assertEqual([i.numero for i in itens], self._numeros())
        page.goto.assert_called_once()

    def test_interferencia_persistente_vira_erro_e_nunca_lista_parcial(self):
        page, estado = self._pagina(lambda n: n % 2 == 0)
        with self.assertRaises(S.SoftExpertErro) as contexto:
            self._listar(page, estado)
        self.assertNotIsInstance(contexto.exception, R.EtapaInstavel)
        self.assertEqual(page.goto.call_count, 2)  # 3 tentativas: a 1ª sem recarregar, as outras no mesmo link

    def test_lista_filtrada_nao_recarrega_o_link_e_falha(self):
        # Recarregar perderia o filtro da pesquisa e o chamado pareceria ausente (falso "finalizado").
        page, estado = self._pagina(lambda n: n == 2)
        with self.assertRaises(S.SoftExpertErro) as contexto:
            self._listar(page, estado, recomecar=False)
        self.assertNotIsInstance(contexto.exception, R.EtapaInstavel)
        page.goto.assert_not_called()

    def test_localizar_le_o_resultado_da_pesquisa_sem_recarregar(self):
        page = mock.MagicMock()
        page.locator.return_value.filter.return_value.count.return_value = 1  # campo de pesquisa único
        chamadas = []

        def listar(_page, *args, **kwargs):
            chamadas.append(kwargs)
            return []

        with (
            mock.patch.object(S, "listar_chamados", side_effect=listar),
            mock.patch.object(S, "_textos_linhas", return_value=["UTIC-2026-9 - resultado da pesquisa"]),
            mock.patch.object(S, "_esperar", return_value=True),
            mock.patch.object(S, "_log"),
            mock.patch.object(R, "log"),
            _sem_esperas(),
        ):
            self.assertIsNone(S._localizar_chamado(page, "UTIC-2026-9"))
        self.assertEqual(chamadas, [{}, {"recomecar": False}])


class DicaExecutarTests(unittest.TestCase):
    def test_dica_que_nao_aparece_e_instavel_e_nada_e_clicado(self):
        # Nada foi clicado ainda: a etapa de abrir o formulário pode refazer do zero.
        with (
            mock.patch.object(S, "_esperar", return_value=None),
            mock.patch.object(S, "clicar") as clique,
        ):
            with self.assertRaises(R.EtapaInstavel):
                S._clicar_icone_executar(mock.MagicMock(), mock.MagicMock(), "UTIC-2026-1")
        clique.assert_not_called()


class GuardPreCliqueTests(unittest.TestCase):
    """O guard pré-clique aborta com SoftExpertErro (motivo estável) e o clique irreversível não acontece."""

    MENSAGEM = "Clique de teste: o cursor do sistema se moveu antes do clique."

    def _guard_aborta(self):
        return mock.patch.object(R, "aguardar_estabilidade_pre_clique", side_effect=R.RotinaErro(self.MENSAGEM))

    def _confere(self, contexto):
        erro = contexto.exception
        self.assertIsInstance(erro, S.SoftExpertErro)
        self.assertEqual(str(erro), self.MENSAGEM)
        self.assertEqual(erro.motivo, S.MOTIVO_FORMULARIO_INDISPONIVEL)

    def test_enviar_anexo(self):
        conteiner = mock.MagicMock()
        conteiner.get_by_role.return_value.filter.return_value.count.return_value = 1
        cliques = []
        with (
            mock.patch.object(S, "_ir_para_menu"),
            mock.patch.object(S, "_botao_unico"),
            mock.patch.object(S, "_esperar", return_value=mock.MagicMock()),
            mock.patch.object(S, "_conteiner_do_upload", return_value=conteiner),
            mock.patch.object(S, "clicar", side_effect=lambda _l, descricao: cliques.append(descricao)),
            mock.patch.object(S, "_log"),
            self._guard_aborta(),
        ):
            with self.assertRaises(S.SoftExpertErro) as contexto:
                S._anexar_pdf(mock.MagicMock(), Path("anexo.pdf"), [])
        self._confere(contexto)
        self.assertEqual(cliques, ["Incluir anexo"])  # só o "+" foi clicado, nunca o Enviar

    def test_anexo_nunca_usa_o_campo_da_grade(self):
        # A área "Arraste um arquivo" da grade sobe o PDF na hora, sem Enviar; sem o modal, nada é posto em campo nenhum.
        campo_da_grade = mock.MagicMock()
        sem_modal = mock.MagicMock()
        sem_modal.filter.return_value.count.return_value = 0
        frame = mock.MagicMock()
        frame.locator.side_effect = lambda seletor: campo_da_grade if "file" in seletor else sem_modal
        pagina = mock.MagicMock()
        with (
            mock.patch.object(S, "_ir_para_menu"),
            mock.patch.object(S, "_botao_unico"),
            mock.patch.object(S, "_frames", return_value=[frame]),
            mock.patch.object(S, "_esperar", side_effect=lambda _p, condicao, _t: condicao()),
            mock.patch.object(S, "clicar"),
            mock.patch.object(R, "etapa_resiliente", side_effect=lambda etapa, _d: etapa()),
        ):
            with self.assertRaises(S.EtapaInstavelSX):
                S._anexar_pdf(pagina, Path("anexo.pdf"), [])
        campo_da_grade.set_input_files.assert_not_called()

    def test_anexo_recusa_seletor_nativo_sem_modal(self):
        # Se o + abrir o seletor de arquivo (campo da grade) em vez do modal, nada é escolhido nele.
        seletor = mock.MagicMock()
        sem_modal = mock.MagicMock()
        sem_modal.filter.return_value.count.return_value = 0
        frame = mock.MagicMock()
        frame.locator.return_value = sem_modal
        pagina = mock.MagicMock()
        pagina.on.side_effect = lambda _evento, guardar: guardar(seletor)
        with (
            mock.patch.object(S, "_ir_para_menu"),
            mock.patch.object(S, "_botao_unico"),
            mock.patch.object(S, "_frames", return_value=[frame]),
            mock.patch.object(S, "_esperar", side_effect=lambda _p, condicao, _t: condicao()),
            mock.patch.object(S, "clicar"),
            mock.patch.object(R, "etapa_resiliente", side_effect=lambda etapa, _d: etapa()),
        ):
            with self.assertRaises(S.SoftExpertErro) as contexto:
                S._anexar_pdf(pagina, Path("anexo.pdf"), [])
        self.assertNotIsInstance(contexto.exception, S.EtapaInstavelSX)  # não repete o +
        seletor.set_files.assert_not_called()

    def test_confirmacao_de_finalizar(self):
        dialogo = mock.MagicMock()
        dialogo.inner_text.return_value = "Deseja finalizar a atividade?"
        dialogo.get_by_role.return_value.filter.return_value.count.return_value = 1
        frame = mock.MagicMock()
        frame.locator.return_value.filter.return_value.all.return_value = [dialogo]
        with (
            mock.patch.object(S, "_frames", return_value=[frame]),
            mock.patch.object(S, "clicar") as clique,
            self._guard_aborta(),
        ):
            with self.assertRaises(S.SoftExpertErro) as contexto:
                S._confirmar_modal_finalizar(mock.MagicMock())
        self._confere(contexto)
        clique.assert_not_called()

    def test_finalizar(self):
        escritas: list[str] = []
        with (
            mock.patch.object(S, "_botao_unico", return_value=mock.MagicMock()),
            mock.patch.object(S, "clicar") as clique,
            mock.patch.object(S, "_log"),
            self._guard_aborta(),
        ):
            with self.assertRaises(S.SoftExpertErro) as contexto:
                S._clicar_finalizar(mock.MagicMock(), mock.MagicMock(), "UTIC-2026-1", escritas)
        self._confere(contexto)
        clique.assert_not_called()
        self.assertEqual(escritas, [])

    def test_finalizar_com_outro_chamado_na_janela_nao_clica(self):
        # O botão é um localizador "preguiçoso": se o usuário levou a janela para outro chamado, o Finalizar
        # seria o desse outro chamado. O guard confere o número do cabeçalho e aborta sem clicar.
        def guard(verificar, descricao):
            if not verificar():
                raise R.RotinaErro(f"{descricao}: o estado mudou antes do clique; não cliquei.")

        for lido in ("UTIC-2026-2",):
            with self.subTest(cabecalho=lido):
                escritas: list[str] = []
                with (
                    mock.patch.object(S, "_botao_unico", return_value=mock.MagicMock()),
                    mock.patch.object(S, "_cabecalho", return_value={"numero": lido, "titulo": "", "solicitante": ""}),
                    mock.patch.object(S, "clicar") as clique,
                    mock.patch.object(S, "_log"),
                    mock.patch.object(R, "aguardar_estabilidade_pre_clique", side_effect=guard),
                ):
                    with self.assertRaises(S.SoftExpertErro):
                        S._clicar_finalizar(mock.MagicMock(), mock.MagicMock(), "UTIC-2026-1", escritas)
                clique.assert_not_called()
                self.assertEqual(escritas, [])

    def test_guarda_do_finalizar_so_bloqueia_quando_o_cabecalho_mostra_outro_chamado(self):
        # Cabeçalho ilegível (visão Atendimento não conferida no site real) não pode bloquear todo Finalizar.
        lidos: list[bool] = []

        def guard(verificar, descricao):
            lidos.append(verificar())
            raise R.RotinaErro("parar antes do clique")

        for cabecalho in ("UTIC-2026-1", "", "UTIC-2026-2"):
            with (
                mock.patch.object(S, "_botao_unico", return_value=mock.MagicMock(**{"is_enabled.return_value": True})),
                mock.patch.object(S, "_cabecalho", return_value={"numero": cabecalho, "titulo": "", "solicitante": ""}),
                mock.patch.object(S, "clicar"),
                mock.patch.object(S, "_log"),
                mock.patch.object(R, "aguardar_estabilidade_pre_clique", side_effect=guard),
                self.assertRaises(S.SoftExpertErro),
            ):
                S._clicar_finalizar(mock.MagicMock(), mock.MagicMock(), "UTIC-2026-1", [])
        self.assertEqual(lidos, [True, True, False])


if __name__ == "__main__":
    unittest.main()
