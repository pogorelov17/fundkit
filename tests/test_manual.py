"""The credentials choice and manual entry on a T3-shaped host.

Before any secret card, a request that lacks credentials gets exactly one choice: a Doppler
Service Token (first, the default) or entering the exchange API credentials manually. Manual
entry uses one private card per value (API key, API secret, and the API passphrase for OKX,
Bitget and KuCoin), never touches Doppler, and keeps the values in the session's memory for
the chat that entered them. All offline and synthetic: mock Doppler on loopback, the synthetic
ccxt-mcp, the T3 emulation in tests/native_support.py.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from tests.native_support import (
    BINANCE_BSC,
    BYBIT_BSC,
    T3Host,
    binance_fixtures,
    cancel_card,
    choose,
    params_key,
    resume,
    submit_card,
    t3_secret_file,
)
from tests.support import (
    DOPPLER_CONFIG,
    FUNDKIT,
    NODE,
    OTHER_TOKEN,
    TOKEN,
    sha256,
    spellings,
    synthetic,
    wait_for,
)
from tests.test_native import ADDRESS_REQUEST, NativeTestCase

MANUAL = {
    "binance": {
        "apiKey": synthetic("manual-binance-key"),
        "secret": synthetic("manual-binance-secret") + '"\\/&=+',
    },
    "bybit": {"apiKey": synthetic("manual-bybit-key"), "secret": synthetic("manual-bybit-secret")},
    "okx": {
        "apiKey": synthetic("manual-okx-key"),
        "secret": synthetic("manual-okx-secret"),
        "passphrase": synthetic("manual okx pass") + " !#",
    },
}
OTHER_BINANCE = {"apiKey": synthetic("chat-b-binance-key"), "secret": synthetic("chat-b-binance-secret")}
LABELS = {
    "Binance": "binance",
    "Bybit": "bybit",
    "OKX": "okx",
}
FIELDS = {"API key": "apiKey", "API secret": "secret", "API passphrase": "passphrase"}
ENV_NAMES = {"apiKey": "APIKEY", "secret": "SECRET", "passphrase": "PASSWORD"}
SEED_PHRASE = " ".join(["abandon"] * 11 + ["about"])
EVM_KEY = "0x" + "4c0883a69102937d6231471b5dbb6204fe512961708279f2e3e8a5d4b8e3a9f1"
BYBIT_FROM = {"from": "Bybit", "to": "Binance", "amount": "300"}
BINANCE_FROM = {"from": "Binance", "to": "Bybit", "amount": "300"}


def field_of(step: dict) -> tuple[str, str]:
    """(exchange, field) of a manual card, from its label, e.g. "Binance API secret"."""
    venue, field = step["request"]["label"].split(" ", 1)
    return LABELS[venue], FIELDS[field]


def manual_values() -> list[str]:
    values = [value for fields in MANUAL.values() for value in fields.values()]
    return [*values, *OTHER_BINANCE.values()]


class ManualTestCase(NativeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.paths: list[Path] = []
        self.labels: list[str] = []

    def enter(self, host: T3Host, body: dict, values: dict | None = None) -> dict:
        """Select manual entry in `body`'s choiceStep and fill every card it opens."""
        chosen, is_error = choose(host, body, "manual")
        self.assertFalse(is_error, chosen)
        return self.fill(host, chosen, values)

    def fill(self, host: T3Host, body: dict, values: dict | None = None) -> dict:
        while body.get("status") == "secret-needed":
            step = body["secretStep"]
            self.assertEqual(step["request"]["delivery"], "file")
            self.assertNotIn("Doppler", json.dumps(step["request"]))  # manual cards never mention it
            exchange, field = field_of(step)
            self.labels.append(step["request"]["label"])
            value = (values or MANUAL)[exchange][field] if exchange in (values or MANUAL) else None
            if value is None:
                value = MANUAL[exchange][field]
            body, is_error, path = submit_card(host, self.tmp, step, value)
            self.paths.append(path)
            self.assertFalse(is_error, body)
            self.assertFalse(path.exists(), "a submitted card file is deleted")
        self.assertEqual(body["status"], "ready", body)
        return body

    def manual_address(self, host: T3Host, request=None, values=None) -> tuple[dict, str]:
        """No credentials yet: choose manual, fill Binance's two cards, resume the address."""
        body, is_error, _ = host.tool_full("fundkit_deposit_address", request or ADDRESS_REQUEST)
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
        ready = self.enter(host, body, values)
        address, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, address)
        self.assertEqual(address["status"], "verified")
        return address, ready["credentials"]

    def start_of(self, prefix: str) -> dict:
        """The latest start of a profile whose alias begins with `prefix`."""
        starts = [event for event in self.events("start") if event["alias"].startswith(prefix)]
        self.assertTrue(starts, f"no profile {prefix}*")
        return starts[-1]

    def leftover_cards(self) -> list[Path]:
        files = self.tmp / "t3-secrets" / "files"
        return sorted(files.iterdir()) if files.exists() else []

    def assert_manual_free(self, *texts: str) -> None:
        """No manual value in any transcript, output, file, argv or environment of fundkit's own."""
        self.assert_secret_free(*texts)
        blob = "\n".join([*texts, *self.outputs, *(host.all_text() for host in self.hosts)])
        blob += "\n".join(host.stderr.decode(errors="replace") for host in self.hosts)
        for value in manual_values():
            for form in spellings(value):
                self.assertNotIn(form, blob)
        for path in self.tmp.rglob("*"):
            if path.is_file() and not path.is_symlink() and "t3-secrets" not in path.parts:
                data = path.read_bytes()
                for value in manual_values():
                    self.assertNotIn(value.encode(), data, str(path))
        for pid in [*self.daemon_pids(), *(host.process.pid for host in self.hosts)]:
            for name in ("environ", "cmdline"):
                try:
                    data = Path(f"/proc/{pid}/{name}").read_bytes()
                except OSError:
                    continue
                for value in manual_values():
                    self.assertNotIn(value.encode(), data)

    def daemon_log(self) -> str:
        path = self.run_dir / "daemon.log"
        return path.read_text() if path.exists() else ""


