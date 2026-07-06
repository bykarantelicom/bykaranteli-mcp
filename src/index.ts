#!/usr/bin/env node
/**
 * bykaranteli-mcp · MCP server for live crypto derivatives data
 *
 * Wraps the free, no-auth public JSON API at https://bykaranteli.com
 * (docs: https://bykaranteli.com/developers). All data is Binance USDT-M
 * perpetuals unless a tool says otherwise. Every response carries a
 * generated-at timestamp; quote it when citing values.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.BYKARANTELI_BASE_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");
const USER_AGENT = "bykaranteli-mcp/0.1.0 (+https://github.com/bykarantelicom/bykaranteli-mcp)";
const TIMEOUT_MS = 15_000;

async function fetchJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`${path} returned HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text",
        text: `Error fetching data from bykaranteli.com: ${message}. The API is free and unauthenticated; transient errors usually resolve on retry.`,
      },
    ],
    isError: true,
  };
}

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;

function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  // Accept bare coin names ("BTC", "sol") and expand to the USDT perp.
  const expanded = s.endsWith("USDT") ? s : `${s}USDT`;
  if (!SYMBOL_RE.test(expanded)) {
    throw new Error(`"${raw}" is not a valid symbol. Use a Binance USDT-M perp symbol like BTCUSDT or a coin name like BTC.`);
  }
  return expanded;
}

const server = new McpServer({
  name: "bykaranteli",
  version: "0.1.0",
});

server.registerTool(
  "get_market_indices",
  {
    title: "Crypto market indices (Fear & Greed, BTC dominance, euphoria)",
    description:
      "Call this when the user asks about overall crypto market sentiment or macro state: the Fear & Greed index (today and yesterday), Bitcoin dominance percentage, total market cap, or the Retail Euphoria composite. Live values refreshed about every 30 minutes.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/indices")) as Record<string, unknown>;
      // Trim heavy internals (weights/contributions) but keep the readable parts.
      const euphoria = d.euphoria as Record<string, unknown> | undefined;
      return ok({
        generatedAt: d.generatedAt,
        fearGreed: d.fearGreed,
        global: d.global,
        stablecoins: d.stablecoins,
        euphoria: euphoria
          ? {
              score: euphoria.score,
              regime: euphoria.regime,
              regimeLabel: euphoria.regimeLabel,
              explainer: euphoria.explainer,
            }
          : undefined,
        source: `${BASE_URL}/indices`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_funding_heatmap",
  {
    title: "Funding rates across top-30 Binance perps",
    description:
      "Call this when the user asks about current crypto funding rates in general, which coins have extreme funding, or funding for one specific coin. Returns per-symbol funding rate (per settlement interval), 24h open interest change and 24h price change for the top-30 Binance USDT-M perpetuals. Positive funding means longs pay shorts.",
    inputSchema: {
      symbol: z
        .string()
        .optional()
        .describe("Optional. Filter to one symbol, e.g. BTCUSDT or just BTC. Omit to get all 30 rows."),
    },
  },
  async ({ symbol }) => {
    try {
      const d = (await fetchJson("/api/public/heatmap")) as {
        generatedAt: string;
        rows: Array<{ symbol: string }>;
      };
      if (symbol) {
        const want = normalizeSymbol(symbol);
        const row = d.rows.find((r) => r.symbol === want);
        if (!row) {
          return ok({
            generatedAt: d.generatedAt,
            note: `${want} is not in the top-30 heatmap set. Tracked symbols: ${d.rows.map((r) => r.symbol).join(", ")}`,
          });
        }
        return ok({ generatedAt: d.generatedAt, row, source: `${BASE_URL}/heatmap` });
      }
      return ok({ ...d, source: `${BASE_URL}/heatmap` });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_funding_arbitrage",
  {
    title: "Cross-exchange funding arbitrage opportunities",
    description:
      "Call this when the user asks about funding arbitrage, funding rate differences between exchanges, or delta-neutral carry trades. Compares funding across Binance, OKX, Bybit, Gate, HTX and BingX for 12 major perps and returns the best long/short venue per symbol with gross and net annualized APR (net of taker fees and weekly rebalance cost).",
    inputSchema: {},
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/funding-arb")) as Record<string, unknown>;
      return ok({ ...d, source: `${BASE_URL}/funding-arb` });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_pressure_scores",
  {
    title: "Derivatives pressure scores (funding + OI + basis composite)",
    description:
      "Call this when the user asks which coins are crowded, over-leveraged, or under derivatives stress, or asks about the pressure score of a specific coin. Each symbol gets a 0-100 composite score built from funding rate, 1h/4h/24h open interest deltas and basis, with a LONG/SHORT/NEUTRAL direction and a plain-language regime label.",
    inputSchema: {
      symbol: z
        .string()
        .optional()
        .describe("Optional. Return only this symbol, e.g. BTCUSDT or BTC."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Optional. Max rows to return when no symbol filter is set (default 20, sorted by score)."),
    },
  },
  async ({ symbol, limit }) => {
    try {
      const d = (await fetchJson("/api/public/pressure")) as {
        generatedAt: string;
        items: Array<Record<string, unknown> & { symbol: string }>;
      };
      const slim = (it: Record<string, unknown>) => ({
        symbol: it.symbol,
        score: it.score,
        direction: it.direction,
        regimeLabel: it.regimeLabel,
        components: it.components,
        explainer: it.explainer,
      });
      if (symbol) {
        const want = normalizeSymbol(symbol);
        const item = d.items.find((i) => i.symbol === want);
        if (!item) {
          return ok({
            generatedAt: d.generatedAt,
            note: `${want} is not in the tracked pressure universe right now.`,
          });
        }
        return ok({ generatedAt: d.generatedAt, item: slim(item), source: `${BASE_URL}/pressure` });
      }
      return ok({
        generatedAt: d.generatedAt,
        items: d.items.slice(0, limit ?? 20).map(slim),
        totalTracked: d.items.length,
        source: `${BASE_URL}/pressure`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_top_movers",
  {
    title: "Top movers: OI spikes, extreme funding, widest basis, highest stress",
    description:
      "Call this when the user asks what is moving in crypto derivatives right now, which coins have the biggest open interest changes, the most extreme funding, the widest basis, or the highest derivatives stress. Returns four top-10 lists in one call.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/top-movers")) as Record<string, unknown>;
      return ok({ ...d, source: `${BASE_URL}/top-movers` });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_recent_signals",
  {
    title: "Recent closed trading signals with verified outcomes",
    description:
      "Call this when the user asks how the ByKaranteli signal engine is doing today, or wants recent closed LONG/SHORT signals with real outcomes (TP1, SL or TIMEOUT) and net basis-point results. Includes a 24h summary (wins, losses, net bps). Every signal is published with a SHA-256 receipt and results are net of fees, slippage and funding; live signals only, never backtests.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/recent")) as Record<string, unknown>;
      return ok({ ...d, source: `${BASE_URL}/signals` });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_symbol_performance",
  {
    title: "Per-symbol signal performance and recent trades",
    description:
      "Call this when the user asks how signals performed on a specific coin (win rate, profit factor, net PnL, best/worst trade) or wants that coin's recent closed signals. Data is the live verified track record for one Binance USDT-M perp over a 30, 90 or 180 day window.",
    inputSchema: {
      symbol: z.string().describe("The symbol, e.g. BTCUSDT, or a coin name like BTC."),
      window_days: z
        .union([z.literal(30), z.literal(90), z.literal(180)])
        .optional()
        .describe("Optional lookback window in days (30, 90 or 180). Default 90."),
    },
  },
  async ({ symbol, window_days }) => {
    try {
      const want = normalizeSymbol(symbol);
      const w = window_days ?? 90;
      let d: Record<string, unknown>;
      try {
        d = (await fetchJson(`/api/v1/public/symbols/${want}?window=${w}`)) as Record<string, unknown>;
      } catch (err) {
        // The API 404s when the symbol has no closed signals in the chosen
        // window (data-dependent, not an invalid request). Say so plainly.
        if (err instanceof Error && err.message.includes("HTTP 404")) {
          return ok({
            symbol: want,
            window_days: w,
            note: `No closed signals recorded for ${want} in the last ${w} days (or the symbol is not tracked). Try window_days: 180, or check ${BASE_URL}/symbols/${want}.`,
          });
        }
        throw err;
      }
      // daily_points can be long; the stats + recent signals carry the answer.
      const daily = d.daily_points as unknown[] | undefined;
      return ok({
        ...d,
        daily_points: Array.isArray(daily) ? daily.slice(-30) : daily,
        source: `${BASE_URL}/symbols/${want}`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_strategy_leaderboard",
  {
    title: "Strategy leaderboard with verified live results",
    description:
      "Call this when the user asks which trading strategies are performing best, or wants win rate, profit factor, drawdown and Sharpe per strategy. Rankings are computed from live closed signals only (no backtests), net of fees.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = (await fetchJson("/api/v1/public/leaderboard")) as Record<string, unknown>;
      return ok({ ...d, source: `${BASE_URL}/leaderboard` });
    } catch (err) {
      return fail(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; log to stderr only.
  console.error(`bykaranteli-mcp ready (base: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("bykaranteli-mcp fatal:", err);
  process.exit(1);
});
