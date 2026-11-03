"""Assistant automation tools: real states, enumerated failure reasons and no raw log text sent to the model."""

import json
import unittest
from typing import Any, Dict, List, Optional, Tuple

from domains.assistant_api import _MOTIVOS, MOTIVOS_AUTOMACAO, SimpressApi, _motivo_codigo
from domains.assistant_tools import TOOLS, grupos_da_mensagem
from tests.test_assistant import FakeModel, abrir, call, calls, make_conversation, text

# Synthetic sensitive data: none of these pieces may reach the model.
EMAIL, CPF, TOKEN, COOKIE, NOME = "joana.quaresma@exemplo.test", "123.456.789-09", "SEGREDO987TOKEN", "SESSAOabc123XYZ", "Zebedeu Quaresmo"
SUJO = (f"para {EMAIL} cpf {CPF} em https://softexpert.exemplo.test/se?token={TOKEN} cookie=JSESSIONID={COOKIE} "
        f"arquivo C:\\Users\\Fulano\\Downloads\\x.xlsx operador {NOME}")
PROIBIDOS = (EMAIL, "joana.quaresma", CPF, "12345678909", TOKEN, COOKIE, NOME, "Users", "Fulano", "softexpert.exemplo.test",
             "[E-MAIL OCULTADO]", "x.xlsx")


def execucao(status: str, mensagem: str = "", rotina: str = "sebrae", codigo: Optional[int] = 1, **extra: Any) -> Dict[str, Any]:
    item = {"id": "20261102-101500-sebrae", "rotina": rotina, "origem": "site", "inicio": "2026-11-02T10:15:00",
            "fim": "2026-11-02T10:20:30", "status": status, "codigo": codigo, "mensagem": mensagem,
            "lotes": [{"id": "C:\\Users\\Fulano\\lote1", "status": "importado"}, {"id": "lote2", "status": "falha"}],
            "capturas": [{"nome": f"{NOME}.png", "url": f"/api/automacao/capturas/{TOKEN}.png"}],
            "log": f"C:\\Users\\Fulano\\logs\\{NOME}.log"}
    item.update(extra)
    return item


