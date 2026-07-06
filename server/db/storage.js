function num(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candleFromRow(row) {
  return {
    t: row.time instanceof Date ? row.time.toISOString() : row.time,
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: num(row.close),
    volume: num(row.volume) || 0
  };
}

function signalFromRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    grade: row.grade,
    direction: row.direction,
    type: row.type,
    title: row.title,
    score: num(row.score),
    entry: num(row.entry),
    stop: num(row.stop),
    target: num(row.target),
    validUntil: row.valid_until instanceof Date ? row.valid_until.toISOString() : row.valid_until,
    expiresInMinutes: row.expires_in_minutes,
    macro: row.macro || {},
    technical: row.technical || [],
    flow: row.flow || [],
    matrix: row.matrix || []
  };
}

function tradeExitReason(row) {
  const payload = row.payload || {};
  return payload.exitReason
    || payload.reason
    || payload.closeReason
    || payload.exit_reason
    || payload.close_reason
    || payload.exit?.reason
    || row.status
    || "";
}

function tradeFromRow(row) {
  return {
    id: row.id,
    openedAt: row.opened_at instanceof Date ? row.opened_at.toISOString() : row.opened_at,
    closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at,
    symbol: row.symbol,
    direction: row.direction,
    type: row.type || row.payload?.signalType || "",
    entry: num(row.entry),
    exit: num(row.exit),
    size: num(row.size),
    pnl: num(row.pnl) || 0,
    rMultiple: num(row.r_multiple) || 0,
    signalGrade: row.signal_grade || row.payload?.signalGrade || "",
    status: row.status || "closed",
    signalId: row.payload?.signalId || row.payload?.signal_id || "",
    exitReason: tradeExitReason(row),
    payload: row.payload || {}
  };
}

function openPositionFromTradeRow(row) {
  const trade = tradeFromRow(row);
  const openedAt = trade.openedAt || row.created_at;
  const durationMinutes = openedAt ? Math.max(0, Math.round((Date.now() - new Date(openedAt).getTime()) / 60000)) : 0;
  return {
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    size: trade.size,
    entry: trade.entry,
    price: num(row.payload?.price) || trade.exit || trade.entry,
    stop: num(row.payload?.stop) || num(row.payload?.stopLossPrice) || null,
    pnl: trade.pnl,
    pnlPct: num(row.payload?.pnlPct) || 0,
    durationMinutes,
    type: trade.type,
    signalGrade: trade.signalGrade,
    signalId: trade.signalId,
    exitReason: trade.exitReason,
    openedAt: trade.openedAt,
    payload: trade.payload,
    status: trade.status
  };
}

function backtestRunFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    dataSource: "postgres-candles",
    params: row.params || {},
    metrics: row.metrics || {},
    equity: row.equity || [],
    monthlyReturns: row.monthly_returns || [],
    drawdownWindows: row.drawdown_windows || [],
    tradeDistribution: row.trade_distribution || [],
    monteCarlo: row.monte_carlo || []
  };
}

function executionAuditFromRow(row) {
  return {
    id: row.id,
    tradeId: row.trade_id,
    signalEntry: num(row.signal_entry),
    actualFill: num(row.actual_fill),
    slippagePct: num(row.slippage_pct) || 0,
    expectedStop: num(row.expected_stop),
    stopOrderId: row.stop_order_id || "",
    stopFillPrice: num(row.stop_fill_price),
    stopSlippagePct: num(row.stop_slippage_pct) || 0,
    fee: num(row.fee) || 0,
    feeAsset: row.fee_asset || "USDT",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    payload: row.payload || {}
  };
}

export class Storage {
  constructor(db) {
    this.db = db;
    this.available = Boolean(db?.enabled);
  }

  get enabled() {
    return Boolean(this.db?.enabled && this.available);
  }

  disable() {
    this.available = false;
  }

  async init() {
    if (!this.enabled) return false;
    await this.db.init();
    return true;
  }

  async readConfig(key) {
    if (!this.enabled) return null;
    const result = await this.db.query("SELECT value FROM config WHERE key = $1", [key]);
    return result.rows[0]?.value || null;
  }

