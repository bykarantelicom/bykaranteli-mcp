// Local smoke test: drives the built server over stdio with raw JSON-RPC.
// Not shipped in the npm package (dist/ only).
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
/* SMOKE_PACE_MS spaces out tool calls so a free key (30 requests a minute) can run the whole suite; 0 keeps the
 * old back-to-back behaviour for keys with a higher limit. */
const PACE_MS = Number(process.env.SMOKE_PACE_MS ?? 0);
async function rpc(method, params) {
  if (PACE_MS > 0 && method === "tools/call") await new Promise((r) => setTimeout(r, PACE_MS));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 25_000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  }
}

const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
check("initialize", init.result?.serverInfo?.name === "bykaranteli", JSON.stringify(init.result?.serverInfo));
notify("notifications/initialized", {});

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
check("tools/list count", names.length === 67, names.join(","));
/* 0.31.0: the account tools act on the caller's own account. The four writes are never called here; the account reads
 * run only with a key (BYKARANTELI_API_KEY), since without one they answer with the key steps by design. */
const WRITE_TOOLS = new Set(["create_alert_recipe", "delete_alert_recipe", "add_watchlist_symbol", "remove_watchlist_symbol"]);
const ACCOUNT_READ_TOOLS = new Set(["list_alert_recipes", "list_watchlists", "parse_alert_text"]);
const HAS_KEY = Boolean((process.env.BYKARANTELI_API_KEY ?? "").trim());
const tools = list.result?.tools ?? [];
check(
  "market tools annotated read-only and open-world",
  tools.filter((t) => !WRITE_TOOLS.has(t.name) && !ACCOUNT_READ_TOOLS.has(t.name)).every((t) => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === true),
  "",
);
check("account reads annotated read-only", tools.filter((t) => ACCOUNT_READ_TOOLS.has(t.name)).every((t) => t.annotations?.readOnlyHint === true), "");
check(
  "write tools annotated as writes, removals destructive",
  tools.filter((t) => WRITE_TOOLS.has(t.name)).length === WRITE_TOOLS.size &&
    tools.filter((t) => WRITE_TOOLS.has(t.name)).every((t) => t.annotations?.readOnlyHint === false && t.title.endsWith("(writes to your account)")) &&
    ["delete_alert_recipe", "remove_watchlist_symbol"].every((n) => tools.find((t) => t.name === n)?.annotations?.destructiveHint === true),
  "",
);

/* D14-12: every tool gets at least one default-argument call; a tool that
 * errors on its own defaults would otherwise ship silently broken. Runs
 * before the targeted assertions so their deeper checks still apply. */
const REQUIRED_ARGS = {
  get_metric_context: { metric: "fear_greed" },
  get_series: { metric: "oi", symbol: "BTC", period: "1h", limit: 24 },
  parse_alert_text: { text: "BTC funding above 0.05%" },
};
for (const toolName of names) {
  if (WRITE_TOOLS.has(toolName)) continue;
  if (ACCOUNT_READ_TOOLS.has(toolName) && !HAS_KEY) {
    console.log(`SKIP call ${toolName} · no BYKARANTELI_API_KEY`);
    continue;
  }
  const r = await callAll(toolName, REQUIRED_ARGS[toolName] ?? {});
  check(`call ${toolName}`, !r.isError, r.isError ? r.text.slice(0, 100).replace(/\n/g, " ") : "");
}
async function callAll(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  return { isError: r.isError ?? r.result?.isError ?? false, text };
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args ?? {} });
  const text = r.result?.content?.[0]?.text ?? "";
  return { isError: r.result?.isError ?? false, text, raw: r };
}

const indices = await call("get_market_indices");
check(
  "get_market_indices",
  !indices.isError && indices.text.includes("fearGreed") && indices.text.includes("generatedAt"),
  indices.text.slice(0, 80).replace(/\n/g, " "),
);
check("provenance on a market answer", !indices.isError && indices.text.includes('"provenance":{"source_page"'), "");

const liq = await call("get_liquidations", { symbol: "BTCUSDT", days: 3 });
check(
  "get_liquidations(BTCUSDT)",
  !liq.isError && liq.text.includes("long_liquidations_usd") && liq.text.includes("BTCUSDT"),
  liq.text.slice(0, 80).replace(/\n/g, " "),
);

const etf = await call("get_etf_flows", { asset: "BTC", days: 5 });
check(
  "get_etf_flows(BTC)",
  !etf.isError && etf.text.includes("net_inflow_usd") && etf.text.includes("BTC"),
  etf.text.slice(0, 80).replace(/\n/g, " "),
);

const heat = await call("get_funding_heatmap", { symbol: "btc" });
check(
  "get_funding_heatmap(btc)",
  !heat.isError && heat.text.includes("BTCUSDT") && heat.text.includes("fundingRatePct"),
  heat.text.slice(0, 80).replace(/\n/g, " "),
);

const pressure = await call("get_pressure_scores", { limit: 3 });
check(
  "get_pressure_scores(limit=3)",
  !pressure.isError && (pressure.text.match(/"symbol"/g) ?? []).length === 3,
  `symbols=${(pressure.text.match(/"symbol"/g) ?? []).length}`,
);

const bad = await call("get_liquidations", { symbol: "not a symbol!!" });
check("invalid symbol rejected", bad.isError === true, bad.text.slice(0, 70));

// LLM-typical spellings must normalize instead of erroring.
const slash = await call("get_funding_heatmap", { symbol: "BTC/USDT" });
check("BTC/USDT normalized", !slash.isError && slash.text.includes("BTCUSDT"), "");
const strWin = await call("get_liquidations", { symbol: "ETH", window_days: "3" });
check("string window_days coerced", !strWin.isError && strWin.text.includes("window_days"), "");

const arb = await call("get_funding_arbitrage");
check("get_funding_arbitrage", !arb.isError && arb.text.includes("netApr"), "");

const movers = await call("get_top_movers");
check("get_top_movers", !movers.isError && movers.text.includes("biggestOi24h"), "");

child.kill();
console.log(failures.length === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures.length} FAILURES: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
