import { runSignalEngine } from "./signalEngine.js";
import { STRUCTURAL_BREAKDOWN_TYPE, aggregateCandles, movingAverage } from "./sentinel.js";
import * as mock from "../mockData.mjs";

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function maxDrawdownPct(equity) {
  let peak = equity[0]?.v || 100000;
  let maxDd = 0;
  for (const point of equity) {
    peak = Math.max(peak, point.v);
    const dd = ((point.v - peak) / peak) * 100;
    maxDd = Math.min(maxDd, dd);
  }
  return round(maxDd);
}

function sharpeFromEquity(equity) {
  if (equity.length < 3) return 0;
  const returns = [];
  for (let index = 1; index < equity.length; index += 1) {
    returns.push((equity[index].v - equity[index - 1].v) / equity[index - 1].v);
  }
  const avg = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - avg) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std ? round((avg / std) * Math.sqrt(252), 2) : 0;
}

function monthlyReturns(equity) {
  const byMonth = new Map();
  for (const point of equity) {
    const month = point.t.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, { first: point.v, last: point.v });
    byMonth.get(month).last = point.v;
  }
  return Array.from(byMonth.entries()).map(([month, item]) => ({
    month,
    value: round(((item.last - item.first) / item.first) * 100)
  }));
}

function tradeDistribution(trades) {
  return [
    { bucket: "< -1R", count: trades.filter((trade) => trade.rMultiple < -1).length },
    { bucket: "-1R 至 0", count: trades.filter((trade) => trade.rMultiple >= -1 && trade.rMultiple < 0).length },
    { bucket: "0 至 1R", count: trades.filter((trade) => trade.rMultiple >= 0 && trade.rMultiple < 1).length },
    { bucket: "> 1R", count: trades.filter((trade) => trade.rMultiple >= 1).length }
  ];
}

