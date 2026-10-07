/**
 * Tool registrations for the ByKaranteli MCP server, transport-agnostic.
 * The stdio bin (index.ts) and the hosted Streamable HTTP endpoint on
 * bykaranteli.com both call registerByKaranteliTools on their own server
 * instance, so all 20 tools have exactly one definition.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { buildProvenance, pageForApiPath } from "./provenance.js";

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
  /** Account API key (bk_...) sent as Authorization: Bearer on every fetch.
   * Since 2026-09-10 the public API asks programs for one; a free key comes
   * with any verified account (https://bykaranteli.com/dashboard/api) and paid
   * plans raise the rate and unlock member depth. Falls back to the
   * BYKARANTELI_API_KEY environment variable. */
  apiKey?: string;
  /** Per-call Authorization value, for hosts that forward their caller's key
   * (the hosted endpoint). Takes precedence over apiKey when it returns one. */
  authorizationProvider?: () => string | undefined;
};

export function registerByKaranteliTools(server: McpServer, options?: RegisterOptions): void {
  const BASE_URL = (options?.baseUrl ?? process.env.BYKARANTELI_BASE_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");
  const PUBLIC_URL = (options?.publicUrl ?? process.env.BYKARANTELI_PUBLIC_URL ?? "https://bykaranteli.com").replace(/\/+$/, "");
  const USER_AGENT = `bykaranteli-mcp/${options?.version ?? "dev"} (+https://github.com/bykarantelicom/bykaranteli-mcp)`;
  const TIMEOUT_MS = 15_000;
  const STATIC_KEY = (options?.apiKey ?? process.env.BYKARANTELI_API_KEY ?? "").trim();
  const authorizationFor = (): string | undefined => {
    /* A host that forwards its callers' keys (authorizationProvider) never falls back to a static key: on the
     * hosted endpoint that fallback would have let every keyless caller act as whatever key the process held
     * (security review 2026-09-30). The static key is for a local stdio server with one owner. */
    if (options?.authorizationProvider) return options.authorizationProvider() || undefined;
    return STATIC_KEY ? `Bearer ${STATIC_KEY}` : undefined;
  };

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
    const authorization = authorizationFor();
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(authorization ? { authorization } : {}),
      },
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
 * P3 #416): routes that already emit these keep their own values. Since
 * 0.31.0 a provenance block rides along too (src/provenance.ts): source page,
 * API path, the answer's own timestamp, fetch time, venues, full or sampled
 * coverage, stale feeds, first recorded day and the proof page, each only
 * when the answer carries it. The page map (stems whose page has another
 * name) moved there as well. */
function provenanceFor(data: unknown, path: string, page?: string) {
  return buildProvenance(data, { apiPath: path, sourcePage: `${PUBLIC_URL}${page ?? pageForApiPath(path)}`, fetchedAt: new Date().toISOString() });
}

function withProvenance(data: unknown, path: string): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  return {
    ...record,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString(),
    source: typeof record.source === "string" ? record.source : `${PUBLIC_URL}${pageForApiPath(path)}`,
    provenance: provenanceFor(record, path),
  };
}

/* Compact JSON (pretty-printing cost ~35% of the budget) and a hard ceiling:
 * a few argument combinations produced 400k+ characters, more than an LLM
 * context window, with no signal that anything was cut (audit 2026-09-04
 * #41). Above the ceiling the tool answers with guidance instead of a
 * payload the caller could not use anyway. */
const MAX_RESULT_CHARS = 240_000;

