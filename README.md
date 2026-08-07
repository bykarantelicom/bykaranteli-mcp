# bykaranteli-mcp

MCP (Model Context Protocol) server for **live crypto derivatives data**: funding rates, cross-exchange funding arbitrage, open interest pressure, Fear & Greed, BTC dominance and a verified signal track record.

Backed by the free, no-auth public JSON API of [bykaranteli.com](https://bykaranteli.com/developers). No API key, no account, no rate-limit registration. Data covers Binance USDT-M perpetuals (funding arbitrage additionally compares OKX, Bybit, Gate, HTX and BingX).

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
