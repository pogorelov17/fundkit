#!/usr/bin/env node
// fundkit: optional, session-only exchange profiles for the pinned ccxt-mcp server, from a
// Doppler config or from API credentials entered in private host cards.
//
//   fundkit install            one-time per machine: pinned ccxt-mcp, skill links, host registration
//   fundkit session [-- CMD]   private terminal step: hidden token prompt, holds the session
//   fundkit unlock --token-file PATH
//                              a private token file: background session (operator use)
//   fundkit mcp                MCP server the host launches (registered by `install`); in T3 Code
//                              it starts the background session itself after the operator's choice
//   fundkit status | stop      session state (no values) | end the session
//
// Node >= 20, standard library only. The implementation lives in ../lib.

import { main } from '../lib/cli.mjs';

const exitCode = await main(process.argv.slice(2));
if (exitCode !== null) process.exit(exitCode);
