"""Local roles on one key per exchange: what a profile forwards, key checks without UIDs, native forms."""

from __future__ import annotations

import json
import socket
import unittest

from tests.support import (
    DOPPLER_CONFIG,
    PASSPHRASES,
    REDACTED_MARK,
    SessionTestCase,
    doppler_names,
    key_check,
    sha256,
    withdraw_args,
)

TRANSFER = {"code": "USDT", "amount": 50, "fromAccount": "funding", "toAccount": "unified"}


def recipient_read(exchange: str, alias: str) -> dict:
    method = {
        "bybit": "privateGetV5AssetDepositQueryAddress",
        "okx": "privateGetAssetDepositAddress",
        "gate": "privateWalletGetDepositAddress",
    }[exchange]
    return {
        "alias": alias,
        "tool": "call_implicit_get",
        "arguments": {"exchange": exchange, "account": alias, "method": method, "params": {"coin": "USDT"}},
    }


class RoleReversalTests(SessionTestCase):
    def connect(self, host, exchange, role):
        body, is_error = host.tool("fundkit_connect", {"exchange": exchange, "role": role})
        self.assertFalse(is_error, body)
        return body

    def test_one_key_serves_source_and_destination_when_routes_reverse(self):
        terminal = self.session("--passphrase", "okx", passphrases={"okx": PASSPHRASES["okx"]})
        host = self.host()
        # Route 1: OKX -> Bybit.  Route 2, same session: Bybit -> OKX.
        self.connect(host, "okx", "source")
        self.connect(host, "bybit", "deposit-only")
        self.connect(host, "bybit", "source")
        okx_dst = self.connect(host, "okx", "deposit-only")
        self.assertEqual(okx_dst["account"]["sameAccountAs"], ["okx-src"])
        self.assertIn("Not verified by fundkit", okx_dst["keyCapability"])
        self.assertEqual(okx_dst["roleScope"]["moneyTools"], [])
        self.assertTrue(okx_dst["dryRun"])

        starts = self.starts()
        for exchange in ("okx", "bybit"):
            apikey, secret = doppler_names(exchange)
            source, destination = starts[f"{exchange}-src"], starts[f"{exchange}-dst"]
            for name in (apikey, secret):
                self.assertEqual(source["envHashes"][name], sha256(DOPPLER_CONFIG[name]))
                self.assertEqual(destination["envHashes"][name], source["envHashes"][name])
        self.assertEqual(starts["okx-dst"]["config"]["accounts"]["okx-dst"]["dryRun"], True)
        self.assertEqual(
            self.doppler.secret_requests(),
            [doppler_names("okx"), doppler_names("bybit"), doppler_names("bybit"), doppler_names("okx")],
        )

        # The destination role reads its own recipient after the key check, and moves nothing.
        body, _ = host.tool("fundkit_read", recipient_read("okx", "okx-dst"))
        self.assertEqual(body["error"], "KEY_CHECK_REQUIRED")
        host.tool("fundkit_read", key_check("okx", "okx-dst"))
        body, is_error = host.tool("fundkit_read", recipient_read("okx", "okx-dst"))
        self.assertFalse(is_error, body)
        self.assertEqual(body["data"]["echoed"], REDACTED_MARK)  # an echoed key comes back redacted
        self.assertIn(REDACTED_MARK, body["data"]["nested"])
        self.assertIn(REDACTED_MARK, body["data"]["url"])
        for tool, arguments in [
            ("withdraw", withdraw_args("okx-dst")),
            ("transfer", {"account": "okx-dst", **TRANSFER}),
        ]:
            body, is_error = host.tool(
                "fundkit_write", {"alias": "okx-dst", "tool": tool, "arguments": arguments}
            )
            self.assertTrue(is_error)
            self.assertEqual(body["error"], "ROLE_DENIED")
            self.assertIn("deposit-only", body["message"])
        # The source role of the same key does not read recipients.
        host.tool("fundkit_read", key_check("okx", "okx-src"))
        body, _ = host.tool("fundkit_read", recipient_read("okx", "okx-src"))
        self.assertEqual(body["error"], "ROLE_DENIED")
        self.assertEqual(self.calls("withdraw") + self.calls("transfer"), [])
        self.assert_no_leaks(host.all_text(), terminal.text)
        self.assert_no_files_with_secrets()

    def test_uids_in_key_metadata_are_never_kept_or_compared(self):
        # One Doppler config is one account per exchange, and the operator's mapping is trusted:
        # a key check whose metadata names another UID changes nothing.
        self.session("--writes", "--max-transfer", "300")
        host = self.host()
        self.connect(host, "bybit", "source")
        host.tool("fundkit_read", key_check("bybit", "bybit-src"))
        self.set_account_uid("bybit", "UID-BYBIT-OTHER")
        connected = self.connect(host, "bybit", "deposit-only")
        self.assertIn("does not read, store or compare an account UID", connected["account"]["note"])
        self.assertNotIn("UID", json.dumps(connected["venueScope"]))
        host.tool("fundkit_read", key_check("bybit", "bybit-dst"))
        body, is_error = host.tool("fundkit_read", recipient_read("bybit", "bybit-dst"))
        self.assertFalse(is_error, body)
        body, is_error = host.tool(
            "fundkit_write",
            {"alias": "bybit-src", "tool": "withdraw", "arguments": withdraw_args("bybit-src")},
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["id"], "W-1")
        self.assertEqual(len(host.forms), 1)
        profiles = json.loads(self.run_cli("status").stdout)["profiles"]
        self.assertEqual(
            {p["alias"]: p["keyChecked"] for p in profiles}, {"bybit-src": True, "bybit-dst": True}
        )
        self.assertNotIn("UID", self.run_cli("status").stdout)
        self.assertNotIn("uid", json.dumps(profiles))


