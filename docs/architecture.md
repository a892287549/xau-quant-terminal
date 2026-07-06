# XAU Quant Terminal Architecture

The terminal is organized around six product modules and matching API surfaces:

| Page | API root | Purpose |
| --- | --- | --- |
| Dashboard | `/api/dashboard` | 3-second trade readiness summary |
| Signal Center | `/api/signals` | Signal stream, detail, resonance matrix, performance |
| Macro Monitor | `/api/macro` | TIPS, FedWatch, COT, event calendar |
| Trade Center | `/api/trades` | Positions, closed trades, PnL, attribution, CSV export |
| Backtest Lab | `/api/backtests` | Parameters, run results, comparisons, Monte Carlo |
| Settings | `/api/settings` | API credentials metadata, risk, strategy, sessions, runtime |

Trading execution is disabled by default. Secrets belong on the server only and are not exposed to frontend payloads.

Current implementation details:

- Dashboard exposes a direct trade-readiness decision (`tradeDecision`) plus macro compass, active signals, positions, risk, and H1/H4/D candles with levels.
- Signal Center supports grade, direction, type, and date-range filtering, and every signal detail carries macro, technical, flow, and 3x4 resonance evidence.
- Macro Monitor surfaces countdown metadata for the next FOMC/NFP/CPI/PCE-style events.
- Trade Center supports direction/type/grade/date filtering, sorting, CSV export, PnL charts, heatmaps, and attribution.
- Backtest Lab returns core metrics, equity curve, monthly returns, drawdown windows, trade distribution, comparison deltas, and Monte Carlo runs.
- Settings persists non-secret configuration to `DATA_DIR/settings.json`; real secrets should be placed in server environment variables or a server-only `.env`.

Phase 2 data status:

- `api.dataMode` selects `mock` or `real` without changing frontend payload shapes.
- `server/data/okxAdapter.js` fetches OKX realtime ticker/candles for Dashboard, Signal Center, and Trade Center, and converts OKX millisecond timestamps to ISO timestamps. The default OKX instrument is the XAU USDT perpetual swap `XAU-USDT-SWAP`; override it with `OKX_INST_ID` if needed.
- `server/execution/okxExecutor.js` owns OKX perpetual execution. It submits `POST /api/v5/trade/order` market entries with `tdMode=cross` and optional `attachAlgoOrds` stop-loss payloads (`slTriggerPx`, `slOrdPx=-1`). Settings selects `demo` or `live`; demo points at `OKX_DEMO_API_BASE`, live points at `OKX_LIVE_API_BASE`.
- `server/data/oandaAdapter.js` is retained for OANDA Practice historical `XAU_USD` candles used by Backtest Lab; it reads credentials from server-side environment variables and discovers the account when `OANDA_ACCOUNT_ID` is omitted.
- `server/data/macroFetcher.js` caches macro snapshots in `DATA_DIR/macro-cache.json`, fetches Treasury 10-year real yield directly, CFTC gold COT directly, and keeps the static-page CME FedWatch parser with fallback when the page does not expose a parseable probability.
- Signal generation and backtest math use the local engine. Trade history remains simulated until OKX execution persistence is wired into `trades` and `positions`.
- `server/engine/sentinel.js` adds the 4H `structural_breakdown` sentinel signal. It scores structure, COT crowding, optional OKX trade-flow proxies, and uses independent weekly-anchor stops plus MA20(H4) trailing exits in backtests.

Phase 3-5 implementation status:

- `server/engine/` now owns macro scoring, technical signal detection, flow validation, and resonance grading. Dashboard and Signal Center use engine-generated signals with the existing frontend payload shape.
- PostgreSQL is available through compose and initializes `candles`, `macro_data`, `signals`, `trades`, `positions`, `backtest_runs`, `backtest_trades`, and `config`; `settings.json` remains a fallback when the database is unavailable.
- OKX realtime candles, OANDA historical candles, macro snapshots, signals, settings, and backtest runs are persisted when PostgreSQL is available.
- The full experiment matrix can be replayed with `npm run experiment:matrix`; groups 5 and 6 append the minimal/full `structural_breakdown` variants after the existing v2.0 groups.
- Backtests read H1 candles from PostgreSQL and replay the signal engine bar-by-bar with spread/slippage, Sharpe, MDD, win rate, Calmar, and 100-run Monte Carlo output.
- Trade execution remains disabled unless `api.broker=okx`, OKX credentials are present in server environment variables, and the relevant server-side switch is enabled: `OKX_DEMO_TRADING_ENABLED=true` for demo or `TRADING_ENABLED=true` for live.
