/* Provenance of one tool answer (0.31.0): where it came from, when, from which venues, whether the record behind it
 * is complete or sampled, and where the proof lives. Read only from fields the API answer already carries
 * (generatedAt or as_of, venues, sources, coverage kinds, stale feeds, recorded_since or history_since); a field the
 * answer does not carry is left out, never filled in.
 *
 * The same code runs in the hosted bridge as web/src/lib/mcp-provenance.ts; the web test mcp-provenance.test.ts runs
 * both copies on the same answers and fails when they drift. No imports, so both sides can load it as is. */

export const PROOF_URL = "https://bykaranteli.com/proof";

export type ProvenanceCoverage = "full" | "sampled" | "mixed";

export type Provenance = {
  source_page: string;
  /** The SuperChart address that opens on what this answer holds, when the route has a chart twin (2026-10-07). */
  chart_url?: string;
  /** A PNG of that chart view (1200 x 630, candles, heatmap, prints), for clients that show images. */
  chart_image_url?: string;
  api_path: string;
  /** The answer's own timestamp (generatedAt, generated_at, as_of); null when the route does not stamp one. */
  generated_at: string | null;
  fetched_at: string;
  venues?: string[];
  /** full: every counted feed is a complete record; sampled: every one is sampled; mixed: both. */
  coverage?: ProvenanceCoverage;
  stale_venues?: string[];
  recorded_since?: string;
  proof: string;
};

/* API stems whose public page has a different name (2026-09-04 audit: stripping /api/public gave nine tools a source
 * that 404s on the site). */
const PAGE_FOR_STEM: Record<string, string> = {
  "/borrow-rates": "/borrow",
  "/oi": "/oi-leaderboard",
  "/venues/markets": "/venues",
  "/venues/lead-lag": "/venues",
  "/venues/profile": "/venues",
  "/venues/oi-history": "/venues",
  "/options/surface": "/options",
  "/context": "/methodology",
  "/leverage-tiers": "/leverage",
  "/datasets/etf-flows": "/etf",
  "/datasets/liquidations-daily": "/liquidations",
  "/jupiter": "/jupiter-perps",
  "/market-profile": "/symbols",
  "/liquidation-leaderboard": "/liquidations",
};

/** The site page a route's numbers are shown on. */
export function pageForApiPath(path: string): string {
  const clean = path.split("?")[0] || "/";
  if (clean === "/api/v1/proof" || clean.startsWith("/api/v1/proof/")) return "/proof";
  if (clean === "/api/series" || clean.startsWith("/api/series/")) return "/chart";
  const stem = clean.replace(/^\/api\/(?:v1\/)?public/, "").replace(/\.(?:json|csv)$/, "") || "/";
  return PAGE_FOR_STEM[stem] ?? stem;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/* Coverage kinds of the liquidation registry. "delayed" is a complete record that arrives late, so it reads as full;
 * "shadow" and "none" are feeds we hold but do not count, so they are not a source of the number. */
const COUNTED_KINDS = new Set(["full", "sampled", "delayed"]);
const UNCOUNTED_KINDS = new Set(["shadow", "none"]);
const VENUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,39}$/;
const MAX_VENUES = 100;

function venueId(item: unknown): string | undefined {
  if (typeof item === "string") return VENUE_TOKEN.test(item) ? item : undefined;
  if (!isRec(item)) return undefined;
  const id = str(item.exchange) ?? str(item.venue_id) ?? str(item.id) ?? str(item.key) ?? str(item.venue);
  return id && VENUE_TOKEN.test(id) ? id : undefined;
}

/* Chart block phase 2 (2026-10-07): the SuperChart address that shows what an answer holds, so an agent can hand the
 * reader a chart that opens on the same symbol, period and layers (chart-url-state.ts keys: s, p, panes, heat, pr,
 * lv, v, r, rv). Null for routes with no chart twin. The symbol defaults to BTCUSDT when the query names none. Since
 * 2026-10-08 (the desk's MCP test): the venue asked for rides as v, a bounded window (to plus limit bars, or from
 * and to) as r=from..to in unix seconds, and the dataset and incident routes have their twins too. */
