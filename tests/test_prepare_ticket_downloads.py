"""Identidade e preservação dos lotes de chamados com arquivos sintéticos."""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import time
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from scripts import prepare_ticket_downloads


def bytes_xlsx(marker: str) -> bytes:
    from openpyxl import Workbook

    output = io.BytesIO()
    workbook = Workbook()
    workbook.active["A1"] = marker
    workbook.save(output)
    return output.getvalue()


class PrepareTicketDownloadsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix=".prepare-ticket-downloads-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.since = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.inbox = self.root / "entrada_chamados"

    def make_downloads(self, label: str) -> Path:
        downloads = self.root / f"downloads-{label}"
        downloads.mkdir()
        moment = time.time()
        sources = (
            ("Gestão de Solicitações (1).xlsx", f"oracle-{label}"),
            ("Acompanhamento de pedidos (1).xlsx", f"ux-{label}"),
        )
        for name, marker in sources:
            path = downloads / name
            path.write_bytes(bytes_xlsx(marker))
            os.utime(path, (moment, moment))
        return downloads

    def test_mesmo_minuto_com_fontes_diferentes_cria_lotes_distintos(self) -> None:
        first = prepare_ticket_downloads.prepare(self.make_downloads("a"), self.since, self.inbox)
        second = prepare_ticket_downloads.prepare(self.make_downloads("b"), self.since, self.inbox)

        self.assertNotEqual(first["lote_id"], second["lote_id"])
        self.assertEqual(second["lote_id"], f"{first['lote_id']}_02")
        self.assertFalse(second["reutilizado"])
        self.assertTrue((Path(first["pasta"]) / "oracle" / "Gestão de Solicitações (1).xlsx").is_file())
        self.assertTrue((Path(second["pasta"]) / "oracle" / "Gestão de Solicitações (1).xlsx").is_file())
        first_origin = json.loads((Path(first["pasta"]) / "_origem.json").read_text(encoding="utf-8"))
        second_origin = json.loads((Path(second["pasta"]) / "_origem.json").read_text(encoding="utf-8"))
        self.assertNotEqual(first_origin["fontes"]["oracle"]["sha256"], second_origin["fontes"]["oracle"]["sha256"])

    def test_mesma_execucao_e_mesmas_fontes_reutilizam_sem_alterar_recibo(self) -> None:
        downloads = self.make_downloads("replay")
        first = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)
        processed = self.inbox / "processadas" / first["lote_id"]
        processed.parent.mkdir(parents=True)
        Path(first["pasta"]).rename(processed)
        receipt = processed / "_resultado.json"
        receipt.write_text('{"status":"concluido","fixture":true}', encoding="utf-8")
        origin_before = (processed / "_origem.json").read_bytes()
        oracle_before = (processed / "oracle" / "Gestão de Solicitações (1).xlsx").read_bytes()

        replay = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)

        self.assertEqual(replay["lote_id"], first["lote_id"])
        self.assertEqual(replay["estado"], "processadas")
        self.assertTrue(replay["reutilizado"])
        self.assertEqual(receipt.read_text(encoding="utf-8"), '{"status":"concluido","fixture":true}')
        self.assertEqual((processed / "_origem.json").read_bytes(), origin_before)
        self.assertEqual((processed / "oracle" / "Gestão de Solicitações (1).xlsx").read_bytes(), oracle_before)

    def test_origem_igual_com_arquivo_existente_alterado_nao_reutiliza_lote(self) -> None:
        downloads = self.make_downloads("changed-existing")
        first = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)
        original = Path(first["pasta"]) / "oracle" / "Gestão de Solicitações (1).xlsx"
        changed_payload = bytes_xlsx("alterado depois da preparação")
        original.write_bytes(changed_payload)

        replay = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)

        self.assertEqual(replay["lote_id"], f"{first['lote_id']}_02")
        self.assertFalse(replay["reutilizado"])
        self.assertEqual(original.read_bytes(), changed_payload)
        self.assertNotEqual(
            (Path(replay["pasta"]) / "oracle" / "Gestão de Solicitações (1).xlsx").read_bytes(),
            original.read_bytes(),
        )

    def test_lote_legado_sem_origem_e_preservado_e_novo_id_usa_sufixo(self) -> None:
        base_tag = f"OS_{self.since.strftime('%Y%m%d_%H%M')}"
        legacy = self.inbox / "pendentes" / base_tag
        legacy.mkdir(parents=True)
        sentinel = legacy / "arquivo-legado.txt"
        sentinel.write_text("preservar", encoding="utf-8")

        result = prepare_ticket_downloads.prepare(self.make_downloads("legacy"), self.since, self.inbox)

        self.assertEqual(result["lote_id"], f"{base_tag}_02")
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preservar")
        self.assertTrue(legacy.is_dir())

    def test_replay_encontra_lote_com_sufixo_mesmo_apos_liberar_o_id_base(self) -> None:
        first = prepare_ticket_downloads.prepare(self.make_downloads("first"), self.since, self.inbox)
        downloads = self.make_downloads("second")
        second = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)
        Path(first["pasta"]).rename(self.root / "lote-preservado-fora-da-fila")

        replay = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)

        self.assertEqual(replay["lote_id"], second["lote_id"])
        self.assertTrue(replay["reutilizado"])
        self.assertEqual(list((self.inbox / "pendentes").iterdir()), [Path(second["pasta"])])

    def test_publicacao_concorrente_do_mesmo_lote_reutiliza_o_lote_publicado(self) -> None:
        downloads = self.make_downloads("concurrent")

        def publish_first(staging, target):
            shutil.copytree(staging, target)
            raise FileExistsError("Outro preparador publicou o lote antes do rename.")

        with patch.object(prepare_ticket_downloads, "publish_staging", side_effect=publish_first):
            result = prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)

        self.assertTrue(result["reutilizado"])
        self.assertTrue((Path(result["pasta"]) / "_origem.json").is_file())
        self.assertEqual(list(self.inbox.glob(".preparando-*")), [])

    def test_publicacao_concorrente_de_outro_lote_preserva_o_existente(self) -> None:
        original_publish = prepare_ticket_downloads.publish_staging
        occupied = []

        def publish_other_first(staging, target):
            if not occupied:
                target.mkdir()
                (target / "preservar.txt").write_text("lote de outra execução", encoding="utf-8")
                occupied.append(target)
                raise FileExistsError("Outro lote ocupou este ID.")
            original_publish(staging, target)

        with patch.object(prepare_ticket_downloads, "publish_staging", side_effect=publish_other_first):
            result = prepare_ticket_downloads.prepare(self.make_downloads("race"), self.since, self.inbox)

        self.assertFalse(result["reutilizado"])
        self.assertEqual(result["lote_id"], f"{occupied[0].name}_02")
        self.assertEqual((occupied[0] / "preservar.txt").read_text(encoding="utf-8"), "lote de outra execução")
        self.assertEqual(list(self.inbox.glob(".preparando-*")), [])

    def test_fonte_ausente_nao_cria_lote_nem_altera_lote_existente(self) -> None:
        base_tag = f"OS_{self.since.strftime('%Y%m%d_%H%M')}"
        legacy = self.inbox / "pendentes" / base_tag
        legacy.mkdir(parents=True)
        sentinel = legacy / "recibo.txt"
        sentinel.write_text("preservar", encoding="utf-8")
        downloads = self.root / "downloads-incompletos"
        downloads.mkdir()
        source = downloads / "Gestão de Solicitações (1).xlsx"
        source.write_bytes(bytes_xlsx("oracle"))
        os.utime(source, (time.time(), time.time()))

        with self.assertRaisesRegex(ValueError, "Nenhum download recente"):
            prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)

        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preservar")
        self.assertEqual(list((self.inbox / "pendentes").iterdir()), [legacy])

    def test_xlsx_invalido_nao_cria_lote(self) -> None:
        downloads = self.root / "downloads-invalidos"
        downloads.mkdir()
        now = time.time()
        (downloads / "Gestão de Solicitações (1).xlsx").write_bytes(bytes_xlsx("oracle"))
        invalid = downloads / "Acompanhamento de pedidos (1).xlsx"
        invalid.write_bytes(b"conteudo sintetico invalido")
        os.utime(downloads / "Gestão de Solicitações (1).xlsx", (now, now))
        os.utime(invalid, (now, now))

        with self.assertRaises(zipfile.BadZipFile):
            prepare_ticket_downloads.prepare(downloads, self.since, self.inbox)

        self.assertFalse(self.inbox.exists())


if __name__ == "__main__":
    unittest.main()