function ok(data: unknown): ToolResult {
  const text = JSON.stringify(data);
  if (text.length <= MAX_RESULT_CHARS) return { content: [{ type: "text", text }] };
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        truncated: true,
        chars: text.length,
        limit: MAX_RESULT_CHARS,
        note: "Result too large for one context window. Narrow the call: fewer hours or days, a single symbol, or include_points=false, then call again.",
      }),
    }],
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = /returned HTTP 4\d\d/.test(message);
  const text =
    err instanceof InputError
      ? `Invalid input: ${message}`
      : permanent
        ? `Error fetching data from bykaranteli.com: ${message}. This is a permanent error for these inputs (wrong parameter or route), not a transient one; retrying will not help.`
        : `Error fetching data from bykaranteli.com: ${message}. Transient errors usually resolve on retry.`;
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
        provenance: provenanceFor(d, "/api/public/indices", "/indices"),
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
      "Call this when the user asks how much was liquidated in crypto futures, whether longs or shorts got flushed, or for liquidation history. Returns daily long and short liquidation totals in USD per symbol and exchange, recorded from ByKaranteli's own stream collectors on every liquidation venue it counts, listed on bykaranteli.com/coverage (recorded events, a floor, not estimates). One row per finalized UTC day, symbol and exchange; history begins 2026-07-30 and grows daily.",
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
        provenance: provenanceFor(d, "/api/v1/public/datasets/liquidations-daily.json", "/liquidations"),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_etf_flows",
  {
    title: "US spot Bitcoin, Ethereum, Solana and XRP ETF daily flows",
    description:
      "Call this when the user asks about Bitcoin, Ethereum, Solana or XRP spot ETF flows: daily net inflows or outflows, cumulative flow since launch, or total net assets of the US spot ETFs (IBIT, FBTC, ETHA, XRPC and the rest). Returns one row per finalized US trading day and asset with net inflow, total net assets, cumulative inflow since launch and value traded, all in USD. History by asset: BTC and ETH since 2025-05-20, SOL since 2025-10-28, XRP since 2026-09-08.",
    inputSchema: {
      asset: z.enum(["BTC", "ETH", "SOL", "XRP"]).optional().describe("Filter to one asset (BTC, ETH, SOL or XRP). Omit for all."),
      days: z.number().int().min(1).max(400).optional().describe("How many most recent trading days to return (default 10)."),
    },
    annotations: READ_ONLY,
  },
  async ({ asset, days }: { asset?: "BTC" | "ETH" | "SOL" | "XRP"; days?: number }) => {
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
        provenance: provenanceFor(d, "/api/v1/public/datasets/etf-flows.json", "/etf"),
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
        return ok({ generatedAt: d.generatedAt, row, source: `${PUBLIC_URL}/heatmap`, provenance: provenanceFor(d, "/api/public/heatmap") });
      }
      return ok({ ...d, source: `${PUBLIC_URL}/heatmap`, provenance: provenanceFor(d, "/api/public/heatmap") });
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
      "Call this when the user asks about funding arbitrage, funding rate differences between exchanges, or delta-neutral carry trades. Compares funding across every venue on the board, from Binance, OKX and Bybit to Hyperliquid, dYdX and the smaller perp venues fed by the venue snapshot, for 12 major perps and returns the best long/short venue per symbol with gross and net annualized APR (net of taker fees and weekly rebalance cost).",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const d = (await fetchJson("/api/public/funding-arb")) as Record<string, unknown>;
      return ok({ ...d, source: `${PUBLIC_URL}/funding-arb`, provenance: provenanceFor(d, "/api/public/funding-arb") });
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
        /* BYK Data Layer reference (rc6 section 14): the sealed record of the same computation,
         * so an assistant can cite the on-chain proof of the score it quotes. */
        ...(it.byk_proof !== undefined ? { byk_proof: it.byk_proof } : {}),
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
        return ok({ generatedAt: d.generatedAt, item: slim(item), source: `${PUBLIC_URL}/pressure`, provenance: provenanceFor(d, "/api/public/pressure") });
      }
      return ok({
        generatedAt: d.generatedAt,
        items: d.items.slice(0, limit ?? 20).map(slim),
        totalTracked: d.items.length,
        source: `${PUBLIC_URL}/pressure`,
        provenance: provenanceFor(d, "/api/public/pressure"),
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
      return ok({ ...d, source: `${PUBLIC_URL}/top-movers`, provenance: provenanceFor(d, "/api/public/top-movers") });
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
      "Call this when the user asks where the big options bets sit, about call/put walls, gamma exposure (GEX), the zero-gamma level, implied volatility (DVOL) or the IV term structure for Bitcoin or Ethereum, across options venues or on one venue. Daily snapshot of the listed option chains of every options venue we record, summed by default or one venue with venue: the call wall (largest call open interest above spot) and put wall (largest put open interest below spot), the largest bars on the whole axis, top strikes by open interest, put/call ratio, dealer hedging map, ATM IV by expiry (calls and puts interpolated at the money, iv_source names the venue whose quotes price the chain), each venue's open interest (venues_included), and per expiry the open interest by side, the max pain strike (where the open contracts as a group pay out the least at settlement, not a price target) and the one-sigma implied move the ATM IV prices (expiries). DVOL is Deribit's index whatever the venue.",
    inputSchema: {
      venue: z.enum(["all", "deribit", "bybit", "binance", "okx", "delta"]).optional().describe("all (default) sums every options venue; or one venue id: deribit, bybit, binance, okx or delta (Delta Exchange India)."),
    },
    annotations: READ_ONLY,
  },
  async ({ venue }: { venue?: "all" | "deribit" | "bybit" | "binance" | "okx" | "delta" }) => {
    try {
      const path = venue && venue !== "all" ? `/api/public/options?venue=${venue}` : "/api/public/options";
      return ok(withProvenance(await fetchJson(path), path));
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
      "Call this when the user asks what big options players are buying, about block trades, or whether call or put premium dominates today. Returns 24h call vs put premium bought (net of the sold legs of the same multi-leg block or combo, so a spread counts its net premium), the block-trade share, the multi-leg structure count, and the largest prints of the last 48 hours with strikes, premium, IV, structure id and venue (Deribit or OKX). Updated every 15 minutes.",
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
  "get_liquidation_leaderboard",
  {
    title: "Largest single liquidations and a 30-day session heatmap (counted venue feeds)",
    description:
      "Call this when the user asks for the biggest liquidation today or this week, who got liquidated for the most, the largest single liquidation print, or when in the day or week liquidations cluster (Asia, Europe or US hours, weekday by UTC hour). Returns the largest single liquidation prints of the last 24h, 7d or 30d (rank, symbol, venue, side where SELL means a long was liquidated, price, quantity, notional, millisecond time) recorded from the counted venues' public feeds, plus a 30-day weekday by UTC hour heatmap with hour, weekday and session totals. Binance publishes at most one print per second per symbol, so its rows are a floor.",
    inputSchema: {
      window: z.enum(["24h", "7d", "30d"]).optional().describe("Ranking window: 24h (default), 7d or 30d."),
      limit: z.number().int().min(1).max(100).optional().describe("Rows to return (default 25, max 100)."),
      days: z.number().int().min(7).max(90).optional().describe("Days folded into the session heatmap (default 30)."),
    },
    annotations: READ_ONLY,
  },
  async ({ window, limit, days }: { window?: "24h" | "7d" | "30d"; limit?: number; days?: number }) => {
    try {
      const params = new URLSearchParams();
      if (window) params.set("window", window);
      if (limit) params.set("limit", String(limit));
      if (days) params.set("days", String(days));
      const qs = params.toString();
      const path = `/api/public/liquidation-leaderboard${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_insurance_funds",
  {
    title: "Exchange insurance funds: size, 24h and 7d change, fund against open interest, daily history",
    description:
      "Call this when the user asks how big an exchange's insurance fund is, whether a fund is shrinking or was used after a crash, how much exchanges hold to absorb bankrupt liquidations, or how a fund compares with the venue's open interest. Returns the latest hourly reading per covered venue (every exchange the insurance fund board lists): the fund in USD (OKX's own published total, the sum of priced pools elsewhere), per asset, 24h and 7d change, the fund as a percent of the venue's perpetual open interest on the coins ByKaranteli tracks, and daily closes per venue. Set pools to include every pool row (the contracts it covers, asset, balance, USD). A fund is a balance the venue reports, not an audit of its reserves.",
    inputSchema: {
      venue: z.enum(["binance", "bybit", "okx", "gate"]).optional().describe("One venue; omit for every covered venue."),
      history_days: z.number().int().min(1).max(366).optional().describe("Days of daily closes (default 30, max 366)."),
      pools: z.boolean().optional().describe("Include every pool row (large for Binance and Bybit). Default false."),
    },
    annotations: READ_ONLY,
  },
  async ({ venue, history_days, pools }: { venue?: "binance" | "bybit" | "okx" | "gate"; history_days?: number; pools?: boolean }) => {
    try {
      const params = new URLSearchParams();
      if (venue) params.set("venue", venue);
      params.set("days", String(history_days ?? 30));
      if (!pools) params.set("pools", "0");
      const path = `/api/public/insurance-funds?${params.toString()}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_tokenized_stocks",
  {
    title: "Tokenized stocks onchain: supply, premium to the real share, DEX pools and exchange pairs",
    description:
      "Call this when the user asks about tokenized stocks or stock tokens (xStocks, Ondo, Robinhood stock tokens, Coinbase tokenized stocks on Base, Binance bStocks, Backpack, Gate gStocks, Reality, Superstate, Figure, Dinari dShares, Securitize): how much of a stock exists onchain, which issuer or chain holds the most, whether a wrapper trades above or below the real share, which DEX pools or exchanges trade it. Returns the board ByKaranteli refreshes every 10 minutes: per underlying the reference share price and its session, each wrapper (issuer, chain, price, premium_pct against a fresh reference, DEX liquidity and 24h volume from admitted pools, supply in shares and dollars, holders, status), tokenized spot pairs on the exchanges the board lists, the perpetual futures cross, and totals (supply by issuer and chain, DEX volume, median premium). Each wrapper's price_source names the price that valued its supply dollars (reference: the share's reference price; issuer_oracle: the issuer's own price for the token; wrapper: its own pool or exchange price; null: no dollars), and totals.priced_by counts the counted wrappers per level, unpriced included. Wrappers come from issuer sources only, never from a name search.",
    inputSchema: {
      underlying: z.string().regex(/^[A-Za-z0-9.]{1,16}$/).optional().describe("Stock ticker, e.g. TSLA; omit for the whole board."),
      /* Issuer ids mirror TOKENIZED_ISSUER_IDS in web/src/lib/tokenized-equities/meta.ts (the hosted tool reads that list
       directly; the package cannot import the web app, so a new issuer there needs a line here in the next release). */
      issuer: z
        .enum(["xstocks", "robinhood", "coinbase", "bstocks", "ondo", "backpack", "gstocks", "reality", "superstate", "figure", "dinari", "securitize"])
        .optional()
        .describe("One issuer: xstocks, robinhood, coinbase, bstocks, ondo, backpack, gstocks, reality, superstate, figure, dinari or securitize; omit for every issuer."),
      chain: z.string().regex(/^[a-z]{2,12}$/).optional().describe("One chain, e.g. solana, base, bnb, robinhood, ethereum, ton, all (xStocks circulating) or cex (exchange pairs)."),
      top: z.number().int().min(1).max(200).optional().describe("Rows by supply (default 20, max 200)."),
    },
    annotations: READ_ONLY,
  },
  async ({ underlying, issuer, chain, top }: { underlying?: string; issuer?: string; chain?: string; top?: number }) => {
    try {
      const params = new URLSearchParams();
      if (underlying) params.set("underlying", underlying.toUpperCase());
      if (issuer) params.set("issuer", issuer);
      if (chain) params.set("chain", chain);
      params.set("top", String(top ?? 20));
      const path = `/api/public/tokenized-stocks?${params.toString()}`;
      return ok(withProvenance(await fetchJson(path), path));
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
  "get_borrow_rates",
  {
    title: "Margin borrow rates per venue: the cost of leverage, hourly",
    description:
      "Call this when the user asks what it costs to borrow USDT, USDC, BTC, ETH or a major alt on an exchange, which venue has the cheapest borrow, whether stablecoin borrow cost is spiking, or what the carry of a basis trade is on a venue (funding minus borrow). Returns the latest annualised rate per venue and asset, 30 days of hourly series for the stablecoins and majors, and the carry table. Recorded hourly by ByKaranteli (Binance and OKX today).",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try { return ok(withProvenance(await fetchJson("/api/public/borrow-rates"), "/api/public/borrow-rates")); } catch (err) { return fail(err); }
  },
);

server.registerTool(
  "get_fee_table",
  {
    title: "Trading fee schedules per venue, base tier maker and taker",
    description:
      "Call this when the user asks what an exchange charges to trade, how maker and taker fees compare across venues, whether a venue changed its fees, or what a round trip costs on a given notional. Returns base tier maker and taker per venue and market type (median across pairs where the venue prices per pair) and the fee change log, read daily by ByKaranteli from each venue's own fee endpoint.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try { return ok(withProvenance(await fetchJson("/api/public/fees"), "/api/public/fees")); } catch (err) { return fail(err); }
  },
);

server.registerTool(
  "get_settlements",
  {
    title: "Expiry calendar and settlement prices across venues",
    description:
      "Call this when the user asks what futures or options expire soon, when the next quarterly expiry is on an exchange, how many contracts settle this week, or at what price a dated future settled. Returns the next 60 days of dated future and option expiries grouped by date, venue and underlying from 54 venues' market lists, plus the settlement prices recorded as dated futures deliver.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok(withProvenance(await fetchJson("/api/public/settlements"), "/api/public/settlements"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_venue_profile",
  {
    title: "Venue profile: everything ByKaranteli records about one exchange",
    description:
      "Call this when the user asks about a specific exchange (Bybit, OKX, Gate, KuCoin, HTX, Bitget, MEXC, BitMEX, Hyperliquid ...): how many contracts it lists, its perp open interest and average funding, its leverage ladders, deposit and withdrawal networks and how many are paused, its base fee schedule, its status uptime and the recent event log (listings, delistings, leverage cuts, withdrawal pauses, incidents). Without venue returns the list of recorded venues.",
    inputSchema: { venue: z.string().optional().describe("string, optional venue id, e.g. bybit") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      return ok(withProvenance(await fetchJson(args.venue ? `/api/public/venues/profile?venue=${encodeURIComponent(String(args.venue).toLowerCase())}` : "/api/public/venues/profile"), args.venue ? `/api/public/venues/profile?venue=${encodeURIComponent(String(args.venue).toLowerCase())}` : "/api/public/venues/profile"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_withdrawal_status",
  {
    title: "Withdrawal status and network fees: which exchanges paused withdrawals, per asset and network",
    description:
      "Call this when the user asks whether an exchange has paused withdrawals or deposits, which networks are open for an asset, what the withdrawal fee or minimum is on each venue, or which venue is cheapest to withdraw from. Without arguments returns the overview (withdrawals paused right now, ranked, plus recent suspension and resumption events). Pass asset (e.g. USDT) for every venue and network of that asset, and venue (e.g. kucoin) to narrow. Recorded daily by ByKaranteli from 20+ venues' public currency lists.",
    inputSchema: {
      asset: z.string().optional().describe("string, optional asset code, e.g. USDT"),
      venue: z.string().optional().describe("string, optional venue id, e.g. kucoin"),
    },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const qs = new URLSearchParams();
      if (args.asset) qs.set("asset", String(args.asset).toUpperCase());
      if (args.venue) qs.set("venue", String(args.venue).toLowerCase());
      const q = qs.toString();
      return ok(withProvenance(await fetchJson(`/api/public/withdrawals${q ? `?${q}` : ""}`), `/api/public/withdrawals${q ? `?${q}` : ""}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_leverage_tiers",
  {
    title: "Leverage tiers: max leverage and maintenance margin per perpetual on every venue",
    description:
      "Call this when the user asks how much leverage an exchange allows on a coin, what the maintenance margin or risk limit ladder is, which venue offers the highest leverage for a symbol, or whether an exchange recently cut leverage. Returns the current ladder per venue (tier, notional floor and cap, max leverage, maintenance margin rate) recorded daily by ByKaranteli, plus a change log. Pass symbol for one base asset (e.g. SOL) and venue for one exchange (bybit, okx, gate, htx, bitget, mexc).",
    inputSchema: {
      symbol: z.string().optional().describe("string, optional base asset, e.g. BTC"),
      venue: z.string().optional().describe("string, optional venue id, e.g. bybit"),
    },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const qs = new URLSearchParams();
      if (args.symbol) qs.set("symbol", String(args.symbol).toUpperCase());
      if (args.venue) qs.set("venue", String(args.venue).toLowerCase());
      const q = qs.toString();
      return ok(withProvenance(await fetchJson(`/api/public/leverage-tiers${q ? `?${q}` : ""}`), `/api/public/leverage-tiers${q ? `?${q}` : ""}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_venue_markets",
  {
    title: "Exchange coverage: OI, volume, funding and pegs across every exchange we snapshot",
    description:
      "Call this when the user asks about total open interest across exchanges, which venues hold the most OI, DEX versus CEX share, funding dispersion between venues, or stablecoin pegs. Returns the latest 10-minute snapshot aggregates across every perpetual and spot feed we poll (the coverage field lists them); pass symbol for one coin's per-venue rows.",
    inputSchema: {
      symbol: z.string().optional().describe("string, optional base asset, e.g. BTC"),
      history_days: z.number().int().min(1).max(90).optional().describe("Return the hourly multi-venue open interest history (total, DEX share, OI-weighted funding) for this many days instead of the snapshot"),
    },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = args.history_days
        ? `/api/public/venues/oi-history?days=${Math.min(90, Math.floor(args.history_days))}`
        : args.symbol ? `/api/public/venues/markets?symbol=${encodeURIComponent(args.symbol.toUpperCase())}` : "/api/public/venues/markets";
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
    inputSchema: { currency: z.enum(["BTC", "ETH"]).optional().describe("BTC or ETH, default BTC") },
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const path = `/api/public/options/surface?currency=${args.currency ?? "BTC"}`;
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
      "Call this when the user asks what new perpetuals were listed, which exchange listed a coin first, or about delistings. Returns listings and delistings across every exchange the hourly scan covers.",
    inputSchema: { days: z.number().int().min(1).max(30).optional().describe("Window in days, 1-30 (default 30). Longer listing history is the listings dataset at bykaranteli.com/data.") },
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
    inputSchema: { days: z.number().int().min(30).max(4000).optional().describe("Window in days, 30-4000 (default 365); the route clamps to that range.") },
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
      "Call this when the user asks about Bitcoin hashrate, difficulty or block fees (our node runs blocksonly, so there is no mempool series). Returns the recorded daily series and latest values measured on ByKaranteli's own node.",
    inputSchema: { days: z.number().int().min(30).max(4000).optional().describe("Window in days, 30-4000 (default 365); the route clamps to that range.") },
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
      "Call this when the user asks where liquidation clusters or liquidity pools sit for a perpetual, where leveraged longs/shorts would get liquidated, or for a liquidation heatmap reading. Returns the LiqMap snapshot for one symbol: modeled liquidation levels by price, zone aggregates and real liquidation prints from every liquidation venue ByKaranteli counts (listed on bykaranteli.com/coverage). Without an account key (or on the Free plan) the 24h view; with a Builder or higher key (BYKARANTELI_API_KEY) every timeframe from 1h to 30d.",
    inputSchema: {
      symbol: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{2,20}$/)
        .optional()
        .describe("Symbol like BTCUSDT (bare BTC accepted). Default BTCUSDT."),
      timeframe: z
        .enum(["1h", "4h", "12h", "24h", "3d", "1w", "30d"])
        .optional()
        .describe("Model window. Default 24h, the only one served without a Builder or higher key."),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol, timeframe }: { symbol?: string; timeframe?: string }) => {
    try {
      const raw = symbol ?? "BTCUSDT";
      const sym = raw.endsWith("USDT") ? raw : `${raw}USDT`;
      const path = `/api/liqmap/public?symbol=${encodeURIComponent(sym)}&timeframe=${encodeURIComponent(timeframe ?? "24h")}`;
      const data = await fetchJson(path);
      const page = `/liqmap/${sym.replace(/USDT$/, "").toLowerCase()}`;
      return ok({ ...(data as Record<string, unknown>), source: `${PUBLIC_URL}${page}`, provenance: provenanceFor(data, path, page) });
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
    title: "RSI heatmap: Wilder RSI(14) on eight timeframes for the top-400 crypto perps and every TradFi perp",
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
    title: "Positioning: long/short ratios, taker buy/sell and CVD across exchanges",
    description:
      "Call this when the user asks about the long/short ratio, whether retail or top traders are net long or short, the taker buy/sell ratio, or CVD (cumulative volume delta) for a perpetual. Returns exchange-published statistics for the 30 most traded Binance USDT perps on every perpetual venue the positioning board records (Binance global and top-trader ratios, Bybit share long, OKX ratios and taker volume, Gate account and top-trader ratios, HTX elite ratios, Bitget account and position ratios) and CVD series for BTC, ETH and SOL; refreshed every 15 minutes.",
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
  "get_turkey_premium",
  {
    title: "Turkey Premium Index: what lira buyers pay above the world price, with TRY reference prices from Turkish venues",
    description:
      "Call this when the user asks about Bitcoin, Ether or USDT prices in Turkish lira, the Turkey premium, the USDT/TRY rate or dollar premium in Turkey, or which Turkish exchanges (BtcTurk, Bitlo, CoinTR, OKX TR, Binance TR, Bybit TR, Bitexen; KuCoin TR contributes the USDT pairs only) trade above or below the global price. Returns the live board: the Turkey Premium Index (what a lira buyer pays for bitcoin against the global dollar price at the official exchange rate, in bps) with its dollar leg and crypto leg, a 0-100 score (50 = world price) and regime, 24h and 7d averages and the same-sign streak; then five reference prices (median of eligible order books), per-venue book status, spread, depth and each venue's implied premium. Pass pair and history_days for 15-minute history of one pair.",
    inputSchema: {
      pair: z.string().trim().toUpperCase().regex(/^(BTC-TRY|ETH-TRY|USDT-TRY|BTC-USDT|ETH-USDT)$/).optional().describe("Pair: BTC-TRY, ETH-TRY, USDT-TRY, BTC-USDT or ETH-USDT"),
      history_days: z.number().int().min(1).max(30).optional().describe("Include 15-minute index history for the pair, 1..30 days"),
    },
    annotations: READ_ONLY,
  },
  async ({ pair, history_days }: { pair?: string; history_days?: number }) => {
    try {
      const q = new URLSearchParams();
      if (pair) q.set("pair", pair);
      if (history_days) q.set("days", String(history_days));
      const qs = q.toString();
      const path = `/api/public/turkey-premium${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_data_proof",
  {
    title: "BYK Data Layer: on-chain proof that a ByKaranteli number was sealed, signed and anchored on Solana and Base",
    description:
      "Call this when the user asks whether ByKaranteli data can be verified or was changed afterwards, about the BYK Data Layer, on-chain proofs of market data, or wants the proof behind one sealed number. Every 5 minutes a catalog of derived feeds (funding composite, aggregate open interest, liquidations, depth within 2%, pressure scores, Kimchi and Turkey premiums) is sealed into one Merkle root, signed and written to Solana mainnet, and attested on Base once a day. With no arguments returns the stream overview: network, epochs and records sealed, final anchors and the newest epochs with explorer links. Pass feed and asset for one record's proof (value, 104-byte leaf, Merkle path, signed manifest, signature, Solana and Base anchors) at the newest epoch or at sequence; sequence alone for one epoch; catalog for the feed list. result ANCHORED means ByKaranteli signed it and an anchor is final; the protocol verdict is reached from the chains alone at https://bykaranteli.com/proof.",
    inputSchema: {
      feed: z.string().trim().toUpperCase().regex(/^BYK\.[A-Z0-9_.]{3,60}$/).optional().describe("Feed id from the catalog, e.g. BYK.FUNDING.COMPOSITE.B"),
      asset: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/).optional().describe("Asset of the feed: BTC, ETH, SOL, XRP, DOGE, BNB, USDT or ALL"),
      sequence: z.number().int().min(0).optional().describe("Epoch sequence; omit for the newest"),
      catalog: z.boolean().optional().describe("true: list every sealed feed with its unit and methodology"),
    },
    annotations: READ_ONLY,
  },
  async ({ feed, asset, sequence, catalog }: { feed?: string; asset?: string; sequence?: number; catalog?: boolean }) => {
    try {
      const route = ((): string | null => {
    if (catalog) return "/api/v1/proof/catalog";
    if (feed && asset) return `/api/v1/proof/proofs/${sequence ?? "latest"}/${encodeURIComponent(feed)}/${encodeURIComponent(asset)}`;
    if (feed || asset) return null;
    if (sequence !== undefined) return `/api/v1/proof/epochs/${sequence}`;
    return "/api/v1/proof";
      })();
      if (!route) throw new InputError("pass feed and asset together (for example feed BYK.FUNDING.COMPOSITE.B and asset BTC), or neither.");
      return ok(withProvenance(await fetchJson(route), route));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_jupiter_perps",
  {
    title: "Jupiter Perps (Solana): exact long/short OI, utilization, borrow rates, weekly top traders",
    description:
      "Call this when the user asks about Jupiter perpetuals on Solana: long versus short open interest per market (SOL, ETH, BTC) read from the on-chain custody state, pool utilization and hourly borrow rates, JLP pool AUM and APR, 24h volume, or the week's top traders by realized PnL. Pass base and history_days for the hourly OI history.",
    inputSchema: {
      base: z.string().trim().toUpperCase().regex(/^(SOL|ETH|BTC)$/).optional().describe("Market base: SOL, ETH or BTC"),
      history_days: z.number().int().min(1).max(30).optional().describe("Include hourly OI history for the base, 1..30 days"),
    },
    annotations: READ_ONLY,
  },
  async ({ base, history_days }: { base?: string; history_days?: number }) => {
    try {
      const q = new URLSearchParams();
      if (base) q.set("base", base);
      if (history_days) q.set("days", String(history_days));
      const qs = q.toString();
      const path = `/api/public/jupiter${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_market_profile",
  {
    title: "Market Profile: daily TPO profile of a perpetual, point of control, value area, initial balance, naked POCs",
    description:
      "Call this when the user asks about a perpetual's Market Profile, TPO profile, point of control (POC), value area (VAH, VAL), initial balance or naked (untested) points of control. Returns one row per closed UTC day from ByKaranteli's own one-minute bars of the Binance USDT-M perpetual (30-minute TPO periods, buckets of 0.05% of the day's open, 70% value area, first-hour initial balance, volume point of control), the naked points of control of the last 60 recorded days and the latest day's profile per price bucket. Symbols without recorded minute bars return no_profile.",
    inputSchema: {
      symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,20}$/).optional().describe("Ticker such as BTC or BTCUSDT (default BTC)"),
      days: z.number().int().min(1).max(30).optional().describe("Closed UTC days, newest first, 1..30 (default 7)"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol, days }: { symbol?: string; days?: number }) => {
    try {
      const q = new URLSearchParams();
      q.set("symbol", symbol ?? "BTC");
      if (days) q.set("days", String(days));
      const path = `/api/public/market-profile?${q.toString()}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_options_chain",
  {
    title: "Options chain hour by hour: open interest and IV per expiry and strike, the change over 1h and 24h, the ATM IV path",
    description:
      "Call this when the user asks how the BTC or ETH option chain moved today or over the last day: open interest and mark IV per expiry and strike from ByKaranteli's own hourly capture of every listed venue, the change over the last hour and the last 24 hours, and the front expiry's ATM IV hour by hour. Anonymous depth lists the largest strikes; a key with member depth lists every strike. Recorded from 2026-09-30, so the first days carry a short history.",
    inputSchema: {
      currency: z.enum(["BTC", "ETH"]).optional().describe("BTC or ETH (default BTC)"),
      venue: z.enum(["all", "deribit", "bybit", "binance", "okx", "delta"]).optional().describe("One venue or all (default all)"),
      expiry: z.string().trim().toUpperCase().regex(/^\d{1,2}[A-Z]{3}\d{2}$/).optional().describe("Expiry as DDMONYY, e.g. 31OCT26 (default: every expiry)"),
      strikes: z.enum(["top", "all"]).optional().describe("top (largest strikes) or all (member depth)"),
    },
    annotations: READ_ONLY,
  },
  async ({ currency, venue, expiry, strikes }: { currency?: string, venue?: string, expiry?: string, strikes?: string }) => {
    try {
      const q = new URLSearchParams();
      if (currency !== undefined) q.set("currency", String(currency));
      if (venue !== undefined) q.set("venue", String(venue));
      if (expiry !== undefined) q.set("expiry", String(expiry));
      if (strikes !== undefined) q.set("strikes", String(strikes));
      const qs = q.toString();
      const path = `/api/public/options/chain${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_hl_positions",
  {
    title: "Hyperliquid tracked positions: the liquidation price map of the largest accounts per coin, against the LiqMap model",
    description:
      "Call this when the user asks where Hyperliquid whales would be liquidated, how much tracked notional sits at each price, how the largest accounts lean on a coin, or how their liquidation prices compare with the LiqMap model. The universe is the largest accounts by equity on Hyperliquid's public leaderboard, scanned every five minutes; the levels are their own liquidation prices bucketed around the mark. hours returns the hourly archive of level totals.",
    inputSchema: {
      coin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,24}$/).optional().describe("Coin as Hyperliquid names it, e.g. BTC, ETH, SOL (default BTC)"),
      hours: z.number().int().min(1).max(720).optional().describe("Hours of archive to return, 1..720 (default 24)"),
    },
    annotations: READ_ONLY,
  },
  async ({ coin, hours }: { coin?: string, hours?: number }) => {
    try {
      const q = new URLSearchParams();
      if (coin !== undefined) q.set("coin", String(coin));
      if (hours !== undefined) q.set("hours", String(hours));
      const qs = q.toString();
      const path = `/api/public/hyperliquid-positions${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_venue_share",
  {
    title: "Venue share: each counted exchange's share of the recorded liquidations and of perpetual open interest",
    description:
      "Call this when the user asks which exchange sees the most liquidations, how that share moved this week or this month, or how perpetual open interest splits between venues. Shares over one, seven or thirty days from ByKaranteli's own hourly liquidation record (counted venues only, each with the day its record started) and the hourly open interest record.",
    inputSchema: {
      days: z.number().int().optional().describe("Window in days: 1, 7 or 30 (default 7)"),
    },
    annotations: READ_ONLY,
  },
  async ({ days }: { days?: number }) => {
    try {
      const q = new URLSearchParams();
      if (days !== undefined) q.set("days", String(days));
      const qs = q.toString();
      const path = `/api/public/venue-share${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_tradfi_gaps",
  {
    title: "Weekend and overnight gaps: stock, index and commodity perpetuals against the cash close, checkpoint by checkpoint",
    description:
      "Call this when the user asks what a stock, index or commodity perpetual did over the weekend or overnight while the cash market was closed, how far it sat from the last cash close at each checkpoint, how the venues disagreed, and what gap the next open then realised. From ByKaranteli's own ten-minute venue record; window weekend or night; one symbol or the whole board.",
    inputSchema: {
      window: z.enum(["weekend", "night"]).optional().describe("weekend (Friday close to Monday open) or night (cash close to next open); default weekend"),
      symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9.]{1,24}$/).optional().describe("One underlying, e.g. TSLA or XAU (default: the whole board)"),
    },
    annotations: READ_ONLY,
  },
  async ({ window, symbol }: { window?: string, symbol?: string }) => {
    try {
      const q = new URLSearchParams();
      if (window !== undefined) q.set("window", String(window));
      if (symbol !== undefined) q.set("symbol", String(symbol));
      const qs = q.toString();
      const path = `/api/public/tradfi-gaps${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_solana_perps",
  {
    title: "Solana Perps board: open interest, 24h volume and hourly rates across six Solana perpetual venues (Jupiter, Pacifica, Phoenix, GM Trade, Velocity, Bullet)",
    description:
      "Call this when the user asks about perpetuals on Solana as a whole, which Solana perp DEX has the most open interest or volume, a market on Pacifica, Phoenix, GM Trade (GMX on Solana), Velocity (the Drift relaunch) or Bullet (funding, open interest, 24h volume, mark), or how Jupiter compares with the order-book venues. Returns the board read every 10 minutes: per-venue totals (one-sided open interest, both sides on pool venues, 24h volume, market count, median hourly rate, as_of), every market of every venue largest first with instrument type (perpetual, equity, index, commodity, fx), and optional hourly history of one market on any venue but Jupiter (7 days free, 30 with member depth; Jupiter history is get_jupiter_perps).",
    inputSchema: {
      venue: z.string().trim().toLowerCase().regex(/^(jupiter|pacifica|phoenix|gmtrade|velocity|bullet)$/).optional().describe("Venue filter: jupiter, pacifica, phoenix, gmtrade, velocity or bullet"),
      /* Passed as typed: Pacifica and Phoenix list mixed-case markets (kBONK, kPEPE, kSHIB) and the route matches the
       symbol case-insensitively, so upper-casing here would only change what the caller sees echoed back. */
      symbol: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,24}$/).optional().describe("Market symbol on the chosen venue (Pacifica when venue is not given) for hourly history, as the board lists it, e.g. SOL, SOL-PERP, SOL-USD, kBONK"),
      history_days: z.number().int().min(1).max(30).optional().describe("Hourly history for the symbol, 1..30 days"),
    },
    annotations: READ_ONLY,
  },
  async ({ venue, symbol, history_days }: { venue?: string; symbol?: string; history_days?: number }) => {
    try {
      const q = new URLSearchParams();
      if (venue) q.set("venue", venue);
      if (symbol) q.set("symbol", symbol);
      if (history_days) q.set("days", String(history_days));
      const qs = q.toString();
      const path = `/api/public/solana-perps${qs ? `?${qs}` : ""}`;
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
      "Call this when the user asks which exchanges sit behind a ByKaranteli number, whether a feed is complete or sampled, since when a venue is collected, or how fresh the data is. Returns the live coverage registry: liquidation feeds per venue with kind and last record, snapshot feeds per venue and market, funding arbitrage legs, positioning sources, whale tape, spot minutes and the Hyperliquid whale scan with freshness. snapshots[].country is the jurisdiction only when the venue states one; it is null for most venues, so do not read null as unknown risk.",
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

server.registerTool(
  "get_orderbook_depth",
  {
    title: "Spot order book depth: walls and 2% depth from every spot venue on the coverage page",
    description:
      "Call this when the user asks where the bid or ask walls are, how deep the spot order book is, whether buyers or sellers have more resting orders near price, or for an order book heatmap. Returns the books of every spot venue with a public book that the coverage page lists, binned into 0.1% buckets within 20% of mid (USD notional), the largest walls with venue split, 2% depth and book reach per venue, and optionally the summed 5-minute history; coins: BTC, ETH, SOL, XRP, DOGE, ADA, LINK, AVAX, LTC, BNB. Books whose size is not corroborated are recorded and returned per venue with in_aggregate false (listed in held_out) but not summed into the walls, 2% depth or history.",
    inputSchema: {
      symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/).optional().describe("One coin, e.g. BTC (default BTC)"),
      hours: z.number().int().min(1).max(24).optional().describe("Include the summed 5-minute history for this many hours"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbol, hours }: { symbol?: string; hours?: number }) => {
    try {
      const params = new URLSearchParams();
      if (symbol) params.set("symbol", symbol);
      if (hours) params.set("hours", String(hours));
      const qs = params.toString();
      const path = `/api/public/orderbook${qs ? `?${qs}` : ""}`;
      return ok(withProvenance(await fetchJson(path), path));
    } catch (err) {
      return fail(err);
    }
  },
);

/* API contract values the account and series tools use (0.31.0). They mirror the web registries (series metrics,
 * recipe fields, operators, channels and limits); the web test mcp-extra-tools.test.ts fails when they drift, and
 * GET /api/series/metrics lists the metrics with their units and floors at runtime. */
const SERIES_METRIC_KEYS = ["price", "volume", "cvd_perp", "cvd_spot", "oi", "funding", "funding_agg", "liquidations", "long_short", "top_traders", "rsi", "premium", "etf_flow", "borrow", "whale_net"];
const SERIES_METRICS: Record<string, true> = Object.fromEntries(SERIES_METRIC_KEYS.map((k) => [k, true]));
const SERIES_PERIODS = ["1m", "3m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;
type SeriesPeriod = (typeof SERIES_PERIODS)[number];
const PERIOD_MS: Record<SeriesPeriod, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "10m": 600_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000 };
const SERIES_MEMBER_BAR_LIMIT = 5000;
const RECIPE_FIELD_KEYS = ["mark_price", "pressure_score", "funding_rate_pct", "oi24h_pct", "basis_pct", "price_change_24h_pct", "liq_cluster_distance_pct", "usdt_peg_min_usd", "usdc_peg_min_usd", "liq_1h_usd", "rsi_4h", "ls_ratio_global", "book_imbalance_2pct_pct", "withdrawal_paused_venues", "max_leverage_min", "borrow_apr_pct", "hl_whale_long_share_pct"] as const;
const RECIPE_OPS: string[] = [">=", ">", "<=", "<", "=="];
const RECIPE_CHANNELS = ["telegram", "email", "push", "webhook"] as const;
const RECIPE_LIMITS = { MAX_CONDITIONS: 6, MAX_SYMBOLS: 20, NAME_MAX: 64 } as const;
const ALERT_TEXT_MAX_CHARS = 500;

/* GET a market route with provenance, and extra fields the tool adds (get_series' requested window). */
async function tool(path: string, extra?: Record<string, unknown>): Promise<ToolResult> {
  try {
    const data = withProvenance(await fetchJson(path), path);
    return ok(extra && data && typeof data === "object" && !Array.isArray(data) ? { ...(data as Record<string, unknown>), ...extra } : data);
  } catch (err) {
    return fail(err);
  }
}

/* Account tools (0.31.0): they read and change the caller's own alert recipes and watchlists through the member
 * routes, which take the account key (the key's refusals, the plan's rate and monthly quota, a per-key write cap and
 * an audit row per write are enforced there). Annotations tell the client which tools change something; the market
 * data tools stay read-only and open-world. The hosted endpoint carries the same tools in
 * web/src/lib/mcp-extra-tools.ts until it installs this version; the web test mcp-extra-tools.test.ts compares the
 * two definitions (names, titles, descriptions, input schemas, annotations). */
type Annotations = { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
const ACCOUNT_READ: Annotations = { readOnlyHint: true, openWorldHint: false };
const ACCOUNT_WRITE: Annotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const ACCOUNT_WRITE_IDEMPOTENT: Annotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const ACCOUNT_DELETE: Annotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true };

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const okResult = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const KEY_NEEDED = "This tool reads or changes your own account, so it needs your account key (x-api-key: bk_... or Authorization: Bearer bk_...). Free key: https://bykaranteli.com/dashboard/api";

/* One call to a member route with the caller's key. The route's own error (limit reached, unknown id, rate) is passed
 * through as the tool error so the model can say what happened. */
async function account(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; result: ToolResult }> {
  const authorization = authorizationFor();
  if (!authorization) return { ok: false, result: errorResult(KEY_NEEDED) };
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      // non-JSON body: the status line below still says what happened
    }
    if (!res.ok) {
      const reason = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : text.replace(/\s+/g, " ").slice(0, 300);
      return { ok: false, result: errorResult(`${method} ${path.split("?")[0]} returned HTTP ${res.status}: ${reason}`) };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, result: errorResult(`Failed: ${err instanceof Error ? err.message : String(err)}`) };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function seriesSymbol(raw: unknown): string | null {
  const s = (typeof raw === "string" && raw.trim() ? raw : "BTCUSDT").trim().toUpperCase().replace(/[\s/_-]+/g, "");
  const expanded = s.endsWith("USDT") ? s : `${s}USDT`;
  return /^[A-Z0-9]{5,20}$/.test(expanded) ? expanded : null;
}

type WatchlistRow = { id: string; name: string; itemCount?: number };
/* The list a symbol goes to: the one named, else "default", else the only list the account has. */
async function resolveWatchlist(watchlistId: unknown): Promise<{ ok: true; list: WatchlistRow } | { ok: false; result: ToolResult }> {
  const lists = await account("GET", "/api/member/watchlists");
  if (!lists.ok) return lists;
  const rows = (Array.isArray(lists.data.watchlists) ? lists.data.watchlists : []) as WatchlistRow[];
  if (typeof watchlistId === "string" && watchlistId.trim()) {
    const hit = rows.find((w) => w.id === watchlistId.trim());
    return hit ? { ok: true, list: hit } : { ok: false, result: errorResult(`No watchlist with id ${watchlistId.trim()} on this account. Lists: ${rows.map((w) => `${w.name} (${w.id})`).join(", ") || "none"}.`) };
  }
  const pick = rows.find((w) => w.name === "default") ?? (rows.length === 1 ? rows[0] : undefined);
  if (pick) return { ok: true, list: pick };
  return {
    ok: false,
    result: errorResult(rows.length === 0
      ? "This account has no watchlist yet. Open https://bykaranteli.com/dashboard/watchlist once to create the default list, then call again."
      : `Pass watchlist_id: this account has ${rows.length} lists: ${rows.map((w) => `${w.name} (${w.id})`).join(", ")}.`),
  };
}

/* ---- 0.31.0: recorded series, alert text, alert recipes, watchlists ---- */

server.registerTool("get_series", {
  title: "Recorded series: bars or points of one metric for one perpetual (price, OI, funding, CVD, liquidations, long/short, RSI and more)",
  description: `Call this when the user wants the history of one recorded metric for one perpetual as a time series: price candles, volume, perp or spot CVD, open interest, funding (one venue, or OI-weighted across every venue as funding_agg), liquidations, long/short ratios, RSI, the Coinbase premium, US spot ETF flows, borrow rates or Hyperliquid whale net flow, for charting, backtesting or "what did X do over the last N days". Returns the /api/series answer (points as [t, v], or [t, o, h, l, c, v] for price, with unit, kind, source and source_kind, the bars served and whether member depth applied) plus provenance. metric is one of: ${SERIES_METRIC_KEYS.join(", ")} (unit, finest period and venue support of each: https://bykaranteli.com/api/series/metrics). Public depth serves fewer bars and no 5m bars; a Builder key and above get member depth; the bar limits are in the same list. Pass from and to (ISO) for a window, or limit for the newest bars.`,
  inputSchema: {
    metric: z.string().describe("string, metric key, e.g. price, oi, funding, liquidations (list: /api/series/metrics)"),
    symbol: z.string().optional().describe("string, optional Binance USDT-M perp or coin, e.g. BTCUSDT or BTC (default BTCUSDT)"),
    period: z.enum(SERIES_PERIODS).optional().describe(`string, optional bar period: ${SERIES_PERIODS.join(" | ")} (default 1h; each metric has a finest period)`),
    venue: z.string().optional().describe("string, optional venue id for price, oi, funding or borrow, e.g. okx (default binance)"),
    from: z.string().optional().describe("string, optional ISO start, e.g. 2026-09-01T00:00:00Z"),
    to: z.string().optional().describe("string, optional ISO end (default now)"),
    limit: z.number().optional().describe(`number, optional newest bars, 10..${SERIES_MEMBER_BAR_LIMIT}; the key's depth caps it`),
  },
  annotations: READ_ONLY,
}, async (args: Record<string, unknown> = {}) => {
  const metric = typeof args.metric === "string" ? args.metric.trim().toLowerCase() : "";
  if (!Object.hasOwn(SERIES_METRICS, metric)) return errorResult(`Invalid input: metric must be one of ${SERIES_METRIC_KEYS.join(", ")}.`);
  const symbol = seriesSymbol(args.symbol);
  if (!symbol) return errorResult("Invalid input: symbol looks like BTCUSDT or BTC.");
  const period = (typeof args.period === "string" && (SERIES_PERIODS as readonly string[]).includes(args.period) ? args.period : "1h") as SeriesPeriod;
  const to = typeof args.to === "string" && args.to.trim() ? new Date(args.to) : null;
  const from = typeof args.from === "string" && args.from.trim() ? new Date(args.from) : null;
  if ((to && Number.isNaN(to.getTime())) || (from && Number.isNaN(from.getTime()))) return errorResult("Invalid input: from and to are ISO dates, e.g. 2026-09-01T00:00:00Z.");
  const end = to ?? new Date();
  if (from && from.getTime() >= end.getTime()) return errorResult("Invalid input: from must be before to.");
  let limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : undefined;
  const bars = from ? Math.ceil((end.getTime() - from.getTime()) / PERIOD_MS[period]) : undefined;
  if (bars !== undefined) limit = Math.min(limit ?? bars, bars);
  if (limit !== undefined) limit = Math.max(10, Math.min(SERIES_MEMBER_BAR_LIMIT, limit));
  const q = new URLSearchParams({ metric, symbol, period });
  if (limit !== undefined) q.set("limit", String(limit));
  if (to) q.set("to", to.toISOString());
  if (typeof args.venue === "string" && /^[a-z0-9]{2,20}$/i.test(args.venue.trim())) q.set("venue", args.venue.trim().toLowerCase());
  /* The route answers the newest `limit` bars up to `to`; `requested` lets the caller compare with the bars served. */
  return tool(`/api/series?${q.toString()}`, from ? { requested: { from: from.toISOString(), to: end.toISOString(), bars } } : undefined);
});

server.registerTool("parse_alert_text", {
  title: "Alert text to an alert recipe: turn a sentence like \"BTC funding above 0.05%\" into the recipe it describes",
  description: `Call this when the user describes an alert in words ("tell me when ETH drops 5% in a day", "BTC funding above 5 bps", "liquidations over $20M in an hour") and you want the exact recipe before creating it. Rule based, nothing is saved: returns recipe (name, scope, symbols, conditions of field, op, value, cooldownHours, channels) or null, confidence 0..1, a one-line summary to confirm with the user, and unresolved (what the text left open or what was assumed; timing words are not part of a recipe). A threshold the text does not state is never invented. English and tickers; at most ${ALERT_TEXT_MAX_CHARS} characters. Pass the returned conditions, scope, symbols and channels to create_alert_recipe once the user agrees.`,
  inputSchema: {
    text: z.string().describe("string, the alert in plain English, e.g. \"SOL funding below -0.01% or OI up 10%\""),
  },
  annotations: ACCOUNT_READ,
}, async (args: Record<string, unknown> = {}) => {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return errorResult("Invalid input: text is required, e.g. \"BTC funding above 0.05%\".");
  if (text.length > ALERT_TEXT_MAX_CHARS) return errorResult(`Invalid input: at most ${ALERT_TEXT_MAX_CHARS} characters.`);
  const r = await account("POST", "/api/member/alert-recipes/parse", { text });
  return r.ok ? okResult(r.data) : r.result;
});

server.registerTool("list_alert_recipes", {
  title: "Your alert recipes: every alert on your account with its conditions, scope, channels and when it last fired",
  description: "Call this when the user asks which alerts they have, whether an alert fired, or before deleting or changing one. Returns the account's alert recipes (id, name, scope, symbols, conditions, cooldown in hours, enabled, last fired, fire count, channels). Needs the account key; reads nothing but this account.",
  inputSchema: {},
  annotations: ACCOUNT_READ,
}, async () => {
  const r = await account("GET", "/api/member/alert-recipes");
  return r.ok ? okResult({ ...r.data, page: "https://bykaranteli.com/dashboard/alerts" }) : r.result;
});

server.registerTool("create_alert_recipe", {
  title: "Create an alert recipe (writes to your account)",
  description: `Call this when the user asks to be alerted when a metric crosses a threshold and has agreed to the exact condition (parse_alert_text turns their words into one). Saves an alert recipe on the account: it fires when every condition holds, delivers by Telegram first with email as fallback unless channels says otherwise, and waits cooldown_hours before it fires again for the same symbol. field is one of: ${RECIPE_FIELD_KEYS.join(", ")}; op is one of ${RECIPE_OPS.join(" ")}; percent fields take percent values (0.05 means 0.05%). Pass field, op and threshold for one condition, or conditions for up to ${RECIPE_LIMITS.MAX_CONDITIONS}. scope: watchlist (default), any, or symbols with symbols. The plan sets how many recipes an account keeps; past it the tool answers with the limit. Writes are rate limited per key and each one is recorded on the account.`,
  inputSchema: {
    field: z.string().optional().describe("string, one condition's metric, e.g. funding_rate_pct"),
    op: z.enum(RECIPE_OPS as [string, ...string[]]).optional().describe(`string, one condition's comparison: ${RECIPE_OPS.join(" | ")}`),
    threshold: z.number().optional().describe("number, one condition's threshold, e.g. 0.05"),
    conditions: z.array(z.object({ field: z.string(), op: z.enum(RECIPE_OPS as [string, ...string[]]), value: z.number() })).optional().describe(`array, optional up to ${RECIPE_LIMITS.MAX_CONDITIONS} conditions {field, op, value}, all must hold (instead of field, op, threshold)`),
    scope: z.enum(["watchlist", "any", "symbols"]).optional().describe("string, optional: watchlist (default), any, symbols"),
    symbols: z.array(z.string()).optional().describe(`array, optional up to ${RECIPE_LIMITS.MAX_SYMBOLS} symbols, e.g. [\"BTCUSDT\", \"ETH\"]; implies scope symbols`),
    channels: z.array(z.enum(RECIPE_CHANNELS)).optional().describe(`array, optional delivery channels: ${RECIPE_CHANNELS.join(" | ")}; empty means Telegram first, email as fallback`),
    cooldown_hours: z.number().optional().describe("number, optional 1..168 hours before it fires again (default 24)"),
    name: z.string().optional().describe("string, optional name; default describes the condition"),
  },
  annotations: ACCOUNT_WRITE,
}, async (args: Record<string, unknown> = {}) => {
  const rawConds = Array.isArray(args.conditions) && args.conditions.length > 0
    ? args.conditions
    : args.field !== undefined || args.threshold !== undefined
      ? [{ field: args.field, op: args.op, value: args.threshold }]
      : [];
  if (rawConds.length === 0) return errorResult("Invalid input: pass field, op and threshold, or conditions.");
  if (rawConds.length > RECIPE_LIMITS.MAX_CONDITIONS) return errorResult(`Invalid input: at most ${RECIPE_LIMITS.MAX_CONDITIONS} conditions.`);
  const conditions: Array<{ field: string; op: string; value: number }> = [];
  for (const c of rawConds as Array<Record<string, unknown>>) {
    const field = typeof c?.field === "string" ? c.field.trim() : "";
    const op = typeof c?.op === "string" ? c.op.trim() : "";
    const value = typeof c?.value === "number" ? c.value : Number.NaN;
    if (!RECIPE_FIELD_KEYS.includes(field as (typeof RECIPE_FIELD_KEYS)[number])) return errorResult(`Invalid input: field "${field}" is not one of ${RECIPE_FIELD_KEYS.join(", ")}.`);
    if (!(RECIPE_OPS as readonly string[]).includes(op)) return errorResult(`Invalid input: op must be one of ${RECIPE_OPS.join(" ")}.`);
    if (!Number.isFinite(value)) return errorResult(`Invalid input: the threshold of ${field} must be a number.`);
    conditions.push({ field, op, value });
  }
  const symbolsIn = Array.isArray(args.symbols) ? args.symbols : [];
  if (symbolsIn.length > RECIPE_LIMITS.MAX_SYMBOLS) return errorResult(`Invalid input: at most ${RECIPE_LIMITS.MAX_SYMBOLS} symbols.`);
  const symbols: string[] = [];
  for (const raw of symbolsIn) {
    const sym = seriesSymbol(raw);
    if (!sym || typeof raw !== "string") return errorResult(`Invalid input: "${String(raw)}" is not a symbol like BTCUSDT or BTC.`);
    if (!symbols.includes(sym)) symbols.push(sym);
  }
  const scope = args.scope === "any" || args.scope === "watchlist" || args.scope === "symbols" ? args.scope : symbols.length > 0 ? "symbols" : "watchlist";
  if (scope === "symbols" && symbols.length === 0) return errorResult("Invalid input: scope symbols needs symbols.");
  const channels = Array.isArray(args.channels) ? args.channels.filter((c): c is string => typeof c === "string") : [];
  if (channels.some((c) => !(RECIPE_CHANNELS as readonly string[]).includes(c))) return errorResult(`Invalid input: channels are ${RECIPE_CHANNELS.join(", ")}.`);
  const cooldownHours = typeof args.cooldown_hours === "number" && Number.isFinite(args.cooldown_hours) ? Math.max(1, Math.min(168, Math.round(args.cooldown_hours))) : 24;
  const fallbackName = `${scope === "symbols" ? `${symbols.slice(0, 3).map((x) => x.replace(/USDT$/, "")).join(", ")} · ` : ""}${conditions.map((c) => `${c.field} ${c.op} ${c.value}`).join(" and ")}`;
  const name = (typeof args.name === "string" && args.name.trim() ? args.name.trim() : fallbackName).slice(0, RECIPE_LIMITS.NAME_MAX);
  const body = { name, scope, symbols: scope === "symbols" ? symbols : [], conditions, cooldownHours, channels: [...new Set(channels)], enabled: true };
  const r = await account("POST", "/api/member/alert-recipes", body);
  return r.ok ? okResult({ ok: true, id: r.data.id, recipe: body, page: "https://bykaranteli.com/dashboard/alerts" }) : r.result;
});

server.registerTool("delete_alert_recipe", {
  title: "Delete one of your alert recipes (writes to your account)",
  description: "Call this when the user asks to remove an alert. Deletes the alert recipe with this id from the account (list_alert_recipes shows the ids); an id that is not one of the account's recipes changes nothing and says so. Writes are rate limited per key and each one is recorded on the account.",
  inputSchema: {
    id: z.string().describe("string, the recipe id from list_alert_recipes"),
  },
  annotations: ACCOUNT_DELETE,
}, async (args: Record<string, unknown> = {}) => {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!UUID_RE.test(id)) return errorResult("Invalid input: id is a recipe id from list_alert_recipes.");
  const r = await account("DELETE", `/api/member/alert-recipes/${id}`);
  if (!r.ok) return r.result;
  if (r.data.deleted === 0) return errorResult(`No alert recipe with id ${id} on this account; list_alert_recipes shows the ids.`);
  return okResult({ ok: true, id, deleted: true });
});

server.registerTool("list_watchlists", {
  title: "Your watchlists and the symbols on each",
  description: "Call this when the user asks what is on their watchlist, which lists they have, or before adding or removing a symbol. Returns the account's watchlists (id, name, symbol count) and, unless include_symbols is false, the symbols on each list in order. Needs the account key; reads nothing but this account.",
  inputSchema: {
    include_symbols: z.boolean().optional().describe("boolean, optional: include each list's symbols (default true)"),
  },
  annotations: ACCOUNT_READ,
}, async (args: Record<string, unknown> = {}) => {
  const lists = await account("GET", "/api/member/watchlists");
  if (!lists.ok) return lists.result;
  const rows = (Array.isArray(lists.data.watchlists) ? lists.data.watchlists : []) as WatchlistRow[];
  if (args.include_symbols === false) return okResult({ watchlists: rows, page: "https://bykaranteli.com/dashboard/watchlist" });
  const out: Array<WatchlistRow & { symbols?: string[] }> = [];
  for (const w of rows.slice(0, 20)) {
    const items = await account("GET", `/api/member/watchlists/${encodeURIComponent(w.id)}/items`);
    if (!items.ok) return items.result;
    out.push({ ...w, symbols: Array.isArray(items.data.symbols) ? (items.data.symbols as string[]) : [] });
  }
  return okResult({ watchlists: out, page: "https://bykaranteli.com/dashboard/watchlist" });
});

server.registerTool("add_watchlist_symbol", {
  title: "Add a symbol to your watchlist (writes to your account)",
  description: "Call this when the user asks to watch, follow or add a coin to their watchlist. Adds the symbol to the list named by watchlist_id, else to the default list (or the only list the account has); a symbol already on the list stays once. Returns the list's symbols after the change. Writes are rate limited per key and each one is recorded on the account.",
  inputSchema: {
    symbol: z.string().describe("string, a Binance USDT-M perp or coin, e.g. SOLUSDT or SOL"),
    watchlist_id: z.string().optional().describe("string, optional list id from list_watchlists (default: the default list)"),
  },
  annotations: ACCOUNT_WRITE_IDEMPOTENT,
}, async (args: Record<string, unknown> = {}) => {
  const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
  if (!symbol || symbol.length > 30) return errorResult("Invalid input: symbol looks like SOLUSDT or SOL.");
  const list = await resolveWatchlist(args.watchlist_id);
  if (!list.ok) return list.result;
  const r = await account("POST", `/api/member/watchlists/${encodeURIComponent(list.list.id)}/items`, { symbol });
  if (!r.ok) return r.result;
  return okResult({ ...r.data, watchlist: { id: list.list.id, name: list.list.name }, note: r.data.created === false ? "Already on this list." : undefined });
});

server.registerTool("remove_watchlist_symbol", {
  title: "Remove a symbol from your watchlist (writes to your account)",
  description: "Call this when the user asks to stop watching a coin or remove it from their watchlist. Removes the symbol from the list named by watchlist_id, else from the default list (or the only list the account has); a symbol that is not on the list changes nothing. Returns the list's symbols after the change. Writes are rate limited per key and each one is recorded on the account.",
  inputSchema: {
    symbol: z.string().describe("string, the symbol to remove, e.g. SOLUSDT or SOL"),
    watchlist_id: z.string().optional().describe("string, optional list id from list_watchlists (default: the default list)"),
  },
  annotations: ACCOUNT_DELETE,
}, async (args: Record<string, unknown> = {}) => {
  const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
  if (!symbol || symbol.length > 30) return errorResult("Invalid input: symbol looks like SOLUSDT or SOL.");
  const list = await resolveWatchlist(args.watchlist_id);
  if (!list.ok) return list.result;
  const r = await account("DELETE", `/api/member/watchlists/${encodeURIComponent(list.list.id)}/items?symbol=${encodeURIComponent(symbol)}`);
  if (!r.ok) return r.result;
  return okResult({ ...r.data, watchlist: { id: list.list.id, name: list.list.name }, note: r.data.deleted === false ? "Was not on this list." : undefined });
});

/* Hyperliquid address tracking (Terminal feature, 2026-09-30): the member routes /api/member/hl-addresses take the
 * account key like the alert and watchlist routes. */
const HL_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TRACKED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

server.registerTool("list_tracked_addresses", {
  title: "List the Hyperliquid addresses you follow (reads your account)",
  description: "Call this when the user asks which Hyperliquid addresses they follow, or what those addresses hold right now. Returns every followed address with its label, the positions last seen on it and the plan's address limit; following addresses is part of Terminal and the plans above it.",
  inputSchema: {},
  annotations: ACCOUNT_READ,
}, async () => {
  const r = await account("GET", "/api/member/hl-addresses");
  if (!r.ok) return r.result;
  return okResult(r.data);
});

server.registerTool("add_tracked_address", {
  title: "Follow a Hyperliquid address for position alerts (writes to your account)",
  description: "Call this when the user asks to follow, track or get alerts for a Hyperliquid address (0x followed by 40 hex characters). Every later position change of the address (opened, closed, increased, reduced, flipped) reaches the user's alert channels; the first sight is the baseline and sends nothing. Counted against the plan's address limit; the route answers terminal_required or limit_reached when it cannot add.",
  inputSchema: {
    address: z.string().describe("string, 0x followed by 40 hex characters"),
    label: z.string().optional().describe("string, optional name for the address, up to 40 characters"),
  },
  annotations: ACCOUNT_WRITE_IDEMPOTENT,
}, async (args: Record<string, unknown> = {}) => {
  const address = typeof args.address === "string" ? args.address.trim().toLowerCase() : "";
  if (!HL_ADDRESS_RE.test(address)) return errorResult("Invalid input: address is 0x followed by 40 hex characters.");
  const label = typeof args.label === "string" ? args.label.trim().slice(0, 40) : undefined;
  const r = await account("POST", "/api/member/hl-addresses", { address, ...(label ? { label } : {}) });
  if (!r.ok) return r.result;
  return okResult(r.data);
});

server.registerTool("remove_tracked_address", {
  title: "Stop following a Hyperliquid address (writes to your account)",
  description: "Call this when the user asks to stop following or tracking a Hyperliquid address. Takes the id from list_tracked_addresses; the address's alerts stop, its recorded events stay.",
  inputSchema: {
    id: z.string().describe("string, the id from list_tracked_addresses"),
  },
  annotations: ACCOUNT_DELETE,
}, async (args: Record<string, unknown> = {}) => {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!TRACKED_ID_RE.test(id)) return errorResult("Invalid input: id is the value list_tracked_addresses returns.");
  const r = await account("DELETE", `/api/member/hl-addresses/${encodeURIComponent(id)}`);
  if (!r.ok) return r.result;
  return okResult(r.data);
});

}
