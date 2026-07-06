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