  async writeConfig(key, value) {
    if (!this.enabled) return false;
    await this.db.query(
      `INSERT INTO config (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
    return true;
  }

  async persistCandles({ instrument = "XAU_USD", timeframe = "H1", candles = [], source = "oanda" }) {
    if (!this.enabled || !candles.length) return 0;
    if (candles.length > 500) {
      let total = 0;
      for (let index = 0; index < candles.length; index += 500) {
        total += await this.persistCandles({
          instrument,
          timeframe,
          candles: candles.slice(index, index + 500),
          source
        });
      }
      return total;
    }
    const values = [];
    const placeholders = candles.map((candle, index) => {
      const base = index * 8;
      values.push(instrument, timeframe, candle.t, candle.open, candle.high, candle.low, candle.close, candle.volume || 0);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, '${source.replace(/'/g, "''")}')`;
    });
    await this.db.query(
      `INSERT INTO candles (instrument, timeframe, time, open, high, low, close, volume, source)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (instrument, timeframe, time) DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         volume = EXCLUDED.volume,
         source = EXCLUDED.source`,
      values
    );
    return candles.length;
  }

  async getCandles({ instrument = "XAU_USD", timeframe = "H1", from, to, limit = 1000 } = {}) {
    if (!this.enabled) return [];
    const params = [instrument, timeframe];
    const filters = ["instrument = $1", "timeframe = $2"];
    if (from) {
      params.push(from);
      filters.push(`time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      filters.push(`time <= $${params.length}`);
    }
    params.push(limit);
    const result = await this.db.query(
      `SELECT time, open, high, low, close, volume
       FROM candles
       WHERE ${filters.join(" AND ")}
       ORDER BY time DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.reverse().map(candleFromRow);
  }

  async persistMacroSnapshot(snapshot) {
    if (!this.enabled || !snapshot?.factors?.length) return 0;
    const observedAt = snapshot.updatedAt || new Date().toISOString();
    for (const item of snapshot.factors) {
      await this.db.query(
        `INSERT INTO macro_data (observed_at, key, value, change, score, bias, unit, source, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (key, observed_at) DO UPDATE SET
           value = EXCLUDED.value,
           change = EXCLUDED.change,
           score = EXCLUDED.score,
           bias = EXCLUDED.bias,
           unit = EXCLUDED.unit,
           source = EXCLUDED.source,
           payload = EXCLUDED.payload`,
        [
          observedAt,
          item.key,
          item.value,
          item.change || 0,
          item.score,
          item.bias,
          item.unit || "",
          snapshot.sources ? "mixed" : "mock",
          JSON.stringify(item)
        ]
      );
    }
    return snapshot.factors.length;
  }

  async persistSignals(signals = []) {
    if (!this.enabled || !signals.length) return 0;
    for (const signal of signals) {
      await this.db.query(
        `INSERT INTO signals (
          id, created_at, grade, direction, type, title, score, entry, stop, target,
          valid_until, expires_in_minutes, macro, technical, flow, matrix, payload, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          grade = EXCLUDED.grade,
          direction = EXCLUDED.direction,
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          score = EXCLUDED.score,
          entry = EXCLUDED.entry,
          stop = EXCLUDED.stop,
          target = EXCLUDED.target,
          valid_until = EXCLUDED.valid_until,
          expires_in_minutes = EXCLUDED.expires_in_minutes,
          macro = EXCLUDED.macro,
          technical = EXCLUDED.technical,
          flow = EXCLUDED.flow,
          matrix = EXCLUDED.matrix,
          payload = EXCLUDED.payload,
          updated_at = now()`,
        [
          signal.id,
          signal.createdAt,
          signal.grade,
          signal.direction,
          signal.type,
          signal.title,
          signal.score,
          signal.entry,
          signal.stop,
          signal.target,
          signal.validUntil,
          signal.expiresInMinutes,
          JSON.stringify(signal.macro || {}),
          JSON.stringify(signal.technical || []),
          JSON.stringify(signal.flow || []),
          JSON.stringify(signal.matrix || []),
          JSON.stringify(signal)
        ]
      );
    }
    return signals.length;
  }

  async getSignals(limit = 100) {
    if (!this.enabled) return [];
    const result = await this.db.query(
      `SELECT * FROM signals ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(signalFromRow);
  }

  async getOpenTradePositions(limit = 20) {
    if (!this.enabled) return [];
    const result = await this.db.query(
      `SELECT *
       FROM trades
       WHERE status IN ('open', 'partial_closed')
       ORDER BY COALESCE(opened_at, created_at) DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(openPositionFromTradeRow);
  }

  async getTradeById(id) {
    if (!this.enabled || !id) return null;
    const result = await this.db.query(
      `SELECT * FROM trades WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] ? tradeFromRow(result.rows[0]) : null;
  }

  async createOpenTrade({
    id,
    openedAt = new Date().toISOString(),
    symbol = "XAU-USDT-SWAP",
    direction,
    type = "",
    entry,
    size,
    stop = null,
    signalGrade = "",
    signalId = "",
    payload = {}
  } = {}) {
    if (!this.enabled || !id) return false;
    await this.db.query(
      `INSERT INTO trades (
        id, opened_at, symbol, direction, type, entry, size, signal_grade, status, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [
        id,
        openedAt,
        symbol,
        direction,
        type,
        entry,
        size,
        signalGrade,
        JSON.stringify({
          ...payload,
          signalId,
          signalGrade,
          stop,
          events: payload.events || []
        })
      ]
    );
    return true;
  }

  async updateTrade(id, patch = {}) {
    if (!this.enabled || !id) return false;
    const fields = [];
    const values = [];
    const allowed = {
      closedAt: "closed_at",
      exit: "exit",
      size: "size",
      pnl: "pnl",
      rMultiple: "r_multiple",
      status: "status",
      payload: "payload"
    };
    for (const [key, column] of Object.entries(allowed)) {
      if (!(key in patch)) continue;
      values.push(key === "payload" ? JSON.stringify(patch[key] || {}) : patch[key]);
      fields.push(`${column} = $${values.length}${key === "payload" ? "::jsonb" : ""}`);
    }
    if (!fields.length) return false;
    values.push(id);
    await this.db.query(
      `UPDATE trades SET ${fields.join(", ")} WHERE id = $${values.length}`,
      values
    );
    return true;
  }

  async appendTradeEvent(id, event = {}) {
    if (!this.enabled || !id) return false;
    const trade = await this.getTradeById(id);
    if (!trade) return false;
    const payload = trade.payload || {};
    const events = Array.isArray(payload.events) ? payload.events : [];
    await this.updateTrade(id, {
      payload: {
        ...payload,
        events: [
          ...events,
          {
            at: new Date().toISOString(),
            ...event
          }
        ]
      }
    });
    return true;
  }

  async recordExecutionAudit(record = {}) {
    if (!this.enabled) return false;
    await this.db.query(
      `INSERT INTO execution_audit (
        trade_id, signal_entry, actual_fill, slippage_pct, expected_stop,
        stop_order_id, stop_fill_price, stop_slippage_pct, fee, fee_asset, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        record.tradeId || null,
        record.signalEntry ?? null,
        record.actualFill ?? null,
        record.slippagePct ?? null,
        record.expectedStop ?? null,
        record.actualStopOrderId || record.stopOrderId || "",
        record.stopFillPrice ?? null,
        record.stopSlippagePct ?? null,
        record.fee ?? null,
        record.feeAsset || "USDT",
        JSON.stringify(record.payload || record)
      ]
    );
    return true;
  }

  async getExecutionAudit(limit = 20) {
    if (!this.enabled) return [];
    const result = await this.db.query(
      `SELECT *
       FROM execution_audit
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(executionAuditFromRow);
  }

  async getBacktestSignalBenchmark() {
    if (!this.enabled) return { runId: "", byType: [] };
    const run = await this.db.query(
      `SELECT id FROM backtest_runs ORDER BY created_at DESC LIMIT 1`
    );
    const runId = run.rows[0]?.id || "";
    if (!runId) return { runId: "", byType: [] };
    const result = await this.db.query(
      `WITH typed AS (
        SELECT
          CASE
            WHEN signal_id LIKE '%-fakeout-%' THEN 'fakeout'
            WHEN signal_id LIKE '%-breakout-%' THEN 'breakout'
            WHEN signal_id LIKE '%-support_reversal-%' THEN 'support_reversal'
            WHEN signal_id LIKE '%-structural_breakdown-%' THEN 'structural_breakdown'
            ELSE COALESCE(payload->>'type', 'unknown')
          END AS type,
          pnl
        FROM backtest_trades
        WHERE run_id = $1
      )
      SELECT
        type,
        COUNT(*)::int AS count,
        COALESCE(SUM(pnl), 0) AS pnl,
        COALESCE(AVG(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100, 0) AS win_rate
      FROM typed
      GROUP BY type
      ORDER BY count DESC`,
      [runId]
    );
    return {
      runId,
      byType: result.rows.map((row) => ({
        type: row.type,
        count: Number(row.count || 0),
        pnl: num(row.pnl) || 0,
        winRate: num(row.win_rate) || 0
      }))
    };
  }

  async getDataHealthSnapshot() {
    if (!this.enabled) return null;
    const candles = await this.db.query(
      `SELECT MAX(time) AS latest
       FROM candles
       WHERE timeframe = 'H1' AND instrument LIKE 'XAU%'`
    );
    const macro = await this.db.query(
      `SELECT key, MAX(observed_at) AS latest
       FROM macro_data
       WHERE key IN ('tips', 'cot')
       GROUP BY key`
    );
    return {
      candlesH1Latest: candles.rows[0]?.latest instanceof Date ? candles.rows[0].latest.toISOString() : candles.rows[0]?.latest || null,
      macroLatest: Object.fromEntries(macro.rows.map((row) => [
        row.key,
        row.latest instanceof Date ? row.latest.toISOString() : row.latest
      ]))
    };
  }

  async getTradeHistory(limit = 200) {
    if (!this.enabled) return [];
    const result = await this.db.query(
      `SELECT *
       FROM trades
       WHERE status <> 'open'
       ORDER BY COALESCE(closed_at, created_at) DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(tradeFromRow);
  }

  async getBacktestRuns(limit = 10) {
    if (!this.enabled) return [];
    const result = await this.db.query(
      `SELECT *
       FROM backtest_runs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(backtestRunFromRow);
  }

  async persistBacktestRun(run, trades = []) {
    if (!this.enabled || !run?.id) return false;
    await this.db.query(
      `INSERT INTO backtest_runs (
        id, name, created_at, params, metrics, equity, monthly_returns,
        drawdown_windows, trade_distribution, monte_carlo
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        params = EXCLUDED.params,
        metrics = EXCLUDED.metrics,
        equity = EXCLUDED.equity,
        monthly_returns = EXCLUDED.monthly_returns,
        drawdown_windows = EXCLUDED.drawdown_windows,
        trade_distribution = EXCLUDED.trade_distribution,
        monte_carlo = EXCLUDED.monte_carlo`,
      [
        run.id,
        run.name,
        run.createdAt,
        JSON.stringify(run.params || {}),
        JSON.stringify(run.metrics || {}),
        JSON.stringify(run.equity || []),
        JSON.stringify(run.monthlyReturns || []),
        JSON.stringify(run.drawdownWindows || []),
        JSON.stringify(run.tradeDistribution || []),
        JSON.stringify(run.monteCarlo || [])
      ]
    );
    for (const trade of trades) {
      await this.db.query(
        `INSERT INTO backtest_trades (
          run_id, signal_id, opened_at, closed_at, direction, entry, exit, size, pnl, r_multiple, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          run.id,
          trade.signalId || null,
          trade.openedAt,
          trade.closedAt,
          trade.direction,
          trade.entry,
          trade.exit,
          trade.size,
          trade.pnl,
          trade.rMultiple,
          JSON.stringify(trade)
        ]
      );
    }
    return true;
  }
}
