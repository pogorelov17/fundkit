"""Shared fixtures for the offline fundkit session tests.

Everything is local and synthetic:
  * a disposable mock Doppler API on 127.0.0.1 (FUNDKIT_DOPPLER_API accepts loopback only),
  * the private terminal steps driven through real pseudo-terminals (pty.fork),
  * a simulated MCP host that launches `fundkit mcp` and answers native forms,
  * tests/fake_ccxt_mcp.mjs as the ccxt-mcp server (or the pinned real one, see
    tests/test_real_ccxt_mcp.py).
No real Doppler service, exchange key, passphrase or exchange is used.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pty
import secrets
import select
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FUNDKIT = ROOT / "bin" / "fundkit.mjs"
FAKE_CCXT_MCP = ROOT / "tests" / "fake_ccxt_mcp.mjs"
NODE = shutil.which("node")

TOKEN = "dp.st.dev." + "A1b2C3d4E5" * 4  # synthetic, in Doppler's service-token format
OTHER_TOKEN = "dp.st.dev." + "Z9y8X7w6V5" * 4
REDACTED_MARK = "[redacted:fundkit]"
METADATA_NAMES = ["DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"]
EXCHANGES = ["binance", "bybit", "gate", "okx", "bitget", "whitebit", "bingx", "mexc", "kucoin"]
PASSPHRASE_EXCHANGES = ["okx", "bitget", "kucoin"]


def synthetic(tag: str) -> str:
    return f"SYNTH-{tag}-{secrets.token_hex(8)}"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def doppler_names(exchange: str) -> list[str]:
    prefix = exchange.upper()
    return [f"{prefix}_APIKEY", f"{prefix}_SECRET"]


# The user's Doppler config: exactly two names per exchange. Secrets carry characters that
# JSON and URLs escape, so every redacted spelling is exercised.
DOPPLER_CONFIG = {}
for _exchange in EXCHANGES:
    _apikey, _secret = doppler_names(_exchange)
    DOPPLER_CONFIG[_apikey] = synthetic(f"{_exchange}-key")
    DOPPLER_CONFIG[_secret] = synthetic(f"{_exchange}-secret") + '"\\/&=+'

# Names that must never be requested: a passphrase slot, legacy role-suffixed names and an
# unrelated secret. Their values are checked for leaks like every other value.
DECOYS = {
    "OKX_PASSWORD": synthetic("decoy-okx-password"),
    "OKX_SOURCE_APIKEY": synthetic("decoy-legacy-key"),
    "OKX_SOURCE_PASSWORD": synthetic("decoy-legacy-pass"),
    "BYBIT_DEPOSIT_APIKEY": synthetic("decoy-legacy-bybit"),
    "UNRELATED_DB_PASSWORD": synthetic("decoy-db"),
}

# API passphrases the operator types; KuCoin's has a space to show spaces are kept.
PASSPHRASES = {
    "okx": synthetic("okx-pass") + "!#",
    "bitget": synthetic("bitget-pass"),
    "kucoin": synthetic("kucoin pass"),
}

ALL_SECRET_VALUES = [
    *DOPPLER_CONFIG.values(),
    *DECOYS.values(),
    *PASSPHRASES.values(),
    TOKEN,
    OTHER_TOKEN,
]


def spellings(value: str) -> list[str]:
    return [value, json.dumps(value)[1:-1], urllib.parse.quote(value, safe="")]


def wait_for(predicate, timeout: float = 10, what: str = "condition") -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


# --------------------------------------------------------------------------- mock Doppler
class MockDoppler:
    """The one endpoint fundkit uses, with the name filter Doppler documents."""

    def __init__(self) -> None:
        self.valid_tokens = {TOKEN, OTHER_TOKEN}
        self.config = {**DOPPLER_CONFIG, **DECOYS}
        self.requests: list[dict] = []
        self.ignore_filter = False
        self.fail_status: int | None = None
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def _handler(self):
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                url = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(url.query)
                auth = self.headers.get("Authorization", "")
                token = auth.removeprefix("Bearer ") if auth.startswith("Bearer ") else None
                names = query["secrets"][0].split(",") if "secrets" in query else None
                mock.requests.append({"path": url.path, "names": names, "token_hash": sha256(token or "")})
                if url.path != "/v3/configs/config/secrets/download":
                    return self._reply(404, {"messages": ["not found"]})
                if token not in mock.valid_tokens:
                    return self._reply(401, {"messages": ["Invalid Auth token"], "success": False})
                if mock.fail_status:
                    return self._reply(mock.fail_status, {"messages": ["boom"]})
                body = {
                    "DOPPLER_PROJECT": "fundkit-test",
                    "DOPPLER_CONFIG": "prd",
                    "DOPPLER_ENVIRONMENT": "prd",
                }
                if names is None or mock.ignore_filter:
                    body.update(mock.config)
                else:
                    body.update({name: mock.config[name] for name in names if name in mock.config})
                return self._reply(200, body)

            def _reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return Handler

    def secret_requests(self) -> list[list[str]]:
        """The name lists of every request other than the token's metadata check."""
        return [r["names"] for r in self.requests if r["names"] and r["names"] != METADATA_NAMES]

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


