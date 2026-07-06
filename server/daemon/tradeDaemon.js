import { runSignalEngine } from "../engine/signalEngine.js";

const EXECUTABLE_GRADES = new Set(["S", "A", "B"]);
const HOUR_MS = 60 * 60 * 1000;

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function compactId(prefix, value = Date.now()) {
  return `${prefix}-${String(value).replace(/[^a-zA-Z0-9]/g, "").slice(-18)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isExecutableSignal(signal) {
  return EXECUTABLE_GRADES.has(signal?.grade)
    && ["LONG", "SHORT"].includes(signal?.direction)
    && Number.isFinite(Number(signal?.entry));
}

function sideForDirection(direction) {
  return direction === "LONG" ? "buy" : "sell";
}

function closeSideForDirection(direction) {
  return direction === "LONG" ? "sell" : "buy";
}

function directionSign(direction) {
  return direction === "SHORT" ? -1 : 1;
}

function startOfUtcDay(value = new Date()) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function startOfUtcWeek(value = new Date()) {
  const date = startOfUtcDay(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}

function isStopLossTrade(trade) {
  const reason = String(trade.exitReason || trade.payload?.exitReason || "").toLowerCase();
  return reason.includes("stop") || reason.includes("sl") || reason.includes("止损");
}

function avg(values = []) {
  const rows = values.map(Number).filter((value) => Number.isFinite(value));
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function ma(candles = [], period = 10) {
  const rows = candles.slice(-period);
  return rows.length >= period ? avg(rows.map((candle) => candle.close)) : null;
}

function positionType(position) {
  return position.type || position.payload?.signalType || "";
}

function hasPartialTakeProfit(position) {
  return Boolean(position.payload?.partialTpAt || position.payload?.partialClosedAt || position.status === "partial_closed");
}

function maxHoldHours(position) {
  const type = positionType(position);
  if (type === "fakeout") return 12 * 4;
  if (type === "breakout") return 24 * 4;
  if (type === "range_revert") return 18 * 4;
  if (type === "support_reversal") return 48;
  return 72;
}

function weeklyLossPct(history = [], initialBalance = 10000) {
  const week = startOfUtcWeek();
  const pnl = history
    .filter((trade) => trade.closedAt && new Date(trade.closedAt) >= week)
    .reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  return round(Math.max(0, -pnl) / Math.max(1, initialBalance) * 100);
}

function maxDrawdownPctFromTrades(history = [], initialBalance = 10000) {
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  const rows = [...history]
    .filter((trade) => trade.closedAt)
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  for (const trade of rows) {
    equity += Number(trade.pnl || 0);
    peak = Math.max(peak, equity);
    const drawdown = peak ? ((equity - peak) / peak) * 100 : 0;
    maxDrawdown = Math.min(maxDrawdown, drawdown);
  }
  return round(maxDrawdown, 2);
}

function dailyStopCount(history = []) {
  const today = startOfUtcDay();
  return history.filter((trade) => trade.closedAt && new Date(trade.closedAt) >= today && isStopLossTrade(trade)).length;
}

function inEventWindow(settings = {}, now = new Date()) {
  if (!settings?.risk?.eventCircuitBreaker) return false;
  const windows = settings?.daemon?.eventWindows || [];
  return windows.some((item) => {
    const eventAt = new Date(item.at || item.time || item);
    if (Number.isNaN(eventAt.getTime())) return false;
    return Math.abs(eventAt.getTime() - now.getTime()) <= 30 * 60 * 1000;
  });
}

function buildRiskSnapshot(settings = {}, history = []) {
  const initialBalance = Number(settings?.paper?.initialBalanceUsdt || 10000);
  const stoppedOutToday = dailyStopCount(history);
  const weeklyDrawdownPct = weeklyLossPct(history, initialBalance);
  const maxDailyStops = Number(settings?.risk?.maxDailyStops || 2);
  const weeklyPausePct = Number(settings?.risk?.weeklyDrawdownPausePct || settings?.risk?.weeklyCircuitLossPct || 15);
  const utcHour = new Date().getUTCHours();
  const lockedHours = settings?.risk?.noTradeUtcHours || [0, 1, 2, 3, 4, 5, 6, 7];
  const sessionLocked = lockedHours.includes(utcHour);
  const eventLocked = inEventWindow(settings);
  const reasons = [];
  if (stoppedOutToday >= maxDailyStops) reasons.push(`daily_stops_${stoppedOutToday}/${maxDailyStops}`);
  if (weeklyDrawdownPct >= weeklyPausePct) reasons.push(`weekly_drawdown_${weeklyDrawdownPct}%`);
  if (sessionLocked) reasons.push(`utc_hour_locked_${utcHour}`);
  if (eventLocked) reasons.push("event_window");
  return {
    canOpen: reasons.length === 0,
    reasons,
    stoppedOutToday,
    maxDailyStops,
    weeklyDrawdownPct,
    weeklyPausePct,
    sessionLocked,
    eventLocked
  };
}

function orderSizeFor(settings = {}) {
  const raw = Number(settings?.daemon?.orderSize || process.env.OKX_DEFAULT_ORDER_SIZE || 0.01);
  return Math.max(0.01, Math.floor(raw * 100) / 100).toFixed(2);
}

function tradeTypeStats(history = []) {
  const byType = new Map();
  for (const trade of history) {
    const type = trade.type || trade.payload?.signalType || "unknown";
    const item = byType.get(type) || { type, count: 0, pnl: 0, wins: 0, winRate: 0 };
    item.count += 1;
    item.pnl += Number(trade.pnl || 0);
    if (Number(trade.pnl || 0) > 0) item.wins += 1;
    byType.set(type, item);
  }
  return Array.from(byType.values()).map((item) => ({
    ...item,
    pnl: round(item.pnl),
    winRate: item.count ? round((item.wins / item.count) * 100) : 0
  }));
}

function byTypeMap(rows = []) {
  return new Map(rows.map((row) => [row.type, row]));
}

function deviationPct(expected, actual) {
  const base = Math.abs(Number(expected || 0));
  if (!base) return actual ? 100 : 0;
  return round((Math.abs(Number(actual || 0) - Number(expected || 0)) / base) * 100, 2);
}

function candidateTradeId(signal) {
  return `TRD-${signal.id || compactId("SIG")}`.slice(0, 64);
}

function orderResponse(order = {}) {
  return order.response || order.data?.[0] || order || {};
}

function fillPriceFromOrder(order, fallback) {
  const response = orderResponse(order);
  const parsed = Number(response.fillPx || response.avgPx || response.px || fallback);
  return Number.isFinite(parsed) ? parsed : null;
}

function feeFromOrder(order) {
  const response = orderResponse(order);
  const fee = Number(response.fee || response.fillFee || 0);
  return Number.isFinite(fee) ? fee : 0;
}

function feeAssetFromOrder(order) {
  const response = orderResponse(order);
  return response.feeCcy || response.fillFeeCcy || "USDT";
}

function slippagePct(expected, actual, direction) {
  const entry = Number(expected);
  const fill = Number(actual);
  if (!entry || !fill) return 0;
  return round(((fill - entry) / entry) * 100 * directionSign(direction), 4);
}

function stopOrderIdFromOrder(order) {
  const response = orderResponse(order);
  return response.algoId || response.ordId || response.clOrdId || "";
}

function shouldPartialTakeProfit(position, quote) {
  if (positionType(position) !== "fakeout" || hasPartialTakeProfit(position)) return false;
  const entry = Number(position.entry);
  const stop = Number(position.stop || position.payload?.stop);
  const current = Number(quote?.mid || position.price || entry);
  if (!entry || !stop || !current) return false;
  const r = Math.abs(entry - stop);
  const move = (current - entry) * directionSign(position.direction);
  return r > 0 && move >= r * 1.5;
}

function shouldTrailingClose(position, h4Candles = []) {
  if (positionType(position) !== "fakeout" || !hasPartialTakeProfit(position)) return false;
  const line = ma(h4Candles, 10);
  const close = Number(h4Candles.at(-1)?.close);
  if (!line || !close) return false;
  return position.direction === "LONG" ? close < line : close > line;
}

function shouldTimeout(position) {
  if (!position.openedAt) return false;
  const heldHours = (Date.now() - new Date(position.openedAt).getTime()) / HOUR_MS;
  return heldHours >= maxHoldHours(position);
}

export class TradeDaemon {
  constructor({
    getSettings,
    okxAdapter,
    okxExecutor,
    macroFetcher,
    storage,
    notifier = null
  }) {
    this.getSettings = getSettings;
    this.okx = okxAdapter;
    this.executor = okxExecutor;
    this.macroFetcher = macroFetcher;
    this.storage = storage;
    this.notifier = notifier;
    this.timer = null;
    this.running = false;
    this.lastScan = null;
    this.lastResult = null;
    this.notifiedSignals = new Set();
    this.notifiedRiskKeys = new Set();
    this.lastDailySummaryKey = "";
  }

  status() {
    return {
      running: Boolean(this.timer),
      scanning: this.running,
      lastScan: this.lastScan,
      lastResult: this.lastResult
    };
  }

  start() {
    if (this.timer) return;
    const boot = async () => {
      const settings = await this.getSettings();
      const daemon = settings?.daemon || {};
      if (!daemon.enabled) {
        console.log(`[${new Date().toISOString()}] trade daemon disabled`);
        return;
      }
      const intervalMs = Math.max(1, Number(daemon.scanIntervalMinutes || 5)) * 60 * 1000;
      this.timer = setInterval(() => this.scanOnce().catch((error) => this.logError(error)), intervalMs);
      setTimeout(() => this.scanOnce().catch((error) => this.logError(error)), 2500);
      console.log(`[${new Date().toISOString()}] trade daemon started interval=${intervalMs / 60000}m autoExecute=${Boolean(daemon.autoExecute)}`);
    };
    boot().catch((error) => this.logError(error));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  logError(error) {
    console.error(`[${new Date().toISOString()}] trade daemon error: ${error.message}`);
  }

  async fetchMarket() {
    const [h1, h4, daily, macro, quote] = await Promise.all([
      this.okx.getCandles({ timeframe: "H1", count: 300 }),
      this.okx.getCandles({ timeframe: "H4", count: 240 }),
      this.okx.getCandles({ timeframe: "D", count: 120 }),
      this.macroFetcher.getSnapshot(),
      this.okx.getPricing()
    ]);
    await Promise.allSettled([
      this.storage?.persistCandles?.({ instrument: this.okx.instrument, timeframe: "H1", candles: h1, source: "okx" }),
      this.storage?.persistCandles?.({ instrument: this.okx.instrument, timeframe: "H4", candles: h4, source: "okx" }),
      this.storage?.persistCandles?.({ instrument: this.okx.instrument, timeframe: "D", candles: daily, source: "okx" })
    ]);
    return { h1, h4, daily, macro, quote };
  }

  async scanOnce() {
    if (this.running) return this.lastResult;
    this.running = true;
    const startedAt = new Date().toISOString();
    try {
      const settings = await this.getSettings();
      const daemon = settings?.daemon || {};
      if (!daemon.enabled) {
        this.lastResult = { skipped: true, reason: "daemon_disabled", startedAt };
        return this.lastResult;
      }
      const autoExecute = Boolean(daemon.autoExecute);
      const market = await this.fetchMarket();
      const engine = runSignalEngine({
        candles: market.h1,
        macroSnapshot: market.macro,
        settings
      });
      await this.storage?.persistSignals?.(engine.signals);
      const signals = engine.signals.filter(isExecutableSignal);
      const openPositions = await this.storage?.getOpenTradePositions?.(50) || [];
      const history = await this.storage?.getTradeHistory?.(500) || [];
      const risk = buildRiskSnapshot(settings, history);
      const actions = [];
      let executed = 0;

      await this.notifyRiskIfNeeded(settings, risk);
      await this.maybeNotifyDailySummary(settings, history, openPositions);
      await this.maybeGenerateAcceptanceReport(settings, history);

      for (const position of openPositions) {
        const action = await this.planPositionManagement({ position, market, settings, autoExecute });
        if (action) {
          actions.push(action);
          if (action.executed) executed += 1;
        }
      }

      for (const signal of signals) {
        await this.notifySignalOnce(settings, signal);
        const action = await this.planSignalExecution({
          signal,
          openPositions,
          risk,
          settings,
          autoExecute
        });
        actions.push(action);
        if (action.executed) executed += 1;
      }

      this.lastScan = new Date().toISOString();
      this.lastResult = {
        startedAt,
        finishedAt: this.lastScan,
        dryRun: !autoExecute,
        signals: signals.length,
        executed,
        positions: openPositions.length,
        risk,
        actions
      };
      console.log(`[${this.lastScan}] 扫描完成，信号 ${signals.length} 个，执行 ${executed} 笔，持仓 ${openPositions.length} 个，mode=${autoExecute ? "execute" : "dry-run"}`);
      actions.slice(0, 8).forEach((action) => console.log(`[${this.lastScan}] daemon ${action.action}: ${action.reason || action.signalId || action.tradeId || ""}`));
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  async safeNotify(task) {
    if (!this.notifier) return;
    try {
      await task();
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] feishu notify failed: ${error.message}`);
    }
  }

  async notifySignalOnce(settings, signal) {
    if (this.notifiedSignals.has(signal.id)) return;
    this.notifiedSignals.add(signal.id);
    await this.safeNotify(() => this.notifier.notifySignal(settings, signal));
  }

  async notifyRiskIfNeeded(settings, risk) {
    if (risk.stoppedOutToday >= risk.maxDailyStops) {
      const key = `daily-${new Date().toISOString().slice(0, 10)}`;
      if (!this.notifiedRiskKeys.has(key)) {
        this.notifiedRiskKeys.add(key);
        await this.safeNotify(() => this.notifier.notifyDailyCircuit(settings, risk));
      }
    }
    if (risk.weeklyDrawdownPct >= risk.weeklyPausePct) {
      const key = `weekly-${startOfUtcWeek().toISOString().slice(0, 10)}`;
      if (!this.notifiedRiskKeys.has(key)) {
        this.notifiedRiskKeys.add(key);
        await this.safeNotify(() => this.notifier.notifyWeeklyDrawdown(settings, risk));
      }
    }
  }

  async maybeNotifyDailySummary(settings, history = [], openPositions = []) {
    const now = new Date();
    if (now.getUTCHours() !== 21) return;
    const key = now.toISOString().slice(0, 10);
    if (this.lastDailySummaryKey === key) return;
    this.lastDailySummaryKey = key;
    const today = startOfUtcDay(now);
    const week = startOfUtcWeek(now);
    const todayTrades = history.filter((trade) => trade.closedAt && new Date(trade.closedAt) >= today);
    const weekTrades = history.filter((trade) => trade.closedAt && new Date(trade.closedAt) >= week);
    const pnl = todayTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const weekPnl = weekTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const wins = todayTrades.filter((trade) => Number(trade.pnl || 0) > 0).length;
    const winRate = todayTrades.length ? Math.round((wins / todayTrades.length) * 100) : 0;
    await this.safeNotify(() => this.notifier.notifyDailySummary(settings, {
      trades: todayTrades.length,
      pnl,
      winRate,
      positions: openPositions.length,
      weekPnl
    }));
    await this.notifyDeviationIfNeeded(settings, history);
  }

  async notifyDeviationIfNeeded(settings, history = []) {
    const benchmark = await this.storage?.getBacktestSignalBenchmark?.();
    const expected = byTypeMap(benchmark?.byType || []);
    const actual = byTypeMap(tradeTypeStats(history));
    const expectedFakeout = expected.get("fakeout") || {};
    const actualFakeout = actual.get("fakeout") || {};
    const expectedBreakout = expected.get("breakout") || {};
    const actualBreakout = actual.get("breakout") || {};
    const expectedTotalPnl = (benchmark?.byType || []).reduce((sum, row) => sum + Number(row.pnl || 0), 0);
    const actualTotalPnl = history.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const deviations = [
      {
        label: "fakeout胜率",
        expected: round(expectedFakeout.winRate || 0),
        actual: round(actualFakeout.winRate || 0),
        deviationPct: deviationPct(expectedFakeout.winRate || 0, actualFakeout.winRate || 0),
        threshold: 30
      },
      {
        label: "breakout PnL",
        expected: round(expectedBreakout.pnl || 0),
        actual: round(actualBreakout.pnl || 0),
        deviationPct: deviationPct(expectedBreakout.pnl || 0, actualBreakout.pnl || 0),
        threshold: 30
      },
      {
        label: "总PnL",
        expected: round(expectedTotalPnl),
        actual: round(actualTotalPnl),
        deviationPct: deviationPct(expectedTotalPnl, actualTotalPnl),
        threshold: 20
      }
    ].filter((item) => item.deviationPct > item.threshold);
    if (deviations.length) {
      await this.safeNotify(() => this.notifier.notifyDeviationAlert(settings, deviations));
    }
  }

  async maybeGenerateAcceptanceReport(settings, history = []) {
    if (!this.storage?.enabled) return null;
    const key = "paper_observation";
    const existing = await this.storage.readConfig(key) || {};
    const startedAt = existing.startedAt || new Date().toISOString();
    if (!existing.startedAt) await this.storage.writeConfig(key, { ...existing, startedAt });
    if (existing.reportGeneratedAt) return existing.report;
    const elapsedMs = Date.now() - new Date(startedAt).getTime();
    if (elapsedMs < 14 * 24 * HOUR_MS) return null;
    const benchmark = await this.storage.getBacktestSignalBenchmark();
    const latestRun = (await this.storage.getBacktestRuns(1))[0] || {};
    const expected = byTypeMap(benchmark.byType || []);
    const actual = byTypeMap(tradeTypeStats(history));
    const expectedTotalPnl = (benchmark.byType || []).reduce((sum, row) => sum + Number(row.pnl || 0), 0);
    const actualTotalPnl = history.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const expectedTrades = (benchmark.byType || []).reduce((sum, row) => sum + Number(row.count || 0), 0);
    const actualDrawdown = maxDrawdownPctFromTrades(history, Number(settings?.paper?.initialBalanceUsdt || 10000));
    const expectedDrawdown = Number(latestRun.metrics?.maxDrawdown || 0);
    const rows = [
      this.reportRow("总PnL", expectedTotalPnl, actualTotalPnl, 20),
      this.reportRow("fakeout胜率", expected.get("fakeout")?.winRate || 0, actual.get("fakeout")?.winRate || 0, 30),
      this.reportRow("breakoutPnL", expected.get("breakout")?.pnl || 0, actual.get("breakout")?.pnl || 0, 30),
      this.reportRow("交易数", expectedTrades, history.length, 25),
      this.reportRow("最大回撤", Math.abs(expectedDrawdown), Math.abs(actualDrawdown), 30)
    ];
    const report = {
      startedAt,
      generatedAt: new Date().toISOString(),
      benchmarkRunId: benchmark.runId,
      rows,
      allPassed: rows.every((row) => row.pass)
    };
    await this.storage.writeConfig(key, {
      ...existing,
      startedAt,
      reportGeneratedAt: report.generatedAt,
      report
    });
    await this.safeNotify(() => this.notifier.notifyAcceptanceReport(settings, report));
    return report;
  }

  reportRow(metric, backtest, actual, threshold) {
    const deviation = deviationPct(backtest, actual);
    return {
      metric,
      backtest: round(backtest),
      actual: round(actual),
      deviationPct: deviation,
      pass: deviation <= threshold
    };
  }

  async planSignalExecution({ signal, openPositions, risk, settings, autoExecute }) {
    const same = openPositions.find((position) => position.direction === signal.direction);
    const opposite = openPositions.find((position) => position.direction !== signal.direction);
    if (same) {
      return {
        action: "skip_same_direction",
        signalId: signal.id,
        reason: same.id,
        executed: false
      };
    }
    if (!risk.canOpen) {
      return {
        action: "skip_risk",
        signalId: signal.id,
        reason: risk.reasons.join(","),
        executed: false
      };
    }
    if (opposite && !autoExecute) {
      return {
        action: "would_close_reverse_then_open",
        signalId: signal.id,
        tradeId: opposite.id,
        executed: false
      };
    }
    if (!autoExecute) {
      return {
        action: "would_open",
        signalId: signal.id,
        direction: signal.direction,
        grade: signal.grade,
        type: signal.type,
        entry: signal.entry,
        stop: signal.stop,
        size: orderSizeFor(settings),
        executed: false
      };
    }

    const guard = this.executor.guard(settings);
    if (!guard.ok) {
      return {
        action: "skip_execution_guard",
        signalId: signal.id,
        reason: guard.reason,
        executed: false
      };
    }
    if (opposite) {
      await this.executor.placePerpetualMarketOrder({
        side: closeSideForDirection(opposite.direction),
        size: opposite.size,
        clientOrderId: compactId("rev")
      }, settings);
      await this.storage.appendTradeEvent(opposite.id, { type: "reverse_close_requested", signalId: signal.id });
    }
    const order = await this.executor.placePerpetualMarketOrder({
      side: sideForDirection(signal.direction),
      size: orderSizeFor(settings),
      stopLossPrice: signal.stop,
      clientOrderId: compactId("open")
    }, settings);
    const tradeId = candidateTradeId(signal);
    await this.storage.createOpenTrade({
      id: tradeId,
      symbol: this.okx.instrument,
      direction: signal.direction,
      type: signal.type,
      entry: signal.entry,
      size: orderSizeFor(settings),
      stop: signal.stop,
      signalGrade: signal.grade,
      signalId: signal.id,
      payload: { signal, order }
    });
    const actualFill = fillPriceFromOrder(order, signal.entry);
    await this.storage.recordExecutionAudit?.({
      tradeId,
      signalEntry: signal.entry,
      actualFill,
      slippagePct: slippagePct(signal.entry, actualFill, signal.direction),
      expectedStop: signal.stop,
      actualStopOrderId: stopOrderIdFromOrder(order),
      stopFillPrice: null,
      stopSlippagePct: null,
      fee: feeFromOrder(order),
      feeAsset: feeAssetFromOrder(order),
      payload: { signalId: signal.id, order }
    });
    await this.safeNotify(() => this.notifier.notifyOpen(settings, {
      signal,
      size: orderSizeFor(settings),
      entry: signal.entry,
      stop: signal.stop
    }));
    return {
      action: "opened",
      signalId: signal.id,
      tradeId,
      executed: true
    };
  }

  async planPositionManagement({ position, market, settings, autoExecute }) {
    if (shouldPartialTakeProfit(position, market.quote)) {
      if (!autoExecute) {
        return { action: "would_partial_tp", tradeId: position.id, reason: "fakeout_1.5R", executed: false };
      }
      const result = await this.executor.closeHalfPosition(position.id, {
        storage: this.storage,
        settings
      });
      await this.safeNotify(() => this.notifier.notifyPartialTakeProfit(settings, {
        position,
        pnl: 0
      }));
      return { action: "partial_tp", tradeId: position.id, result, executed: true };
    }
    if (shouldTrailingClose(position, market.h4)) {
      if (!autoExecute) {
        return { action: "would_trailing_close", tradeId: position.id, reason: "MA10_H4_cross", executed: false };
      }
      const result = await this.executor.closePosition(position.id, {
        storage: this.storage,
        settings,
        reason: "trailing_stop",
        exitPrice: market.h4.at(-1)?.close
      });
      await this.safeNotify(() => this.notifier.notifyClose(settings, {
        position,
        pnl: result.pnl || 0,
        reason: "trailing_stop"
      }));
      return { action: "trailing_close", tradeId: position.id, result, executed: true };
    }
    if (shouldTimeout(position)) {
      if (!autoExecute) {
        return { action: "would_timeout_close", tradeId: position.id, reason: "max_hold_reached", executed: false };
      }
      const result = await this.executor.closePosition(position.id, {
        storage: this.storage,
        settings,
        reason: "timeout",
        exitPrice: market.quote?.mid || position.price
      });
      await this.safeNotify(() => this.notifier.notifyClose(settings, {
        position,
        pnl: result.pnl || 0,
        reason: "timeout"
      }));
      return { action: "timeout_close", tradeId: position.id, result, executed: true };
    }
    return null;
  }
}
