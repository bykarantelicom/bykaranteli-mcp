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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerByKaranteliTools } from "./tools.js";

// Single source of truth for the version: package.json ships in the tarball
// and sits one level above both src/ and dist/.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const BASE_URL = (process.env.BYKARANTELI_BASE_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");

const server = new McpServer({
  name: "bykaranteli",
  version: VERSION,
});
registerByKaranteliTools(server, { version: VERSION });

async function main() {
  // If the host dies while a response is in flight, exit quietly instead of
  // crashing with an unhandled EPIPE from the stdout pipe. Non-EPIPE stream
  // errors would be swallowed once a listener exists, so log and exit nonzero.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    console.error("bykaranteli-mcp stdout error:", err);
    process.exit(1);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; log to stderr only.
  console.error(`bykaranteli-mcp ready (base: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("bykaranteli-mcp fatal:", err);
  process.exit(1);
});