# --------------------------------------------------------------------------- private terminal
class Terminal:
    """A fundkit command on a real pseudo-terminal, as the operator would run it."""

    def __init__(self, env: dict, args=("session",)) -> None:
        self.output = b""
        self.status: int | None = None
        pid, fd = pty.fork()
        if pid == 0:  # child: becomes the command, with the pty as its controlling terminal
            os.execve(NODE, [NODE, str(FUNDKIT), *args], env)
        self.pid, self.fd = pid, fd

    @property
    def text(self) -> str:
        return self.output.decode(errors="replace")

    def _read_available(self, wait: float) -> bool:
        ready, _, _ = select.select([self.fd], [], [], wait)
        if not ready:
            return False
        try:
            chunk = os.read(self.fd, 4096)
        except OSError:
            chunk = b""
        self.output += chunk
        return bool(chunk)

    def read_until(self, needle: str, timeout: float = 15, start: int = 0) -> str:
        """Wait until `needle` appears in the output after byte offset `start`."""
        deadline = time.monotonic() + timeout
        while needle.encode() not in self.output[start:]:
            if time.monotonic() > deadline:
                raise AssertionError(f"terminal never showed {needle!r}; got {self.text!r}")
            if not self._read_available(0.1) and self.poll() is not None:
                raise AssertionError(f"terminal exited before {needle!r}: {self.text!r}")
        return self.text

    def type(self, keys: str | bytes) -> None:
        os.write(self.fd, keys.encode() if isinstance(keys, str) else keys)

    def poll(self) -> int | None:
        if self.status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = os.waitstatus_to_exitcode(status)
        return self.status

    def wait(self, timeout: float = 15) -> int:
        deadline = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() > deadline:
                raise AssertionError(f"command did not exit: {self.text!r}")
            self._read_available(0.1)
        while self._read_available(0.05):
            pass
        return self.status

    def kill(self, sig: int = signal.SIGTERM) -> None:
        if self.poll() is None:
            os.kill(self.pid, sig)

    def close(self) -> None:
        self.kill(signal.SIGKILL)
        with contextlib.suppress(AssertionError, ChildProcessError):
            self.wait(3)
        with contextlib.suppress(OSError):
            os.close(self.fd)


