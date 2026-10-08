# Changelog

Notable changes to the `bykaranteli-mcp` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC and come from the git tag of each release (the version commit where no tag exists). The tool count is the number of tools the server registers in that release.

## [0.34.2] - 2026-10-08

67 tools.

### Changed

- Provenance `chart_url`: the venue asked for rides on the link as `v`, a bounded window (`to` plus `limit` bars, or `from` and `to`) as `r=from..to` in unix seconds, and the routes behind `get_liquidations`, `get_etf_flows` and `get_liquidation_cascades` (the dataset and incident routes) now have chart twins too; the liquidation twins open the recorded event marks (`rv=1`).
- `get_series`: the description says which periods stay member depth on a key (1m, 3m, 5m, 10m) and that the answer names the venue it was read from (`venue`) and every venue a market-wide series sums (`venues`).

## [0.34.1] - 2026-10-07

67 tools.

### Changed

- `get_series`: `period` accepts the sixteen bar periods the API serves since 2026-10-07 (1m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M); the package listed five. Periods under 15m stay member depth on a key.

## [0.34.0] - 2026-10-07

67 tools.

### Changed

- `get_series`: `metric` accepts `funding_agg`, the 8h funding rate weighted by open interest across every perp venue the 10-minute venue recorder reports (the SuperChart's all-venue funding pane); the description names it next to the single-venue `funding`.

## [0.33.0] - 2026-10-07

67 tools.

### Added

- Provenance: every answer whose route has a chart twin carries `chart_url` (the SuperChart address that opens on the same symbol, period and layers) and `chart_image_url` (a 1200 x 630 PNG of that view) next to `source_page` and `api_path`. Routes with a twin: series, the liquidation map and liquidation routes, options, funding and the funding heatmap, open interest, positioning, ETF flows and Hyperliquid whales.

## [0.32.0] - 2026-10-06

67 tools.

### Changed

- `get_etf_flows`: `asset` accepts `XRP` next to `BTC`, `ETH` and `SOL` and returns the US spot XRP ETF daily rows (net inflow, total net assets, cumulative inflow since launch, value traded, in USD). The description gives each asset's first day (BTC and ETH since 2025-05-20, SOL since 2025-10-28, XRP since 2026-09-08) instead of one history length for all.

## [0.31.0] - 2026-09-30

67 tools.

### Added

- `get_options_chain`: the option chain hour by hour from ByKaranteli's own capture of every listed venue: open interest and mark IV per expiry and strike, the change over 1h and 24h, the front expiry's ATM IV path.
- `get_hl_positions`: the liquidation price map of the largest Hyperliquid accounts per coin, with a comparison against the LiqMap model and an hourly archive.
- `get_venue_share`: each counted exchange's share of the recorded liquidations and of perpetual open interest over 1, 7 or 30 days.
- `get_tradfi_gaps`: stock, index and commodity perpetuals against the cash close over weekends and nights, checkpoint by checkpoint, with the realised open gap.
- Account tools for Hyperliquid address tracking (Terminal and above): `list_tracked_addresses`, `add_tracked_address`, `remove_tracked_address`.
- OAuth 2.1 sign-in on the hosted endpoint: the client registers itself, the user approves once, the token runs on the account's own key; the key path stays.

- `get_series`: the recorded series of one metric for one perpetual (price candles, volume, perp and spot CVD, open interest, funding, liquidations, long/short ratios, RSI, Coinbase premium, ETF flows, borrow rates, Hyperliquid whale net), by period, window (`from`, `to`) or newest bars, on another venue for price, OI, funding and borrow; `/api/series`, metric list at `/api/series/metrics`.
- Account tools that act on your own account with your key: `list_alert_recipes`, `create_alert_recipe`, `delete_alert_recipe`, `list_watchlists`, `add_watchlist_symbol`, `remove_watchlist_symbol`. The four that change something are annotated `readOnlyHint: false` (the two that remove, `destructiveHint: true`), count on the key's plan, are rate limited per key and recorded on the account; the plan's recipe limit comes back as the tool answer.
- `parse_alert_text`: a sentence such as "BTC funding above 0.05%" or "tell me when ETH drops 5% in a day" becomes the recipe it describes, with a confidence, a summary and what the text left open; rule based, saves nothing, never invents a threshold.
- A `provenance` block on every market answer: source page, API path, the answer's own timestamp, fetch time, and when the answer carries them the venues, `full`, `sampled` or `mixed` coverage, stale feeds and first recorded day, plus the proof page.

### Changed

- The README plan table leaves prices to <https://bykaranteli.com/pricing>, and the x402 catalog is included in the monthly fair use of Builder and above (each call counts as 10 requests) instead of a separate monthly allowance.

## [0.30.8] - 2026-09-30

52 tools.

### Added

- `get_market_profile`: the daily TPO Market Profile of a Binance USDT-M perpetual from ByKaranteli's own minute bars (point of control, 70% value area, first-hour initial balance, volume point of control, naked points of control of the last 60 recorded days, the latest day's profile per bucket); `/api/public/market-profile`.

