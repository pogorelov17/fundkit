#!/usr/bin/env node
// fundkit: optional, session-only Doppler profiles for the pinned ccxt-mcp server.
//
//   fundkit install            one-time per machine: pinned ccxt-mcp, skill links, host registration
//   fundkit session [-- CMD]   private terminal step: hidden token prompt, holds the session
//   fundkit mcp                MCP server the host launches (registered by `install`)
//   fundkit status | stop      session state (no values) | end the session
//
// Node >= 20, standard library only. The implementation lives in ../lib.

import { main } from '../lib/cli.mjs';

const exitCode = await main(process.argv.slice(2));
if (exitCode !== null) process.exit(exitCode);
