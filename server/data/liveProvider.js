import * as mock from "../mockData.mjs";
import { runSignalEngine, signalStats } from "../engine/signalEngine.js";
import { runBacktest } from "../engine/backtestEngine.js";

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function isSettledOk(result) {
  return result.status === "fulfilled" && result.value;
}

function needsSentinelFlow(settings) {
  return settings?.strategy?.enabledSignalTypes?.structural_breakdown === true
    && settings?.strategy?.structuralBreakdown?.useFundingData === true;
}

function candleLevels(candles) {
  const recent = candles.slice(-48);
  const high = Math.max(...recent.map((item) => item.high));
  const low = Math.min(...recent.map((item) => item.low));
  const close = recent.at(-1)?.close || (high + low) / 2;
  const pivot = (high + low + close) / 3;
  return [
    { label: "日内高点", price: round(high) },
    { label: "实时枢轴", price: round(pivot) },
    { label: "风控低点", price: round(low) },
    { label: "低吸区", price: round(low + (pivot - low) * 0.35) }
  ];
}

function goldCurveFromCandles(candles = []) {
  return candles
    .filter((candle) => Number.isFinite(Number(candle.close)))
    .slice(-80)
    .map((candle) => ({
      t: candle.t,
      v: round(candle.close)
    }));
}

function mockGoldCurve() {
  return goldCurveFromCandles(mock.makeKlines("D"));
}