# =========================================================================== the choice
class ChoiceTests(ManualTestCase):
    def test_one_choice_comes_first_and_nothing_starts_without_a_selection(self):
        host = self.t3()
        body, is_error, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
        choice = body["choiceStep"]
        self.assertNotIn("secretStep", body)
        self.assertEqual([option["id"] for option in choice["options"]], ["doppler", "manual"])
        self.assertTrue(choice["options"][0]["default"])
        self.assertIn("request_user_input", choice["hostTool"])
        self.assertIn("plain choice", choice["hostTool"])  # hosts without a selector ask in the chat
        rules = " ".join(choice["rules"])
        self.assertIn("No answer, a timeout, a cancel or a dismissal selects nothing", rules)
        self.assertIn("Never pick an option yourself", rules)
        self.assertIn("Doppler Service Token first", rules)
        self.assertIn("into the user's language", rules)  # one choice, asked in the user's language
        self.assertIn("Without one, do not ask this question", rules)
        self.assertIn("hostWithoutCard", choice)
        for option in choice["options"]:
            self.assertEqual(option["then"]["tool"], "fundkit_credentials")
            self.assertEqual(option["then"]["arguments"]["exchanges"], ["binance"])
            self.assertEqual(option["then"]["arguments"]["resume"], body["resume"])
        self.assertIn("API key, Binance API secret", choice["options"][1]["description"])

        # Nobody answers: nothing starts, nothing is read, no card exists.
        time.sleep(1)
        self.assertEqual(self.daemon_pids(), [])
        self.assertEqual(self.doppler.requests, [])
        self.assertFalse((self.run_dir / "session.sock").exists())
        self.assertEqual(self.events(), [])
        self.assertEqual(self.leftover_cards(), [])

        # A transfer asks once for both ends.
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", BINANCE_FROM)
        self.assertTrue(is_error)
        self.assertEqual(body["missing"], ["binance", "bybit"])
        self.assertEqual(
            body["choiceStep"]["options"][1]["then"]["arguments"]["exchanges"], ["binance", "bybit"]
        )
        self.assertEqual((body["status"], body["dispatch"]), ("hold", "none"))
        self.assertEqual(self.daemon_pids(), [])

    def test_existing_doppler_session_needs_no_choice(self):
        self.start_session()
        host = self.t3()
        body, is_error, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertFalse(is_error, body)
        self.assertEqual(body["status"], "verified")
        self.assertNotIn("choiceStep", body)
        self.assertEqual(self.doppler.secret_requests(), [["BINANCE_APIKEY", "BINANCE_SECRET"]])