class Rotas:
    """Fake transport for the automation routes; records every call."""

    def __init__(self, estado: Optional[Dict[str, Any]] = None, historico: Optional[List[Dict[str, Any]]] = None,
                 linhas: Optional[List[str]] = None, executar: Tuple[int, Any] = (202, {}), cancelar: Tuple[int, Any] = (202, {}),
                 estado_depois: Optional[Dict[str, Any]] = None) -> None:
        self.estado = estado or {"estado": "livre", "rotina": "", "ultima": None}
        self.estado_depois = estado_depois
        self.historico = historico or []
        self.linhas = linhas or []
        self.executar, self.cancelar = executar, cancelar
        self.calls: List[Tuple[str, str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]] = []

    def __call__(self, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Tuple[int, Any]:
        self.calls.append((method, path, params, body))
        if path == "/api/automacao/estado":
            return 200, self.estado
        if path == "/api/automacao/historico":
            itens = [e for e in self.historico if not (params or {}).get("status") or e["status"] == params["status"]]
            return 200, {"execucoes": itens[: (params or {}).get("limite", 15)], "total": len(itens)}
        if path.startswith("/api/automacao/execucoes/") and path.endswith("/log"):
            alvo = next((e for e in self.historico if path == f"/api/automacao/execucoes/{e['id']}/log"), None)
            if alvo is None:
                return 404, {"detail": "Execução não encontrada."}
            return 200, {"execucao": alvo, "arquivo": f"{NOME}.log", "linhas": self.linhas, "limitado": False}
        if path == "/api/automacao/executar":
            if self.estado_depois is not None:
                self.estado = self.estado_depois
            return self.executar
        if path == "/api/automacao/cancelar":
            if self.estado_depois is not None:
                self.estado = self.estado_depois
            return self.cancelar
        return 404, {"detail": "não existe"}

    def writes(self) -> List[Tuple[str, str]]:
        return [(m, p) for m, p, _, _ in self.calls if m != "GET"]


def dump(dados: Any) -> str:
    return json.dumps(dados, ensure_ascii=False)


class SelecaoDeGruposTests(unittest.TestCase):
    def test_phrases_select_the_automation_group(self) -> None:
        for frase in ("Para a automação atual", "Em que etapa a automação está?", "A rotina terminou ou falhou?",
                      "Confere os usuários logados", "Roda a automação de chamados do Sebrae",
                      "Baixa o Dashboard do SharePoint e atualiza", "Você consegue rodar a automação do Sebrae?",
                      "Por que o robô parou?", "Por que falhou?", "Deu erro na automação"):
            with self.subTest(frase=frase):
                self.assertIn("automacao", grupos_da_mensagem(frase))

    def test_no_false_positives(self) -> None:
        for frase in ("a comparação falhou", "máquinas sem usuário logado", "quem são os usuários logados na ABC123?"):
            with self.subTest(frase=frase):
                self.assertNotIn("automacao", grupos_da_mensagem(frase))

    def test_result_tool_is_a_read_in_the_group(self) -> None:
        tool = TOOLS["resultado_ultima_automacao"]
        self.assertFalse(tool.changes_data)


class StatusTests(unittest.TestCase):
    def status(self, estado: Dict[str, Any]) -> Dict[str, Any]:
        return SimpressApi(Rotas(estado=estado)).consultar_status_automacao()

    def test_free_without_history(self) -> None:
        r = self.status({"estado": "livre", "rotina": "", "ultima": None})
        self.assertEqual((r["situacao"], r["fonte"], r["rotina"]), ("livre", "estado_atual", "nenhuma"))
        self.assertIsNone(r["ultima_execucao"])
        self.assertIn("Nenhuma execução registrada", r["nota_ultima"])
        self.assertNotIn("etapa", r)

    def test_running_has_unavailable_step(self) -> None:
        r = self.status({"estado": "em_andamento", "rotina": "os", "inicio": "2026-11-02T09:00:00", "origem": "site", "pid": 4242,
                         "log": {"linhas": [f"[INFO] {SUJO}"]}, "ultima": execucao("em_andamento", codigo=None)})
        self.assertEqual((r["situacao"], r["rotina"], r["etapa"]), ("em_andamento", "os", "indisponível"))
        self.assertIn("nota_etapa", r)
        self.assertEqual(r["ultima_execucao"]["fonte"], "historico")
        self.assertNotIn("4242", dump(r))
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, dump(r))

    def test_waiting_login_is_the_only_known_step(self) -> None:
        r = self.status({"estado": "em_andamento", "rotina": "sebrae", "aguardando_login": True, "login_origem": NOME})
        self.assertEqual((r["situacao"], r["etapa"]), ("aguardando_login", "aguardando_login"))
        self.assertNotIn(NOME, dump(r))

    def test_cancel_requested_wins(self) -> None:
        r = self.status({"estado": "em_andamento", "rotina": "sebrae", "aguardando_login": True, "cancelamento_pedido": True})
        self.assertEqual(r["situacao"], "cancelamento_solicitado")

    def test_last_run_labels(self) -> None:
        for status, situacao in (("concluido", "concluida"), ("falha", "falhou"), ("cancelado", "cancelada"),
                                 ("interrompido", "interrompida"), ("ocupada", "ocupada")):
            with self.subTest(status=status):
                ultima = self.status({"estado": "livre", "ultima": execucao(status, SUJO)})["ultima_execucao"]
                self.assertEqual(ultima["situacao"], situacao)
        interrompida = self.status({"estado": "livre", "ultima": execucao("interrompido")})["ultima_execucao"]
        self.assertEqual(interrompida["motivo_codigo"], "servidor_reiniciado")
        self.assertIn("não é falha", interrompida["situacao_texto"])
        ocupada = self.status({"estado": "livre", "ultima": execucao("ocupada")})["ultima_execucao"]
        self.assertEqual(ocupada["motivo_codigo"], "outra_execucao_em_andamento")

    def test_free_but_last_still_running_says_not_recorded(self) -> None:
        ultima = self.status({"estado": "livre", "ultima": execucao("em_andamento", codigo=None)})["ultima_execucao"]
        self.assertIn("Resultado não registrado", ultima["situacao_texto"])