function boolParam(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function numberParam(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const GRADE_RANK = { S: 0, A: 1, B: 2, C: 3 };
const GRADE_MULTIPLIER = { S: 1.5, A: 1, B: 0.5, C: 0.25 };
const SIGNAL_TYPES = ["range_revert", "breakout", "fakeout", "momentum", "support_reversal", STRUCTURAL_BREAKDOWN_TYPE];

function normalizeGrade(value, fallback = "B") {
  const grade = String(value || "").toUpperCase();
  return Object.hasOwn(GRADE_RANK, grade) ? grade : fallback;
}

function signalAdmissionParams(input) {
  const requestedMinLevel = input.minSignalLevel ? normalizeGrade(input.minSignalLevel, "B") : "";
  const allowCSignals = boolParam(input.allowCSignals, requestedMinLevel === "C");
  const allowBSignals = allowCSignals || boolParam(input.allowBSignals, requestedMinLevel ? ["B", "C"].includes(requestedMinLevel) : true);
  return {
    allowBSignals,
    allowCSignals,
    minSignalLevel: allowCSignals ? "C" : allowBSignals ? "B" : "A"
  };
}

function positionMultiplierForSignal(signal, params) {
  const grade = normalizeGrade(signal.grade || signal.level, "");
  if (!grade || GRADE_RANK[grade] > GRADE_RANK[params.minSignalLevel]) return 0;
  if (grade === "B" && !params.allowBSignals) return 0;
  if (grade === "C" && !params.allowCSignals) return 0;
  const structuralFactor = signal.type === STRUCTURAL_BREAKDOWN_TYPE
    ? Number(params.structuralBreakdownPositionFactor || 0.5)
    : 1;
  return (GRADE_MULTIPLIER[grade] || 0) * structuralFactor;
}

function enabledSignalTypesParam(input, settings = {}) {
  const configured = settings?.strategy?.enabledSignalTypes || {};
  return {
    range_revert: boolParam(input.enableRangeRevert ?? input.enabledSignalTypes?.range_revert, configured.range_revert ?? true),
    breakout: boolParam(input.enableBreakout ?? input.enabledSignalTypes?.breakout, configured.breakout ?? true),
    fakeout: boolParam(input.enableFakeout ?? input.enabledSignalTypes?.fakeout, configured.fakeout ?? true),
    momentum: boolParam(input.enableMomentum ?? input.enabledSignalTypes?.momentum, configured.momentum ?? true),
    support_reversal: boolParam(input.enableSupportReversal ?? input.enabledSignalTypes?.support_reversal, configured.support_reversal ?? false),
    structural_breakdown: boolParam(
      input.enableStructuralBreakdown ?? input.enabledSignalTypes?.structural_breakdown,
      configured.structural_breakdown ?? false
    )
  };
}

function volatilityBucket(volatilityRatio) {
  if (volatilityRatio < 0.8) return "low";
  if (volatilityRatio > 1.3) return "high";
  return "medium";
}

function stopMultiplierForVolatility(volatilityRatio, params = {}) {
  if (params.dynamicATRStop) {
    if (volatilityRatio > params.dynamicStopHighThreshold) return params.dynamicStopHigh;
    if (volatilityRatio < params.dynamicStopLowThreshold) return params.dynamicStopLow;
    return params.dynamicStopMedium;
  }
  return params.fixedStopAtrMultiplier;
}

function newSystemStopMultiplier(signal, params = {}) {
  if (signal.type === "fakeout") return Number(params.fakeoutStopAtrMultiplier || 1.5);
  if (signal.type === "breakout") return Number(params.breakoutStopAtrMultiplier || 2.0);
  if (signal.type === "support_reversal" || signal.type === STRUCTURAL_BREAKDOWN_TYPE) {
    return Number(signal.stopMultiplier || 0.5);
  }
  return stopMultiplierForVolatility(Number(signal.volatilityRatio || signal.atrRatio || 1), params);
}

function stopForPosition(signal, entry, params) {
  if (params.newExitRules && ["support_reversal", STRUCTURAL_BREAKDOWN_TYPE].includes(signal.type) && Number.isFinite(Number(signal.stop))) {
    return Number(signal.stop);
  }
  if (signal.type === STRUCTURAL_BREAKDOWN_TYPE && Number.isFinite(Number(signal.stop))) return Number(signal.stop);
  const atr = Number(signal.atr || 0);
  if (!Number.isFinite(atr) || atr <= 0) return signal.stop;
  const directionSign = signal.direction === "LONG" ? 1 : -1;
  const useLegacyExit = params.legacyBreakoutExit && signal.type === "breakout";
  const multiplier = params.newExitRules && !useLegacyExit
    ? newSystemStopMultiplier(signal, params)
    : stopMultiplierForVolatility(Number(signal.volatilityRatio || signal.atrRatio || 1), params);
  return round(entry - directionSign * atr * multiplier);
}

function isoWeekKey(value) {
  const date = new Date(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function profitAmplifier(equityValue, initialEquity, params) {
  const returnPct = ((equityValue - initialEquity) / initialEquity) * 100;
  if (returnPct > params.profitAmplifierTier3Pct) return params.profitAmplifierTier3;
  if (returnPct > params.profitAmplifierTier2Pct) return params.profitAmplifierTier2;
  if (returnPct > params.profitAmplifierTier1Pct) return params.profitAmplifierTier1;
  return params.profitAmplifierBase;
}

function volatilityRiskMultiplier(volatilityRatio, params) {
  const bucket = volatilityBucket(volatilityRatio);
  return {
    low: params.volatilityRiskLow,
    medium: params.volatilityRiskMedium,
    high: params.volatilityRiskHigh
  }[bucket];
}

function gradeRiskAmount(grade, params) {
  const normalized = normalizeGrade(grade, "B");
  return {
    S: params.fixedRiskS,
    A: params.fixedRiskA,
    B: params.fixedRiskB,
    C: params.fixedRiskC
  }[normalized] ?? params.fixedRiskB;
}

function gradeRiskMultiplier(grade) {
  return {
    S: 1.5,
    A: 1.0,
    B: 0.5,
    C: 0.25
  }[normalizeGrade(grade, "B")] || 0.5;
}

function roundToStep(value, step) {
  const unit = Number(step || 0.01);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(unit) || unit <= 0) return 0;
  return round(Math.floor(value / unit) * unit, 4);
}

function adaptivePositionSizing({ signal, positionMultiplier, params, baseSize, equityValue, initialEquity, entry, stop, weeklyDrawdownPct }) {
  if (params.sizingMode === "fixed_dollar") {
    const riskAmount = gradeRiskAmount(signal.grade, params);
    const stopDistance = Math.max(0.01, Math.abs(entry - stop));
    const rawSize = riskAmount / (stopDistance * Number(params.pnlMultiplier || 1));
    const size = roundToStep(rawSize, params.minOrderSize || 0.01);
    return {
      size,
      finalRiskPct: initialEquity ? round((riskAmount / initialEquity) * 100, 3) : 0,
      riskMode: "fixed_dollar",
      riskDetails: {
        riskAmount,
        stopDistance: round(stopDistance, 3),
        minOrderSize: Number(params.minOrderSize || 0.01)
      }
    };
  }

  if (params.sizingMode === "percent_risk") {
    const riskAmount = equityValue * (params.perTradeRiskPct / 100) * gradeRiskMultiplier(signal.grade);
    const stopDistance = Math.max(0.01, Math.abs(entry - stop));
    const rawSize = riskAmount / (stopDistance * Number(params.pnlMultiplier || 1));
    const size = roundToStep(rawSize, params.minOrderSize || 0.01);
    return {
      size,
      finalRiskPct: equityValue ? round((riskAmount / equityValue) * 100, 3) : 0,
      riskMode: "percent_risk",
      riskDetails: {
        riskAmount: round(riskAmount),
        baseRiskPct: params.perTradeRiskPct,
        gradeMultiplier: gradeRiskMultiplier(signal.grade),
        stopDistance: round(stopDistance, 3),
        minOrderSize: Number(params.minOrderSize || 0.01)
      }
    };
  }

  if (!params.adaptiveLeverage) {
    return {
      size: Math.max(0.001, round(baseSize * positionMultiplier, 4)),
      finalRiskPct: 0,
      riskMode: "fixed_size",
      riskDetails: {}
    };
  }

  const weeklyDrawdownAbs = Math.abs(Math.min(0, weeklyDrawdownPct));
  if (weeklyDrawdownAbs > params.weeklyDrawdownPausePct) {
    return {
      size: 0,
      finalRiskPct: 0,
      riskMode: "weekly_pause",
      riskDetails: { weeklyDrawdownPct }
    };
  }

  const grade = normalizeGrade(signal.grade, "B");
  const volatilityRatio = Number(signal.volatilityRatio || signal.atrRatio || 1);
  const baseRiskPct = weeklyDrawdownAbs > params.weeklyDrawdownReducePct
    ? params.weeklyDrawdownReducedRiskPct
    : params.perTradeRiskPct;
  const signalMultiplier = params.signalRiskMultipliers[grade] || 1;
  const volMultiplier = volatilityRiskMultiplier(volatilityRatio, params);
  const profitMultiplier = profitAmplifier(equityValue, initialEquity, params);
  const structuralMultiplier = signal.type === STRUCTURAL_BREAKDOWN_TYPE
    ? Number(params.structuralBreakdownPositionFactor || 0.5)
    : 1;
  const rawRiskPct = baseRiskPct * signalMultiplier * volMultiplier * profitMultiplier;
  const finalRiskPct = Math.min(params.maxSingleTradeRiskPct, rawRiskPct) * structuralMultiplier;
  const riskAmount = equityValue * (finalRiskPct / 100);
  const stopDistance = Math.max(0.01, Math.abs(entry - stop));
  const riskSized = riskAmount / (stopDistance * 100);
  const maxLeverageSize = params.maxEffectiveLeverage > 0
    ? (equityValue * params.maxEffectiveLeverage) / (Math.max(1, entry) * 100)
    : Number.POSITIVE_INFINITY;
  const size = Math.max(0.001, round(Math.min(riskSized, maxLeverageSize), 4));

  return {
    size,
    finalRiskPct: round(finalRiskPct, 3),
    riskMode: "adaptive",
    riskDetails: {
      baseRiskPct,
      signalMultiplier,
      volMultiplier,
      structuralMultiplier,
      profitMultiplier,
      volatilityRatio: round(volatilityRatio, 3),
      volatilityBucket: volatilityBucket(volatilityRatio),
      weeklyDrawdownPct: round(weeklyDrawdownPct, 2),
      leverageCapped: riskSized > maxLeverageSize
    }
  };
}

function seededShuffle(values, seed) {
  const out = values.slice();
  let state = seed + 1;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

function monteCarlo(trades, runs = 100, initialEquity = 100000) {
  const pnls = trades.map((trade) => trade.pnl);
  if (!pnls.length) return [];
  return Array.from({ length: runs }, (_, index) => {
    let equity = initialEquity;
    let peak = equity;
    let maxDd = 0;
    for (const pnl of seededShuffle(pnls, index)) {
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDd = Math.min(maxDd, ((equity - peak) / peak) * 100);
    }
    return {
      run: index + 1,
      terminalReturn: round(((equity - initialEquity) / initialEquity) * 100),
      maxDrawdown: round(maxDd)
    };
  });
}

const DEFAULT_MAX_HOLD_H4_BARS = {
  fakeout: 12,
  breakout: 24,
  range_revert: 18
};

function maxHoldBarsForPosition(position, params) {
  if (params.newExitRules && !(params.legacyBreakoutExit && position.signalType === "breakout")) return Number.POSITIVE_INFINITY;
  if (position.signalType === STRUCTURAL_BREAKDOWN_TYPE) return Number.POSITIVE_INFINITY;
  if (position.signalType === "fakeout" && params.fakeoutDisableTimeoutAfterTp1 && position.tp1Done) {
    return Number.POSITIVE_INFINITY;
  }
  if (position.signalType === "support_reversal") {
    return Number(params.supportReversalMaxHoldBars || 48);
  }
  const h4Bars = Number(params.maxHoldH4BarsByType?.[position.signalType]);
  if (Number.isFinite(h4Bars) && h4Bars > 0) return h4Bars * 4;
  return Number(params.maxHoldBars || 24);
}

function stopWasTrailed(position) {
  if (!position?.initialStop) return false;
  return position.direction === "LONG"
    ? position.stop > position.initialStop
    : position.stop < position.initialStop;
}

function favorableMove(position, candle) {
  return position.direction === "LONG"
    ? candle.high - position.entry
    : position.entry - candle.low;
}

function improveStop(position, candidate) {
  if (!Number.isFinite(candidate)) return false;
  if (position.direction === "LONG" && candidate > position.stop) {
    position.stop = round(candidate);
    return true;
  }
  if (position.direction === "SHORT" && candidate < position.stop) {
    position.stop = round(candidate);
    return true;
  }
  return false;
}

function updateTrailingStop(position, candle, params) {
  if (params.newExitRules && !(params.legacyBreakoutExit && position.signalType === "breakout")) {
    return updateNewSystemTrailingStop(position, candle, params);
  }
  if (!params.trailingStopEnabled) return;
  const atr = Number(position.atr || 0);
  if (!Number.isFinite(atr) || atr <= 0) return;
  const move = favorableMove(position, candle);
  const directionSign = position.direction === "LONG" ? 1 : -1;
  if (move > atr * params.trailingLockAtr) {
    if (improveStop(position, position.entry + directionSign * atr * params.trailingLockProfitAtr)) {
      position.trailStage = Math.max(position.trailStage || 0, 2);
    }
    return;
  }
  if (move > atr * params.trailingBreakEvenAtr) {
    if (improveStop(position, position.entry)) {
      position.trailStage = Math.max(position.trailStage || 0, 1);
    }
  }
}

function maFromCandles(candlesSoFar, period) {
  const h4 = aggregateCandles(candlesSoFar, "H4");
  return movingAverage(h4, period);
}

function updateNewSystemTrailingStop(position, candle, params) {
  if (!params.trailingStopEnabled) return;
  const riskDistance = Math.abs(Number(position.entry) - Number(position.initialStop));
  if (position.signalType === "fakeout") {
    if (params.fakeoutPartialTakeProfit && position.tp1Done) {
      if (params.fakeoutMaExitOnClose) return;
      const ma = maFromCandles(position.candlesSoFar || [], params.fakeoutTrailingMaPeriod);
      if (Number.isFinite(ma)) improveStop(position, ma);
      return;
    }
    if (riskDistance > 0 && favorableMove(position, candle) >= riskDistance) {
      improveStop(position, Number(position.entry));
    }
    return;
  }
  if (position.signalType === "breakout") {
    const ma10 = maFromCandles(position.candlesSoFar || [], 10);
    if (Number.isFinite(ma10)) improveStop(position, ma10);
    return;
  }
  if (position.signalType === "support_reversal" || position.signalType === STRUCTURAL_BREAKDOWN_TYPE) {
    if (position.signalType === "support_reversal" && params.supportReversalTrailAfterTp1 && !position.tp1Done) return;
    const ma20 = maFromCandles(position.candlesSoFar || [], 20);
    if (Number.isFinite(ma20)) improveStop(position, ma20);
  }
}

function targetForPosition(signal, entry, params) {
  if (signal.type === "fakeout" && params.fakeoutPartialTakeProfit) return null;
  if (signal.type === STRUCTURAL_BREAKDOWN_TYPE && Number(params.structuralTakeProfitR || 0) > 0) {
    const stop = stopForPosition(signal, entry, params);
    const directionSign = signal.direction === "LONG" ? 1 : -1;
    const riskDistance = Math.abs(entry - stop);
    return round(entry + directionSign * riskDistance * Number(params.structuralTakeProfitR));
  }
  if (params.newExitRules && !(params.legacyBreakoutExit && signal.type === "breakout")) {
    if (signal.type === "fakeout") {
      const stop = stopForPosition(signal, entry, params);
      const directionSign = signal.direction === "LONG" ? 1 : -1;
      const riskDistance = Math.abs(entry - stop);
      return round(entry + directionSign * riskDistance * Number(params.fakeoutTakeProfitR || 1.5));
    }
    return null;
  }
  if (signal.type === STRUCTURAL_BREAKDOWN_TYPE) return null;
  const directionSign = signal.direction === "LONG" ? 1 : -1;
  const atr = Number(signal.atr || 0);
  if (signal.type === "fakeout" && Number.isFinite(atr) && atr > 0) {
    return round(entry + directionSign * atr * params.fakeoutTakeProfitAtr);
  }
  return signal.target;
}

function isTradableSignal(signal, params = {}) {
  if (!signal?.entry || !signal?.stop) return false;
  if (params.newExitRules && ["support_reversal", STRUCTURAL_BREAKDOWN_TYPE].includes(signal.type)) return true;
  if (params.newExitRules && signal.type === "breakout" && !params.legacyBreakoutExit) return true;
  if (signal.type === STRUCTURAL_BREAKDOWN_TYPE) return true;
  return Number.isFinite(Number(signal.target));
}

function tradeFromExit(position, candle, exit, reason, sizeOverride) {
  const directionSign = position.direction === "LONG" ? 1 : -1;
  const size = Number(sizeOverride || position.size);
  const pnlMultiplier = Number(position.pnlMultiplier || position.params?.pnlMultiplier || 100);
  const pnl = round((exit - position.entry) * directionSign * size * pnlMultiplier);
  const riskStop = Number(position.initialStop || position.stop);
  const risk = Math.max(1, Math.abs(position.entry - riskStop) * size * pnlMultiplier);
  return {
    signalId: position.signalId,
    openedAt: position.openedAt,
    closedAt: candle.t,
    direction: position.direction,
    entry: round(position.entry),
    exit: round(exit),
    size,
    signalGrade: position.signalGrade,
    signalType: position.signalType,
    positionMultiplier: position.positionMultiplier,
    finalRiskPct: position.finalRiskPct || 0,
    riskMode: position.riskMode || "fixed_size",
    riskDetails: position.riskDetails || {},
    initialStop: round(riskStop),
    finalStop: round(position.stop),
    atr: round(position.atr || 0, 3),
    volatilityRatio: round(position.volatilityRatio || 1, 3),
    stopMultiplier: round(position.stopMultiplier || 0, 2),
    breakoutLevel: position.breakoutLevel,
    support: position.support,
    resistance: position.resistance,
    sentinelScore: position.sentinelScore,
    sentinel: position.sentinel,
    maxHoldBars: maxHoldBarsForPosition(position, position.params || {}),
    pnl,
    rMultiple: round(pnl / risk, 2),
    reason
  };
}

function reverseSentinelExit(position, signal, candle, params) {
  if (position?.signalType !== STRUCTURAL_BREAKDOWN_TYPE) return null;
  if (signal?.type !== STRUCTURAL_BREAKDOWN_TYPE || signal.direction === position.direction) return null;
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  const exit = position.direction === "LONG"
    ? candle.close - spread - slippage
    : candle.close + spread + slippage;
  return tradeFromExit({ ...position, params }, candle, exit, "reverse_sentinel");
}

function endOfBacktestExit(position, candle, params) {
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  const exit = position.direction === "LONG"
    ? candle.close - spread - slippage
    : candle.close + spread + slippage;
  return tradeFromExit({ ...position, params }, candle, exit, "end_of_backtest");
}

function supportReversalFailure(position, candle, params) {
  if (params.newExitRules) return false;
  if (position.signalType !== "support_reversal" || !Number.isFinite(Number(position.breakoutLevel))) return false;
  if (position.holdBars > Number(params.supportReversalFailureBars || 3)) return false;
  const buffer = Number(position.atr || 0) * Number(params.supportReversalFailureAtr || 0.2);
  return position.direction === "LONG"
    ? candle.close < Number(position.breakoutLevel) - buffer
    : candle.close > Number(position.breakoutLevel) + buffer;
}

function supportReversalNoProgress(position, candle, params) {
  if (params.newExitRules) return false;
  if (position.signalType !== "support_reversal") return false;
  if (position.holdBars < Number(params.supportReversalOneRTimeoutBars || 24)) return false;
  const oneR = Math.abs(position.entry - position.initialStop);
  const move = position.direction === "LONG" ? candle.high - position.entry : position.entry - candle.low;
  return move < oneR;
}

function supportReversalTp1(position, candle, params) {
  if (position.signalType !== "support_reversal" || position.tp1Done) return null;
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  const directionSign = position.direction === "LONG" ? 1 : -1;
  const oneR = Math.abs(position.entry - position.initialStop);
  const target = position.entry + directionSign * oneR * Number(params.supportReversalTp1R || 1.5);
  const hit = position.direction === "LONG" ? candle.high >= target : candle.low <= target;
  if (!hit) return null;
  const exit = position.direction === "LONG" ? target - spread - slippage : target + spread + slippage;
  const closedSize = round(position.size / 2, 4);
  position.size = round(position.size - closedSize, 4);
  position.stop = position.entry;
  position.tp1Done = true;
  return tradeFromExit({ ...position, params }, candle, exit, "partial_target", closedSize);
}

function fakeoutTp1(position, candle, params) {
  if (!params.fakeoutPartialTakeProfit || position.signalType !== "fakeout" || position.tp1Done) return null;
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  const directionSign = position.direction === "LONG" ? 1 : -1;
  const oneR = Math.abs(position.entry - position.initialStop);
  const target = position.entry + directionSign * oneR * Number(params.fakeoutTp1R || 1);
  const hit = position.direction === "LONG" ? candle.high >= target : candle.low <= target;
  if (!hit) return null;
  const exit = position.direction === "LONG" ? target - spread - slippage : target + spread + slippage;
  const closedSize = round(position.size / 2, 4);
  position.size = round(position.size - closedSize, 4);
  position.stop = position.entry;
  position.tp1Done = true;
  position.trailStage = Math.max(position.trailStage || 0, 1);
  return tradeFromExit({ ...position, params }, candle, exit, "partial_target", closedSize);
}

function fakeoutMaCloseExit(position, candle, params) {
  if (!params.fakeoutPartialTakeProfit || !params.fakeoutMaExitOnClose) return null;
  if (position.signalType !== "fakeout" || !position.tp1Done) return null;
  const ma = maFromCandles(position.candlesSoFar || [], params.fakeoutTrailingMaPeriod);
  if (!Number.isFinite(ma)) return null;
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  if (position.direction === "LONG" && candle.close < ma) {
    return tradeFromExit({ ...position, params }, candle, candle.close - spread - slippage, "ma_trailing_exit");
  }
  if (position.direction === "SHORT" && candle.close > ma) {
    return tradeFromExit({ ...position, params }, candle, candle.close + spread + slippage, "ma_trailing_exit");
  }
  return null;
}

function structuralBreakdownMa20Exit(position, candle, candlesSoFar, params) {
  if (params.newExitRules) return null;
  if (position.signalType !== STRUCTURAL_BREAKDOWN_TYPE) return null;
  const h4 = aggregateCandles(candlesSoFar, "H4");
  const ma20 = movingAverage(h4, 20);
  if (!Number.isFinite(ma20)) return null;
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  if (position.direction === "LONG" && candle.close < ma20) {
    return tradeFromExit({ ...position, params }, candle, candle.close - spread - slippage, "structural_ma20_exit");
  }
  if (position.direction === "SHORT" && candle.close > ma20) {
    return tradeFromExit({ ...position, params }, candle, candle.close + spread + slippage, "structural_ma20_exit");
  }
  return null;
}

function closePosition(position, candle, params, candlesSoFar = []) {
  position.candlesSoFar = candlesSoFar;
  const spread = Number(params.spread || 0.3);
  const slippage = Number(params.slippage || 0.1);
  const maxHoldBars = maxHoldBarsForPosition(position, params);
  const targetValue = position.target === null || typeof position.target === "undefined"
    ? null
    : Number(position.target);
  const hasTarget = Number.isFinite(targetValue);
  let exit = null;
  let reason = "";
  if (position.direction === "LONG") {
    if (candle.low <= position.stop) {
      exit = position.stop - slippage;
      reason = stopWasTrailed(position) ? "trailing_stop" : "stop";
    } else if (hasTarget && candle.high >= targetValue) {
      exit = targetValue - spread - slippage;
      reason = "target";
    }
  } else if (candle.high >= position.stop) {
    exit = position.stop + slippage;
    reason = stopWasTrailed(position) ? "trailing_stop" : "stop";
  } else if (hasTarget && candle.low <= targetValue) {
    exit = targetValue + spread + slippage;
    reason = "target";
  }
  if (exit === null) {
    const fakeoutMaExit = fakeoutMaCloseExit(position, candle, params);
    if (fakeoutMaExit) return fakeoutMaExit;
  }
  if (exit === null) {
    const structuralExit = structuralBreakdownMa20Exit(position, candle, candlesSoFar, params);
    if (structuralExit) return structuralExit;
  }
  if (exit === null && supportReversalFailure(position, candle, params)) {
    exit = position.direction === "LONG" ? candle.close - spread - slippage : candle.close + spread + slippage;
    reason = "support_failure";
  }
  if (exit === null && supportReversalNoProgress(position, candle, params)) {
    exit = position.direction === "LONG" ? candle.close - spread - slippage : candle.close + spread + slippage;
    reason = "one_r_timeout";
  }
  if (exit === null && Number.isFinite(maxHoldBars) && position.holdBars >= maxHoldBars) {
    exit = position.direction === "LONG" ? candle.close - spread - slippage : candle.close + spread + slippage;
    reason = "timeout";
  }
  if (exit === null) {
    updateTrailingStop(position, candle, params);
    return null;
  }
  return tradeFromExit({ ...position, params }, candle, exit, reason);
}

function processPosition(position, candle, params, candlesSoFar = []) {
  position.candlesSoFar = candlesSoFar;
  const closeTrade = closePosition(position, candle, params, candlesSoFar);
  if (closeTrade) return { trades: [closeTrade], closed: true };
  const partialTrade = fakeoutTp1(position, candle, params) || supportReversalTp1(position, candle, params);
  if (partialTrade) return { trades: [partialTrade], closed: false };
  return { trades: [], closed: false };
}

function dayKey(value) {
  return String(value || "").slice(0, 10);
}

function dailyBucket(dailyStats, day) {
  if (!dailyStats.has(day)) {
    dailyStats.set(day, { entries: 0, stops: 0, pnl: 0 });
  }
  return dailyStats.get(day);
}

function recordDailyTrades(dailyStats, trades) {
  for (const trade of trades) {
    const bucket = dailyBucket(dailyStats, dayKey(trade.closedAt || trade.openedAt));
    bucket.pnl += Number(trade.pnl || 0);
    if (trade.reason === "stop" && Number(trade.pnl || 0) < 0) bucket.stops += 1;
  }
}

function canOpenToday(dailyStats, day, params) {
  if (!params.newExitRules) return true;
  const bucket = dailyBucket(dailyStats, day);
  if (bucket.entries >= params.maxDailyTrades) return false;
  if (bucket.stops >= params.dailyStopLimit) return false;
  if (bucket.pnl <= -Math.abs(params.dailyLossLimitUsd)) return false;
  return true;
}

function normalizedMacroBias(macroSnapshot = {}) {
  const bias = String(macroSnapshot.bias || macroSnapshot.compass?.bias || "").toLowerCase();
  if (bias.includes("利多") || bias.includes("bull")) return "bullish";
  if (bias.includes("利空") || bias.includes("bear")) return "bearish";
  return "neutral";
}

function applyBacktestSignalFilters(signal, params, macroSnapshot) {
  if (!signal) return signal;
  if (params.breakoutMacroDirectionFilter && signal.type === "breakout") {
    const bias = normalizedMacroBias(macroSnapshot);
    const mismatched = (bias === "bullish" && signal.direction === "SHORT")
      || (bias === "bearish" && signal.direction === "LONG");
    if (mismatched) {
      return { ...signal, grade: "C", level: "C" };
    }
  }
  return signal;
}

export async function runBacktest({ storage, macroSnapshot, settings, input = {} }) {
  const rangeDays = Number(input.rangeDays || 180);
  const admission = signalAdmissionParams(input);
  const exitRules = settings?.strategy?.exitRules || {};
  const fakeoutPartialTP = boolParam(
    input.fakeoutPartialTakeProfit ?? input.fakeoutPartialTP,
    exitRules.fakeoutPartialTP ?? false
  );
  const params = {
    from: input.from || "",
    to: input.to || "",
    rangeDays,
    atrThreshold: numberParam(input.atrThreshold, settings?.strategy?.atrThreshold || 1.12),
    rangeUpperThreshold: numberParam(input.rangeUpperThreshold, settings?.strategy?.rangeUpperThreshold ?? 0.85),
    rangeLowerThreshold: numberParam(input.rangeLowerThreshold, settings?.strategy?.rangeLowerThreshold ?? 0.15),
    requirePinBar: boolParam(input.requirePinBar, settings?.strategy?.requirePinBar ?? true),
    fakeoutVolumeFilter: boolParam(input.fakeoutVolumeFilter, settings?.strategy?.fakeoutVolumeFilter ?? false),
    flowResonanceMode: input.flowResonanceMode === "relaxed" ? "relaxed" : "strict",
    newExitRules: boolParam(input.newExitRules, exitRules.newExitRules ?? false),
    sizingMode: input.sizingMode || "legacy",
    pnlMultiplier: numberParam(input.pnlMultiplier, 100),
    minOrderSize: numberParam(input.minOrderSize, 0.01),
    fixedRiskS: numberParam(input.fixedRiskS, 300),
    fixedRiskA: numberParam(input.fixedRiskA, 200),
    fixedRiskB: numberParam(input.fixedRiskB, 100),
    fixedRiskC: numberParam(input.fixedRiskC, 50),
    fakeoutStopAtrMultiplier: numberParam(input.fakeoutStopAtrMultiplier, 1.5),
    breakoutStopAtrMultiplier: numberParam(input.breakoutStopAtrMultiplier, 2.0),
    fakeoutTakeProfitR: numberParam(input.fakeoutTakeProfitR, 1.5),
    fakeoutPartialTakeProfit: fakeoutPartialTP,
    fakeoutTp1R: numberParam(input.fakeoutTp1R, exitRules.fakeoutTp1R ?? 1.5),
    fakeoutTrailingMaPeriod: numberParam(input.fakeoutTrailingMaPeriod, exitRules.fakeoutTrailingMaPeriod ?? 10),
    fakeoutMaExitOnClose: boolParam(input.fakeoutMaExitOnClose, fakeoutPartialTP),
    fakeoutDisableTimeoutAfterTp1: boolParam(input.fakeoutDisableTimeoutAfterTp1, fakeoutPartialTP),
    structuralTakeProfitR: numberParam(input.structuralTakeProfitR, exitRules.structuralTakeProfitR ?? 0),
    breakoutMacroDirectionFilter: boolParam(input.breakoutMacroDirectionFilter, exitRules.breakoutMacroDirectionFilter ?? false),
    legacyBreakoutExit: boolParam(input.legacyBreakoutExit, exitRules.legacyBreakoutExit ?? false),
    dailyStopLimit: numberParam(input.dailyStopLimit, 3),
    dailyLossLimitUsd: numberParam(input.dailyLossLimitUsd, 600),
    maxDailyTrades: numberParam(input.maxDailyTrades, 4),
    ...admission,
    enabledSignalTypes: enabledSignalTypesParam(input, settings),
    positionFactor: Number(input.positionFactor || settings?.risk?.maxPositionPct / 100 || 0.1),
    perTradeRiskPct: numberParam(input.perTradeRiskPct, settings?.risk?.perTradeRiskPct ?? 2),
    macroWeight: Number(input.macroWeight || settings?.strategy?.weights?.macro || 0.42),
    technicalWeight: Number(input.technicalWeight || settings?.strategy?.weights?.technical || 0.38),
    flowWeight: Number(input.flowWeight || settings?.strategy?.weights?.flow || 0.2),
    spread: Number(input.spread || 0.3),
    slippage: Number(input.slippage || 0.1),
    fixedStopAtrMultiplier: numberParam(input.fixedStopAtrMultiplier, settings?.risk?.fixedStopAtrMultiplier ?? 1.5),
    dynamicATRStop: boolParam(input.dynamicATRStop, settings?.risk?.dynamicATRStop ?? false),
    dynamicStopHigh: numberParam(input.dynamicStopHigh, settings?.risk?.dynamicStopHigh ?? 2.0),
    dynamicStopMedium: numberParam(input.dynamicStopMedium, settings?.risk?.dynamicStopMedium ?? 1.5),
    dynamicStopLow: numberParam(input.dynamicStopLow, settings?.risk?.dynamicStopLow ?? 1.2),
    dynamicStopHighThreshold: numberParam(input.dynamicStopHighThreshold, settings?.risk?.dynamicStopHighThreshold ?? 1.3),
    dynamicStopLowThreshold: numberParam(input.dynamicStopLowThreshold, settings?.risk?.dynamicStopLowThreshold ?? 0.8),
    maxHoldBars: Number(input.maxHoldBars || 24),
    trailingStopEnabled: boolParam(input.trailingStopEnabled, settings?.risk?.trailingStopEnabled ?? true),
    trailingCheckMinutes: Number(input.trailingCheckMinutes || settings?.risk?.trailingCheckMinutes || 15),
    trailingBreakEvenAtr: numberParam(input.trailingBreakEvenAtr, settings?.risk?.trailingBreakEvenAtr ?? 1),
    trailingLockAtr: numberParam(input.trailingLockAtr, settings?.risk?.trailingLockAtr ?? 2),
    trailingLockProfitAtr: numberParam(input.trailingLockProfitAtr, settings?.risk?.trailingLockProfitAtr ?? 1),
    fakeoutTakeProfitAtr: numberParam(input.fakeoutTakeProfitAtr, settings?.risk?.fakeoutTakeProfitAtr ?? 1.5),
    maxHoldH4BarsByType: {
      fakeout: numberParam(input.fakeoutMaxHoldH4Bars, settings?.risk?.maxHoldH4BarsByType?.fakeout ?? DEFAULT_MAX_HOLD_H4_BARS.fakeout),
      breakout: numberParam(input.breakoutMaxHoldH4Bars, settings?.risk?.maxHoldH4BarsByType?.breakout ?? DEFAULT_MAX_HOLD_H4_BARS.breakout),
      range_revert: numberParam(input.rangeRevertMaxHoldH4Bars, settings?.risk?.maxHoldH4BarsByType?.range_revert ?? DEFAULT_MAX_HOLD_H4_BARS.range_revert)
    },
    supportReversalEntry: input.supportReversalEntry || settings?.strategy?.supportReversal?.entry || "retest",
    supportReversalSlowFilter: boolParam(input.supportReversalSlowFilter, settings?.strategy?.supportReversal?.slowFilter ?? true),
    supportReversalPivotBars: numberParam(input.supportReversalPivotBars, settings?.strategy?.supportReversal?.pivotBars ?? 3),
    supportReversalMaxHoldBars: numberParam(input.supportReversalMaxHoldBars, settings?.risk?.supportReversalMaxHoldBars ?? 48),
    supportReversalFailureBars: numberParam(input.supportReversalFailureBars, settings?.risk?.supportReversalFailureBars ?? 3),
    supportReversalFailureAtr: numberParam(input.supportReversalFailureAtr, settings?.risk?.supportReversalFailureAtr ?? 0.2),
    supportReversalOneRTimeoutBars: numberParam(input.supportReversalOneRTimeoutBars, settings?.risk?.supportReversalOneRTimeoutBars ?? 24),
    supportReversalTp1R: numberParam(input.supportReversalTp1R, settings?.risk?.supportReversalTp1R ?? 1.5),
    supportReversalTrailAfterTp1: boolParam(input.supportReversalTrailAfterTp1, false),
    structuralBreakdownUseFundingData: boolParam(input.structuralBreakdownUseFundingData, settings?.strategy?.structuralBreakdown?.useFundingData ?? false),
    structuralBreakdownThresholdA: numberParam(input.structuralBreakdownThresholdA, settings?.strategy?.structuralBreakdown?.thresholdA ?? 30),
    structuralBreakdownThresholdS: numberParam(input.structuralBreakdownThresholdS, settings?.strategy?.structuralBreakdown?.thresholdS ?? 40),
    structuralBreakdownPositionFactor: numberParam(input.structuralBreakdownPositionFactor, settings?.risk?.structuralBreakdownPositionFactor ?? 0.5),
    structuralBreakdownAllowedUtcStart: numberParam(input.structuralBreakdownAllowedUtcStart, settings?.strategy?.structuralBreakdown?.allowedUtcStart ?? 8),
    structuralBreakdownAllowedUtcEnd: numberParam(input.structuralBreakdownAllowedUtcEnd, settings?.strategy?.structuralBreakdown?.allowedUtcEnd ?? 17),
    adaptiveLeverage: boolParam(input.adaptiveLeverage, settings?.risk?.adaptiveLeverage ?? false),
    signalRiskMultipliers: {
      S: numberParam(input.signalRiskMultiplierS, settings?.risk?.signalRiskMultipliers?.S ?? 2.5),
      A: numberParam(input.signalRiskMultiplierA, settings?.risk?.signalRiskMultipliers?.A ?? 1.5),
      B: numberParam(input.signalRiskMultiplierB, settings?.risk?.signalRiskMultipliers?.B ?? 1.0)
    },
    volatilityRiskLow: numberParam(input.volatilityRiskLow, settings?.risk?.volatilityRiskMultipliers?.low ?? 1.3),
    volatilityRiskMedium: numberParam(input.volatilityRiskMedium, settings?.risk?.volatilityRiskMultipliers?.medium ?? 1.0),
    volatilityRiskHigh: numberParam(input.volatilityRiskHigh, settings?.risk?.volatilityRiskMultipliers?.high ?? 0.5),
    profitAmplifierTier1Pct: numberParam(input.profitAmplifierTier1Pct, settings?.risk?.profitAmplifiers?.tier1Pct ?? 5),
    profitAmplifierTier1: numberParam(input.profitAmplifierTier1, settings?.risk?.profitAmplifiers?.tier1 ?? 1.5),
    profitAmplifierTier2Pct: numberParam(input.profitAmplifierTier2Pct, settings?.risk?.profitAmplifiers?.tier2Pct ?? 10),
    profitAmplifierTier2: numberParam(input.profitAmplifierTier2, settings?.risk?.profitAmplifiers?.tier2 ?? 2.0),
    profitAmplifierTier3Pct: numberParam(input.profitAmplifierTier3Pct, settings?.risk?.profitAmplifiers?.tier3Pct ?? 20),
    profitAmplifierTier3: numberParam(input.profitAmplifierTier3, settings?.risk?.profitAmplifiers?.tier3 ?? 2.5),
    profitAmplifierBase: numberParam(input.profitAmplifierBase, settings?.risk?.profitAmplifiers?.base ?? 1.0),
    maxSingleTradeRiskPct: numberParam(input.maxSingleTradeRiskPct, settings?.risk?.maxSingleTradeRiskPct ?? 8),
    maxEffectiveLeverage: numberParam(input.maxEffectiveLeverage, settings?.risk?.maxEffectiveLeverage ?? 4),
    weeklyDrawdownReducePct: numberParam(input.weeklyDrawdownReducePct, settings?.risk?.weeklyDrawdownReducePct ?? 10),
    weeklyDrawdownPausePct: numberParam(input.weeklyDrawdownPausePct, settings?.risk?.weeklyDrawdownPausePct ?? 15),
    weeklyDrawdownReducedRiskPct: numberParam(input.weeklyDrawdownReducedRiskPct, settings?.risk?.weeklyDrawdownReducedRiskPct ?? 1),
    enhancements: {
      bollingerRegimeFilter: boolParam(input.bollingerRegimeFilter, settings?.strategy?.enhancements?.bollingerRegimeFilter ?? false),
      previousDayLevelBoost: boolParam(input.previousDayLevelBoost, settings?.strategy?.enhancements?.previousDayLevelBoost ?? false),
      rsiDivergenceBoost: boolParam(input.rsiDivergenceBoost, settings?.strategy?.enhancements?.rsiDivergenceBoost ?? false),
      londonOpenDirectionFilter: boolParam(input.londonOpenDirectionFilter, settings?.strategy?.enhancements?.londonOpenDirectionFilter ?? false)
    }
  };
  const candles = await storage?.getCandles?.({
    instrument: "XAU_USD",
    timeframe: "H1",
    from: params.from || undefined,
    to: params.to || undefined,
    limit: Math.max(120, rangeDays * 24)
  });
  if (!candles || candles.length < 30) {
    const fallback = mock.createBacktestResult(input);
    return {
      result: {
        ...fallback,
        params: {
          ...(fallback.params || {}),
          ...params
        },
        name: input.name || "真实回测等待K线",
        dataSource: "fallback-mock",
        warning: "candles table has fewer than 30 H1 candles"
      },
      trades: []
    };
  }

  const initialEquity = Number(input.initialEquity || 100000);
  const baseSize = Math.max(0.01, round(params.positionFactor, 2));
  let equityValue = initialEquity;
  let position = null;
  const trades = [];
  const equity = [{ t: candles[0].t, v: equityValue }];
  let currentWeek = isoWeekKey(candles[0].t);
  let weeklyPeak = equityValue;
  let weeklyDrawdownPct = 0;
  const structuralEntryDays = new Set();
  const dailyStats = new Map();
  const engineSettings = {
    ...settings,
    strategy: {
      ...(settings?.strategy || {}),
      atrThreshold: params.atrThreshold,
      rangeUpperThreshold: params.rangeUpperThreshold,
      rangeLowerThreshold: params.rangeLowerThreshold,
      requirePinBar: params.requirePinBar,
      fakeoutVolumeFilter: params.fakeoutVolumeFilter,
      flowResonanceMode: params.flowResonanceMode,
      enabledSignalTypes: params.enabledSignalTypes,
      supportReversal: {
        entry: params.supportReversalEntry,
        slowFilter: params.supportReversalSlowFilter,
        pivotBars: params.supportReversalPivotBars
      },
      structuralBreakdown: {
        ...(settings?.strategy?.structuralBreakdown || {}),
        useFundingData: params.structuralBreakdownUseFundingData,
        thresholdA: params.structuralBreakdownThresholdA,
        thresholdS: params.structuralBreakdownThresholdS,
        allowedUtcStart: params.structuralBreakdownAllowedUtcStart,
        allowedUtcEnd: params.structuralBreakdownAllowedUtcEnd
      },
      enhancements: params.enhancements
    },
    risk: {
      ...(settings?.risk || {}),
      structuralBreakdownPositionFactor: params.structuralBreakdownPositionFactor,
      fixedStopAtrMultiplier: params.fixedStopAtrMultiplier,
      dynamicATRStop: params.dynamicATRStop,
      dynamicStopHigh: params.dynamicStopHigh,
      dynamicStopMedium: params.dynamicStopMedium,
      dynamicStopLow: params.dynamicStopLow,
      dynamicStopHighThreshold: params.dynamicStopHighThreshold,
      dynamicStopLowThreshold: params.dynamicStopLowThreshold
    }
  };

  function refreshWeeklyRisk(time) {
    const nextWeek = isoWeekKey(time);
    if (nextWeek !== currentWeek) {
      currentWeek = nextWeek;
      weeklyPeak = equityValue;
    }
    weeklyPeak = Math.max(weeklyPeak, equityValue);
    weeklyDrawdownPct = weeklyPeak ? ((equityValue - weeklyPeak) / weeklyPeak) * 100 : 0;
    return weeklyDrawdownPct;
  }

  for (let index = 24; index < candles.length; index += 1) {
    const candle = candles[index];
    const candlesSoFar = candles.slice(0, index + 1);
    let scanEngine = null;
    refreshWeeklyRisk(candle.t);
    if (position) {
      position.holdBars += 1;
      const processed = processPosition(position, candle, params, candlesSoFar);
      if (processed.trades.length) {
        const pnl = processed.trades.reduce((sum, trade) => sum + trade.pnl, 0);
        equityValue += pnl;
        trades.push(...processed.trades);
        recordDailyTrades(dailyStats, processed.trades);
      }
      if (processed.closed) {
        position = null;
        refreshWeeklyRisk(candle.t);
      }
    }

    if (position && position.signalType === STRUCTURAL_BREAKDOWN_TYPE && index % 4 === 0) {
      scanEngine = runSignalEngine({ candles: candlesSoFar, macroSnapshot, settings: engineSettings });
      if (!params.newExitRules) {
        const reverseSignal = scanEngine.signals.find((item) => item.type === STRUCTURAL_BREAKDOWN_TYPE);
        const reverseTrade = reverseSentinelExit(position, reverseSignal, candle, params);
        if (reverseTrade) {
          equityValue += reverseTrade.pnl;
          trades.push(reverseTrade);
          recordDailyTrades(dailyStats, [reverseTrade]);
          position = null;
          refreshWeeklyRisk(candle.t);
        }
      }
    }

    if (!position && index % 4 === 0) {
      const entryDay = dayKey(candle.t);
      if (!canOpenToday(dailyStats, entryDay, params)) {
        equity.push({ t: candle.t, v: round(equityValue) });
        continue;
      }
      const engine = scanEngine || runSignalEngine({ candles: candlesSoFar, macroSnapshot, settings: engineSettings });
      const signal = engine.signals.map((item) => applyBacktestSignalFilters(item, params, macroSnapshot)).find((item) => {
        if (positionMultiplierForSignal(item, params) <= 0 || !isTradableSignal(item, params)) return false;
        if (item.type === STRUCTURAL_BREAKDOWN_TYPE && structuralEntryDays.has(candle.t.slice(0, 10))) return false;
        return true;
      });
      if (signal) {
        const positionMultiplier = positionMultiplierForSignal(signal, params);
        const directionSign = signal.direction === "LONG" ? 1 : -1;
        const entry = candle.close + directionSign * (params.spread + params.slippage);
        const stop = stopForPosition(signal, entry, params);
        const target = targetForPosition(signal, entry, params);
        const sizing = adaptivePositionSizing({
          signal,
          positionMultiplier,
          params,
          baseSize,
          equityValue,
          initialEquity,
          entry,
          stop,
          weeklyDrawdownPct
        });
        if (sizing.size <= 0) {
          equity.push({ t: candle.t, v: round(equityValue) });
          continue;
        }
        position = {
          signalId: signal.id,
          signalGrade: signal.grade,
          signalType: signal.type,
          openedAt: candle.t,
          direction: signal.direction,
          entry,
          stop,
          initialStop: stop,
          target,
          atr: Number(signal.atr || Math.abs(signal.entry - signal.stop) / 1.2 || 0),
          size: sizing.size,
          positionMultiplier,
          finalRiskPct: sizing.finalRiskPct,
          riskMode: sizing.riskMode,
          riskDetails: sizing.riskDetails,
          pnlMultiplier: params.pnlMultiplier,
          volatilityRatio: Number(signal.volatilityRatio || signal.atrRatio || 1),
          stopMultiplier: Number(signal.stopMultiplier || stopMultiplierForVolatility(Number(signal.volatilityRatio || signal.atrRatio || 1), params)),
          support: signal.support,
          resistance: signal.resistance,
          breakoutLevel: signal.breakoutLevel,
          sentinelScore: signal.sentinelScore,
          sentinel: signal.sentinel,
          tp1Done: false,
          holdBars: 0,
          trailStage: 0
        };
        if (signal.type === STRUCTURAL_BREAKDOWN_TYPE) {
          structuralEntryDays.add(candle.t.slice(0, 10));
        }
        dailyBucket(dailyStats, entryDay).entries += 1;
      }
    }
    equity.push({ t: candle.t, v: round(equityValue) });
  }

  if (position) {
    const last = candles.at(-1);
    const processed = processPosition({ ...position, holdBars: 999 }, last, params, candles);
    const closingTrades = processed.trades.length ? processed.trades : [endOfBacktestExit(position, last, params)];
    const pnl = closingTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    equityValue += pnl;
    trades.push(...closingTrades);
    recordDailyTrades(dailyStats, closingTrades);
    equity.push({ t: last.t, v: round(equityValue) });
  }

  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const maxDrawdown = maxDrawdownPct(equity);
  const annualReturn = round(((equityValue - initialEquity) / initialEquity) * (365 / Math.max(1, rangeDays)) * 100);
  const result = {
    id: `BT-${Date.now()}-${Math.round(Math.random() * 999)}`,
    name: input.name || "真实K线回测",
    createdAt: new Date().toISOString(),
    dataSource: "postgres-candles",
    params,
    metrics: {
      annualReturn,
      maxDrawdown,
      winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
      profitFactor: grossLoss ? round(grossProfit / grossLoss, 2) : grossProfit ? 99 : 0,
      sharpe: sharpeFromEquity(equity),
      calmar: maxDrawdown ? round(annualReturn / Math.abs(maxDrawdown), 2) : 0,
      trades: trades.length,
      expectancyR: trades.length ? round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length, 2) : 0
    },
    equity,
    monthlyReturns: monthlyReturns(equity),
    drawdownWindows: [
      { start: equity[0]?.t?.slice(0, 10), end: equity.at(-1)?.t?.slice(0, 10), drawdown: maxDrawdown }
    ],
    tradeDistribution: tradeDistribution(trades),
    monteCarlo: monteCarlo(trades, Number(input.monteCarloRuns || 100), initialEquity)
  };
  await storage?.persistBacktestRun?.(result, trades);
  return { result, trades };
}

export async function backtestCatalog({ storage, macroSnapshot, settings }) {
  const first = await runBacktest({
    storage,
    macroSnapshot,
    settings,
    input: { name: "主策略 v0.2", rangeDays: 180, atrThreshold: 1.12, positionFactor: 0.12, allowBSignals: true, allowCSignals: false }
  });
  const second = await runBacktest({
    storage,
    macroSnapshot,
    settings,
    input: { name: "低仓位风控", rangeDays: 180, atrThreshold: 1.25, positionFactor: 0.08, allowBSignals: true, allowCSignals: false }
  });
  return {
    parameters: {
      rangeDays: 180,
      atrThreshold: 1.12,
      resonanceWeight: settings.strategy.weights,
      positionFactor: settings.risk.maxPositionPct / 100,
      minSignalLevel: "B",
      allowBSignals: true,
      allowCSignals: false,
      from: "",
      to: ""
    },
    lastRuns: [first.result, second.result]
  };
}
