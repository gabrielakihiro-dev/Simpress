"""Remover no Endpoint: página falsa (dados sintéticos) servida no endereço do SoM, sem tocar no Endpoint real."""
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from domains import endpoint_remocao

BASE = "https://endpoint.teste.invalid/client"

PAGINA = """<!doctype html><html><head><style>
.ember-table-table-row { display:flex } .ember-table-cell,.ember-table-header-cell { width:220px; flex:none }
#dlg[hidden] { display:none } #dlg { width:400px; transition: transform .4s } #dlg.entrando { transform: translateX(300px) }
#dlg.cheio { position:fixed; left:0; top:0; width:100vw; height:100vh; background:#fff }
.cresce { animation: cresce 1s linear infinite } @keyframes cresce { from { height:0 } to { height:100px } }
</style></head><body>
<div class="ember-table-header-row ember-table-table-row">
<div class="ember-table-header-cell"><input type="checkbox" id="todos"></div>
<div class="ember-table-header-cell">Nome do computador</div>
<div class="ember-table-header-cell">Horário do último contato</div></div>
<button id="SoMManagedComputers_searchButton" disabled>Pesquisar</button>
<div id="barra" style="display:none"><span style="width:220px;flex:none"></span><input class="search-text-box" placeholder="Somente sequência" style="width:212px"></div>
<div class="page-loader-wrapper">Carregando...</div>
<div id="rows"></div><div id="vazio" hidden>Nenhum computador gerenciado.</div><div id="carregador" class="grid-loading" hidden>...</div><p id="count"></p>
<button id="remover">X Remover computador(es)</button>
<div role="dialog" class="app--slider"></div>
<div class="zdialog--overlay" id="overlay" hidden></div>
<div id="dlg" role="alertdialog" class="zdialog zdialog--alert" hidden>
<span class="zdialog__title">Esta ação resulta em</span>
<div id="conteudo"></div>
</div>
<script>
const cfg = __CFG__;
let renders=0;
function render() {
 renders++;
 const value=document.querySelector('.search-text-box').value.toLowerCase();
 // some_apos: a remoção só aparece depois de N buscas (o portal demora para refletir).
 const sumiu = (cfg.some_apos && renders >= cfg.some_apos) || (cfg.vazio_em || []).includes(renders);
 const filtered=sumiu ? [] : cfg.linhas.filter(n=>n.toLowerCase().includes(value));
 document.querySelector('#rows').replaceChildren(...filtered.map(nome=>{
   const row=document.createElement('div'); row.className='ember-table-table-row';
   row.innerHTML='<div class="ember-table-cell"><input type="checkbox"></div><div class="ember-table-cell"><a class="anchor-text" href="#/x"></a></div><div class="ember-table-cell contato"></div>';
   row.querySelector('a').textContent=nome; row.querySelector('.contato').textContent=cfg.contato; return row;
 }));
 document.querySelector('#count').textContent=filtered.length ? `1 - ${filtered.length} de Total de registros` : '0 - 0 de Total de registros';
 document.querySelector('#vazio').hidden = filtered.length > 0;
 // vazio_com_carregador: o aviso de vazio aparece durante o carregamento (placeholder passageiro).
 document.querySelector('#carregador').hidden = !(cfg.vazio_com_carregador && !filtered.length);
}
document.querySelector('.search-text-box').addEventListener('keydown', e=>{if(e.key==='Enter'){
 window.buscou(); render();
 // troca_filtro: a caixa fica com outro valor depois da busca (filtro errado com grade vazia).
 if (cfg.troca_filtro) setTimeout(()=>{document.querySelector('.search-text-box').value='OUTRO'}, 50);
}});
// Como o Ember: o "selecionar todos" marca sozinho quando todas as linhas visíveis estão marcadas.
document.querySelector('#rows').addEventListener('change', ()=>{
 const caixas=[...document.querySelectorAll('#rows input[type=checkbox]')];
 document.querySelector('#todos').checked = caixas.length > 0 && caixas.every(c=>c.checked);
});
document.querySelector('#SoMManagedComputers_searchButton').onclick=()=>{document.querySelector('#barra').style.display='flex'};
// A grade demora a aparecer depois do goto (como no portal, logo depois do login).
setTimeout(()=>{document.querySelector('.page-loader-wrapper').remove(); document.querySelector('#SoMManagedComputers_searchButton').disabled=false; render()}, 1200);
const mdm = () => document.querySelector('#dlg label.checkbox--form input[type=checkbox]');
const CONTEUDO = `<div class="zdialog__content"><p id="qtd"></p>
<label class="checkbox--form" tooltip="default"><input type="checkbox" value="false" style="width:0;height:0;opacity:0;margin:0">
<span class="label--text">Remove MDM enrollment Profile</span><span class="checkmark"></span></label>
<p>Especifique o motivo da remoção do agente do Endpoint Central</p><textarea id="motivo-txt"></textarea>
<div id="motivo"></div></div>
<button id="sim">Sim, prosseguir</button><button id="cancelar">Cancel</button>`;
document.querySelector('#remover').onclick=()=>{
 window.registrar('remover');
 const n=document.querySelectorAll('#rows input:checked').length;
 document.querySelector('#overlay').hidden=false; document.querySelector('#dlg').hidden=false;
 const dlg=document.querySelector('#dlg'); dlg.classList.add('entrando');
 if (cfg.dialogo_cheio) dlg.classList.add('cheio');
 requestAnimationFrame(()=>requestAnimationFrame(()=>dlg.classList.remove('entrando')));
 // Como no portal: a moldura aparece primeiro e o conteúdo chega ~800 ms depois.
 setTimeout(()=>{
  document.querySelector('#conteudo').innerHTML = CONTEUDO;
  document.querySelector('#qtd').textContent = cfg.reconhecivel === false ? 'Outra mensagem do portal.'
    : `The removal of the Endpoint Central agent on the ${n} selected devices. Inability to manage the ${n} selected devices.`;
  mdm().checked = cfg.mdm;
  // O clique no label alterna o input (o clique sintético no input não conta como outro clique do usuário).
  document.querySelector('label.checkbox--form').addEventListener('click', e=>{if(e.target.tagName!=='INPUT') window.registrar('label_mdm')});
  // dialogo_animado: o painel cresce sem parar abaixo dos botões (a caixa nunca estabiliza).
  if (cfg.dialogo_animado) { const cresce=document.createElement('div'); cresce.className='cresce'; document.querySelector('#dlg').append(cresce); }
  if (cfg.motivo) document.querySelector('#motivo').innerHTML='<label>Motivo *</label><textarea required></textarea>';
  document.querySelector('#sim').onclick=()=>{
   window.registrar('sim');
   if(cfg.fecha) document.querySelector('#dlg').hidden=true;
   // apos_sim: o portal mostra o carregamento e atualiza a grade sozinho, na mesma página.
   if (cfg.apos_sim) {
    const carregando=document.createElement('div'); carregando.className='zloading'; carregando.textContent='...';
    document.body.append(carregando);
    setTimeout(()=>{carregando.remove(); cfg.linhas=cfg.apos_sim; render();}, 600);
   }
  };
  document.querySelector('#cancelar').onclick=()=>{
   window.registrar('cancelar:' + (mdm().checked ? 'mdm' : 'sem_mdm'));
   // Some com um pequeno atraso, como a animação do portal.
   setTimeout(()=>{document.querySelector('#dlg').hidden=true; document.querySelector('#overlay').hidden=true}, 300);
  };
 }, 800);
};
</script></body></html>"""