class ResultadoTests(unittest.TestCase):
    def test_success_with_batches(self) -> None:
        rotas = Rotas(historico=[execucao("concluido", codigo=0)])
        r = SimpressApi(rotas).resultado_ultima_automacao()
        final = r["ultima_finalizada"]
        self.assertEqual((r["fonte"], final["situacao"], final["rotina"]), ("historico", "concluida", "sebrae"))
        self.assertEqual(final["lotes"], {"total": 2, "por_status": {"importado": 1, "falha": 1}})
        self.assertEqual(final["capturas_de_tela"], 1)
        self.assertEqual(final["duracao_segundos"], 330)
        self.assertNotIn("motivo_codigo", final)
        self.assertNotIn("aviso_execucao_atual", r)
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, dump(r))

    def test_failure_has_reason_and_running_warning(self) -> None:
        rotas = Rotas(estado={"estado": "em_andamento", "rotina": "os"},
                      historico=[execucao("em_andamento", codigo=None), execucao("falha", f"Login não concluído em 15 minutos. {SUJO}")])
        r = SimpressApi(rotas).resultado_ultima_automacao()
        self.assertEqual(r["ultima_finalizada"]["motivo_codigo"], "login_nao_concluido")
        self.assertIn("ainda não terminou", r["aviso_execucao_atual"])
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, dump(r))

    def test_no_finished_run(self) -> None:
        r = SimpressApi(Rotas()).resultado_ultima_automacao()
        self.assertIn("Nenhuma execução finalizada", r["mensagem"])

    def test_busy_run_does_not_mask_the_last_real_run(self) -> None:
        r = SimpressApi(Rotas(historico=[execucao("ocupada"), execucao("concluido", codigo=0)])).resultado_ultima_automacao()
        self.assertEqual(r["ultima_finalizada"]["situacao"], "concluida")
        r = SimpressApi(Rotas(historico=[execucao("ocupada")])).resultado_ultima_automacao()
        self.assertIn("Nenhuma execução finalizada", r["mensagem"])
        self.assertNotIn("ultima_finalizada", r)

    def test_duration_survives_mixed_timezones(self) -> None:
        misto = SimpressApi(Rotas(historico=[execucao("concluido", codigo=0, inicio="2026-11-02T10:00:00", fim="2026-11-02T10:05:00+00:00")]))
        self.assertNotIn("duracao_segundos", misto.resultado_ultima_automacao()["ultima_finalizada"])
        normal = SimpressApi(Rotas(historico=[execucao("concluido", codigo=0)]))
        self.assertEqual(normal.resultado_ultima_automacao()["ultima_finalizada"]["duracao_segundos"], 330)


