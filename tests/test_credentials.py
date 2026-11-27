"""Doppler names and API passphrases.

The user's Doppler config holds exactly <EXCHANGE>_APIKEY and <EXCHANGE>_SECRET per venue. OKX,
Bitget and KuCoin passphrases are typed by the operator in a private terminal, once per exchange
and session, and live only in memory.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import unittest
from pathlib import Path

from tests.support import (
    DECOYS,
    DOPPLER_CONFIG,
    EXCHANGES,
    METADATA_NAMES,
    NODE,
    PASSPHRASE_EXCHANGES,
    PASSPHRASES,
    ROOT,
    TOKEN,
    SessionTestCase,
    doppler_names,
    label,
    sha256,
    withdraw_args,
)


def passphrase_prompt(exchange: str) -> str:
    return f"{label(exchange)} API passphrase (for the key in {exchange.upper()}_APIKEY): "


class DopplerNameTests(SessionTestCase):
    def test_every_route_needs_exactly_the_two_plain_names(self):
        host = self.host()
        routes = 0
        for source in EXCHANGES:
            for destination in EXCHANGES:
                if source == destination:
                    continue
                routes += 1
                body, _ = host.tool("fundkit_profiles", {"from": source, "to": destination})
                for need in body["needs"]:
                    with self.subTest(source=source, destination=destination, role=need["role"]):
                        self.assertEqual(need["dopplerNames"], doppler_names(need["exchange"]))
                        has_passphrase = "passphrase" in need
                        self.assertEqual(has_passphrase, need["exchange"] in PASSPHRASE_EXCHANGES)
        self.assertEqual(routes, len(EXCHANGES) * (len(EXCHANGES) - 1))  # 56 directed CEX pairs
        body, _ = host.tool("fundkit_profiles")
        self.assertIn("<EXCHANGE>_APIKEY and <EXCHANGE>_SECRET", body["naming"])
        self.assertEqual(self.doppler.requests, [])  # route planning needs no session

    def test_connect_fetches_only_the_plain_names_and_forwards_only_them(self):
        terminal = self.session()
        host = self.host()
        for exchange, role in [("bybit", "deposit-only"), ("binance", "source"), ("gate", "settlement")]:
            body, is_error = host.tool("fundkit_connect", {"exchange": exchange, "role": role})
            self.assertFalse(is_error, body)
            self.assertEqual(body["fetchedNames"], doppler_names(exchange))
            self.assertEqual(body["account"]["credentials"], doppler_names(exchange))

        self.assertEqual(
            [request["names"] for request in self.doppler.requests],
            [METADATA_NAMES, doppler_names("bybit"), doppler_names("binance"), doppler_names("gate")],
        )
        self.assertTrue(all(request["token_hash"] == sha256(TOKEN) for request in self.doppler.requests))
        for alias, start in self.starts().items():
            exchange = alias.split("-")[0]
            apikey, secret = doppler_names(exchange)
            with self.subTest(alias=alias):
                self.assertEqual(
                    set(start["envNames"]) - {"LANG"}, {"PATH", "HOME", "CCXT_MCP_CONFIG", apikey, secret}
                )
                self.assertEqual(start["envHashes"][apikey], sha256(DOPPLER_CONFIG[apikey]))
                self.assertEqual(start["envHashes"][secret], sha256(DOPPLER_CONFIG[secret]))
                self.assertEqual(start["configMode"], "600")
                self.assertNotIn("apiKey", json.dumps(start["config"]))
        self.assert_no_leaks(host.all_text(), terminal.text, host.stderr.decode(errors="replace"))
        self.assert_no_files_with_secrets()

    def test_legacy_role_suffixed_names_are_not_aliases(self):
        # A config with only the old <EX>_SOURCE_* names does not satisfy the plain names.
        for name in doppler_names("okx"):
            self.doppler.config.pop(name)
        self.session()
        host = self.host()
        body, is_error = host.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "MISSING_SECRETS")
        self.assertEqual(body["missing"], doppler_names("okx"))
        requested = {name for names in self.doppler.secret_requests() for name in names}
        self.assertEqual(requested, set(doppler_names("okx")))
        self.assertTrue(requested.isdisjoint(DECOYS))
        self.assertEqual(self.events(), [])

    def test_one_missing_name_is_reported_and_the_session_survives(self):
        self.doppler.config.pop("BINANCE_SECRET")
        terminal = self.session()
        host = self.host()
        body, _ = host.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertEqual((body["error"], body["missing"]), ("MISSING_SECRETS", ["BINANCE_SECRET"]))
        self.assertIsNone(terminal.poll())
        self.doppler.config["BINANCE_SECRET"] = DOPPLER_CONFIG["BINANCE_SECRET"]
        _, is_error = host.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertFalse(is_error)

    def test_unknown_exchange_and_role(self):
        self.session()
        host = self.host()
        body, _ = host.tool("fundkit_connect", {"exchange": "hyperliquid", "role": "source"})
        self.assertEqual(body["error"], "UNKNOWN_EXCHANGE")
        body, _ = host.tool("fundkit_connect", {"exchange": "okx", "role": "admin"})
        self.assertEqual(body["error"], "UNKNOWN_ROLE")
        self.assertEqual(self.doppler.secret_requests(), [])


# Venues fundkit does not serve: other ccxt ids, near misses of supported ids, an alias used as an
# exchange name, and the watch-only Hyperliquid. Supported ones are matched exactly, not by prefix.
UNLISTED_VENUES = [
    "kraken",
    "htx",
    "binanceus",
    "okxus",
    "Binance US",
    "okx-src",
    "gate.io.example",
    "hyperliquid",
]
LABELS = {
    "binance": "Binance",
    "bybit": "Bybit",
    "gate": "Gate",
    "okx": "OKX",
    "bitget": "Bitget",
    "whitebit": "WhiteBIT",
    "mexc": "MEXC",
    "kucoin": "KuCoin",
}


def venue_registries() -> dict:
    """The venue registries of lib/, evaluated in node."""
    modules = {
        name: (ROOT / "lib" / path).as_uri()
        for name, path in [("e", "exchanges.mjs"), ("m", "venues/minimum.mjs"), ("p", "policy.mjs")]
    }
    script = (
        "".join(f"const {name} = await import({json.dumps(uri)});" for name, uri in modules.items())
        + f"const unlisted = {json.dumps(UNLISTED_VENUES)};"
        "const ids = Object.keys(e.EXCHANGES);"
        "const minimum = (v) => { try { m.resolveMinimum({ exchange: v, coin: 'USDT',"
        "  networkLabel: 'x', published: { present: false }, field: 'f' }); return 'resolved'; }"
        "  catch (err) { return err.code; } };"
        "console.log(JSON.stringify({"
        "  ids, labels: Object.fromEntries(ids.map((v) => [v, e.exchangeLabel(v)])),"
        "  passphrase: e.PASSPHRASE_EXCHANGES, destinations: Object.keys(m.DESTINATIONS),"
        "  keyCheck: ids.filter((v) => p.hasKeyCheck(v)),"
        "  spellings: Object.fromEntries(ids.flatMap((v) => [v, v.toUpperCase(), ` ${e.exchangeLabel(v)} `]"
        "    .map((s) => [s, e.normalizeExchange(s)]))),"
        "  synonyms: ['gate.io', 'gateio', 'kucoin.com', 'binance.com'].map((s) => e.normalizeExchange(s)),"
        "  unlisted: unlisted.map((v) => [e.normalizeExchange(v), p.hasKeyCheck(v), minimum(v)]),"
        "}));"
    )
    result = subprocess.run(
        [NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30, check=True
    )
    return json.loads(result.stdout)


class SupportedVenueTests(SessionTestCase):
    """Fundkit serves exactly the eight CEX venues; any other is refused before a secret or a call."""

    def test_the_registries_hold_exactly_the_supported_venues(self):
        registries = venue_registries()
        self.assertEqual(registries["ids"], EXCHANGES)
        self.assertEqual(registries["labels"], LABELS)
        self.assertEqual(registries["passphrase"], PASSPHRASE_EXCHANGES)
        self.assertEqual(sorted(registries["destinations"]), sorted(EXCHANGES))
        self.assertEqual(registries["keyCheck"], [v for v in EXCHANGES if v != "whitebit"])
        for spelling, exchange in registries["spellings"].items():
            with self.subTest(spelling=spelling):
                self.assertEqual(exchange, spelling.strip().lower())
        self.assertEqual(registries["synonyms"], ["gate", "gate", "kucoin", "binance"])
        for venue, (exchange, key_check, minimum) in zip(
            UNLISTED_VENUES, registries["unlisted"], strict=True
        ):
            with self.subTest(venue=venue):
                self.assertEqual((exchange, key_check, minimum), (None, False, "VENUE_NOT_SUPPORTED"))

    def test_session_options_and_the_passphrase_command_refuse_unlisted_venues(self):
        for venue in UNLISTED_VENUES:
            with self.subTest(venue=venue):
                for option, allowed in (
                    ("--passphrase", "okx, bitget, kucoin"),
                    ("--allow-provisioning", "gate, whitebit"),
                ):
                    terminal = self.terminal("session", option, venue)
                    self.assertEqual(terminal.wait(), 2)
                    self.assertIn(f"{option} accepts {allowed}", terminal.text)
                terminal = self.terminal("passphrase", venue)
                self.assertEqual(terminal.wait(), 2)
                self.assertIn("usage: fundkit passphrase <okx|bitget|kucoin>", terminal.text)
        self.assertEqual(self.doppler.requests, [])

    def test_unlisted_venues_and_external_registrations_are_refused_before_secrets_or_calls(self):
        # An external registration: Doppler names for an unlisted venue, and a ccxt-mcp profile for it
        # left in the run directory by something other than this session.
        for venue in ("kraken", "htx"):
            for name in doppler_names(venue):
                self.doppler.config[name] = f"SYNTH-{name}"
        self.session("--writes", "--max-transfer", "300")
        stale = self.run_dir / "profiles" / "kraken-src"
        stale.mkdir(parents=True, mode=0o700)
        (stale / "config.json").write_text(
            json.dumps(
                {"accounts": {"kraken-src": {"exchange": "kraken", "apiKey": "SYNTH", "secret": "SYNTH"}}}
            )
        )
        host = self.host()
        for venue in UNLISTED_VENUES:
            for role in ("source", "deposit-only", "settlement"):
                with self.subTest(venue=venue, role=role):
                    body, is_error = host.tool("fundkit_connect", {"exchange": venue, "role": role})
                    self.assertTrue(is_error)
                    self.assertEqual(body["error"], "UNKNOWN_EXCHANGE")
            with self.subTest(venue=venue, tool="fundkit_profiles"):
                body, _ = host.tool("fundkit_profiles", {"from": venue, "to": "binance"})
                unlisted = body["needs"][0]
                self.assertEqual((unlisted["exchange"], unlisted["error"]), (venue, "unsupported exchange"))
                self.assertNotIn("dopplerNames", unlisted)
                self.assertEqual({need.get("exchange") for need in body["needs"][1:]}, {"binance"})
        self.assertEqual(self.doppler.secret_requests(), [])

        # Calls addressed to the unregistered alias, or to another venue through a connected profile.
        _, is_error = host.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertFalse(is_error)
        for channel, tool, arguments in [
            ("fundkit_read", "get_balance", {"account": "kraken-src"}),
            (
                "fundkit_read",
                "call_implicit_get",
                {"exchange": "kraken", "account": "kraken-src", "method": "x"},
            ),
            ("fundkit_write", "withdraw", withdraw_args("kraken-src")),
        ]:
            with self.subTest(channel=channel, tool=tool):
                body, is_error = host.tool(
                    channel, {"alias": "kraken-src", "tool": tool, "arguments": arguments}
                )
                self.assertTrue(is_error)
                self.assertEqual(body["error"], "UNKNOWN_ALIAS")
        for arguments, code in [
            ({"exchange": "kraken", "account": "binance-src", "method": "fetchBalance"}, "WRONG_EXCHANGE"),
            ({"exchange": "binance", "account": "kraken-src", "method": "fetchBalance"}, "WRONG_ACCOUNT"),
        ]:
            with self.subTest(code=code):
                body, is_error = host.tool(
                    "fundkit_read",
                    {"alias": "binance-src", "tool": "call_read_method", "arguments": arguments},
                )
                self.assertTrue(is_error)
                self.assertEqual(body["error"], code)
        body, is_error = host.tool(
            "fundkit_write",
            {"alias": "binance-src", "tool": "withdraw", "arguments": withdraw_args("kraken-src")},
        )
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "WRONG_ACCOUNT")

        self.assertEqual(self.doppler.secret_requests(), [doppler_names("binance")])
        self.assertEqual(set(self.starts()), {"binance-src"})
        self.assertEqual(
            [c for c in self.calls() if c["name"] not in ("get_safety_status", "list_accounts")], []
        )
        self.assertEqual(self.events("dispatch"), [])


class PassphraseTests(SessionTestCase):
    def connect_with_terminal_passphrase(self, host, terminal, exchange, role="source"):
        """Connect, answer the session terminal's passphrase prompt, connect again."""
        mark = len(terminal.output)
        body, is_error = host.tool("fundkit_connect", {"exchange": exchange, "role": role})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "PASSPHRASE_NEEDED")
        self.assertIn("terminal where fundkit session runs", body["userStep"])
        terminal.read_until(passphrase_prompt(exchange), start=mark)
        terminal.type(PASSPHRASES[exchange] + "\r")
        terminal.read_until("kept in memory for this session", start=mark)
        body, is_error = host.tool("fundkit_connect", {"exchange": exchange, "role": role})
        self.assertFalse(is_error, body)
        return body

    def test_all_three_venues_ask_in_the_session_terminal_and_never_read_doppler_for_it(self):
        terminal = self.session()
        host = self.host()
        for exchange in PASSPHRASE_EXCHANGES:
            with self.subTest(exchange=exchange):
                body = self.connect_with_terminal_passphrase(host, terminal, exchange)
                self.assertIn(
                    "API passphrase (private terminal, memory only)", body["account"]["credentials"]
                )
                start = self.starts()[f"{exchange}-src"]
                password = f"{exchange.upper()}_PASSWORD"
                self.assertEqual(start["envHashes"][password], sha256(PASSPHRASES[exchange]))
                self.assertNotEqual(start["envHashes"][password], sha256(DECOYS["OKX_PASSWORD"]))

        # Doppler was asked only for the plain pairs: never OKX_PASSWORD or any third name.
        for names in self.doppler.secret_requests():
            self.assertEqual(len(names), 2)
            self.assertTrue(all(name.endswith(("_APIKEY", "_SECRET")) for name in names))
        # Typed input never echoes, and nothing reaches the host or a file.
        self.assert_no_leaks(terminal.text, host.all_text(), host.stderr.decode(errors="replace"))
        self.assert_no_files_with_secrets()
        self.assert_environ_free_of_secrets(host.process.pid)
        self.assert_environ_free_of_secrets(terminal.pid)

    def test_the_passphrase_is_asked_once_per_exchange_and_session(self):
        terminal = self.session()
        host = self.host()
        self.connect_with_terminal_passphrase(host, terminal, "okx", role="source")
        mark = len(terminal.output)
        body, is_error = host.tool("fundkit_connect", {"exchange": "okx", "role": "deposit-only"})
        self.assertFalse(is_error, body)
        self.assertNotIn(passphrase_prompt("okx").encode(), terminal.output[mark:])
        self.assertEqual(terminal.text.count(passphrase_prompt("okx")), 1)
        starts = self.starts()
        self.assertEqual(
            starts["okx-src"]["envHashes"]["OKX_PASSWORD"], starts["okx-dst"]["envHashes"]["OKX_PASSWORD"]
        )

    def test_cancel_and_empty_input_start_nothing_and_are_reported_once(self):
        terminal = self.session()
        host = self.host()
        # Ctrl-C, and Ctrl-U (wipe) followed by Enter on the now empty line.
        for keys in (b"\x03", b"\x15\r"):
            with self.subTest(keys=keys):
                mark = len(terminal.output)
                body, _ = host.tool("fundkit_connect", {"exchange": "kucoin", "role": "deposit-only"})
                self.assertEqual(body["error"], "PASSPHRASE_NEEDED")
                terminal.read_until(passphrase_prompt("kucoin"), start=mark)
                terminal.type(PASSPHRASES["kucoin"][:6])
                terminal.type(keys)
                terminal.read_until("KuCoin passphrase: ", start=mark)
                body, is_error = host.tool("fundkit_connect", {"exchange": "kucoin", "role": "deposit-only"})
                self.assertTrue(is_error)
                self.assertEqual(body["error"], "PASSPHRASE_CANCELLED")
                self.assertIn("fundkit passphrase kucoin", body["userStep"])
        self.assertIsNone(terminal.poll())  # Ctrl-C at a passphrase prompt does not end the session
        self.assertEqual(self.events("start"), [])
        self.assertNotIn(PASSPHRASES["kucoin"][:6], terminal.text)
        # After a reported cancel, the next connect asks again.
        self.connect_with_terminal_passphrase(host, terminal, "kucoin", role="deposit-only")

    def test_up_front_passphrases_for_a_wrapped_host(self):
        # `fundkit session --passphrase okx,bitget -- <host>`: asked before the host starts.
        script = "import time; time.sleep(30)"
        passphrases = {"okx": PASSPHRASES["okx"], "bitget": PASSPHRASES["bitget"]}
        terminal = self.session(
            "--passphrase", "okx,bitget", "--", sys.executable, "-I", "-c", script, passphrases=passphrases
        )
        host = self.host()
        for exchange in ("okx", "bitget"):
            body, is_error = host.tool("fundkit_connect", {"exchange": exchange, "role": "deposit-only"})
            self.assertFalse(is_error, body)
        hashes = {alias: start["envHashes"] for alias, start in self.starts().items()}
        self.assertEqual(hashes["okx-dst"]["OKX_PASSWORD"], sha256(PASSPHRASES["okx"]))
        self.assertEqual(hashes["bitget-dst"]["BITGET_PASSWORD"], sha256(PASSPHRASES["bitget"]))
        self.run_cli("stop")
        terminal.wait(40)
        self.assert_no_leaks(terminal.text, host.all_text())
        self.assert_no_files_with_secrets()

    def test_wrapped_host_gets_the_passphrase_from_a_second_terminal(self):
        script = "import time; time.sleep(30)"
        terminal = self.session("--", sys.executable, "-I", "-c", script)
        host = self.host()
        body, is_error = host.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "PASSPHRASE_NEEDED")
        self.assertIn("fundkit passphrase okx", body["userStep"])
        self.assertNotIn(passphrase_prompt("okx"), terminal.text)  # the host owns that terminal

        second = self.terminal("passphrase", "okx")
        second.read_until(passphrase_prompt("okx"))
        second.type(PASSPHRASES["okx"] + "\r")
        self.assertEqual(second.wait(), 0)
        self.assertIn("memory only", second.text)
        body, is_error = host.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertFalse(is_error, body)
        self.assertEqual(self.starts()["okx-src"]["envHashes"]["OKX_PASSWORD"], sha256(PASSPHRASES["okx"]))
        self.run_cli("stop")
        terminal.wait(40)
        self.assert_no_leaks(terminal.text, second.text, host.all_text())
        self.assert_no_files_with_secrets()

    def test_passphrase_command_refusals(self):
        terminal = self.terminal("passphrase", "bybit")  # no passphrase on this venue
        self.assertEqual(terminal.wait(), 2)
        terminal = self.terminal("passphrase", "okx")  # no session
        self.assertEqual(terminal.wait(), 1)
        self.assertIn("no fundkit session", terminal.text)

    def test_a_host_broker_cannot_hand_over_a_passphrase(self):
        self.session()
        with socket.socket(socket.AF_UNIX) as control:
            control.connect(str(self.run_dir / "session.sock"))
            control.sendall(b'{"t":"hello","id":1,"host":"intruder"}\n')
            control.sendall(
                json.dumps({"t": "passphrase", "id": 2, "exchange": "okx", "value": "x" * 12}).encode()
                + b"\n"
            )
            replies = b""
            while replies.count(b"\n") < 2:
                replies += control.recv(4096)
        answer = json.loads(replies.splitlines()[1])
        self.assertEqual((answer["t"], answer["code"]), ("error", "BAD_REQUEST"))

    def test_session_end_forgets_passphrases(self):
        terminal = self.session()
        host = self.host()
        self.connect_with_terminal_passphrase(host, terminal, "okx")
        self.run_cli("stop")
        terminal.wait()
        self.session()
        body, _ = host.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertEqual(body["error"], "PASSPHRASE_NEEDED")
        self.assertFalse(Path(self.run_dir, "profiles").exists())
        self.assert_no_files_with_secrets()


if __name__ == "__main__":
    unittest.main()
