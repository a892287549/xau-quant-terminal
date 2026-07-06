import { runBacktest } from "./backtestEngine.js";
import { STRUCTURAL_BREAKDOWN_TYPE } from "./sentinel.js";

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function daysBetween(from, to) {
  return Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1);
}

function sum(values) {
  return round(values.reduce((total, value) => total + Number(value || 0), 0));
}

function enabledTypes(values) {
  return {
    range_revert: Boolean(values.range_revert),
    breakout: Boolean(values.breakout),
    fakeout: Boolean(values.fakeout),
    momentum: Boolean(values.momentum),
    support_reversal: Boolean(values.support_reversal),
    structural_breakdown: Boolean(values.structural_breakdown)
  };
}

function fullV2Types(structural = false) {
  return enabledTypes({
    range_revert: true,
    breakout: true,
    fakeout: true,
    momentum: true,
    support_reversal: true,
    structural_breakdown: structural
  });
}

export function experimentGroups({ from = "2024-01-01", to = todayInShanghai(), initialEquity = 100000 } = {}) {
  const rangeDays = daysBetween(from, to);
  const common = {
    from,
    to,
    rangeDays,
    initialEquity,
    positionFactor: 0.12,
    allowBSignals: true,
    allowCSignals: false,
    monteCarloRuns: 100
  };
  const group4 = {
    ...common,
    enabledSignalTypes: fullV2Types(false),
    fakeoutVolumeFilter: true,
    flowResonanceMode: "relaxed",
    bollingerRegimeFilter: true,
    previousDayLevelBoost: true,
    rsiDivergenceBoost: true,
    londonOpenDirectionFilter: true,
    supportReversalEntry: "retest",
    supportReversalSlowFilter: true,
    adaptiveLeverage: true
  };

  return [
    {
      id: 1,
      name: "组 1: v2.0核心基线（突破 + 假突破）",
      input: {
        ...common,
        name: "组 1: v2.0核心基线",
        enabledSignalTypes: enabledTypes({ breakout: true, fakeout: true }),
        fakeoutVolumeFilter: false,
        flowResonanceMode: "strict"
      }
    },
    {
      id: 2,
      name: "组 2: 核心 + 斐波回归 + 时段动量",
      input: {
        ...common,
        name: "组 2: 四信号扩展",
        enabledSignalTypes: enabledTypes({ range_revert: true, breakout: true, fakeout: true, momentum: true }),
        fakeoutVolumeFilter: true,
        flowResonanceMode: "relaxed"
      }
    },
    {
      id: 3,
      name: "组 3: 组2 + 支撑反转",
      input: {
        ...common,
        name: "组 3: 支撑反转版",
        enabledSignalTypes: fullV2Types(false),
        fakeoutVolumeFilter: true,
        flowResonanceMode: "relaxed",
        supportReversalEntry: "retest",
        supportReversalSlowFilter: true
      }
    },
    {
      id: 4,
      name: "组 4: 全策略 v2.0（增强 + 风控）",
      input: {
        ...group4,
        name: "组 4: 全策略 v2.0"
      }
    },
    {
      id: 5,
      name: "组 5: 全策略 + structural_breakdown 最小版",
      input: {
        ...group4,
        name: "组 5: 全策略 + 结构崩溃最小版",
        enabledSignalTypes: fullV2Types(true),
        structuralBreakdownUseFundingData: false,
        structuralBreakdownThresholdA: 30,
        structuralBreakdownThresholdS: 40,
        structuralBreakdownPositionFactor: 0.5
      }
    },
    {
      id: 6,
      name: "组 6: 全策略 + structural_breakdown 完整版",
      input: {
        ...group4,
        name: "组 6: 全策略 + 结构崩溃完整版",
        enabledSignalTypes: fullV2Types(true),
        structuralBreakdownUseFundingData: true,
        structuralBreakdownThresholdA: 45,
        structuralBreakdownThresholdS: 60,
        structuralBreakdownPositionFactor: 0.5
      }
    }
  ];
}

