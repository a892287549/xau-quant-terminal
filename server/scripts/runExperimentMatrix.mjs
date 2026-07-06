import { createDatabase } from "../db/postgres.js";
import { Storage } from "../db/storage.js";
import { MacroFetcher } from "../data/macroFetcher.js";
import { SettingsStore } from "../settingsStore.mjs";
import { runBacktest } from "../engine/backtestEngine.js";

const INSTRUMENT = process.env.EXPERIMENT_INSTRUMENT || "XAU_USD";
const TIMEFRAME = process.env.EXPERIMENT_TIMEFRAME || "H1";

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function pct(value) {
  return `${round(value)}%`;
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1);
}

function commonInput({ from, to, rangeDays }) {
  return {
    from,
    to,
    rangeDays,
    initialEquity: Number(process.env.EXPERIMENT_INITIAL_EQUITY || 100000),
    positionFactor: 0.12,
    perTradeRiskPct: 2,
    allowBSignals: true,
    allowCSignals: false,
    minSignalLevel: "B",
    enabledSignalTypes: {
      range_revert: false,
      breakout: true,
      fakeout: true,
      momentum: false,
      support_reversal: false,
      structural_breakdown: false
    },
    fakeoutVolumeFilter: true,
    flowResonanceMode: "relaxed",
    fixedStopAtrMultiplier: 1.5,
    dynamicStopHigh: 2.0,
    dynamicStopMedium: 1.5,
    dynamicStopLow: 1.2,
    dynamicStopHighThreshold: 1.3,
    dynamicStopLowThreshold: 0.8,
    trailingStopEnabled: true,
    fakeoutTakeProfitAtr: 1.5,
    fakeoutMaxHoldH4Bars: 12,
    breakoutMaxHoldH4Bars: 24,
    rangeRevertMaxHoldH4Bars: 18,
    bollingerRegimeFilter: false,
    previousDayLevelBoost: false,
    rsiDivergenceBoost: false,
    londonOpenDirectionFilter: false,
    supportReversalEntry: "retest",
    supportReversalSlowFilter: true,
    structuralBreakdownUseFundingData: false,
    monteCarloRuns: 100
  };
}

function enhancedBase(common) {
  return {
    ...common,
    dynamicATRStop: true,
    adaptiveLeverage: false,
    perTradeRiskPct: 2,
    bollingerRegimeFilter: true,
    previousDayLevelBoost: true,
    rsiDivergenceBoost: true,
    londonOpenDirectionFilter: true
  };
}

function newSystemBase(common) {
  return {
    ...enhancedBase(common),
    enabledSignalTypes: {
      range_revert: false,
      breakout: true,
      fakeout: true,
      momentum: false,
      support_reversal: true,
      structural_breakdown: true
    },
    newExitRules: true,
    pnlMultiplier: 1,
    minOrderSize: 0.01,
    fakeoutStopAtrMultiplier: 1.5,
    breakoutStopAtrMultiplier: 2.0,
    fakeoutTakeProfitR: 1.5,
    supportReversalTp1R: 2,
    supportReversalEntry: "retest",
    supportReversalSlowFilter: true,
    structuralBreakdownUseFundingData: false,
    structuralBreakdownThresholdA: 15,
    structuralBreakdownThresholdS: 25,
    structuralBreakdownAllowedUtcStart: 0,
    structuralBreakdownAllowedUtcEnd: 23,
    structuralBreakdownPositionFactor: 1,
    dailyStopLimit: 3,
    dailyLossLimitUsd: 600,
    maxDailyTrades: 4
  };
}

function finalFixedRiskBase(common) {
  return {
    ...newSystemBase(common),
    sizingMode: "fixed_dollar",
    fixedRiskS: 200,
    fixedRiskA: 200,
    fixedRiskB: 200,
    fixedRiskC: 200,
    fakeoutPartialTakeProfit: true,
    fakeoutTp1R: 1,
    fakeoutTrailingMaPeriod: 5,
    supportReversalTp1R: 2,
    supportReversalTrailAfterTp1: true,
    structuralBreakdownThresholdA: 12,
    structuralBreakdownThresholdS: 22,
    dailyStopLimit: 3,
    dailyLossLimitUsd: 600,
    maxDailyTrades: 4
  };
}

