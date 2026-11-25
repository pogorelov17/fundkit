"""End-to-end tests for the optional Doppler session (bin/fundkit.mjs).

Standard library only. Everything is local and synthetic:
  * a disposable mock Doppler API on 127.0.0.1 (FUNDKIT_DOPPLER_API, loopback only),
  * the private terminal step driven through a real pseudo-terminal (pty.fork),
  * a simulated MCP host that launches `fundkit mcp` and answers native forms,
  * tests/fake_ccxt_mcp.mjs as the ccxt-mcp server (or the pinned real one with
    FUNDKIT_REAL_CCXT_MCP=<path to server.js>, run inside a network namespace).

Run:  python3 -I tests/test_session.py        (add -v for names)
"""
import hashlib
import json
import os
import pty
import queue
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNDKIT = os.path.join(ROOT, "bin", "fundkit.mjs")
FAKE = os.path.join(ROOT, "tests", "fake_ccxt_mcp.mjs")
NODE = shutil.which("node")
REAL = os.environ.get("FUNDKIT_REAL_CCXT_MCP")

TOKEN = "dp.st.dev." + "A1b2C3d4E5" * 4          # synthetic, matches Doppler's service-token format
TOKEN2 = "dp.st.dev." + "Z9y8X7w6V5" * 4


def rnd(tag):
    return "SYNTH-%s-%s" % (tag, os.urandom(8).hex())


SECRETS = {
    "OKX_SOURCE_APIKEY": rnd("okxsk"), "OKX_SOURCE_SECRET": rnd("okxss") + '"\\/', "OKX_SOURCE_PASSWORD": rnd("okxsp"),
    "BYBIT_DEPOSIT_APIKEY": rnd("bydk"), "BYBIT_DEPOSIT_SECRET": rnd("byds") + "&=+",
    "BYBIT_SETTLEMENT_APIKEY": rnd("bystk"), "BYBIT_SETTLEMENT_SECRET": rnd("bysts"),
    "BINANCE_SOURCE_APIKEY": rnd("bnk"), "BINANCE_SOURCE_SECRET": rnd("bns"),
    "KUCOIN_DEPOSIT_APIKEY": rnd("kck"), "KUCOIN_DEPOSIT_SECRET": rnd("kcs"),   # passphrase deliberately missing
    "UNRELATED_DB_PASSWORD": rnd("db"),
}
ALL_SECRET_VALUES = list(SECRETS.values()) + [TOKEN, TOKEN2]
sha = lambda v: hashlib.sha256(v.encode()).hexdigest()


