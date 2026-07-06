export const STRUCTURAL_BREAKDOWN_TYPE = "structural_breakdown";
export const STRUCTURAL_BREAKDOWN_LABEL = "结构性崩溃";

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function average(values) {
  const filtered = values.map(Number).filter(Number.isFinite);
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0;
}

function percentile(values, pct) {
  const filtered = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const index = Math.min(filtered.length - 1, Math.max(0, Math.ceil((pct / 100) * filtered.length) - 1));
  return filtered[index];
}

function boolOption(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trueRange(current, previous) {
  if (!previous) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );
}

function atr(candles, period = 14) {
  const slice = candles.slice(-period);
  return average(slice.map((candle, index) => trueRange(candle, candles[candles.length - slice.length + index - 1])));
}

function rsi(candles, period = 14) {
  if (candles.length <= period) return null;
  const closes = candles.map((candle) => candle.close);
  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const diff = closes[index] - closes[index - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (!avgLoss) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function rsiSeries(candles, period = 14) {
  return candles.map((_, index) => rsi(candles.slice(0, index + 1), period));
}

function startOfWeek(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString();
}

function bucketKey(value, timeframe) {
  const date = new Date(value);
  if (timeframe === "W") return startOfWeek(value);
  if (timeframe === "M") return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  if (timeframe === "H4") {
    date.setUTCMinutes(0, 0, 0);
    date.setUTCHours(Math.floor(date.getUTCHours() / 4) * 4);
    return date.toISOString();
  }
  return date.toISOString();
}

export function aggregateCandles(candles = [], timeframe = "H4") {
  const buckets = new Map();
  for (const candle of candles) {
    if (!Number.isFinite(Number(candle?.close))) continue;
    const key = bucketKey(candle.t, timeframe);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        t: key,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume || 0)
      });
      continue;
    }
    existing.high = Math.max(existing.high, Number(candle.high));
    existing.low = Math.min(existing.low, Number(candle.low));
    existing.close = Number(candle.close);
    existing.volume += Number(candle.volume || 0);
  }
  return Array.from(buckets.values()).sort((a, b) => new Date(a.t) - new Date(b.t));
}

export function movingAverage(candles = [], period = 20) {
  if (candles.length < period) return null;
  return average(candles.slice(-period).map((candle) => candle.close));
}

function directionFromStructure(events) {
  const directions = new Set(events.map((event) => event.direction).filter(Boolean));
  if (directions.size !== 1) return null;
  return directions.values().next().value;
}

function structureLayer(candles) {
  const weekly = aggregateCandles(candles, "W");
  const monthly = aggregateCandles(candles, "M");
  const events = [];
  const evidence = [];
  let score = 0;

  const latestWeek = weekly.at(-1);
  const weeklyRsi = rsi(weekly, 14);
  if (latestWeek && weeklyRsi !== null && weeklyRsi > 75 && latestWeek.close < latestWeek.open) {
    score += 15;
    events.push({ key: "weekly_top_exhaustion", direction: "SHORT" });
    evidence.push(`周线 RSI(14) ${round(weeklyRsi, 1)} > 75 且本周阴线，顶部衰竭 +15`);
  }
  if (latestWeek && weeklyRsi !== null && weeklyRsi < 25 && latestWeek.close > latestWeek.open) {
    score += 15;
    events.push({ key: "weekly_bottom_exhaustion", direction: "LONG" });
    evidence.push(`周线 RSI(14) ${round(weeklyRsi, 1)} < 25 且本周阳线，底部衰竭 +15`);
  }

  const latestMonth = monthly.at(-1);
  const monthlyRsiValues = rsiSeries(monthly, 14);
  const latestMonthlyRsi = monthlyRsiValues.at(-1);
  const priorMonths = monthly.slice(Math.max(0, monthly.length - 13), -1);
  const priorRsi = monthlyRsiValues.slice(Math.max(0, monthlyRsiValues.length - 13), -1).filter(Number.isFinite);
  if (latestMonth && priorMonths.length >= 6 && latestMonthlyRsi !== null && priorRsi.length) {
    const priorCloseHigh = Math.max(...priorMonths.map((item) => item.close));
    const priorCloseLow = Math.min(...priorMonths.map((item) => item.close));
    const priorRsiHigh = Math.max(...priorRsi);
    const priorRsiLow = Math.min(...priorRsi);
    if (latestMonth.close > priorCloseHigh && latestMonthlyRsi <= priorRsiHigh) {
      score += 7;
      events.push({ key: "monthly_top_divergence", direction: "SHORT" });
      evidence.push(`月线收盘新高但 RSI ${round(latestMonthlyRsi, 1)} 未创新高，顶部背离 +7`);
    }
    if (latestMonth.close < priorCloseLow && latestMonthlyRsi >= priorRsiLow) {
      score += 7;
      events.push({ key: "monthly_bottom_divergence", direction: "LONG" });
      evidence.push(`月线收盘新低但 RSI ${round(latestMonthlyRsi, 1)} 未创新低，底部背离 +7`);
    }
  }

  return {
    score,
    direction: directionFromStructure(events),
    events,
    evidence,
    weekly,
    monthly,
    weeklyAtr: atr(weekly, Math.min(14, weekly.length)) || atr(candles, Math.min(14, candles.length)) || 0
  };
}