# =========================================================================== manual entry
class ManualEntryTests(ManualTestCase):
    def test_manual_address_needs_no_doppler_and_keeps_values_private(self):
        host = self.t3()
        address, credentials = self.manual_address(host)
        self.assertEqual(address["address"], BINANCE_BSC)
        self.assertEqual(self.labels, ["Binance API key", "Binance API secret"])
        self.assertRegex(credentials, r"^cs-[0-9a-f]{32}$")
        self.assertEqual(self.doppler.requests, [])  # not even a token check

        start = self.start_of("binance-dst-m")
        self.assertRegex(start["alias"], r"^binance-dst-m[0-9a-f]{6}$")
        self.assertEqual(start["envHashes"]["BINANCE_APIKEY"], sha256(MANUAL["binance"]["apiKey"]))
        self.assertEqual(start["envHashes"]["BINANCE_SECRET"], sha256(MANUAL["binance"]["secret"]))
        self.assertEqual(
            set(start["envNames"]),
            {"BINANCE_APIKEY", "BINANCE_SECRET", "CCXT_MCP_CONFIG", "HOME", "LANG", "PATH"},
        )
        self.assertEqual(self.leftover_cards(), [])

        status = json.loads(self.run_cli("status").stdout)
        self.assertIsNone(status["doppler"])
        self.assertEqual(status["manual"], {"sets": 1, "venues": 1, "pendingSteps": 0})
        self.assertNotIn(credentials, json.dumps(status))  # the set id is not shown to other callers
        self.assertIn("Binance API key kept in memory", self.daemon_log())
        self.assert_manual_free()

    def test_transfer_collects_only_the_missing_venue_and_shares_it_across_roles(self):
        host = self.t3(decisions=["approve"])
        _, credentials = self.manual_address(host)  # Binance is already entered in this chat

        body, is_error, _ = host.tool_full(
            "fundkit_transfer_prepare", {**BINANCE_FROM, "credentials": credentials}
        )
        self.assertTrue(is_error)
        self.assertEqual(body["missing"], ["bybit"])
        self.assertEqual(body["choiceStep"]["options"][1]["then"]["arguments"]["exchanges"], ["bybit"])
        self.labels.clear()
        ready = self.enter(host, body)
        self.assertEqual(self.labels, ["Bybit API key", "Bybit API secret"])
        self.assertEqual(ready["credentials"], credentials)
        self.assertEqual(ready["resume"]["arguments"]["credentials"], credentials)
        self.assertEqual(host.cards, [])  # entering credentials opened no confirmation

        plan, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, plan)
        self.assertEqual(plan["status"], "ready", plan)
        self.assertEqual(plan["plan"]["recipient"], BYBIT_BSC)
        source = self.start_of("binance-src-m")
        destination = self.start_of("bybit-dst-m")
        reader = self.start_of("binance-dst-m")
        self.assertEqual(source["alias"][-7:], reader["alias"][-7:])  # one credential set, one tag
        self.assertEqual(source["envHashes"]["BINANCE_APIKEY"], sha256(MANUAL["binance"]["apiKey"]))
        self.assertEqual(reader["envHashes"]["BINANCE_APIKEY"], sha256(MANUAL["binance"]["apiKey"]))
        self.assertEqual(destination["envHashes"]["BYBIT_APIKEY"], sha256(MANUAL["bybit"]["apiKey"]))
        self.assertNotIn("BINANCE_APIKEY", destination["envNames"])
        self.assertTrue(source["config"]["accounts"][source["alias"]]["dryRun"])  # no write pre-approval

        result, is_error, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan["planId"]})
        self.assertFalse(is_error, result)
        self.assertEqual(result["status"], "sent", result)
        self.assertEqual(len(host.cards), 1)  # exactly the one plan card
        self.assertEqual(len(self.dispatches()), 1)
        planned = self.start_of(f"binance-{plan['planId'].lower()}")
        self.assertEqual(planned["envHashes"]["BINANCE_APIKEY"], sha256(MANUAL["binance"]["apiKey"]))
        again, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan["planId"]})
        self.assertTrue(again["duplicate"])
        self.assertEqual(len(self.dispatches()), 1)
        self.assertEqual(self.doppler.requests, [])
        self.assert_manual_free()

    def test_mixed_route_manual_destination_and_doppler_source(self):
        host = self.t3(decisions=["decline"])
        _, credentials = self.manual_address(host)  # Binance entered manually in this chat
        body, is_error, _ = host.tool_full(
            "fundkit_transfer_prepare", {**BYBIT_FROM, "credentials": credentials}
        )
        self.assertTrue(is_error)
        self.assertEqual(body["missing"], ["bybit"])
        chosen, _ = choose(host, body, "doppler")
        self.assertEqual(chosen["secretStep"]["request"]["label"], "Doppler Service Token")
        self.assertIn("BYBIT_APIKEY, BYBIT_SECRET", chosen["secretStep"]["request"]["reason"])
        ready, is_error, _ = submit_card(host, self.tmp, chosen["secretStep"], TOKEN)
        self.assertFalse(is_error, ready)
        plan, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, plan)
        self.assertEqual(plan["status"], "ready", plan)
        # Doppler was asked for Bybit's two names only; Binance came from the manual set.
        self.assertEqual(self.doppler.secret_requests(), [["BYBIT_APIKEY", "BYBIT_SECRET"]])
        self.assertEqual(
            self.starts()["bybit-src"]["envHashes"]["BYBIT_APIKEY"], sha256(DOPPLER_CONFIG["BYBIT_APIKEY"])
        )
        destination = self.start_of("binance-dst-m")
        self.assertEqual(destination["envHashes"]["BINANCE_APIKEY"], sha256(MANUAL["binance"]["apiKey"]))

        result, _, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan["planId"]})
        self.assertEqual(result["status"], "not-sent")
        self.assertEqual(self.dispatches(), [])
        # The destination recheck before the card read Binance with the same manual credentials.
        self.assertNotIn("binance-dst", self.starts())
        # Doppler served Bybit only (the reads and the plan's source profile), never Binance.
        self.assertEqual(
            {tuple(names) for names in self.doppler.secret_requests()}, {("BYBIT_APIKEY", "BYBIT_SECRET")}
        )

        # Doppler is connected now: a new chat without manual credentials gets no choice at all.
        other = self.t3()
        body, is_error, _ = other.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        self.assertFalse(is_error, body)
        self.assertEqual(
            self.starts()["binance-dst"]["envHashes"]["BINANCE_APIKEY"],
            sha256(DOPPLER_CONFIG["BINANCE_APIKEY"]),
        )
        self.assert_manual_free()

    def test_two_of_three_fields_then_cancel_keeps_nothing_and_retry_starts_over(self):
        host = self.t3()
        body, is_error, _ = host.tool_full("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
        self.assertIn("OKX API passphrase", body["choiceStep"]["options"][1]["description"])
        chosen, _ = choose(host, body, "manual")
        step = chosen["secretStep"]
        self.assertEqual((step["request"]["label"], step["progress"]), ("OKX API key", "OKX: 1 of 3"))
        stored, _, _ = submit_card(host, self.tmp, step, MANUAL["okx"]["apiKey"])
        self.assertEqual(stored["secretStep"]["request"]["label"], "OKX API secret")
        stored, _, _ = submit_card(host, self.tmp, stored["secretStep"], MANUAL["okx"]["secret"])
        step = stored["secretStep"]
        self.assertEqual((step["request"]["label"], step["progress"]), ("OKX API passphrase", "OKX: 3 of 3"))
        credentials = stored["credentials"]

        cancelled, is_error = cancel_card(host, step)
        self.assertFalse(is_error, cancelled)
        self.assertEqual((cancelled["status"], cancelled["discardedFields"]), ("cancelled", 2))
        self.assertEqual(
            [option["id"] for option in cancelled["choiceStep"]["options"]], ["doppler", "manual"]
        )
        # The late answer of the cancelled card is refused and its file removed.
        late, is_error, path = submit_card(host, self.tmp, step, MANUAL["okx"]["passphrase"])
        self.assertTrue(is_error)
        self.assertEqual(late["error"], "STEP_CANCELLED")
        self.assertFalse(path.exists())

        body, is_error, _ = host.tool_full(
            "fundkit_connect", {"exchange": "okx", "role": "source", "credentials": credentials}
        )
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "CREDENTIALS_NEEDED")  # no half entry was kept
        self.assertEqual(self.events("start"), [])

        ready = self.enter(host, cancelled)
        self.assertEqual(self.labels[-3:], ["OKX API key", "OKX API secret", "OKX API passphrase"])
        connected, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, connected)
        self.assertEqual(connected["credentials"], "manual")
        start = self.start_of("okx-src-m")
        self.assertEqual(start["envHashes"]["OKX_PASSWORD"], sha256(MANUAL["okx"]["passphrase"]))
        self.assertEqual(start["envHashes"]["OKX_SECRET"], sha256(MANUAL["okx"]["secret"]))

        # The same exchange in another role reuses the set: no card, the same values.
        again, is_error, _ = host.tool_full(
            "fundkit_connect",
            {"exchange": "okx", "role": "deposit-only", "credentials": ready["credentials"]},
        )
        self.assertFalse(is_error, again)
        self.assertEqual(again["account"]["sameAccountAs"], [start["alias"]])
        reader = self.start_of("okx-dst-m")
        self.assertEqual(
            reader["envHashes"], {**reader["envHashes"], "OKX_PASSWORD": start["envHashes"]["OKX_PASSWORD"]}
        )
        self.assertEqual(self.doppler.requests, [])
        self.assert_manual_free()

    def test_each_venue_asks_only_its_own_fields_in_order(self):
        # Bitget and KuCoin ask for the API passphrase as the third card; Gate (like Binance,
        # Bybit, WhiteBIT and MEXC) only for the API key and the API secret.
        extra = {
            "bitget": {
                "apiKey": synthetic("manual-bitget-key"),
                "secret": synthetic("manual-bitget-secret"),
                "passphrase": synthetic("manual bitget pass"),
            },
            "kucoin": {
                "apiKey": synthetic("manual-kucoin-key"),
                "secret": synthetic("manual-kucoin-secret"),
                "passphrase": synthetic("manual kucoin pass") + " ~",
            },
            "gate": {"apiKey": synthetic("manual-gate-key"), "secret": synthetic("manual-gate-secret")},
        }
        labels = {"Bitget": "bitget", "KuCoin": "kucoin", "Gate": "gate"}
        host = self.t3()
        credentials = None
        for exchange, fields in extra.items():
            with self.subTest(exchange=exchange):
                args = {"exchange": exchange, "role": "source"}
                if credentials:
                    args["credentials"] = credentials
                body, is_error, _ = host.tool_full("fundkit_connect", args)
                self.assertTrue(is_error)
                self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
                self.assertEqual(body["missing"], [exchange])
                chosen, is_error = choose(host, body, "manual")
                self.assertFalse(is_error, chosen)
                seen = []
                while chosen.get("status") == "secret-needed":
                    step = chosen["secretStep"]
                    venue, field = step["request"]["label"].split(" ", 1)
                    self.assertEqual(labels[venue], exchange)
                    seen.append(FIELDS[field])
                    chosen, is_error, path = submit_card(host, self.tmp, step, fields[FIELDS[field]])
                    self.assertFalse(is_error, chosen)
                    self.assertFalse(path.exists())
                self.assertEqual(seen, list(fields))
                self.assertEqual(chosen["status"], "ready")
                credentials = chosen["credentials"]
                connected, is_error, _ = resume(host, chosen)
                self.assertFalse(is_error, connected)
                start = self.start_of(f"{exchange}-src-m")
                upper = exchange.upper()
                expected = {f"{upper}_{ENV_NAMES[field]}" for field in fields}
                self.assertEqual(
                    set(start["envNames"]) - {"CCXT_MCP_CONFIG", "HOME", "LANG", "PATH"}, expected
                )
                for field, value in fields.items():
                    self.assertEqual(start["envHashes"][f"{upper}_{ENV_NAMES[field]}"], sha256(value))
        self.assertEqual(self.doppler.requests, [])
        log = self.daemon_log()
        blob = host.all_text() + log
        for fields in extra.values():
            for value in fields.values():
                for form in spellings(value):
                    self.assertNotIn(form, blob)

    def test_refused_values_are_retried_and_never_kept(self):
        host = self.t3()
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        chosen, _ = choose(host, body, "manual")
        step = chosen["secretStep"]
        for bad in (SEED_PHRASE, EVM_KEY, "short"):
            with self.subTest(bad=bad[:12]):
                refused, is_error, path = submit_card(host, self.tmp, step, bad)
                self.assertTrue(is_error)
                self.assertEqual(refused["error"], "VALUE_REFUSED")
                self.assertFalse(path.exists())
                step = refused["retry"]
                self.assertEqual(step["request"]["label"], "Binance API key")
        stored, _, _ = submit_card(host, self.tmp, step, MANUAL["binance"]["apiKey"])
        # The API key pasted again into the API secret card is refused too.
        refused, is_error, _ = submit_card(host, self.tmp, stored["secretStep"], MANUAL["binance"]["apiKey"])
        self.assertTrue(is_error)
        self.assertEqual(refused["error"], "VALUE_REFUSED")
        self.assertEqual(refused["retry"]["request"]["label"], "Binance API secret")
        ready, is_error, _ = submit_card(host, self.tmp, refused["retry"], MANUAL["binance"]["secret"])
        self.assertFalse(is_error, ready)
        address, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, address)
        log = self.daemon_log()
        self.assertNotIn("abandon", log)
        self.assertNotIn(EVM_KEY, log)
        self.assertNotIn("abandon", host.all_text())
        self.assert_manual_free()

    def test_rejected_manual_key_is_dropped_and_asked_for_again(self):
        key_check = params_key("call_implicit_get", "sapiGetAccountApiRestrictions")
        self.fixtures["binance"][key_check] = {
            "__error": {"code": "AUTH_FAILED", "message": "Invalid API-key"}
        }
        self.write_fixtures()
        host = self.t3()
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        ready = self.enter(host, body)
        rejected, is_error, _ = resume(host, ready)
        self.assertTrue(is_error)
        self.assertEqual(rejected["error"], "CREDENTIALS_REJECTED")
        self.assertIsNone(rejected["address"])
        self.assertEqual(
            [option["id"] for option in rejected["choiceStep"]["options"]], ["doppler", "manual"]
        )
        alias = self.start_of("binance-dst-m")["alias"]
        wait_for(
            lambda: alias not in [p["alias"] for p in json.loads(self.run_cli("status").stdout)["profiles"]]
        )

        again, is_error, _ = host.tool_full("fundkit_deposit_address", ready["resume"]["arguments"])
        self.assertTrue(is_error)
        self.assertEqual(again["error"], "CREDENTIALS_NEEDED")  # the rejected key is not reused

        self.fixtures["binance"] = binance_fixtures()
        self.write_fixtures()
        fixed = {"binance": OTHER_BINANCE}
        ready = self.enter(host, rejected, fixed)
        address, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, address)
        self.assertEqual(
            self.start_of("binance-dst-m")["envHashes"]["BINANCE_APIKEY"], sha256(OTHER_BINANCE["apiKey"])
        )
        self.assertEqual(self.doppler.requests, [])
        self.assert_manual_free()


