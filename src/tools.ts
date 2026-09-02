/**
 * Tool registrations for the ByKaranteli MCP server, transport-agnostic.
 * The stdio bin (index.ts) and the hosted Streamable HTTP endpoint on
 * bykaranteli.com both call registerByKaranteliTools on their own server
 * instance, so all 20 tools have exactly one definition.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

export type RegisterOptions = {
  /** Override the API origin used for OUTBOUND fetches (the hosted endpoint
   * points this at the container-internal origin). */
  baseUrl?: string;
  /** Origin used in citations returned to the caller. Defaults to baseUrl.
   * The hosted endpoint must set this, otherwise every response cites the
   * container-internal address, which is useless to the agent reading it. */
  publicUrl?: string;
  /** Version string for the outbound user-agent. */
  version?: string;
};

export function registerByKaranteliTools(server: McpServer, options?: RegisterOptions): void {
  const BASE_URL = (options?.baseUrl ?? process.env.BYKARANTELI_BASE_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");
  const PUBLIC_URL = (options?.publicUrl ?? process.env.BYKARANTELI_PUBLIC_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");
  const USER_AGENT = `bykaranteli-mcp/${options?.version ?? "dev"} (+https://github.com/bykarantelicom/bykaranteli-mcp)`;
  const TIMEOUT_MS = 15_000;

// Read-only GET tools over an open-world public API, all of them.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Invalid tool input (not a network problem): no retry hint in the error. */
class InputError extends Error {}

async function fetchJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${path} timed out after ${TIMEOUT_MS / 1000}s`)),
    TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!res.ok) {
      /* Carry the route's own error body (audit P3 #412): "HTTP 400" alone
       * hid the actual reason (unknown metric, bad symbol...). */
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 2000);
      throw new Error(`${path} returned HTTP ${res.status}${body ? `: ${body}` : ""}`);
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

/* Every answer carries where it came from and when (README promise; audit
 * P3 #416): routes that already emit these keep their own values. */
function withProvenance(data: unknown, path: string): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  return {
    ...record,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString(),
    source: typeof record.source === "string" ? record.source : `${PUBLIC_URL}${path.replace(/^\/api\/public/, "").split("?")[0] || "/"}`,
  };
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = /returned HTTP 4\d\d/.test(message);
  const text =
    err instanceof InputError
      ? `Invalid input: ${message}`
      : permanent
        ? `Error fetching data from bykaranteli.com: ${message}. This is a permanent error for these inputs (wrong parameter or route), not a transient one; retrying will not help.`
        : `Error fetching data from bykaranteli.com: ${message}. The API is free and unauthenticated; transient errors usually resolve on retry.`;
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;

function normalizeSymbol(raw: string): string {
  // Accept the spellings models actually produce: "BTC/USDT", "btc-usdt",
  // "BTC USDT", bare "BTC". Strip separators, then expand to the USDT perp.
  const s = raw.trim().toUpperCase().replace(/[\s/_-]+/g, "");
  const expanded = s.endsWith("USDT") ? s : `${s}USDT`;
  if (!SYMBOL_RE.test(expanded)) {
    throw new InputError(`"${raw}" is not a valid symbol. Use a Binance USDT-M perp symbol like BTCUSDT or a coin name like BTC.`);
  }
  return expanded;
}

server.registerTool(
  "get_market_indices",
  {
    title: "Crypto market indices (Fear & Greed, BTC dominance, euphoria)",
    description:
      "Call this when the user asks about overall crypto market sentiment or macro state: the Fear & Greed index (today and yesterday), Bitcoin dominance percentage, total market cap, or the Retail Euphoria composite. Live values refreshed about every 30 minutes.",
    inputSchema: {},
    annotations: READ_ONLY,
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
        source: `${PUBLIC_URL}/indices`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_liquidations",
  {
    title: "Crypto liquidations: daily long/short totals per symbol and exchange",
    description:
      "Call this when the user asks how much was liquidated in crypto futures, whether longs or shorts got flushed, or for liquidation history. Returns daily long and short liquidation totals in USD per symbol and exchange, recorded from ByKaranteli's own Binance, Bybit, OKX, Gate, HTX and dYdX stream collectors (recorded events, a floor, not estimates). One row per finalized UTC day, symbol and exchange; history begins 2026-07-30 and grows daily.",
    inputSchema: {
      symbol: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{2,20}$/)
        .optional()
        .describe("Optional symbol filter like BTCUSDT or ETHUSDT. Omit for all symbols."),
      days: z.number().int().min(1).max(90).optional().describe("How many most recent days to return (default 7)."),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol, days }: { symbol?: string; days?: number }) => {
    try {
      const d = (await fetchJson("/api/v1/public/datasets/liquidations-daily.json")) as {
        rows?: Array<Record<string, unknown>>;
      };
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const wantDays = days ?? 7;
      const dates = [...new Set(rows.map((r) => String(r.date)))].sort().reverse().slice(0, wantDays);
      const dateSet = new Set(dates);
      /* Bare "BTC" is accepted like every other tool (audit P3 #414). */
      const wantSymbol = symbol ? (symbol.endsWith("USDT") ? symbol : `${symbol}USDT`) : undefined;
      const filtered = rows.filter(
        (r) => dateSet.has(String(r.date)) && (!wantSymbol || String(r.symbol).toUpperCase() === wantSymbol),
      );
      /* Totals are computed over EVERY matching row before the row cap. A
       * symbol-less 7-day call matches ~7,000 rows; returning only the first
       * 400 (one day, alphabetically) used to understate the weekly total
       * 11.5x with no warning in the payload (audit 2026-08-20 P1-67). */
      const num = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const byDate = new Map<string, { date: string; long_liquidations_usd: number; short_liquidations_usd: number; events: number; rows: number }>();
      let longTotal = 0;
      let shortTotal = 0;
      let eventsTotal = 0;
      for (const r of filtered) {
        const date = String(r.date);
        const long = num(r.long_liquidations_usd);
        const short = num(r.short_liquidations_usd);
        const events = num(r.events);
        longTotal += long;
        shortTotal += short;
        eventsTotal += events;
        const day = byDate.get(date) ?? { date, long_liquidations_usd: 0, short_liquidations_usd: 0, events: 0, rows: 0 };
        day.long_liquidations_usd += long;
        day.short_liquidations_usd += short;
        day.events += events;
        day.rows += 1;
        byDate.set(date, day);
      }
      const MAX_ROWS = 400;
      /* Largest rows first within the cap, newest day first. */
      const ordered = [...filtered].sort((a, b) => {
        const dd = String(b.date).localeCompare(String(a.date));
        if (dd !== 0) return dd;
        return (num(b.long_liquidations_usd) + num(b.short_liquidations_usd)) - (num(a.long_liquidations_usd) + num(a.short_liquidations_usd));
      });
      const truncated = ordered.length > MAX_ROWS;
      const baseNote = "Recorded from public exchange streams; totals are a floor (Binance throttles its stream). Live 24h view: " + PUBLIC_URL + "/liquidations";
      return ok({
        summary: {
          window_days: wantDays,
          dates_covered: dates,
          totals: {
            long_liquidations_usd: Math.round(longTotal),
            short_liquidations_usd: Math.round(shortTotal),
            total_liquidations_usd: Math.round(longTotal + shortTotal),
            events: eventsTotal,
            rows_matched: filtered.length,
          },
          by_date: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).map((d) => ({
            ...d,
            long_liquidations_usd: Math.round(d.long_liquidations_usd),
            short_liquidations_usd: Math.round(d.short_liquidations_usd),
          })),
        },
        rows: ordered.slice(0, MAX_ROWS),
        rows_returned: Math.min(ordered.length, MAX_ROWS),
        rows_matched: filtered.length,
        truncated,
        note: truncated
          ? `rows is capped at ${MAX_ROWS} of ${filtered.length} matching rows (largest first). Use summary.totals and summary.by_date for complete figures, or pass a symbol filter. ` + baseNote
          : baseNote,
        source: `${PUBLIC_URL}/liquidations`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_etf_flows",
  {
    title: "US spot Bitcoin and Ethereum ETF daily flows",
    description:
      "Call this when the user asks about Bitcoin or Ethereum ETF flows: daily net inflows or outflows, cumulative flow since launch, or total net assets of the US spot ETFs (IBIT, FBTC, ETHA and the rest). Returns one row per finalized US trading day and asset with net inflow, total net assets, cumulative inflow and value traded, all in USD. About 14 months of history.",
    inputSchema: {
      asset: z.enum(["BTC", "ETH"]).optional().describe("Filter to one asset. Omit for both."),
      days: z.number().int().min(1).max(400).optional().describe("How many most recent trading days to return (default 10)."),
    },
    annotations: READ_ONLY,
  },
  async ({ asset, days }: { asset?: "BTC" | "ETH"; days?: number }) => {
    try {
      const d = (await fetchJson("/api/v1/public/datasets/etf-flows.json")) as {
        rows?: Array<Record<string, unknown>>;
      };
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const filtered = rows.filter((r) => !asset || String(r.asset) === asset);
      /* Window by DATE like get_liquidations (audit D14-03): the old row-count
       * slice could cut one asset's day in half and reported no totals and no
       * truncation flag, so partial sums read as full ones. */
      const wantDays = days ?? 10;
      const dates = [...new Set(filtered.map((r) => String(r.date)))].sort().reverse().slice(0, wantDays);
      const dateSet = new Set(dates);
      const windowed = filtered.filter((r) => dateSet.has(String(r.date)));
      const totals: Record<string, number> = {};
      for (const r of windowed) {
        const a = String(r.asset);
        totals[a] = (totals[a] ?? 0) + (Number(r.net_inflow_usd) || 0);
      }
      return ok({
        rows: windowed,
        window_days: dates.length,
        window_net_inflow_usd: totals,
        truncated: dates.length < new Set(filtered.map((r) => String(r.date))).size,
        note: "Finalized US trading days only; a positive net_inflow_usd means the funds bought more of the asset than they sold that day. window_net_inflow_usd sums the returned window per asset.",
        source: `${PUBLIC_URL}/etf`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_funding_heatmap",
  {
    title: "Funding rates across the ~30 most traded Binance perps",
    description:
      "Call this when the user asks for the full current funding table across the ~30 most traded Binance perps (28-30 rows; contracts without a live funding print are skipped), or the funding rate of one specific coin. For a pre-ranked top-10 of the most extreme funding rates, use get_top_movers instead. Returns per-symbol funding rate (per settlement interval), 24h open interest change and 24h price change for the most traded Binance USDT-M perpetuals. Positive funding means longs pay shorts.",
    inputSchema: {
      symbol: z
        .string()
        .optional()
        .describe("Optional. Filter to one symbol, e.g. BTCUSDT or just BTC. Omit to get all 30 rows."),
    },
    annotations: READ_ONLY,
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
            note: `${want} is not in the heatmap set. Tracked symbols: ${d.rows.map((r) => r.symbol).join(", ")}`,
          });
        }
        return ok({ generatedAt: d.generatedAt, row, source: `${PUBLIC_URL}/heatmap` });
      }
      return ok({ ...d, source: `${PUBLIC_URL}/heatmap` });
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
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/funding-arb")) as Record<string, unknown>;
      return ok({ ...d, source: `${PUBLIC_URL}/funding-arb` });
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
      "Call this when the user asks which coins are crowded or over-leveraged, or asks for the pressure/derivatives-stress score of specific coins. For a quick top-10 ranking of the highest-stress coins right now, use get_top_movers instead. Each symbol gets a 0-100 composite score built from funding rate, 1h/4h/24h open interest deltas and basis, with a LONG/SHORT/NEUTRAL direction and a plain-language regime label.",
    inputSchema: {
      symbol: z
        .string()
        .optional()
        .describe("Optional. Return only this symbol, e.g. BTCUSDT or BTC."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Optional. Max rows to return when no symbol filter is set (default 20, sorted by score)."),
    },
    annotations: READ_ONLY,
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
        return ok({ generatedAt: d.generatedAt, item: slim(item), source: `${PUBLIC_URL}/pressure` });
      }
      return ok({
        generatedAt: d.generatedAt,
        items: d.items.slice(0, limit ?? 20).map(slim),
        totalTracked: d.items.length,
        source: `${PUBLIC_URL}/pressure`,
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
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/top-movers")) as Record<string, unknown>;
      return ok({ ...d, source: `${PUBLIC_URL}/top-movers` });
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
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/recent")) as Record<string, unknown>;
      return ok({ ...d, source: `${PUBLIC_URL}/signals` });
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
        .preprocess(
          (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
          z.union([z.literal(30), z.literal(90), z.literal(180)]),
        )
        .optional()
        .describe("Optional lookback window in days (30, 90 or 180). Default 90."),
    },
    annotations: READ_ONLY,
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
            note: `No closed signals recorded for ${want} in the last ${w} days (or the symbol is not tracked). Try window_days: 180, or check ${PUBLIC_URL}/symbols/${want}.`,
          });
        }
        throw err;
      }
      // daily_points can be long; the stats + recent signals carry the answer.
      const daily = d.daily_points as unknown[] | undefined;
      return ok({
        ...d,
        daily_points: Array.isArray(daily) ? daily.slice(-30) : daily,
        daily_points_truncated: Array.isArray(daily) ? daily.length > 30 : false,
        source: `${PUBLIC_URL}/symbols/${want}`,
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
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const d = (await fetchJson("/api/v1/public/leaderboard")) as Record<string, unknown>;
      return ok({ ...d, source: `${PUBLIC_URL}/leaderboard` });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_cot_positioning",
  {
    title: "CME futures positioning (weekly COT report, BTC + ETH)",
    description:
      "Call this when the user asks how hedge funds or institutions are positioned in Bitcoin or Ethereum, or about the CFTC Commitments of Traders report. Returns net positions in contracts, week-over-week changes, open interest and notable extremes/streaks, from official CFTC data updated every Friday. Note: a large share of hedge fund shorts is the market-neutral basis trade, so the weekly change carries more signal than the level.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/cot"), "/api/public/cot"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_options_snapshot",
  {
    title: "Options walls, gamma exposure and DVOL (BTC + ETH)",
    description:
      "Call this when the user asks where the big options bets sit, about call/put walls, gamma exposure (GEX), the zero-gamma level, implied volatility (DVOL) or the IV term structure for Bitcoin or Ethereum. Daily snapshot of listed crypto options: top strikes by open interest, put/call ratio, dealer hedging map and ATM IV by expiry.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/options"), "/api/public/options"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_coinbase_premium",
  {
    title: "Coinbase Premium (US demand gauge) + carry yield",
    description:
      "Call this when the user asks whether US investors are buying or selling Bitcoin or Ethereum, about the Coinbase Premium, or what the cash-and-carry basis trade pays. Returns the latest daily premium in percent, 7-day average, same-sign streak, the last 30 days, and annualized quarterly carry yields. History since 2017; positive premium = US buying pressure.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/premium"), "/api/public/premium"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_flow_toxicity",
  {
    title: "Order-flow toxicity (VPIN) for BTC, ETH, SOL perps",
    description:
      "Call this when the user asks whether informed or toxic order flow is building, about VPIN, or whether market makers are under pressure in Bitcoin, Ethereum or Solana. Returns the current VPIN (0 = balanced, 1 = fully one-sided), its 90-day percentile, the danger threshold and the 24h average. Elevated readings historically precede volatility; VPIN says nothing about direction.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/flow"), "/api/public/flow"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_options_flow",
  {
    title: "Options tape: biggest prints and premium flow (BTC + ETH)",
    description:
      "Call this when the user asks what big options players are buying, about block trades, or whether call or put premium dominates today. Returns 24h call vs put premium bought, the block-trade share, and the largest prints of the last 48 hours with strikes, premium, IV and venue (Deribit or OKX). Updated every 15 minutes.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/options-flow"), "/api/public/options-flow"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_slippage",
  {
    title: "Live execution cost: what a market order really costs",
    description:
      "Call this when the user asks how much slippage a trade of a given size would face, how thick the books are, or which major perp market is thinnest right now. Returns live cost ladders in basis points for $10K to $5M market orders across 8 major perpetuals, both sides, from the full visible order book. Excludes fees; null = the book cannot absorb that size.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/slippage"), "/api/public/slippage"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_fomc_impact",
  {
    title: "Measured FOMC impact on Bitcoin",
    description:
      "Call this when the user asks what Bitcoin does on Fed days, how FOMC statements move crypto, or when the next FOMC meeting is. Returns per-statement 5/30/60-minute BTC reactions measured from a minute-resolution record, the average move versus a normal half hour, the up/down split (near a coin flip), and the next meeting date. Description, not prediction.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/events"), "/api/public/events"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_liquidation_cascades",
  {
    title: "Auto-detected liquidation cascades (forensic case file)",
    description:
      "Call this when the user asks what caused a recent crash or flush, about liquidation cascades, or who got liquidated. Returns auto-detected cascade incidents: when, total notional flushed, long/short split, which coins led, and BTC's move during the window. Totals are an honestly-labeled lower bound from a real liquidation tape.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/incidents"), "/api/public/incidents"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_open_interest",
  {
    title: "Intraday open interest and leverage regimes (10 major perps)",
    description:
      "Call this when the user asks whether leverage is entering or leaving the market, about open interest changes, or whether longs or shorts are building in a major coin. Returns 5-minute-resolution OI with 24h OI and price deltas and a four-regime read per symbol: longs building, shorts building, long squeeze, short squeeze, or quiet.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/oi"), "/api/public/oi"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_psi_charge",
  {
    title: "PsiCharge liquidity state (proprietary model, outcomes published)",
    description:
      "Call this when the user asks about the market's hidden liquidity state, PsiCharge, or whether parked money is deploying or stress is unwinding. Returns the current Psi score (0-100), state (superposition = charge building, collapse = low-stress discharge, purge = high-stress discharge and historically the most consistent risk-off state, ground = ordinary), stress locality, recent alarms and the year-split measured scorecard. Inputs are proprietary; outcomes are always published. Not a trade signal, not a crash predictor.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/charge"), "/api/public/charge"));
    } catch (err) {
      return fail(err);
    }
  },
);
server.registerTool(
  "get_altseason",
  {
    title: "Altcoin Season Index (live + recorded history)",
    description:
      "Call this when the user asks whether it is altseason, how altcoins are doing against Bitcoin, or about market rotation. Returns the live Altcoin Season Index (share of the top 50 Binance perpetual altcoins beating BTC over the trailing 90 days; >=75 altseason, <=25 bitcoin season), the strongest and weakest large alts, and the recorded daily history (never reconstructed).",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/altseason"), "/api/public/altseason"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_quantum_exposure",
  {
    title: "Quantum-exposed Bitcoin (daily first-party measurement)",
    description:
      "Call this when the user asks how much Bitcoin is vulnerable to a quantum computer, about quantum-exposed supply, P2PK coins, or Satoshi-era exposure. Returns the latest daily measurement from ByKaranteli's own Bitcoin Core node: exposed BTC and its share of held value and UTXO count, composition by script family, dormancy cohorts, the dormant-P2PK watch set, and provenance hashes (base_height, base_hash, txoutset_hash) so any figure can be re-verified against any node.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/quantum"), "/api/public/quantum"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_metric_context",
  {
    title: "Historical context for any recorded metric (conditional distribution)",
    description:
      "Call this when the user asks whether a metric's current reading is high or low, or what happened after similar readings. Buckets today's value against the metric's own recorded daily history and returns the median forward BTC return and up-share per bucket at +1/+3/+7 days, with the all-days base rate alongside. Honesty rules: buckets under 30 days are suppressed, and most metrics do NOT separate from the base rate; the interpretation says so plainly. History, not a forecast. Metrics include coinbase_premium_pct, kraken_btc_premium_pct, dvol_btc, fear_greed, funding_btc_daily_pct, etf_btc_net_flow_usd, vpin_btc, altseason_index, stablecoin_total_mcap_busd, fred_dff, fred_dgs10, fred_walcl_busd, fred_rrp_busd and the btc_* network series.",
    inputSchema: {
      metric: z
        .string()
        .regex(/^[a-z0-9_]{2,50}$/)
        .describe("Metric key, e.g. coinbase_premium_pct, fear_greed, altseason_index, stablecoin_total_mcap_busd."),
    },
    annotations: READ_ONLY,
  },
  async ({ metric }) => {
    try {
      return ok(withProvenance(await fetchJson(`/api/public/context?metric=${encodeURIComponent(metric)}`), `/api/public/context?metric=${encodeURIComponent(metric)}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_theme_indices",
  {
    title: "Crypto narrative indices (AI, RWA, DePIN, meme, L1, L2, DeFi, quantum)",
    description:
      "Call this when the user asks which crypto narrative or sector is leading, about rotation between AI, RWA, DePIN, memecoins, layer 1, layer 2, DeFi or quantum coins, or for a theme index. Returns eight equal-weight fixed-basket indices rebased to 100 on 2025-01-01 with 1d/7d/30d/90d/YTD returns, vs BTC, and the member lists; daily points are omitted unless include_points is true.",
    inputSchema: { include_points: z.boolean().optional().describe("boolean, optional: include the daily index points (large)") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = args.include_points === true ? "/api/public/themes" : "/api/public/themes?points=0";
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_factor_board",
  {
    title: "Factor board: what followed days like today across recorded metrics",
    description:
      "Call this when the user asks which indicators currently sit in an unusual band, whether a metric's current level historically preceded BTC moves, or for a cross-metric conditional overview. Returns every recorded metric in its historical band with the median 7-day BTC move that followed versus the base rate, with an n >= 30 gate; distributions, not forecasts.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/factors"), "/api/public/factors"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_venue_markets",
  {
    title: "Exchange coverage: OI, volume, funding and pegs across 43 exchanges",
    description:
      "Call this when the user asks about total open interest across exchanges, which venues hold the most OI, DEX versus CEX share, funding dispersion between venues, or stablecoin pegs. Returns the latest 10-minute snapshot aggregates across 56 feeds on 43 exchanges; pass symbol for one coin's per-venue rows.",
    inputSchema: { symbol: z.string().optional().describe("string, optional base asset, e.g. BTC") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = args.symbol ? `/api/public/venues/markets?symbol=${encodeURIComponent(args.symbol.toUpperCase())}` : "/api/public/venues/markets";
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_lead_lag",
  {
    title: "Venue lead-lag: who moves first (Coinbase, Kraken, Binance)",
    description:
      "Call this when the user asks which exchange leads price discovery or whether spot or perp moves first. Returns per-pair daily cross-correlations of one-minute returns at lags -3..+3 and the lead asymmetry, with the share of days each venue led.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/venues/lead-lag"), "/api/public/venues/lead-lag"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_iv_surface",
  {
    title: "Options implied-volatility surface and 25-delta skew",
    description:
      "Call this when the user asks about implied volatility by strike or expiry, skew, put versus call IV, term structure of IV, or whether downside protection is expensive. Returns the IV surface (expiry x moneyness), per-expiry ATM / 25-delta put and call IV, skew and butterfly, and the constant-30d history, from the daily Deribit chain.",
    inputSchema: { currency: z.string().optional().describe("BTC or ETH, default BTC") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = `/api/public/options/surface?currency=${(args.currency ?? "BTC").toUpperCase() === "ETH" ? "ETH" : "BTC"}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_whale_tape",
  {
    title: "Whale tape: $1M+ aggressive prints with 24h buy share",
    description:
      "Call this when the user asks about whale trades, large market orders, or whether big players are buying or selling right now. Returns recent $1M+ aggressive prints recorded live from our own sockets and 24h aggregates with the buy share.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/whales"), "/api/public/whales"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_correlations",
  {
    title: "Crypto correlation matrix",
    description:
      "Call this when the user asks how correlated two coins are, for decorrelated pairs, or how tightly alts track BTC. Returns the 30-day rolling Pearson correlation matrix of daily returns across the top perpetuals.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/correlations"), "/api/public/correlations"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_new_listings",
  {
    title: "New and delisted perpetual contracts",
    description:
      "Call this when the user asks what new perpetuals were listed, which exchange listed a coin first, or about delistings. Returns listings and delistings across six exchanges from the hourly scan.",
    inputSchema: { days: z.number().int().min(1).max(30).optional().describe("Window in days, 1-30 (default 30). Longer listing history is the paid x402 dataset.") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = `/api/public/listings?days=${args.days && args.days > 0 ? Math.floor(args.days) : 30}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_macro_liquidity",
  {
    title: "Macro liquidity: Fed funds, 10y, balance sheet, RRP, stablecoin supply",
    description:
      "Call this when the user asks about macro liquidity, the Fed balance sheet, reverse repo, rates or stablecoin supply in relation to crypto. Returns the recorded daily series and latest values.",
    inputSchema: { days: z.number().int().min(1).max(730).optional().describe("Window in days, 1-730 (default 365).") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = `/api/public/macro?days=${args.days && args.days > 0 ? Math.floor(args.days) : 365}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_network_health",
  {
    title: "Bitcoin network health from our own node",
    description:
      "Call this when the user asks about Bitcoin hashrate, difficulty, fees or mempool congestion. Returns the recorded daily series and latest values measured on ByKaranteli's own node.",
    inputSchema: { days: z.number().int().min(1).max(730).optional().describe("Window in days, 1-730 (default 365).") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = `/api/public/network?days=${args.days && args.days > 0 ? Math.floor(args.days) : 365}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_liqmap",
  {
    title: "LiqMap: estimated liquidation clusters with real prints overlaid",
    description:
      "Call this when the user asks where liquidation clusters or liquidity pools sit for a perpetual, where leveraged longs/shorts would get liquidated, or for a liquidation heatmap reading. Returns the public LiqMap snapshot for one symbol: modeled liquidation levels by price, zone aggregates and real liquidation prints from six venues. Public tier serves the 24h view; other intervals are a member feature at the source page.",
    inputSchema: {
      symbol: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{2,20}$/)
        .optional()
        .describe("Symbol like BTCUSDT (bare BTC accepted). Default BTCUSDT."),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol }: { symbol?: string }) => {
    try {
      const raw = symbol ?? "BTCUSDT";
      const sym = raw.endsWith("USDT") ? raw : `${raw}USDT`;
      const path = `/api/liqmap/public?symbol=${encodeURIComponent(sym)}&timeframe=24h`;
      const data = await fetchJson(path);
      return ok({ ...(data as Record<string, unknown>), source: `${PUBLIC_URL}/liqmap/${sym.replace(/USDT$/, "").toLowerCase()}` });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_tradfi_board",
  {
    title: "TradFi perpetuals: stock, index and commodity perps on Binance",
    description:
      "Call this when the user asks about stock perpetuals (TSLA, NVDA, AAPL, gold, S&P 500...), tokenized-equity perps, TradFi perp funding rates, open interest, liquidations, which exchanges list a stock perp, or whether the equity session is open. Returns Binance's TradFi perpetual board: per contract mark, index, basis, funding, 24h change and volume, open interest, 24h recorded liquidations, other venues listing the same underlying, and the trading-session state per market. Filter by market (EQUITY, HK_EQUITY, KR_EQUITY, CN_EQUITY, COMMODITY, INDEX, PREMARKET) or one symbol.",
    inputSchema: {
      market: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z_]{3,16}$/)
        .optional()
        .describe("Market filter: EQUITY | HK_EQUITY | KR_EQUITY | CN_EQUITY | COMMODITY | INDEX | PREMARKET"),
      symbol: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{2,24}$/)
        .optional()
        .describe("One Binance TradFi symbol, e.g. TSLAUSDT"),
    },
    annotations: READ_ONLY,
  },
  async ({ market, symbol }: { market?: string; symbol?: string }) => {
    try {
      const params = new URLSearchParams();
      if (market) params.set("market", market);
      if (symbol) params.set("symbol", symbol);
      const qs = params.toString();
      const path = `/api/public/tradfi${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);


server.registerTool(
  "get_rsi_heatmap",
  {
    title: "RSI heatmap: Wilder RSI(14) on eight timeframes for ~580 perps",
    description:
      "Call this when the user asks which coins are overbought or oversold, for a crypto RSI heatmap, multi-timeframe RSI, or one contract's RSI on 15m, 1h, 4h, 12h, 1d, 3d, 1w or 1M. Returns the live board for the top-400 Binance crypto perps by volume plus every TradFi perp, with overbought/oversold counts per interval. Filter by symbol or kind (crypto|tradfi), sort by an interval.",
    inputSchema: {
      symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,24}$/).optional().describe("One Binance symbol, e.g. BTCUSDT"),
      kind: z.enum(["crypto", "tradfi"]).optional().describe("crypto | tradfi"),
      sort: z.enum(["15m", "1h", "4h", "12h", "1d", "3d", "1w", "1M"]).optional().describe("Interval to sort by, descending"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol, kind, sort }: { symbol?: string; kind?: string; sort?: string }) => {
    try {
      const params = new URLSearchParams();
      if (symbol) params.set("symbol", symbol);
      if (kind) params.set("kind", kind);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      const path = `/api/public/rsi${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);


server.registerTool(
  "get_cycle_indicators",
  {
    title: "Bitcoin cycle indicators: Pi Cycle, Mayer, 200W MA, Puell, S2F",
    description:
      "Call this when the user asks whether Bitcoin is near a cycle top or bottom by the classic indicators, about the Pi Cycle Top, Mayer Multiple, 200-week moving average, 2-year MA multiplier, golden ratio multiple, profitable days, stock-to-flow, Puell Multiple or Bitfinex margin positioning. Returns the latest readings, the Pi Cycle cross dates on record, and optionally the daily series (recomputed nightly from a first-party close record since 2012). Levels, not forecasts.",
    inputSchema: {
      days: z.number().int().min(30).max(10000).optional().describe("Window in days for the series (default 730)"),
      include_points: z.boolean().optional().describe("Include the daily series (large). Default false: latest values and cross dates only."),
    },
    annotations: READ_ONLY,
  },
  async ({ days, include_points }: { days?: number; include_points?: boolean }) => {
    try {
      const path = `/api/public/indicators?days=${days && days > 0 ? Math.floor(days) : 730}${include_points ? "" : "&points=0"}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);


server.registerTool(
  "get_hl_whales",
  {
    title: "Hyperliquid whale tracker: top-300 accounts, long vs short, positions, changes",
    description:
      "Call this when the user asks what Hyperliquid whales are doing, whether the biggest Hyperliquid accounts are net long or short a coin, for the largest open positions with liquidation prices, or what large accounts just opened, closed or flipped. Returns the live board of the 300 largest accounts by equity (scanned every 5 minutes, addresses only) and with events the last 200 position changes.",
    inputSchema: {
      coin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,24}$/).optional().describe("One coin, e.g. BTC"),
      events: z.boolean().optional().describe("Include the last 200 position change events"),
    },
    annotations: READ_ONLY,
  },
  async ({ coin, events }: { coin?: string; events?: boolean }) => {
    try {
      const params = new URLSearchParams();
      if (coin) params.set("coin", coin);
      if (events) params.set("events", "1");
      const qs = params.toString();
      const path = `/api/public/hyperliquid-whales${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);


server.registerTool(
  "get_positioning",
  {
    title: "Positioning: long/short ratios, taker buy/sell and CVD on Binance, Bybit, OKX",
    description:
      "Call this when the user asks about the long/short ratio, whether retail or top traders are net long or short, the taker buy/sell ratio, or CVD (cumulative volume delta) for a perpetual. Returns exchange-published statistics for the 30 most traded Binance USDT perps (Binance global and top-trader ratios, Bybit share long, OKX ratios and taker volume) and CVD series for BTC, ETH and SOL; refreshed every 15 minutes.",
    inputSchema: {
      symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,24}$/).optional().describe("One Binance symbol, e.g. BTCUSDT"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol }: { symbol?: string }) => {
    try {
      const path = `/api/public/positioning${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);


server.registerTool(
  "get_coverage",
  {
    title: "Coverage registry: which venues and data types we collect, how, and how fresh",
    description:
      "Call this when the user asks which exchanges sit behind a ByKaranteli number, whether a feed is complete or sampled, since when a venue is collected, or how fresh the data is. Returns the live coverage registry: liquidation feeds per venue with kind and last record, snapshot feeds per venue and market, funding arbitrage legs, positioning sources, whale tape, spot minutes and the Hyperliquid whale scan with freshness.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const path = "/api/public/coverage";
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

}
