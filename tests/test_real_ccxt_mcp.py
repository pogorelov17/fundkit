"""The pinned ccxt-mcp 0.1.3 behind the session, with no network.

Run inside a network namespace with loopback up, pointing at an installed pinned server:

    FUNDKIT_REAL_CCXT_MCP=<APP_DIR>/node_modules/ccxt-mcp/js/server.js unshare -rn \\
      sh -c 'ip link set lo up && python3 -I -m unittest discover -s tests -t . -p test_real_ccxt_mcp.py'

tests/real_ccxt_recorder.mjs replaces ccxt's transport with a recorder, so nothing is sent.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.support import (
    DOPPLER_CONFIG,
    PASSPHRASES,
    ROOT,
    TOKEN,
    SessionTestCase,
    key_check,
    sha256,
    wait_for,
    withdraw_args,
)

REAL_SERVER = os.environ.get("FUNDKIT_REAL_CCXT_MCP")
RECORDER = ROOT / "tests" / "real_ccxt_recorder.mjs"
UIDS = {"okx": "UID-REAL-OKX", "bybit": "UID-REAL-BYBIT"}


def recorder_pids() -> list[int]:
    pids = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if str(RECORDER).encode() in argv:
            pids.append(int(entry.name))
    return pids


def read_environ(pid: int) -> dict[str, str]:
    raw = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    return dict(item.decode().split("=", 1) for item in raw if b"=" in item)


@unittest.skipUnless(REAL_SERVER, "set FUNDKIT_REAL_CCXT_MCP=<APP_DIR>/node_modules/ccxt-mcp/js/server.js")
class RealCcxtMcpTests(SessionTestCase):
    def setUp(self):
        super().setUp()
        app = Path(REAL_SERVER).parents[3]
        paths = {
            "ccxtEntry": str(app / "node_modules" / "ccxt" / "js" / "ccxt.js"),
            "serverEntry": REAL_SERVER,
        }
        (self.home / "real-ccxt-paths.json").write_text(json.dumps(paths))
        self.env["FUNDKIT_CCXT_MCP"] = str(RECORDER)
        self.env["XDG_CACHE_HOME"] = str(self.home / ".cache")

    def wire(self) -> list[dict]:
        path = self.home / "wire.jsonl"
        if not path.exists():
            return []
        with path.open() as stream:
            return [json.loads(line) for line in stream]

    def assert_each_process_has_only_its_own_credentials(self):
        pids = recorder_pids()
        self.assertEqual(len(pids), 2)
        for pid in pids:
            environ = read_environ(pid)
            exchange = "OKX" if "OKX_APIKEY" in environ else "BYBIT"
            expected = {"PATH", "HOME", "LANG", "XDG_CACHE_HOME", "CCXT_MCP_CONFIG"}
            expected |= {f"{exchange}_APIKEY", f"{exchange}_SECRET"}
            if exchange == "OKX":
                expected.add("OKX_PASSWORD")
            self.assertEqual(set(environ), expected)
            self.assertNotIn(TOKEN, "".join(environ.values()))
            self.assertNotIn("HOST-ENV-OKX", "".join(environ.values()))
            self.assertEqual(environ[f"{exchange}_APIKEY"], DOPPLER_CONFIG[f"{exchange}_APIKEY"])
            if exchange == "OKX":
                self.assertEqual(environ["OKX_PASSWORD"], PASSPHRASES["okx"])

    def assert_step_zero(self, host):
        arguments = {"alias": "okx-src", "tool": "get_safety_status", "arguments": {}}
        status, is_error = host.tool("fundkit_read", arguments)
        self.assertFalse(is_error, status)
        status = status["data"]
        self.assertEqual((status["version"], status["ccxtVersion"]), ("0.1.3", "4.5.84"))
        self.assertEqual(status["configProblems"], [])
        self.assertTrue(status["elicitationSupported"])
        self.assertTrue(status["configPath"].endswith("/profiles/okx-src/config.json"))
        arguments = {"alias": "bybit-dst", "tool": "list_accounts", "arguments": {}}
        accounts, is_error = host.tool("fundkit_read", arguments)
        self.assertFalse(is_error, accounts)

    def assert_key_checks_sign_with_own_keys_and_keep_no_uid(self, host):
        host.tool("fundkit_read", key_check("bybit", "bybit-dst"), timeout=120)
        host.tool("fundkit_read", key_check("okx", "okx-src"), timeout=120)
        signed = [request for request in self.wire() if request["signed"]]
        keys = {"bybit": sha256(DOPPLER_CONFIG["BYBIT_APIKEY"]), "okx": sha256(DOPPLER_CONFIG["OKX_APIKEY"])}
        self.assertEqual({request["id"] for request in signed}, {"bybit", "okx"}, signed)
        self.assertTrue(all(request["keyHash"] == keys[request["id"]] for request in signed), signed)
        # The real results name a UID among the key metadata; the session keeps only "checked".
        status = self.run_cli("status").stdout
        checked = {profile["alias"]: profile["keyChecked"] for profile in json.loads(status)["profiles"]}
        self.assertEqual(checked, {"okx-src": True, "bybit-dst": True})
        for uid in UIDS.values():
            self.assertNotIn(uid, status)

    def assert_money_moves_need_the_form_and_stay_dry(self, host):
        write = {"alias": "okx-src", "tool": "withdraw", "arguments": withdraw_args("okx-src", 5)}
        host.form_answer = "decline"
        body, _ = host.tool("fundkit_write", write, timeout=120)
        self.assertEqual(len(host.forms), 1, body)
        self.assertIn("CONFIRM_DECLINED", json.dumps(body))
        host.form_answer = "accept"
        body, _ = host.tool("fundkit_write", write, timeout=120)
        self.assertEqual(len(host.forms), 2, body)
        self.assertIn("dryRun", json.dumps(body))
        self.assertFalse([request for request in self.wire() if request["method"] != "GET"])
        body, _ = host.tool(
            "fundkit_write", dict(write, arguments=withdraw_args("okx-src", 300)), timeout=120
        )
        self.assertIn("TRANSFER_VALUE_CAP", json.dumps(body))  # cap 10 without --writes; no form
        self.assertEqual(len(host.forms), 2)
        denied = dict(write, alias="bybit-dst", arguments=withdraw_args("bybit-dst", 5))
        body, _ = host.tool("fundkit_write", denied)
        self.assertEqual(body["error"], "ROLE_DENIED")

    def test_real_server_end_to_end(self):
        terminal = self.session("--passphrase", "okx", passphrases={"okx": PASSPHRASES["okx"]})
        host = self.host()
        for exchange, role in [("okx", "source"), ("bybit", "deposit-only")]:
            body, is_error = host.tool("fundkit_connect", {"exchange": exchange, "role": role})
            self.assertFalse(is_error, body)
            self.assertEqual(body["server"]["name"], "ccxt-mcp")

        self.assert_each_process_has_only_its_own_credentials()
        self.assert_step_zero(host)
        self.assert_key_checks_sign_with_own_keys_and_keep_no_uid(host)
        self.assert_money_moves_need_the_form_and_stay_dry(host)

        self.assert_no_leaks(host.all_text(), terminal.text)
        self.assert_no_files_with_secrets()
        host.close()
        self.assertEqual(terminal.wait(), 0)
        wait_for(lambda: not recorder_pids(), what="real servers to stop")


if __name__ == "__main__":
    unittest.main()