# --------------------------------------------------------------------------- simulated host
class Host:
    """Launches `fundkit mcp` the way Claude Code or Codex would, and answers native forms."""

    def __init__(self, env: dict, *, elicitation: bool = True, form_answer: str | None = "accept") -> None:
        self.process = subprocess.Popen(
            [NODE, str(FUNDKIT), "mcp"],
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.transcript: list[tuple[str, str]] = []  # every line, both directions, as a host would log it
        self.forms: list[dict] = []
        self.form_answer = form_answer
        self.stderr = b""
        self._responses: dict = {}
        self._changed = threading.Condition()
        self._next_id = 1
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        capabilities = {"elicitation": {"form": {}}} if elicitation else {}
        init = self.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": capabilities,
                "clientInfo": {"name": "sim-host", "version": "1"},
            },
        )
        self.instructions = init["result"].get("instructions", "")
        self.notify("notifications/initialized")

    def _read_stderr(self) -> None:
        for line in self.process.stderr:
            self.stderr += line

    def _read_stdout(self) -> None:
        for raw in self.process.stdout:
            line = raw.decode()
            self.transcript.append(("in", line))
            message = json.loads(line)
            if "method" in message and "id" in message:
                if message["method"] == "elicitation/create":
                    self._answer_form(message)
                continue
            with self._changed:
                self._responses[message.get("id")] = message
                self._changed.notify_all()

    def _answer_form(self, message: dict) -> None:
        self.forms.append(message["params"])
        if self.form_answer is None:  # the human never answers
            return
        accepted = self.form_answer == "accept"
        result = {"action": "accept", "content": {"confirm": True}} if accepted else {"action": "decline"}
        self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})

    def send(self, message: dict) -> None:
        line = json.dumps(message) + "\n"
        self.transcript.append(("out", line))
        self.process.stdin.write(line.encode())
        self.process.stdin.flush()

    def notify(self, method: str, params: dict | None = None) -> None:
        self.send({"jsonrpc": "2.0", "method": method, **({"params": params} if params else {})})

    def request(self, method: str, params: dict, timeout: float = 30) -> dict:
        request_id = self._next_id
        self._next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        with self._changed:
            if not self._changed.wait_for(lambda: request_id in self._responses, timeout):
                raise AssertionError(f"no response to {method}")
            return self._responses.pop(request_id)

    def tool(self, name: str, args: dict | None = None, timeout: float = 60) -> tuple[object, bool]:
        """Call a fundkit tool; returns (parsed text body, isError)."""
        result = self.request("tools/call", {"name": name, "arguments": args or {}}, timeout)["result"]
        text = result["content"][0]["text"]
        try:
            body = json.loads(text)
        except ValueError:
            body = text
        return body, bool(result.get("isError"))

    def all_text(self) -> str:
        return "".join(line for _, line in self.transcript)

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self.process.stdin.close()
        try:
            self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(5)
        for stream in (self.process.stdout, self.process.stderr):
            with contextlib.suppress(OSError):
                stream.close()


