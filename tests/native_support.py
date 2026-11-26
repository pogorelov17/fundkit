"""Fixtures for the native flows: a T3-shaped host, its secret card, venue fixtures, a PNG reader.

The T3 emulation follows T3 Code 0.1.11 as read from its runtime: `request_secret` with
`delivery: "file"` writes the value to a 0600 regular file named by 32 hex characters in a 0700
directory and returns that path; an MCP elicitation becomes an approval card (Approve, Decline,
Cancel, "Always allow this session") whose accepted content T3 fills itself, cancelling any form
whose required fields it cannot fill; "Always allow this session" keys on server and message.
Everything is synthetic and local.
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import struct
import subprocess
import zlib
from pathlib import Path

from tests.support import NODE, ROOT, Host

QR_DECODER = ROOT / "tests" / "qr_decode.mjs"

BINANCE_BSC = "0x1b6C0d8D0aF0A3a0b6F6e4E5bC6a7F2d3C4e5F60"
BINANCE_BSC_OLD = "0x9999999999999999999999999999999999999999"
BINANCE_TRX = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"
BINANCE_TON = "EQD" + "_" * 42 + "0vo"
BINANCE_TON_MEMO = "000123"
BYBIT_BSC = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23"
USDT_BSC = "0x55d398326f99059fF775485246999027B3197955"
USDT_TRX = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
BINANCE_IDS = {"BEP20": "BSC", "TRC20": "TRX", "ERC20": "ETH", "TON": "TON"}


def params_key(tool: str, method: str, params: dict | None = None) -> str:
    """The fake server's fixture key; params in the order fundkit sends them."""
    base = f"{tool}:{method}"
    return base if params is None else f"{base}:{json.dumps(params, separators=(',', ':'))}"


def binance_fixtures(free_spot: float = 812.44) -> dict:
    rows = [
        {
            "network": "BSC",
            "contractAddress": USDT_BSC.lower(),
            "depositEnable": True,
            "withdrawEnable": True,
            "withdrawFee": "0.29",
            "withdrawMin": "10",
            "withdrawMax": "9999999",
            "withdrawIntegerMultiple": "0.00000001",
        },
        {
            "network": "TRX",
            "contractAddress": USDT_TRX,
            "depositEnable": True,
            "withdrawEnable": True,
            "withdrawFee": "1",
            "withdrawMin": "10",
            "withdrawMax": "9999999",
            "withdrawIntegerMultiple": "0.000001",
        },
        {
            "network": "ETH",
            "contractAddress": USDT_ETH,
            "depositEnable": True,
            "withdrawEnable": True,
            "withdrawFee": "4",
            "withdrawMin": "20",
            "withdrawMax": "9999999",
            "withdrawIntegerMultiple": "0.000001",
        },
        {
            "network": "TON",
            "contractAddress": USDT_TON,
            "depositEnable": True,
            "withdrawEnable": True,
            "withdrawFee": "0.5",
            "withdrawMin": "1",
            "withdrawMax": "9999999",
            "withdrawIntegerMultiple": "0.000001",
        },
    ]
    fixtures = {
        params_key("call_implicit_get", "sapiGetAccountApiRestrictions"): {
            "enableReading": True,
            "enableWithdrawals": True,
            "enableInternalTransfer": False,
            "ipRestrict": True,
        },
        params_key("call_read_method", "fetchDepositWithdrawFee"): {
            "info": {"coin": "USDT", "networkList": rows}
        },
        params_key("call_read_method", "fetchBalance", {"type": "spot"}): {"USDT": {"free": free_spot}},
        params_key("call_read_method", "fetchBalance", {"type": "funding"}): {"USDT": {"free": 0}},
    }
    for code, address, tag in [
        ("BEP20", BINANCE_BSC, ""),
        ("TRC20", BINANCE_TRX, ""),
        ("TON", BINANCE_TON, BINANCE_TON_MEMO),
    ]:
        set_binance_address(fixtures, code, address, tag)
    return fixtures


