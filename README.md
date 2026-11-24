# fundkit
A lightweight toolkit for moving funds between crypto wallets and exchanges.

## USDT (BSC): mobile OKX Wallet → your own Bybit account

- Skill (agent instructions): [`skills/okx-bsc-usdt-to-bybit/SKILL.md`](skills/okx-bsc-usdt-to-bybit/SKILL.md)
- Reference, checks, recovery, real-device limitations: [`docs/okx-bsc-usdt-to-bybit.md`](docs/okx-bsc-usdt-to-bybit.md)

```bash
npm install
npm test          # offline mock acceptance (no keys, no network, no funds)
npm run demo      # full mock run: link, QR, FUNDKIT_STATE lines

cp .env.example .env    # Bybit key/secret via env only (or `doppler run -- …`)
node src/cli.js preflight --amount 25
node src/cli.js start --amount 25            # prints HTTPS signing link, OKX link + QR
node src/cli.js resume --state '<FUNDKIT_STATE …>'
```

Layout: `src/` CLI, Bybit V5 client, BSC verification, flow and helper server;
`public/` the signing page (no secrets; shared ERC-20 helpers); `test/` mocks and acceptance tests.
Requires Node ≥ 20.12.
