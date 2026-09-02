# bykaranteli-mcp

MCP (Model Context Protocol) server for **live crypto derivatives data**: funding rates, cross-exchange funding arbitrage, open interest pressure, Fear & Greed, BTC dominance and a verified signal track record.

34 read-only tools over the free, no-auth public JSON API of [bykaranteli.com](https://bykaranteli.com/developers). No API key, no account, no rate-limit registration. Data covers Binance USDT-M perpetuals (funding arbitrage additionally compares OKX, Bybit, Gate, HTX, BingX, Kraken, MEXC and Bitget).

## Hosted endpoint (no install)

Paste `https://mcp.bykaranteli.com` as a custom connector in any MCP-capable
assistant. Same 34 tools, nothing to install, no key.

## Quick start

### Claude Code

```bash
claude mcp add bykaranteli -- npx -y bykaranteli-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bykaranteli": {
      "command": "npx",
      "args": ["-y", "bykaranteli-mcp"]
    }
  }
}
```

### Cursor / other MCP clients

Any stdio MCP client works: command `npx`, args `["-y", "bykaranteli-mcp"]`.

Requires Node.js 18 or newer.

## Tools

| Tool | What it answers |
|---|---|
| `get_market_indices` | "What is the Fear & Greed index today?", "What is BTC dominance right now?" |
| `get_funding_heatmap` | "What are funding rates right now?", "What is SOL's funding?" |
| `get_funding_arbitrage` | "Any funding arb opportunities?", "Best venue to long/short BTC for carry?" |
| `get_pressure_scores` | "Which coins are over-leveraged / crowded right now?" |
| `get_top_movers` | "Biggest OI spikes today?", "Most extreme funding right now?" |
| `get_recent_signals` | "How did the signals do in the last 24h?" |
| `get_symbol_performance` | "Win rate on ETHUSDT over 90 days?" |
| `get_strategy_leaderboard` | "Which strategies are performing best?" |
| `get_liquidations` | "How much was liquidated today?", "Did longs or shorts get flushed this week?" |
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
| `get_lead_lag` | "Does Coinbase or Binance move first?" |
| `get_iv_surface` | "What is BTC implied vol by expiry?", "Is downside protection expensive (skew)?" |
| `get_whale_tape` | "Are whales buying or selling right now?" |
| `get_correlations` | "How correlated is SOL to BTC over 30 days?" |
| `get_new_listings` | "Which perpetuals were listed this week, and where first?" |
| `get_macro_liquidity` | "What is the Fed balance sheet / RRP / stablecoin supply doing?" |
| `get_network_health` | "Bitcoin hashrate, difficulty, fees, mempool right now?" |
| `get_tradfi_board` | "TSLA perp funding rate? Which exchanges list NVDA perps? Is the stock session open?" |
| `get_altseason` | "Is it altseason?", "What is the altcoin season index?" |
| `get_metric_context` | "Is today's funding extreme historically?", "Where does this reading sit in its distribution?" |
| `get_quantum_exposure` | "How much Bitcoin is quantum-vulnerable?", "What is the P2PK exposure?" |
| `get_liqmap` | "Where are the BTC liquidation clusters?", "Where would leveraged longs get liquidated?" |

All responses are JSON and carry a `generatedAt` timestamp plus a `source` URL to the human-readable page. Symbols accept both `BTCUSDT` and bare `BTC`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BYKARANTELI_BASE_URL` | `https://bykaranteli.com` | Override the API host (testing only) |

## Data notes

- Signal performance is a **live-only** track record: real published signals with SHA-256 receipts, evaluated net of fees, slippage and funding. Never backtests. Verify any signal at [bykaranteli.com/verify](https://bykaranteli.com/verify).
- Funding, OI and pressure data refresh every 15 to 30 minutes; indices every 30 minutes.
- Nothing here is financial advice. See [bykaranteli.com/risk-guide](https://bykaranteli.com/risk-guide).

## Development

```bash
npm install
npm run build
node dist/index.js   # speaks MCP over stdio
```

## License

MIT. Attribution appreciated: "ByKaranteli (bykaranteli.com)".

## Paid depth (optional)

The 34 tools above are free and stay free. For recorded history and raw records
beyond the live snapshots, bykaranteli.com also exposes pay-per-call x402
endpoints (USDC on Solana or Base, priced per call, no account):
<https://bykaranteli.com/developers#x402> · machine catalog:
<https://bykaranteli.com/api/x402>
