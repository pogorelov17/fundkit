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


# The one constant the rule is about; every boundary below is derived from it.
FALLBACK = minimum_js("return m.FALLBACK_POLICY.value;")["ok"]
FALLBACK_UNITS = Decimal(FALLBACK)
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


class BinanceFallbackMinimumTests(NativeTestCase):
    """Bybit -> Binance on BSC with Binance's unknown deposit minimum (the real T3 thread)."""

    def setUp(self) -> None:
        super().setUp()
        # The real thread: Bybit withdrawMin 10, fee 0.15 on top.
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15")
        self.write_fixtures()

    def prepare(self, host: T3Host, amount: str, **extra) -> dict:
        body, is_error, _ = host.tool_full(
            "fundkit_transfer_prepare", {**TO_BINANCE, "amount": amount, **extra}
        )
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

    def test_real_thread_ten_plus_fee_reaches_one_card_and_cancel_writes_nothing(self):
        self.start_session()
        host = self.t3(decisions=["cancel"])
        body = self.prepare(host, "10")
        self.assertEqual(body["status"], "ready", body)
        plan = body["plan"]
        self.assertEqual(plan["amount"], "10 USDT")
        self.assertEqual(plan["fee"], "0.15 USDT (on top)")
        self.assertEqual((plan["debit"], plan["credit"]), ("10.15", "10"))
        self.assertEqual(plan["recipient"], BINANCE_BSC)
        self.assertEqual(plan["destinationMinimum"], FALLBACK)
        basis = plan["destinationMinimumBasis"]
        for needle in ("Fundkit operator fallback", "venue minimum: unknown", "not a Binance figure"):
            self.assertIn(needle, basis)
        self.assertIn("does not guarantee the credit", basis)
        stored = self.stored_plan(body["planId"])
        minimum = stored["destination"]["minimum"]
        self.assertEqual(
            (minimum["value"], minimum["basis"], minimum["venueMinimum"]),
            (FALLBACK, "fundkit-operator-fallback", "unknown"),
        )
        self.assertIn("recheck", stored["destination"])
        self.assertEqual(stored["args"]["amount"], 10)
        self.assertEqual(self.dispatches(), [])

        reads_before = len(self.calls("call_read_method"))
        result, is_error, _ = host.tool_full(
            "fundkit_transfer_confirm", {"planId": body["planId"]}, timeout=60
        )
        self.assertFalse(is_error, result)
        self.assertEqual((result["status"], result["sent"]), ("not-sent", False), result)
        self.assertEqual(result["reason"], "CONFIRM_DECLINED")
        # Exactly one card, with the minimum, its basis and the unknown venue minimum on it.
        self.assertEqual(len(host.cards), 1)
        card = host.cards[0]["message"]
        self.assertIn(
            f"Destination minimum: {FALLBACK} USDT, Fundkit operator fallback (venue minimum: unknown).", card
        )
        self.assertIn("does not guarantee the credit", card)
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

    def test_one_approval_sends_exactly_once(self):
        self.start_session()
        host = self.t3(decisions=["approve", "approve"])
        body = self.prepare(host, "10")
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertEqual(result["status"], "sent", result)
        dispatches = self.dispatches()
        self.assertEqual(len(dispatches), 1)
        self.assertEqual(dispatches[0]["args"], self.stored_plan(body["planId"])["args"])
        again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertTrue(again["duplicate"])
        self.assertEqual((len(host.cards), len(self.dispatches())), (1, 1))

    def test_decline_and_no_answer_on_a_fallback_plan_send_nothing(self):
        self.start_session()
        for decision in ("decline", None):
            with self.subTest(decision=decision):
                host = self.t3(decisions=[decision], FUNDKIT_FORM_TIMEOUT_MS="1500")
                plan_id = self.prepare(host, "10")["planId"]
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id}, timeout=30)
                self.assertEqual(result["status"], "not-sent", result)
                self.assertEqual(len(host.cards), 1)
                host.close()
        self.assertEqual(self.dispatches(), [])

    def test_source_side_twins_still_hold(self):
        self.start_session()
        host = self.t3()
        body = self.prepare(host, "2")
        self.assertEqual(self.hold_codes(body), ["BELOW_WITHDRAW_MIN"])
        self.assertIn("10", body["reasons"][0]["detail"])

        self.fixtures["bybit"] = bybit_fixtures(free=10.14, withdraw_fee="0.15")
        self.write_fixtures()
        body = self.prepare(host, "10")
        self.assertEqual(self.hold_codes(body), ["INSUFFICIENT_BALANCE"])
        self.assertIn("needs 10.15 USDT", body["reasons"][0]["detail"])
        self.assertIn("funding 10.14", body["reasons"][0]["detail"])

        self.fixtures["bybit"] = bybit_fixtures(free=10.15, withdraw_fee="0.15")
        self.write_fixtures()
        self.assertEqual(self.prepare(host, "10")["status"], "ready")
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_threshold_on_the_expected_credit_is_inclusive(self):
        self.start_session()
        host = self.t3()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        self.write_fixtures()
        below = self.prepare(host, str(FALLBACK_UNITS - STEP))
        self.assertEqual(self.hold_codes(below), ["BELOW_DEPOSIT_MIN"])
        detail = below["reasons"][0]["detail"]
        self.assertIn("Fundkit's operator fallback minimum", detail)
        self.assertIn(f"{FALLBACK} USDT", detail)
        equal = self.prepare(host, FALLBACK)
        self.assertEqual(equal["status"], "ready", equal)
        self.assertEqual(equal["plan"]["credit"], FALLBACK)
        self.assertEqual(self.dispatches(), [])

    def test_fee_adjusted_threshold_on_the_shared_check(self):
        tiny = Decimal("0.000000000001")  # the finest exact unit (12 places)
        cases = {
            # fee taken from the amount (unconfirmed model): credit = amount - fee
            ("unconfirmed", FALLBACK_UNITS + Decimal("0.15")): None,
            ("unconfirmed", FALLBACK_UNITS + Decimal("0.1499")): "BELOW_DEPOSIT_MIN",
            ("unconfirmed", FALLBACK_UNITS + Decimal("0.15") - tiny): "BELOW_DEPOSIT_MIN",
            # fee on top: credit = amount
            ("on top", FALLBACK_UNITS): None,
            ("on top", FALLBACK_UNITS - Decimal("0.000001")): "BELOW_DEPOSIT_MIN",
            ("on top", FALLBACK_UNITS - tiny): "BELOW_DEPOSIT_MIN",
        }
        for (model, amount), expected in cases.items():
            with self.subTest(model=model, amount=str(amount)):
                outcome = minimum_js(
                    "const p = d.parseDecimal;"
                    f"const {{ credit }} = m.transferAmounts({{ amount: p('{amount}'), fee: p('0.15'),"
                    f" feeModel: '{model}', depositFee: 0n }});"
                    "const f = m.operatorFallback('binance', 'USDT');"
                    "m.checkDestinationMinimum(credit.min, { depositMin: p(f.value),"
                    " minimum: m.fallbackMinimum(f, 'BNB Smart Chain (BEP20)') }, 'Binance', 'USDT');"
                    "return d.formatDecimal(credit.min);"
                )
                self.assertEqual(outcome.get("code"), expected, outcome)
                if expected:
                    self.assertIn(f"{FALLBACK} USDT", outcome["message"])

    def test_a_venue_minimum_on_the_row_wins_whatever_its_value(self):
        self.start_session()
        host = self.t3()
        self.mutate_binance(lambda f: binance_bsc_row(f).update(depositMin="20"))
        body = self.prepare(host, "10")
        self.assertEqual(self.hold_codes(body), ["BELOW_DEPOSIT_MIN"])
        self.assertIn("Binance credits deposits from 20 USDT", body["reasons"][0]["detail"])

        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        lower = FALLBACK_UNITS / 2
        self.fixtures["binance"] = binance_fixtures()
        binance_bsc_row(self.fixtures["binance"]).update(depositMin=str(lower))
        self.write_fixtures()
        between = str(lower + STEP)
        body = self.prepare(host, between)
        self.assertEqual(body["status"], "ready", body)
        self.assertEqual(body["plan"]["destinationMinimum"], str(lower))
        self.assertIn(
            "venue minimum (Binance networkList depositMin)", body["plan"]["destinationMinimumBasis"]
        )
        stored = self.stored_plan(body["planId"])
        self.assertEqual(stored["destination"]["minimum"]["basis"], "venue")
        self.assertNotIn("recheck", stored["destination"])

        self.mutate_binance(lambda f: binance_bsc_row(f).update(depositMin="n/a"))
        self.assertEqual(self.hold_codes(self.prepare(host, "10")), ["DESTINATION_MINIMUM_UNREADABLE"])
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_contrary_unhealthy_or_failed_reads_never_use_the_fallback(self):
        self.start_session()
        host = self.t3()
        above = str(FALLBACK_UNITS + Decimal("0.01"))
        key = fee_key()
        cases = {
            "DESTINATION_MINIMUM_CONTRARY": lambda f: binance_bsc_row(f).update(depositDust=above),
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
                self.assertNotEqual(body.get("status"), "ready")
                self.assertNotIn("planId", body)
        # depositDust at or below the fallback is no contrary evidence (and is never the minimum).
        self.fixtures["binance"] = binance_fixtures()
        binance_bsc_row(self.fixtures["binance"]).update(depositDust=FALLBACK)
        self.write_fixtures()
        body = self.prepare(host, "10")
        self.assertEqual(body["status"], "ready", body)
        self.assertEqual(body["plan"]["destinationMinimum"], FALLBACK)
        self.assertEqual((host.cards, self.dispatches()), ([], []))
        self.assertEqual(len(self.plan_files()), 1)

    def test_recheck_before_the_card_never_shows_a_stale_plan(self):
        self.start_session()
        cases = {
            "venue minimum now known (same value)": lambda f: binance_bsc_row(f).update(depositMin=FALLBACK),
            "venue minimum now known (higher)": lambda f: binance_bsc_row(f).update(depositMin="20"),
            "address changed": lambda f: set_binance_address(f, "BEP20", BINANCE_BSC_OLD, ""),
            "deposits disabled": lambda f: binance_bsc_row(f).update(depositEnable=False),
            "contrary evidence": lambda f: binance_bsc_row(f).update(depositDust="n/a"),
            "key check fails": lambda f: f[
                params_key("call_implicit_get", "sapiGetAccountApiRestrictions")
            ].update(enableReading=False),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                self.fixtures["binance"] = binance_fixtures()
                self.write_fixtures()
                host = self.t3(decisions=["approve"])
                plan_id = self.prepare(host, "10")["planId"]
                self.mutate_binance(mutate)
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                self.assertEqual(
                    (result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED")
                )
                self.assertIn("before the card", result["detail"])
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
                plan_id = self.prepare(host, "10")["planId"]
                result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan_id})
                self.assertEqual(
                    (result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED")
                )
                self.assertIn("after the approval", result["detail"])
                self.assertEqual(len(host.cards), 1)
                host.close()
        self.assertEqual(self.dispatches(), [])

    def test_every_binance_chain_uses_the_fallback_and_the_address_flow_is_unchanged(self):
        self.start_session()
        host = self.t3()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", extra_chains=[BYBIT_TRX])
        self.write_fixtures()
        # Binance publishes no minimum on any chain, so TRC20 now uses the same fallback as BSC.
        body = self.prepare(host, "10", network="TRC20")
        self.assertEqual(body["status"], "ready", body)
        self.assertEqual(body["plan"]["destinationMinimum"], FALLBACK)
        self.assertIn("for USDT on Tron (TRC20)", body["plan"]["destinationMinimumBasis"])
        self.assertIn("recheck", self.stored_plan(body["planId"])["destination"])

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
        self.assertEqual(self.stored_plan(body["planId"])["destination"]["minimum"]["basis"], "venue")
        self.assertNotIn("recheck", self.stored_plan(body["planId"])["destination"])

        # The address-only flow reads no amount, fee or minimum and shows the same address and QR.
        address, is_error, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertFalse(is_error, address)
        self.assertEqual(address["address"], BINANCE_BSC)
        self.assertEqual(decode_qr(Path(address["qr"]["path"])), BINANCE_BSC.encode())
        self.assertNotIn("inimum", json.dumps(address))
        self.assertEqual((host.cards, self.dispatches()), ([], []))


# =========================================================================== the policy, USDT only
VENUES = ["binance", "bybit", "okx", "bitget", "gate", "kucoin", "mexc", "bingx", "whitebit"]
# Requests fundkit refuses before a session, a read or a write: it supports USDT only.
REFUSED_COINS = ["USDC", "usdc", " USDC ", "DAI", "", "USDT-BSC", 5]


class DepositMinimumPolicyTests(NativeTestCase):
    """The one-unit operator fallback: USDT deposits into every supported CEX destination."""

    def test_policy_matrix_nine_venues_usdt_only(self):
        outcome = minimum_js(
            f"const venues = {json.dumps(VENUES)};"
            "const label = 'Ethereum (ERC20)';"
            "const out = {};"
            "for (const v of venues) {"
            "  const at = (value, present = true, coin = 'USDT') => {"
            "    try { const r = m.resolveMinimum({ exchange: v, coin, networkLabel: label,"
            "      published: { present, value }, field: 'f' });"
            "      return [r.minimum.basis, r.minimum.value, r.minimum.venueMinimum, r.minimum.coin,"
            "        r.minimum.statement ?? null]; }"
            "    catch (e) { return [e.code]; } };"
            "  out[v] = { policy: m.operatorFallback(v, 'USDT'), absent: at(undefined, false),"
            "    zero: at('0'), lower: at('0.5'), higher: at('25'), nul: at(null), empty: at(''),"
            "    text: at('n/a'), negative: at('-1'), number: at(2),"
            "    usdcPolicy: m.operatorFallback(v, 'USDC'), usdcAbsent: at(undefined, false, 'USDC') };"
            "}"
            "out.coins = m.FALLBACK_POLICY.coins;"
            "out.other = [m.operatorFallback('hyperliquid', 'USDT'), m.operatorFallback('binance', 'DAI'),"
            "  m.operatorFallback('binance', 'usdt')];"
            "return out;"
        )["ok"]
        self.assertEqual(outcome["coins"], ["USDT"])
        self.assertEqual(sorted(key for key in outcome if key in VENUES), sorted(VENUES))
        for venue in VENUES:
            with self.subTest(venue=venue):
                row = outcome[venue]
                self.assertEqual(
                    (row["policy"]["value"], row["policy"]["coin"], row["policy"]["exchange"]),
                    (FALLBACK, "USDT", venue),
                )
                basis, value, venue_minimum, minimum_coin, statement = row["absent"]
                self.assertEqual(
                    (basis, value, venue_minimum, minimum_coin),
                    ("fundkit-operator-fallback", FALLBACK, "unknown", "USDT"),
                )
                self.assertIn("publishes no deposit minimum for USDT on Ethereum (ERC20)", statement)
                self.assertIn(f"{FALLBACK} USDT is Fundkit's operator fallback, not a", statement)
                self.assertIn("does not guarantee the credit", statement)
                # An authoritative venue value wins whatever it is, 0 included; never "unknown".
                for case, expected in (("zero", "0"), ("lower", "0.5"), ("higher", "25"), ("number", "2")):
                    self.assertEqual(row[case][:4], ["venue", expected, expected, "USDT"], case)
                for case in ("nul", "empty", "text", "negative"):
                    self.assertEqual(row[case], ["DESTINATION_MINIMUM_UNREADABLE"], case)
                # No coin but USDT has a fallback: a USDC minimum is never assumed.
                self.assertIsNone(row["usdcPolicy"])
                self.assertEqual(row["usdcAbsent"], ["DESTINATION_MINIMUM_UNDOCUMENTED"])
        self.assertEqual(outcome["other"], [None, None, None])

    def test_positive_credit_is_required_even_with_a_zero_venue_minimum(self):
        for credit, expected in (("0", "CREDIT_NOT_POSITIVE"), ("0.000000000001", None)):
            with self.subTest(credit=credit):
                outcome = minimum_js(
                    "const p = d.parseDecimal;"
                    f"m.checkDestinationMinimum(p('{credit}'), {{ depositMin: 0n,"
                    " minimum: m.venueMinimum(0n, 'f', 'USDT') }, 'Bybit', 'USDT');"
                )
                self.assertEqual(outcome.get("code"), expected, outcome)

    # ------------------------------------------------------------------ native, end to end

    def setUp(self) -> None:
        super().setUp()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15")
        self.write_fixtures()

    def prepare(self, host: T3Host, request: dict) -> dict:
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", request)
        self.assertFalse(is_error, body)
        return body

    def stored_plan(self, plan_id: str) -> dict:
        return json.loads((self.home / f".local/state/fundkit/plans/{plan_id}.json").read_text())

    def test_inclusive_boundary_end_to_end(self):
        self.start_session()
        host = self.t3()
        self.fixtures["bybit"] = bybit_fixtures(withdraw_fee="0.15", withdraw_min="0.0001")
        self.write_fixtures()
        base = {"from": "Bybit", "to": "Binance", "network": "BSC"}
        below = self.prepare(host, {**base, "amount": str(FALLBACK_UNITS - STEP)})
        self.assertEqual(below["status"], "hold", below)
        self.assertEqual([r["code"] for r in below["reasons"]], ["BELOW_DEPOSIT_MIN"])
        self.assertIn("0.9999 USDT, below Fundkit's operator fallback minimum", below["reasons"][0]["detail"])
        equal = self.prepare(host, {**base, "amount": FALLBACK})
        self.assertEqual(equal["status"], "ready", equal)
        self.assertEqual((equal["plan"]["credit"], equal["plan"]["amount"]), (FALLBACK, f"{FALLBACK} USDT"))
        self.assertEqual((host.cards, self.dispatches()), ([], []))

    def test_bybit_destination_venue_minimum_and_missing_field(self):
        self.start_session()
        host = self.t3(decisions=["approve", "approve"])
        cases = {
            # Bybit's own depositMin, whatever its value: no recheck.
            "1": ("venue", "1", False),
            "0": ("venue", "0", False),
            "350": ("hold", "BELOW_DEPOSIT_MIN", None),
            # The field absent from an otherwise healthy row: the operator fallback, rechecked.
            None: ("fundkit-operator-fallback", FALLBACK, True),
            # Present but not exact: hold, never the fallback.
            "": ("hold", "DESTINATION_MINIMUM_UNREADABLE", None),
        }
        for deposit_min, (basis, value, recheck) in cases.items():
            with self.subTest(depositMin=deposit_min):
                self.fixtures["bybit"] = bybit_fixtures(deposit_min=deposit_min)
                self.write_fixtures()
                body = self.prepare(host, {**REVERSE, "network": "BSC"})
                if basis == "hold":
                    self.assertEqual(body["status"], "hold", body)
                    self.assertEqual([r["code"] for r in body["reasons"]], [value])
                    continue
                self.assertEqual(body["status"], "ready", body)
                self.assertEqual(body["plan"]["recipient"], BYBIT_BSC)
                self.assertEqual(body["plan"]["credit"], "299.71\u2013300")
                stored = self.stored_plan(body["planId"])
                minimum = stored["destination"]["minimum"]
                self.assertEqual(
                    (minimum["basis"], minimum["value"], minimum["coin"]), (basis, value, "USDT")
                )
                self.assertEqual("recheck" in stored["destination"], recheck)
                if basis == "venue":
                    self.assertEqual(minimum["venueMinimum"], value)
                else:
                    self.assertEqual(minimum["venueMinimum"], "unknown")
                    self.assertIn("Bybit publishes no deposit minimum for USDT", minimum["statement"])
        # A fallback plan on Bybit is read again: a minimum that appears before the card stops it.
        self.fixtures["bybit"] = bybit_fixtures(deposit_min=None)
        self.write_fixtures()
        body = self.prepare(host, {**REVERSE, "network": "BSC"})
        self.fixtures["bybit"] = bybit_fixtures(deposit_min="1")
        self.write_fixtures()
        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": body["planId"]})
        self.assertEqual((result["status"], result["reason"]), ("not-sent", "DESTINATION_RECHECK_FAILED"))
        self.assertIn("now 1 USDT (venue)", result["detail"])
        self.assertEqual((host.cards, self.dispatches()), ([], []))

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
