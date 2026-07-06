const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function minutesUntil(ts) {
  return Math.max(0, Math.round((new Date(ts).getTime() - Date.now()) / 60000));
}

function directionLabel(direction) {
  return {
    LONG: "做多",
    SHORT: "做空",
    FLAT: "观望"
  }[direction] || direction;
}

function wave(i, a = 1, b = 0.21) {
  return Math.sin(i * b) * a + Math.cos(i * b * 0.41) * a * 0.45;
}

export function makeSeries(points, start, step, base, amplitude, drift = 0) {
  return Array.from({ length: points }, (_, index) => ({
    t: new Date(start + index * step).toISOString(),
    v: round(base + wave(index, amplitude) + index * drift, 3)
  }));
}

export function makeKlines(timeframe = "H1") {
  const step = timeframe === "D" ? DAY : timeframe === "H4" ? 4 * HOUR : HOUR;
  const points = timeframe === "D" ? 80 : 96;
  const start = Date.now() - step * points;
  let close = 2368;
  return Array.from({ length: points }, (_, index) => {
    const open = close;
    const impulse = wave(index, 9, 0.27) + (index > points * 0.55 ? 1.9 : -0.2);
    close = open + impulse;
    const high = Math.max(open, close) + 4 + Math.abs(wave(index, 2.7, 0.59));
    const low = Math.min(open, close) - 4 - Math.abs(wave(index, 2.1, 0.47));
    return {
      t: new Date(start + index * step).toISOString(),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(6800 + Math.abs(wave(index, 3000, 0.31)))
    };
  });
}

export function macroCompass() {
  const factors = [
    {
      key: "tips",
      label: "TIPS 实际利率",
      value: 1.72,
      unit: "%",
      change: -0.09,
      bias: "利多",
      score: 72,
      history: makeSeries(40, Date.now() - 39 * DAY, DAY, 1.91, 0.13, -0.004)
    },
    {
      key: "fedwatch",
      label: "FedWatch 降息概率",
      value: 58,
      unit: "%",
      change: 7,
      bias: "利多",
      score: 70,
      history: makeSeries(40, Date.now() - 39 * DAY, DAY, 47, 8, 0.16)
    },
    {
      key: "cot",
      label: "COT 持仓方向",
      value: 62,
      unit: "净多分位",
      change: 4,
      bias: "利多",
      score: 64,
      commercialNet: 1,
      nonCommercialNet: -1,
      history: makeSeries(40, Date.now() - 39 * DAY, DAY, 51, 7, 0.21)
    }
  ];
  const score = Math.round(factors.reduce((sum, item) => sum + item.score, 0) / factors.length);
  return {
    score,
    bias: score >= 66 ? "利多" : score <= 44 ? "利空" : "中性",
    factors
  };
}

const resonanceRows = ["宏观顺风", "技术触发", "资金确认"];
const resonanceCols = ["区间回归", "突破", "假突破", "支撑反转", "事件驱动", "结构崩溃"];

export function resonanceMatrix(seed = 0) {
  return resonanceRows.map((row, r) => ({
    row,
    cells: resonanceCols.map((col, c) => ({
      col,
      value: Math.max(18, Math.min(96, Math.round(54 + wave(seed + r * 4 + c, 28, 0.85) + r * 8 + c * 3)))
    }))
  }));
}