function cotFactor(macroSnapshot = {}) {
  return (macroSnapshot?.factors || []).find((item) => item.key === "cot") || {};
}

function cotRatios(cot) {
  const long = Number(cot.nonCommercialLong);
  const short = Number(cot.nonCommercialShort);
  const net = Number(cot.nonCommercialNet);
  const openInterest = Number(cot.totalOpenInterest || cot.openInterest || cot.totalPositions);
  if (Number.isFinite(openInterest) && openInterest > 0 && Number.isFinite(net)) {
    return {
      longCrowding: Math.max(0, net) / openInterest,
      shortCrowding: Math.max(0, -net) / openInterest
    };
  }
  if (Number.isFinite(long) && Number.isFinite(short) && long + short > 0) {
    const netLongRatio = long / (long + short);
    return {
      longCrowding: netLongRatio,
      shortCrowding: 1 - netLongRatio
    };
  }
  const percentileValue = Number(cot.value);
  if (Number.isFinite(percentileValue)) {
    return {
      longCrowding: percentileValue / 100,
      shortCrowding: (100 - percentileValue) / 100,
      percentileValue
    };
  }
  return { longCrowding: null, shortCrowding: null };
}

function cotHistoryPercentile(cot, key, fallbackPct) {
  const history = (cot.history || [])
    .map((item) => {
      if (Number.isFinite(Number(item?.[key]))) return Number(item[key]);
      if (Number.isFinite(Number(item?.v))) return Number(item.v) / 100;
      return null;
    })
    .filter(Number.isFinite)
    .slice(-52);
  if (history.length >= 10) return percentile(history, 90);
  return fallbackPct;
}

function emotionLayer(macroSnapshot, structureDirection) {
  const cot = cotFactor(macroSnapshot);
  const ratios = cotRatios(cot);
  const evidence = [];
  const events = [];
  let score = 0;

  const longThreshold = cotHistoryPercentile(cot, "longCrowding", 0.9);
  const shortThreshold = cotHistoryPercentile(cot, "shortCrowding", 0.9);
  const longCrowded = Number.isFinite(ratios.longCrowding) && ratios.longCrowding >= longThreshold;
  const shortCrowded = Number.isFinite(ratios.shortCrowding) && ratios.shortCrowding >= shortThreshold;

  if (longCrowded) {
    events.push({ key: "cot_long_crowded", direction: "SHORT" });
    evidence.push(`COT 投机净多拥挤 ${round(ratios.longCrowding * 100, 1)}% >= 1年90分位，+10`);
  }
  if (shortCrowded) {
    events.push({ key: "cot_short_crowded", direction: "LONG" });
    evidence.push(`COT 投机净空拥挤 ${round(ratios.shortCrowding * 100, 1)}% >= 1年90分位，+10`);
  }

  const directionalEvents = events.filter((event) => event.direction);
  const conflict = directionalEvents.some((event) => event.direction !== structureDirection);
  if (conflict) {
    return {
      score: 0,
      conflict: true,
      events,
      evidence: [...evidence, "结构层与情绪层方向冲突，sentinel 不触发"]
    };
  }

  score += directionalEvents.length ? 10 : 0;
  if (!directionalEvents.length) evidence.push("COT 拥挤度未到1年90分位，情绪层 0");
  return { score, conflict: false, events, evidence };
}

