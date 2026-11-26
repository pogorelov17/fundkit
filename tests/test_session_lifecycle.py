"""Session lifecycle: no session, the private terminal step, token errors, ends and reconnects."""

from __future__ import annotations

import json
import queue
import signal
import subprocess
import sys
import threading
import time
import unittest

from tests.support import (
    FUNDKIT,
    METADATA_NAMES,
    NODE,
    OTHER_TOKEN,
    TOKEN,
    SessionTestCase,
    key_check,
    wait_for,
    withdraw_args,
)

TOOL_NAMES = [
    "fundkit_deposit_address",
    "fundkit_transfer_prepare",
    "fundkit_transfer_confirm",
    "fundkit_transfer_status",
    "fundkit_profiles",
    "fundkit_connect",
    "fundkit_read",
    "fundkit_write",
    "fundkit_disconnect",
]


class NoSessionTests(SessionTestCase):
    def test_clean_install_is_lazy_and_explains_the_private_step(self):
        host = self.host()
        tools = [tool["name"] for tool in host.request("tools/list", {})["result"]["tools"]]
        self.assertEqual(tools, TOOL_NAMES)
        self.assertIn("SKILL.md", host.instructions)
        self.assertIn("переведи 300 USDT с OKX на Bybit", host.instructions)  # noqa: RUF001 (Russian on purpose)

        body, is_error = host.tool("fundkit_profiles", {"from": "OKX", "to": "Bybit"})
        self.assertFalse(is_error)
        self.assertEqual(body["session"], "none")
        self.assertIn("fundkit session", body["userStep"])
        self.assertIn("passphrase", body["userStep"])
        routes = [(need["exchange"], need["role"], need["alias"]) for need in body["needs"]]
        self.assertEqual(
            routes,
            [
                ("okx", "source", "okx-src"),
                ("bybit", "deposit-only", "bybit-dst"),
                ("bybit", "settlement", "bybit-settle"),
            ],
        )

        body, is_error = host.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "NO_SESSION")
        self.assertEqual(self.doppler.requests, [])
        self.assertEqual(self.events(), [])
        self.assertFalse(self.run_dir.exists() and any(self.run_dir.iterdir()))

    def test_existing_profiles_need_no_session(self):
        # A host whose route profiles are already registered never touches fundkit: starting,
        # listing and health-checking the broker opens no session and no prompt.
        host = self.host()
        host.request("tools/list", {})
        host.request("ping", {})
        host.close()
        self.assertEqual(self.doppler.requests, [])
        self.assertFalse((self.run_dir / "session.sock").exists())


