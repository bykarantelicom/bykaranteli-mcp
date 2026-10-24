/**
 * Compact answers (1.1.0, 2026-10-24). Two callers:
 *   - the `detail: "compact"` value of thirteen large tools (tools.ts): a shorter page than the default one, for a
 *     model that only needs the headline figures;
 *   - the AI desk on bykaranteli.com, which runs the same tools in process and caps every tool answer at a fixed
 *     number of characters before the model reads it (compactToolText).
 * Nothing here recomputes a figure: lists are cut in the route's own order, numbers are rounded to a few significant
 * digits, long free text is shortened, and every cut is named in `trimmed` the way the default pages name theirs.
 */

export type CompactCut = { field: string; returned: number; total: number; more: string };

export type CompactRule = {
  /** Items kept per list (default 10; Infinity leaves every list as the tool cut it). The thirteen tool rules leave
   * lists alone: each tool cuts its own lists in its handler, where it knows which end of a series is the newest. */
  maxItems?: number;
  /** Per-key item caps by the list's own key, e.g. { exchanges: 3 }; wins over maxItems for that key. */
  fields?: Readonly<Record<string, number>>;
  /** Top-level keys left out entirely (heatmap grids, label axes). */
  drop?: readonly string[];
  /** Keys whose strings are never shortened and whose lists are never cut (the quotable text of a desk note, the
   * routes' own field definitions in `note`). */
  keepKeys?: readonly string[];
  /** Longest string kept (default 300 characters); longer ones are cut with a marker. */
  maxString?: number;
  /** Significant digits kept on non-integer numbers (default 6). */
  significant?: number;
  /** The `more` text of every cut (default: the full answer parameter). */
  more?: string;
};

const DEFAULT_MORE = "narrow the call: a symbol, fewer days or a smaller limit";
/** Keys never shortened: provenance and page links are what the reader follows. */
const KEEP_KEYS = new Set(["provenance", "source", "generatedAt", "generated_at", "as_of", "asOf", "trimmed", "license", "page", "links", "url", "destination_url", "image_url", "note"]);

