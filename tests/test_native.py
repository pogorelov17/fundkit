"""Native flows on a T3-shaped host: one secret card, verified address with QR, bound transfers.

All offline: mock Doppler on loopback, the synthetic ccxt-mcp with venue fixtures, the T3
emulation in tests/native_support.py. No real key, token, exchange or money.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

from tests.native_support import (
    BINANCE_BSC,
    BINANCE_TON,
    BINANCE_TON_MEMO,
    BINANCE_TRX,
    BYBIT_BSC,
    USDT_BSC,
    T3Host,
    binance_fixtures,
    bybit_fixtures,
    decode_qr,
    params_key,
    run_then,
    set_binance_address,
    t3_acceptance,
    t3_secret_file,
)
from tests.support import FUNDKIT, NODE, OTHER_TOKEN, PASSPHRASES, TOKEN, SessionTestCase, wait_for

ADDRESS_REQUEST = {"exchange": "Binance", "network": "BSC", "coin": "USDT"}


class NativeTestCase(SessionTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.fixtures = {"binance": binance_fixtures(), "bybit": bybit_fixtures()}
        self.write_fixtures()
        self.addCleanup(self.stop_session)

    def write_fixtures(self) -> None:
        (self.home / "fake-ccxt-fixtures.json").write_text(json.dumps(self.fixtures))

    def stop_session(self) -> None:
        subprocess.run(
            [NODE, str(FUNDKIT), "stop"], env=self.host_env, capture_output=True, timeout=15, check=False
        )
        wait_for(lambda: not self.daemon_pids(), timeout=10, what="daemon exit")

    def daemon_pids(self) -> list[int]:
        pids = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                argv = (entry / "cmdline").read_bytes().split(b"\0")
                environ = (entry / "environ").read_bytes()
            except OSError:
                continue
            ours = str(FUNDKIT).encode() in argv and f"HOME={self.home}".encode() in environ
            if ours and b"daemon" in argv and self.alive(int(entry.name)):
                pids.append(int(entry.name))
        return pids

    def card(self, value: str = TOKEN) -> Path:
        return t3_secret_file(self.tmp, value)

    def unlock(self, path: Path, *extra: str) -> dict:
        result = subprocess.run(
            [NODE, str(FUNDKIT), "unlock", "--token-file", str(path), *extra],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        self.outputs.append(result.stdout + result.stderr)
        body = json.loads(result.stdout.strip().splitlines()[-1])
        body["_status"] = result.returncode
        return body

    def start_session(self) -> None:
        body = self.unlock(self.card())
        self.assertTrue(body["ok"], body)

    def t3(self, decisions=None, elicitation: bool = True, **env) -> T3Host:
        host = T3Host({**self.host_env, **env}, decisions=decisions, elicitation=elicitation)
        self.hosts.append(host)
        return host

    @property
    def outputs(self) -> list[str]:
        if not hasattr(self, "_outputs"):
            self._outputs = []
        return self._outputs

    def assert_secret_free(self, *texts: str) -> None:
        self.assert_no_leaks(*texts, *self.outputs, *(host.all_text() for host in self.hosts))
        self.assert_no_files_with_secrets()
        for pid in self.daemon_pids():
            self.assertNotIn(TOKEN.encode(), Path(f"/proc/{pid}/cmdline").read_bytes())
            self.assert_environ_free_of_secrets(pid)

    def dispatches(self) -> list[dict]:
        return self.events("dispatch")


# =========================================================================== handoff
class HandoffTests(NativeTestCase):
    def test_card_file_is_consumed_once_and_starts_a_background_session(self):
        path = self.card()
        body = self.unlock(path)
        self.assertEqual((body["ok"], body["session"]), (True, "active"), body)
        self.assertEqual(body["doppler"], {"project": "fundkit-test", "config": "prd"})
        self.assertFalse(path.exists(), "the delivered file must be deleted after reading")
        self.assertEqual(len(self.daemon_pids()), 1)
        # Only the token check reached Doppler; no exchange secret was fetched yet.
        self.assertEqual(self.doppler.secret_requests(), [])

        again = self.unlock(path)
        self.assertEqual((again["ok"], again["error"]), (False, "FILE_MISSING"))

        status = json.loads(self.run_cli("status").stdout)
        self.assertEqual(status["state"], "active")
        self.assert_secret_free()

    def test_session_outlives_host_restarts_and_a_second_card_is_not_needed(self):
        self.start_session()
        first = self.t3()
        body, _, _ = first.tool_full("fundkit_profiles", {})
        self.assertEqual(body["session"], "active")
        first.close()
        time.sleep(0.3)
        second = self.t3()
        body, _, _ = second.tool_full("fundkit_profiles", {})
        self.assertEqual(body["session"], "active")

        path = self.card(OTHER_TOKEN)
        already = self.unlock(path)
        self.assertTrue(already["already"])
        self.assertFalse(path.exists())
        self.assertEqual(len(self.daemon_pids()), 1)
        self.assert_secret_free()

    def test_unsafe_or_wrong_files_are_refused_and_nothing_is_sent(self):
        target = self.card()
        link = target.parent / ("b" * 32)
        link.symlink_to(target)
        self.assertEqual(self.unlock(link)["error"], "FILE_UNSAFE")
        self.assertTrue(target.exists())

        target.chmod(0o640)
        self.assertEqual(self.unlock(target)["error"], "FILE_UNSAFE")
        target.chmod(0o600)

        fifo = target.parent / ("c" * 32)
        os.mkfifo(fifo, 0o600)
        self.assertEqual(self.unlock(fifo)["error"], "FILE_UNSAFE")

        big = self.card("dp.st.x." + "A" * 5000)
        self.assertEqual(self.unlock(big)["error"], "FILE_UNSAFE")

        open_dir = self.tmp / "world"
        open_dir.mkdir()
        open_dir.chmod(0o777)
        exposed = open_dir / "token"
        exposed.write_text(TOKEN)
        exposed.chmod(0o600)
        self.assertEqual(self.unlock(exposed)["error"], "FILE_UNSAFE")
        exposed.unlink()  # the test's own copy; fundkit refused to touch it
        target.unlink()

        relative = self.unlock(Path("relative/token"))
        self.assertEqual(relative["error"], "FILE_PATH")

        not_a_token = self.card("hello, this is not a token")
        body = self.unlock(not_a_token)
        self.assertEqual(body["error"], "TOKEN_FORMAT")
        self.assertFalse(not_a_token.exists(), "a consumed file is deleted even when the value is refused")

        self.assertEqual(self.doppler.requests, [])
        self.assertEqual(self.daemon_pids(), [])
        self.assert_secret_free()

    def test_rejected_token_starts_nothing(self):
        self.doppler.valid_tokens = set()
        path = self.card()
        body = self.unlock(path)
        self.assertEqual((body["ok"], body["error"], body["_status"]), (False, "TOKEN_REJECTED", 3))
        self.assertFalse(path.exists())
        wait_for(lambda: not self.daemon_pids(), what="no daemon")
        self.assertFalse((self.run_dir / "session.sock").exists())
        self.assert_secret_free()

    def test_passphrase_card_reaches_only_the_session(self):
        self.start_session()
        host = self.t3()
        body, is_error, _ = host.tool_full("fundkit_connect", {"exchange": "okx", "role": "deposit-only"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "PASSPHRASE_NEEDED")
        step = body["secretStep"]
        self.assertEqual(step["request"]["delivery"], "file")
        self.assertEqual(step["request"]["label"], "OKX API passphrase")

        path = self.card(PASSPHRASES["okx"])
        stored = run_then(step, path, self.env)
        self.assertTrue(stored["ok"], stored)
        self.assertFalse(path.exists())
        body, is_error, _ = host.tool_full("fundkit_connect", {"exchange": "okx", "role": "deposit-only"})
        self.assertFalse(is_error, body)
        start = self.starts()["okx-dst"]
        self.assertIn("OKX_PASSWORD", start["envNames"])
        self.assert_secret_free()


# =========================================================================== address
class AddressTests(NativeTestCase):
    def assert_verified_qr(self, body: dict, result: dict, address: str) -> None:
        qr = body["qr"]
        path = Path(qr["path"])
        data = path.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), qr["sha256"])
        self.assertEqual(path.name, f"{qr['sha256']}.png")
        self.assertEqual(qr["payload"], address)
        self.assertEqual(decode_qr(path), address.encode())  # independent reader and decoder
        images = [item for item in result["content"] if item["type"] == "image"]
        self.assertEqual(len(images), 1)
        self.assertEqual(base64.b64decode(images[0]["data"]), data)
        self.assertEqual(qr["markdown"], f"![QR Binance USDT {body['network']['code']}]({path})")

    def test_no_session_one_card_then_the_same_request_continues(self):
        host = self.t3()
        body, is_error, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "NO_SESSION")
        step = body["secretStep"]
        self.assertEqual(step["hostTool"], "request_secret")
        self.assertEqual(step["request"]["delivery"], "file")
        self.assertEqual(step["request"]["label"], "Doppler service token")
        self.assertEqual(
            body["resume"],
            {
                "tool": "fundkit_deposit_address",
                "arguments": {"exchange": "binance", "coin": "USDT", "network": "BSC"},
            },
        )
        self.assertNotIn("готово", json.dumps(body["secretStep"], ensure_ascii=False))
        self.assertTrue(body["userStep"].startswith("Only on a host without"))

        path = self.card()
        unlocked = run_then(step, path, self.env)
        self.assertTrue(unlocked["ok"], unlocked)
        self.assertFalse(path.exists())

        body, is_error, result = host.tool_full(body["resume"]["tool"], body["resume"]["arguments"])
        self.assertFalse(is_error, body)
        self.assertEqual(body["status"], "verified")
        self.assertEqual(body["address"], BINANCE_BSC)
        self.assertEqual(body["network"]["code"], "BEP20")
        self.assertEqual(body["network"]["venueId"], "BSC")
        self.assertEqual(body["network"]["chainId"], 56)
        self.assertEqual(body["network"]["contract"], USDT_BSC)
        self.assertEqual(body["memo"], {"required": False, "value": None})
        self.assert_verified_qr(body, result, BINANCE_BSC)
        self.assertEqual(self.doppler.secret_requests(), [["BINANCE_APIKEY", "BINANCE_SECRET"]])
        self.assertEqual(host.cards, [])  # reads open no confirmation
        self.assertEqual(self.dispatches(), [])
        self.assert_secret_free()

    def test_memo_with_leading_zeros_is_kept_and_flagged(self):
        self.start_session()
        body, is_error, result = self.t3().tool_full(
            "fundkit_deposit_address", {"exchange": "binance", "network": "TON"}
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["memo"]["value"], BINANCE_TON_MEMO)
        self.assertTrue(body["memo"]["required"])
        self.assertIn("QR carries only the address", body["memo"]["warning"])
        self.assertEqual(body["qr"]["carries"], "the address only")
        self.assert_verified_qr(body, result, BINANCE_TON)

    def test_same_address_same_png_and_concurrent_requests_do_not_mix(self):
        self.start_session()
        host = self.t3()
        results = host.call_many(
            [
                ("fundkit_deposit_address", {"exchange": "binance", "network": "BEP20"}),
                ("fundkit_deposit_address", {"exchange": "binance", "network": "TRC20"}),
                ("fundkit_deposit_address", {"exchange": "binance", "network": "TON"}),
            ]
        )
        seen = {}
        for body, is_error, _ in results:
            self.assertFalse(is_error, body)
            self.assertEqual(decode_qr(Path(body["qr"]["path"])), body["address"].encode())
            seen[body["network"]["code"]] = body["address"]
        self.assertEqual(seen, {"BEP20": BINANCE_BSC, "TRC20": BINANCE_TRX, "TON": BINANCE_TON})
        starts = [event for event in self.events("start") if event["alias"] == "binance-dst"]
        self.assertEqual(len(starts), 1, "concurrent calls share one profile process")

        first, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        again, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertEqual(first["qr"]["sha256"], again["qr"]["sha256"])

    def test_failed_reads_show_no_address_and_no_qr(self):
        self.start_session()
        host = self.t3()
        good, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertEqual(good["status"], "verified")
        cases = {
            "WRONG_CHAIN": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC, "", gated_network="ERC20"),
            "AMBIGUOUS_ROWS": lambda f: set_binance_address(
                f,
                "BEP20",
                BINANCE_BSC,
                "",
                extra_rows=[{"coin": "USDT", "address": BYBIT_BSC, "tag": "", "isDefault": 1}],
            ),
            "MEMO_FIELD_MISSING": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC, None),
            "ADDRESS_IS_CONTRACT": lambda f: set_binance_address(f, "BEP20", USDT_BSC, ""),
            "CONTRACT_MISMATCH": lambda f: f[params_key("call_read_method", "fetchDepositWithdrawFee")][
                "info"
            ]["networkList"][0].update(contractAddress="0x0000000000000000000000000000000000000001"),
            "DEPOSIT_DISABLED": lambda f: f[params_key("call_read_method", "fetchDepositWithdrawFee")][
                "info"
            ]["networkList"][0].update(depositEnable=False),
        }
        qr_files_before = set((self.home / ".local/state/fundkit/qr").iterdir())
        for code, mutate in cases.items():
            with self.subTest(code=code):
                self.fixtures["binance"] = binance_fixtures()
                mutate(self.fixtures["binance"])
                self.write_fixtures()
                body, is_error, result = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
                self.assertTrue(is_error)
                self.assertEqual(body["error"], code)
                self.assertIsNone(body["address"])
                self.assertIsNone(body["qr"])
                self.assertEqual([c for c in result["content"] if c["type"] == "image"], [])
        self.assertEqual(set((self.home / ".local/state/fundkit/qr").iterdir()), qr_files_before)

    def test_unsupported_venue_is_reported_without_reads(self):
        body, is_error, _ = self.t3().tool_full(
            "fundkit_deposit_address", {"exchange": "okx", "network": "BSC"}
        )
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "VENUE_NOT_NATIVE")
        self.assertEqual(self.doppler.requests, [])


# =========================================================================== transfers
REVERSE = {"from": "Binance", "to": "Bybit", "amount": "300", "language": "ru"}


class TransferTests(NativeTestCase):
    def prepare(self, host: T3Host, request=None) -> dict:
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", request or REVERSE)
        self.assertFalse(is_error, body)
        return body

    def test_bybit_to_binance_holds_on_the_undocumented_minimum_with_zero_dispatch(self):
        self.start_session()
        host = self.t3(decisions=["approve"])
        body = self.prepare(host, {"from": "Bybit", "to": "Binance", "amount": "300", "network": "BSC"})
        self.assertEqual((body["status"], body["dispatch"]), ("hold", "none"))
        self.assertEqual([r["code"] for r in body["reasons"]], ["DESTINATION_MINIMUM_UNDOCUMENTED"])
        self.assertIn("Do not ask", body["note"])
        self.assertEqual(host.cards, [])
        self.assertEqual(self.dispatches(), [])
        plans = self.home / ".local/state/fundkit/plans"
        self.assertFalse(plans.exists() and any(plans.iterdir()))

    def test_plan_reads_both_ends_and_one_approval_sends_exactly_once(self):
        self.start_session()
        host = self.t3(decisions=["approve"])
        body = self.prepare(host)
        self.assertEqual(body["status"], "ready")
        plan = body["plan"]
        self.assertEqual(plan["recipient"], BYBIT_BSC)
        self.assertEqual(plan["memo"], "none")
        self.assertEqual(plan["amount"], "300 USDT")
        self.assertEqual(plan["fee"], "0.29 USDT (unconfirmed)")
        self.assertEqual(plan["debit"], "300\u2013300.29")
        self.assertEqual(plan["credit"], "299.71\u2013300")
        self.assertEqual(plan["destinationMinimum"], "1")
        plan_id = body["planId"]
        self.assertEqual(self.dispatches(), [])

        result, is_error, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertFalse(is_error, result)
        self.assertEqual(result["status"], "sent")
        self.assertEqual(result["withdrawalId"], "W-1")
        self.assertEqual(len(host.cards), 1)
        card = host.cards[0]["message"]
        for needle in (
            plan_id,
            BYBIT_BSC,
            "0.29",
            "300",
            "BNB Smart Chain",
            body["hash"],
            "Подтвердите перевод",
        ):
            self.assertIn(needle, card)
        self.assertEqual(host.auto_cancelled, [])  # the raw ccxt-mcp form never reached T3

        dispatches = self.dispatches()
        self.assertEqual(len(dispatches), 1)
        stored = json.loads((self.home / f".local/state/fundkit/plans/{plan_id}.json").read_text())
        self.assertEqual(dispatches[0]["args"], stored["args"])
        alias = stored["args"]["account"]
        account = self.starts()[alias]["config"]["accounts"][alias]
        self.assertEqual((account["dryRun"], account["maxTransferValue"]), (False, 300))

        # Duplicate confirmation, a restarted broker and a status read send nothing more.
        again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertTrue(again["duplicate"])
        host.close()
        restarted = self.t3(decisions=["approve"])
        again, _, _ = restarted.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertTrue(again["duplicate"])
        status, _, _ = restarted.tool_full("fundkit_transfer_status", {"planId": plan_id})
        self.assertTrue(status["dispatchAttempted"])
        self.assertEqual(len(self.dispatches()), 1)
        self.assertEqual(restarted.cards, [])
        self.assert_secret_free()

    def test_decline_cancel_and_no_answer_send_nothing(self):
        self.start_session()
        for decision in ("decline", "cancel", None):
            with self.subTest(decision=decision):
                host = self.t3(decisions=[decision], FUNDKIT_FORM_TIMEOUT_MS="1500")
                plan_id = self.prepare(host)["planId"]
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id}, timeout=30)
                self.assertEqual(result["status"], "not-sent", result)
                self.assertFalse(result["sent"])
                self.assertEqual(len(host.cards), 1)
                again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                self.assertTrue(again["duplicate"])
                host.close()
        self.assertEqual(self.dispatches(), [])

    def test_always_allow_for_one_plan_does_not_approve_the_next(self):
        self.start_session()
        host = self.t3(decisions=["session", "decline"])
        first = self.prepare(host)["planId"]
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": first})
        self.assertEqual(result["status"], "sent")
        second = self.prepare(host)["planId"]
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": second})
        self.assertEqual(result["status"], "not-sent")
        self.assertEqual(len(host.cards), 2)
        self.assertEqual(len(self.dispatches()), 1)

    def test_expired_plan_and_changed_fields_need_a_new_plan(self):
        self.start_session()
        host = self.t3(decisions=["approve", "approve"], FUNDKIT_PLAN_TTL_MS="1500")
        expired = self.prepare(host)["planId"]
        time.sleep(2)
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": expired})
        self.assertEqual((result["status"], result["reason"]), ("not-sent", "PLAN_EXPIRED"))
        host.close()

        host = self.t3(decisions=["approve"])
        plan_id = self.prepare(host)["planId"]
        path = self.home / f".local/state/fundkit/plans/{plan_id}.json"
        plan = json.loads(path.read_text())
        plan["args"]["amount"] = 3000
        path.write_text(json.dumps(plan))
        result, is_error, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertEqual((is_error, result["error"]), (True, "PLAN_TAMPERED"))

        # Even with the plan's own hashes recomputed, the session holds the original binding.
        self.rehash(plan)
        path.write_text(json.dumps(plan))
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertEqual((result["status"], result["reason"]), ("not-sent", "PLAN_ARGS_CHANGED"))
        self.assertEqual(host.cards, [])
        self.assertEqual(self.dispatches(), [])

    def test_session_restart_forgets_plans(self):
        self.start_session()
        host = self.t3(decisions=["approve"])
        plan_id = self.prepare(host)["planId"]
        self.stop_session()
        self.start_session()
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertEqual((result["status"], result["reason"]), ("not-sent", "PLAN_NOT_REGISTERED"))
        self.assertEqual(self.dispatches(), [])

    def test_concurrent_confirmations_dispatch_once(self):
        self.start_session()
        host = self.t3(decisions=["approve", "approve"])
        plan_id = self.prepare(host)["planId"]
        results = host.call_many(
            [
                ("fundkit_transfer_confirm", {"planId": plan_id}),
                ("fundkit_transfer_confirm", {"planId": plan_id}),
            ]
        )
        statuses = sorted(body["status"] for body, _, _ in results)
        self.assertEqual(statuses, ["in-progress", "sent"])
        self.assertEqual(len(self.dispatches()), 1)

    def test_host_without_forms_cannot_confirm(self):
        self.start_session()
        host = self.t3(elicitation=False)
        plan_id = self.prepare(host)["planId"]
        result, is_error, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
        self.assertEqual((is_error, result["error"]), (True, "CONFIRMATION_UNAVAILABLE"))
        self.assertEqual(self.dispatches(), [])

    def test_insufficient_balance_and_inbound_cap_hold(self):
        self.start_session()
        host = self.t3()
        self.fixtures["binance"] = binance_fixtures(free_spot=300.28)
        self.write_fixtures()
        body = self.prepare(host, {**REVERSE, "network": "BSC"})
        self.assertEqual(body["status"], "hold")
        self.assertEqual([reason["code"] for reason in body["reasons"]], ["INSUFFICIENT_BALANCE"])
        self.assertIn("300.29", body["reasons"][0]["detail"])

        self.fixtures["binance"] = binance_fixtures()
        self.fixtures["bybit"] = bybit_fixtures(batch_release_limit="5000")
        self.write_fixtures()
        body = self.prepare(host, {**REVERSE, "network": "BSC"})
        self.assertEqual([reason["code"] for reason in body["reasons"]], ["INBOUND_CAP"])
        self.assertEqual(self.dispatches(), [])

    def test_source_key_without_withdrawal_right_holds(self):
        self.start_session()
        key = params_key("call_implicit_get", "sapiGetAccountApiRestrictions")
        self.fixtures["binance"][key]["enableWithdrawals"] = False
        self.write_fixtures()
        body = self.prepare(self.t3())
        self.assertEqual((body["status"], body["dispatch"]), ("hold", "none"))
        self.assertEqual([reason["code"] for reason in body["reasons"]], ["SOURCE_KEY_CANNOT_WITHDRAW"])
        self.assertNotIn("read-only", json.dumps(body))

    @staticmethod
    def rehash(plan: dict) -> None:
        def canonical(value):
            if isinstance(value, list):
                return "[" + ",".join(canonical(v) for v in value) + "]"
            if isinstance(value, dict):
                keys = sorted(value)
                return "{" + ",".join(f"{json.dumps(k)}:{canonical(value[k])}" for k in keys) + "}"
            return json.dumps(value, ensure_ascii=False)

        plan["argsHash"] = hashlib.sha256(canonical(plan["args"]).encode()).hexdigest()
        body = {k: v for k, v in plan.items() if k != "hash"}
        plan["hash"] = hashlib.sha256(canonical(body).encode()).hexdigest()


class T3FormTests(NativeTestCase):
    def test_t3_cannot_answer_ccxt_mcp_boolean_form_but_can_answer_the_plan_card(self):
        raw = {
            "message": "Confirm: …",
            "requestedSchema": {
                "type": "object",
                "properties": {"confirm": {"type": "boolean", "description": "approve this action"}},
                "required": ["confirm"],
            },
        }
        self.assertIsNone(t3_acceptance(raw))
        card = {
            "requestedSchema": {
                "type": "object",
                "properties": {"decision": {"type": "string", "enum": ["approve"]}},
                "required": ["decision"],
            }
        }
        self.assertEqual(t3_acceptance(card), {"action": "accept", "content": {"decision": "approve"}})