export function signals() {
  const raw = [
    {
      id: "SIG-XAU-20260705-01",
      createdAt: iso(-42 * 60000),
      grade: "S",
      direction: "LONG",
      type: "breakout",
      title: "伦敦段突破延续",
      score: 88,
      validUntil: iso(2.5 * HOUR),
      entry: 2384.6,
      stop: 2372.4,
      target: 2408.5,
      macro: { tips: 72, fedwatch: 70, cot: 64 },
      technical: ["H4 收盘站上 20EMA", "ATR 放大至 1.18 倍", "前高 2382.8 被有效突破"],
      flow: ["COT 净多分位抬升", "回撤成交量缩小", "纽约盘流动性确认"],
      matrix: resonanceMatrix(4)
    },
    {
      id: "SIG-XAU-20260705-02",
      createdAt: iso(-3.5 * HOUR),
      grade: "A",
      direction: "LONG",
      type: "rangeRegression",
      title: "实际利率回落后的低吸",
      score: 79,
      validUntil: iso(5 * HOUR),
      entry: 2376.2,
      stop: 2365.8,
      target: 2393.4,
      macro: { tips: 76, fedwatch: 68, cot: 59 },
      technical: ["H1 回踩 VWAP", "RSI 重新越过 50", "下沿假跌破收回"],
      flow: ["主动买入回升", "价差回归均值", "仓位拥挤度可控"],
      matrix: resonanceMatrix(9)
    },
    {
      id: "SIG-XAU-20260705-03",
      createdAt: iso(-21 * HOUR),
      grade: "B",
      direction: "SHORT",
      type: "falseBreakout",
      title: "关键压力假突破观察",
      score: 65,
      validUntil: iso(90 * 60 * 1000),
      entry: 2391.8,
      stop: 2399.9,
      target: 2378.1,
      macro: { tips: 48, fedwatch: 49, cot: 42 },
      technical: ["上影线穿越日内 R2", "H1 MACD 背离", "突破后量能递减"],
      flow: ["追多成交降温", "避险买盘未延续", "短线止盈盘增加"],
      matrix: resonanceMatrix(15)
    },
    {
      id: "SIG-XAU-20260705-04",
      createdAt: iso(-4 * DAY),
      grade: "C",
      direction: "FLAT",
      type: "eventDriven",
      title: "CPI 前事件熔断窗口",
      score: 51,
      validUntil: iso(10 * HOUR),
      entry: null,
      stop: null,
      target: null,
      macro: { tips: 53, fedwatch: 57, cot: 50 },
      technical: ["日线波动收敛", "事件前价差扩大", "突破确认不足"],
      flow: ["流动性等待数据", "盘口深度下降", "隔夜仓位降低"],
      matrix: resonanceMatrix(22)
    }
  ];
  return raw.map((signal) => ({
    ...signal,
    expiresInMinutes: minutesUntil(signal.validUntil)
  }));
}

export function positions() {
  return [];
}

export function riskState(settings) {
  return {
    circuitBreaker: false,
    eventCircuitBreaker: settings.risk.eventCircuitBreaker,
    stoppedOutToday: 1,
    maxDailyStops: settings.risk.maxDailyStops,
    remainingNotionalPct: 64,
    dailyLossPct: 0.42,
    dailyLimitPct: settings.risk.dailyCircuitLossPct,
    weeklyLossPct: 1.25,
    weeklyLimitPct: settings.risk.weeklyCircuitLossPct,
    status: "可交易但等待 S/A 共振"
  };
}

export function tradeDecision(compass, activeSignals, risk) {
  const bestSignal = activeSignals
    .filter((signal) => signal.direction !== "FLAT")
    .sort((a, b) => b.score - a.score)[0];
  if (risk.circuitBreaker) {
    return {
      action: "NO_TRADE",
      label: "暂停交易",
      grade: "RISK",
      direction: "FLAT",
      confidence: 0,
      reasons: ["风控熔断已触发", "停止开新仓", "等待风险状态恢复"]
    };
  }
  if (!bestSignal || bestSignal.score < 74) {
    return {
      action: "WAIT",
      label: "等待",
      grade: bestSignal?.grade || "C",
      direction: bestSignal?.direction || "FLAT",
      confidence: bestSignal?.score || compass.score,
      reasons: ["没有 A 级以上可执行共振", "保持观察", "优先保护开仓额度"]
    };
  }
  const macroAligned = (compass.bias === "利多" && bestSignal.direction === "LONG")
    || (compass.bias === "利空" && bestSignal.direction === "SHORT");
  return {
    action: macroAligned ? `ALLOW_${bestSignal.direction}` : "WATCH",
    label: macroAligned ? `可小仓${bestSignal.direction === "SHORT" ? "做空" : "做多"}` : "观察确认",
    grade: bestSignal.grade,
    direction: bestSignal.direction,
    confidence: Math.round((bestSignal.score + compass.score) / 2),
    reasons: [
      `${bestSignal.grade} 级 ${directionLabel(bestSignal.direction)}信号有效`,
      `宏观罗盘 ${compass.bias} ${compass.score} 分`,
      `剩余可开仓额度 ${risk.remainingNotionalPct}%`
    ]
  };
}