function normalizedTrade(trade) {
  const price = Number(trade.price ?? trade.px);
  const size = Number(trade.size ?? trade.sz);
  const t = trade.t || trade.time || (trade.ts ? new Date(Number(trade.ts)).toISOString() : "");
  const side = String(trade.side || "").toLowerCase();
  const notional = Number(trade.notional) || (Number.isFinite(price) && Number.isFinite(size) ? price * size : 0);
  if (!t || !Number.isFinite(notional) || notional <= 0) return null;
  return { t, side, price, size, notional };
}

function candleCvd(candles) {
  const last8 = candles.slice(-8);
  if (last8.length < 8) return null;
  const signed = last8.map((candle) => Number(candle.volume || 0) * Math.sign(Number(candle.close) - Number(candle.open)));
  const positive = signed.filter((value) => value > 0).length;
  const negative = signed.filter((value) => value < 0).length;
  const total = signed.reduce((sum, value) => sum + value, 0);
  if (negative >= 6 && total < 0) return { direction: "SHORT", total, source: "candles-proxy" };
  if (positive >= 6 && total > 0) return { direction: "LONG", total, source: "candles-proxy" };
  return { direction: null, total, source: "candles-proxy" };
}

function tradeCvd(trades, latestTime) {
  const latestMs = new Date(latestTime).getTime();
  const since = latestMs - 8 * 60 * 60 * 1000;
  const normalized = (trades || []).map(normalizedTrade).filter(Boolean)
    .filter((trade) => new Date(trade.t).getTime() >= since && new Date(trade.t).getTime() <= latestMs);
  if (normalized.length < 20) return null;
  const signed = normalized.map((trade) => trade.notional * (trade.side === "sell" ? -1 : 1));
  const total = signed.reduce((sum, value) => sum + value, 0);
  const firstMs = Math.min(...normalized.map((trade) => new Date(trade.t).getTime()));
  const coverageHours = (latestMs - firstMs) / 3600000;
  if (coverageHours < 1) return { direction: null, total, source: "okx-trades-short-window", coverageHours };
  return {
    direction: total > 0 ? "LONG" : total < 0 ? "SHORT" : null,
    total,
    source: "okx-trades",
    coverageHours
  };
}

function volumeSpike(candles) {
  const latest = candles.at(-1);
  const previous = candles.slice(-21, -1);
  const avg = average(previous.map((candle) => candle.volume || 0));
  if (!latest || previous.length < 20 || !avg) return null;
  const ratio = Number(latest.volume || 0) / avg;
  return { hit: ratio > 3, ratio };
}

function largeOrderSignal(trades, latestTime, options = {}) {
  const latestMs = new Date(latestTime).getTime();
  const since = latestMs - 60 * 60 * 1000;
  const normalized = (trades || []).map(normalizedTrade).filter(Boolean)
    .filter((trade) => new Date(trade.t).getTime() >= since && new Date(trade.t).getTime() <= latestMs);
  if (!normalized.length) return null;
  const btcUsd = numberOption(options.btcUsd, numberOption(options.largeOrderUsd, 100000));
  const threshold = btcUsd * numberOption(options.largeOrderBtcEquivalent, 1);
  const total = normalized.reduce((sum, trade) => sum + trade.notional, 0);
  const large = normalized.filter((trade) => trade.notional >= threshold);
  const largeNotional = large.reduce((sum, trade) => sum + trade.notional, 0);
  const ratio = total ? largeNotional / total : 0;
  const buyNotional = large.filter((trade) => trade.side !== "sell").reduce((sum, trade) => sum + trade.notional, 0);
  const sellNotional = largeNotional - buyNotional;
  return {
    hit: ratio > 0.3,
    ratio,
    threshold,
    direction: buyNotional > sellNotional ? "LONG" : sellNotional > buyNotional ? "SHORT" : null
  };
}