function bBoostV1Base(common) {
  return {
    ...enhancedBase(common),
    name: "server-matrix-bboost-v1",
    fakeoutPartialTakeProfit: true,
    fakeoutTp1R: 1.5,
    fakeoutTrailingMaPeriod: 10,
    fakeoutMaExitOnClose: true,
    fakeoutDisableTimeoutAfterTp1: true
  };
}

function bBoostV2Base(common) {
  return {
    ...bBoostV1Base(common),
    name: "server-matrix-bboost-v2",
    enabledSignalTypes: {
      range_revert: false,
      breakout: true,
      fakeout: true,
      momentum: false,
      support_reversal: false,
      structural_breakdown: true
    },
    structuralBreakdownUseFundingData: false,
    structuralBreakdownThresholdA: 12,
    structuralBreakdownThresholdS: 22,
    structuralBreakdownAllowedUtcStart: 0,
    structuralBreakdownAllowedUtcEnd: 23,
    structuralBreakdownPositionFactor: 1,
    structuralTakeProfitR: 2
  };
}

function experimentGroups(range) {
  const common = commonInput(range);
  return [
    {
      key: "bestB",
      name: "组B(当前最优): 动态ATR + 四增强",
      input: {
        ...enhancedBase(common),
        name: "server-matrix-bestB-current"
      }
    },
    {
      key: "newA",
      name: "新系统A: 固定美元风险",
      input: {
        ...newSystemBase(common),
        name: "server-matrix-newA-fixed-dollar",
        sizingMode: "fixed_dollar",
        fixedRiskS: 300,
        fixedRiskA: 200,
        fixedRiskB: 100
      }
    },
    {
      key: "newB",
      name: "新系统B: 百分比风险2%",
      input: {
        ...newSystemBase(common),
        name: "server-matrix-newB-percent-risk",
        sizingMode: "percent_risk",
        perTradeRiskPct: 2
      }
    },
    {
      key: "newBExitPatch",
      name: "新B变体: fakeout半仓1.5R + breakout组B统一退出",
      input: {
        ...newSystemBase(common),
        name: "server-matrix-newB-exit-patch",
        sizingMode: "percent_risk",
        perTradeRiskPct: 2,
        fakeoutPartialTakeProfit: true,
        fakeoutTp1R: 1.5,
        fakeoutTrailingMaPeriod: 10,
        fakeoutMaExitOnClose: true,
        legacyBreakoutExit: true
      }
    },
    {
      key: "newBExitNoStruct",
      name: "新B最终版: 修复退出 + 关闭structural_breakdown",
      input: {
        ...newSystemBase(common),
        name: "server-matrix-newB-exit-no-struct",
        sizingMode: "percent_risk",
        perTradeRiskPct: 2,
        enabledSignalTypes: {
          range_revert: false,
          breakout: true,
          fakeout: true,
          momentum: false,
          support_reversal: true,
          structural_breakdown: false
        },
        fakeoutPartialTakeProfit: true,
        fakeoutTp1R: 1.5,
        fakeoutTrailingMaPeriod: 10,
        fakeoutMaExitOnClose: true,
        legacyBreakoutExit: true
      }
    },
    {
      key: "newC",
      name: "新C(最终版): 固定$200 + 放开止盈",
      input: {
        ...finalFixedRiskBase(common),
        name: "server-matrix-newC-final-fixed-200"
      }
    },
    {
      key: "newD",
      name: "新D(高频对比): 新C + 单日8单/亏损熔断$1000",
      input: {
        ...finalFixedRiskBase(common),
        name: "server-matrix-newD-high-frequency",
        dailyLossLimitUsd: 1000,
        maxDailyTrades: 8
      }
    },
    {
      key: "bBoostV1",
      name: "B增-v1: fakeout半仓1.5R + MA10",
      input: bBoostV1Base(common)
    },
    {
      key: "bBoostV2",
      name: "B增-v2: v1 + structural放宽/2R/MA20",
      input: bBoostV2Base(common)
    },
    {
      key: "bBoostV3",
      name: "B增-v3: v2 + breakout宏观方向过滤",
      input: {
        ...bBoostV2Base(common),
        name: "server-matrix-bboost-v3",
        breakoutMacroDirectionFilter: true
      }
    }
  ];
}

