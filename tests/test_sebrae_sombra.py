"""Modo sombra: caderno local e avaliação, com um modelo falso (sem Ollama, sem planilha real)."""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from domains.sebrae_agendamento import FUSO
from domains.sebrae_chamados import TIPO_INCIDENTE, TIPO_SOLICITACAO, ChamadoSoftExpert, decidir
from scripts import avaliar_classificacao_local as av
from scripts import sebrae_sombra as sombra


def chamado(numero: str, descricao: str) -> ChamadoSoftExpert:
    return ChamadoSoftExpert(numero=numero, titulo="", descricao=descricao, solicitante="Maria", habilitada_em="21/10/2026 10:30")


class ObservadorTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.caderno = Path(self._tmp.name) / "sebrae_sombra.jsonl"

    def observador(self, chamar):
        return sombra.criar_observador(self.caderno, chamar, agora=lambda: datetime(2026, 10, 22, 9, 15, tzinfo=FUSO))

    def test_records_rule_and_suggestion_per_ticket(self):
        observar = self.observador(lambda corpo: json.dumps({"tipo": TIPO_SOLICITACAO}))
        item = chamado("UTIC-2026-0101", "Bom dia")
        observar(item, decidir(item))
        registro = sombra.ler_caderno(self.caderno)[0]
        self.assertEqual((registro["numero"], registro["regra"], registro["motivo"], registro["sugestao"]),
                         ("UTIC-2026-0101", None, "sem_indicios_de_tipo", TIPO_SOLICITACAO))
        self.assertEqual(registro["descricao"], "Bom dia")

    def test_model_offline_marks_unavailable_and_stops_calling(self):
        chamadas = []

        def fora_do_ar(corpo):
            chamadas.append(corpo)
            raise OSError("connection refused")

        observar = self.observador(fora_do_ar)
        for numero in ("UTIC-2026-0101", "UTIC-2026-0102"):
            item = chamado(numero, "Bom dia")
            observar(item, decidir(item))
        self.assertEqual(len(chamadas), 1)
        self.assertEqual([r["sugestao"] for r in sombra.ler_caderno(self.caderno)], [sombra.INDISPONIVEL] * 2)


class CruzarTest(unittest.TestCase):
    def test_only_tickets_with_answer_key_and_suggestion_are_scored(self):
        registros = [
            {"numero": "UTIC-2026-0101", "regra": None, "motivo": "sem_indicios_de_tipo", "sugestao": TIPO_INCIDENTE, "segundos": 2},
            {"numero": "UTIC-2026-0102", "regra": TIPO_INCIDENTE, "motivo": "", "sugestao": TIPO_INCIDENTE, "segundos": 2},
            {"numero": "UTIC-2026-0103", "regra": None, "motivo": "sem_indicios_de_tipo", "sugestao": sombra.INDISPONIVEL},
            {"numero": "UTIC-2026-0104", "regra": None, "motivo": "sem_indicios_de_tipo", "sugestao": TIPO_INCIDENTE},
        ]
        dashboard = [("UTIC-2026-0101", "x", "Incidente"), ("UTIC-2026-0102", "x", "INCIDENTE"),
                     ("UTIC-2026-0103", "x", "INCIDENTE"), ("UTIC-2026-0104", "x", "")]
        resultados = sombra.cruzar(registros, dashboard)
        self.assertEqual([(r["numero"], r["grupo"]) for r in resultados],
                         [("UTIC-2026-0101", av.GRUPO_A), ("UTIC-2026-0102", av.GRUPO_B)])
        self.assertEqual(av.resumir(resultados)["veredito"]["situacao"], "inconclusivo")


if __name__ == "__main__":
    unittest.main()