function fundingLayer({ candles, trades, latestTime, structureDirection, options }) {
  const evidence = [];
  const events = [];
  let score = 0;
  const tradeSignal = tradeCvd(trades, latestTime);
  const cvd = tradeSignal?.direction ? tradeSignal : candleCvd(candles);

  if (cvd?.direction === structureDirection) {
    score += 10;
    events.push({ key: "cvd_dominance", direction: cvd.direction });
    evidence.push(`滚动8小时 CVD ${cvd.direction === "SHORT" ? "持续为负，卖方主导" : "持续为正，买方主导"}，+10 (${cvd.source})`);
  } else if (cvd?.direction) {
    evidence.push(`滚动8小时 CVD 指向 ${cvd.direction}，与结构方向不一致，资金CVD 0 (${cvd.source})`);
  } else {
    evidence.push("滚动8小时 CVD 未形成持续单边，资金CVD 0");
  }

  const spike = volumeSpike(candles);
  if (spike?.hit) {
    score += 8;
    events.push({ key: "h1_volume_spike" });
    evidence.push(`当前 H1 成交量为过去20根均值 ${round(spike.ratio, 2)}x，放量 +8`);
  } else if (spike) {
    evidence.push(`当前 H1 成交量 ${round(spike.ratio, 2)}x，未到3x，放量 0`);
  }

  const large = largeOrderSignal(trades, latestTime, options);
  if (large?.hit && (!large.direction || large.direction === structureDirection)) {
    score += 7;
    events.push({ key: "large_order_ratio", direction: large.direction });
    evidence.push(`近1小时 >=1 BTC等值大单占比 ${round(large.ratio * 100, 1)}%，机构行动 +7`);
  } else if (large?.hit) {
    evidence.push(`近1小时大单占比 ${round(large.ratio * 100, 1)}%，但方向与结构不一致，机构行动 0`);
  } else if (large) {
    evidence.push(`近1小时大单占比 ${round(large.ratio * 100, 1)}%，未到30%，机构行动 0`);
  } else {
    evidence.push("OKX 逐笔成交样本不足，大单占比 0");
  }

  return { score, events, evidence };
}

function stopAnchor(weekly, direction, weeklyAtr, latestClose) {
  const bodies = weekly.map((candle) => Math.abs(candle.close - candle.open));
  const avgBody = average(bodies.slice(-26));
  const isBigBull = (candle) => candle.close > candle.open && Math.abs(candle.close - candle.open) >= Math.max(avgBody, weeklyAtr * 0.35);
  const isBigBear = (candle) => candle.close < candle.open && Math.abs(candle.close - candle.open) >= Math.max(avgBody, weeklyAtr * 0.35);
  const found = weekly.slice(0, -1).reverse().find(direction === "SHORT" ? isBigBull : isBigBear)
    || weekly.slice().reverse().find(direction === "SHORT" ? (candle) => candle.close > candle.open : (candle) => candle.close < candle.open);
  if (direction === "SHORT") return (found?.high ?? latestClose) + weeklyAtr * 0.5;
  return (found?.low ?? latestClose) - weeklyAtr * 0.5;
}

function sentinelOptions(settings = {}) {
  const configured = settings?.strategy?.structuralBreakdown || {};
  const enabledTypes = settings?.strategy?.enabledSignalTypes || {};
  const risk = settings?.risk || {};
  return {
    enabled: boolOption(enabledTypes[STRUCTURAL_BREAKDOWN_TYPE], boolOption(configured.enabled, false)),
    useFundingData: boolOption(configured.useFundingData, false),
    thresholdA: numberOption(configured.thresholdA, configured.useFundingData ? 45 : 30),
    thresholdS: numberOption(configured.thresholdS, configured.useFundingData ? 60 : 40),
    allowedUtcStart: numberOption(configured.allowedUtcStart, 8),
    allowedUtcEnd: numberOption(configured.allowedUtcEnd, 17),
    largeOrderBtcEquivalent: numberOption(configured.largeOrderBtcEquivalent, 1),
    largeOrderUsd: numberOption(configured.largeOrderUsd, 100000),
    positionSizeMultiplier: numberOption(risk.structuralBreakdownPositionFactor, 0.5)
  };
}