def set_binance_address(fixtures: dict, code: str, address: str, tag: str | None, **overrides) -> None:
    venue_id = BINANCE_IDS[code]
    info = {"coin": "USDT", "address": address, "tag": tag, "url": f"https://explorer/{address}"}
    fixtures[params_key("call_read_method", "fetchDepositAddress", {"network": code})] = {
        "currency": "USDT",
        "network": overrides.get("gated_network", code),
        "address": address,
        "tag": tag or None,
        "info": info,
    }
    row = {"coin": "USDT", "address": address, "isDefault": 1}
    if tag is not None:
        row["tag"] = tag
    rows = [row, {"coin": "USDT", "address": BINANCE_BSC_OLD, "tag": "", "isDefault": 0}]
    rows.extend(overrides.get("extra_rows", []))
    fixtures[
        params_key(
            "call_implicit_get", "sapiGetCapitalDepositAddressList", {"coin": "USDT", "network": venue_id}
        )
    ] = rows


def bybit_fixtures(
    free: float = 812.44,
    batch_release_limit: str = "-1",
    withdraw_fee: str = "0.3",
    withdraw_min: str = "10",
    extra_chains: list | None = None,
) -> dict:
    chain = {
        "chain": "BSC",
        "chainType": "BSC (BEP20)",
        "chainDeposit": "1",
        "chainWithdraw": "1",
        "depositMin": "1",
        "withdrawMin": withdraw_min,
        "contractAddress": USDT_BSC.lower(),
        "minAccuracy": "4",
        "withdrawFee": withdraw_fee,
        "withdrawPercentageFee": "0",
    }
    entry = {
        "chainType": "BSC (BEP20)",
        "chain": "BSC",
        "addressDeposit": BYBIT_BSC,
        "tagDeposit": "",
        "contractAddress": "197955",
        "batchReleaseLimit": batch_release_limit,
    }
    return {
        params_key("call_implicit_get", "privateGetV5UserQueryApi"): {
            "retCode": 0,
            "result": {
                "readOnly": 0,
                "permissions": {"Wallet": ["AccountTransfer", "Withdraw"]},
                "isMaster": True,
                "ips": ["*"],
                "userID": 1,
            },
        },
        params_key("call_read_method", "fetchDepositWithdrawFee"): {
            "info": {"coin": "USDT", "remainAmount": "1000000", "chains": [chain, *(extra_chains or [])]}
        },
        params_key("call_read_method", "fetchDepositAddressesByNetwork", {"network": "BEP20"}): {
            "BEP20": {"address": BYBIT_BSC, "tag": None, "network": "BEP20", "info": entry}
        },
        params_key(
            "call_implicit_get", "privateGetV5AssetDepositQueryAddress", {"coin": "USDT", "chainType": "BSC"}
        ): {
            "retCode": 0,
            "result": {"coin": "USDT", "chains": [entry]},
        },
        params_key("call_read_method", "fetchBalance", {"type": "funding"}): {"USDT": {"free": free}},
    }


# --------------------------------------------------------------------------- T3 secret card
def t3_secret_file(root: Path, value: str) -> Path:
    """What T3's request_secret with delivery "file" leaves behind: a 0600 file in a 0700 dir."""
    files = root / "t3-secrets" / "files"
    files.mkdir(parents=True, exist_ok=True)
    files.chmod(0o700)
    path = files / secrets.token_hex(16)
    partial = path.with_name(path.name + ".partial")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(value)
    partial.rename(path)
    return path


