"""`fundkit install` against the real `claude` and `codex` CLIs, in a scratch home."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest

from tests.support import ROOT, SessionTestCase

PINS = {"ccxt-mcp": "0.1.3", "ccxt": "4.5.85", "@modelcontextprotocol/sdk": "1.32.2", "zod": "3.25.76"}


class InstallTests(SessionTestCase):
    def fake_pinned_app(self):
        """Pinned packages faked by their version files only: npm is not run when they match."""
        app = self.tmp / "app"
        for name, version in PINS.items():
            package = app / "node_modules" / name
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": name, "version": version}))
        return app

    def test_install_registers_hosts_links_the_skill_and_never_touches_doppler(self):
        app = self.fake_pinned_app()
        first = self.run_cli("install", "--app-dir", str(app), timeout=120)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        for link in (".claude/skills/usdt-funding", ".agents/skills/usdt-funding"):
            self.assertEqual((self.home / link).resolve(), ROOT)
        record = json.loads((self.home / ".config/fundkit/install.json").read_text())
        self.assertEqual(record["appDir"], str(app))
        self.assertEqual(((self.home / ".config/fundkit/install.json").stat().st_mode & 0o777), 0o600)

        if shutil.which("claude"):
            self.assertIn('registered user-scope server "fundkit"', first.stdout)
            listed = subprocess.run(
                ["claude", "mcp", "list"],
                env=self.host_env,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            self.assertRegex(listed.stdout, r"fundkit: .*fundkit\.mjs mcp - . Connected")
        if shutil.which("codex"):
            shown = subprocess.run(
                ["codex", "mcp", "get", "fundkit"],
                env=self.host_env,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertIn("tool_timeout_sec: 420", shown.stdout)
            self.assertIn("env: -", shown.stdout)

        second = self.run_cli("install", "--app-dir", str(app), timeout=120)
        self.assertIn("left unchanged", second.stdout)
        self.assertEqual(self.doppler.requests, [])
        self.assertFalse((self.run_dir / "session.sock").exists())

    def test_install_refuses_unknown_options(self):
        completed = self.run_cli("install", "--bogus")
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unknown option --bogus", completed.stderr)


if __name__ == "__main__":
    unittest.main()
