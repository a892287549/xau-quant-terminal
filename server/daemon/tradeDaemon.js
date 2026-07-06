import { runSignalEngine } from "../engine/signalEngine.js";
import { logger } from "../logger.js";

const EXECUTABLE_GRADES = new Set(["S", "A", "B"]);
const HOUR_MS = 60 * 60 * 1000;

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function floorLot(value, step = 0.01) {
  const unit = Number(step || 0.01);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(unit) || unit <= 0) return 0;
  return Math.floor(value / unit) * unit;
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

function isPaperExecution(settings = {}) {
  return settings?.api?.tradeMode !== "live";
}

function quotePrice(market = {}, fallback = null) {
  const value = Number(market.quote?.mid || market.quote?.last || fallback);
  return Number.isFinite(value) ? value : null;
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

function realizedPnl(history = []) {
  return history
    .filter((trade) => trade.closedAt)
    .reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
}

function gradeRiskMultiplier(grade) {
  return {
    S: 1.5,
    A: 1,
    B: 0.5,
    C: 0.25
  }[String(grade || "B").toUpperCase()] || 0.5;
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

function inEventWindow(settings = {}, now = new Date(), eventSnapshot = null) {
  if (!settings?.risk?.eventCircuitBreaker) return false;
  if (eventSnapshot?.active) return eventSnapshot.active;
  const windows = settings?.daemon?.eventWindows || [];
  return windows.find((item) => {
    const eventAt = new Date(item.at || item.time || item);
    if (Number.isNaN(eventAt.getTime())) return null;
    return Math.abs(eventAt.getTime() - now.getTime()) <= 30 * 60 * 1000;
  }) || null;
}

export function buildRiskSnapshot(settings = {}, history = [], eventSnapshot = null) {
  const initialBalance = Number(settings?.paper?.initialBalanceUsdt || 10000);
  const closedPnl = realizedPnl(history);
  const equity = initialBalance + closedPnl;
  const stoppedOutToday = dailyStopCount(history);
  const weeklyDrawdownPct = weeklyLossPct(history, initialBalance);
  const maxDailyStops = Number(settings?.risk?.maxDailyStops || 2);
  const weeklyPausePct = Number(settings?.risk?.weeklyDrawdownPausePct || settings?.risk?.weeklyCircuitLossPct || 15);
  const utcHour = new Date().getUTCHours();
  const lockedHours = settings?.risk?.noTradeUtcHours || [0, 1, 2, 3, 4, 5, 6, 7];
  const sessionLocked = lockedHours.includes(utcHour);
  const eventWindow = inEventWindow(settings, new Date(), eventSnapshot);
  const eventLocked = Boolean(eventWindow);
  const reasons = [];
  if (stoppedOutToday >= maxDailyStops) reasons.push(`daily_stops_${stoppedOutToday}/${maxDailyStops}`);
  if (weeklyDrawdownPct >= weeklyPausePct) reasons.push(`weekly_drawdown_${weeklyDrawdownPct}%`);
  if (sessionLocked) reasons.push(`utc_hour_locked_${utcHour}`);
  if (eventLocked) reasons.push(`event_window_${eventWindow.code || eventWindow.name || "manual"}`);
  return {
    canOpen: reasons.length === 0,
    reasons,
    stoppedOutToday,
    maxDailyStops,
    weeklyDrawdownPct,
    weeklyPausePct,
    sessionLocked,
    eventLocked,
    eventWindow,
    eventCalendar: {
      enabled: eventSnapshot?.enabled ?? null,
      fetchedAt: eventSnapshot?.fetchedAt || null,
      lastError: eventSnapshot?.lastError || "",
      events: eventSnapshot?.events?.length || 0
    },
    initialBalance,
    realizedPnl: round(closedPnl),
    equity: round(equity)
  };
}

export function orderSizeFor(settings = {}, signal = {}, risk = {}) {
  if (settings?.daemon?.useFixedOrderSize && settings?.daemon?.orderSize) {
    const raw = Number(settings.daemon.orderSize || process.env.OKX_DEFAULT_ORDER_SIZE || 0.01);
    return Math.max(0.01, Math.floor(raw * 100) / 100).toFixed(2);
  }
  const entry = Number(signal.entry);
  const stop = Number(signal.stop);
  const stopDistance = Math.abs(entry - stop);
  const equity = Number(risk.equity || settings?.paper?.initialBalanceUsdt || 10000);
  const riskPct = Number(settings?.risk?.perTradeRiskPct || 2) / 100;
  const pnlMultiplier = Number(settings?.daemon?.pnlMultiplier || process.env.OKX_PNL_MULTIPLIER || 100);
  const minOrderSize = Number(settings?.daemon?.minOrderSize || process.env.OKX_MIN_ORDER_SIZE || 0.01);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || stopDistance <= 0 || equity <= 0) {
    return Math.max(minOrderSize, floorLot(Number(process.env.OKX_DEFAULT_ORDER_SIZE || 0.01), minOrderSize)).toFixed(2);
  }
  const riskAmount = equity * riskPct * gradeRiskMultiplier(signal.grade);
  const raw = riskAmount / Math.max(0.01, stopDistance * pnlMultiplier);
  return Math.max(minOrderSize, floorLot(raw, minOrderSize)).toFixed(2);
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
  const parsed = Number(order?.fill?.fillPx || response.fillPx || response.avgPx || response.px || fallback);
  return Number.isFinite(parsed) ? parsed : null;
}

function feeFromOrder(order) {
  const response = orderResponse(order);
  const fee = Number(order?.fill?.fee || response.fee || response.fillFee || 0);
  return Number.isFinite(fee) ? fee : 0;
}

function feeAssetFromOrder(order) {
  const response = orderResponse(order);
  return order?.fill?.feeCcy || response.feeCcy || response.fillFeeCcy || "USDT";
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

function orderIdFromOrder(order = {}) {
  const response = orderResponse(order);
  return response.ordId || "";
}

function clientOrderIdFromOrder(order = {}) {
  const response = orderResponse(order);
  return response.clOrdId || order.request?.clOrdId || "";
}

function partialTakeProfitR(position, settings = {}) {
  const type = positionType(position);
  if (type === "fakeout") return Number(settings?.strategy?.exitRules?.fakeoutTp1R || 1.5);
  if (type === "support_reversal") return Number(settings?.risk?.supportReversalTp1R || 2);
  return 0;
}

export function partialTargetForSignal(signal = {}, actualEntry = null, size = 0, settings = {}) {
  const type = signal.type || signal.signalType || "";
  const fakeoutEnabled = Boolean(settings?.strategy?.exitRules?.fakeoutPartialTP);
  if (type === "fakeout" && !fakeoutEnabled) return null;
  if (!["fakeout", "support_reversal"].includes(type)) return null;
  if (!["LONG", "SHORT"].includes(signal.direction)) return null;
  const entry = Number(actualEntry || signal.entry);
  const stop = Number(signal.stop);
  const totalSize = Number(size);
  const r = Math.abs(entry - stop);
  const takeProfitR = type === "fakeout"
    ? Number(settings?.strategy?.exitRules?.fakeoutTp1R || 1.5)
    : Number(settings?.risk?.supportReversalTp1R || 2);
  const minOrderSize = Number(settings?.daemon?.minOrderSize || process.env.OKX_MIN_ORDER_SIZE || 0.01);
  const targetSize = floorLot(totalSize / 2, minOrderSize);
  const remainingSize = floorLot(totalSize - targetSize, minOrderSize);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(totalSize) || r <= 0 || takeProfitR <= 0) return null;
  if (targetSize < minOrderSize || remainingSize < minOrderSize) return null;
  return {
    type,
    reason: `${type}_${takeProfitR}R`,
    r: takeProfitR,
    side: closeSideForDirection(signal.direction),
    price: round(entry + directionSign(signal.direction) * r * takeProfitR, 2),
    size: targetSize.toFixed(2),
    remainingSize: remainingSize.toFixed(2)
  };
}

function paperOrder({ side, size, price, stop = null, clientOrderId, orderType = "market", state = "filled", reason = "paper" } = {}) {
  const clOrdId = clientOrderId || compactId("paper");
  const ordId = compactId("paperord");
  const fillPx = Number(price);
  return {
    mode: "paper",
    paper: true,
    request: {
      side,
      size: String(size),
      ordType: orderType,
      px: Number.isFinite(fillPx) ? fillPx : null,
      stopLossPrice: stop,
      clOrdId
    },
    response: {
      ordId,
      clOrdId,
      state,
      reason
    },
    fill: {
      confirmed: state === "filled",
      state,
      ordId,
      clOrdId,
      fillPx: Number.isFinite(fillPx) ? fillPx : null,
      accFillSz: Number(size || 0),
      fee: 0,
      feeCcy: "USDT",
      raw: { paper: true, reason }
    }
  };
}

function paperClosePnl(trade = {}, fill, size, settings = {}) {
  const price = Number(fill);
  const entry = Number(trade.entry);
  const amount = Number(size || trade.size || 0);
  const pnlMultiplier = Number(settings?.daemon?.pnlMultiplier || process.env.OKX_PNL_MULTIPLIER || 100);
  if (!Number.isFinite(price) || !Number.isFinite(entry)) return Number(trade.pnl || 0);
  return (price - entry) * directionSign(trade.direction) * amount * pnlMultiplier;
}

function shouldPartialTakeProfit(position, quote, settings = {}) {
  const takeProfitR = partialTakeProfitR(position, settings);
  if (!takeProfitR || hasPartialTakeProfit(position)) return false;
  const entry = Number(position.entry);
  const stop = Number(position.stop || position.payload?.stop);
  const current = Number(quote?.mid || position.price || entry);
  if (!entry || !stop || !current) return false;
  const r = Math.abs(entry - stop);
  const move = (current - entry) * directionSign(position.direction);
  return r > 0 && move >= r * takeProfitR;
}

function shouldStopLoss(position, quote) {
  const stop = Number(position.stop || position.payload?.stop);
  const current = Number(quote?.mid || quote?.last || position.price);
  if (!Number.isFinite(stop) || !Number.isFinite(current)) return false;
  return position.direction === "LONG" ? current <= stop : current >= stop;
}

function trailingPeriod(position, settings = {}) {
  const type = positionType(position);
  if (type === "fakeout") return Number(settings?.strategy?.exitRules?.fakeoutTrailingMaPeriod || 10);
  if (type === "support_reversal") return 20;
  return 0;
}

function shouldTrailingClose(position, h4Candles = [], settings = {}) {
  if (!hasPartialTakeProfit(position)) return false;
  const period = trailingPeriod(position, settings);
  if (!period) return false;
  const line = ma(h4Candles, period);
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
    notifier = null,
    broadcaster = null,
    dataHealthMonitor = null,
    eventCalendar = null
  }) {
    this.getSettings = getSettings;
    this.okx = okxAdapter;
    this.executor = okxExecutor;
    this.macroFetcher = macroFetcher;
    this.storage = storage;
    this.notifier = notifier;
    this.broadcaster = broadcaster;
    this.dataHealthMonitor = dataHealthMonitor;
    this.eventCalendar = eventCalendar;
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
        logger.info({ module: "tradeDaemon" }, "trade daemon disabled");
        return;
      }
      const intervalMs = Math.max(1, Number(daemon.scanIntervalMinutes || 5)) * 60 * 1000;
      this.timer = setInterval(() => this.scanOnce().catch((error) => this.logError(error)), intervalMs);
      setTimeout(() => this.scanOnce().catch((error) => this.logError(error)), 2500);
      logger.info({
        module: "tradeDaemon",
        scanIntervalMinutes: intervalMs / 60000,
        autoExecute: Boolean(daemon.autoExecute)
      }, "trade daemon started");
    };
    boot().catch((error) => this.logError(error));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  logError(error) {
    logger.error({ module: "tradeDaemon", error: error.message }, "trade daemon error");
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
      const eventSnapshot = await this.eventCalendar?.getSnapshot?.(settings);
      const risk = buildRiskSnapshot(settings, history, eventSnapshot);
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
          const action = await this.planSignalExecution({
            signal,
            openPositions,
            risk,
            settings,
            autoExecute,
            market
          });
        if (["would_open", "opened", "would_close_reverse_then_open"].includes(action.action)) {
          await this.notifySignalOnce(settings, signal);
        }
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
      this.broadcast("signal", signals);
      this.broadcast("position", openPositions);
      this.broadcast("risk", risk);
      logger.info({
        module: "tradeDaemon",
        signals: signals.length,
        executed,
        positions: openPositions.length,
        mode: autoExecute ? "execute" : "dry-run",
        riskReasons: risk.reasons
      }, "scan completed");
      actions.slice(0, 8).forEach((action) => logger.info({
        module: "tradeDaemon",
        action: action.action,
        tradeId: action.tradeId,
        signalId: action.signalId,
        reason: action.reason
      }, "daemon action"));
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  broadcast(type, data) {
    try {
      this.broadcaster?.broadcast?.(type, data);
    } catch (error) {
      logger.warn({ module: "tradeDaemon", type, error: error.message }, "websocket broadcast failed");
    }
  }

  async safeNotify(task) {
    if (!this.notifier) return;
    try {
      await task();
    } catch (error) {
      logger.warn({ module: "tradeDaemon", error: error.message }, "feishu notify failed");
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

  async paperClosePosition(positionId, { settings = {}, reason = "closed", exitPrice = null } = {}) {
    const trade = await this.storage.getTradeById(positionId);
    if (!trade) throw new Error(`Trade ${positionId} was not found`);
    const fill = Number(exitPrice || trade.exit || trade.entry);
    const size = Number(trade.size || 0);
    const order = paperOrder({
      side: closeSideForDirection(trade.direction),
      size,
      price: fill,
      clientOrderId: compactId("pcls"),
      reason
    });
    const pnl = paperClosePnl(trade, fill, size, settings);
    const status = reason === "timeout" ? "timeout" : reason === "stop_loss" ? "stopped_out" : "closed";
    await this.storage.updateTrade(positionId, {
      closedAt: new Date().toISOString(),
      exit: Number.isFinite(fill) ? fill : null,
      pnl: round(pnl),
      status,
      payload: {
        ...(trade.payload || {}),
        exitReason: reason,
        closeOrder: order,
        events: [
          ...((trade.payload || {}).events || []),
          { at: new Date().toISOString(), type: "paper_closed", reason, order }
        ]
      }
    });
    await this.storage.recordExecutionAudit?.({
      tradeId: positionId,
      signalEntry: trade.entry,
      actualFill: null,
      slippagePct: null,
      expectedStop: trade.payload?.stop || null,
      actualStopOrderId: order.response.ordId,
      stopFillPrice: Number.isFinite(fill) ? fill : null,
      stopSlippagePct: null,
      fee: 0,
      feeAsset: "USDT",
      payload: { reason, order, paper: true }
    });
    return {
      tradeId: positionId,
      status,
      sizeClosed: size,
      remainingSize: 0,
      pnl: round(pnl),
      order
    };
  }

  async paperCloseHalfPosition(positionId, { settings = {}, exitPrice = null } = {}) {
    const trade = await this.storage.getTradeById(positionId);
    if (!trade) throw new Error(`Trade ${positionId} was not found`);
    const totalSize = Number(trade.size || 0);
    if (totalSize < 0.02) throw new Error("Position is too small for partial close");
    const size = floorLot(totalSize / 2, Number(settings?.daemon?.minOrderSize || 0.01));
    const remainingSize = floorLot(totalSize - size, Number(settings?.daemon?.minOrderSize || 0.01));
    const fill = Number(exitPrice || trade.payload?.partialTargetPrice || trade.entry);
    const order = paperOrder({
      side: closeSideForDirection(trade.direction),
      size,
      price: fill,
      clientOrderId: compactId("pptp"),
      reason: "partial_take_profit"
    });
    await this.storage.updateTrade(positionId, {
      size: remainingSize,
      status: "partial_closed",
      payload: {
        ...(trade.payload || {}),
        partialTpAt: new Date().toISOString(),
        partialTpOrder: order,
        originalSize: trade.payload?.originalSize || trade.size,
        events: [
          ...((trade.payload || {}).events || []),
          { at: new Date().toISOString(), type: "paper_partial_tp", sizeClosed: size, remainingSize, order }
        ]
      }
    });
    await this.storage.recordExecutionAudit?.({
      tradeId: positionId,
      signalEntry: trade.entry,
      actualFill: order.fill.fillPx,
      slippagePct: null,
      expectedStop: trade.payload?.stop || null,
      actualStopOrderId: order.response.ordId,
      stopFillPrice: null,
      stopSlippagePct: null,
      fee: 0,
      feeAsset: "USDT",
      payload: { reason: "partial_take_profit", sizeClosed: size, remainingSize, order, paper: true }
    });
    return {
      tradeId: positionId,
      sizeClosed: size,
      remainingSize,
      order
    };
  }

  async placePartialTargetIfNeeded({ signal, settings, actualEntry, size, tradeId }) {
    const target = partialTargetForSignal(signal, actualEntry, size, settings);
    if (!target) return null;
    if (isPaperExecution(settings)) {
      const order = paperOrder({
        side: target.side,
        size: target.size,
        price: target.price,
        clientOrderId: compactId("ptgt"),
        orderType: "limit",
        state: "live",
        reason: target.reason
      });
      return {
        ...target,
        placedAt: new Date().toISOString(),
        orderId: order.response.ordId,
        clOrdId: order.response.clOrdId,
        order
      };
    }
    try {
      const order = await this.executor.placeReduceOnlyLimitOrder({
        instrument: this.okx.instrument,
        side: target.side,
        size: target.size,
        price: target.price,
        clientOrderId: compactId("ptgt")
      }, settings);
      return {
        ...target,
        placedAt: new Date().toISOString(),
        orderId: orderIdFromOrder(order),
        clOrdId: clientOrderIdFromOrder(order),
        order
      };
    } catch (error) {
      logger.error({
        module: "tradeDaemon",
        signalId: signal.id,
        tradeId,
        error: error.reason || error.message
      }, "partial target placement failed");
      return {
        ...target,
        failedAt: new Date().toISOString(),
        error: error.reason || error.message,
        errorPayload: error.payload || null
      };
    }
  }

  async planSignalExecution({ signal, openPositions, risk, settings, autoExecute, market = {} }) {
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
        size: orderSizeFor(settings, signal, risk),
        executed: false
      };
    }
    if (!this.storage?.enabled) {
      return {
        action: "skip_storage_missing",
        signalId: signal.id,
        executed: false
      };
    }

    const paperExecution = isPaperExecution(settings);
    if (!paperExecution) {
      const guard = this.executor.guard(settings);
      if (!guard.ok) {
        return {
          action: "skip_execution_guard",
          signalId: signal.id,
          reason: guard.reason,
          executed: false
        };
      }
    }
    const executionHealth = await this.dataHealthMonitor?.checkBeforeTrade?.(settings);
    if (executionHealth && executionHealth.ok === false) {
      return {
        action: "skip_okx_rate_limit",
        signalId: signal.id,
        reason: `${executionHealth.rate?.remainingPct}% remaining`,
        executed: false
      };
    }
    const size = orderSizeFor(settings, signal, risk);
    const tradeId = candidateTradeId(signal);
    const inserted = await this.storage.createOpenTrade({
      id: tradeId,
      symbol: this.okx.instrument,
      direction: signal.direction,
      type: signal.type,
      entry: signal.entry,
      size,
      stop: signal.stop,
      signalGrade: signal.grade,
      signalId: signal.id,
      status: "pending_open",
      payload: {
        signal,
        risk,
        requestedSize: size,
        events: [{ at: new Date().toISOString(), type: "pending_open", signalId: signal.id }]
      }
    });
    if (!inserted) {
      return {
        action: "skip_duplicate_signal",
        signalId: signal.id,
        tradeId,
        executed: false
      };
    }
    try {
      if (opposite) {
        if (paperExecution) {
          await this.paperClosePosition(opposite.id, {
            settings,
            reason: "reverse_signal",
            exitPrice: quotePrice(market, signal.entry)
          });
        } else {
          await this.executor.closePosition(opposite.id, {
            storage: this.storage,
            settings,
            reason: "reverse_signal",
            exitPrice: signal.entry
          });
        }
      }
      const paperFill = quotePrice(market, signal.entry);
      const order = paperExecution
        ? paperOrder({
          side: sideForDirection(signal.direction),
          size,
          price: paperFill,
          stop: signal.stop,
          clientOrderId: compactId("open"),
          reason: "open"
        })
        : await this.executor.placePerpetualMarketOrder({
          side: sideForDirection(signal.direction),
          size,
          stopLossPrice: signal.stop,
          clientOrderId: compactId("open")
        }, settings);
      const actualFill = fillPriceFromOrder(order, signal.entry);
      const partialTarget = await this.placePartialTargetIfNeeded({
        signal,
        settings,
        actualEntry: actualFill || signal.entry,
        size,
        tradeId
      });
      const events = [
        { at: new Date().toISOString(), type: "opened", signalId: signal.id, order }
      ];
      if (partialTarget?.orderId || partialTarget?.clOrdId) {
        events.push({
          at: partialTarget.placedAt,
          type: "partial_target_placed",
          price: partialTarget.price,
          size: partialTarget.size,
          orderId: partialTarget.orderId,
          clOrdId: partialTarget.clOrdId
        });
      } else if (partialTarget?.error) {
        events.push({
          at: partialTarget.failedAt,
          type: "partial_target_failed",
          price: partialTarget.price,
          size: partialTarget.size,
          error: partialTarget.error
        });
      }
      await this.storage.updateTrade(tradeId, {
        entry: actualFill || signal.entry,
        status: "open",
        payload: {
          signal,
          order,
          stop: signal.stop,
          signalId: signal.id,
          signalGrade: signal.grade,
          requestedSize: size,
          actualFill,
          partialTarget,
          partialTargetOrderId: partialTarget?.orderId || "",
          partialTargetClOrdId: partialTarget?.clOrdId || "",
          partialTargetPrice: partialTarget?.price || null,
          partialTargetSize: partialTarget?.size || null,
          partialTargetRemainingSize: partialTarget?.remainingSize || null,
          originalSize: size,
          events
        }
      });
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
        size,
        entry: actualFill || signal.entry,
        stop: signal.stop
      }));
      openPositions.push({
        id: tradeId,
        direction: signal.direction,
        type: signal.type,
        entry: actualFill || signal.entry,
        size,
        status: "open",
        payload: { partialTarget }
      });
      return {
        action: "opened",
        signalId: signal.id,
        tradeId,
        executed: true
      };
    } catch (error) {
      await this.storage.updateTrade(tradeId, {
        status: "execution_failed",
        payload: {
          signal,
          risk,
          requestedSize: size,
          error: error.reason || error.message,
          errorPayload: error.payload || null,
          events: [{ at: new Date().toISOString(), type: "execution_failed", error: error.reason || error.message }]
        }
      });
      logger.error({ module: "tradeDaemon", signalId: signal.id, tradeId, error: error.message }, "signal execution failed");
      return {
        action: "execution_failed",
        signalId: signal.id,
        tradeId,
        reason: error.reason || error.message,
        executed: false
      };
    }
  }

  async syncPartialTargetOrder({ position, settings, quote = null }) {
    if (hasPartialTakeProfit(position)) return null;
    const payload = position.payload || {};
    const ordId = payload.partialTargetOrderId || payload.partialTarget?.orderId || "";
    const clOrdId = payload.partialTargetClOrdId || payload.partialTarget?.clOrdId || "";
    if (!ordId && !clOrdId) return null;
    let fill = null;
    if (isPaperExecution(settings)) {
      const targetPrice = Number(payload.partialTargetPrice || payload.partialTarget?.price);
      const current = Number(quote?.mid || quote?.last || position.price || position.entry);
      const hit = Number.isFinite(targetPrice) && Number.isFinite(current)
        && (position.direction === "LONG" ? current >= targetPrice : current <= targetPrice);
      fill = hit
        ? {
          confirmed: true,
          state: "filled",
          ordId,
          clOrdId,
          fillPx: targetPrice,
          accFillSz: Number(payload.partialTargetSize || Number(position.size || 0) / 2),
          fee: 0,
          feeCcy: "USDT",
          raw: { paper: true, current }
        }
        : {
          confirmed: false,
          state: "live",
          ordId,
          clOrdId,
          fillPx: null,
          accFillSz: 0,
          fee: 0,
          feeCcy: "USDT",
          raw: { paper: true, current }
        };
    } else {
      try {
        fill = await this.executor.getManagedOrderFill({
          instrument: position.symbol || this.okx.instrument,
          ordId,
          clOrdId,
          settings
        });
      } catch (error) {
        logger.warn({
          module: "tradeDaemon",
          tradeId: position.id,
          ordId,
          clOrdId,
          error: error.reason || error.message
        }, "partial target sync failed");
        return { inactive: true, error: error.reason || error.message };
      }
    }
    if (!fill) return null;
    if (fill.confirmed) {
      const minOrderSize = Number(settings?.daemon?.minOrderSize || process.env.OKX_MIN_ORDER_SIZE || 0.01);
      const closedSize = floorLot(Number(fill.accFillSz || payload.partialTargetSize || Number(position.size || 0) / 2), minOrderSize);
      const remainingSize = floorLot(Math.max(0, Number(position.size || 0) - closedSize), minOrderSize);
      const fillPx = Number(fill.fillPx || payload.partialTargetPrice || position.entry);
      const pnlMultiplier = Number(settings?.daemon?.pnlMultiplier || process.env.OKX_PNL_MULTIPLIER || 100);
      const partialPnl = Number.isFinite(fillPx)
        ? (fillPx - Number(position.entry)) * directionSign(position.direction) * closedSize * pnlMultiplier
        : 0;
      await this.storage.updateTrade(position.id, {
        size: remainingSize,
        status: "partial_closed",
        payload: {
          ...payload,
          partialTpAt: new Date().toISOString(),
          partialTargetFilledAt: new Date().toISOString(),
          partialTargetFill: fill,
          partialTpOrder: payload.partialTarget?.order || null,
          originalSize: payload.originalSize || position.size,
          events: [
            ...(payload.events || []),
            {
              at: new Date().toISOString(),
              type: "partial_target_filled",
              sizeClosed: closedSize,
              remainingSize,
              pnl: round(partialPnl),
              fill
            }
          ]
        }
      });
      await this.storage.recordExecutionAudit?.({
        tradeId: position.id,
        signalEntry: position.entry,
        actualFill: Number.isFinite(fillPx) ? fillPx : null,
        slippagePct: null,
        expectedStop: position.stop || payload.stop || null,
        actualStopOrderId: ordId || clOrdId,
        stopFillPrice: null,
        stopSlippagePct: null,
        fee: fill.fee || 0,
        feeAsset: fill.feeCcy || "USDT",
        payload: {
          reason: "partial_target",
          sizeClosed: closedSize,
          remainingSize,
          fill
        }
      });
      return {
        filled: true,
        action: {
          action: "partial_target_filled",
          tradeId: position.id,
          result: {
            sizeClosed: closedSize,
            remainingSize,
            pnl: round(partialPnl),
            fill
          },
          executed: true
        }
      };
    }
    if (["live", "partially_filled", ""].includes(fill.state)) {
      return { pending: true, fill };
    }
    return { inactive: true, fill };
  }

  async planPositionManagement({ position, market, settings, autoExecute }) {
    if (isPaperExecution(settings) && shouldStopLoss(position, market.quote)) {
      if (!autoExecute) {
        return { action: "would_stop_loss_close", tradeId: position.id, reason: "paper_stop_loss", executed: false };
      }
      const result = await this.paperClosePosition(position.id, {
        settings,
        reason: "stop_loss",
        exitPrice: position.stop || position.payload?.stop || quotePrice(market, position.price)
      });
      await this.safeNotify(() => this.notifier.notifyClose(settings, {
        position,
        pnl: result.pnl || 0,
        reason: "stop_loss"
      }));
      return { action: "stop_loss_close", tradeId: position.id, result, executed: true };
    }
    const partialTargetState = autoExecute
      ? await this.syncPartialTargetOrder({ position, settings, quote: market.quote })
      : null;
    if (partialTargetState?.filled) {
      await this.safeNotify(() => this.notifier.notifyPartialTakeProfit(settings, {
        position,
        pnl: partialTargetState.action.result?.pnl || 0,
        label: `${partialTakeProfitR(position, settings)}R`
      }));
      return partialTargetState.action;
    }
    if (!partialTargetState?.pending && shouldPartialTakeProfit(position, market.quote, settings)) {
      if (!autoExecute) {
        return { action: "would_partial_tp", tradeId: position.id, reason: `${positionType(position)}_${partialTakeProfitR(position, settings)}R`, executed: false };
      }
      const result = isPaperExecution(settings)
        ? await this.paperCloseHalfPosition(position.id, {
          settings,
          exitPrice: quotePrice(market, position.payload?.partialTargetPrice || position.entry)
        })
        : await this.executor.closeHalfPosition(position.id, {
          storage: this.storage,
          settings
        });
      await this.safeNotify(() => this.notifier.notifyPartialTakeProfit(settings, {
        position,
        pnl: 0,
        label: `${partialTakeProfitR(position, settings)}R`
      }));
      return { action: "partial_tp", tradeId: position.id, result, executed: true };
    }
    if (shouldTrailingClose(position, market.h4, settings)) {
      if (!autoExecute) {
        return { action: "would_trailing_close", tradeId: position.id, reason: `MA${trailingPeriod(position, settings)}_H4_cross`, executed: false };
      }
      const result = isPaperExecution(settings)
        ? await this.paperClosePosition(position.id, {
          settings,
          reason: "trailing_stop",
          exitPrice: market.h4.at(-1)?.close || quotePrice(market, position.entry)
        })
        : await this.executor.closePosition(position.id, {
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
      const result = isPaperExecution(settings)
        ? await this.paperClosePosition(position.id, {
          settings,
          reason: "timeout",
          exitPrice: quotePrice(market, position.price)
        })
        : await this.executor.closePosition(position.id, {
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