function bySignalType(trades) {
  const map = new Map();
  for (const trade of trades) {
    const type = trade.signalType || trade.type || "unknown";
    const item = map.get(type) || { type, trades: 0, pnl: 0, wins: 0, losses: 0, avgR: 0 };
    item.trades += 1;
    item.pnl += Number(trade.pnl || 0);
    item.avgR += Number(trade.rMultiple || 0);
    if (Number(trade.pnl || 0) > 0) item.wins += 1;
    if (Number(trade.pnl || 0) < 0) item.losses += 1;
    map.set(type, item);
  }
  return Array.from(map.values())
    .map((item) => ({
      ...item,
      pnl: round(item.pnl),
      winRate: item.trades ? Math.round((item.wins / item.trades) * 100) : 0,
      avgR: item.trades ? round(item.avgR / item.trades, 2) : 0
    }))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

function tradesInRange(trades, from, to) {
  return trades.filter((trade) => {
    const day = dateOnly(trade.openedAt || trade.closedAt);
    return day >= from && day <= to;
  });
}

function tradesOnDays(trades, days) {
  return trades.filter((trade) => days.has(dateOnly(trade.openedAt || trade.closedAt)));
}

function jan2026Check(trades) {
  const jan = tradesInRange(trades, "2026-01-01", "2026-01-31");
  const structural = jan.filter((trade) => trade.signalType === STRUCTURAL_BREAKDOWN_TYPE);
  const structuralDays = new Set(structural.map((trade) => dateOnly(trade.openedAt || trade.closedAt)));
  const scoped = structuralDays.size ? tradesOnDays(jan, structuralDays) : jan;
  const fakeoutLosses = scoped
    .filter((trade) => trade.signalType === "fakeout" && Number(trade.pnl || 0) < 0)
    .map((trade) => Number(trade.pnl || 0));
  return {
    window: "2026-01",
    trades: jan.length,
    structuralTriggered: structural.length > 0,
    structuralTrades: structural.length,
    structuralDays: Array.from(structuralDays),
    structuralPnl: sum(structural.map((trade) => trade.pnl)),
    fakeoutLossOnStructuralDays: sum(fakeoutLosses),
    combinedPnlOnStructuralDays: sum(scoped.map((trade) => trade.pnl)),
    combinedPnlPositive: sum(scoped.map((trade) => trade.pnl)) > 0
  };
}

function dailyCandles(candles) {
  const map = new Map();
  for (const candle of candles) {
    const key = dateOnly(candle.t);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        t: key,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume || 0)
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += Number(candle.volume || 0);
  }
  return Array.from(map.values()).sort((a, b) => a.t.localeCompare(b.t));
}

function extremeDays(candles, year, limit = 8) {
  return dailyCandles(candles)
    .filter((candle) => candle.t.startsWith(String(year)))
    .map((candle) => ({
      day: candle.t,
      rangePct: candle.close ? ((candle.high - candle.low) / candle.close) * 100 : 0,
      direction: candle.close >= candle.open ? "UP" : "DOWN",
      close: candle.close
    }))
    .sort((a, b) => b.rangePct - a.rangePct)
    .slice(0, limit)
    .map((item) => ({ ...item, rangePct: round(item.rangePct, 2), close: round(item.close) }));
}

function extremeCheck(trades, candles, year) {
  const days = extremeDays(candles, year);
  const daySet = new Set(days.map((item) => item.day));
  const scoped = tradesOnDays(trades, daySet);
  return {
    year,
    days,
    trades: scoped.length,
    structuralTrades: scoped.filter((trade) => trade.signalType === STRUCTURAL_BREAKDOWN_TYPE).length,
    structuralPnl: sum(scoped.filter((trade) => trade.signalType === STRUCTURAL_BREAKDOWN_TYPE).map((trade) => trade.pnl)),
    fakeoutLoss: sum(scoped.filter((trade) => trade.signalType === "fakeout" && Number(trade.pnl || 0) < 0).map((trade) => trade.pnl)),
    combinedPnl: sum(scoped.map((trade) => trade.pnl)),
    byType: bySignalType(scoped)
  };
}

