"""Focused safety checks; these tests never invoke Docker or the CLI."""

import copy
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

from scripts import supabase_local as local


class LocalSupabaseSafetyTests(unittest.TestCase):
    def test_approved_config_passes(self):
        local.check_config()

    def test_changed_project_and_linked_remote_are_rejected(self):
        config = (local.ROOT / "supabase/config.toml").read_text(encoding="utf-8")
        changed = config.replace('project_id = "simpress-dev"', 'project_id = "other"')
        with patch.object(Path, "open", return_value=io.BytesIO(changed.encode("utf-8"))):
            with self.assertRaisesRegex(RuntimeError, "Configuration"):
                local.check_config()
        with patch.object(Path, "open", return_value=io.BytesIO(config.encode("utf-8"))), patch.object(Path, "exists", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "linked remote"):
                local.check_config()

    def container(self):
        return {
            "Config": {"Labels": {
                "com.supabase.cli.project": local.PROJECT,
                "com.supabase.cli.workdir": str(local.ROOT),
            }},
            "NetworkSettings": {
                "Networks": {local.NETWORK: {}},
                "Ports": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "54322"}]},
            },
        }

    def test_loopback_bindings_pass(self):
        with patch.object(local, "containers", return_value=[self.container()]):
            local.check_bindings("unused")

    def test_non_loopback_bindings_are_rejected(self):
        for address in ("0.0.0.0", "::", "192.0.2.1", ""):
            with self.subTest(address=address):
                container = self.container()
                container["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostIp"] = address
                with patch.object(local, "containers", return_value=[container]):
                    with self.assertRaisesRegex(RuntimeError, "Non-loopback"):
                        local.check_bindings("unused")

    def test_wrong_project_workdir_or_network_is_rejected(self):
        variants = []
        item = self.container()
        item["Config"]["Labels"]["com.supabase.cli.project"] = "other"
        variants.append(item)
        item = self.container()
        item["Config"]["Labels"]["com.supabase.cli.workdir"] = str(local.ROOT.parent)
        variants.append(item)
        item = self.container()
        item["NetworkSettings"]["Networks"] = {"other": {}}
        variants.append(item)
        for variant in variants:
            with self.subTest(variant=variant):
                with patch.object(local, "containers", return_value=[variant]):
                    with self.assertRaises(RuntimeError):
                        local.check_bindings("unused")

    def test_existing_network_must_have_expected_owner_and_loopback_option(self):
        valid = {"Options": {"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"},
                 "Labels": {"com.simpress.purpose": "disposable-development"}}
        with patch.object(local, "run", side_effect=[local.NETWORK, json.dumps([valid])]):
            local.check_network("unused")
        wrong = copy.deepcopy(valid)
        wrong["Options"]["com.docker.network.bridge.host_binding_ipv4"] = "0.0.0.0"
        with patch.object(local, "run", side_effect=[local.NETWORK, json.dumps([wrong])]):
            with self.assertRaises(RuntimeError):
                local.check_network("unused")

    def test_resume_receipt_must_match_volume_identity(self):
        volume = [{"name": "synthetic-volume", "created_at": "synthetic-time"}]
        receipt = {"project": local.PROJECT, "root": str(local.ROOT), "volumes": volume}
        with patch.object(Path, "read_text", return_value=json.dumps(receipt)):
            with patch.object(local, "volume_identity", return_value=volume):
                local.check_receipt("unused")
            with patch.object(local, "volume_identity", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "identities changed"):
                    local.check_receipt("unused")

    def test_error_output_redacts_sensitive_lines(self):
        private_line = "postgres" + "ql://placeholder:placeholder@127.0.0.1/database"
        result = subprocess.CompletedProcess(["unused"], 1, stdout="", stderr="safe error\n" + private_line)
        with patch.object(local.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as captured:
                local.run(["unused"])
        self.assertIn("safe error", str(captured.exception))
        self.assertIn("[redacted]", str(captured.exception))
        self.assertNotIn(private_line, str(captured.exception))

    def test_stop_is_project_scoped_and_preserves_volumes(self):
        with patch.object(local, "run", return_value="") as run, redirect_stdout(io.StringIO()):
            local.stop(["cli"])
        self.assertEqual(run.call_args.args[0], ["cli", "stop", "--project-id", "simpress-dev"])


if __name__ == "__main__":
    unittest.main()