export function dashboard(settings, timeframe = "H1") {
  const compass = macroCompass();
  const activeSignals = signals();
  const risk = riskState(settings);
  return {
    generatedAt: iso(),
    tradeDecision: tradeDecision(compass, activeSignals, risk),
    macroCompass: compass,
    activeSignals,
    positions: positions(),
    risk,
    kline: {
      symbol: "XAUUSD",
      timeframe,
      candles: makeKlines(timeframe),
      keyLevels: [
        { label: "日线压力", price: 2402.8 },
        { label: "H4 枢轴", price: 2382.2 },
        { label: "风控止损", price: 2371.8 },
        { label: "低吸区", price: 2363.5 }
      ],
      signalEntries: signals().filter((item) => item.entry).map((item) => ({
        id: item.id,
        grade: item.grade,
        direction: item.direction,
        type: item.type,
        title: item.title,
        price: item.entry
      }))
    }
  };
}

export function signalCenter() {
  const list = signals();
  const stats = [
    { label: "S 级", count: 18, winRate: 72, avgReturn: 1.36 },
    { label: "A 级", count: 44, winRate: 63, avgReturn: 0.82 },
    { label: "B 级", count: 71, winRate: 54, avgReturn: 0.28 },
    { label: "C 级", count: 38, winRate: 48, avgReturn: -0.05 }
  ];
  return {
    signals: list,
    matrix: resonanceMatrix(4),
    stats,
    typeStats: [
      { type: "区间回归", trades: 64, winRate: 61, pnl: 8.4 },
      { type: "突破", trades: 49, winRate: 58, pnl: 11.7 },
      { type: "假突破", trades: 31, winRate: 55, pnl: 4.2 },
      { type: "事件驱动", trades: 27, winRate: 46, pnl: -1.1 }
    ]
  };
}

export function macroMonitor() {
  const compass = macroCompass();
  const events = [
    { name: "FOMC 利率决议", type: "FOMC", at: iso(8 * DAY), impact: "high" },
    { name: "美国非农就业", type: "NFP", at: iso(13 * DAY), impact: "high" },
    { name: "美国 CPI", type: "CPI", at: iso(20 * DAY), impact: "high" },
    { name: "PCE 物价指数", type: "PCE", at: iso(27 * DAY), impact: "medium" }
  ].map((event, index) => ({
    ...event,
    countdownMinutes: minutesUntil(event.at),
    countdownDays: Math.ceil(minutesUntil(event.at) / 1440),
    isNext: index === 0
  }));
  return {
    indicators: compass.factors,
    scoreHistory: makeSeries(90, Date.now() - 89 * DAY, DAY, 58, 12, 0.07),
    events,
    centralBankGold: [
      { quarter: "2025 Q3", tonnes: 173, direction: "增持" },
      { quarter: "2025 Q4", tonnes: 196, direction: "增持" },
      { quarter: "2026 Q1", tonnes: 184, direction: "增持" },
      { quarter: "2026 Q2", tonnes: 157, direction: "放缓" }
    ]
  };
}

export function tradeCenter() {
  const goldCurve = makeKlines("D").slice(-80).map((candle) => ({
    t: candle.t,
    v: candle.close
  }));
  return {
    account: {
      currency: "USDT",
      initialBalance: 10000,
      balance: 10000,
      availableMargin: 10000,
      usedMargin: 0,
      floatingPnl: 0
    },
    positions: [],
    history: [],
    pnlCurve: goldCurve.map((point) => ({ t: point.t, v: 10000 })),
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
    attribution: []
  };
}

export function backtestCatalog(settings) {
  return {
    parameters: {
      rangeDays: 120,
      atrThreshold: 1.12,
      resonanceWeight: settings.strategy.weights,
      positionFactor: settings.risk.maxPositionPct / 100,
      minSignalLevel: "B",
      allowBSignals: true,
      allowCSignals: false,
      from: "2025-01-01",
      to: "2026-07-05"
    },
    lastRuns: [
      createBacktestResult({ name: "主策略 v0.1", rangeDays: 365, atrThreshold: 1.12, positionFactor: 0.12 }),
      createBacktestResult({ name: "低仓位风控", rangeDays: 365, atrThreshold: 1.25, positionFactor: 0.08 })
    ]
  };
}