function summarizeBy(trades, key) {
  const map = new Map();
  for (const trade of trades) {
    const value = trade[key] || "unknown";
    const item = map.get(value) || { label: value, trades: 0, pnl: 0, wins: 0 };
    item.trades += 1;
    item.pnl += Number(trade.pnl || 0);
    if (Number(trade.pnl || 0) > 0) item.wins += 1;
    map.set(value, item);
  }
  return Array.from(map.values())
    .map((item) => ({
      ...item,
      pnl: round(item.pnl),
      winRate: item.trades ? Math.round((item.wins / item.trades) * 100) : 0
    }))
    .sort((a, b) => b.trades - a.trades);
}

function segmentTrades(trades, from, to) {
  const start = new Date(from);
  const end = new Date(to);
  const segments = [];
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) {
    for (const half of [1, 2]) {
      const segStart = new Date(Date.UTC(year, half === 1 ? 0 : 6, 1));
      const segEnd = new Date(Date.UTC(year, half === 1 ? 5 : 11, half === 1 ? 30 : 31, 23, 59, 59));
      if (segEnd < start || segStart > end) continue;
      const scoped = trades.filter((trade) => {
        const closed = new Date(trade.closedAt || trade.openedAt);
        return closed >= segStart && closed <= segEnd;
      });
      const wins = scoped.filter((trade) => Number(trade.pnl || 0) > 0).length;
      segments.push({
        label: `${year}H${half}`,
        trades: scoped.length,
        pnl: round(scoped.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0)),
        winRate: scoped.length ? Math.round((wins / scoped.length) * 100) : 0
      });
    }
  }
  return segments;
}

function formatList(items) {
  return items.length
    ? items.map((item) => `${item.label}: ${item.trades}笔 / PnL ${item.pnl} / 胜率 ${item.winRate}%`).join("; ")
    : "无";
}

function streaks(trades) {
  let win = 0;
  let loss = 0;
  let maxWin = 0;
  let maxLoss = 0;
  for (const trade of trades) {
    const pnl = Number(trade.pnl || 0);
    if (pnl > 0) {
      win += 1;
      loss = 0;
    } else if (pnl < 0) {
      loss += 1;
      win = 0;
    } else {
      win = 0;
      loss = 0;
    }
    maxWin = Math.max(maxWin, win);
    maxLoss = Math.max(maxLoss, loss);
  }
  return { maxWin, maxLoss };
}

function tradeStats(trades) {
  const wins = trades.map((trade) => Number(trade.pnl || 0)).filter((pnl) => pnl > 0);
  const losses = trades.map((trade) => Number(trade.pnl || 0)).filter((pnl) => pnl < 0);
  const avgWin = wins.length ? wins.reduce((sum, pnl) => sum + pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((sum, pnl) => sum + pnl, 0) / losses.length : 0;
  return {
    maxWinTrade: wins.length ? round(Math.max(...wins)) : 0,
    maxLossTrade: losses.length ? round(Math.min(...losses)) : 0,
    avgWin: round(avgWin),
    payoffRatio: avgLoss ? round(avgWin / Math.abs(avgLoss), 2) : 0,
    ...streaks(trades)
  };
}

function monthlyPnl(trades) {
  const map = new Map();
  for (const trade of trades) {
    const month = String(trade.closedAt || trade.openedAt || "").slice(0, 7);
    if (!month) continue;
    map.set(month, round((map.get(month) || 0) + Number(trade.pnl || 0)));
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, pnl]) => `${month}:${pnl}`)
    .join(" | ") || "无";
}

