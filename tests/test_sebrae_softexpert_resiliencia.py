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
                S._clicar_finalizar(mock.MagicMock(), mock.MagicMock(), escritas)
        self._confere(contexto)
        clique.assert_not_called()
        self.assertEqual(escritas, [])


if __name__ == "__main__":
    unittest.main()
