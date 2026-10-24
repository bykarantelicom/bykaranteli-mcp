import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPACT_RULES, COMPACT_TOOL_NAMES, compactToolText, compactValue } from "../dist/compact.js";
import { registerByKaranteliTools } from "../dist/tools.js";

test("compactValue cuts lists, rounds numbers, shortens strings and names every cut", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ i, price: 61234.56789123, text: "x".repeat(400) }));
  const { value, cuts } = compactValue({ rows, legs: [1, 2, 3, 4], note: "y".repeat(500), memo: "y".repeat(500), provenance: { kept: "z".repeat(500) }, grid: [[1, 2, 3], [4, 5, 6]] }, { maxItems: 10, fields: { legs: 2 }, drop: ["grid"] });
  assert.equal(value.rows.length, 10);
  assert.equal(value.legs.length, 2);
  assert.equal(value.rows[0].price, 61234.6);
  assert.equal(value.rows[0].text.length, 301);
  assert.equal(value.note.length, 500, "note is a route's field definitions, never shortened");
  assert.equal(value.memo.length, 301);
  assert.equal(value.provenance.kept.length, 500, "provenance is never shortened");
  assert.equal(value.grid, undefined);
  const fields = cuts.map((c) => c.field);
  assert.deepEqual(fields, ["rows[]", "rows[].text (characters)", "legs[]", "memo (characters)", "grid"]);
  assert.deepEqual(cuts[4], { field: "grid", returned: 0, total: 2, more: "narrow the call: a symbol, fewer days or a smaller limit" });
  assert.equal(value.trimmed.length, 5);
});

test("keepKeys protect strings and lists, Infinity leaves lists alone, surrogate pairs are never split", () => {
  const { value, cuts } = compactValue({ text: "t".repeat(400), items: Array.from({ length: 40 }, (_, i) => i), other: "o".repeat(400) }, { maxItems: Number.POSITIVE_INFINITY, keepKeys: ["text"] });
  assert.equal(value.text.length, 400);
  assert.equal(value.items.length, 40);
  assert.equal(value.other.length, 301);
  assert.deepEqual(cuts.map((c) => c.field), ["other (characters)"]);
  const astral = compactValue({ s: "x".repeat(279) + "🚀 rest" }, { maxString: 280 }).value.s;
  assert.ok(astral.isWellFormed(), "no lone surrogate");
  assert.equal(astral, "x".repeat(279) + "…");
});

test("compactValue leaves an answer that needs no cut untouched and keeps integers exact", () => {
  const input = { a: [1, 2], n: 1234567890123, f: 0.000123456789 };
  const { value, cuts } = compactValue(input);
  assert.deepEqual(cuts, []);
  assert.equal(value.n, 1234567890123);
  assert.equal(value.f, 0.000123457);
  assert.equal(value.trimmed, undefined);
});

test("compactToolText returns the text as is under the cap and a complete JSON document above it", () => {
  const small = JSON.stringify({ ok: true });
  assert.deepEqual(compactToolText(small, 100), { text: small, cuts: [], capped: false, chars: small.length });
  const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i, v: Math.random() })), note: "n" });
  const out = compactToolText(big, 4000);
  assert.ok(out.capped);
  assert.ok(out.chars <= 4000, `chars ${out.chars}`);
  const parsed = JSON.parse(out.text);
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length < 400);
  assert.ok(parsed.trimmed.some((c) => c.field === "rows[]"));
});

test("compactToolText drops lists at the halved caps when halving alone is not enough", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i, text: "r".repeat(60) }));
  const series = { BTC: { "1h": Array.from({ length: 24 }, (_, i) => ({ t: i, v: 1.123456789 })), "5m": Array.from({ length: 24 }, (_, i) => ({ t: i, v: 2.123456789 })) } };
  const big = JSON.stringify({ rows, series, keep: 1 });
  const out = compactToolText(big, 900, { maxItems: 12, fields: { "1h": 12, "5m": 12 } });
  assert.ok(out.capped);
  assert.ok(out.chars <= 900, `chars ${out.chars}`);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.keep, 1);
  assert.ok(parsed.rows === undefined || parsed.rows.length <= 12);
});

test("compactToolText cuts non-JSON text at the cap with a marker", () => {
  const out = compactToolText("Error fetching data: " + "z".repeat(1000), 200);
  assert.ok(out.capped);
  assert.ok(out.text.endsWith("[cut at 200 characters]"));
  assert.ok(out.text.length <= 200);
});

test("the tools that declare detail are exactly the thirteen with a compact rule", () => {
  const withDetail = [];
  const collector = { registerTool: (name, def) => { if (def.inputSchema && "detail" in def.inputSchema) withDetail.push(name); } };
  registerByKaranteliTools(collector, { baseUrl: "http://127.0.0.1:1", publicUrl: "https://bykaranteli.com", version: "test" });
  assert.deepEqual([...withDetail].sort(), [...COMPACT_TOOL_NAMES].sort());
  assert.equal(COMPACT_TOOL_NAMES.length, 13);
  for (const name of COMPACT_TOOL_NAMES) assert.equal(COMPACT_RULES[name].maxItems, Number.POSITIVE_INFINITY, `${name}: lists are cut by the handler`);
  assert.ok(COMPACT_RULES.get_liqmap.drop.includes("heatmap_cells"));
});