function formatRun(run, range) {
  const metrics = run.result.metrics;
  const totalPnl = round(run.trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
  const annualPnl = round(totalPnl * (365 / Math.max(1, range.rangeDays)));
  const stats = tradeStats(run.trades);
  const lines = [
    `=== ${run.name} ===`,
    `run_id: ${run.result.id}`,
    `数据源: ${run.result.dataSource}`,
    `参数: sizing=${run.result.params.sizingMode} | newExit=${run.result.params.newExitRules} | dynamicATR=${run.result.params.dynamicATRStop} | adaptive=${run.result.params.adaptiveLeverage} | enabled=${Object.entries(run.result.params.enabledSignalTypes).filter(([, enabled]) => enabled).map(([key]) => key).join(",")}`,
    `总体: trades=${metrics.trades} | Sharpe=${metrics.sharpe} | 胜率=${pct(metrics.winRate)} | MDD=${pct(metrics.maxDrawdown)} | PF=${metrics.profitFactor} | 年化P&L=$${annualPnl} | 总PnL=$${totalPnl}`,
    `单笔: 最大盈利=$${stats.maxWinTrade} | 最大亏损=$${stats.maxLossTrade} | 平均盈利=$${stats.avgWin} | 盈亏比=${stats.payoffRatio}`,
    `连胜连亏: 连盈=${stats.maxWin} | 连亏=${stats.maxLoss}`,
    `方向: ${formatList(summarizeBy(run.trades, "direction"))}`,
    `信号: ${formatList(summarizeBy(run.trades, "signalType"))}`,
    `退出: ${formatList(summarizeBy(run.trades, "reason"))}`,
    `月度PnL: ${monthlyPnl(run.trades)}`
  ];
  return lines.join("\n");
}

function january2026Details(trades) {
  return trades
    .filter((trade) => {
      const day = dateOnly(trade.openedAt || trade.closedAt);
      return day >= "2026-01-01" && day <= "2026-01-31";
    })
    .map((trade) => [
      dateOnly(trade.openedAt || trade.closedAt),
      trade.direction,
      trade.signalGrade,
      `entry=${round(trade.entry)}`,
      `exit=${round(trade.exit)}`,
      `pnl=${round(trade.pnl)}`,
      `R=${round(trade.rMultiple)}`,
      `reason=${trade.reason || "unknown"}`,
      `score=${trade.sentinelScore ?? trade.sentinel?.score ?? trade.riskDetails?.sentinelScore ?? ""}`
    ].filter(Boolean).join(" | "));
}

async function candleBounds(db) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count, MIN(time) AS min_time, MAX(time) AS max_time
     FROM candles
     WHERE instrument = $1 AND timeframe = $2`,
    [INSTRUMENT, TIMEFRAME]
  );
  const row = result.rows[0] || {};
  return {
    count: Number(row.count || 0),
    from: row.min_time ? new Date(row.min_time).toISOString() : "",
    to: row.max_time ? new Date(row.max_time).toISOString() : ""
  };
}

const db = createDatabase();
const storage = new Storage(db);
const dataDir = process.env.DATA_DIR || new URL("../../data", import.meta.url).pathname;
const settingsStore = new SettingsStore(dataDir, storage);
const macroFetcher = new MacroFetcher({ dataDir, storage });

try {
  if (!db.enabled) throw new Error("DATABASE_URL is required; refusing to run experiment matrix without PostgreSQL");
  await storage.init();
  const bounds = await candleBounds(db);
  if (bounds.count < 30) throw new Error(`not enough ${INSTRUMENT} ${TIMEFRAME} candles in PostgreSQL: ${bounds.count}`);

  const from = process.env.EXPERIMENT_FROM ? new Date(process.env.EXPERIMENT_FROM).toISOString() : bounds.from;
  const to = process.env.EXPERIMENT_TO ? new Date(process.env.EXPERIMENT_TO).toISOString() : bounds.to;
  const range = { from, to, rangeDays: daysBetween(from, to) };
  const selected = new Set(String(process.env.EXPERIMENT_GROUPS || "newC,newD").split(",").map((item) => item.trim()).filter(Boolean));
  const settings = await settingsStore.read();
  const macroSnapshot = await macroFetcher.getSnapshot();
  const groups = experimentGroups(range).filter((group) => selected.has(group.key));
  const runs = [];

  for (const group of groups) {
    const { result, trades } = await runBacktest({
      storage,
      macroSnapshot,
      settings,
      input: group.input
    });
    runs.push({ ...group, result, trades });
  }

  console.log([
    `服务器实验矩阵: ${Array.from(selected).join(", ")}`,
    `数据库: PostgreSQL via DATABASE_URL`,
    `K线: ${INSTRUMENT} ${TIMEFRAME} count=${bounds.count}, ${dateOnly(bounds.from)} -> ${dateOnly(bounds.to)}, rangeDays=${range.rangeDays}`,
    `宏观: ${macroSnapshot?.bias || macroSnapshot?.compass?.bias || "unknown"}`,
    "",
    ...runs.map((run) => formatRun(run, range))
  ].join("\n\n"));
} finally {
  await db.close?.();
}