# --------------------------------------------------------------------------- base test case
class SessionTestCase(unittest.TestCase):
    """A scratch HOME, a mock Doppler, and helpers to run sessions and hosts in it."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="fundkit-test-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.doppler = MockDoppler()
        self.run_dir = self.home / ".local" / "state" / "fundkit" / "run"
        base = {"PATH": os.environ["PATH"], "HOME": str(self.home), "LANG": "C.UTF-8"}
        self.host_env = dict(base)
        self.env = {
            **base,
            "FUNDKIT_DOPPLER_API": self.doppler.url,
            "FUNDKIT_CCXT_MCP": str(FAKE_CCXT_MCP),
            # Values in the operator's shell must never be picked up or forwarded.
            "DOPPLER_TOKEN": OTHER_TOKEN,
            "OKX_APIKEY": "HOST-ENV-OKX-KEY-SHOULD-NOT-PASS",
            "OKX_PASSWORD": "HOST-ENV-OKX-PASS-SHOULD-NOT-PASS",
        }
        self.terminals: list[Terminal] = []
        self.hosts: list[Host] = []
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        for host in self.hosts:
            host.close()
        for terminal in self.terminals:
            terminal.close()
        self.doppler.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- processes
    def terminal(self, *args: str) -> Terminal:
        terminal = Terminal(self.env, args or ("session",))
        self.terminals.append(terminal)
        return terminal

    def session(self, *args: str, token: str = TOKEN, passphrases: dict | None = None) -> Terminal:
        """Start `fundkit session`, type the token (and any --passphrase values) and wait until active."""
        terminal = self.terminal("session", *args)
        terminal.read_until("Doppler service token: ")
        terminal.type(token + "\r")
        for exchange, value in (passphrases or {}).items():
            terminal.read_until(
                f"{label(exchange)} API passphrase (for the key in {exchange.upper()}_APIKEY): "
            )
            terminal.type(value + "\r")
        terminal.read_until("Session active")
        return terminal

    def host(self, **options) -> Host:
        host = Host(self.host_env, **options)
        self.hosts.append(host)
        return host

    def run_cli(self, *args: str, timeout: float = 15) -> subprocess.CompletedProcess:
        return subprocess.run(
            [NODE, str(FUNDKIT), *args],
            env=self.host_env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    # ---- what the fake server recorded
    def events(self, kind: str | None = None) -> list[dict]:
        path = self.home / "fake-ccxt-events.jsonl"
        if not path.exists():
            return []
        with path.open() as stream:
            events = [json.loads(line) for line in stream]
        return [event for event in events if kind is None or event["type"] == kind]

    def starts(self) -> dict[str, dict]:
        """The latest start event per alias."""
        return {event["alias"]: event for event in self.events("start")}

    def calls(self, name: str | None = None) -> list[dict]:
        return [event for event in self.events("call") if name is None or event["name"] == name]

    def set_account_uid(self, exchange: str, uid: str) -> None:
        path = self.home / "fake-uids.json"
        current = json.loads(path.read_text()) if path.exists() else {}
        current[exchange] = uid
        path.write_text(json.dumps(current))

    def fail_key_check(self, exchange: str) -> None:
        path = self.home / "fake-key-check-errors.json"
        current = json.loads(path.read_text()) if path.exists() else []
        path.write_text(json.dumps([*current, exchange]))

    # ---- assertions
    def assert_no_leaks(self, *texts: str) -> None:
        blob = "\n".join(texts)
        for value in ALL_SECRET_VALUES:
            for form in spellings(value):
                self.assertNotIn(form, blob)

    def assert_no_files_with_secrets(self) -> None:
        for path in self.tmp.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            try:
                data = path.read_bytes()
            except OSError:
                continue
            for value in ALL_SECRET_VALUES:
                self.assertNotIn(value.encode(), data, str(path))

    def assert_environ_free_of_secrets(self, pid: int) -> None:
        with contextlib.suppress(FileNotFoundError, ProcessLookupError):
            environ = Path(f"/proc/{pid}/environ").read_bytes()
            for value in [*DOPPLER_CONFIG.values(), *PASSPHRASES.values(), TOKEN]:
                self.assertNotIn(value.encode(), environ)

    @staticmethod
    def alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            state = Path(f"/proc/{pid}/stat").read_text().split()[2]
        except (OSError, FileNotFoundError):
            return False
        return state != "Z"


def label(exchange: str) -> str:
    return {"okx": "OKX", "bitget": "Bitget", "kucoin": "KuCoin"}[exchange]


def key_check(exchange: str, alias: str) -> dict:
    """fundkit_read arguments for the venue key check (key rights; any UID in it is ignored)."""
    method = {
        "binance": "sapiGetAccountApiRestrictions",
        "bybit": "privateGetV5UserQueryApi",
        "okx": "privateGetAccountConfig",
        "bitget": "privateSpotGetV2SpotAccountInfo",
        "bingx": "accountV1PrivateGetAccountApiPermissions",
        "mexc": "spotPrivateGetAccount",
        "kucoin": "privateGetUserApiKey",
        "gate": "privateAccountGetDetail",
    }[exchange]
    return {
        "alias": alias,
        "tool": "call_implicit_get",
        "arguments": {"exchange": exchange, "account": alias, "method": method},
    }


def withdraw_args(alias: str, amount: float = 300) -> dict:
    return {
        "account": alias,
        "code": "USDT",
        "amount": amount,
        "address": "TSynthAddress000000000000000000000",
        "network": "TRC20",
        "params": {"fee": "1"},
    }