export async function runExperimentMatrix({ storage, macroSnapshot, settings, range = {} } = {}) {
  const groups = experimentGroups(range);
  const runs = [];
  for (const group of groups) {
    const { result, trades } = await runBacktest({
      storage,
      macroSnapshot,
      settings,
      input: group.input
    });
    runs.push({
      id: group.id,
      name: group.name,
      result,
      trades,
      attribution: bySignalType(trades)
    });
  }

  const from = groups[0].input.from;
  const to = groups[0].input.to;
  const candles = await storage?.getCandles?.({
    instrument: "XAU_USD",
    timeframe: "H1",
    from,
    to,
    limit: Math.max(120, daysBetween(from, to) * 24)
  }) || [];
  const group6 = runs.find((run) => run.id === 6);
  const focus = group6
    ? {
      january2026: jan2026Check(group6.trades),
      extreme2024: extremeCheck(group6.trades, candles, 2024),
      extreme2025: extremeCheck(group6.trades, candles, 2025)
    }
    : null;
  return { runs, focus, range: { from, to, rangeDays: groups[0].input.rangeDays } };
}

function metricLine(metrics) {
  return [
    `年化 ${metrics.annualReturn}%`,
    `最大回撤 ${metrics.maxDrawdown}%`,
    `胜率 ${metrics.winRate}%`,
    `PF ${metrics.profitFactor}`,
    `Sharpe ${metrics.sharpe}`,
    `Calmar ${metrics.calmar}`,
    `交易 ${metrics.trades}`,
    `期望 ${metrics.expectancyR}R`
  ].join(" | ");
}

function typeLine(items) {
  if (!items.length) return "无交易";
  return items.map((item) => `${item.type}: ${item.trades}笔 / PnL ${item.pnl} / 胜率 ${item.winRate}% / ${item.avgR}R`).join("; ");
}

function focusLine(check) {
  const combinedPositive = check.combinedPnlPositive ?? ((check.combinedPnl || 0) > 0);
  return [
    `交易 ${check.trades}`,
    `结构崩溃 ${check.structuralTrades}笔`,
    `结构PnL ${check.structuralPnl}`,
    `假突破亏损 ${check.fakeoutLoss ?? check.fakeoutLossOnStructuralDays}`,
    `合并PnL ${check.combinedPnl ?? check.combinedPnlOnStructuralDays}`,
    `合并为正 ${combinedPositive ? "是" : "否"}`
  ].join(" | ");
}

export function formatExperimentReport(matrix) {
  const lines = [
    `实验区间: ${matrix.range.from} -> ${matrix.range.to} (${matrix.range.rangeDays}天)`,
    ""
  ];
  for (const run of matrix.runs) {
    lines.push(`=== ${run.name} ===`);
    lines.push(metricLine(run.result.metrics));
    lines.push(`数据源: ${run.result.dataSource || "unknown"}${run.result.warning ? ` | warning: ${run.result.warning}` : ""}`);
    lines.push(`参数: enabled=${Object.entries(run.result.params.enabledSignalTypes || {}).filter(([, enabled]) => enabled).map(([key]) => key).join(",") || "none"} | structuralFunding=${run.result.params.structuralBreakdownUseFundingData}`);
    lines.push(`交易分布: ${run.result.tradeDistribution.map((item) => `${item.bucket}:${item.count}`).join(" | ")}`);
    lines.push(`类型归因: ${typeLine(run.attribution)}`);
    lines.push("");
  }
  if (matrix.focus) {
    lines.push("=== 组 6 重点验证 ===");
    const jan = matrix.focus.january2026;
    lines.push(`2026-01: ${focusLine(jan)} | 结构触发日: ${jan.structuralDays.join(",") || "无"}`);
    for (const key of ["extreme2024", "extreme2025"]) {
      const check = matrix.focus[key];
      lines.push(`${check.year} 极端日: ${focusLine(check)}`);
      lines.push(`极端日列表: ${check.days.map((day) => `${day.day}(${day.direction},${day.rangePct}%)`).join(",") || "无K线"}`);
      lines.push(`极端日归因: ${typeLine(check.byType)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