class LogTests(unittest.TestCase):
    def test_mapped_failure_hides_every_sensitive_piece(self) -> None:
        linhas = [f"[INFO] Abrindo {SUJO}", f"[FALHA] O download de X chegou vazio {SUJO}", f"Traceback {SUJO}"]
        rotas = Rotas(historico=[execucao("falha", f"O download de X chegou vazio {SUJO}")], linhas=linhas)
        r = SimpressApi(rotas).log_execucao_automacao()
        self.assertEqual(r["motivo_codigo"], "download_falhou")
        self.assertEqual(r["linhas_de_falha"], 1)
        self.assertNotIn("detalhes", r)
        self.assertIn("Cockpit", r["nota"])
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, dump(r))

    def test_unmapped_failure_is_unknown_with_note(self) -> None:
        rotas = Rotas(historico=[execucao("falha", f"Algo inesperado {SUJO}")], linhas=[f"[FALHA] Algo inesperado {SUJO}"])
        r = SimpressApi(rotas).log_execucao_automacao()
        self.assertEqual(r["motivo_codigo"], "desconhecido")
        self.assertIn("não é enviado à IA", r["execucao"]["motivo_texto"])
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, dump(r))

    def test_reason_from_log_lines_when_message_is_empty(self) -> None:
        rotas = Rotas(historico=[execucao("falha", "")], linhas=["[FALHA] Google Chrome não encontrado neste computador."])
        self.assertEqual(SimpressApi(rotas).log_execucao_automacao()["motivo_codigo"], "chrome_nao_encontrado")

    def test_real_id_formats_survive_the_sanitizer(self) -> None:
        real = "20261102_101500_os (1)"  # stem made by the script's nome_livre
        rotas = Rotas(historico=[execucao("falha", "Login não concluído.", id=real)])
        r = SimpressApi(rotas).log_execucao_automacao(real)
        self.assertEqual((r["execucao"]["id"], r["execucao"]["inicio"], r["execucao"]["fim"]),
                         (real, "2026-11-02T10:15:00", "2026-11-02T10:20:30"))
        self.assertIn(("GET", f"/api/automacao/execucoes/{real}/log"), [(m, p) for m, p, _, _ in rotas.calls])

    def test_invalid_id_and_no_failure(self) -> None:
        api = SimpressApi(Rotas())
        self.assertIn("erro", api.log_execucao_automacao(".."))
        self.assertIn("erro", api.log_execucao_automacao("../x"))
        self.assertIn("erro", api.log_execucao_automacao("C:\\Users\\x"))
        self.assertIn("Nenhuma rotina com falha", api.log_execucao_automacao()["mensagem"])

    def test_history_is_allowlisted(self) -> None:
        r = SimpressApi(Rotas(historico=[execucao("falha", SUJO), execucao("concluido", SUJO)])).listar_historico_automacao()
        self.assertEqual(len(r["execucoes"]), 2)
        self.assertEqual(r["execucoes"][0]["motivo_codigo"], "desconhecido")
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, dump(r))

    def test_reason_table(self) -> None:
        casos = {
            "Rotina de OS não foi concluída. | Login não concluído em 10 minutos.": "login_nao_concluido",
            "O Chrome não abriu a porta 9222.": "chrome_sem_conexao",
            "O site recusou o Dashboard (HTTP 400).": "dashboard_recusado_pelo_site",
            "O Dashboard no SharePoint mudou depois da importação; importe de novo.": "dashboard_sharepoint_mudou",
            "Gestão de solicitações: a tela não ficou pronta em 60 s (x).": "timeout",
            "TimeoutError: Page.click: Timeout 30000ms exceeded.": "timeout",
            "A busca de chamados novos não foi concluída.": "rotina_nao_concluida",
            "Não foi possível abrir a Gestão de Solicitações pelo Menu do Oracle.": "oracle_menu_indisponivel",
            "O XLSX do Endpoint tem 10 linhas, mas a tela mostra 12.": "exportacao_endpoint_invalida",
        }
        for texto, esperado in casos.items():
            with self.subTest(texto=texto):
                self.assertEqual(_motivo_codigo("falha", 1, [texto]), esperado)
        self.assertEqual(_motivo_codigo("falha", 3, [""]), "playwright_ausente")
        self.assertEqual(_motivo_codigo("cancelado", 130, [""]), "cancelada_pelo_operador")
        self.assertIsNone(_motivo_codigo("concluido", 0, ["Login não concluído"]))
        self.assertTrue({c for _, c in _MOTIVOS} <= set(MOTIVOS_AUTOMACAO))

    def test_model_receives_no_log_text(self) -> None:
        rotas = Rotas(historico=[execucao("falha", SUJO)], linhas=[f"[FALHA] {SUJO}"])
        model = FakeModel(calls(call("log_execucao_automacao")), text("Falhou por motivo desconhecido."))
        conversation, _ = make_conversation(model, rotas)  # type: ignore[arg-type]
        conversation.enviar_mensagem("por que a rotina falhou?")
        enviado = abrir(model.sent[1][-1]["content"])
        self.assertIn("desconhecido", enviado)
        for proibido in PROIBIDOS:
            self.assertNotIn(proibido, enviado)


