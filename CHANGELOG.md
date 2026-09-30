# Changelog

Notable changes to the `bykaranteli-mcp` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC and come from the git tag of each release (the version commit where no tag exists). The tool count is the number of tools the server registers in that release.

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