# =========================================================================== Doppler path
class DopplerChoiceTests(ManualTestCase):
    def test_bad_or_rejected_token_offers_retry_or_manual_without_invalid_input(self):
        host = self.t3()
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        chosen, _ = choose(host, body, "doppler")
        refused, is_error, path = submit_card(host, self.tmp, chosen["secretStep"], "hello, not a token")
        self.assertTrue(is_error)
        self.assertEqual(refused["error"], "TOKEN_FORMAT")
        self.assertFalse(path.exists())
        self.assertEqual([option["id"] for option in refused["choiceStep"]["options"]], ["doppler", "manual"])
        self.assertEqual(self.doppler.requests, [])

        chosen, _ = choose(host, refused, "doppler")  # retry with another token
        rejected, is_error, _ = submit_card(host, self.tmp, chosen["secretStep"], "dp.st.dev." + "Q" * 40)
        self.assertTrue(is_error)
        self.assertEqual(rejected["error"], "TOKEN_REJECTED")
        self.assertEqual(len(self.doppler.requests), 1)  # the metadata check only

        ready = self.enter(host, rejected)  # switch to manual: no deliberately invalid input needed
        address, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, address)
        self.assertEqual(len(self.doppler.requests), 1)
        self.assert_manual_free()

    def test_cancelled_token_card_offers_the_choice_again(self):
        host = self.t3()
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        chosen, _ = choose(host, body, "doppler")
        cancelled, is_error = cancel_card(host, chosen["secretStep"])
        self.assertFalse(is_error, cancelled)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertIn("if the operator selects nothing, stop", cancelled["next"])
        chosen, _ = choose(host, cancelled, "doppler")
        ready, is_error, _ = submit_card(host, self.tmp, chosen["secretStep"], TOKEN)
        self.assertFalse(is_error, ready)
        address, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, address)
        self.assertEqual(self.doppler.secret_requests(), [["BINANCE_APIKEY", "BINANCE_SECRET"]])

    def test_revoked_token_drops_doppler_only_and_offers_the_choice(self):
        host = self.t3()
        _, credentials = self.manual_address(host)  # Binance manual in this chat
        body, _, _ = host.tool_full("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        chosen, _ = choose(host, body, "doppler")
        ready, _, _ = submit_card(host, self.tmp, chosen["secretStep"], TOKEN)
        connected, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, connected)

        self.doppler.valid_tokens.discard(TOKEN)  # revoked in Doppler
        body, is_error, _ = host.tool_full("fundkit_connect", {"exchange": "bybit", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "TOKEN_REJECTED")
        self.assertEqual([option["id"] for option in body["choiceStep"]["options"]], ["doppler", "manual"])
        status = json.loads(self.run_cli("status").stdout)
        self.assertIsNone(status["doppler"])
        self.assertEqual(status["manual"]["venues"], 1)  # the manual set survives
        address, is_error, _ = host.tool_full(
            "fundkit_deposit_address", {**ADDRESS_REQUEST, "credentials": credentials}
        )
        self.assertFalse(is_error, address)

        chosen, _ = choose(host, body, "doppler")
        ready, is_error, _ = submit_card(host, self.tmp, chosen["secretStep"], OTHER_TOKEN)
        self.assertFalse(is_error, ready)
        connected, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, connected)

    def test_cli_unlock_adds_doppler_to_a_manual_session(self):
        host = self.t3()
        self.manual_address(host)
        body = self.unlock(self.card())
        self.assertTrue(body["ok"], body)
        status = json.loads(self.run_cli("status").stdout)
        self.assertEqual(status["doppler"], {"project": "fundkit-test", "config": "prd"})
        self.assertEqual(status["manual"]["venues"], 1)
        self.assertEqual(len(self.daemon_pids()), 1)