# --------------------------------------------------------------------------- mock Doppler
class MockDoppler:
    def __init__(self):
        self.valid = {TOKEN, TOKEN2}
        self.secrets = dict(SECRETS)
        self.requests = []
        self.ignore_filter = False
        self.fail_status = None
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(u.query)
                auth = self.headers.get("Authorization", "")
                tok = auth[7:] if auth.startswith("Bearer ") else None
                names = q.get("secrets", [""])[0].split(",") if "secrets" in q else None
                mock.requests.append({"path": u.path, "names": names, "token_ok": tok in mock.valid, "token_hash": sha(tok or "")})
                if u.path != "/v3/configs/config/secrets/download":
                    return self.reply(404, {"messages": ["not found"]})
                if tok not in mock.valid:
                    return self.reply(401, {"messages": ["Invalid Auth token"], "success": False})
                if mock.fail_status:
                    return self.reply(mock.fail_status, {"messages": ["boom"]})
                body = {"DOPPLER_PROJECT": "fundkit-test", "DOPPLER_CONFIG": "prd", "DOPPLER_ENVIRONMENT": "prd"}
                src = dict(mock.secrets)
                if names is None or mock.ignore_filter:
                    body.update(src)
                else:
                    body.update({n: src[n] for n in names if n in src})
                self.reply(200, body)

            def reply(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def secret_requests(self):
        return [r for r in self.requests if r["names"] and not all(n.startswith("DOPPLER_") for n in r["names"])]

    def close(self):
        self.httpd.shutdown()


# --------------------------------------------------------------------------- private terminal
class Terminal:
    """`fundkit session` on a real pseudo-terminal, as a human would run it."""

    def __init__(self, env, args=()):
        self.out = b""
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(NODE, [NODE, FUNDKIT, "session", *args], env)
        self.pid, self.fd = pid, fd
        self.status = None

    def read_until(self, needle, timeout=15):
        end = time.time() + timeout
        while needle.encode() not in self.out:
            if time.time() > end:
                raise AssertionError("terminal never showed %r; got %r" % (needle, self.out.decode(errors="replace")))
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(self.fd, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    if self.poll() is not None:
                        raise AssertionError("terminal exited before %r: %r" % (needle, self.out.decode(errors="replace")))
                    continue
                self.out += chunk
        return self.out.decode(errors="replace")

    def type(self, s):
        os.write(self.fd, s.encode() if isinstance(s, str) else s)

    def poll(self):
        if self.status is None:
            p, st = os.waitpid(self.pid, os.WNOHANG)
            if p:
                self.status = os.waitstatus_to_exitcode(st)
        return self.status

    def wait(self, timeout=15):
        end = time.time() + timeout
        while self.poll() is None:
            if time.time() > end:
                raise AssertionError("session did not exit: %r" % self.out.decode(errors="replace"))
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                try:
                    self.out += os.read(self.fd, 4096)
                except OSError:
                    pass
        try:
            while True:
                r, _, _ = select.select([self.fd], [], [], 0.05)
                if not r:
                    break
                c = os.read(self.fd, 4096)
                if not c:
                    break
                self.out += c
        except OSError:
            pass
        return self.status

    def kill(self, sig=signal.SIGTERM):
        if self.poll() is None:
            os.kill(self.pid, sig)


# --------------------------------------------------------------------------- simulated host
class Host:
    """Launches `fundkit mcp` like Claude Code or Codex would and answers native forms."""

    def __init__(self, env, elicitation=True, form_answer="accept"):
        self.p = subprocess.Popen([NODE, FUNDKIT, "mcp"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.transcript = []      # every line in both directions, as the host would see / log it
        self.responses = {}
        self.cv = threading.Condition()
        self.forms = []
        self.form_answer = form_answer
        self.next = 1
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._err, daemon=True).start()
        self.stderr = b""
        caps = {"elicitation": {"form": {}}} if elicitation else {}
        init = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": caps, "clientInfo": {"name": "sim-host", "version": "1"}})
        self.instructions = init["result"].get("instructions", "")
        self.notify("notifications/initialized")

    def _err(self):
        for line in self.p.stderr:
            self.stderr += line

    def _reader(self):
        for line in self.p.stdout:
            s = line.decode()
            self.transcript.append(("in", s))
            m = json.loads(s)
            if "method" in m and "id" in m:
                if m["method"] == "elicitation/create":
                    self.forms.append(m["params"])
                    ans = self.form_answer
                    if ans is None:            # the human never answers
                        continue
                    res = {"action": "accept", "content": {"confirm": True}} if ans == "accept" else {"action": "decline"}
                    self.send({"jsonrpc": "2.0", "id": m["id"], "result": res})
                continue
            with self.cv:
                self.responses[m.get("id")] = m
                self.cv.notify_all()

    def send(self, m):
        s = json.dumps(m) + "\n"
        self.transcript.append(("out", s))
        self.p.stdin.write(s.encode())
        self.p.stdin.flush()

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, **({"params": params} if params else {})})

    def request(self, method, params, timeout=30):
        i = self.next
        self.next += 1
        self.send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        with self.cv:
            ok = self.cv.wait_for(lambda: i in self.responses, timeout)
        if not ok:
            raise AssertionError("no response to %s" % method)
        return self.responses.pop(i)

    def tool(self, name, args=None, timeout=60):
        r = self.request("tools/call", {"name": name, "arguments": args or {}}, timeout)
        res = r["result"]
        txt = res["content"][0]["text"]
        try:
            body = json.loads(txt)
        except ValueError:
            body = txt
        return body, bool(res.get("isError"))

    def all_text(self):
        return "".join(s for _, s in self.transcript)

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(5)
        except subprocess.TimeoutExpired:
            self.p.kill()


# --------------------------------------------------------------------------- tests
def wait_for(pred, timeout=10, msg="condition"):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return
        time.sleep(0.05)
    raise AssertionError("timed out waiting for " + msg)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fundkit-test-")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.doppler = MockDoppler()
        self.env = {"PATH": os.environ["PATH"], "HOME": self.home, "LANG": "C.UTF-8",
                    "FUNDKIT_DOPPLER_API": self.doppler.url, "FUNDKIT_CCXT_MCP": FAKE,
                    # a token in the operator's shell must never be picked up or forwarded
                    "DOPPLER_TOKEN": TOKEN2, "OKX_APIKEY": "HOST-ENV-OKX-KEY-SHOULD-NOT-PASS"}
        self.host_env = {"PATH": os.environ["PATH"], "HOME": self.home, "LANG": "C.UTF-8"}
        self.terms, self.hosts = [], []
        self.run_dir = os.path.join(self.home, ".local", "state", "fundkit", "run")

    def tearDown(self):
        for h in self.hosts:
            h.close()
        for t in self.terms:
            t.kill(signal.SIGKILL)
            try:
                t.wait(3)
            except AssertionError:
                pass
        self.doppler.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers
    def session(self, args=(), token=TOKEN, expect_active=True):
        t = Terminal(self.env, args)
        self.terms.append(t)
        t.read_until("Doppler service token: ")
        t.type(token + "\r")
        if expect_active:
            t.read_until("Session active")
        return t

    def host(self, **kw):
        h = Host(self.host_env, **kw)
        self.hosts.append(h)
        return h

    def events(self):
        p = os.path.join(self.home, "fake-ccxt-events.jsonl")
        if not os.path.exists(p):
            return []
        return [json.loads(l) for l in open(p)]

    def assert_no_leaks(self, *texts):
        blob = "\n".join(texts)
        for v in ALL_SECRET_VALUES:
            for form in (v, json.dumps(v)[1:-1], urllib.parse.quote(v, safe="")):
                self.assertNotIn(form, blob)

    def assert_no_files_with_secrets(self):
        for d, _, files in os.walk(self.tmp):
            for f in files:
                p = os.path.join(d, f)
                try:
                    data = open(p, "rb").read()
                except OSError:
                    continue
                for v in ALL_SECRET_VALUES:
                    self.assertNotIn(v.encode(), data, p)

    def alive(self, pid):
        try:
            os.kill(pid, 0)
            st = open("/proc/%d/stat" % pid).read().split()[2]
            return st != "Z"
        except (OSError, FileNotFoundError):
            return False



class SessionTests(Base):
    def test_01_clean_install_no_session_is_lazy_and_explains_private_step(self):
        h = self.host()
        tools = [t["name"] for t in h.request("tools/list", {})["result"]["tools"]]
        self.assertEqual(tools, ["fundkit_profiles", "fundkit_connect", "fundkit_read", "fundkit_write", "fundkit_disconnect"])
        self.assertIn("SKILL.md", h.instructions)
        self.assertIn("переведи 300 USDT с OKX на Bybit", h.instructions)
        body, err = h.tool("fundkit_profiles", {"from": "OKX", "to": "Bybit"})
        self.assertFalse(err)
        self.assertEqual(body["session"], "none")
        self.assertIn("fundkit session", body["userStep"])
        self.assertEqual([(n["exchange"], n["role"], n["alias"]) for n in body["needs"]],
                         [("okx", "source", "okx-src"), ("bybit", "deposit-only", "bybit-dst"), ("bybit", "settlement", "bybit-settle")])
        self.assertEqual(body["needs"][0]["dopplerNames"], ["OKX_SOURCE_APIKEY", "OKX_SOURCE_SECRET", "OKX_SOURCE_PASSWORD"])
        body, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(err)
        self.assertEqual(body["error"], "NO_SESSION")
        self.assertEqual(self.doppler.requests, [])
        self.assertEqual(self.events(), [])
        self.assertFalse(os.path.exists(self.run_dir) and os.listdir(self.run_dir))

    def test_02_existing_profiles_need_no_session(self):
        # A host whose route profiles are already registered (scheme C) never touches fundkit:
        # starting, listing and health-checking the broker opens no session and no prompt.
        h = self.host()
        h.request("tools/list", {})
        h.request("ping", {})
        h.close()
        self.assertEqual(self.doppler.requests, [])
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "session.sock")))

    def test_03_route_fetches_only_required_names_and_forwards_native_form(self):
        t = self.session()
        screen = t.out.decode(errors="replace")
        self.assertIn("Doppler project fundkit-test, config prd", screen)
        h = self.host()
        body, err = h.tool("fundkit_profiles", {"from": "okx", "to": "bybit"})
        self.assertEqual(body["session"], "active")
        self.assertFalse(any(n["connected"] for n in body["needs"]))
        a, err = h.tool("fundkit_connect", {"exchange": "OKX", "role": "source"})
        self.assertFalse(err, a)
        self.assertEqual(a["alias"], "okx-src")
        b, err = h.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        self.assertFalse(err, b)
        # Doppler saw: one identity check with Doppler's own names, then exactly the route's names.
        self.assertEqual([r["names"] for r in self.doppler.requests], [
            ["DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"],
            ["OKX_SOURCE_APIKEY", "OKX_SOURCE_SECRET", "OKX_SOURCE_PASSWORD"],
            ["BYBIT_DEPOSIT_APIKEY", "BYBIT_DEPOSIT_SECRET"]])
        self.assertTrue(all(r["token_hash"] == sha(TOKEN) for r in self.doppler.requests))
        starts = {e["alias"]: e for e in self.events() if e["type"] == "start"}
        okx, byb = starts["okx-src"], starts["bybit-dst"]
        if True:
            self.assertEqual(set(okx["envNames"]) - {"LANG"}, {"PATH", "HOME", "CCXT_MCP_CONFIG", "OKX_APIKEY", "OKX_SECRET", "OKX_PASSWORD"})
            self.assertEqual(set(byb["envNames"]) - {"LANG"}, {"PATH", "HOME", "CCXT_MCP_CONFIG", "BYBIT_APIKEY", "BYBIT_SECRET"})
            self.assertEqual(okx["envHashes"]["OKX_APIKEY"], sha(SECRETS["OKX_SOURCE_APIKEY"]))
            self.assertEqual(okx["envHashes"]["OKX_PASSWORD"], sha(SECRETS["OKX_SOURCE_PASSWORD"]))
            self.assertEqual(byb["envHashes"]["BYBIT_SECRET"], sha(SECRETS["BYBIT_DEPOSIT_SECRET"]))
            for e in (okx, byb):  # neither the service token nor another profile's values reach a server
                self.assertNotIn(sha(TOKEN), e["envHashes"].values())
                self.assertNotIn(sha(TOKEN2), e["envHashes"].values())
                self.assertFalse(any(n.startswith("DOPPLER") for n in e["envNames"]))
                self.assertEqual(e["configMode"], "600")
                self.assertNotIn("apiKey", json.dumps(e["config"]))
            self.assertNotIn(sha(SECRETS["BYBIT_DEPOSIT_APIKEY"]), okx["envHashes"].values())
            self.assertEqual(okx["config"]["accounts"]["okx-src"]["dryRun"], True)       # no --writes
            self.assertEqual(byb["config"]["accounts"]["bybit-dst"]["dryRun"], True)
        # Step 0 through the broker
        st, err = h.tool("fundkit_read", {"alias": "okx-src", "tool": "get_safety_status"})
        self.assertFalse(err)
        self.assertTrue(st["elicitationSupported"])     # the host's form capability reaches ccxt-mcp
        self.assertEqual(st["version"], "0.1.3")
        # redaction of an echoed key (fake server only has this tool)
        if True:
            echo, _ = h.tool("fundkit_read", {"alias": "bybit-dst", "tool": "debug_echo_key"})
            self.assertEqual(echo["echoed"], "[redacted:fundkit]")
            self.assertIn("[redacted:fundkit]", echo["nested"])
            self.assertIn("[redacted:fundkit]", echo["url"])
        # routing gates
        _, err = h.tool("fundkit_read", {"alias": "okx-src", "tool": "withdraw", "arguments": {}})
        self.assertTrue(err)
        r, err = h.tool("fundkit_read", {"alias": "bybit-dst", "tool": "get_deposit_address", "arguments": {"account": "bybit-dst", "code": "USDT"}})
        self.assertTrue(err)
        self.assertEqual(r["error"], "NOT_FORWARDED")
        r, err = h.tool("fundkit_write", {"alias": "okx-src", "tool": "get_balance", "arguments": {}})
        self.assertTrue(err)
        # money move: the native form is forwarded to the host and the human's answer decides
        h.form_answer = "decline"
        w = {"account": "okx-src", "code": "USDT", "amount": 300, "address": "TSynthAddress000000000000000000000", "network": "TRC20", "params": {"fee": "1"}}
        r, err = h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": w})
        self.assertEqual(len(h.forms), 1)
        self.assertIn("withdraw 300 USDT on okx-src", h.forms[0]["message"])
        if True:
            self.assertEqual(r["code"], "CONFIRM_DECLINED")
        h.form_answer = "accept"
        r, err = h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": w})
        self.assertEqual(len(h.forms), 2)
        if True:
            self.assertEqual(r["dryRun"], True)
            self.assertEqual([e for e in self.events() if e["type"] == "dispatch"], [])
        self.assert_no_leaks(h.all_text(), t.out.decode(errors="replace"), h.stderr.decode(errors="replace"))
        # argv of every child carries no secret
        for e in starts.values():
            self.assert_no_leaks(json.dumps(e["argv"]))
        self.assert_no_files_with_secrets()
        # host session ends -> children stopped, session ends, nothing left behind
        pids = [e["pid"] for e in starts.values()]
        h.close()
        self.assertEqual(t.wait(), 0)
        self.assertIn("the host session ended", t.out.decode())
        wait_for(lambda: not any(self.alive(p) for p in pids), msg="children to stop")
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "session.sock")))
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "profiles")))
        self.assert_no_files_with_secrets()

    def test_04_writes_flag_and_caps(self):
        t = self.session(["--writes", "--max-transfer", "300", "--max-daily", "600"])
        h = self.host()
        h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        h.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        h.tool("fundkit_connect", {"exchange": "bybit", "role": "settlement"})
        if True:
            c = {e["alias"]: e["config"]["accounts"][e["alias"]] for e in self.events() if e["type"] == "start"}
            self.assertEqual((c["okx-src"]["dryRun"], c["okx-src"]["maxTransferValue"], c["okx-src"]["maxDailyValue"]), (False, 300, 600))
            self.assertEqual((c["bybit-settle"]["dryRun"], c["bybit-settle"]["maxTransferValue"]), (False, 300))
            self.assertEqual(c["bybit-dst"]["dryRun"], True)                 # deposit-only stays dryRun always
            self.assertEqual(c["okx-src"]["confirm"], "always")
            h.form_answer = "accept"
            r, _ = h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": {"account": "okx-src", "code": "USDT", "amount": 300, "address": "TX", "network": "TRC20"}})
            self.assertEqual(r["id"], "W-1")
            self.assertEqual(len(h.forms), 1)
            # no form, no write: a host without elicitation gets a token preview the skill never redeems
        h2 = self.host(elicitation=False)
        r, err = h2.tool("fundkit_connect", {"exchange": "binance", "role": "source"})
        self.assertFalse(err, r)
        st, _ = h2.tool("fundkit_read", {"alias": "binance-src", "tool": "get_safety_status"})
        self.assertFalse(st["elicitationSupported"])
        # --writes without an explicit cap is refused before any prompt
        t2 = Terminal(self.env, ["--writes"])
        self.terms.append(t2)
        self.assertEqual(t2.wait(), 2)
        self.assertIn("--writes needs an explicit --max-transfer", t2.out.decode())

    def test_05_missing_passphrase_and_unknown_inputs(self):
        self.doppler.secrets.pop("OKX_SOURCE_PASSWORD")
        t = self.session()
        h = self.host()
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(err)
        self.assertEqual(r["error"], "MISSING_SECRETS")
        self.assertEqual(r["missing"], ["OKX_SOURCE_PASSWORD"])
        self.assertIn("passphrase", r["message"])
        r, err = h.tool("fundkit_connect", {"exchange": "kucoin", "role": "deposit-only"})
        self.assertEqual(r["missing"], ["KUCOIN_DEPOSIT_PASSWORD"])
        r, err = h.tool("fundkit_connect", {"exchange": "hyperliquid", "role": "source"})
        self.assertEqual(r["error"], "UNKNOWN_EXCHANGE")
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "admin"})
        self.assertTrue(err)
        self.assertEqual(self.events(), [])            # nothing was started for a failed fetch
        self.assertEqual(len(self.doppler.secret_requests()), 2)
        # the session survives a missing name; a fixed config works without a new token
        self.doppler.secrets["OKX_SOURCE_PASSWORD"] = SECRETS["OKX_SOURCE_PASSWORD"]
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertFalse(err, r)
        self.assert_no_leaks(h.all_text(), t.out.decode(errors="replace"))

    def test_06_expired_token_ends_session_and_stops_children(self):
        t = self.session()
        h = self.host()
        r, err = h.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        self.assertFalse(err)
        pid = [e["pid"] for e in self.events() if e["type"] == "start"][0]
        self.doppler.valid.discard(TOKEN)                # token expires / is revoked in Doppler
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(err)
        self.assertEqual(r["error"], "TOKEN_REJECTED")
        self.assertIn("fundkit session", r["userStep"])
        self.assertEqual(t.wait(), 3)
        wait_for(lambda: not self.alive(pid), msg="bybit-dst to stop")
        r, err = h.tool("fundkit_read", {"alias": "bybit-dst", "tool": "list_accounts"})
        self.assertTrue(err)
        body, _ = h.tool("fundkit_profiles")
        self.assertEqual(body["session"], "none")
        self.assertIn("rejected", body["note"])
        # reconnect: a new private-terminal step, same running host, no host restart
        self.doppler.valid.add(TOKEN)
        t2 = self.session()
        body, _ = h.tool("fundkit_profiles")
        self.assertEqual(body["session"], "active")
        self.assertEqual(body["profiles"], [])           # nothing carried over from the old session
        r, err = h.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        self.assertFalse(err, r)
        r, err = h.tool("fundkit_read", {"alias": "bybit-dst", "tool": "list_accounts"})
        self.assertFalse(err)
        self.assert_no_leaks(h.all_text(), t.out.decode(errors="replace"), t2.out.decode(errors="replace"))

    def test_07_cancel_and_bad_token_store_nothing(self):
        t = Terminal(self.env)
        self.terms.append(t)
        t.read_until("Doppler service token: ")
        t.type(TOKEN[:12])
        t.type(b"\x03")                                  # Ctrl-C at the prompt
        self.assertEqual(t.wait(), 130)
        self.assertNotIn(TOKEN[:12], t.out.decode())   # no echo
        t = Terminal(self.env)
        self.terms.append(t)
        t.read_until("Doppler service token: ")
        t.type("dp.pt.personaltoken" + "x" * 40 + "\r")  # personal token: refused, nothing sent
        self.assertEqual(t.wait(), 2)
        t = Terminal(self.env)
        self.terms.append(t)
        t.read_until("Doppler service token: ")
        t.type("dp.st.dev." + "Q" * 40 + "\r")           # well-formed but unknown
        self.assertEqual(t.wait(), 3)
        self.assertIn("rejected", t.out.decode())
        self.assertEqual(len(self.doppler.requests), 1)
        self.assertEqual(self.doppler.requests[0]["names"], ["DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"])
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "session.sock")))
        # no terminal at all: refused, never read from stdin
        p = subprocess.run([NODE, FUNDKIT, "session"], env=self.env, input=(TOKEN + "\n").encode(), capture_output=True, start_new_session=True, timeout=15)
        self.assertEqual(p.returncode, 2)
        self.assertIn(b"No terminal", p.stderr)
        self.assertEqual(len(self.doppler.requests), 1)
        self.assert_no_files_with_secrets()

    def test_08_ttl_signal_and_stop_cleanup(self):
        t = self.session(["--ttl", "3s"])
        h = self.host()
        h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        pid = [e["pid"] for e in self.events() if e["type"] == "start"][0]
        self.assertEqual(t.wait(10), 0)
        self.assertIn("session time limit reached", t.out.decode())
        wait_for(lambda: not self.alive(pid), msg="child after ttl")
        # SIGHUP (terminal closed)
        t = self.session()
        h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        pid = [e["pid"] for e in self.events() if e["type"] == "start"][-1]
        t.kill(signal.SIGHUP)
        t.wait()
        wait_for(lambda: not self.alive(pid), msg="child after SIGHUP")
        # fundkit stop
        t = self.session()
        h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        pid = [e["pid"] for e in self.events() if e["type"] == "start"][-1]
        p = subprocess.run([NODE, FUNDKIT, "status"], env=self.host_env, capture_output=True, timeout=10)
        st = json.loads(p.stdout)
        self.assertEqual([x["alias"] for x in st["profiles"]], ["okx-src"])
        self.assert_no_leaks(p.stdout.decode())
        subprocess.run([NODE, FUNDKIT, "stop"], env=self.host_env, capture_output=True, timeout=10)
        self.assertEqual(t.wait(), 0)
        wait_for(lambda: not self.alive(pid), msg="child after stop")
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "profiles")))
        self.assert_no_files_with_secrets()

    def test_09_doppler_ignoring_the_filter_is_refused(self):
        t = self.session()
        h = self.host()
        self.doppler.ignore_filter = True
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertTrue(err)
        self.assertEqual(r["error"], "DOPPLER_UNEXPECTED_SECRETS")
        self.assertEqual(self.events(), [])
        self.doppler.ignore_filter = False
        self.doppler.fail_status = 503
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertEqual(r["error"], "DOPPLER_UNAVAILABLE")
        self.assertIsNone(t.poll())                      # a transient outage keeps the session
        self.assert_no_leaks(h.all_text(), t.out.decode(errors="replace"))

    def test_10_wrapped_host_launch(self):
        # `fundkit session -- <host>`: prompt first, then the host; its env has no token.
        rec = os.path.join(self.tmp, "hostenv.json")
        script = "import json,os,sys; json.dump(sorted(os.environ), open(sys.argv[1],'w')); import time; time.sleep(1)"
        t = Terminal(self.env, ["--", sys.executable, "-I", "-c", script, rec])
        self.terms.append(t)
        t.read_until("Doppler service token: ")
        t.type(TOKEN + "\r")
        self.assertEqual(t.wait(), 0)
        names = json.load(open(rec))
        self.assertNotIn("DOPPLER_TOKEN", names)
        self.assertIn("the host exited", t.out.decode())
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "session.sock")))

    def test_11_alias_owned_by_one_host_session(self):
        t = self.session(["--keep"])
        h1, h2 = self.host(), self.host()
        r, err = h1.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertFalse(err)
        r, err = h2.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertEqual(r["error"], "ALIAS_IN_USE")
        r, err = h2.tool("fundkit_read", {"alias": "okx-src", "tool": "get_balance", "arguments": {"account": "okx-src"}})
        self.assertEqual(r["error"], "UNKNOWN_ALIAS")
        h1.close()
        time.sleep(0.5)
        self.assertIsNone(t.poll())                      # --keep: session outlives the host session
        r, err = h2.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertFalse(err, r)
        r, err = h2.tool("fundkit_disconnect", {"alias": "okx-src"})
        self.assertFalse(err)

    def test_12_session_end_during_pending_write_reports_unknown_outcome(self):
        t = self.session(["--writes", "--max-transfer", "300"])
        h = self.host()
        h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        done = queue.Queue()

        def go():
            done.put(h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": {"account": "okx-src", "code": "USDT", "amount": 1, "address": "TX"}}))

        # never answer the form: simulate the human not answering, then the session ends
        h.form_answer = None
        threading.Thread(target=go, daemon=True).start()
        wait_for(lambda: len(h.forms) == 1, msg="form")
        t.kill(signal.SIGTERM)
        r, err = done.get(timeout=10)
        self.assertTrue(err)
        self.assertIn("outcome is unknown", r["message"])


SHIM = r"""
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as ccxt from %(ccxt)s;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const KEYH = ['OK-ACCESS-KEY', 'X-BAPI-API-KEY', 'X-MBX-APIKEY'];
ccxt.Exchange.prototype.fetch = async function (url, method = 'GET', headers = {}, body = undefined) {
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
  const key = KEYH.map((k) => h[k]).find(Boolean);
  fs.appendFileSync(process.env.HOME + '/wire.jsonl', JSON.stringify({ id: this.id, method, path: new URL(url).pathname, signed: Boolean(key), keyHash: key ? sha(key) : null }) + '\n');
  if (method !== 'GET') throw new ccxt.NetworkError('recorder: only GET is answered, nothing is sent');
  return { retCode: 0, retMsg: 'OK', result: { list: [], rows: [] }, code: '0', data: [] };
};
await import(%(server)s);
"""


def child_pids(server_path):
    out = []
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                cmd = open("/proc/%s/cmdline" % d, "rb").read().split(b"\0")
            except OSError:
                continue
            if server_path.encode() in cmd:
                out.append(int(d))
    return out


@unittest.skipUnless(REAL, "set FUNDKIT_REAL_CCXT_MCP=<APP_DIR>/node_modules/ccxt-mcp/js/server.js (run inside unshare -rn)")
class RealCcxtMcpTests(Base):
    """The pinned ccxt-mcp 0.1.3 behind the broker. Run without network: no exchange is reached."""

    def setUp(self):
        super().setUp()
        # Test-only shim: the real server, with ccxt's transport replaced by a recorder that
        # stores the request line and a sha256 of the API-key header, answers GETs locally with an
        # empty list, throws on anything else, and sends nothing. The run is also inside unshare -rn.
        app = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(REAL))))
        self.shim = os.path.join(self.tmp, "ccxt_recorder_shim.mjs")
        with open(self.shim, "w") as f:
            f.write(SHIM % {"ccxt": json.dumps(os.path.join(app, "node_modules", "ccxt", "js", "ccxt.js")), "server": json.dumps(REAL)})
        self.env["FUNDKIT_CCXT_MCP"] = self.shim
        self.env["XDG_CACHE_HOME"] = os.path.join(self.home, ".cache")

    def wire(self):
        p = os.path.join(self.home, "wire.jsonl")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def test_real_server_end_to_end(self):
        t = self.session()
        h = self.host()
        r, err = h.tool("fundkit_connect", {"exchange": "okx", "role": "source"})
        self.assertFalse(err, r)
        self.assertEqual(r["server"]["name"], "ccxt-mcp")
        r, err = h.tool("fundkit_connect", {"exchange": "bybit", "role": "deposit-only"})
        self.assertFalse(err, r)
        pids = child_pids(self.shim)
        self.assertEqual(len(pids), 2)
        for pid in pids:
            env = dict(kv.split(b"=", 1) for kv in open("/proc/%d/environ" % pid, "rb").read().split(b"\0") if b"=" in kv)
            names = {k.decode() for k in env}
            ex = "OKX" if b"OKX_APIKEY" in env else "BYBIT"
            want = {"PATH", "HOME", "LANG", "XDG_CACHE_HOME", "CCXT_MCP_CONFIG", ex + "_APIKEY", ex + "_SECRET"} | ({"OKX_PASSWORD"} if ex == "OKX" else set())
            self.assertEqual(names, want)
            self.assertNotIn(TOKEN.encode(), b"".join(env.values()))
            self.assertNotIn(b"HOST-ENV-OKX-KEY", b"".join(env.values()))
            role = "SOURCE" if ex == "OKX" else "DEPOSIT"
            self.assertEqual(env[(ex + "_APIKEY").encode()].decode(), SECRETS["%s_%s_APIKEY" % (ex, role)])
        st, err = h.tool("fundkit_read", {"alias": "okx-src", "tool": "get_safety_status", "arguments": {}})
        self.assertFalse(err, st)
        st = st["data"]
        self.assertEqual((st["version"], st["ccxtVersion"]), ("0.1.3", "4.5.84"))
        self.assertEqual(st["configProblems"], [])
        self.assertTrue(st["elicitationSupported"])
        self.assertTrue(st["configPath"].endswith("/profiles/okx-src/config.json"))
        acc, err = h.tool("fundkit_read", {"alias": "bybit-dst", "tool": "list_accounts", "arguments": {}})
        self.assertFalse(err, acc)
        self.real_accounts = acc
        # key check (security.md, venue profiles): the signed request carries B's deposit-only key
        kc, err = h.tool("fundkit_read", {"alias": "bybit-dst", "tool": "call_implicit_get", "arguments": {"exchange": "bybit", "account": "bybit-dst", "method": "privateGetV5UserQueryApi"}}, timeout=120)
        signed = [w for w in self.wire() if w["signed"]]
        self.assertTrue(signed, (kc, self.wire()))
        keys = {"bybit": sha(SECRETS["BYBIT_DEPOSIT_APIKEY"]), "okx": sha(SECRETS["OKX_SOURCE_APIKEY"])}
        self.assertTrue(any(w["id"] == "bybit" for w in signed), signed)
        self.assertTrue(all(w["keyHash"] == keys[w["id"]] for w in signed), signed)   # each profile signs with its own key
        okx_read, _ = h.tool("fundkit_read", {"alias": "okx-src", "tool": "call_read_method", "arguments": {"exchange": "okx", "account": "okx-src", "method": "fetchAccounts", "includeInfo": True}}, timeout=120)
        signed_okx = [w for w in self.wire() if w["signed"] and w["id"] == "okx"]
        self.assertTrue(signed_okx, (okx_read, self.wire()))
        self.assertTrue(all(w["keyHash"] == sha(SECRETS["OKX_SOURCE_APIKEY"]) for w in signed_okx))
        w = {"account": "okx-src", "code": "USDT", "amount": 5, "address": "TSynthAddress000000000000000000000", "network": "TRC20", "params": {"fee": "1"}}
        h.form_answer = "decline"
        r, err = h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": w}, timeout=120)
        self.assertEqual(len(h.forms), 1, r)
        self.assertIn("CONFIRM_DECLINED", json.dumps(r))
        h.form_answer = "accept"
        r, err = h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": w}, timeout=120)
        self.assertEqual(len(h.forms), 2, r)
        self.assertIn("dryRun", json.dumps(r))
        self.real_withdraw = r
        self.assertFalse([w for w in self.wire() if w["method"] != "GET"])      # nothing but GETs ever built
        r, err = h.tool("fundkit_write", {"alias": "okx-src", "tool": "withdraw", "arguments": dict(w, amount=300)}, timeout=120)
        self.assertIn("TRANSFER_VALUE_CAP", json.dumps(r))       # cap 10 without --writes; no form
        self.assertEqual(len(h.forms), 2)
        self.assert_no_leaks(h.all_text(), t.out.decode(errors="replace"))
        self.assert_no_files_with_secrets()
        h.close()
        self.assertEqual(t.wait(), 0)
        wait_for(lambda: not child_pids(self.shim), msg="real servers to stop")
        if os.environ.get("FUNDKIT_SHOW"):
            print(json.dumps({"list_accounts": self.real_accounts, "withdraw_accept": self.real_withdraw}, indent=1)[:3000])


if __name__ == "__main__":
    if not NODE:
        sys.exit("node not found")
    unittest.main()
