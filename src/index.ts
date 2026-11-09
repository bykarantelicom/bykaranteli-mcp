#!/usr/bin/env node
/**
 * bykaranteli-mcp · MCP server for live crypto derivatives data
 *
 * Wraps the free, no-auth public JSON API at https://bykaranteli.com
 * (docs: https://bykaranteli.com/developers). All data is Binance USDT-M
 * perpetuals unless a tool says otherwise. Every response carries a
 * generated-at timestamp; quote it when citing values.
 */

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { registerByKaranteliTools } from "./tools.js";

// Single source of truth for the version: package.json ships in the tarball
// and sits one level above both src/ and dist/.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const BASE_URL = (process.env.BYKARANTELI_BASE_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");

/* GHSA-46jr (SDK 1.32.0, kept on 2.x): the combined number of array elements and object members one tools/call
 * `arguments` payload may carry; above it the server answers a tool error (isError) before validation. The largest
 * real input is an alert recipe (a few dozen members); the hosted endpoint sets the same ceiling. */
const MAX_TOOL_INPUT_ELEMENTS = 2_000;

/* One server per connection (1.0.0, SDK 2.x). serveStdio owns the era decision: a client that opens with the
 * 2025-era `initialize` handshake (every client released before the 2026-07-28 revision) is served exactly as the
 * 0.x releases served it; a client that opens with a 2026-07-28 per-request envelope (`server/discover` is the
 * modern probe) is served on that revision, with the same tools. The factory is called once per connection, plus
 * once for a discarded probe instance, so it registers the tools afresh each time. */
/* initialize.instructions (1.1.2, owner rule 2026-11-07): the one paragraph a client model reads before its first call,
 * the same text the hosted endpoint sends (web/src/lib/mcp-hosted.ts HOSTED_INSTRUCTIONS; ops/mcp-release-check.py
 * compares the two). Advice a well-behaved agent follows and relays to its user, never enforcement: the plan's rate
 * and monthly figures refuse on the server, and a client's provider does not police our terms. */
const INSTRUCTIONS =
  "ByKaranteli serves recorded crypto derivatives market data (liquidations, funding, open interest, options, ETF flows, positioning, order flow); every market-data tool is read-only, and the account tools that change alerts or the watchlist are marked as writes. A free key is for evaluation and personal scripts; a bot, a dashboard or a polling agent that runs continuously takes a plan (Terminal, Builder or Business by use). Call a tool no more often than its data refreshes (the daily brief once a day). A 429 answer carries retry-after: wait that long before calling again instead of retrying.";

function buildServer(): McpServer {
  const server = new McpServer({ name: "bykaranteli", version: VERSION }, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS, instructions: INSTRUCTIONS });
  registerByKaranteliTools(server, { version: VERSION });
  return server;
}

function main(): void {
  // If the host dies while a response is in flight, exit quietly instead of
  // crashing with an unhandled EPIPE from the stdout pipe. Non-EPIPE stream
  // errors would be swallowed once a listener exists, so log and exit nonzero.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    console.error("bykaranteli-mcp stdout error:", err);
    process.exit(1);
  });

  // stdout is the JSON-RPC channel; log to stderr only. Out-of-band protocol errors (a frame the server could not
  // use) are reported there too, cut short: the SDK builds some messages from the client's own frame.
  serveStdio(buildServer, {
    // The SDK's default, named so a later default change cannot silently drop the 2025-era clients.
    legacy: "serve",
    onerror: (err) => console.error(`bykaranteli-mcp: ${String(err.message ?? err).replace(/\s+/g, " ").slice(0, 300)}`),
  });
  console.error(`bykaranteli-mcp ready (base: ${BASE_URL})`);
}

try {
  main();
} catch (err) {
  console.error("bykaranteli-mcp fatal:", err);
  process.exit(1);
}