# =========================================================================== isolation
class IsolationTests(ManualTestCase):
    def test_two_chats_never_share_manual_credentials(self):
        first = self.t3()
        second = self.t3()
        _, mine = self.manual_address(first)
        _, theirs = self.manual_address(second, values={"binance": OTHER_BINANCE})
        self.assertNotEqual(mine, theirs)
        readers = [event for event in self.events("start") if event["alias"].startswith("binance-dst-m")]
        self.assertEqual(len({event["alias"] for event in readers}), 2)
        self.assertEqual(
            {event["envHashes"]["BINANCE_APIKEY"] for event in readers},
            {sha256(MANUAL["binance"]["apiKey"]), sha256(OTHER_BINANCE["apiKey"])},
        )
        # Without its own set, or with an invented one, a chat gets the choice, not another's keys.
        for extra in ({}, {"credentials": "cs-" + "0" * 32}):
            with self.subTest(extra=extra):
                body, is_error, _ = second.tool_full("fundkit_deposit_address", {**ADDRESS_REQUEST, **extra})
                self.assertTrue(is_error)
                self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
        self.assertIn("gone", body["choiceStep"]["why"])

        # Two concurrent starts for the same set and exchange share one card.
        body, _, _ = first.tool_full(
            "fundkit_connect", {"exchange": "bybit", "role": "deposit-only", "credentials": mine}
        )
        option = body["choiceStep"]["options"][1]["then"]
        results = first.call_many(
            [(option["tool"], option["arguments"]), (option["tool"], option["arguments"])]
        )
        steps = {result[0]["secretStep"]["stepId"] for result in results}
        self.assertEqual(len(steps), 1)
        self.assertEqual(self.doppler.requests, [])
        self.assert_manual_free()

    def test_hostile_files_are_refused_untouched_and_the_card_stays_open(self):
        host = self.t3()
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        chosen, _ = choose(host, body, "manual")
        step = chosen["secretStep"]
        submit = step["submit"]

        def send(path) -> dict:
            result, is_error = host.tool(submit["tool"], {**submit["arguments"], "file": str(path)})
            self.assertTrue(is_error, result)
            self.assertEqual(result["retry"]["stepId"], step["stepId"])  # the card stays open
            return result

        target = t3_secret_file(self.tmp, MANUAL["binance"]["apiKey"])
        cards = target.parent
        link = cards / ("b" * 32)
        link.symlink_to(target)
        hard = cards / ("d" * 32)
        os.link(target, hard)
        fifo = cards / ("c" * 32)
        os.mkfifo(fifo, 0o600)
        folder = cards / ("e" * 32)
        folder.mkdir(mode=0o700)
        ssh = self.home / ".ssh"
        ssh.mkdir(mode=0o700)
        private_key = ssh / "id_ed25519"
        private_key.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n")
        private_key.chmod(0o600)
        stale = cards / ("f" * 32)
        stale.write_text(MANUAL["binance"]["apiKey"])
        stale.chmod(0o600)
        os.utime(stale, (time.time() - 3600, time.time() - 3600))
        cases = {
            link: "FILE_UNSAFE",
            hard: "FILE_UNSAFE",
            fifo: "FILE_UNSAFE",
            folder: "FILE_UNSAFE",
            private_key: "FILE_UNSAFE",
            stale: "FILE_STALE",
            Path("/proc/self/environ"): "FILE_UNSAFE",
            Path("relative/" + "a" * 32): "FILE_PATH",
            cards / ("a" * 31 + "/../" + "a" * 32): "FILE_UNSAFE",
        }
        for path, code in cases.items():
            with self.subTest(path=path.name):
                self.assertEqual(send(path)["error"], code)
        target.chmod(0o640)
        self.assertEqual(send(target)["error"], "FILE_UNSAFE")
        target.chmod(0o600)
        for path in (target, hard, stale, private_key):
            self.assertTrue(path.exists(), f"{path.name} must be left untouched")
        hard.unlink()

        stored, is_error = host.tool(submit["tool"], {**submit["arguments"], "file": str(target)})
        self.assertFalse(is_error, stored)
        self.assertFalse(target.exists())
        # A second file for the used card is removed unused; an unknown step leaves files alone.
        late, is_error, path = submit_card(host, self.tmp, step, MANUAL["binance"]["secret"])
        self.assertEqual(late["error"], "STEP_USED")
        self.assertFalse(path.exists())
        unknown = {**step, "submit": {"tool": submit["tool"], "arguments": {"stepId": "st-" + "1" * 32}}}
        missing, is_error, path = submit_card(host, self.tmp, unknown, MANUAL["binance"]["secret"])
        self.assertEqual(missing["error"], "STEP_UNKNOWN")
        self.assertTrue(path.exists())
        path.unlink()
        stale.unlink()
        self.assertEqual(self.doppler.requests, [])
        self.assert_manual_free()