function gradeForScore(score, options) {
  if (score >= options.thresholdS) return "S";
  if (score >= options.thresholdA) return "A";
  return null;
}

export function detectStructuralBreakdown({ candles = [], macroSnapshot = {}, settings = {}, marketFlow = {} } = {}) {
  const options = sentinelOptions(settings);
  if (!options.enabled || candles.length < 120) return null;
  const latest = candles.at(-1);
  const latestTime = latest?.t || new Date().toISOString();
  const utcHour = new Date(latestTime).getUTCHours();
  if (utcHour < options.allowedUtcStart || utcHour > options.allowedUtcEnd) return null;

  const structure = structureLayer(candles);
  if (!structure.direction) return null;

  const emotion = emotionLayer(macroSnapshot, structure.direction);
  if (emotion.conflict) return null;

  const funding = options.useFundingData
    ? fundingLayer({
      candles,
      trades: marketFlow.trades || [],
      latestTime,
      structureDirection: structure.direction,
      options: {
        btcUsd: marketFlow.btcUsd,
        largeOrderBtcEquivalent: options.largeOrderBtcEquivalent,
        largeOrderUsd: options.largeOrderUsd
      }
    })
    : { score: 0, events: [], evidence: ["资金层关闭：最小版只使用结构层 + COT 情绪层"] };

  const infoEvidence = ["信息层第一版占位，新闻API未接入，0"];
  const totalScore = structure.score + emotion.score + funding.score;
  const grade = gradeForScore(totalScore, options);
  if (!grade) return null;

  const stop = stopAnchor(structure.weekly, structure.direction, structure.weeklyAtr, latest.close);
  const directionText = structure.direction === "SHORT" ? "顶部衰竭做空" : "底部衰竭做多";
  return {
    type: STRUCTURAL_BREAKDOWN_TYPE,
    typeLabel: STRUCTURAL_BREAKDOWN_LABEL,
    direction: structure.direction,
    entry: round(latest.close),
    stop: round(stop),
    target: null,
    support: structure.direction === "LONG" ? round(stop) : undefined,
    resistance: structure.direction === "SHORT" ? round(stop) : undefined,
    breakoutLevel: null,
    confidence: grade === "S" ? 90 : 78,
    gradeOverride: grade,
    scoreOverride: grade === "S" ? 90 : 78,
    sentinelScore: totalScore,
    exitMode: "ma20_h4_trailing",
    maxPositionMultiplier: options.positionSizeMultiplier,
    evidence: [
      `${directionText} sentinel 总分 ${totalScore}，评级 ${grade}`,
      ...structure.evidence,
      ...emotion.evidence,
      ...funding.evidence,
      ...infoEvidence
    ],
    adjustments: [],
    gradeAdjustment: 0,
    rangePosition: structure.direction === "SHORT" ? 0.9 : 0.1,
    atr: round(structure.weeklyAtr, 3),
    atrValue: round(structure.weeklyAtr, 3),
    atrRatio: 1,
    volatilityRatio: 1,
    stopMultiplier: 0.5,
    sentinel: {
      score: totalScore,
      grade,
      structureScore: structure.score,
      emotionScore: emotion.score,
      fundingScore: funding.score,
      informationScore: 0,
      scanIntervalHours: 4,
      allowedUtcHours: [options.allowedUtcStart, options.allowedUtcEnd],
      useFundingData: options.useFundingData,
      events: [
        ...structure.events,
        ...emotion.events,
        ...funding.events
      ]
    }
  };
}