def run_then(step: dict, path: Path, env: dict) -> dict:
    """Run a secretStep's `then` command with the card's path, as the agent's shell would."""
    command = step["then"].replace("<FILE>", str(path))
    result = subprocess.run(
        ["sh", "-c", command], env=env, capture_output=True, text=True, timeout=60, check=False
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    body = json.loads(lines[-1]) if lines else {}
    body["_stderr"] = result.stderr
    body["_status"] = result.returncode
    return body


# --------------------------------------------------------------------------- T3 approval cards
APPROVE_PATTERN = re.compile(
    r"^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$", re.I
)


def t3_acceptance(params: dict) -> dict | None:
    """The content T3 fills for an accepted form, or None when it cannot fill a required field."""
    schema = params.get("requestedSchema") or {}
    content = {}
    for key, field in (schema.get("properties") or {}).items():
        options = list(field.get("enum") or []) + [item["const"] for item in field.get("oneOf") or []]
        chosen = next((option for option in options if APPROVE_PATTERN.match(option.strip())), None)
        if chosen is not None:
            content[key] = chosen
    if any(key not in content for key in schema.get("required") or []):
        return None
    return {"action": "accept", "content": content}


class T3Host(Host):
    """A host that answers forms the way T3 Code's approval card does.

    `decisions` is consumed per card shown: "approve", "decline", "cancel", "session" (Always allow
    this session) or None (the human never answers). A callable is called with the card's params
    while the card is open and returns one of those.
    """

    def __init__(self, env: dict, decisions=None, **options) -> None:
        self.decisions = list(decisions or [])
        self.cards: list[dict] = []
        self.auto_cancelled: list[dict] = []
        self.grants: set[str] = set()
        super().__init__(env, **options)

    def _answer_form(self, message: dict) -> None:
        params = message["params"]
        self.forms.append(params)
        acceptance = t3_acceptance(params)
        if acceptance is None:  # T3 cancels a form its card cannot answer, without showing it
            self.auto_cancelled.append(params)
            self._reply(message, {"action": "cancel"})
            return
        if params.get("message") in self.grants:
            self._reply(message, acceptance)
            return
        self.cards.append(params)
        decision = self.decisions.pop(0) if self.decisions else None
        if callable(decision):
            decision = decision(params)
        if decision is None:
            return
        if decision in ("decline", "cancel"):
            self._reply(message, {"action": decision})
            return
        if decision == "session":
            self.grants.add(params.get("message"))
        self._reply(message, acceptance)

    def _reply(self, message: dict, result: dict) -> None:
        self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})

    def call_many(
        self, calls: list[tuple[str, dict]], timeout: float = 60
    ) -> list[tuple[object, bool, dict]]:
        """Send several tools/call requests at once and wait for all of them."""
        ids = []
        for name, args in calls:
            request_id = self._next_id
            self._next_id += 1
            ids.append(request_id)
            self.send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": args},
                }
            )
        results = []
        with self._changed:
            for request_id in ids:
                if not self._changed.wait_for(lambda rid=request_id: rid in self._responses, timeout):
                    raise AssertionError("no response")
                results.append(self._responses.pop(request_id)["result"])
        return [(json.loads(r["content"][0]["text"]), bool(r.get("isError")), r) for r in results]

    def tool_full(self, name: str, args: dict, timeout: float = 60) -> tuple[dict, bool, dict]:
        result = self.request("tools/call", {"name": name, "arguments": args}, timeout)["result"]
        return json.loads(result["content"][0]["text"]), bool(result.get("isError")), result


# --------------------------------------------------------------------------- PNG and QR
def read_png_gray(path: Path) -> tuple[int, int, bytes]:
    """An independent 8-bit grayscale PNG reader (all five filters)."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    offset, idat, header = 8, b"", None
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        body = data[offset + 8 : offset + 8 + length]
        (crc,) = struct.unpack(">I", data[offset + 8 + length : offset + 12 + length])
        if zlib.crc32(kind + body) != crc:
            raise ValueError("bad CRC")
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        offset += 12 + length
    width, height, depth, color, _, _, interlace = header
    if (depth, color, interlace) != (8, 0, 0):
        raise ValueError("expected 8-bit grayscale")
    raw = zlib.decompress(idat)
    out = bytearray()
    previous = bytearray(width)
    for y in range(height):
        line = raw[y * (width + 1) : (y + 1) * (width + 1)]
        kind, row = line[0], bytearray(line[1:])
        for x in range(width):
            a = row[x - 1] if x else 0
            b = previous[x]
            c = previous[x - 1] if x else 0
            if kind == 1:
                row[x] = (row[x] + a) & 0xFF
            elif kind == 2:
                row[x] = (row[x] + b) & 0xFF
            elif kind == 3:
                row[x] = (row[x] + (a + b) // 2) & 0xFF
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[x] = (row[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        out += row
        previous = row
    return width, height, bytes(out)


def decode_qr(path: Path) -> bytes | None:
    """Decode the QR in a delivered PNG: Python pixels, jsQR decoding."""
    width, height, gray = read_png_gray(path)
    payload = json.dumps({"width": width, "height": height, "gray": base64.b64encode(gray).decode()})
    result = subprocess.run(
        [NODE, str(QR_DECODER)], input=payload, capture_output=True, text=True, timeout=60, check=True
    )
    body = json.loads(result.stdout)
    return bytes.fromhex(body["hex"]) if body["found"] else None