class DeniedSurfaceTests(SessionTestCase):
    def setUp(self):
        super().setUp()
        self.terminal_ = self.session("--writes", "--max-transfer", "300")
        self.host_ = self.host()
        for role in ("deposit-only", "settlement", "source"):
            body, is_error = self.host_.tool("fundkit_connect", {"exchange": "bybit", "role": role})
            self.assertFalse(is_error, body)
            self.host_.tool("fundkit_read", key_check("bybit", body["alias"]))

    def read(self, alias, tool, arguments):
        return self.host_.tool("fundkit_read", {"alias": alias, "tool": tool, "arguments": arguments})

    def test_deposit_only_forwards_no_write_on_any_surface(self):
        alias = "bybit-dst"
        cases = [
            ("withdraw", withdraw_args(alias), "NOT_FORWARDED"),
            ("transfer", {"account": alias, **TRANSFER}, "NOT_FORWARDED"),
            ("get_deposit_address", {"account": alias, "code": "USDT"}, "NOT_FORWARDED"),
            (
                "call_write_method",
                {"exchange": "bybit", "account": alias, "method": "withdraw"},
                "NOT_FORWARDED",
            ),
            (
                "call_implicit_write",
                {"exchange": "bybit", "account": alias, "method": "privatePostV5AssetWithdrawCreate"},
                "NOT_FORWARDED",
            ),
            ("create_order", {"account": alias, "symbol": "BTC/USDT"}, "NOT_FORWARDED"),
            (
                "call_read_method",
                {"exchange": "bybit", "account": alias, "method": "createDepositAddress"},
                "ROLE_DENIED",
            ),
            (
                "call_read_method",
                {"exchange": "bybit", "account": alias, "method": "fetchWithdrawals"},
                "ROLE_DENIED",
            ),
            (
                "call_implicit_get",
                {"exchange": "bybit", "account": alias, "method": "privatePostV5AssetTransferInterTransfer"},
                "ROLE_DENIED",
            ),
            (
                "call_implicit_get",
                {"exchange": "bybit", "account": alias, "method": "privateGetV5AssetWithdrawQueryRecord"},
                "ROLE_DENIED",
            ),
            ("get_orders", {"account": alias}, "ROLE_DENIED"),
            ("call_implicit_get", {"exchange": "okx", "method": "privateGetAccountConfig"}, "WRONG_EXCHANGE"),
            ("get_balance", {"account": "bybit-src"}, "WRONG_ACCOUNT"),
        ]
        for tool, arguments, code in cases:
            with self.subTest(tool=tool, method=arguments.get("method")):
                body, is_error = self.read(alias, tool, arguments)
                self.assertTrue(is_error)
                self.assertEqual(body["error"], code)
        for tool in ("withdraw", "transfer"):
            body, _ = self.host_.tool(
                "fundkit_write", {"alias": alias, "tool": tool, "arguments": withdraw_args(alias)}
            )
            self.assertEqual(body["error"], "ROLE_DENIED")
        forwarded = {
            (call["name"], call["args"].get("method"))
            for call in self.calls()
            if call["args"].get("account") == alias
        }
        self.assertEqual(forwarded, {("call_implicit_get", "privateGetV5UserQueryApi")})  # only the key check

    def test_deposit_only_allows_its_reads(self):
        alias = "bybit-dst"
        for tool, arguments in [
            ("get_safety_status", {}),
            ("list_accounts", {}),
            ("get_balance", {"account": alias}),
            (
                "call_read_method",
                {
                    "exchange": "bybit",
                    "account": alias,
                    "method": "fetchDepositWithdrawFee",
                    "args": ["USDT"],
                },
            ),
            (
                "call_read_method",
                {
                    "exchange": "bybit",
                    "account": alias,
                    "method": "fetchDeposits",
                    "args": ["USDT", None, 20],
                },
            ),
            (
                "call_read_method",
                {
                    "exchange": "bybit",
                    "account": alias,
                    "method": "fetchDepositAddressesByNetwork",
                    "args": ["USDT"],
                },
            ),
        ]:
            with self.subTest(tool=tool, method=arguments.get("method")):
                body, is_error = self.read(alias, tool, arguments)
                self.assertFalse(is_error, body)

    def test_settlement_transfers_but_never_withdraws(self):
        alias = "bybit-settle"
        body, _ = self.host_.tool(
            "fundkit_write", {"alias": alias, "tool": "withdraw", "arguments": withdraw_args(alias)}
        )
        self.assertEqual(body["error"], "ROLE_DENIED")
        body, _ = self.read(alias, "call_implicit_get", recipient_read("bybit", alias)["arguments"])
        self.assertEqual(body["error"], "ROLE_DENIED")
        body, is_error = self.host_.tool(
            "fundkit_write",
            {"alias": alias, "tool": "transfer", "arguments": {"account": alias, **TRANSFER}},
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["id"], "T-1")
        self.assertEqual(
            [call["name"] for call in self.calls() if call["name"] in ("withdraw", "transfer")], ["transfer"]
        )

    def test_money_moves_need_no_uid_and_ignore_an_old_callers_uid(self):
        alias = "bybit-src"
        arguments = withdraw_args(alias)
        body, _ = self.host_.tool(
            "fundkit_write",
            {"alias": alias, "tool": "withdraw", "arguments": {**arguments, "account": "bybit-dst"}},
        )
        self.assertEqual(body["error"], "WRONG_ACCOUNT")
        self.assertEqual(self.calls("withdraw"), [])
        self.assertEqual(self.host_.forms, [])
        body, is_error = self.host_.tool(
            "fundkit_write", {"alias": alias, "tool": "withdraw", "arguments": arguments}
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["id"], "W-1")
        # An older caller still sending a uid, even one that differs from the key metadata: ignored.
        body, is_error = self.host_.tool(
            "fundkit_write",
            {"alias": alias, "tool": "withdraw", "uid": "UID-BYBIT-2", "arguments": arguments},
        )
        self.assertFalse(is_error, body)
        self.assertEqual(len(self.host_.forms), 2)
        self.assertEqual([call["args"] for call in self.calls("withdraw")], [arguments, arguments])
        tool = next(
            t for t in self.host_.request("tools/list", {})["result"]["tools"] if t["name"] == "fundkit_write"
        )
        self.assertNotIn("uid", tool["inputSchema"]["properties"])
        self.assertEqual(tool["inputSchema"]["required"], ["alias", "tool", "arguments"])

    def test_the_daemon_enforces_roles_without_the_broker(self):
        # Anything else that talks to the control socket gets the same decisions.
        with socket.socket(socket.AF_UNIX) as control:
            control.connect(str(self.run_dir / "session.sock"))
            stream = control.makefile("rwb")

            def send(message):
                stream.write(json.dumps(message).encode() + b"\n")
                stream.flush()

            def receive_until(predicate):
                while True:
                    message = json.loads(stream.readline())
                    if predicate(message):
                        return message

            send({"t": "hello", "id": 1, "host": "raw"})
            receive_until(lambda m: m.get("t") == "hello")
            send({"t": "connect", "id": 2, "exchange": "binance", "role": "deposit-only"})
            receive_until(lambda m: m.get("t") in ("connected", "error"))
            call = {"name": "withdraw", "arguments": withdraw_args("binance-dst")}
            send(
                {
                    "t": "rpc",
                    "alias": "binance-dst",
                    "call": {"channel": "write", "uid": "x"},
                    "msg": {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": call},
                }
            )
            reply = receive_until(lambda m: m.get("t") == "rpc" and m["msg"].get("id") == 7)
            self.assertTrue(reply["msg"]["result"]["isError"])
            self.assertEqual(json.loads(reply["msg"]["result"]["content"][0]["text"])["error"], "ROLE_DENIED")
            send(
                {
                    "t": "rpc",
                    "alias": "binance-dst",
                    "msg": {"jsonrpc": "2.0", "id": 8, "method": "resources/read", "params": {}},
                }
            )
            reply = receive_until(lambda m: m.get("t") == "rpc" and m["msg"].get("id") == 8)
            self.assertEqual(reply["msg"]["error"]["code"], -32601)
            stream.close()
        self.assertEqual(self.calls("withdraw"), [])


class VenueScopeTests(SessionTestCase):
    def test_provisioning_reads_need_the_operator_flag(self):
        self.session()
        host = self.host()
        host.tool("fundkit_connect", {"exchange": "gate", "role": "deposit-only"})
        body, _ = host.tool("fundkit_read", recipient_read("gate", "gate-dst"))
        self.assertEqual(body["error"], "PROVISIONING_NOT_AUTHORIZED")
        self.assertIn("--allow-provisioning gate", body["message"])
        self.run_cli("stop")
        self.terminals[-1].wait()

        self.session("--allow-provisioning", "gate")
        host = self.host()
        connected, _ = host.tool("fundkit_connect", {"exchange": "gate", "role": "deposit-only"})
        self.assertTrue(any("key read shows no key permissions" in note for note in connected["venueScope"]))
        body, _ = host.tool("fundkit_read", recipient_read("gate", "gate-dst"))
        self.assertEqual(body["error"], "KEY_CHECK_REQUIRED")
        host.tool("fundkit_read", key_check("gate", "gate-dst"))
        body, is_error = host.tool("fundkit_read", recipient_read("gate", "gate-dst"))
        self.assertFalse(is_error, body)

    def test_whitebit_money_moves_reach_the_native_form_without_a_key_identity(self):
        # WhiteBIT has no key read. That no longer blocks withdraw or transfer at fundkit; the
        # route gates (SKILL.md: source balance not visible, so a WhiteBIT-source plan holds) and
        # the human's form still decide.
        self.session("--writes", "--max-transfer", "300")
        host = self.host()
        connected, _ = host.tool("fundkit_connect", {"exchange": "whitebit", "role": "source"})
        self.assertTrue(any("no key read" in note for note in connected["venueScope"]))
        self.assertTrue(any("available amount is not visible" in note for note in connected["venueScope"]))
        self.assertNotIn("UID", json.dumps(connected["venueScope"]))
        write = {"alias": "whitebit-src", "tool": "withdraw", "arguments": withdraw_args("whitebit-src")}
        host.form_answer = "decline"
        body, _ = host.tool("fundkit_write", write)
        self.assertEqual(body["code"], "CONFIRM_DECLINED")
        host.form_answer = "accept"
        body, is_error = host.tool("fundkit_write", write)
        self.assertFalse(is_error, body)
        self.assertEqual(body["id"], "W-1")
        self.assertEqual(len(host.forms), 2)

        settle, _ = host.tool("fundkit_connect", {"exchange": "whitebit", "role": "settlement"})
        self.assertEqual(settle["roleScope"]["moneyTools"], ["transfer"])
        transfer = {"account": "whitebit-settle", **TRANSFER}
        body, is_error = host.tool(
            "fundkit_write", {"alias": "whitebit-settle", "tool": "transfer", "arguments": transfer}
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["id"], "T-1")
        body, _ = host.tool(
            "fundkit_write",
            {"alias": "whitebit-settle", "tool": "withdraw", "arguments": withdraw_args("whitebit-settle")},
        )
        self.assertEqual(body["error"], "ROLE_DENIED")

        host.tool("fundkit_connect", {"exchange": "whitebit", "role": "deposit-only"})
        body, _ = host.tool(
            "fundkit_write",
            {"alias": "whitebit-dst", "tool": "withdraw", "arguments": withdraw_args("whitebit-dst")},
        )
        self.assertEqual(body["error"], "ROLE_DENIED")
        self.assertEqual([event["name"] for event in self.events("dispatch")], ["withdraw", "transfer"])


class KeyCheckTests(SessionTestCase):
    def test_key_check_gates_without_any_uid_and_uid_only_reads_are_not_forwarded(self):
        self.session("--writes", "--max-transfer", "300")
        host = self.host()
        for exchange in ("binance", "bingx", "mexc"):
            host.tool("fundkit_connect", {"exchange": exchange, "role": "source"})
        binance = {"alias": "binance-src", "tool": "withdraw", "arguments": withdraw_args("binance-src")}
        body, _ = host.tool("fundkit_write", binance)
        self.assertEqual(body["error"], "KEY_CHECK_REQUIRED")
        self.assertIn("sapiGetAccountApiRestrictions", body["message"])
        self.assertNotIn("UID", body["message"])

        # A failed key check (wrong key) opens nothing.
        self.fail_key_check("binance")
        body, is_error = host.tool("fundkit_read", key_check("binance", "binance-src"))
        self.assertTrue(is_error)
        body, _ = host.tool("fundkit_write", binance)
        self.assertEqual(body["error"], "KEY_CHECK_REQUIRED")
        (self.home / "fake-key-check-errors.json").unlink()
        _, is_error = host.tool("fundkit_read", key_check("binance", "binance-src"))
        self.assertFalse(is_error)
        body, is_error = host.tool("fundkit_write", binance)
        self.assertFalse(is_error, body)

        # The reads whose only purpose is the UID are not forwarded, on any venue that has one.
        for exchange, method in [
            ("binance", "privateGetAccount"),
            ("bingx", "accountV1PrivateGetUid"),
            ("mexc", "spotPrivateGetUid"),
        ]:
            with self.subTest(exchange=exchange):
                alias = f"{exchange}-src"
                arguments = {"exchange": exchange, "account": alias, "method": method}
                body, _ = host.tool(
                    "fundkit_read", {"alias": alias, "tool": "call_implicit_get", "arguments": arguments}
                )
                self.assertEqual(body["error"], "NOT_FORWARDED")
                self.assertIn("does not bind profiles to UIDs", body["message"])
        uid_reads = {"privateGetAccount", "accountV1PrivateGetUid", "spotPrivateGetUid"}
        self.assertFalse([c for c in self.calls("call_implicit_get") if c["args"]["method"] in uid_reads])
        # The permission reads are the key check there, and a money move then needs nothing more.
        for exchange in ("bingx", "mexc"):
            alias = f"{exchange}-src"
            _, is_error = host.tool("fundkit_read", key_check(exchange, alias))
            self.assertFalse(is_error)
            body, is_error = host.tool(
                "fundkit_write", {"alias": alias, "tool": "withdraw", "arguments": withdraw_args(alias)}
            )
            self.assertFalse(is_error, body)
        self.assertEqual(len(self.events("dispatch")), 3)


class LimitsAndFormsTests(SessionTestCase):
    def test_writes_flag_caps_and_dry_run(self):
        self.session("--writes", "--max-transfer", "300", "--max-daily", "600")
        host = self.host()
        for role in ("source", "deposit-only", "settlement"):
            host.tool("fundkit_connect", {"exchange": "bybit", "role": role})
        accounts = {alias: start["config"]["accounts"][alias] for alias, start in self.starts().items()}
        source = accounts["bybit-src"]
        self.assertEqual(
            (source["dryRun"], source["maxTransferValue"], source["maxDailyValue"]), (False, 300, 600)
        )
        self.assertEqual(
            (accounts["bybit-settle"]["dryRun"], accounts["bybit-settle"]["maxTransferValue"]), (False, 300)
        )
        self.assertEqual(
            (accounts["bybit-dst"]["dryRun"], accounts["bybit-dst"]["maxTransferValue"]), (True, 10)
        )
        self.assertTrue(all(account["confirm"] == "always" for account in accounts.values()))

    def test_native_form_is_forwarded_and_the_human_decides(self):
        terminal = self.session()
        host = self.host()
        host.tool("fundkit_connect", {"exchange": "bybit", "role": "source"})
        status, _ = host.tool("fundkit_read", {"alias": "bybit-src", "tool": "get_safety_status"})
        self.assertTrue(status["elicitationSupported"])  # the host's form capability reaches ccxt-mcp
        self.assertEqual(status["version"], "0.1.3")
        host.tool("fundkit_read", key_check("bybit", "bybit-src"))
        write = {"alias": "bybit-src", "tool": "withdraw", "arguments": withdraw_args("bybit-src")}

        host.form_answer = "decline"
        body, _ = host.tool("fundkit_write", write)
        self.assertEqual(body["code"], "CONFIRM_DECLINED")
        self.assertIn('Confirm: withdrawal on bybit (account "bybit-src", LIVE)', host.forms[0]["message"])
        host.form_answer = "accept"
        body, _ = host.tool("fundkit_write", write)
        self.assertEqual(body["dryRun"], True)  # no --writes: dryRun
        self.assertEqual(len(host.forms), 2)
        self.assertEqual(self.events("dispatch"), [])

        # A host without forms gets a token preview the skill never redeems.
        other = self.host(elicitation=False)
        other.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        status, _ = other.tool("fundkit_read", {"alias": "binance-src", "tool": "get_safety_status"})
        self.assertFalse(status["elicitationSupported"])
        self.assert_no_leaks(host.all_text(), other.all_text(), terminal.text)
        for start in self.starts().values():
            self.assert_no_leaks(json.dumps(start["argv"]))

        host.close()
        other.close()
        self.assertEqual(terminal.wait(), 0)
        self.assertIn("the host session ended", terminal.text)
        self.assertFalse((self.run_dir / "session.sock").exists())
        self.assertFalse((self.run_dir / "profiles").exists())
        self.assert_no_files_with_secrets()

    def test_read_arguments_pass_unchanged(self):
        self.session()
        host = self.host()
        host.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        arguments = {
            "exchange": "bybit",
            "account": "bybit-dst",
            "method": "fetchDeposits",
            "params": {"fakeDelayMs": 300},
        }
        body, is_error = host.tool(
            "fundkit_read", {"alias": "bybit-dst", "tool": "call_read_method", "arguments": arguments}
        )
        self.assertFalse(is_error, body)
        self.assertEqual(body["method"], "fetchDeposits")


if __name__ == "__main__":
    unittest.main()
