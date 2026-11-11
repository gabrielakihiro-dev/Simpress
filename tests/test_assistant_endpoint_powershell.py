import json
import unittest

from domains.assistant_api import SimpressApi
from domains.assistant_chat import AssistantConversation
from domains.assistant_tools import TOOLS, schemas_para_mensagem
from tests.test_assistant import FakeModel, calls, call, text

COMANDO = "Get-Service | Where-Object Status -eq 'Running'"
HOST = "PRNOTEUMU005"  # dado sintético; o hostname é sempre informado, não existe computador padrão


class AssistantPowerShellTests(unittest.TestCase):
    def conversation(self, response, requests, **args):
        def transport(method, path, params, body):
            if method == "POST":
                requests.append((path, body))
                return 200, response
            return 200, {"items": [], "has_more": False}
        args = {"comando": COMANDO, "hostname": HOST, **args}
        model = FakeModel(calls(call("abrir_powershell_endpoint", **args)), text("Pronto."))
        return AssistantConversation(model, SimpressApi(transport), "modelo-teste"), model

    def test_has_no_enter_or_execute_parameter(self):
        tool = TOOLS["abrir_powershell_endpoint"]
        self.assertTrue(tool.changes_data)
        props = [s for s in schemas_para_mensagem("abra o PowerShell") if s["function"]["name"] == "abrir_powershell_endpoint"][0]["function"]["parameters"]
        self.assertEqual(set(props["properties"]), {"comando", "modo", "hostname", "usuario"})  # no Enter/execute parameter
        self.assertEqual(props["required"], ["comando", "hostname"])  # sem computador padrão: o assistente pergunta ao usuário
        self.assertIn("pergunte", TOOLS["abrir_powershell_endpoint"].description)
        self.assertNotIn("padrão PRNOTE", TOOLS["abrir_powershell_endpoint"].description)

    def test_confirmation_card_names_everything_and_nothing_runs_before_click(self):
        requests = []
        conversation, _ = self.conversation({"status": "inserido", "hostname": "PRNOTEUMU005", "modo": "sistema"}, requests)
        reply = conversation.enviar_mensagem("Abra o PowerShell e insira o comando")
        card = reply.pendente["descricao"]
        self.assertIn("PRNOTEUMU005", card)
        self.assertNotIn("padrão", card)
        self.assertIn("SYSTEM", card)
        self.assertIn(COMANDO, card)
        self.assertIn("O comando será apenas inserido no prompt; NÃO será executado (o Enter é seu, no Chrome).", card)
        self.assertEqual(requests, [])
        conversation.resolver_confirmacao(True)
        self.assertEqual(requests, [("/api/endpoint/powershell", {"modo": "sistema", "comando": COMANDO, "hostname": HOST})])

    def test_user_mode_card_and_payload(self):
        requests = []
        conversation, _ = self.conversation({"status": "inserido", "hostname": "PC1", "modo": "usuario", "usuario": "gananias"}, requests,
                                            modo="usuario", hostname="pc1", usuario="gananias")
        reply = conversation.enviar_mensagem("Abra o PowerShell como usuário logado")
        self.assertIn("usuário logado", reply.pendente["descricao"])
        self.assertIn("gananias", reply.pendente["descricao"])
        conversation.resolver_confirmacao(True)
        self.assertEqual(requests, [("/api/endpoint/powershell", {"modo": "usuario", "comando": COMANDO, "hostname": "PC1", "usuario": "gananias"})])

    def test_cancel_never_calls_the_route(self):
        requests = []
        conversation, _ = self.conversation({"status": "inserido"}, requests)
        conversation.enviar_mensagem("Abra o PowerShell")
        conversation.resolver_confirmacao(False)
        self.assertEqual(requests, [])

    def test_missing_hostname_is_rejected_before_any_request_and_never_defaults(self):
        for hostname in (None, "", "   ", "PC 1;rm"):
            args = {"comando": "ok", "hostname": hostname}
            requests = []
            result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *a: requests.append(a) or (200, {})), args)
            self.assertFalse(result["sucesso"], args)
            self.assertEqual(requests, [], args)
        self.assertFalse(TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *a: (200, {})), {"comando": "ok"})["sucesso"])
        for hostname in ("", "   "):  # a chamada direta da API tampouco cai num computador padrão
            requests = []
            result = SimpressApi(lambda *a: requests.append(a) or (200, {})).abrir_powershell_endpoint("ok", "sistema", hostname)
            self.assertFalse(result["sucesso"])
            self.assertEqual(requests, [])

    def test_missing_hostname_builds_no_confirmation_card(self):
        requests = []
        conversation, model = self.conversation({"status": "inserido"}, requests, hostname="")
        reply = conversation.enviar_mensagem("Abra o PowerShell e insira o comando")
        self.assertIsNone(reply.pendente)
        self.assertIn("pergunte ao usuário", json.dumps(model.sent, ensure_ascii=False))
        self.assertEqual(requests, [])

    def test_line_break_and_bad_arguments_rejected_before_any_request(self):
        for args in ({"comando": "a\nb"}, {"comando": "a\rb"}, {"comando": ""}, {"comando": "x" * 2001}, {"comando": "ok", "modo": "admin"}):
            args = {"hostname": HOST, **args}
            requests = []
            result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *a: requests.append(a) or (200, {})), args)
            self.assertFalse(result["sucesso"], args)
            self.assertEqual(requests, [], args)

    def test_result_never_echoes_the_command(self):
        segredo = "Write-Host SEGREDO-123"
        for status in ("inserido", "not_found", "erro_terminal", "sem_usuario", "usuario_ambiguo"):
            answer = {"status": status, "hostname": "PRNOTEUMU005", "modo": "sistema", "mensagem": "falha", "usuarios": ["a", "b"] if status == "usuario_ambiguo" else []}
            result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *args, a=answer: (200, a)), {"comando": segredo, "hostname": HOST})
            self.assertNotIn("SEGREDO-123", json.dumps(result, ensure_ascii=False), status)
            self.assertFalse(result.get("enter_enviado", False), status)
            self.assertEqual(result["sucesso"], status == "inserido", status)
        ok = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *args: (200, {"status": "inserido", "hostname": "PC1"})), {"comando": segredo, "hostname": "PC1"})
        self.assertNotIn("hostname_padrao_offline", ok)
        self.assertEqual(ok["tamanho_comando"], len(segredo))
        self.assertEqual(ok["hostname"], "PC1")
        self.assertEqual(ok["modo"], "sistema")
        self.assertIn("NÃO executado", ok["mensagem"])

    def test_http_errors_and_unknown_status_are_errors(self):
        for answer in ((409, {"detail": "ocupado"}), (503, {"detail": "falha"}), (200, {"status": "x"}), (422, {"detail": "inválido"})):
            result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *args, a=answer: a), {"comando": "ls", "hostname": HOST})
            self.assertFalse(result["sucesso"])
            self.assertIn("erro", result)

    def test_unicode_line_separators_and_bidi_controls_rejected(self):
        for ruim in ("a\u2028b", "a\u2029b", "a\u0085b", "a\u202eb", "a\u200bb", "a\x7fb"):
            requests = []
            result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *a: requests.append(a) or (200, {})), {"comando": ruim, "hostname": HOST})
            self.assertFalse(result["sucesso"], repr(ruim))
            self.assertEqual(requests, [], repr(ruim))

    def test_old_status_for_offline_default_is_no_longer_known(self):
        result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *a: (200, {"status": "sem_host_online", "hostname": HOST})), {"comando": "ls", "hostname": HOST})
        self.assertFalse(result["sucesso"])
        self.assertIn("erro", result)

    def test_non_dict_answer_is_an_error(self):
        result = TOOLS["abrir_powershell_endpoint"].run(SimpressApi(lambda *a: (200, ["x"])), {"comando": "ls", "hostname": HOST})
        self.assertFalse(result["sucesso"])

    def test_final_text_and_history_never_hold_the_command(self):
        segredo = "Write-Host SEGREDO-987"
        requests = []
        conversation, _ = self.conversation({"status": "inserido", "hostname": "PRNOTEUMU005", "modo": "sistema"}, requests, comando=segredo)
        reply = conversation.enviar_mensagem("Abra o PowerShell e insira o comando")
        self.assertIn("SEGREDO-987", reply.pendente["descricao"])  # the card must show it so the user reviews it
        final = conversation.resolver_confirmacao(True)
        self.assertNotIn("SEGREDO-987", final.texto)
        self.assertIn("NÃO executado", final.texto)

    def test_tool_only_sent_for_powershell_requests(self):
        nomes = lambda p: [s["function"]["name"] for s in schemas_para_mensagem(p)]
        for prompt in ("Abra o PowerShell da PRNOTEUMU005", "insere no powershell o comando ipconfig"):
            self.assertIn("abrir_powershell_endpoint", nomes(prompt), prompt)
        for prompt in ("Consulte ABC no Endpoint", "Abra o controle remoto da ABC", "quais chamados estão abertos?"):
            self.assertNotIn("abrir_powershell_endpoint", nomes(prompt), prompt)


if __name__ == "__main__":
    unittest.main()
