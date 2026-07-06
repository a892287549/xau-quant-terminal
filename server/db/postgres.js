import pg from "pg";

const { Pool } = pg;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candles (
  id BIGSERIAL PRIMARY KEY,
  instrument TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  time TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instrument, timeframe, time)
);
CREATE INDEX IF NOT EXISTS candles_lookup_idx ON candles (instrument, timeframe, time DESC);

CREATE TABLE IF NOT EXISTS macro_data (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  key TEXT NOT NULL,
  value NUMERIC,
  change NUMERIC,
  score INTEGER,
  bias TEXT,
  unit TEXT,
  source TEXT NOT NULL DEFAULT 'mixed',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, observed_at)
);
CREATE INDEX IF NOT EXISTS macro_data_lookup_idx ON macro_data (key, observed_at DESC);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  grade TEXT NOT NULL,
  direction TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  score NUMERIC NOT NULL,
  entry NUMERIC,
  stop NUMERIC,
  target NUMERIC,
  valid_until TIMESTAMPTZ,
  expires_in_minutes INTEGER,
  macro JSONB NOT NULL DEFAULT '{}'::jsonb,
  technical JSONB NOT NULL DEFAULT '[]'::jsonb,
  flow JSONB NOT NULL DEFAULT '[]'::jsonb,
  matrix JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_created_idx ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS signals_grade_direction_idx ON signals (grade, direction);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  size NUMERIC NOT NULL,
  entry NUMERIC NOT NULL,
  price NUMERIC,
  stop NUMERIC,
  pnl NUMERIC,
  pnl_pct NUMERIC,
  signal_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  type TEXT,
  entry NUMERIC NOT NULL,
  exit NUMERIC,
  size NUMERIC NOT NULL,
  pnl NUMERIC,
  r_multiple NUMERIC,
  signal_grade TEXT,
  status TEXT NOT NULL DEFAULT 'closed',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'closed';
CREATE INDEX IF NOT EXISTS trades_closed_idx ON trades (closed_at DESC);
CREATE INDEX IF NOT EXISTS trades_status_idx ON trades (status, created_at DESC);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  equity JSONB NOT NULL DEFAULT '[]'::jsonb,
  monthly_returns JSONB NOT NULL DEFAULT '[]'::jsonb,
  drawdown_windows JSONB NOT NULL DEFAULT '[]'::jsonb,
  trade_distribution JSONB NOT NULL DEFAULT '[]'::jsonb,
  monte_carlo JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  signal_id TEXT,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  direction TEXT NOT NULL,
  entry NUMERIC NOT NULL,
  exit NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  pnl NUMERIC NOT NULL,
  r_multiple NUMERIC,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backtest_trades_run_idx ON backtest_trades (run_id, opened_at);

CREATE TABLE IF NOT EXISTS execution_audit (
  id BIGSERIAL PRIMARY KEY,
  trade_id TEXT REFERENCES trades(id),
  signal_entry NUMERIC(12,2),
  actual_fill NUMERIC(12,2),
  slippage_pct NUMERIC(8,4),
  expected_stop NUMERIC(12,2),
  stop_order_id VARCHAR(64),
  stop_fill_price NUMERIC(12,2),
  stop_slippage_pct NUMERIC(8,4),
  fee NUMERIC(12,4),
  fee_asset VARCHAR(10),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_audit_trade_idx ON execution_audit (trade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_audit_created_idx ON execution_audit (created_at DESC);
`;

export function createDatabase() {
  const connectionString = process.env.DATABASE_URL || "";
  if (!connectionString) {
    return {
      enabled: false,
      async init() {},
      async query() {
        throw new Error("DATABASE_URL is not configured");
      },
      async close() {}
    };
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX || 6),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 2500),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000)
  });

  return {
    enabled: true,
    pool,
    async init() {
      await pool.query(SCHEMA_SQL);
    },
    async query(text, params) {
      return pool.query(text, params);
    },
    async close() {
      await pool.end();
    }
  };
}