class _Cancelada(BaseException):
    pass


def _automacao():
    def estabilidade(verificar, descricao, **_):
        if not verificar():
            raise RuntimeError(descricao)

    def pronto(acao, descricao, timeout_ms=15000, confirmar=None, **_):
        fim = time.time() + timeout_ms / 1000
        while not (confirmar is None or confirmar()):
            if time.time() > fim:
                raise RuntimeError(descricao)
            time.sleep(0.2)

    return SimpleNamespace(
        ENDPOINT_URL=f"{BASE}#/uems/inventory/computers", CARREGAMENTO_MS=10000,
        verificar_cancelamento=lambda *a: None, log=lambda *a: None, RotinaErro=RuntimeError,
        EtapaInstavel=RuntimeError, RotinaCancelada=_Cancelada,
        etapa_resiliente=lambda etapa, descricao, **k: etapa(),
        definir_pagina_ativa_para_recuperacao=lambda pagina: None, aguardar_estado=lambda *a, **k: None,
        aguardar_login=lambda *a, **k: None, endpoint_logado=lambda page: True, endpoint_entrar=lambda page: True,
        aguardar_estabilidade_pre_clique=estabilidade, acionar_quando_pronto=pronto,
    )


@unittest.skipUnless(importlib.util.find_spec("playwright") is not None, "playwright não está instalado")
class RemoverNoEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright

        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch()
        except Exception as exc:
            cls.pw.stop()
            raise unittest.SkipTest(f"Chromium do Playwright indisponível: {str(exc)[:120]}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.pasta = tempfile.TemporaryDirectory()
        self.addCleanup(self.pasta.cleanup)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(endpoint_remocao.VAR_SEM_REMOCAO, None)

    def rodar(self, linhas, confirmado=False, depois=None, mdm=False, motivo=False, fecha=True, reconhecivel=True,
              contato="nov 23, 2026 11:20 AM", corte="nov 25, 2026 08:59 PM", apos_sim=None, some_apos=None,
              segundo=None, antes_do_clique=None, primeiro=None):
        segundo = segundo or {}
        primeiro = primeiro or {}
        cliques = []
        abertas = []
        page = self.browser.new_page(viewport={"width": 1100, "height": 700})
        self.addCleanup(page.close)
        page.expose_function("registrar", lambda nome: cliques.append(nome))
        self.buscas = 0

        def buscou():
            self.buscas += 1

        page.expose_function("buscou", buscou)

        def servir(route):
            atuais = linhas if not abertas else (depois if depois is not None else linhas)
            abertas.append(route.request.url)
            cfg = json.dumps({"linhas": atuais, "mdm": mdm, "motivo": motivo, "fecha": fecha, "reconhecivel": reconhecivel, "contato": contato,
                              "apos_sim": apos_sim, "some_apos": some_apos if abertas[:-1] else None, **primeiro,
                              **(segundo if abertas[:-1] else {})})
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=PAGINA.replace("__CFG__", cfg))

        page.route(f"{BASE}**", servir)
        self.page = page
        automacao = _automacao()
        self.logs = []
        automacao.log = lambda origem, mensagem: self.logs.append(mensagem)
        resultado = endpoint_remocao.remover_na_pagina(
            page, automacao, "PRNOTE100", confirmado, Path(self.pasta.name), corte=corte,
            antes_do_clique=antes_do_clique)
        self.assertFalse([m for m in self.logs if "PRNOTE" in m.upper()])  # hostname nunca vai a log
        self.marcadas = page.locator("#rows input:checked").count()
        self.todos_marcado = page.locator("#todos").is_checked()
        self.alerta_visivel = page.locator("[role=alertdialog]").is_visible()
        self.motivo_digitado = page.locator("#motivo-txt").input_value() if page.locator("#motivo-txt").count() else ""
        return resultado, cliques, abertas

    def test_sem_confirmacao_cancela_e_nunca_clica_sim(self):
        pasta = Path(self.pasta.name)
        for i in range(25):  # capturas antigas: ficam só as 20 mais recentes
            velha = pasta / f"dialogo-remocao-antiga-{i:02d}.png"
            velha.write_bytes(b"x")
            os.utime(velha, (1_700_000_000 + i, 1_700_000_000 + i))
        resultado, cliques, abertas = self.rodar(["PRNOTE100"])
        self.assertEqual(resultado["resultado"], "cancelado_sem_confirmacao")
        self.assertEqual(cliques, ["remover", "label_mdm", "cancelar:mdm"])
        self.assertEqual(self.marcadas, 0)  # a linha não fica marcada na aba que fica aberta
        self.assertFalse(self.todos_marcado)
        self.assertFalse(self.alerta_visivel)
        self.assertEqual(self.motivo_digitado, "")  # o motivo (sem asterisco nem required) não dispara parada nem é digitado
        self.assertTrue(Path(resultado["captura"]).is_file())
        self.assertTrue(Path(resultado["captura"]).is_relative_to(Path(self.pasta.name)))
        self.assertEqual(len(list(pasta.glob("dialogo-remocao-*.png"))), 20)
        # Só o diálogo (400 px), nunca a página inteira com as colunas de nome e usuário.
        self.assertLessEqual(int.from_bytes(Path(resultado["captura"]).read_bytes()[16:20], "big"), 420)
        self.assertEqual(len(abertas), 1)
        self.assertEqual(endpoint_remocao.url_som(_automacao()), f"{BASE}#/uems/agent/som/computers?managedStatus=true")

    def test_variavel_de_recusa_vence_a_confirmacao(self):
        os.environ[endpoint_remocao.VAR_SEM_REMOCAO] = "1"
        resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True)
        self.assertEqual(resultado["resultado"], "recusado_por_configuracao")
        self.assertNotIn("sim", cliques)
        self.assertEqual(cliques[-1], "cancelar:mdm")

    def test_zero_ou_duas_linhas_param_sem_clicar(self):
        for linhas, esperado in (([], "nao_encontrado"), (["PRNOTE100", "PRNOTE100"], "ambiguo")):
            with self.subTest(linhas=linhas):
                resultado, cliques, _ = self.rodar(linhas, confirmado=True)
                self.assertEqual(resultado["resultado"], esperado)
                self.assertEqual(cliques, [])

    def test_nome_parecido_nao_conta_como_exato(self):
        for linhas, esperado in ((["PRNOTE1000"], "nao_encontrado"), (["PRNOTE100", "PRNOTE1000"], "ambiguo")):
            with self.subTest(linhas=linhas):
                resultado, cliques, _ = self.rodar(linhas, confirmado=True)
                self.assertEqual(resultado["resultado"], esperado)
                self.assertEqual(cliques, [])

    def test_mdm_desmarcado_e_marcado_e_marcado_continua(self):
        for mdm in (False, True):
            with self.subTest(mdm=mdm):
                resultado, cliques, _ = self.rodar(["PRNOTE100"], mdm=mdm)
                self.assertEqual(resultado["resultado"], "cancelado_sem_confirmacao")
                self.assertEqual(cliques[-1], "cancelar:mdm")
                # Desmarcado: um único clique no label; já marcado: nenhum clique (o label alterna).
                self.assertEqual(cliques.count("label_mdm"), 0 if mdm else 1)

    def test_dialogo_que_nao_fecha_e_incerto_com_um_clique(self):
        with patch.object(endpoint_remocao, "ESPERA_DIALOGO_FECHAR_MS", 1500):
            resultado, cliques, abertas = self.rodar(["PRNOTE100"], confirmado=True, fecha=False)
        self.assertEqual(resultado["resultado"], "incerto")
        self.assertEqual(cliques.count("sim"), 1)
        self.assertEqual(len(abertas), 1)  # sem nova navegação nem nova tentativa

    def test_removido_quando_o_portal_tira_a_linha_sozinho(self):
        with patch.multiple(endpoint_remocao, INTERVALO_CONFERENCIA_MS=300):
            resultado, cliques, abertas = self.rodar(["PRNOTE100"], confirmado=True, depois=[], apos_sim=[])
        self.assertEqual(resultado["resultado"], "removido")
        self.assertEqual(cliques, ["remover", "label_mdm", "sim"])
        self.assertEqual(len(abertas), 2)  # goto de novo (via about:blank), nunca reload
        self.assertTrue(any(m.startswith("Grade atualizada em") for m in self.logs))

    def test_removido_so_depois_de_refazer_o_filtro(self):
        with patch.multiple(endpoint_remocao, ESPERA_REMOCAO_MS=2000, INTERVALO_CONFERENCIA_MS=300):
            # busca 1 com a linha; buscas 2 e 3 vazias (duas seguidas confirmam)
            resultado, cliques, abertas = self.rodar(["PRNOTE100"], confirmado=True, depois=["PRNOTE100"], some_apos=3)
        self.assertEqual(resultado["resultado"], "removido")
        self.assertEqual(cliques, ["remover", "label_mdm", "sim"])  # o Sim e o remover, uma vez cada
        self.assertEqual(len(abertas), 2)
        self.assertTrue(any(m.startswith("Remoção confirmada em") for m in self.logs))

    def test_linha_que_nunca_some_e_incerto_com_um_clique(self):
        with patch.multiple(endpoint_remocao, ESPERA_REMOCAO_MS=2000, ESPERA_CONFERENCIA_MS=60000, INTERVALO_CONFERENCIA_MS=300):
            resultado, cliques, abertas = self.rodar(["PRNOTE100"], confirmado=True, depois=["PRNOTE100"])
        self.assertEqual(self.buscas, 1 + endpoint_remocao.BUSCAS_CONFERENCIA)  # 1 antes do Sim + no máximo 3 depois
        self.assertEqual(resultado["resultado"], "incerto")
        self.assertEqual(cliques, ["remover", "label_mdm", "sim"])
        self.assertEqual(len(abertas), 2)
        self.assertTrue(any(m.startswith("Remoção não confirmada em") for m in self.logs))

    def test_vazio_passageiro_com_carregador_nao_e_removido(self):
        with patch.multiple(endpoint_remocao, ESPERA_REMOCAO_MS=2000, INTERVALO_CONFERENCIA_MS=300):
            resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, depois=[], segundo={"vazio_com_carregador": True})
        self.assertEqual(resultado["resultado"], "incerto")
        self.assertEqual(cliques.count("sim"), 1)

    def test_filtro_com_outro_valor_e_incerto(self):
        with patch.multiple(endpoint_remocao, ESPERA_REMOCAO_MS=2000, INTERVALO_CONFERENCIA_MS=300), \
                patch.object(endpoint_remocao.grid, "CONFIRMACAO_FILTRO_S", 2):
            resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, depois=[], segundo={"troca_filtro": True})
        self.assertEqual(resultado["resultado"], "incerto")
        self.assertEqual(cliques.count("sim"), 1)

    def test_busca_vazia_isolada_seguida_de_linha_nao_e_removido(self):
        # Depois do goto: render 1 (carga) com linha, busca 1 vazia, buscas 2 e 3 com a linha.
        with patch.multiple(endpoint_remocao, ESPERA_REMOCAO_MS=2000, INTERVALO_CONFERENCIA_MS=300):
            resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, depois=["PRNOTE100"], segundo={"vazio_em": [2]})
        self.assertEqual(resultado["resultado"], "incerto")
        self.assertEqual(cliques.count("sim"), 1)

    def test_marcador_que_nao_grava_nao_clica_e_fecha_pelo_cancel(self):
        def falha():
            raise RuntimeError("disco cheio")

        resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, antes_do_clique=falha)
        self.assertEqual(resultado["resultado"], "marcador_nao_gravado")
        self.assertEqual(cliques, ["remover", "label_mdm", "cancelar:mdm"])
        self.assertFalse(self.alerta_visivel)
        self.assertEqual(self.marcadas, 0)

    def test_marcador_e_gravado_antes_do_sim(self):
        ordem = []
        with patch.multiple(endpoint_remocao, INTERVALO_CONFERENCIA_MS=300):
            resultado, cliques, _ = self.rodar(
                ["PRNOTE100"], confirmado=True, depois=[], apos_sim=[], antes_do_clique=lambda: ordem.append("marcador"))
        self.assertEqual(resultado["resultado"], "removido")
        self.assertEqual(ordem, ["marcador"])  # uma vez; sem ele o Sim não é clicado (teste acima)
        self.assertEqual(cliques, ["remover", "label_mdm", "sim"])

    def test_dialogo_nao_reconhecido_fecha_pelo_cancel_e_desmarca(self):
        with patch.object(endpoint_remocao, "ESPERA_CONTEUDO_DIALOGO_MS", 2500):
            resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, reconhecivel=False)
        self.assertEqual(resultado["resultado"], "dialogo_inesperado")
        self.assertEqual(cliques, ["remover", "cancelar:sem_mdm"])
        self.assertTrue(Path(resultado["captura"]).is_file())
        self.assertNotIn("dialogo_aberto", resultado)
        self.assertIn("Diálogo não reconhecido: conteudo.", self.logs)
        self.assertFalse(self.alerta_visivel)
        self.assertEqual(self.marcadas, 0)

    def test_zoom_do_viewport_multiplica_o_recorte(self):
        with patch.object(endpoint_remocao, "_zoom", return_value=0.5):
            resultado, _, _ = self.rodar(["PRNOTE100"])
        largura = int.from_bytes(Path(resultado["captura"]).read_bytes()[16:20], "big")
        self.assertTrue(190 <= largura <= 210, largura)  # painel de 400 px CSS x zoom 0,5

    def test_captura_recusa_moldura_cheia_e_caixa_instavel(self):
        for cfg in ({"dialogo_cheio": True}, {"dialogo_animado": True}):
            with self.subTest(cfg=cfg):
                resultado, cliques, _ = self.rodar(["PRNOTE100"], primeiro=cfg)
                self.assertEqual(resultado["resultado"], "cancelado_sem_confirmacao")
                self.assertEqual(resultado["captura"], "")  # sem captura; o diálogo continua fechado pelo Cancel
                self.assertEqual(cliques[-1], "cancelar:mdm")
                self.assertFalse(self.alerta_visivel)

    def test_log_vem_antes_do_marcador(self):
        with patch.multiple(endpoint_remocao, INTERVALO_CONFERENCIA_MS=300):
            resultado, _, _ = self.rodar(["PRNOTE100"], confirmado=True, depois=[], apos_sim=[],
                                         antes_do_clique=lambda: self.logs.append("MARCADOR"))
        self.assertEqual(resultado["resultado"], "removido")
        self.assertLess(self.logs.index("Confirmando a remoção (clique único)."), self.logs.index("MARCADOR"))

    def test_dialogo_que_muda_depois_do_marcador_nao_clica(self):
        def marcador_e_mudanca():
            self.page.evaluate("document.querySelector('#dlg label input').checked = false")

        resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, antes_do_clique=marcador_e_mudanca)
        self.assertEqual(resultado["resultado"], "dialogo_inesperado")
        self.assertNotIn("sim", cliques)
        self.assertTrue(cliques[-1].startswith("cancelar"))
        self.assertFalse(self.alerta_visivel)
        self.assertEqual(self.marcadas, 0)

    def test_zoom_real_sem_escala_e_1(self):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        self.assertEqual(endpoint_remocao._zoom(page), 1.0)

    def test_contato_recente_ilegivel_ou_sem_corte_nao_clica(self):
        for contato, corte in (
            ("nov 25, 2026 07:00 AM", "nov 25, 2026 08:59 PM"),  # mesmo dia do corte
            ("dez 02, 2026 09:00 AM", "nov 25, 2026 08:59 PM"),  # depois do corte (mês em português)
            ("--", "nov 25, 2026 08:59 PM"),
            ("nov 23, 2026 11:20 AM", None),
        ):
            with self.subTest(contato=contato, corte=corte):
                resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, contato=contato, corte=corte)
                self.assertEqual(resultado["resultado"], "contato_recente")
                self.assertEqual(cliques, [])
                self.assertEqual(self.marcadas, 0)

    def test_motivo_obrigatorio_para_antes_do_clique_final(self):
        resultado, cliques, _ = self.rodar(["PRNOTE100"], confirmado=True, motivo=True)
        self.assertEqual(resultado["resultado"], "motivo_obrigatorio")
        self.assertNotIn("sim", cliques)
        self.assertTrue(cliques[-1].startswith("cancelar"))
        self.assertFalse(self.alerta_visivel)
        self.assertEqual(self.marcadas, 0)


