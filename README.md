# bykaranteli-mcp

MCP (Model Context Protocol) server for **live crypto derivatives data**: funding rates, cross-exchange funding arbitrage, open interest pressure, liquidations, options, ETF flows, Fear & Greed and BTC dominance.

67 read-only and account tools over the public JSON API of [bykaranteli.com](https://bykaranteli.com/developers): the market data tools only read, and the alert and watchlist tools act on your own account through your key ([Account tools](#account-tools-alerts-and-watchlist)). Since 2026-09-10 the API asks programs for an account key: a **free key** comes with any verified account at <https://bykaranteli.com/dashboard/api> (30 requests a minute and 15,000 a month, public depth), and the Builder, Business and Scale plans raise the rate and the monthly fair use and unlock member depth (LiqMap on seven timeframes, 5-minute series, the x402 catalog included in the monthly fair use). Set it as `BYKARANTELI_API_KEY`. Data covers Binance USDT-M perpetuals; funding arbitrage, liquidations, order book depth, options, positioning and insurance funds add the other venues each board lists on bykaranteli.com/coverage.

## Hosted endpoint (no install)

Paste `https://mcp.bykaranteli.com` as a custom connector in any MCP-capable
assistant. The same tools, nothing to install. Every tool call needs your
account key (free at <https://bykaranteli.com/dashboard/api>); connecting and
listing the tools work without one. The key travels one of three ways:

- the request header `x-api-key: bk_...` (claude.ai custom connectors, Cursor,
  Claude Code);
- the request header `Authorization: Bearer bk_...`;
- the address `https://mcp.bykaranteli.com/?key=bk_...` for clients that cannot
  send headers (ChatGPT). Treat that address like a password and revoke the key
  if it leaks.

Or sign in with OAuth 2.1 where the client offers it (claude.ai custom
connectors: Authentication, Sign in; ChatGPT connectors: OAuth): the client
registers itself (RFC 7591, PKCE S256), you approve it once on bykaranteli.com
and it runs on a key of your own account, which the Data and API page lists
under connected apps. Discovery:
<https://mcp.bykaranteli.com/.well-known/oauth-protected-resource>.

A free account covers the API and the hosted MCP on one monthly counter;
Builder and above bring higher rates and member depth.

Step-by-step guide for beginners: https://bykaranteli.com/guide/connect

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
| `get_solana_perps` | "Which Solana perp DEX has the most open interest? What is Pacifica's BTC funding and 24h volume? Phoenix SOL open interest? GM Trade versus Jupiter?" |
| `get_turkey_premium` | "What do lira buyers pay for bitcoin above the world price? What is the Turkey Premium Index and its score right now? Which Turkish exchange is dearest? What is USDT/TRY against the official rate?" |
| `get_data_proof` | "Can I verify a ByKaranteli number was not changed later? Show the on-chain proof for BTC funding right now. Which Solana transaction sealed the newest epoch?" |
| `get_cycle_indicators` | "Has the Pi Cycle crossed? Mayer Multiple and Puell today?" |
| `get_altseason` | "Is it altseason?", "What is the altcoin season index?" |
| `get_metric_context` | "Is today's funding extreme historically?", "Where does this reading sit in its distribution?" |
| `get_quantum_exposure` | "How much Bitcoin is quantum-vulnerable?", "What is the P2PK exposure?" |
| `get_liqmap` | "Where are the BTC liquidation clusters?", "Where would leveraged longs get liquidated?" |
| `get_market_profile` | "Where is the BTC point of control today?", "What was yesterday's value area?", "Which naked POCs are still untested?" |
| `get_options_chain` | "How did BTC open interest move by strike today?", "Where is ETH ATM IV hour by hour?", "Which expiry gained the most open interest in 24h?" |
| `get_hl_positions` | "Where do Hyperliquid whales get liquidated on BTC?", "How much tracked notional sits below price?", "Does the model agree with the tracked positions?" |
| `get_venue_share` | "Which exchange had the most liquidations this week?", "How is perp open interest split by venue?" |
| `get_tradfi_gaps` | "What did the TSLA perp do over the weekend?", "How big was the Monday open gap on NVDA?", "How far apart were the venues overnight?" |
| `get_series` | "BTC open interest by hour for the last week?", "ETH funding on OKX since 1 September?", "Daily Coinbase premium this month?" (metric list, units and finest periods: <https://bykaranteli.com/api/series/metrics>) |

All market answers are JSON and carry a `generatedAt` timestamp, a `source` URL to the human-readable page and a `provenance` block: `source_page`, `api_path`, the answer's own `generated_at`, `fetched_at`, and when the answer carries them the `venues` behind the number, `coverage` (`full`, `sampled` or `mixed`), `stale_venues` and `recorded_since`, plus the `proof` page (<https://bykaranteli.com/proof>). A field the answer does not carry is left out, never filled in. Symbols accept both `BTCUSDT` and bare `BTC`.

## Account tools (alerts and watchlist)

These tools read and change your own ByKaranteli account with the same key: the alert recipes that notify you on Telegram, email, push or webhook, and your watchlists. They never trade, move funds or touch another account.

| Tool | What it does |
|---|---|
| `parse_alert_text` | Turns "BTC funding above 0.05%" or "tell me when ETH drops 5% in a day" into the exact recipe, with a confidence and what the text left open. Rule based; saves nothing, never invents a threshold. |
| `list_alert_recipes` | Lists your alert recipes with their conditions, scope, channels and when each last fired. |
| `create_alert_recipe` | Saves an alert recipe (writes to your account). |
| `delete_alert_recipe` | Deletes one of your alert recipes by id (writes to your account). |
| `list_watchlists` | Lists your watchlists and the symbols on each. |
| `add_watchlist_symbol` | Adds a symbol to your default list or the list you name (writes to your account). |
| `remove_watchlist_symbol` | Removes a symbol from a list (writes to your account). |
| `list_tracked_addresses` | Lists the Hyperliquid addresses you follow, with their last positions (reads your account). |
| `add_tracked_address` | Follows a Hyperliquid address for position alerts (writes to your account; Terminal and above). |
| `remove_tracked_address` | Stops following an address (writes to your account). |

- The write tools carry `readOnlyHint: false` (and `destructiveHint: true` for the two that remove something), so clients that ask before a change will ask.
- How many recipes an account keeps follows its plan; past it, `create_alert_recipe` answers with the limit instead of saving.
- Every call counts on the key's plan like any other request; writes are also rate limited per key, and each write is recorded on the account with the key that made it.
- Recipes and watchlist changes show up at once on <https://bykaranteli.com/dashboard/alerts> and <https://bykaranteli.com/dashboard/watchlist>.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BYKARANTELI_API_KEY` | none | Account key (`bk_...`) sent as `Authorization: Bearer`. Free at <https://bykaranteli.com/dashboard/api>; required for programs from 2026-09-10 |
| `BYKARANTELI_BASE_URL` | `https://bykaranteli.com` | Override the API host (testing only). The key is sent to whatever host this names, so point it only at a server you trust. |

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

Release notes per version: [CHANGELOG.md](https://github.com/bykarantelicom/bykaranteli-mcp/blob/main/CHANGELOG.md).

## License

Server: MIT. Data: personal and research use with attribution "ByKaranteli (bykaranteli.com)"; commercial use with the Business plan. Licence text: <https://bykaranteli.com/data#license>.

## Plans and paid depth

| Plan | Rate | Monthly | Depth |
|---|---|---|---|
| Free API | 30 / min | 15,000 | public pages |
| Terminal | 60 / min | 150,000 | public pages |
| Builder | 300 / min | 1,000,000 fair use | member depth, x402 catalog included, each call counts as 10 requests of the monthly fair use |
| Business | 1,200 / min | 3,000,000 fair use | member depth, commercial licence, x402 catalog included, each call counts as 10 requests of the monthly fair use, monthly bulk |
| Scale | 3,000 / min | 10,000,000 fair use | member depth, derived redistribution, x402 catalog included, each call counts as 10 requests of the monthly fair use, daily raw |

Prices: https://bykaranteli.com/pricing

A Free or Terminal key past its monthly figure gets 429 until
the month resets. A paid key past its fair use is never stopped: it answers at
the Free rate (30 a minute) until the month resets, with `x-quota-state: slow`
on every answer.

Full table: <https://bykaranteli.com/developers#tiers>. For recorded history and
raw records beyond the live snapshots, bykaranteli.com also exposes pay-per-call
x402 endpoints for anonymous agents (USDC on Solana or Base, priced per call,
no account): <https://bykaranteli.com/developers#x402> · machine catalog:
<https://bykaranteli.com/api/x402>. Builder, Business and Scale keys call those
routes unpaid; each call counts as 10 requests of the monthly fair use.
