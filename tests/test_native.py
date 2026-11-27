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
from decimal import Decimal
from pathlib import Path

from tests.native_support import (
    BINANCE_BSC,
    BINANCE_BSC_OLD,
    BINANCE_TON,
    BINANCE_TON_MEMO,
    BINANCE_TRX,
    BYBIT_BSC,
    USDT_BSC,
    USDT_TRX,
    T3Host,
    binance_fixtures,
    bybit_fixtures,
    decode_qr,
    fee_key,
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
        # No "tell me when you are done" round trip: the step continues on its own.
        self.assertIn(
            "Do not ask the user to confirm they are done or to run anything.", body["secretStep"]["rules"]
        )
        self.assertNotIn("say they are done", json.dumps(body["secretStep"], ensure_ascii=False))
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
            "CONTRACT_MISMATCH": lambda f: f[fee_key()]["info"]["networkList"][0].update(
                contractAddress="0x0000000000000000000000000000000000000001"
            ),
            "DEPOSIT_DISABLED": lambda f: f[fee_key()]["info"]["networkList"][0].update(depositEnable=False),
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
REVERSE = {"from": "Binance", "to": "Bybit", "amount": "300"}


class TransferTests(NativeTestCase):
    def prepare(self, host: T3Host, request=None) -> dict:
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", request or REVERSE)
        self.assertFalse(is_error, body)
        return body

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
            "Confirm transfer",
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


# =========================================================================== destination minimum
MINIMUM_MODULE = Path(__file__).resolve().parents[1] / "lib" / "venues" / "minimum.mjs"


def minimum_js(expression: str):
    """Evaluate `expression` with lib/venues/minimum.mjs as `m` and decimal.mjs as `d`."""
    script = (
        f"const m = await import({json.dumps(MINIMUM_MODULE.as_uri())});"
        f"const d = await import({json.dumps((MINIMUM_MODULE.parent / 'decimal.mjs').as_uri())});"
        f"const run = () => {{ {expression} }};"
        "try { console.log(JSON.stringify({ ok: run() ?? null })); }"
        "catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }"
    )
    result = subprocess.run(
        [NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30, check=True
    )
    return json.loads(result.stdout)


# The owner's exact copy. The 1 USDT in it is advice only: nothing below compares an amount with it.
NOTICE = "Destination deposit minimum unknown. Fundkit recommends depositing at least 1 USDT."
ADVICE = (
    "The exchange has not published a minimum for this network. "
    "Fundkit recommends depositing at least 1 USDT."
)
STEP = Decimal("0.0001")  # Bybit minAccuracy 4
TO_BINANCE = {"from": "Bybit", "to": "Binance", "network": "BSC"}
BYBIT_TRX = {
    "chain": "TRX",
    "chainType": "TRC20",
    "chainDeposit": "1",
    "chainWithdraw": "1",
    "depositMin": "1",
    "withdrawMin": "10",
    "contractAddress": USDT_TRX,
    "minAccuracy": "4",
    "withdrawFee": "1",
    "withdrawPercentageFee": "0",
}


def binance_bsc_row(fixtures: dict) -> dict:
    rows = fixtures[fee_key()]["info"]["networkList"]
    return next(row for row in rows if row["network"] == "BSC")


def bybit_bsc_row(fixtures: dict) -> dict:
    return next(row for row in fixtures[fee_key()]["info"]["chains"] if row["chain"] == "BSC")


class MinimumTestCase(NativeTestCase):
    def prepare(self, host: T3Host, request: dict) -> dict:
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", request)
        self.assertFalse(is_error, body)
        return body

    def hold_codes(self, body: dict) -> list[str]:
        self.assertEqual((body["status"], body["dispatch"]), ("hold", "none"), body)
        return [reason["code"] for reason in body["reasons"]]

    def mutate_binance(self, change) -> None:
        change(self.fixtures["binance"])
        self.write_fixtures()

    def stored_plan(self, plan_id: str) -> dict:
        return json.loads((self.home / f".local/state/fundkit/plans/{plan_id}.json").read_text())

    def plan_files(self) -> list[Path]:
        plans = self.home / ".local/state/fundkit/plans"
        return list(plans.iterdir()) if plans.exists() else []

    def assert_unknown_plan(self, body: dict) -> dict:
        """A ready plan whose venue minimum is unknown: the notice is in the summary, bound in the plan."""
        self.assertEqual(body["status"], "ready", body)
        self.assertEqual(body["minimumNotice"], NOTICE)
        plan = body["plan"]
        self.assertEqual(plan["destinationMinimum"], "unknown")
        self.assertEqual(plan["destinationMinimumBasis"], NOTICE)
        self.assertEqual(plan["minimumNotice"], NOTICE)
        self.assertIn(NOTICE, body["next"]["how"])
        self.assertIn("before the card opens", body["next"]["how"])
        self.assertIn("ask nothing", body["next"]["how"])
        stored = self.stored_plan(body["planId"])
        minimum = stored["destination"]["minimum"]
        self.assertIsNone(stored["destination"]["depositMin"], "unknown is never 0")
        self.assertEqual(
            (minimum["value"], minimum["basis"], minimum["venueMinimum"], minimum["notice"]),
            (None, "venue-unpublished", "unknown", NOTICE),
        )
        self.assertIn("Fundkit sets no minimum of its own", minimum["statement"])
        self.assertIn("the credit is not guaranteed", minimum["statement"])
        self.assertIn("recheck", stored["destination"])
        return stored


class BinanceUnknownMinimumTests(MinimumTestCase):
    """Bybit -> Binance on BSC with Binance's unknown deposit minimum (the real T3 thread)."""

    def setUp(self) -> None:
        super().setUp()
        # The real thread: Bybit withdrawMin 10, fee 0.15 on top.
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15")
        self.write_fixtures()

    def to_binance(self, host: T3Host, amount: str, **extra) -> dict:
        return self.prepare(host, {**TO_BINANCE, "amount": amount, **extra})

    def test_real_thread_ten_plus_fee_reaches_one_card_and_cancel_writes_nothing(self):
        self.start_session()
        host = self.t3(decisions=["cancel"])
        body = self.to_binance(host, "10")
        stored = self.assert_unknown_plan(body)
        plan = body["plan"]
        self.assertEqual(plan["amount"], "10 USDT")
        self.assertEqual(plan["fee"], "0.15 USDT (on top)")
        self.assertEqual((plan["debit"], plan["credit"]), ("10.15", "10"))
        self.assertEqual(plan["recipient"], BINANCE_BSC)
        self.assertEqual(stored["args"]["amount"], 10)
        self.assertEqual((host.cards, self.dispatches()), ([], []), "nothing before confirm")

        reads_before = len(self.calls("call_read_method"))
        result, is_error, _ = host.tool_full(
            "fundkit_transfer_confirm", {"planId": body["planId"]}, timeout=60
        )
        self.assertFalse(is_error, result)
        self.assertEqual((result["status"], result["sent"]), ("not-sent", False), result)
        self.assertEqual(result["reason"], "CONFIRM_DECLINED")
        # Exactly one card, with the same disclosure line in its body.
        self.assertEqual(len(host.cards), 1)
        card = host.cards[0]["message"]
        self.assertIn(f"\n{NOTICE}\n", card)
        self.assertNotIn("Destination minimum:", card)
        self.assertIn("Amount (withdrawal amount): 10 USDT", card)
        self.assertIn("Leaves the source: 10.15 USDT; Arrives: 10 USDT", card)
        self.assertGreater(len(self.calls("call_read_method")), reads_before, "the destination is read again")
        self.assertEqual(host.auto_cancelled, [])
        self.assertEqual(self.dispatches(), [], "zero withdrawal writes")
        again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertTrue(again["duplicate"])
        self.assertEqual(len(host.cards), 1)
        self.assertEqual(self.dispatches(), [])
        self.assert_secret_free()

    def test_disclosure_comes_before_consent_on_one_normal_card(self):
        """The notice is in the prepare summary, then in the card body; nothing is sent before the click."""
        self.start_session()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        self.write_fixtures()
        for amount, decision in (("0.5", "cancel"), ("0.5", "approve"), ("10", "approve")):
            with self.subTest(amount=amount, decision=decision):
                seen: list = []

                def at_card(params, decision=decision, seen=seen):
                    # While the card is open: the disclosure is on it and nothing was dispatched yet.
                    seen.append((params["message"], len(self.dispatches())))
                    return decision

                host = self.t3(decisions=[at_card])
                body = self.to_binance(host, amount)
                self.assert_unknown_plan(body)
                self.assertEqual(body["plan"]["credit"], amount)
                self.assertEqual(host.cards, [], "the summary with the notice comes before any card")
                dispatched_before = len(self.dispatches())
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
                self.assertEqual(len(seen), 1, "one card, no extra acknowledgement")
                message, dispatched_at_card = seen[0]
                self.assertEqual(dispatched_at_card, dispatched_before, "no dispatch before consent")
                self.assertIn(NOTICE, message)
                self.assertIn(body["planId"], message)
                self.assertIn(f"plan hash {body['hash']}", message)
                self.assertLess(message.index(NOTICE), message.index("Exact call"))
                expected = "sent" if decision == "approve" else "not-sent"
                self.assertEqual(result["status"], expected, result)
                self.assertEqual(len(self.dispatches()), dispatched_before + (decision == "approve"))
                host.close()

    def test_one_approval_sends_exactly_once(self):
        self.start_session()
        host = self.t3(decisions=["approve", "approve"])
        body = self.to_binance(host, "10")
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertEqual(result["status"], "sent", result)
        dispatches = self.dispatches()
        self.assertEqual(len(dispatches), 1)
        self.assertEqual(dispatches[0]["args"], self.stored_plan(body["planId"])["args"])
        again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertTrue(again["duplicate"])
        self.assertEqual((len(host.cards), len(self.dispatches())), (1, 1))

    def test_decline_and_no_answer_on_an_unknown_minimum_plan_send_nothing(self):
        self.start_session()
        for decision in ("decline", None):
            with self.subTest(decision=decision):
                host = self.t3(decisions=[decision], FUNDKIT_FORM_TIMEOUT_MS="1500")
                plan_id = self.to_binance(host, "10")["planId"]
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id}, timeout=30)
                self.assertEqual(result["status"], "not-sent", result)
                self.assertEqual(len(host.cards), 1)
                host.close()
        self.assertEqual(self.dispatches(), [])

    def test_source_side_gates_still_hold(self):
        self.start_session()
        host = self.t3()
        body = self.to_binance(host, "2")
        self.assertEqual(self.hold_codes(body), ["BELOW_WITHDRAW_MIN"])
        self.assertIn("10", body["reasons"][0]["detail"])

        self.fixtures["bybit"] = bybit_fixtures(free=10.14, withdraw_fee="0.15")
        self.write_fixtures()
        body = self.to_binance(host, "10")
        self.assertEqual(self.hold_codes(body), ["INSUFFICIENT_BALANCE"])
        self.assertIn("needs 10.15 USDT", body["reasons"][0]["detail"])
        self.assertIn("funding 10.14", body["reasons"][0]["detail"])

        self.fixtures["bybit"] = bybit_fixtures(free=10.15, withdraw_fee="0.15")
        self.write_fixtures()
        self.assertEqual(self.to_binance(host, "10")["status"], "ready")
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_sub_one_and_the_smallest_representable_credit_pass(self):
        self.start_session()
        host = self.t3()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        self.write_fixtures()
        # Below the old 1 USDT floor, and the old boundary itself: no Fundkit minimum.
        for amount in ("0.9999", "0.5", "0.0001", "1"):
            with self.subTest(amount=amount):
                body = self.to_binance(host, amount)
                self.assert_unknown_plan(body)
                self.assertEqual(body["plan"]["credit"], amount)
        # The finest amount fundkit can send unchanged as a JSON number (1e-6), on a 6-place step.
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.000001")
        bybit_bsc_row(self.fixtures["bybit"])["minAccuracy"] = "6"
        self.write_fixtures()
        body = self.to_binance(host, "0.000001")
        self.assert_unknown_plan(body)
        self.assertEqual(self.stored_plan(body["planId"])["args"]["amount"], 0.000001)
        # One place finer is not representable, and is refused before any minimum question.
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0000001")
        bybit_bsc_row(self.fixtures["bybit"])["minAccuracy"] = "7"
        self.write_fixtures()
        self.assertEqual(self.hold_codes(self.to_binance(host, "0.0000001")), ["AMOUNT_NOT_REPRESENTABLE"])
        # The source's own minimum still applies below 1.
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.5")
        self.write_fixtures()
        self.assertEqual(self.hold_codes(self.to_binance(host, "0.4999")), ["BELOW_WITHDRAW_MIN"])
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_unknown_minimum_adds_no_threshold_on_the_shared_check(self):
        tiny = Decimal("0.000000000001")  # the finest exact unit (12 places)
        cases = {
            # fee possibly taken from the amount (unconfirmed model): credit = amount - fee
            ("unconfirmed", Decimal("0.15") + tiny): None,
            ("unconfirmed", Decimal("0.15")): "CREDIT_NOT_POSITIVE",
            ("unconfirmed", Decimal("0.1")): "CREDIT_NOT_POSITIVE",
            ("unconfirmed", Decimal("1.1499")): None,
            # fee on top: credit = amount
            ("on top", tiny): None,
            ("on top", Decimal("0.999999")): None,
            ("on top", Decimal("0")): "CREDIT_NOT_POSITIVE",
        }
        for (model, amount), expected in cases.items():
            with self.subTest(model=model, amount=str(amount)):
                outcome = minimum_js(
                    "const p = d.parseDecimal;"
                    f"const {{ credit }} = m.transferAmounts({{ amount: p('{amount}'), fee: p('0.15'),"
                    f" feeModel: '{model}', depositFee: 0n }});"
                    "const r = m.resolveMinimum({ exchange: 'binance', coin: 'USDT',"
                    " networkLabel: 'BNB Smart Chain (BEP20)', published: { present: false }, field: 'f' });"
                    "m.checkDestinationMinimum(credit.min, r, 'Binance', 'USDT');"
                    "return d.formatDecimal(credit.min);"
                )
                self.assertEqual(outcome.get("code"), expected, outcome)
                if expected:
                    self.assertIn("nothing would arrive", outcome["message"])

    def test_zero_or_negative_credit_after_fees_holds(self):
        self.start_session()
        host = self.t3()
        # Binance -> Bybit with Bybit's field absent; Binance's fee (0.29) may be taken from the amount.
        self.fixtures["bybit"] = bybit_fixtures(deposit_min=None)
        binance_bsc_row(self.fixtures["binance"]).update(withdrawMin="0.00000001")
        self.write_fixtures()
        request = {"from": "Binance", "to": "Bybit", "network": "BSC"}
        for amount, credit in (("0.29", "0"), ("0.1", "-0.19")):
            with self.subTest(amount=amount):
                body = self.prepare(host, {**request, "amount": amount})
                self.assertEqual(self.hold_codes(body), ["CREDIT_NOT_POSITIVE"])
                self.assertIn(f"after fees is {credit} USDT", body["reasons"][0]["detail"])
        body = self.prepare(host, {**request, "amount": "0.5"})
        self.assert_unknown_plan(body)
        self.assertEqual(body["plan"]["credit"], "0.21\u20130.5")
        self.assertEqual((host.cards, self.dispatches(), len(self.plan_files())), ([], [], 1))

    def test_a_venue_minimum_on_the_row_is_enforced_whatever_its_value(self):
        self.start_session()
        host = self.t3()
        self.mutate_binance(lambda f: binance_bsc_row(f).update(depositMin="20"))
        body = self.to_binance(host, "10")
        self.assertEqual(self.hold_codes(body), ["BELOW_DEPOSIT_MIN"])
        self.assertIn("Binance credits deposits from 20 USDT", body["reasons"][0]["detail"])

        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        for venue_min, below, at in (("0.5", "0.4999", "0.5"), ("0", None, "0.0001"), ("1", "0.9999", "1")):
            with self.subTest(depositMin=venue_min):
                self.fixtures["binance"] = binance_fixtures()
                binance_bsc_row(self.fixtures["binance"]).update(depositMin=venue_min)
                self.write_fixtures()
                if below:
                    self.assertEqual(self.hold_codes(self.to_binance(host, below)), ["BELOW_DEPOSIT_MIN"])
                body = self.to_binance(host, at)
                self.assertEqual(body["status"], "ready", body)
                self.assertNotIn("minimumNotice", body)
                self.assertEqual(body["plan"]["destinationMinimum"], venue_min)
                self.assertEqual(
                    body["plan"]["destinationMinimumBasis"],
                    f"{venue_min} USDT, venue minimum (Binance networkList depositMin)",
                )
                stored = self.stored_plan(body["planId"])
                self.assertEqual(stored["destination"]["minimum"]["basis"], "venue")
                self.assertNotIn("recheck", stored["destination"])

        self.mutate_binance(lambda f: binance_bsc_row(f).update(depositMin="n/a"))
        self.assertEqual(self.hold_codes(self.to_binance(host, "10")), ["DESTINATION_MINIMUM_UNREADABLE"])
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_unhealthy_contrary_or_failed_reads_are_not_an_unknown_minimum(self):
        self.start_session()
        host = self.t3()
        key = fee_key()
        cases = {
            "DESTINATION_FIELD_UNREADABLE": lambda f: binance_bsc_row(f).update(depositDust="n/a"),
            "DESTINATION_MINIMUM_UNREADABLE": lambda f: binance_bsc_row(f).update(depositMin=None),
            "DESTINATION_BUSY": lambda f: binance_bsc_row(f).update(busy=True),
            "DEPOSIT_DISABLED": lambda f: binance_bsc_row(f).update(depositEnable=False),
            "CONTRACT_MISMATCH": lambda f: binance_bsc_row(f).update(
                contractAddress="0x0000000000000000000000000000000000000001"
            ),
            "BAD_RESPONSE": lambda f: f[key]["info"].update(coin="USDC"),
            "AMBIGUOUS_ROWS": lambda f: set_binance_address(
                f,
                "BEP20",
                BINANCE_BSC,
                "",
                extra_rows=[{"coin": "USDT", "address": BYBIT_BSC, "tag": "", "isDefault": 1}],
            ),
            "WRONG_CHAIN": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC, "", gated_network="ERC20"),
            "MEMO_FIELD_MISSING": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC, None),
            "AUTH_FAILED": lambda f: f.update(
                {key: {"__error": {"code": "AUTH_FAILED", "message": "Invalid API-key, IP, or permissions"}}}
            ),
        }
        for code, mutate in cases.items():
            with self.subTest(code=code):
                self.fixtures["binance"] = binance_fixtures()
                mutate(self.fixtures["binance"])
                self.write_fixtures()
                body, _, _ = host.tool_full("fundkit_transfer_prepare", {**TO_BINANCE, "amount": "10"})
                text = json.dumps(body)
                self.assertIn(code, text, body)
                self.assertNotIn(NOTICE, text)
                self.assertNotEqual(body.get("status"), "ready")
                self.assertNotIn("planId", body)
        self.assertEqual(self.plan_files(), [])
        # depositDust has no documented meaning: never the minimum, never compared with a constant.
        # A credit at or below it is contrary evidence; above it, the minimum stays unknown.
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        for dust, amount, expected in (
            ("0.0005", "0.0005", "DESTINATION_MINIMUM_CONTRARY"),
            ("0.0005", "0.0006", "ready"),
            ("1.5", "1.5", "DESTINATION_MINIMUM_CONTRARY"),
            ("1.5", "1.5001", "ready"),
        ):
            with self.subTest(depositDust=dust, amount=amount):
                self.fixtures["binance"] = binance_fixtures()
                binance_bsc_row(self.fixtures["binance"]).update(depositDust=dust)
                self.write_fixtures()
                body = self.to_binance(host, amount)
                if expected == "ready":
                    stored = self.assert_unknown_plan(body)
                    self.assertEqual(
                        stored["destination"]["minimum"]["uninterpreted"],
                        {"Binance networkList depositDust": dust},
                    )
                else:
                    self.assertEqual(self.hold_codes(body), [expected])
                    self.assertIn("is not the minimum", body["reasons"][0]["detail"])
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_recheck_before_the_card_never_shows_a_stale_plan(self):
        self.start_session()
        cases = {
            "venue minimum now known (1)": lambda f: binance_bsc_row(f).update(depositMin="1"),
            "venue minimum now known (0)": lambda f: binance_bsc_row(f).update(depositMin="0"),
            "venue minimum now known (higher)": lambda f: binance_bsc_row(f).update(depositMin="20"),
            "address changed": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC_OLD, ""),
            "deposits disabled": lambda f: binance_bsc_row(f).update(depositEnable=False),
            "row unhealthy": lambda f: binance_bsc_row(f).update(depositDust="n/a"),
            "uninterpreted field appeared": lambda f: binance_bsc_row(f).update(depositDust="0.0001"),
            "key check fails": lambda f: f[
                params_key("call_implicit_get", "sapiGetAccountApiRestrictions")
            ].update(enableReading=False),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                self.fixtures["binance"] = binance_fixtures()
                self.write_fixtures()
                host = self.t3(decisions=["approve"])
                plan_id = self.to_binance(host, "10")["planId"]
                self.mutate_binance(mutate)
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                self.assertEqual(
                    (result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED")
                )
                self.assertIn("before the card", result["detail"])
                if name.startswith("venue minimum"):
                    self.assertIn("not unknown (venue-unpublished)", result["detail"])
                self.assertEqual(host.cards, [])
                again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                self.assertTrue(again["duplicate"])
                host.close()
        self.assertEqual(self.dispatches(), [])

    def test_recheck_after_the_approval_stops_a_plan_that_went_stale_on_the_card(self):
        self.start_session()
        cases = {
            "venue minimum now known": lambda f: binance_bsc_row(f).update(depositMin="20"),
            "address changed": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC_OLD, ""),
            "read fails": lambda f: f.update(
                {fee_key(): {"__error": {"code": "EXCHANGE_NOT_AVAILABLE", "message": "maintenance"}}}
            ),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                self.fixtures["binance"] = binance_fixtures()
                self.write_fixtures()

                def change_then_approve(_params, mutate=mutate):
                    self.mutate_binance(mutate)
                    return "approve"

                host = self.t3(decisions=[change_then_approve])
                plan_id = self.to_binance(host, "10")["planId"]
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                self.assertEqual(
                    (result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED")
                )
                self.assertIn("after the approval", result["detail"])
                self.assertEqual(len(host.cards), 1)
                host.close()
        self.assertEqual(self.dispatches(), [])

    def test_every_binance_chain_is_unknown_and_the_address_flow_gives_advice_only(self):
        self.start_session()
        host = self.t3()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", extra_chains=[BYBIT_TRX])
        self.write_fixtures()
        # Binance publishes no minimum on any chain, so TRC20 is unknown like BSC.
        body = self.to_binance(host, "10", network="TRC20")
        self.assert_unknown_plan(body)
        self.assertIn(
            "for USDT on Tron (TRC20)",
            self.stored_plan(body["planId"])["destination"]["minimum"]["statement"],
        )

        # With no network named, both qualify and the cheaper one (BSC, fee 0.15) is chosen.
        any_network = {"from": "Bybit", "to": "Binance", "amount": "10"}
        body, _, _ = host.tool_full("fundkit_transfer_prepare", any_network)
        self.assertEqual(body["status"], "ready")
        self.assertIn("BNB Smart Chain", body["plan"]["network"])
        # TRC20 qualifies too (no hold for it); Bybit has no ERC20 or TON row in the fixture.
        other = {reason["network"]: reason["code"] for reason in body["otherNetworks"]}
        self.assertEqual(other, {"ERC20": "NO_ROW", "TON": "NO_ROW"})

        # Binance -> Bybit keeps Bybit's own depositMin and is never rechecked.
        body, _, _ = host.tool_full("fundkit_transfer_prepare", REVERSE)
        self.assertEqual(body["plan"]["destinationMinimum"], "1")
        self.assertEqual(
            body["plan"]["destinationMinimumBasis"], "1 USDT, venue minimum (Bybit chains[].depositMin)"
        )
        self.assertNotIn("minimumNotice", body)
        self.assertEqual(self.stored_plan(body["planId"])["destination"]["minimum"]["basis"], "venue")
        self.assertNotIn("recheck", self.stored_plan(body["planId"])["destination"])

        # The address-only flow takes no amount and asks nothing; it gives the advice, same address and QR.
        address, is_error, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertFalse(is_error, address)
        self.assertEqual(address["address"], BINANCE_BSC)
        self.assertEqual(decode_qr(Path(address["qr"]["path"])), BINANCE_BSC.encode())
        self.assertEqual(
            address["depositMinimum"],
            {
                "status": "unpublished",
                "venueMinimum": "unknown",
                "field": "Binance networkList depositMin",
                "advice": ADVICE,
            },
        )
        self.assertTrue(any(ADVICE in line for line in address["show"]))
        self.assertNotIn("amount", json.dumps(address).lower())
        self.assertEqual((host.cards, self.dispatches()), ([], []))


class AddressMinimumTests(MinimumTestCase):
    """The address and QR, with the destination's minimum as it stands, and never a hold for it."""

    def address(self, host: T3Host, exchange: str, network: str = "BSC") -> dict:
        body, is_error, result = host.tool_full(
            "fundkit_deposit_address", {"exchange": exchange, "network": network}
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["status"], "verified", body)
        self.assertEqual([item["type"] for item in result["content"]], ["text", "image"])
        self.assertEqual(decode_qr(Path(body["qr"]["path"])), body["address"].encode())
        return body

    def test_published_unpublished_and_unreadable_are_told_apart(self):
        self.start_session()
        host = self.t3()
        cases = {
            # Bybit's field: published (any value, 0 included), absent, or present but unreadable.
            "1": {"status": "published", "value": "1", "venueMinimum": "1"},
            "0": {"status": "published", "value": "0", "venueMinimum": "0"},
            "350": {"status": "published", "value": "350", "venueMinimum": "350"},
            None: {"status": "unpublished", "venueMinimum": "unknown", "advice": ADVICE},
            "": {"status": "unreadable", "venueMinimum": "unknown"},
        }
        for deposit_min, expected in cases.items():
            with self.subTest(depositMin=deposit_min):
                self.fixtures["bybit"] = bybit_fixtures(deposit_min=deposit_min)
                self.write_fixtures()
                body = self.address(host, "bybit")
                self.assertEqual(body["address"], BYBIT_BSC)
                minimum = body["depositMinimum"]
                for field, value in expected.items():
                    self.assertEqual(minimum[field], value, minimum)
                self.assertEqual(minimum["field"], "Bybit chains[].depositMin")
                if expected["status"] == "published":
                    self.assertNotIn("advice", minimum)
                    self.assertIn(f"deposit minimum of {expected['value']} USDT", minimum["text"])
                    self.assertTrue(any(minimum["text"] in line for line in body["show"]))
                elif expected["status"] == "unreadable":
                    # Never claimed as "not published" when the field could not be read.
                    self.assertNotIn("not published", minimum["advice"])
                    self.assertIn("could not be read", minimum["advice"])
                    self.assertIn("at least 1 USDT", minimum["advice"])
        # Binance with a published depositMin on the row.
        self.mutate_binance(lambda f: binance_bsc_row(f).update(depositMin="0.5"))
        body = self.address(host, "binance")
        self.assertEqual(body["depositMinimum"]["status"], "published")
        self.assertEqual(body["depositMinimum"]["value"], "0.5")
        self.assertEqual((host.cards, self.dispatches(), self.plan_files()), ([], [], []))

    def test_a_failed_lookup_shows_no_minimum_claim_and_no_address(self):
        self.start_session()
        host = self.t3()
        self.mutate_binance(
            lambda f: f.update(
                {fee_key(): {"__error": {"code": "EXCHANGE_NOT_AVAILABLE", "message": "maintenance"}}}
            )
        )
        body, is_error, result = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertTrue(is_error, body)
        text = json.dumps(body)
        self.assertNotIn(ADVICE, text)
        self.assertNotIn("not published", text)
        self.assertEqual((body["address"], body["qr"]), (None, None))
        self.assertEqual([item["type"] for item in result["content"]], ["text"])


# =========================================================================== the policy, USDT only
VENUES = ["binance", "bybit", "okx", "bitget", "gate", "kucoin", "mexc", "whitebit"]
# Requests fundkit refuses before a session, a read or a write: it supports USDT only.
REFUSED_COINS = ["USDC", "usdc", " USDC ", "DAI", "", "USDT-BSC", 5]


class DepositMinimumPolicyTests(MinimumTestCase):
    """No Fundkit minimum: USDT deposits into every supported CEX destination."""

    def test_policy_matrix_eight_venues_usdt_only(self):
        outcome = minimum_js(
            f"const venues = {json.dumps(VENUES)};"
            "const label = 'Ethereum (ERC20)';"
            "const out = {};"
            "const tiny = d.parseDecimal('0.000000000001');"
            "for (const v of venues) {"
            "  const at = (value, present = true, coin = 'USDT') => {"
            "    try { const r = m.resolveMinimum({ exchange: v, coin, networkLabel: label,"
            "      published: { present, value }, field: 'f' });"
            "      const pass = (c) => { try { m.checkDestinationMinimum(c, r, v, coin); return 'pass'; }"
            "        catch (e) { return e.code; } };"
            "      return [r.minimum.basis, r.minimum.value, r.minimum.venueMinimum, r.minimum.coin,"
            "        r.depositMin === null ? null : d.formatDecimal(r.depositMin),"
            "        r.minimum.notice ?? null, r.minimum.statement ?? null, pass(tiny), pass(0n)]; }"
            "    catch (e) { return [e.code]; } };"
            "  out[v] = { absent: at(undefined, false),"
            "    zero: at('0'), lower: at('0.5'), higher: at('25'), nul: at(null), empty: at(''),"
            "    text: at('n/a'), negative: at('-1'), number: at(2),"
            "    usdcAbsent: at(undefined, false, 'USDC'), usdcPresent: at('1', true, 'USDC') };"
            "}"
            "out.coins = m.COINS;"
            "out.destinations = Object.keys(m.DESTINATIONS);"
            "out.other = (() => { try { m.resolveMinimum({ exchange: 'hyperliquid', coin: 'USDT',"
            "  networkLabel: label, published: { present: false }, field: 'f' }); return 'resolved'; }"
            "  catch (e) { return e.code; } })();"
            "out.recommendation = m.RECOMMENDATION;"
            "return out;"
        )["ok"]
        self.assertEqual(outcome["coins"], ["USDT"])
        self.assertEqual(sorted(outcome["destinations"]), sorted(VENUES))
        self.assertEqual(outcome["recommendation"], {"value": "1", "coin": "USDT"})
        for venue in VENUES:
            with self.subTest(venue=venue):
                row = outcome[venue]
                basis, value, venue_minimum, minimum_coin, deposit_min, notice, statement, tiny, zero = row[
                    "absent"
                ]
                self.assertEqual(
                    (basis, value, venue_minimum, minimum_coin, deposit_min, notice),
                    ("venue-unpublished", None, "unknown", "USDT", None, NOTICE),
                )
                self.assertIn("publishes no deposit minimum for USDT on Ethereum (ERC20)", statement)
                self.assertIn("Fundkit sets no minimum of its own", statement)
                # Unknown: the finest positive credit passes, zero never does.
                self.assertEqual((tiny, zero), ("pass", "CREDIT_NOT_POSITIVE"))
                # An authoritative venue value is enforced whatever it is, 0 included; never "unknown".
                for case, expected in (("zero", "0"), ("lower", "0.5"), ("higher", "25"), ("number", "2")):
                    self.assertEqual(row[case][:5], ["venue", expected, expected, "USDT", expected], case)
                self.assertEqual(row["zero"][7:], ["pass", "CREDIT_NOT_POSITIVE"])
                self.assertEqual(row["lower"][7], "BELOW_DEPOSIT_MIN")
                for case in ("nul", "empty", "text", "negative"):
                    self.assertEqual(row[case], ["DESTINATION_MINIMUM_UNREADABLE"], case)
                # No coin but USDT: never resolved, never "unknown".
                self.assertEqual(row["usdcAbsent"], ["UNSUPPORTED_COIN"])
                self.assertEqual(row["usdcPresent"], ["UNSUPPORTED_COIN"])
        self.assertEqual(outcome["other"], "VENUE_NOT_SUPPORTED")

    def test_positive_credit_is_required_even_with_a_zero_venue_minimum(self):
        for credit, expected in (("0", "CREDIT_NOT_POSITIVE"), ("0.000000000001", None)):
            with self.subTest(credit=credit):
                outcome = minimum_js(
                    "const p = d.parseDecimal;"
                    f"m.checkDestinationMinimum(p('{credit}'), {{ depositMin: 0n,"
                    " minimum: m.venueMinimum(0n, 'f', 'USDT') }, 'Bybit', 'USDT');"
                )
                self.assertEqual(outcome.get("code"), expected, outcome)

    def test_a_missing_minimum_without_the_unknown_record_still_holds(self):
        outcome = minimum_js("m.checkDestinationMinimum(5n, { depositMin: null }, 'X', 'USDT');")
        self.assertEqual(outcome["code"], "DESTINATION_MINIMUM_UNDOCUMENTED")

    # ------------------------------------------------------------------ native, end to end

    def setUp(self) -> None:
        super().setUp()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15")
        self.write_fixtures()

    def test_bybit_destination_venue_minimum_and_missing_field(self):
        self.start_session()
        host = self.t3(decisions=["approve", "approve"])
        binance_bsc_row(self.fixtures["binance"]).update(withdrawMin="0.00000001")
        cases = {
            # Bybit's own depositMin, whatever its value: enforced, no recheck.
            ("1", "300"): ("venue", "1", False),
            ("0", "300"): ("venue", "0", False),
            ("350", "300"): ("hold", "BELOW_DEPOSIT_MIN", None),
            ("1", "1"): ("hold", "BELOW_DEPOSIT_MIN", None),  # credit 0.71 below Bybit's own 1
            # The field absent from an otherwise healthy row: unknown, any positive credit, rechecked.
            (None, "300"): ("venue-unpublished", None, True),
            (None, "1"): ("venue-unpublished", None, True),  # credit 0.71: below 1, still planned
            # Present but not exact: hold, never "unknown".
            ("", "300"): ("hold", "DESTINATION_MINIMUM_UNREADABLE", None),
        }
        for (deposit_min, amount), (basis, value, recheck) in cases.items():
            with self.subTest(depositMin=deposit_min, amount=amount):
                self.fixtures["bybit"] = bybit_fixtures(deposit_min=deposit_min)
                self.write_fixtures()
                body = self.prepare(host, {**REVERSE, "amount": amount, "network": "BSC"})
                if basis == "hold":
                    self.assertEqual([r["code"] for r in body["reasons"]], [value], body)
                    continue
                self.assertEqual(body["status"], "ready", body)
                self.assertEqual(body["plan"]["recipient"], BYBIT_BSC)
                stored = self.stored_plan(body["planId"])
                minimum = stored["destination"]["minimum"]
                self.assertEqual(
                    (minimum["basis"], minimum["value"], minimum["coin"]), (basis, value, "USDT")
                )
                self.assertEqual("recheck" in stored["destination"], recheck)
                if basis == "venue":
                    self.assertEqual(minimum["venueMinimum"], value)
                    self.assertNotIn("minimumNotice", body)
                else:
                    self.assert_unknown_plan(body)
                    self.assertIn("Bybit publishes no deposit minimum for USDT", minimum["statement"])
        # An unknown-minimum plan on Bybit is read again: a minimum that appears before the card stops it.
        self.fixtures["bybit"] = bybit_fixtures(deposit_min=None)
        self.write_fixtures()
        body = self.prepare(host, {**REVERSE, "amount": "0.5", "network": "BSC"})
        self.assert_unknown_plan(body)
        self.fixtures["bybit"] = bybit_fixtures(deposit_min="0.1")
        self.write_fixtures()
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertEqual((result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED"))
        self.assertIn("now 0.1 USDT (venue), not unknown (venue-unpublished)", result["detail"])
        self.assertEqual((host.cards, self.dispatches()), ([], []))
        # A sub-1 plan into Bybit's unknown minimum reaches one card and is sent once on approval.
        self.fixtures["bybit"] = bybit_fixtures(deposit_min=None)
        self.write_fixtures()
        body = self.prepare(host, {**REVERSE, "amount": "0.5", "network": "BSC"})
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertEqual(result["status"], "sent", result)
        self.assertEqual(len(host.cards), 1)
        self.assertIn(NOTICE, host.cards[0]["message"])
        self.assertEqual(len(self.dispatches()), 1)

    # ------------------------------------------------------------------ USDT only

    def assert_refused(self, host: T3Host, name: str, args: dict) -> None:
        body, is_error, result = host.tool_full(name, args)
        self.assertTrue(is_error, body)
        self.assertEqual(body["error"], "UNSUPPORTED_COIN", body)
        self.assertIn("only USDT is supported", body["message"])
        self.assertEqual([item["type"] for item in result["content"]], ["text"], "no QR image")
        self.assertNotIn("address", body)
        self.assertNotIn("planId", body)

    def test_any_coin_but_usdt_is_refused_with_zero_reads_and_writes(self):
        requests = [
            ("fundkit_deposit_address", {"exchange": "binance", "network": "BSC"}),
            ("fundkit_deposit_address", {"exchange": "bybit", "network": "ERC20"}),
            (
                "fundkit_transfer_prepare",
                {"from": "bybit", "to": "binance", "amount": "10", "network": "BSC"},
            ),
            ("fundkit_transfer_prepare", REVERSE),
        ]
        # Before any session: refused, not NO_SESSION, so no secret card is ever asked for.
        host = self.t3()
        for name, args in requests:
            for coin in REFUSED_COINS:
                with self.subTest(session=False, name=name, coin=coin):
                    self.assert_refused(host, name, {**args, "coin": coin})
        self.assertEqual(self.doppler.requests, [], "no Doppler request at all")
        # With a session: still refused before any profile, read or write.
        self.start_session()
        for name, args in requests:
            for coin in REFUSED_COINS:
                with self.subTest(session=True, name=name, coin=coin):
                    self.assert_refused(host, name, {**args, "coin": coin})
        self.assertEqual(self.doppler.secret_requests(), [], "no exchange secret fetched")
        self.assertEqual(self.starts(), {}, "no profile started")
        self.assertEqual((self.calls(), self.dispatches(), host.cards), ([], [], []))

    def test_usdt_spelled_or_omitted_is_the_same_request(self):
        self.start_session()
        host = self.t3()
        addresses = set()
        for coin in (None, "USDT", "usdt", " Usdt "):
            with self.subTest(coin=coin):
                args = {"exchange": "binance", "network": "BSC"}
                if coin is not None:
                    args["coin"] = coin
                body, is_error, _ = host.tool_full("fundkit_deposit_address", args)
                self.assertFalse(is_error, body)
                self.assertEqual((body["status"], body["coin"]), ("verified", "USDT"))
                addresses.add(body["address"])
        self.assertEqual(addresses, {BINANCE_BSC})
        # Every coin-scoped request a venue received asked for USDT.
        for event in self.calls():
            self.assertNotIn("USDC", json.dumps(event["args"]))
        self.assertEqual(self.dispatches(), [])

    def test_schemas_offer_usdt_only(self):
        tools = {tool["name"]: tool for tool in self.t3().request("tools/list", {})["result"]["tools"]}
        for name in ("fundkit_deposit_address", "fundkit_transfer_prepare"):
            with self.subTest(name=name):
                self.assertEqual(tools[name]["inputSchema"]["properties"]["coin"]["enum"], ["USDT"])
                self.assertNotIn("USDC", tools[name]["description"])