export function createBacktestResult(input = {}) {
  const rangeDays = Number(input.rangeDays || 180);
  const atrThreshold = Number(input.atrThreshold || 1.12);
  const positionFactor = Number(input.positionFactor || 0.1);
  const allowCSignals = input.allowCSignals === true;
  const allowBSignals = allowCSignals || input.allowBSignals !== false;
  const tradeCount = Math.max(12, Math.round(rangeDays / 7));
  const winRate = Math.max(42, Math.min(71, Math.round(58 + (atrThreshold - 1) * 14 - positionFactor * 20)));
  const annualReturn = round(14 + positionFactor * 80 - atrThreshold * 2, 2);
  const maxDrawdown = round(-(4 + positionFactor * 32 + Math.abs(atrThreshold - 1.15) * 5), 2);
  const equity = makeSeries(60, Date.now() - 59 * DAY, DAY, 100000, 1600, annualReturn * 5);
  return {
    id: `BT-${Date.now()}-${Math.round(Math.random() * 999)}`,
    name: input.name || "参数实验",
    createdAt: iso(),
    params: {
      from: input.from || "2025-01-01",
      to: input.to || "2026-07-05",
      rangeDays,
      atrThreshold,
      positionFactor,
      minSignalLevel: allowCSignals ? "C" : allowBSignals ? "B" : "A",
      allowBSignals,
      allowCSignals,
      macroWeight: Number(input.macroWeight || 0.42),
      technicalWeight: Number(input.technicalWeight || 0.38),
      flowWeight: Number(input.flowWeight || 0.2)
    },
    metrics: {
      annualReturn,
      maxDrawdown,
      winRate,
      profitFactor: round(1.18 + (winRate - 50) / 80, 2),
      sharpe: round(0.85 + annualReturn / 45, 2),
      calmar: round(annualReturn / Math.abs(maxDrawdown), 2),
      trades: tradeCount,
      expectancyR: round((winRate - 50) / 42, 2)
    },
    equity,
    monthlyReturns: Array.from({ length: 12 }, (_, index) => ({
      month: `M${index + 1}`,
      value: round(annualReturn / 12 + wave(index, 1.9, 0.77), 2)
    })),
    drawdownWindows: [
      { start: "2025-04-08", end: "2025-05-02", drawdown: round(maxDrawdown * 0.74, 2) },
      { start: "2026-02-14", end: "2026-03-05", drawdown: maxDrawdown }
    ],
    tradeDistribution: [
      { bucket: "< -1R", count: Math.round(tradeCount * 0.16) },
      { bucket: "-1R 至 0", count: Math.round(tradeCount * 0.25) },
      { bucket: "0 至 1R", count: Math.round(tradeCount * 0.36) },
      { bucket: "> 1R", count: Math.round(tradeCount * 0.23) }
    ],
    monteCarlo: Array.from({ length: Number(input.monteCarloRuns || 80) }, (_, index) => ({
      run: index + 1,
      terminalReturn: round(annualReturn + wave(index, 7, 0.49), 2),
      maxDrawdown: round(maxDrawdown - Math.abs(wave(index, 3, 0.63)), 2)
    }))
  };
}

export function deploymentInfo(startedAt) {
  return {
    version: "0.1.0",
    startedAt,
    uptimeSeconds: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000),
    dataLatencySeconds: 0,
    routeBase: "/quant/",
    apiBase: "/quant/api/",
    tradingEnabled: process.env.TRADING_ENABLED === "true"
  };
}

export function logs() {
  return [
    { at: iso(-7 * 60000), level: "info", message: "XAU terminal runtime started" },
    { at: iso(-6 * 60000), level: "warn", message: "Market data provider not configured" },
    { at: iso(-5 * 60000), level: "info", message: "Trading execution disabled by environment" },
    { at: iso(-2 * 60000), level: "info", message: "Architecture modules loaded" }
  ];
}
