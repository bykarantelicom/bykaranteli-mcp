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
function rpc(method, params) {
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
check("tools/list count", names.length === 8, names.join(","));

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

const heat = await call("get_funding_heatmap", { symbol: "btc" });
check(
  "get_funding_heatmap(btc)",
  !heat.isError && heat.text.includes("BTCUSDT") && heat.text.includes("fundingRatePct"),
  heat.text.slice(0, 80).replace(/\n/g, " "),
);

const perf = await call("get_symbol_performance", { symbol: "ETH", window_days: 180 });
check(
  "get_symbol_performance(ETH,180)",
  !perf.isError && perf.text.includes("ETHUSDT") && perf.text.includes("winRatePct"),
  perf.text.slice(0, 80).replace(/\n/g, " "),
);

// Windows with no closed signals 404 upstream; the tool must answer with a
// plain note instead of an error.
const perfEmpty = await call("get_symbol_performance", { symbol: "ETH", window_days: 30 });
check(
  "get_symbol_performance empty window note",
  !perfEmpty.isError && perfEmpty.text.includes("No closed signals"),
  perfEmpty.text.slice(0, 80).replace(/\n/g, " "),
);

const pressure = await call("get_pressure_scores", { limit: 3 });
check(
  "get_pressure_scores(limit=3)",
  !pressure.isError && (pressure.text.match(/"symbol"/g) ?? []).length === 3,
  `symbols=${(pressure.text.match(/"symbol"/g) ?? []).length}`,
);

const bad = await call("get_symbol_performance", { symbol: "not a symbol!!" });
check("invalid symbol rejected", bad.isError === true, bad.text.slice(0, 70));

const arb = await call("get_funding_arbitrage");
check("get_funding_arbitrage", !arb.isError && arb.text.includes("netApr"), "");

const movers = await call("get_top_movers");
check("get_top_movers", !movers.isError && movers.text.includes("biggestOi24h"), "");

const recent = await call("get_recent_signals");
check("get_recent_signals", !recent.isError && recent.text.includes("total24h"), "");

const lb = await call("get_strategy_leaderboard");
check("get_strategy_leaderboard", !lb.isError && lb.text.includes("profit_factor_net"), "");

child.kill();
console.log(failures.length === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures.length} FAILURES: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