const CHART_BASE = "https://bykaranteli.com/chart";
const CHART_PERIOD_MS: Record<string, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "10m": 600_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000 };
function chartSymbol(q: URLSearchParams): string {
  const raw = (q.get("symbol") ?? q.get("coin") ?? q.get("currency") ?? q.get("asset") ?? "BTC").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return "BTCUSDT";
  return /USDT$|USD$|PERP$/.test(raw) ? raw : `${raw}USDT`;
}
/** The venue and the window of the request as chart keys (empty when the request names neither). */
function chartExtras(q: URLSearchParams, periodMs: number): string {
  let out = "";
  const venue = (q.get("venue") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (venue && venue !== "binance" && venue !== "all") out += `&v=${venue}`;
  const toRaw = q.get("to");
  const fromRaw = q.get("from");
  const to = toRaw ? Date.parse(toRaw) : NaN;
  const limit = Number(q.get("limit"));
  let from = fromRaw ? Date.parse(fromRaw) : NaN;
  if (!Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(limit) && limit > 0 && periodMs > 0) from = to - limit * periodMs;
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) out += `&r=${Math.floor(from / 1000)}..${Math.floor(to / 1000)}`;
  return out;
}
export function chartUrlForApiPath(path: string): string | null {
  const [clean, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  const s = chartSymbol(q);
  if (clean === "/api/series" || clean.startsWith("/api/series/")) {
    const metric = (q.get("metric") ?? "price").toLowerCase();
    const period = q.get("period") ?? "1h";
    const panes = metric === "price" || metric === "volume" ? "" : `&panes=${encodeURIComponent(metric)}`;
    return `${CHART_BASE}?s=${s}&p=${encodeURIComponent(period)}${panes}${chartExtras(q, CHART_PERIOD_MS[period] ?? 0)}&heat=1&pr=1`;
  }
  const x = chartExtras(q, 0);
  if (clean.startsWith("/api/liqmap/") || clean.startsWith("/api/public/liqmap") || clean.startsWith("/api/public/liquidations") || clean.startsWith("/api/public/liquidation-cascades") || clean.startsWith("/api/v1/public/datasets/liquidation") || clean === "/api/public/incidents") {
    return `${CHART_BASE}?s=${s}&panes=liquidations,oi&heat=1&pr=1&rv=1${x}`;
  }
  if (clean.startsWith("/api/public/options")) return `${CHART_BASE}?s=${s}&panes=oi&lv=1&heat=1&pr=0${x}`;
  if (clean.startsWith("/api/public/funding") || clean.startsWith("/api/public/heatmap")) return `${CHART_BASE}?s=${s}&panes=funding,oi&heat=1&pr=0${x}`;
  if (clean.startsWith("/api/public/oi")) return `${CHART_BASE}?s=${s}&panes=oi,funding&heat=1&pr=0${x}`;
  if (clean.startsWith("/api/public/positioning") || clean.startsWith("/api/public/long-short")) return `${CHART_BASE}?s=${s}&panes=long_short,top_traders&heat=0&pr=0${x}`;
  if (clean.startsWith("/api/public/etf") || clean.startsWith("/api/v1/public/datasets/etf")) return `${CHART_BASE}?s=${s}&p=1d&panes=etf_flow&heat=0&pr=0${x}`;
  if (clean.startsWith("/api/public/hyperliquid-whales")) return `${CHART_BASE}?s=${s}&panes=whale_net,oi&heat=1&pr=1&hw=1${x}`;
  return null;
}

export function buildProvenance(
  data: unknown,
  at: { apiPath: string; sourcePage: string; fetchedAt: string },
): Provenance {
  const d: Rec = isRec(data) ? data : {};
  const meta: Rec = isRec(d.meta) ? d.meta : {};
  const coverageRec: Rec = isRec(d.coverage) ? d.coverage : {};
  const estimate: Rec = isRec(d.market_estimate) ? d.market_estimate : {};

  const venues: string[] = [];
  const kinds = new Set<string>();
  const stale: string[] = [];
  let staleKnown = false;
  const addVenue = (id: string) => {
    if (!venues.includes(id) && venues.length < MAX_VENUES) venues.push(id);
  };
  const addStale = (id: string) => {
    if (!stale.includes(id)) stale.push(id);
  };
  const addList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list.slice(0, 1000)) {
      const kind = isRec(item) ? str(item.kind) ?? str(item.coverage) : undefined;
      if (kind && UNCOUNTED_KINDS.has(kind)) continue;
      const id = venueId(item);
      if (!id) continue;
      addVenue(id);
      if (kind && COUNTED_KINDS.has(kind)) kinds.add(kind === "delayed" ? "full" : kind);
      if (isRec(item) && typeof item.stale === "boolean") {
        staleKnown = true;
        if (item.stale) addStale(id);
      }
    }
  };
  const addStaleList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    staleKnown = true;
    for (const item of list) {
      const id = venueId(item);
      if (id) addStale(id);
    }
  };

  const single = str(d.venue);
  if (single && VENUE_TOKEN.test(single)) addVenue(single);
  addList(d.venues);
  addList(d.by_exchange);
  addList(d.coverage);
  addList(coverageRec.counted);
  addList(d.sources);
  addList(meta.venues);
  addStaleList(d.stale_venues);
  addStaleList(coverageRec.stale);
  addStaleList(estimate.stale_venues);
  const coverageWord = str(d.coverage);
  if (coverageWord && COUNTED_KINDS.has(coverageWord)) kinds.add(coverageWord === "delayed" ? "full" : coverageWord);

  const since = str(d.recorded_since) ?? str(d.history_since) ?? str(meta.recorded_since) ?? str(meta.history_since);
  return {
    source_page: at.sourcePage,
    ...(chartUrlForApiPath(at.apiPath) ? { chart_url: chartUrlForApiPath(at.apiPath)!, chart_image_url: chartUrlForApiPath(at.apiPath)!.replace("/chart?", "/api/og/chart?") } : {}),
    api_path: at.apiPath,
    generated_at: str(d.generatedAt) ?? str(d.generated_at) ?? str(d.as_of) ?? str(d.asOf) ?? str(meta.generatedAt) ?? str(meta.generated_at) ?? str(meta.as_of) ?? null,
    fetched_at: at.fetchedAt,
    ...(venues.length > 0 ? { venues } : {}),
    ...(kinds.size > 0 ? { coverage: kinds.size > 1 ? "mixed" : (kinds.values().next().value as ProvenanceCoverage) } : {}),
    ...(staleKnown ? { stale_venues: stale } : {}),
    ...(since ? { recorded_since: since } : {}),
    proof: PROOF_URL,
  };
}
