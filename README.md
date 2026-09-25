# bykaranteli-mcp

MCP (Model Context Protocol) server for **live crypto derivatives data**: funding rates, cross-exchange funding arbitrage, open interest pressure, liquidations, options, ETF flows, Fear & Greed and BTC dominance.

50 read-only tools over the public JSON API of [bykaranteli.com](https://bykaranteli.com/developers). Since 2026-09-10 the API asks programs for an account key: a **free key** comes with any verified account at <https://bykaranteli.com/dashboard/api> (30 requests a minute and 15,000 a month, public depth), and the Builder, Business and Scale plans raise the rate and the monthly fair use and unlock member depth (LiqMap on seven timeframes, 5-minute series, a monthly x402 catalog allowance). Set it as `BYKARANTELI_API_KEY`. Data covers Binance USDT-M perpetuals; funding arbitrage, liquidations, order book depth, options, positioning and insurance funds add the other venues each board lists on bykaranteli.com/coverage.

## Hosted endpoint (no install)

Paste `https://mcp.bykaranteli.com` as a custom connector in any MCP-capable
assistant. Same 50 tools, nothing to install. Every tool call needs your
account key (free at <https://bykaranteli.com/dashboard/api>); connecting and
listing the tools work without one. The key travels one of three ways:

- the request header `x-api-key: bk_...` (claude.ai custom connectors, Cursor,
  Claude Code);
- the request header `Authorization: Bearer bk_...`;
- the address `https://mcp.bykaranteli.com/?key=bk_...` for clients that cannot
  send headers (ChatGPT). Treat that address like a password and revoke the key
  if it leaks.

A free account covers the API and the hosted MCP on one monthly counter;
Builder and above bring higher rates and member depth.

## Quick start

### Claude Code

```bash
claude mcp add bykaranteli -e BYKARANTELI_API_KEY=bk_... -- npx -y bykaranteli-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bykaranteli": {
      "command": "npx",
      "args": ["-y", "bykaranteli-mcp"],
      "env": { "BYKARANTELI_API_KEY": "bk_..." }
    }
  }
}
```

### Cursor / other MCP clients

Any stdio MCP client works: command `npx`, args `["-y", "bykaranteli-mcp"]`, env `BYKARANTELI_API_KEY`.

Requires Node.js 18 or newer.

## Tools

| Tool | What it answers |
|---|---|
| `get_market_indices` | "What is the Fear & Greed index today?", "What is BTC dominance right now?" |
| `get_funding_heatmap` | "What are funding rates right now?", "What is SOL's funding?" |
| `get_funding_arbitrage` | "Any funding arb opportunities?", "Best venue to long/short BTC for carry?" |
| `get_pressure_scores` | "Which coins are over-leveraged / crowded right now?" |
| `get_top_movers` | "Biggest OI spikes today?", "Most extreme funding right now?" |
| `get_liquidations` | "How much was liquidated today?", "Did longs or shorts get flushed this week?" |
| `get_liquidation_leaderboard` | "What was the biggest liquidation today?", "When do liquidations cluster, Asia or US hours?" |
| `get_insurance_funds` | "How big is the Binance insurance fund?", "Did any exchange insurance fund shrink this week?" |
| `get_tokenized_stocks` | "How much tokenized Tesla exists onchain?", "Which tokenized stock trades furthest from the real share?", "Which price valued this wrapper's supply?" (`price_source`, `totals.priced_by`) |
| `get_etf_flows` | "Did the Bitcoin ETFs buy or sell yesterday?", "Cumulative ETH ETF inflow?" |
| `get_cot_positioning` | "Are hedge funds long or short Bitcoin?", "What did the COT report show?" |
| `get_options_snapshot` | "Where are the BTC option walls?", "What is DVOL / the zero-gamma level?" |
| `get_coinbase_premium` | "Are US investors buying Bitcoin?", "What does the basis trade pay?" |
| `get_flow_toxicity` | "Is toxic order flow building?", "What is BTC's VPIN right now?" |
| `get_options_flow` | "What are the big options players buying?", "Any block trades today?" |
| `get_slippage` | "How much slippage on a $1M market order?", "Which book is thinnest?" |
| `get_fomc_impact` | "What does BTC do on Fed days?", "When is the next FOMC meeting?" |
| `get_liquidation_cascades` | "What caused that flush?", "Who got liquidated this week?" |
| `get_open_interest` | "Is leverage entering the market?", "Are shorts building in XRP?" |
| `get_psi_charge` | "What liquidity state is the market in?", "Is parked money deploying?" |
| `get_theme_indices` | "Which crypto narrative is leading: AI, RWA, DePIN, memes, L2s, DeFi?" |
| `get_factor_board` | "Which indicators sit in an unusual band today, and what followed historically?" |
| `get_venue_markets` | "Total BTC open interest across exchanges?", "What is the DEX share of perp OI?", "Is USDT off peg anywhere?" |
| `get_leverage_tiers` | "How much leverage does Bybit allow on SOL?", "Which exchange has the highest max leverage for DOGE?", "Did any venue cut leverage on a coin this week?" |
| `get_withdrawal_status` | "Has KuCoin paused USDT withdrawals?", "Cheapest network to withdraw USDT from Gate?", "Which exchanges have withdrawals closed right now?" |
| `get_venue_profile` | "What do you record about Bybit?", "How many contracts does OKX list?", "Is HTX up, and what happened there this week?" |
| `get_settlements` | "What expires this week?", "When is the next BTC quarterly on OKX?", "At what price did the September future settle?" |
| `get_borrow_rates` | "What does it cost to borrow USDT on Binance?", "Cheapest venue to borrow ETH?", "Is stablecoin borrow spiking?" |
| `get_fee_table` | "What are Bitget's perp fees?", "Which exchange has the lowest taker fee?", "Did any venue change fees this week?" |
| `get_lead_lag` | "Does Coinbase or Binance move first?" |
| `get_iv_surface` | "What is BTC implied vol by expiry?", "Is downside protection expensive (skew)?" |
| `get_whale_tape` | "Are whales buying or selling right now?" |
| `get_correlations` | "How correlated is SOL to BTC over 30 days?" |
| `get_new_listings` | "Which perpetuals were listed this week, and where first?" |
| `get_macro_liquidity` | "What is the Fed balance sheet / RRP / stablecoin supply doing?" |
| `get_network_health` | "Bitcoin hashrate, difficulty, fees, mempool right now?" |
| `get_tradfi_board` | "TSLA perp funding rate? Which exchanges list NVDA perps? Is the stock session open?" |
| `get_rsi_heatmap` | "Which coins are oversold on the daily? BTC RSI on 4h and 1w?" |
| `get_hl_whales` | "Are Hyperliquid whales net long BTC? What did the biggest accounts just flip?" |
| `get_positioning` | "BTC long/short ratio on Binance? Are top traders net short ETH? CVD today?" |
| `get_coverage` | "Which exchanges are behind your liquidation totals? How fresh is the data?" |
| `get_orderbook_depth` | "Where is the biggest BTC bid wall? How deep is ETH within 2% on Coinbase vs Binance?" |
| `get_jupiter_perps` | "How much long vs short OI is on Jupiter SOL perps? Who topped Jupiter this week? What is the JLP APR?" |
| `get_turkey_premium` | "What do lira buyers pay for bitcoin above the world price? What is the Turkey Premium Index and its score right now? Which Turkish exchange is dearest? What is USDT/TRY against the official rate?" |
| `get_data_proof` | "Can I verify a ByKaranteli number was not changed later? Show the on-chain proof for BTC funding right now. Which Solana transaction sealed the newest epoch?" |
| `get_cycle_indicators` | "Has the Pi Cycle crossed? Mayer Multiple and Puell today?" |
| `get_altseason` | "Is it altseason?", "What is the altcoin season index?" |
| `get_metric_context` | "Is today's funding extreme historically?", "Where does this reading sit in its distribution?" |
| `get_quantum_exposure` | "How much Bitcoin is quantum-vulnerable?", "What is the P2PK exposure?" |
| `get_liqmap` | "Where are the BTC liquidation clusters?", "Where would leveraged longs get liquidated?" |

All responses are JSON and carry a `generatedAt` timestamp plus a `source` URL to the human-readable page. Symbols accept both `BTCUSDT` and bare `BTC`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BYKARANTELI_API_KEY` | none | Account key (`bk_...`) sent as `Authorization: Bearer`. Free at <https://bykaranteli.com/dashboard/api>; required for programs from 2026-09-10 |
| `BYKARANTELI_BASE_URL` | `https://bykaranteli.com` | Override the API host (testing only) |

## Data notes

- The signal engine was retired in September 2026; this server publishes recorded market data only, no trading signals or performance claims.
- Funding, OI and pressure data refresh every 15 to 30 minutes; indices every 30 minutes.
- Nothing here is financial advice. See [bykaranteli.com/risk-guide](https://bykaranteli.com/risk-guide).

## Development

```bash
npm install
npm run build
node dist/index.js   # speaks MCP over stdio
```

## License

Server: MIT. Data: personal and research use with attribution "ByKaranteli (bykaranteli.com)"; commercial use with the Business plan. Licence text: <https://bykaranteli.com/data#license>.

## Plans and paid depth

| Plan | Price | Rate | Monthly | Depth |
|---|---|---|---|---|
| Free API | $0 | 30 / min | 15,000 | public pages |
| Terminal | $29 / mo | 60 / min | 150,000 | public pages |
| Builder | $49 / mo | 300 / min | 1,000,000 fair use | member depth, 1,000 x402 catalog calls a month |
| Business | $149 / mo | 1,200 / min | 3,000,000 fair use | member depth, commercial licence, 10,000 x402 catalog calls a month, monthly bulk |
| Scale | $399 / mo | 3,000 / min | 10,000,000 fair use | member depth, derived redistribution, x402 catalog with no ceiling, daily raw |

From 2026-10-01 a Free or Terminal key past its monthly figure gets 429 until
the month resets. A paid key past its fair use is never stopped: it answers at
the Free rate (30 a minute) until the month resets, with `x-quota-state: slow`
on every answer.

Full table: <https://bykaranteli.com/developers#tiers>. For recorded history and
raw records beyond the live snapshots, bykaranteli.com also exposes pay-per-call
x402 endpoints for anonymous agents (USDC on Solana or Base, priced per call,
no account): <https://bykaranteli.com/developers#x402> · machine catalog:
<https://bykaranteli.com/api/x402>. Builder keys call those routes unpaid up to
1,000 calls a month, Business up to 10,000, Scale with no ceiling; past the
allowance a key pays per call like an anonymous agent or moves up a plan.