/** The first `max` UTF-16 units without a dangling high surrogate at the end. */
function cutString(v: string, max: number): string {
  let end = max;
  const unit = v.charCodeAt(end - 1);
  if (end > 0 && unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return v.slice(0, end);
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function roundNumber(n: number, significant: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  const r = Number(n.toPrecision(significant));
  return Number.isFinite(r) ? r : n;
}

/** Walks one answer; returns the shortened copy and the cuts it made. */
export function compactValue(value: unknown, rule: CompactRule = {}): { value: unknown; cuts: CompactCut[] } {
  const maxItems = rule.maxItems ?? 10;
  const keep = new Set([...KEEP_KEYS, ...(rule.keepKeys ?? [])]);
  const maxString = rule.maxString ?? 300;
  const significant = rule.significant ?? 6;
  const more = rule.more ?? DEFAULT_MORE;
  const cuts: CompactCut[] = [];
  const noted = new Set<string>();
  const note = (field: string, returned: number, total: number) => {
    if (noted.has(field)) {
      const prev = cuts.find((c) => c.field === field);
      if (prev) {
        prev.returned += returned;
        prev.total += total;
      }
      return;
    }
    noted.add(field);
    cuts.push({ field, returned, total, more });
  };
  const walk = (v: unknown, path: string, key: string, depth: number): unknown => {
    if (typeof v === "number") return roundNumber(v, significant);
    if (typeof v === "string") {
      if (v.length > maxString && !keep.has(key)) {
        note(`${path} (characters)`, maxString, v.length);
        return `${cutString(v, maxString)}…`;
      }
      return v;
    }
    if (Array.isArray(v)) {
      const cap = keep.has(key) ? Number.POSITIVE_INFINITY : rule.fields?.[key] ?? maxItems;
      const kept = v.length > cap ? v.slice(0, cap) : v;
      if (v.length > cap) note(`${path}[]`, cap, v.length);
      return kept.map((item) => walk(item, `${path}[]`, key, depth + 1));
    }
    if (isRec(v)) {
      const out: Rec = {};
      for (const [k, x] of Object.entries(v)) {
        if (depth === 0 && rule.drop?.includes(k)) {
          note(k, 0, Array.isArray(x) ? x.length : 1);
          continue;
        }
        if (keep.has(k)) {
          out[k] = x;
          continue;
        }
        out[k] = walk(x, path ? `${path}.${k}` : k, k, depth + 1);
      }
      return out;
    }
    return v;
  };
  const out = walk(value, "", "", 0);
  if (isRec(out) && cuts.length > 0) {
    const prior = Array.isArray(out.trimmed) ? (out.trimmed as CompactCut[]) : [];
    return { value: { ...out, trimmed: [...prior, ...cuts] }, cuts };
  }
  return { value: out, cuts };
}

/**
 * One tool answer (its JSON text) under a character cap. The caps shrink until the text fits: first the rule's own
 * item caps, then halves of them down to two items, then the largest top-level lists are left out. The answer is
 * never cut mid-JSON; a model always reads a complete document with its `trimmed` notes. Non-JSON text (an error
 * line) is cut at the cap with a marker.
 */
export function compactToolText(text: string, cap: number, rule: CompactRule = {}): { text: string; cuts: CompactCut[]; capped: boolean; chars: number } {
  if (text.length <= cap) return { text, cuts: [], capped: false, chars: text.length };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const cut = `${cutString(text, Math.max(0, cap - 40))} [cut at ${cap} characters]`;
    return { text: cut, cuts: [], capped: true, chars: cut.length };
  }
  let maxItems = Number.isFinite(rule.maxItems ?? 10) ? (rule.maxItems ?? 10) : 10;
  let fields = rule.fields;
  for (let round = 0; round < 8; round += 1) {
    const { value, cuts } = compactValue(parsed, { ...rule, maxItems, fields });
    const out = JSON.stringify(value);
    if (out.length <= cap) return { text: out, cuts, capped: true, chars: out.length };
    if (maxItems <= 2) break;
    maxItems = Math.max(2, Math.floor(maxItems / 2));
    fields = fields ? Object.fromEntries(Object.entries(fields).map(([k, n]) => [k, Math.max(2, Math.floor(n / 2))])) : undefined;
  }
  /* Still over: leave out the top-level lists one by one, the one that costs the most at the final caps first. */
  if (isRec(parsed)) {
    const rec: Rec = { ...parsed };
    const lists = Object.entries(rec)
      .filter(([k, v]) => Array.isArray(v) && !KEEP_KEYS.has(k) && !(rule.keepKeys ?? []).includes(k))
      .map(([k, v]) => [k, JSON.stringify((v as unknown[]).slice(0, fields?.[k] ?? maxItems)).length] as const)
      .sort((a, b) => b[1] - a[1]);
    const dropped: string[] = [];
    for (const [k] of lists) {
      dropped.push(k);
      const { value, cuts } = compactValue(rec, { ...rule, maxItems, fields, drop: [...(rule.drop ?? []), ...dropped] });
      const out = JSON.stringify(value);
      if (out.length <= cap) return { text: out, cuts, capped: true, chars: out.length };
    }
  }
  const fallback = JSON.stringify({ truncated: true, chars: text.length, limit: cap, note: "Answer too large for the desk even in compact form. Narrow the call: one symbol, fewer days or a smaller limit." });
  return { text: fallback, cuts: [], capped: true, chars: fallback.length };
}

/** The compact rules of the thirteen large tools (measured 24 Oct 2026, olcum/mcp_arac_sayimi.md). Each handler cuts
 *  its own lists for detail "compact" (it knows which end of a series is the newest and writes one `trimmed` entry
 *  with consistent counts); these rules only round figures, shorten free text and leave grids out, so every list
 *  stays as the handler cut it (maxItems Infinity). A key here must be a tool that declares `detail`
 *  (test/compact.test.mjs checks the two sets agree). */
const NO_LIST_CUT = Number.POSITIVE_INFINITY;
export const COMPACT_RULES = {
  get_liqmap: { maxItems: NO_LIST_CUT, drop: ["heatmap_cells", "x_labels", "y_labels", "band_prices", "price_path", "candles"], more: 'pass detail "full" for every level and print' },
  get_turkey_premium: { maxItems: NO_LIST_CUT, maxString: 300 },
  get_correlations: { maxItems: NO_LIST_CUT },
  get_hl_whales: { maxItems: NO_LIST_CUT },
  get_options_flow: { maxItems: NO_LIST_CUT, maxString: 300 },
  get_funding_arbitrage: { maxItems: NO_LIST_CUT },
  get_desk_notes: { maxItems: NO_LIST_CUT, keepKeys: ["text", "headline", "x_text", "history_line"] },
  get_positioning: { maxItems: NO_LIST_CUT },
  get_coverage: { maxItems: NO_LIST_CUT, maxString: 200, keepKeys: ["note_en"], drop: ["matrix"], more: "omit detail for the venue by product matrix" },
  get_new_listings: { maxItems: NO_LIST_CUT },
  get_venue_markets: { maxItems: NO_LIST_CUT },
  get_tokenized_stocks: { maxItems: NO_LIST_CUT, maxString: 300 },
  get_factor_board: { maxItems: NO_LIST_CUT, maxString: 200, keepKeys: ["interpretationEn", "todayText", "bandEn"] },
} as const satisfies Readonly<Record<string, CompactRule>>;

export type CompactToolName = keyof typeof COMPACT_RULES;
export const COMPACT_TOOL_NAMES: readonly CompactToolName[] = Object.keys(COMPACT_RULES) as CompactToolName[];