## [0.30.7] - 2026-09-30

51 tools.

### Changed

- `get_options_snapshot` describes the per-expiry rows the API now returns (`expiries`: open interest by side, the max pain strike, the one-sigma implied move the ATM IV prices).

### Added

- This changelog ships inside the npm package, and the README links to it.

## [0.30.6] - 2026-09-30

51 tools.

### Fixed

- Source links of the IV surface, metric context, leverage tiers and open interest history tools point at pages that exist, and the options snapshot and options flow descriptions name the wall side, the single ATM strike and how multi-leg trades are netted.

## [0.30.5] - 2026-09-28

51 tools.

### Fixed

- `get_tokenized_stocks` accepts all twelve issuers, `get_solana_perps` passes the symbol as typed so mixed-case markets (kBONK, kPEPE, kSHIB) reach their history, and `get_turkey_premium` says KuCoin TR contributes the USDT pairs only.

## [0.30.4] - 2026-09-25

51 tools.

### Changed

- `get_solana_perps` covers six venues (Jupiter, Pacifica, Phoenix, GM Trade, Velocity, Bullet) with one-sided open interest and history on every venue but Jupiter.

## [0.30.3] - 2026-09-25

51 tools.

### Added

- `get_solana_perps`: the Solana Perps board with venues summed, every market and Pacifica hourly history.

## [0.30.2] - 2026-09-25

50 tools.

### Changed

- The hosted endpoint needs an account key; the README, the registry description and the remote header say so.

## [0.30.1] - 2026-09-24

50 tools.

### Changed

- `get_tokenized_stocks` describes `price_source` per wrapper and `totals.priced_by`.

## [0.30.0] - 2026-09-23

50 tools.

### Added

- `get_tokenized_stocks`: tokenized stock wrappers onchain and on exchanges.

## [0.29.0] - 2026-09-23

49 tools.

### Added

- `get_insurance_funds` (exchange insurance funds on Binance, Bybit, OKX and Gate) and a `venue` argument on `get_options_snapshot` (all, deribit, bybit, binance, okx, delta); `get_orderbook_depth` reports held-out books and venue wording no longer carries hand-written lists.

## [0.28.3] - 2026-09-20

48 tools.

### Added

- `get_liquidation_leaderboard`: the largest single liquidations over 24 hours, 7 days and 30 days, with a 30-day session heatmap.

## [0.28.2] - 2026-09-20

47 tools.

### Changed

- `get_positioning` names six venues (Gate, HTX and Bitget joined on 2026-09-20).

## [0.28.1] - 2026-09-20

47 tools.

### Fixed

- `get_pressure_scores` keeps the `byk_proof` reference in its slim output.

## [0.28.0] - 2026-09-18

47 tools.

### Added

- `get_data_proof`: onchain proofs of the BYK Data Layer on Solana and Base.

## [0.27.2] - 2026-09-17

46 tools.

### Changed

- The README lists `get_turkey_premium`, every description states the same tool count, and the `server.json` and Cursor plugin versions caught up with the package.

## [0.27.1] - 2026-09-17

46 tools. No git tag; the date is the version commit.

### Changed

- `get_turkey_premium` describes the Turkey Premium Index, its score and its regime.

## [0.27.0] - 2026-09-17

46 tools. No git tag; the date is the version commit.

### Added

- `get_turkey_premium`: TRY reference prices from eight Turkish venues and the premium in basis points.

## Earlier versions

Release notes for 0.26.3 and earlier are not recorded in this file; the git history and tags of this repository carry them.