class LiberacaoTests(unittest.TestCase):
    def test_so_true_literal_e_sem_variavel_liberam(self):
        with patch.dict(os.environ, {endpoint_remocao.VAR_SEM_REMOCAO: "0"}):
            self.assertTrue(endpoint_remocao.remocao_liberada(True))
            self.assertFalse(endpoint_remocao.remocao_liberada(1))
            self.assertFalse(endpoint_remocao.remocao_liberada("true"))
        with patch.dict(os.environ, {endpoint_remocao.VAR_SEM_REMOCAO: "1"}):
            self.assertFalse(endpoint_remocao.remocao_liberada(True))

    def test_sem_confirmacao_o_codigo_nao_alcanca_o_sim(self):
        # O localizador do "Sim" só existe em _confirmar_remocao, chamada depois de remocao_liberada.
        import inspect
        fonte = inspect.getsource(endpoint_remocao.remover_na_pagina)
        for saida in (endpoint_remocao._sair_sem_remover, endpoint_remocao._fechar_alertas):
            self.assertNotIn("_SIM", inspect.getsource(saida))
        self.assertNotIn("_SIM", fonte)
        self.assertLess(fonte.index("remocao_liberada(confirmado)"), fonte.index("_confirmar_remocao("))


if __name__ == "__main__":
    unittest.main()
