"""The pinned ccxt-mcp 0.1.3 behind the session, with no network.

Run inside a network namespace with loopback up, pointing at an installed pinned server:

    FUNDKIT_REAL_CCXT_MCP=<APP_DIR>/node_modules/ccxt-mcp/js/server.js unshare -rn \\
      sh -c 'ip link set lo up && python3 -I -m unittest discover -s tests -t . -p test_real_ccxt_mcp.py'

tests/real_ccxt_recorder.mjs replaces ccxt's transport with a recorder, so nothing is sent.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import time
import unittest
from pathlib import Path

from tests.native_support import T3Host, t3_secret_file
from tests.support import (
    DOPPLER_CONFIG,
    NODE,
    PASSPHRASES,
    ROOT,
    TOKEN,
    SessionTestCase,
    key_check,
    sha256,
    wait_for,
    withdraw_args,
)
from tests.test_native import NOTICE

REAL_SERVER = os.environ.get("FUNDKIT_REAL_CCXT_MCP")
RECORDER = ROOT / "tests" / "real_ccxt_recorder.mjs"
UIDS = {"okx": "UID-REAL-OKX", "bybit": "UID-REAL-BYBIT"}
# The real T3 thread: 10 USDT from Bybit (fee 0.15 on top) to Binance on BSC.
TEN_TO_BINANCE = {"from": "bybit", "to": "binance", "amount": "10", "network": "BSC"}
# The recorder's Bybit coin list (tests/real_ccxt_recorder.mjs), for tests that override one field.
BYBIT_COIN_INFO = {
    "retCode": 0,
    "retMsg": "OK",
    "result": {
        "rows": [
            {
                "name": "USDT",
                "coin": "USDT",
                "remainAmount": "1000000",
                "chains": [
                    {
                        "chainType": "BSC (BEP20)",
                        "confirmation": "15",
                        "withdrawFee": "0.15",
                        "depositMin": "1",
                        "withdrawMin": "10",
                        "chain": "BSC",
                        "chainDeposit": "1",
                        "chainWithdraw": "1",
                        "minAccuracy": "4",
                        "withdrawPercentageFee": "0",
                        "contractAddress": "0x55d398326f99059ff775485246999027b3197955",
                    }
                ],
            }
        ]
    },
}


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


def canonical(value) -> str:
    """lib/plans.mjs canonicalJson, for ASCII-only plans."""
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(key)}:{canonical(value[key])}" for key in sorted(value)) + "}"
    return json.dumps(value)


def digest(value) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


@unittest.skipUnless(REAL_SERVER, "set FUNDKIT_REAL_CCXT_MCP=<APP_DIR>/node_modules/ccxt-mcp/js/server.js")
class RealPlanFormTests(RealCcxtMcpTests):
    """The plan card against the real server's own form, on a T3-shaped host; nothing leaves."""

    test_real_server_end_to_end = None

    def register_plan(self, plan_id: str, recipient: str, amount: int = 25) -> dict:
        alias = f"bybit-{plan_id.lower()}"
        args = {
            "account": alias,
            "code": "USDT",
            "amount": amount,
            "address": recipient,
            "network": "BEP20",
            "params": {"accountType": "FUND"},
        }
        expires = int(time.time() * 1000) + 600_000
        body = {
            "planId": plan_id,
            "version": 1,
            "createdAt": "2026-11-26T00:00:00.000Z",
            "expiresAt": "2026-11-26T00:10:00.000Z",
            "expiresAtMs": expires,
            "from": "bybit",
            "to": "binance",
            "coin": "USDT",
            "network": {
                "code": "BEP20",
                "label": "BNB Smart Chain (BEP20)",
                "chainId": 56,
                "contract": "0x55d398326f99059fF775485246999027B3197955",
                "venueId": "BSC",
                "sourceId": "BSC",
                "destinationId": "BSC",
            },
            "amount": str(amount),
            "fee": {"value": "0.3", "asset": "USDT", "model": "on top", "fields": "test"},
            "debit": {"min": "25.3", "max": "25.3"},
            "credit": {"min": str(amount), "max": str(amount)},
            "sourceWallet": {"wallet": "funding", "available": "100"},
            "recipient": {
                "address": recipient,
                "memo": None,
                "readFrom": "binance-dst",
                "reads": [],
                "lands": "Spot",
                "readAt": "2026-11-26T00:00:00Z",
            },
            "destination": {
                "depositMin": "1",
                "depositFee": {"value": "0", "source": "test"},
                "inboundCap": None,
            },
            "sourceKey": {},
            "args": args,
            "argsHash": digest(args),
            "cap": amount,
            "readsFrom": {"source": "bybit-src", "destination": "binance-dst"},
            "exchangeMayReject": "test",
            "onward": "test",
        }
        plan = {**body, "hash": digest(body)}
        plans = self.home / ".local" / "state" / "fundkit" / "plans"
        plans.mkdir(parents=True, exist_ok=True)
        (plans / f"{plan_id}.json").write_text(json.dumps(plan))
        with socket.socket(socket.AF_UNIX) as control:
            control.connect(str(self.run_dir / "session.sock"))
            stream = control.makefile("rw")
            stream.write(json.dumps({"t": "hello", "id": 1, "host": "test"}) + "\n")
            stream.write(
                json.dumps(
                    {
                        "t": "plan-register",
                        "id": 2,
                        "plan": {
                            "planId": plan_id,
                            "exchange": "bybit",
                            "argsHash": plan["argsHash"],
                            "cap": amount,
                            "expiresAt": expires,
                        },
                    }
                )
                + "\n"
            )
            stream.flush()
            replies = [json.loads(stream.readline()) for _ in range(2)]
        self.assertEqual(replies[1]["t"], "plan-registered", replies)
        return plan

    def unlock_from_card(self) -> None:
        path = t3_secret_file(self.tmp, TOKEN)
        result = subprocess.run(
            [NODE, str(ROOT / "bin" / "fundkit.mjs"), "unlock", "--token-file", str(path)],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        self.assertIn('"ok":true', result.stdout, result.stdout + result.stderr)
        self.addCleanup(lambda: self.run_cli("stop"))

    def posts(self) -> list[dict]:
        return [request for request in self.wire() if request["method"] != "GET"]

    def test_real_form_is_matched_and_shown_once_and_nothing_leaves(self):
        self.unlock_from_card()

        recipient = "0x1b6C0d8D0aF0A3a0b6F6e4E5bC6a7F2d3C4e5F60"
        for decision, plan_id in (("decline", "FK-AAAAAAAA"), ("approve", "FK-BBBBBBBB")):
            with self.subTest(decision=decision):
                self.register_plan(plan_id, recipient)
                host = T3Host(self.host_env, decisions=[decision])
                self.hosts.append(host)
                body, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id}, timeout=120)
                # The real server's form matched the plan and became exactly one card.
                self.assertEqual(host.auto_cancelled, [])
                self.assertEqual(len(host.cards), 1, body)
                self.assertIn(plan_id, host.cards[0]["message"])
                self.assertIn(recipient, host.cards[0]["message"])
                posts = [request for request in self.wire() if request["method"] != "GET"]
                if decision == "decline":
                    self.assertEqual((body["status"], body["reason"]), ("not-sent", "CONFIRM_DECLINED"))
                    self.assertEqual(posts, [])
                else:
                    # Approved: the real server passed its gate and built the withdrawal; the recorder
                    # refused it, so nothing left this machine.
                    self.assertEqual(
                        [(p["id"], p["method"], p["path"]) for p in posts],
                        [("bybit", "POST", "/v5/asset/withdraw/create")],
                    )
                    # The recorder fails the request like a network error after dispatch: the real
                    # server reports UNKNOWN_OUTCOME, and the plan can never be sent again.
                    self.assertEqual((body["status"], body["reason"]), ("unknown", "UNKNOWN_OUTCOME"), body)
                    again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                    self.assertTrue(again["duplicate"])
                    self.assertEqual(len([p for p in self.wire() if p["method"] != "GET"]), 1)
                host.close()
        self.assert_no_files_with_secrets()

    def test_real_binance_address_reads_parse_and_send_only_gets(self):
        self.unlock_from_card()
        host = T3Host(self.host_env)
        self.hosts.append(host)
        body, is_error, _ = host.tool_full(
            "fundkit_deposit_address", {"exchange": "binance", "network": "BSC"}, timeout=120
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["address"], "0x1b6C0d8D0aF0A3a0b6F6e4E5bC6a7F2d3C4e5F60")
        self.assertEqual((body["network"]["code"], body["network"]["venueId"]), ("BEP20", "BSC"))
        self.assertEqual(body["memo"]["value"], None)
        self.assertTrue(body["qr"]["verified"])
        wire = self.wire()
        self.assertEqual({request["method"] for request in wire}, {"GET"})
        signed = {request["path"] for request in wire if request["signed"]}
        for expected in (
            "/sapi/v1/account/apiRestrictions",
            "/sapi/v1/capital/config/getall",
            "/sapi/v1/capital/deposit/address",
            "/sapi/v1/capital/deposit/address/list",
        ):
            self.assertIn(expected, signed)
        key = sha256(DOPPLER_CONFIG["BINANCE_APIKEY"])
        self.assertTrue(all(request["keyHash"] == key for request in wire if request["signed"]))
        self.assert_no_files_with_secrets()

    # ------------------------------------------------------------ Binance's unknown deposit minimum

    def getall_reads(self) -> int:
        return len(
            [r for r in self.wire() if r["id"] == "binance" and r["path"] == "/sapi/v1/capital/config/getall"]
        )

    def test_real_bybit_ten_plus_fee_to_binance_reaches_the_card_and_cancel_sends_nothing(self):
        self.unlock_from_card()
        host = T3Host(self.host_env, decisions=["cancel"])
        self.hosts.append(host)
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", TEN_TO_BINANCE, timeout=180)
        self.assertFalse(is_error, body)
        self.assertEqual(body["status"], "ready", body)
        plan = body["plan"]
        self.assertEqual(plan["fee"], "0.15 USDT (on top)")
        self.assertEqual((plan["amount"], plan["debit"], plan["credit"]), ("10 USDT", "10.15", "10"))
        self.assertEqual(plan["available"], "812.44 USDT in funding")
        self.assertEqual(plan["recipient"], "0x1b6C0d8D0aF0A3a0b6F6e4E5bC6a7F2d3C4e5F60")
        self.assertEqual(plan["destinationMinimum"], "unknown")
        self.assertEqual((body["minimumNotice"], plan["destinationMinimumBasis"]), (NOTICE, NOTICE))
        self.assertIn(NOTICE, body["next"]["how"])
        self.assertEqual((host.cards, self.posts()), ([], []), "the notice comes before any card or write")
        reads = self.getall_reads()

        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]}, timeout=180)
        self.assertEqual((result["status"], result["sent"]), ("not-sent", False), result)
        self.assertEqual(host.auto_cancelled, [])
        self.assertEqual(len(host.cards), 1)
        card = host.cards[0]["message"]
        self.assertIn(body["planId"], card)
        self.assertIn(f"\n{NOTICE}\n", card)
        self.assertGreater(self.getall_reads(), reads, "Binance is read again before the card")
        self.assertEqual(self.posts(), [], "zero withdrawal writes")
        again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertTrue(again["duplicate"])
        self.assertEqual(self.posts(), [])
        self.assert_no_files_with_secrets()

    def test_real_sub_one_plan_reaches_one_card_with_the_notice_and_cancel_sends_nothing(self):
        self.unlock_from_card()
        # Bybit's real-thread row with a withdrawal minimum below 1, so 0.5 USDT clears the source.
        bybit = json.loads(json.dumps(BYBIT_COIN_INFO))
        bybit["result"]["rows"][0]["chains"][0]["withdrawMin"] = "0.0001"
        (self.home / "recorder-overrides.json").write_text(json.dumps({"/v5/asset/coin/query-info": bybit}))
        seen = []

        def at_card(params):
            seen.append((params["message"], len(self.posts())))
            return "cancel"

        host = T3Host(self.host_env, decisions=[at_card])
        self.hosts.append(host)
        body, is_error, _ = host.tool_full(
            "fundkit_transfer_prepare", {**TEN_TO_BINANCE, "amount": "0.5"}, timeout=180
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["status"], "ready", body)
        self.assertEqual((body["plan"]["credit"], body["minimumNotice"]), ("0.5", NOTICE))
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]}, timeout=180)
        self.assertEqual((result["status"], result["sent"]), ("not-sent", False), result)
        self.assertEqual(len(seen), 1)
        message, posts_at_card = seen[0]
        self.assertIn(NOTICE, message)
        self.assertIn("Amount (withdrawal amount): 0.5 USDT", message)
        self.assertEqual(posts_at_card, 0)
        self.assertEqual(self.posts(), [], "zero withdrawal writes")
        self.assert_no_files_with_secrets()

    def test_real_usdc_request_is_refused_with_zero_reads_and_writes(self):
        self.unlock_from_card()
        host = T3Host(self.host_env, decisions=["approve"])
        self.hosts.append(host)
        for name, args in (
            ("fundkit_transfer_prepare", {**TEN_TO_BINANCE, "coin": "USDC"}),
            ("fundkit_deposit_address", {"exchange": "binance", "network": "BSC", "coin": "USDC"}),
        ):
            with self.subTest(name=name):
                body, is_error, _ = host.tool_full(name, args, timeout=120)
                self.assertTrue(is_error, body)
                self.assertEqual(body["error"], "UNSUPPORTED_COIN", body)
        # No profile was started, so the real server built no request at all.
        self.assertEqual(recorder_pids(), [])
        self.assertEqual(self.wire(), [])
        self.assertEqual((host.forms, host.cards), ([], []))
        # The same session still serves the USDT request, which asks the venues for USDT only.
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", TEN_TO_BINANCE, timeout=180)
        self.assertFalse(is_error, body)
        self.assertEqual(body["status"], "ready", body)
        coins = {request["coin"] for request in self.wire() if request["coin"]}
        self.assertEqual(coins, {"USDT"}, self.wire())
        self.assertEqual(self.posts(), [], "zero withdrawal writes")
        self.assert_no_files_with_secrets()

    def test_real_minimum_known_after_the_approval_sends_nothing(self):
        self.unlock_from_card()
        row = {
            "network": "BSC",
            "coin": "USDT",
            "name": "BNB Smart Chain (BEP20)",
            "contractAddress": "0x55d398326f99059ff775485246999027b3197955",
            "depositEnable": True,
            "withdrawEnable": True,
            "withdrawFee": "0.29",
            "withdrawMin": "10",
            "withdrawMax": "9999999",
            "withdrawIntegerMultiple": "0.00000001",
            "isDefault": False,
            "depositMin": "20",
        }
        overrides = {
            "/sapi/v1/capital/config/getall": [{"coin": "USDT", "name": "TetherUS", "networkList": [row]}]
        }

        def minimum_appears_then_approve(_params):
            (self.home / "recorder-overrides.json").write_text(json.dumps(overrides))
            return "approve"

        host = T3Host(self.host_env, decisions=[minimum_appears_then_approve])
        self.hosts.append(host)
        body, _, _ = host.tool_full("fundkit_transfer_prepare", TEN_TO_BINANCE, timeout=180)
        self.assertEqual(body["status"], "ready", body)
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]}, timeout=180)
        self.assertEqual(
            (result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED"), result
        )
        self.assertIn("20 USDT (venue)", result["detail"])
        self.assertEqual(len(host.cards), 1)
        self.assertEqual(self.posts(), [], "zero withdrawal writes")
        self.assert_no_files_with_secrets()


if __name__ == "__main__":
    unittest.main()