class ExecutarTests(unittest.TestCase):
    def test_success_reads_state_once_and_says_started(self) -> None:
        rotas = Rotas(estado_depois={"estado": "em_andamento", "rotina": "sebrae", "origem": "site", "log": {"linhas": [SUJO]}})
        r = SimpressApi(rotas).executar_automacao("sebrae")
        self.assertTrue(r["sucesso"])
        self.assertIn("iniciada", r["mensagem"])
        self.assertIn("Iniciar não é concluir", r["mensagem"])
        self.assertIn("resultado_ultima_automacao", r["mensagem"])
        self.assertEqual(r["estado_apos_iniciar"]["situacao"], "em_andamento")
        self.assertEqual([p for m, p, _, _ in rotas.calls], ["/api/automacao/executar", "/api/automacao/estado"])
        self.assertNotIn(NOME, dump(r))

    def test_state_after_start_never_carries_the_previous_run(self) -> None:
        rotas = Rotas(estado_depois={"estado": "livre", "rotina": "", "ultima": execucao("falha", SUJO)})
        r = SimpressApi(rotas).executar_automacao("sebrae")
        self.assertTrue(r["sucesso"])
        self.assertNotIn("ultima_execucao", r["estado_apos_iniciar"])
        self.assertIn("resultado_ultima_automacao", r["mensagem"])
        self.assertNotIn("falhou", dump(r))

    def test_error_body_reaches_the_model_without_tokens_cookies_or_paths(self) -> None:
        sujo = f"{SUJO} Bearer sk-or-v1-abcdef123456 Cookie: FedAuth=ZZZ"
        r = SimpressApi(Rotas(executar=(500, {"detail": sujo}))).executar_automacao("os")
        self.assertFalse(r["sucesso"])
        for proibido in (EMAIL, CPF, TOKEN, COOKIE, "softexpert.exemplo.test", "Users", "Fulano", "x.xlsx", "sk-or-v1", "FedAuth=ZZZ"):
            self.assertNotIn(proibido, r["erro"])

    def test_conflict_keeps_message(self) -> None:
        r = SimpressApi(Rotas(executar=(409, {"detail": "Já existe uma rotina em andamento."}))).executar_automacao("os")
        self.assertEqual(r["erro"], "Já existe uma automação em andamento. Aguarde o término ou cancele.")

    def test_invalid_and_forbidden_routines_never_post(self) -> None:
        for rotina in ("xyz", "fechar", "enviar", "antigos"):
            with self.subTest(rotina=rotina):
                rotas = Rotas()
                r = SimpressApi(rotas).executar_automacao(rotina)
                self.assertFalse(r["sucesso"])
                self.assertIn("Rotina inválida", r["erro"])
                self.assertEqual(rotas.writes(), [])

    def test_card_before_any_post_then_started(self) -> None:
        rotas = Rotas(estado_depois={"estado": "em_andamento", "rotina": "sebrae"})
        conversation, _ = make_conversation(FakeModel(calls(call("executar_automacao_chrome", rotina="sebrae"))), rotas)  # type: ignore[arg-type]
        reply = conversation.enviar_mensagem("Roda a automação de chamados do Sebrae")
        self.assertIsNotNone(reply.pendente)
        self.assertIn("SoftExpert", reply.pendente["descricao"])  # type: ignore[index]
        self.assertEqual(rotas.writes(), [])
        confirmado = conversation.resolver_confirmacao(True)
        self.assertEqual(rotas.writes(), [("POST", "/api/automacao/executar")])
        self.assertIn("iniciada", confirmado.texto)

    def test_capability_question_runs_nothing(self) -> None:
        rotas = Rotas()
        conversation, _ = make_conversation(FakeModel(text("Sim, consigo iniciar essa rotina se você pedir.")), rotas)  # type: ignore[arg-type]
        conversation.enviar_mensagem("Você consegue rodar a automação do Sebrae?")
        self.assertEqual(rotas.writes(), [])
        self.assertIsNone(conversation._pendente)

    def test_cards_describe_each_routine(self) -> None:
        describe = TOOLS["executar_automacao_chrome"].describe  # type: ignore[misc]
        self.assertIn("SharePoint", describe({"rotina": "dashboard"}))
        self.assertIn("Não atualiza a cópia local nem envia nada ao SharePoint", describe({"rotina": "dashboard"}))
        self.assertIn("login manual", describe({"rotina": "login"}))


class CancelarTests(unittest.TestCase):
    def test_request_is_not_completion(self) -> None:
        rotas = Rotas(estado_depois={"estado": "em_andamento", "rotina": "os", "cancelamento_pedido": True})
        r = SimpressApi(rotas).cancelar_automacao()
        self.assertTrue(r["sucesso"])
        self.assertFalse(r["cancelada"])
        self.assertIn("Cancelamento solicitado", r["mensagem"])
        self.assertNotIn("Rotina cancelada", r["mensagem"])
        self.assertEqual(r["situacao_apos_pedido"], "cancelamento_solicitado")

    def test_confirmed_only_when_free_and_last_cancelled(self) -> None:
        rotas = Rotas(estado_depois={"estado": "livre", "ultima": execucao("cancelado", codigo=130)})
        r = SimpressApi(rotas).cancelar_automacao()
        self.assertTrue(r["cancelada"])

    def test_nothing_running(self) -> None:
        rotas = Rotas(cancelar=(409, {"detail": "Nenhuma rotina em andamento para cancelar."}))
        r = SimpressApi(rotas).cancelar_automacao()
        self.assertFalse(r["sucesso"])
        self.assertIn("Não há rotina de automação em andamento", r["erro"])

    def test_external_run_keeps_server_instruction(self) -> None:
        rotas = Rotas(cancelar=(409, {"detail": "A rotina foi iniciada fora do site; cancele na janela dela (Ctrl+C)."}))
        self.assertIn("Ctrl+C", SimpressApi(rotas).cancelar_automacao()["erro"])


if __name__ == "__main__":
    unittest.main()