class PrivateTerminalTests(SessionTestCase):
    def test_cancel_and_bad_tokens_store_nothing(self):
        terminal = self.terminal()
        terminal.read_until("Doppler service token: ")
        terminal.type(TOKEN[:12])
        terminal.type(b"\x03")  # Ctrl-C at the prompt
        self.assertEqual(terminal.wait(), 130)
        self.assertNotIn(TOKEN[:12], terminal.text)  # nothing echoed

        terminal = self.terminal()
        terminal.read_until("Doppler service token: ")
        terminal.type("dp.pt.personaltoken" + "x" * 40 + "\r")  # a personal token is refused unsent
        self.assertEqual(terminal.wait(), 2)

        terminal = self.terminal()
        terminal.read_until("Doppler service token: ")
        terminal.type("dp.st.dev." + "Q" * 40 + "\r")  # well-formed but unknown
        self.assertEqual(terminal.wait(), 3)
        self.assertIn("rejected", terminal.text)

        self.assertEqual([request["names"] for request in self.doppler.requests], [METADATA_NAMES])
        self.assertFalse((self.run_dir / "session.sock").exists())

        # No terminal at all: refused, and the token is never read from stdin.
        completed = subprocess.run(
            [NODE, str(FUNDKIT), "session"],
            env=self.env,
            input=(TOKEN + "\n").encode(),
            capture_output=True,
            start_new_session=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn(b"No terminal", completed.stderr)
        self.assertEqual(len(self.doppler.requests), 1)
        self.assert_no_files_with_secrets()

    def test_usage_errors_are_refused_before_any_prompt(self):
        for args, message in [
            (["--writes"], "--writes needs an explicit --max-transfer"),
            (["--ttl", "soon"], "bad duration"),
            (["--passphrase", "bybit"], "--passphrase accepts okx, bitget, kucoin"),
            (["--allow-provisioning", "okx"], "--allow-provisioning accepts gate, whitebit"),
            (["--max-transfer"], "--max-transfer needs a value"),
        ]:
            with self.subTest(args=args):
                terminal = self.terminal("session", *args)
                self.assertEqual(terminal.wait(), 2)
                self.assertIn(message, terminal.text)
        self.assertEqual(self.doppler.requests, [])

    def test_wrapped_host_launch_drops_doppler_variables(self):
        # `fundkit session -- <host>`: prompt first, then the host; its environment has no token.
        record = self.tmp / "hostenv.json"
        script = (
            "import json,os,sys,time; json.dump(sorted(os.environ), open(sys.argv[1],'w')); time.sleep(1)"
        )
        terminal = self.terminal("session", "--", sys.executable, "-I", "-c", script, str(record))
        terminal.read_until("Doppler service token: ")
        terminal.type(TOKEN + "\r")
        self.assertEqual(terminal.wait(), 0)
        self.assertNotIn("DOPPLER_TOKEN", json.loads(record.read_text()))
        self.assertIn("the host exited", terminal.text)
        self.assertFalse((self.run_dir / "session.sock").exists())


class SessionEndTests(SessionTestCase):
    def test_expired_token_ends_the_session_and_a_new_one_reconnects(self):
        terminal = self.session()
        host = self.host()
        body, is_error = host.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        self.assertFalse(is_error, body)
        pid = self.events("start")[0]["pid"]

        self.doppler.valid_tokens.discard(TOKEN)  # the token expires or is revoked in Doppler
        body, is_error = host.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "TOKEN_REJECTED")
        self.assertIn("fundkit session", body["userStep"])
        self.assertEqual(terminal.wait(), 3)
        wait_for(lambda: not self.alive(pid), what="bybit-dst to stop")
        _, is_error = host.tool("fundkit_read", {"alias": "bybit-dst", "tool": "list_accounts"})
        self.assertTrue(is_error)
        body, _ = host.tool("fundkit_profiles")
        self.assertEqual(body["session"], "none")
        self.assertIn("rejected", body["note"])

        # Reconnect: a new private terminal step, the same running host, no host restart.
        self.doppler.valid_tokens.add(TOKEN)
        second = self.session()
        body, _ = host.tool("fundkit_profiles")
        self.assertEqual(body["session"], "active")
        self.assertEqual(body["profiles"], [])  # nothing carried over from the old session
        body, is_error = host.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        self.assertFalse(is_error, body)
        _, is_error = host.tool("fundkit_read", {"alias": "bybit-dst", "tool": "list_accounts"})
        self.assertFalse(is_error)
        self.assert_no_leaks(host.all_text(), terminal.text, second.text)

    def test_ttl_hangup_and_stop_clean_up(self):
        def connect_and_pid(host):
            host.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
            return self.events("start")[-1]["pid"]

        terminal = self.session("--ttl", "3s")
        host = self.host()
        pid = connect_and_pid(host)
        self.assertEqual(terminal.wait(10), 0)
        self.assertIn("session time limit reached", terminal.text)
        wait_for(lambda: not self.alive(pid), what="profile after ttl")

        terminal = self.session()  # the terminal is closed (SIGHUP)
        pid = connect_and_pid(host)
        terminal.kill(signal.SIGHUP)
        terminal.wait()
        wait_for(lambda: not self.alive(pid), what="profile after SIGHUP")

        terminal = self.session()  # fundkit stop
        pid = connect_and_pid(host)
        status = self.run_cli("status")
        self.assertEqual(
            [profile["alias"] for profile in json.loads(status.stdout)["profiles"]], ["binance-src"]
        )
        self.assert_no_leaks(status.stdout)
        self.run_cli("stop")
        self.assertEqual(terminal.wait(), 0)
        wait_for(lambda: not self.alive(pid), what="profile after stop")
        self.assertFalse((self.run_dir / "profiles").exists())
        self.assert_no_files_with_secrets()

    def test_doppler_ignoring_the_filter_is_refused_and_outages_keep_the_session(self):
        terminal = self.session()
        host = self.host()
        self.doppler.ignore_filter = True
        body, is_error = host.tool("fundkit_connect", {"exchange": "bybit", "role": "source"})
        self.assertTrue(is_error)
        self.assertEqual(body["error"], "DOPPLER_UNEXPECTED_SECRETS")
        self.assertEqual(self.events(), [])

        self.doppler.ignore_filter = False
        self.doppler.fail_status = 503
        body, _ = host.tool("fundkit_connect", {"exchange": "bybit", "role": "source"})
        self.assertEqual(body["error"], "DOPPLER_UNAVAILABLE")
        self.assertIsNone(terminal.poll())  # a transient outage keeps the session
        self.assert_no_leaks(host.all_text(), terminal.text)

    def test_an_alias_belongs_to_one_host_session(self):
        terminal = self.session("--keep")
        first, second = self.host(), self.host()
        _, is_error = first.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertFalse(is_error)
        body, _ = second.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertEqual(body["error"], "ALIAS_IN_USE")
        body, _ = second.tool(
            "fundkit_read",
            {"alias": "binance-src", "tool": "get_balance", "arguments": {"account": "binance-src"}},
        )
        self.assertEqual(body["error"], "UNKNOWN_ALIAS")
        first.close()
        time.sleep(0.5)
        self.assertIsNone(terminal.poll())  # --keep: the session outlives the host session
        body, is_error = second.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertFalse(is_error, body)
        _, is_error = second.tool("fundkit_disconnect", {"alias": "binance-src"})
        self.assertFalse(is_error)

    def test_session_end_during_an_open_write_reports_an_unknown_outcome(self):
        terminal = self.session("--writes", "--max-transfer", "300")
        host = self.host()
        host.tool("fundkit_connect", {"exchange": "bybit", "role": "source"})
        host.tool("fundkit_read", key_check("bybit", "bybit-src"))
        outcome: queue.Queue = queue.Queue()
        host.form_answer = None  # the human never answers the form; then the session ends

        def withdraw():
            arguments = withdraw_args("bybit-src", amount=1)
            outcome.put(
                host.tool(
                    "fundkit_write",
                    {"alias": "bybit-src", "tool": "withdraw", "arguments": arguments},
                )
            )

        threading.Thread(target=withdraw, daemon=True).start()
        wait_for(lambda: len(host.forms) == 1, what="the native form")
        terminal.kill(signal.SIGTERM)
        body, is_error = outcome.get(timeout=10)
        self.assertTrue(is_error)
        self.assertIn("outcome is unknown", body["message"])

    def test_a_second_session_is_refused_while_one_runs(self):
        self.session()
        terminal = self.terminal()
        self.assertEqual(terminal.wait(), 1)
        self.assertIn("already active", terminal.text)
        self.assertNotIn(OTHER_TOKEN, terminal.text)


if __name__ == "__main__":
    unittest.main()