# =========================================================================== lifetime
class LifetimeTests(ManualTestCase):
    def test_expired_set_and_restarted_session_ask_again(self):
        host = self.t3(FUNDKIT_CREDENTIAL_TTL_MS="4000")
        _, credentials = self.manual_address(host)
        time.sleep(4.5)
        body, is_error, _ = host.tool_full(
            "fundkit_deposit_address", {**ADDRESS_REQUEST, "credentials": credentials}
        )
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
        self.assertIn("gone", body["choiceStep"]["why"])
        ready = self.enter(host, body)
        self.assertNotEqual(ready["credentials"], credentials)

        self.stop_session()
        body, is_error, _ = host.tool_full("fundkit_deposit_address", ready["resume"]["arguments"])
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "CREDENTIALS_NEEDED")
        self.assertEqual(self.doppler.requests, [])

    def test_plan_whose_manual_credentials_expired_is_never_sent(self):
        ttl = 8.0
        host = self.t3(decisions=["approve"], FUNDKIT_CREDENTIAL_TTL_MS=str(int(ttl * 1000)))
        body, is_error, _ = host.tool_full("fundkit_transfer_prepare", BINANCE_FROM)
        self.assertTrue(is_error)
        entered = time.monotonic()
        ready = self.enter(host, body)
        plan, is_error, _ = resume(host, ready)
        self.assertFalse(is_error, plan)
        self.assertEqual(plan["status"], "ready", plan)
        time.sleep(max(0.0, ttl + 0.5 - (time.monotonic() - entered)))
        result, is_error, _ = host.tool_full("fundkit_transfer_confirm", {"planId": plan["planId"]})
        self.assertEqual(result["status"], "not-sent", result)
        self.assertEqual(result["reason"], "CREDENTIALS_CHANGED")
        self.assertEqual(self.dispatches(), [])
        self.assertEqual(self.doppler.requests, [])
        self.assert_manual_free()

    def test_expired_card_keeps_no_partial_entry_and_removes_the_late_file(self):
        host = self.t3(FUNDKIT_SECRET_STEP_TTL_MS="2500")
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        chosen, _ = choose(host, body, "manual")
        stored, _, _ = submit_card(host, self.tmp, chosen["secretStep"], MANUAL["binance"]["apiKey"])
        time.sleep(3)
        late, is_error, path = submit_card(host, self.tmp, stored["secretStep"], MANUAL["binance"]["secret"])
        self.assertTrue(is_error)
        self.assertEqual(late["error"], "STEP_EXPIRED")
        self.assertFalse(path.exists())
        self.assertEqual([option["id"] for option in late["choiceStep"]["options"]], ["doppler", "manual"])
        chosen, _ = choose(host, late, "manual")
        self.assertEqual(chosen["secretStep"]["request"]["label"], "Binance API key")  # starts over

    def test_background_session_ends_when_nothing_is_left(self):
        host = self.t3(FUNDKIT_IDLE_GRACE_MS="1000")
        body, _, _ = host.tool_full("fundkit_deposit_address", ADDRESS_REQUEST)
        chosen, _ = choose(host, body, "manual")
        self.assertEqual(len(self.daemon_pids()), 1)
        cancel_card(host, chosen["secretStep"])
        wait_for(lambda: not self.daemon_pids(), what="the idle session to end")
        self.assertFalse((self.run_dir / "session.sock").exists())
        status = subprocess.run(
            [NODE, str(FUNDKIT), "status"], env=self.host_env, capture_output=True, text=True, check=False
        )
        self.assertEqual(status.returncode, 1)