function pnlMultiplier(settings = {}) {
  const value = Number(settings?.daemon?.pnlMultiplier || 100);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function paperMarginLeverage(settings = {}) {
  const value = Number(settings?.paper?.marginLeverage || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function closeablePrice(direction, quote = {}, fallback = null, settings = {}) {
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const mid = Number(quote?.mid ?? quote?.last ?? fallback);
  const spread = Number.isFinite(Number(quote?.spread))
    ? Number(quote.spread)
    : Number(settings?.paper?.spreadUsd ?? 0.3);
  if (direction === "LONG" && Number.isFinite(bid)) return bid;
  if (direction === "SHORT" && Number.isFinite(ask)) return ask;
  if (!Number.isFinite(mid)) return null;
  if (direction === "LONG") return mid - Math.max(0, spread) / 2;
  if (direction === "SHORT") return mid + Math.max(0, spread) / 2;
  return mid;
}

function positionNotional(position = {}, settings = {}) {
  return Math.abs(Number(position.entry || 0) * Number(position.size || 0) * pnlMultiplier(settings));
}

function positionMargin(position = {}, settings = {}) {
  return positionNotional(position, settings) / paperMarginLeverage(settings);
}

function withQuotePosition(position, quote, settings = {}) {
  if (!position || !quote) return position;
  const price = closeablePrice(position.direction, quote, position.price || position.entry, settings);
  if (!Number.isFinite(price)) return position;
  const sign = position.direction === "SHORT" ? -1 : 1;
  const payload = position.payload || {};
  const grossPnl = (price - position.entry) * sign * position.size * pnlMultiplier(settings);
  const realizedPnl = Number(payload.realizedPnl || 0);
  const entryFeeRemaining = Number(payload.entryFeeRemaining || 0);
  const pnl = realizedPnl + grossPnl - entryFeeRemaining;
  const notional = positionNotional(position, settings);
  return {
    ...position,
    price: round(price),
    pnl: round(pnl),
    pnlPct: round(notional ? (pnl / notional) * 100 : ((price - position.entry) / position.entry) * 100 * sign)
  };
}

function durationLabel(minutes = 0) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value < 60) return `${Math.round(value)}分钟`;
  if (value < 1440) return `${Math.floor(value / 60)}小时${Math.round(value % 60)}分钟`;
  return `${Math.floor(value / 1440)}天${Math.round((value % 1440) / 60)}小时`;
}

function normalizedType(value) {
  return String(value || "").trim() || "未分类";
}

function enrichPosition(position) {
  const type = normalizedType(position.type || position.payload?.signalType);
  const partialLocked = Boolean(position.payload?.partialTpAt || position.payload?.partialClosedAt || position.status === "partial_closed");
  const partialPending = type === "fakeout" && !partialLocked && Boolean(position.payload?.partialTargetPrice || position.payload?.partialTarget);
  return {
    ...position,
    type,
    signalType: type,
    durationLabel: durationLabel(position.durationMinutes),
    halfProfitLabel: type === "fakeout"
      ? partialLocked
        ? "半仓已锁利 @1.5R / 剩余 MA10 跟踪中"
        : partialPending
          ? "半仓止盈挂单 @1.5R / 等待触发"
          : ""
      : ""
  };
}

function compactSymbol(symbol) {
  return String(symbol || "").replace(/[-_]/g, "").toUpperCase();
}

function sameUnderlying(left, right) {
  const a = compactSymbol(left);
  const b = compactSymbol(right);
  return a === b || (a.includes("XAU") && b.includes("XAU"));
}

function samePosition(left, right) {
  return sameUnderlying(left.symbol, right.symbol) && left.direction === right.direction;
}

function mergeOkxPositions({ positions = [], okxPositions = [], quote = null, okxAvailable = false, settings = {} }) {
  const usedOkx = new Set();
  const paperMode = isPaperTradeMode(settings);
  const merged = positions.map((position) => {
    const quoted = quote ? withQuotePosition(position, quote, settings) : position;
    const match = okxPositions.find((item) => !usedOkx.has(item.id) && samePosition(quoted, item));
    if (!match) {
      return enrichPosition({
        ...quoted,
        source: "database",
        okxVerified: paperMode ? null : okxAvailable ? false : null,
        okxStatus: paperMode ? "paper" : okxAvailable ? "missing_on_okx" : "unavailable"
      });
    }
    usedOkx.add(match.id);
    return enrichPosition({
      ...quoted,
      price: match.price || quoted.price,
      pnl: match.pnl ?? quoted.pnl,
      pnlPct: match.pnlPct ?? pctPnl(quoted),
      source: "database",
      okxVerified: true,
      okxStatus: "matched",
      okxSize: match.size,
      okxUpdatedAt: match.updatedAt,
      okxPositionId: match.id
    });
  });

  okxPositions
    .filter((position) => !usedOkx.has(position.id))
    .forEach((position) => {
      merged.push(enrichPosition({
        ...position,
        id: `OKX-${position.id}`,
        signalId: "OKX持仓",
        signalGrade: "",
        type: "manual",
        stop: null,
        durationMinutes: position.openedAt ? Math.max(0, Math.round((Date.now() - new Date(position.openedAt).getTime()) / 60000)) : 0,
        okxVerified: true,
        okxStatus: "okx_only",
        okxSize: position.size
      }));
    });

  return merged;
}

function emptyTradeCenter(settings, goldCurve = mockGoldCurve()) {
  const initialBalance = Number(settings?.paper?.initialBalanceUsdt || 10000);
  return {
    account: {
      currency: "USDT",
      initialBalance,
      balance: initialBalance,
      availableMargin: initialBalance,
      usedMargin: 0,
      floatingPnl: 0,
      marginLeverage: paperMarginLeverage(settings),
      notional: 0,
      marginLevelPct: 0
    },
    positions: [],
    history: [],
    pnlCurve: goldCurve.map((point) => ({ t: point.t, v: initialBalance })),
    goldCurve,
    metrics: {
      totalPnl: 0,
      winRate: 0,
      profitFactor: 0,
      sharpe: 0,
      maxDrawdown: 0,
      avgR: 0
    },
    weeklyHeatmap: [],
    monthlyHeatmap: [],
    attribution: [],
    typeStats: [],
    okxPositions: [],
    expectedCurve: [],
    deviation: {
      actualPnl: 0,
      expectedPnl: 0,
      ratioPct: 0
    }
  };
}

function pctPnl(position) {
  if (!position?.entry || !position.price) return 0;
  const sign = position.direction === "SHORT" ? -1 : 1;
  return round(((position.price - position.entry) / position.entry) * 100 * sign);
}

function dailyPnlCurve({ history = [], initialBalance, goldCurve = [] }) {
  const events = history
    .map((trade) => ({
      day: String(trade.closedAt || trade.openedAt || new Date().toISOString()).slice(0, 10),
      pnl: Number(trade.pnl || 0)
    }))
    .filter((event) => event.day && Number.isFinite(event.pnl))
    .sort((a, b) => a.day.localeCompare(b.day));
  let equity = initialBalance;
  let index = 0;
  return goldCurve.map((point) => {
    const day = String(point.t).slice(0, 10);
    while (index < events.length && events[index].day <= day) {
      equity += events[index].pnl;
      index += 1;
    }
    return { t: point.t, v: round(equity) };
  });
}

function typeStats(history = []) {
  const keys = new Set(["fakeout", "breakout"]);
  history.forEach((trade) => keys.add(normalizedType(trade.type)));
  return Array.from(keys).map((type) => {
    const rows = history.filter((trade) => normalizedType(trade.type) === type);
    const pnl = rows.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const wins = rows.filter((trade) => Number(trade.pnl || 0) > 0).length;
    return {
      type,
      count: rows.length,
      pnl: round(pnl),
      winRate: rows.length ? Math.round((wins / rows.length) * 100) : 0
    };
  });
}

function expectedCurveFromRun(run, initialBalance, fallbackLength = 80) {
  const equity = (run?.equity || [])
    .filter((point) => Number.isFinite(Number(point?.v)))
    .slice(-Math.max(10, fallbackLength));
  if (!equity.length) return [];
  const first = Number(equity[0].v);
  return equity.map((point) => ({
    t: point.t,
    v: round(initialBalance + Number(point.v) - first)
  }));
}

function compactBacktestRun(run) {
  if (!run) return run;
  return {
    ...run,
    equity: (run.equity || []).slice(-300),
    monteCarlo: (run.monteCarlo || []).slice(0, 120),
    equityPoints: run.equity?.length || 0,
    monteCarloPoints: run.monteCarlo?.length || 0
  };
}

function tradeCenterFromRows({ positions = [], history = [], settings, goldCurve = mockGoldCurve(), latestRun = null }) {
  const initialBalance = Number(settings?.paper?.initialBalanceUsdt || 10000);
  const totalPnl = round(history.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
  const wins = history.filter((trade) => Number(trade.pnl || 0) > 0);
  const losses = history.filter((trade) => Number(trade.pnl || 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
  const pnlCurve = dailyPnlCurve({ history, initialBalance, goldCurve });
  const floatingPnl = round(positions.reduce((sum, position) => sum + Number(position.pnl || 0), 0));
  const notional = round(positions.reduce((sum, position) => sum + positionNotional(position, settings), 0));
  const usedMargin = round(positions.reduce((sum, position) => sum + positionMargin(position, settings), 0));
  const equity = round(initialBalance + totalPnl + floatingPnl);
  const expectedCurve = expectedCurveFromRun(latestRun, initialBalance, goldCurve.length || pnlCurve.length || 80);
  const expectedPnl = expectedCurve.length ? round(expectedCurve.at(-1).v - initialBalance) : 0;
  const actualPnl = round(totalPnl + floatingPnl);
  const byType = new Map();
  for (const trade of history) {
    const key = trade.type || "未分类";
    const item = byType.get(key) || { type: key, pnl: 0, count: 0 };
    item.pnl += Number(trade.pnl || 0);
    item.count += 1;
    byType.set(key, item);
  }
  return {
    account: {
      currency: "USDT",
      initialBalance,
      balance: equity,
      availableMargin: round(equity - usedMargin),
      usedMargin,
      floatingPnl,
      marginLeverage: paperMarginLeverage(settings),
      notional,
      marginLevelPct: usedMargin ? round((equity / usedMargin) * 100) : 0
    },
    positions,
    history,
    pnlCurve,
    goldCurve,
    metrics: {
      totalPnl,
      winRate: history.length ? Math.round((wins.length / history.length) * 100) : 0,
      profitFactor: grossLoss ? round(grossProfit / grossLoss) : grossProfit ? 99 : 0,
      sharpe: 0,
      maxDrawdown: 0,
      avgR: history.length ? round(history.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / history.length) : 0
    },
    weeklyHeatmap: [],
    monthlyHeatmap: [],
    attribution: Array.from(byType.values()).map((item) => ({
      type: item.type,
      pnl: round(item.pnl),
      share: totalPnl ? round((item.pnl / Math.abs(totalPnl)) * 100) : 0
    })),
    typeStats: typeStats(history),
    expectedCurve,
    deviation: {
      actualPnl,
      expectedPnl,
      ratioPct: expectedPnl ? round((actualPnl / expectedPnl) * 100) : 0
    }
  };
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

function riskStateFromTrades(settings, history = []) {
  const initialBalance = Number(settings?.paper?.initialBalanceUsdt || 10000);
  const today = startOfUtcDay();
  const week = startOfUtcWeek();
  const todayTrades = history.filter((trade) => trade.closedAt && new Date(trade.closedAt) >= today);
  const weekTrades = history.filter((trade) => trade.closedAt && new Date(trade.closedAt) >= week);
  const todayPnl = todayTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const weekPnl = weekTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const dailyLossPct = round(Math.max(0, -todayPnl) / initialBalance * 100);
  const weeklyLossPct = round(Math.max(0, -weekPnl) / initialBalance * 100);
  const stoppedOutToday = todayTrades.filter(isStopLossTrade).length;
  const maxDailyStops = Number(settings?.risk?.maxDailyStops || 2);
  const dailyLimitPct = Number(settings?.risk?.dailyCircuitLossPct || 2.5);
  const weeklyLimitPct = Number(settings?.risk?.weeklyCircuitLossPct || 4);
  const noTradeUtcHours = settings?.risk?.noTradeUtcHours || [];
  const utcHour = new Date().getUTCHours();
  const sessionLocked = noTradeUtcHours.includes(utcHour);
  const circuitBreaker = stoppedOutToday >= maxDailyStops || dailyLossPct >= dailyLimitPct || weeklyLossPct >= weeklyLimitPct;
  return {
    circuitBreaker,
    eventCircuitBreaker: Boolean(settings?.risk?.eventCircuitBreaker),
    stoppedOutToday,
    maxDailyStops,
    remainingNotionalPct: circuitBreaker ? 0 : 100,
    dailyLossPct,
    dailyLimitPct,
    weeklyLossPct,
    weeklyLimitPct,
    sessionLocked,
    sessionStatus: sessionLocked ? "锁仓" : "交易中",
    status: circuitBreaker ? "熔断触发" : sessionLocked ? "时段保护锁仓" : "正常"
  };
}

export function isRealDataMode(settings) {
  return settings?.api?.dataMode === "real";
}

function isPaperTradeMode(settings) {
  return settings?.api?.tradeMode !== "live";
}

export class LiveDataProvider {
  constructor({ oandaAdapter, okxAdapter, macroFetcher, storage = null }) {
    this.oanda = oandaAdapter;
    this.okx = okxAdapter;
    this.macroFetcher = macroFetcher;
    this.storage = storage;
    this.lastEngineResult = null;
    this.lastOandaHistoryAt = 0;
    this.oandaHistoryTtlMs = Number(process.env.OANDA_HISTORY_REFRESH_MS || 15 * 60 * 1000);
    this.oandaHistoryCount = Number(process.env.OANDA_BACKTEST_CANDLE_COUNT || 20000);
    this.oandaHistoryRangeDays = Number(process.env.OANDA_BACKTEST_RANGE_DAYS || 730);
  }

  async ensureBacktestCandles() {
    if (!this.storage?.enabled || !this.oanda?.isConfigured?.()) return { skipped: true };
    const now = Date.now();
    if (now - this.lastOandaHistoryAt < this.oandaHistoryTtlMs) return { skipped: true };
    this.lastOandaHistoryAt = now;
    const candles = this.oandaHistoryRangeDays >= 365 && this.oanda.getHistoricalCandles
      ? await this.oanda.getHistoricalCandles({
        timeframe: "H1",
        days: this.oandaHistoryRangeDays,
        pageSize: Math.min(5000, this.oandaHistoryCount)
      })
      : await this.oanda.getCandles({
        timeframe: "H1",
        count: this.oandaHistoryCount
      });
    await this.storage.persistCandles({
      instrument: this.oanda.instrument,
      timeframe: "H1",
      candles,
      source: "oanda"
    });
    return { candles: candles.length };
  }

  async engineResult(settings, timeframe = "H1") {
    const base = mock.dashboard(settings, timeframe);
    if (!isRealDataMode(settings)) {
      const result = runSignalEngine({
        candles: base.kline.candles,
        macroSnapshot: mock.macroCompass(),
        settings
      });
      await this.storage?.persistSignals?.(result.signals);
      this.lastEngineResult = result;
      return {
        result,
        base,
        quote: null,
        candles: base.kline.candles,
        macro: mock.macroCompass(),
        warnings: []
      };
    }
    const warnings = [];
    const fetchSentinelFlow = needsSentinelFlow(settings);
    const [quote, candles, macro, oandaHistory, okxTrades, btcQuote] = await Promise.allSettled([
      this.okx.getPricing(),
      this.okx.getCandles({ timeframe }),
      this.macroFetcher.getSnapshot(),
      this.ensureBacktestCandles(),
      fetchSentinelFlow ? this.okx.getTrades({ limit: 500 }) : Promise.resolve([]),
      fetchSentinelFlow ? this.okx.getPricing("BTC-USDT") : Promise.resolve(null)
    ]);
    const candleData = isSettledOk(candles) && candles.value.length ? candles.value : base.kline.candles;
    const macroData = isSettledOk(macro) ? macro.value : mock.macroCompass();
    if (isSettledOk(candles) && candles.value.length) {
      await this.storage?.persistCandles?.({
        instrument: this.okx.instrument,
        timeframe,
        candles: candles.value,
        source: "okx"
      });
    } else {
      warnings.push(`okx candles: ${candles.reason?.message || "unavailable"}`);
    }
    if (!isSettledOk(macro)) warnings.push(`macro: ${macro.reason?.message || "unavailable"}`);
    if (!isSettledOk(quote)) warnings.push(`okx pricing: ${quote.reason?.message || "unavailable"}`);
    if (!isSettledOk(oandaHistory)) warnings.push(`oanda backtest candles: ${oandaHistory.reason?.message || "unavailable"}`);
    if (fetchSentinelFlow && !isSettledOk(okxTrades)) warnings.push(`okx trades: ${okxTrades.reason?.message || "unavailable"}`);
    if (fetchSentinelFlow && !isSettledOk(btcQuote)) warnings.push(`okx btc quote: ${btcQuote.reason?.message || "unavailable"}`);
    const result = runSignalEngine({
      candles: candleData,
      macroSnapshot: macroData,
      settings,
      marketFlow: {
        trades: isSettledOk(okxTrades) ? okxTrades.value : [],
        btcUsd: isSettledOk(btcQuote) ? btcQuote.value?.mid || btcQuote.value?.last : null
      }
    });
    await this.storage?.persistSignals?.(result.signals);
    this.lastEngineResult = result;
    return {
      result,
      base,
      quote: isSettledOk(quote) ? quote.value : null,
      candles: candleData,
      macro: macroData,
      warnings
    };
  }

  async dashboard(settings, timeframe = "H1") {
    const { result, base, quote, candles, macro, warnings } = await this.engineResult(settings, timeframe);
    const positions = await this.storage?.getOpenTradePositions?.() || [];
    const history = this.storage?.enabled ? await this.storage.getTradeHistory(500) : [];
    base.activeSignals = result.signals;
    base.risk = riskStateFromTrades(settings, history);
    base.tradeDecision = mock.tradeDecision({
      score: result.macroCompass.score,
      bias: result.macroLayer.bias
    }, result.signals, base.risk);
    base.macroCompass = {
      ...macro,
      score: result.macroCompass.score,
      bias: result.macroLayer.bias,
      factors: macro.factors || base.macroCompass.factors
    };
    base.kline.candles = candles;
    base.kline.keyLevels = candleLevels(candles);
    base.kline.signalEntries = result.signals.filter((item) => item.entry).map((item) => ({
      id: item.id,
      grade: item.grade,
      direction: item.direction,
      type: item.type,
      title: item.title,
      atr: item.atr,
      price: item.entry
    }));

    base.positions = positions.map(enrichPosition);
    if (quote) {
      base.quote = quote;
      base.positions = base.positions.map((position) => withQuotePosition(position, quote, settings));
    }

    return {
      ...base,
      dataSource: {
        mode: isRealDataMode(settings) ? "real" : "mock",
        realtimeProvider: "okx",
        backtestProvider: "oanda",
        okxTradingConfigured: this.okx.isConfigured(),
        oandaConfigured: this.oanda.isConfigured(),
        macroUpdatedAt: macro.updatedAt || null,
        warnings
      }
    };
  }

  async macroMonitor(settings) {
    const base = mock.macroMonitor();
    if (!isRealDataMode(settings)) return base;

    const snapshot = await this.macroFetcher.getSnapshot();
    return {
      ...base,
      indicators: snapshot.factors,
      score: snapshot.score,
      bias: snapshot.bias,
      updatedAt: snapshot.updatedAt,
      sources: snapshot.sources,
      stale: snapshot.stale || false
    };
  }

  async tradeGoldCurve(settings) {
    if (!isRealDataMode(settings)) return mockGoldCurve();
    try {
      return goldCurveFromCandles(await this.okx.getCandles({ timeframe: "D", count: 80 }));
    } catch {
      return mockGoldCurve();
    }
  }

  async tradeCenter(settings, filters = {}) {
    const goldCurve = await this.tradeGoldCurve(settings);
    if (!this.storage?.enabled) return emptyTradeCenter(settings, goldCurve);
    let positions = await this.storage.getOpenTradePositions();
    const history = await this.storage.getTradeHistory(500);
    const latestRun = (await this.storage.getBacktestRuns(1))[0] || null;
    const warnings = [];
    const useOkxPositions = !isPaperTradeMode(settings);
    const [quoteResult, okxResult] = await Promise.allSettled([
      this.okx.getPricing(),
      useOkxPositions ? this.okx.getPositions() : Promise.resolve([])
    ]);
    const quote = isSettledOk(quoteResult) ? quoteResult.value : null;
    const okxPositions = isSettledOk(okxResult) ? okxResult.value : [];
    if (!isSettledOk(quoteResult)) warnings.push(`okx pricing: ${quoteResult.reason?.message || "unavailable"}`);
    if (useOkxPositions && !isSettledOk(okxResult)) warnings.push(`okx positions: ${okxResult.reason?.message || "unavailable"}`);
    positions = mergeOkxPositions({
      positions,
      okxPositions,
      quote,
      okxAvailable: useOkxPositions && isSettledOk(okxResult),
      settings
    });
    const output = tradeCenterFromRows({ positions, history, settings, goldCurve, latestRun });
    if (filters.status === "open") output.history = [];
    if (filters.status === "closed") output.positions = [];
    return {
      ...output,
      okxPositions,
      okxStatus: useOkxPositions ? isSettledOk(okxResult) ? "ok" : "unavailable" : "paper_skipped",
      warnings
    };
  }

  async signalCenter(settings) {
    const { result } = await this.engineResult(settings, "H1");
    const stats = signalStats(result.signals);
    return {
      signals: result.signals,
      matrix: result.matrix,
      stats: stats.stats,
      typeStats: stats.typeStats
    };
  }

  async signalById(id, settings) {
    const center = await this.signalCenter(settings);
    return center.signals.find((signal) => signal.id === id);
  }

  async backtestCatalog(settings) {
    if (!this.storage?.enabled) return { parameters: {}, lastRuns: [] };
    const lastRuns = await this.storage.getBacktestRuns(10);
    return {
      parameters: lastRuns[0]?.params || {},
      lastRuns: lastRuns.map(compactBacktestRun)
    };
  }

  async createBacktestResult(input, settings) {
    if (!this.storage?.enabled) return mock.createBacktestResult(input);
    const macroSnapshot = await this.macroFetcher.getSnapshot();
    const { result } = await runBacktest({ storage: this.storage, macroSnapshot, settings, input });
    return result;
  }

  logs() {
    return mock.logs();
  }
}
