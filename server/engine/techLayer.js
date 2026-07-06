const TYPE_LABELS = {
  range_revert: "斐波回归",
  breakout: "突破",
  fakeout: "斐波假突破",
  momentum: "时段动量",
  support_reversal: "支撑反转",
  structural_breakdown: "结构性崩溃"
};

const FIB_LEVELS = [
  { key: "0.618", ratio: 0.618 },
  { key: "0.50", ratio: 0.5 },
  { key: "0.382", ratio: 0.382 }
];

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOption(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
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

function stdDev(values) {
  if (!values.length) return 0;
  const avg = average(values);
  const variance = average(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function percentileRank(values, value) {
  if (!values.length || !Number.isFinite(value)) return 50;
  const below = values.filter((item) => item <= value).length;
  return (below / values.length) * 100;
}

function rsi(candles, period = 14) {
  if (candles.length <= period) return 50;
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

function bollingerWidthSeries(candles, period = 20) {
  const widths = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    const closes = candles.slice(index - period + 1, index + 1).map((candle) => candle.close);
    const mid = average(closes);
    if (mid) widths.push((stdDev(closes) * 4) / mid);
  }
  return widths;
}

function bollingerRegime(candles, lookback = 120 * 24) {
  const widths = bollingerWidthSeries(candles);
  const current = widths.at(-1);
  const history = widths.slice(Math.max(0, widths.length - lookback - 1), -1);
  const percentile = percentileRank(history, current);
  if (percentile < 25) return { regime: "contraction", percentile, width: current };
  if (percentile > 75) return { regime: "expansion", percentile, width: current };
  return { regime: "normal", percentile, width: current };
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function previousDayRange(candles, currentTime) {
  const currentDay = dateKey(currentTime);
  const prior = candles.filter((candle) => dateKey(candle.t) < currentDay);
  const previousDay = prior.at(-1) ? dateKey(prior.at(-1).t) : "";
  const rows = prior.filter((candle) => dateKey(candle.t) === previousDay);
  if (!rows.length) return null;
  return {
    day: previousDay,
    high: Math.max(...rows.map((candle) => candle.high)),
    low: Math.min(...rows.map((candle) => candle.low))
  };
}

function londonOpenDirection(candles, currentTime) {
  const current = new Date(currentTime);
  if (current.getUTCHours() < 9) return "FLAT";
  const currentDay = dateKey(currentTime);
  const london = candles.find((candle) => {
    const date = new Date(candle.t);
    return dateKey(candle.t) === currentDay && date.getUTCHours() === 8;
  });
  if (!london) return "FLAT";
  if (london.close > london.open) return "LONG";
  if (london.close < london.open) return "SHORT";
  return "FLAT";
}

function stopMultiplierForVolatility(volatilityRatio, options = {}) {
  if (boolOption(options.dynamicATRStop, false)) {
    if (volatilityRatio > numberOption(options.dynamicStopHighThreshold, 1.3)) {
      return numberOption(options.dynamicStopHigh, 2.0);
    }
    if (volatilityRatio < numberOption(options.dynamicStopLowThreshold, 0.8)) {
      return numberOption(options.dynamicStopLow, 1.2);
    }
    return numberOption(options.dynamicStopMedium, 1.5);
  }
  return numberOption(options.fixedStopAtrMultiplier, 1.5);
}

function bucketStart(value, hours = 4) {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(Math.floor(date.getUTCHours() / hours) * hours);
  return date.toISOString();
}

function toH4Candles(candles) {
  const buckets = new Map();
  for (const candle of candles) {
    const key = bucketStart(candle.t, 4);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        t: key,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume || 0;
  }
  return Array.from(buckets.values()).sort((a, b) => new Date(a.t) - new Date(b.t));
}

function sessionDirection(candles, startHour, endHour) {
  const session = candles.filter((candle) => {
    const hour = new Date(candle.t).getUTCHours();
    return hour >= startHour && hour < endHour;
  });
  if (!session.length) return "FLAT";
  const open = session[0].open;
  const close = session.at(-1).close;
  if (close > open) return "LONG";
  if (close < open) return "SHORT";
  return "FLAT";
}

function targetFor(signal, range, atrValue, stopMultiplier) {
  if (signal.direction === "LONG") {
    return {
      stop: round(signal.entry - atrValue * stopMultiplier),
      target: round(signal.entry + Math.max(atrValue * 2.2, (range.high - signal.entry) * 0.8))
    };
  }
  return {
    stop: round(signal.entry + atrValue * stopMultiplier),
    target: round(signal.entry - Math.max(atrValue * 2.2, (signal.entry - range.low) * 0.8))
  };
}

function candleParts(candle) {
  const fullRange = Math.max(0.0001, candle.high - candle.low);
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return { fullRange, body, upperWick, lowerWick };
}

function bullishPinBar(candle) {
  const { body, lowerWick } = candleParts(candle);
  return lowerWick > Math.max(body, 0.0001) * 2;
}

function bearishPinBar(candle) {
  const { body, upperWick } = candleParts(candle);
  return upperWick > Math.max(body, 0.0001) * 2;
}

function hammer(candle) {
  const { fullRange, body, lowerWick } = candleParts(candle);
  const bodyTop = Math.max(candle.open, candle.close);
  return lowerWick > Math.max(body, 0.0001) * 3 && bodyTop >= candle.low + fullRange * 0.65;
}

function bullishEngulfing(current, previous) {
  return previous.close < previous.open
    && current.close > current.open
    && current.open <= previous.close
    && current.close >= previous.open;
}

function bearishEngulfing(current, previous) {
  return previous.close > previous.open
    && current.close < current.open
    && current.open >= previous.close
    && current.close <= previous.open;
}

function isSwingHigh(candles, index, pivotBars = 2) {
  const high = candles[index].high;
  for (let offset = -pivotBars; offset <= pivotBars; offset += 1) {
    if (offset !== 0 && candles[index + offset].high >= high) return false;
  }
  return true;
}

function isSwingLow(candles, index, pivotBars = 2) {
  const low = candles[index].low;
  for (let offset = -pivotBars; offset <= pivotBars; offset += 1) {
    if (offset !== 0 && candles[index + offset].low <= low) return false;
  }
  return true;
}

function findSwingPoints(candles, maxLookback = 240, pivotBars = 2) {
  const start = Math.max(pivotBars, candles.length - maxLookback);
  const highs = [];
  const lows = [];
  for (let index = start; index <= candles.length - pivotBars - 1; index += 1) {
    if (isSwingHigh(candles, index, pivotBars)) highs.push({ index, value: candles[index].high, candle: candles[index] });
    if (isSwingLow(candles, index, pivotBars)) lows.push({ index, value: candles[index].low, candle: candles[index] });
  }
  return { highs, lows };
}

function fallbackExtreme(candles, endIndex, side) {
  const slice = candles.slice(Math.max(0, endIndex - 120), Math.max(1, endIndex));
  if (!slice.length) return null;
  if (side === "low") {
    return slice.reduce((best, candle, index) => candle.low < best.value
      ? { index: Math.max(0, endIndex - 120) + index, value: candle.low, candle }
      : best, { index: 0, value: Number.POSITIVE_INFINITY, candle: slice[0] });
  }
  return slice.reduce((best, candle, index) => candle.high > best.value
    ? { index: Math.max(0, endIndex - 120) + index, value: candle.high, candle }
    : best, { index: 0, value: Number.NEGATIVE_INFINITY, candle: slice[0] });
}

function buildFibSwing(candles) {
  if (candles.length < 24) return null;
  const { highs, lows } = findSwingPoints(candles);
  const latestHigh = highs.at(-1);
  const latestLow = lows.at(-1);
  if (!latestHigh || !latestLow) return null;

  const referenceIsHigh = latestHigh.index > latestLow.index;
  const reference = referenceIsHigh ? latestHigh : latestLow;
  const opposite = referenceIsHigh
    ? lows.filter((item) => item.index < reference.index).at(-1) || fallbackExtreme(candles, reference.index, "low")
    : highs.filter((item) => item.index < reference.index).at(-1) || fallbackExtreme(candles, reference.index, "high");
  if (!opposite || reference.index === opposite.index) return null;

  const high = referenceIsHigh ? reference : opposite;
  const low = referenceIsHigh ? opposite : reference;
  const width = Math.max(0.0001, high.value - low.value);
  const levels = Object.fromEntries(FIB_LEVELS.map((level) => [
    level.key,
    referenceIsHigh
      ? high.value - width * level.ratio
      : low.value + width * level.ratio
  ]));
  return {
    direction: referenceIsHigh ? "pullbackFromHigh" : "bounceFromLow",
    reference,
    opposite,
    high,
    low,
    width,
    levels
  };
}

function touchesLevel(candle, level, tolerance = 0) {
  return candle.low - tolerance <= level && candle.high + tolerance >= level;
}

function confirmationFor(direction, latest, previous) {
  if (direction === "LONG") {
    return {
      pin: bullishPinBar(latest),
      engulfing: bullishEngulfing(latest, previous),
      hammer: hammer(latest)
    };
  }
  return {
    pin: bearishPinBar(latest),
    engulfing: bearishEngulfing(latest, previous),
    hammer: false
  };
}

function fibRangePosition(close, fib) {
  return (close - fib.low.value) / Math.max(0.0001, fib.width);
}

function makeSignal(input) {
  const stopMultiplier = numberOption(input.stopMultiplier, 1.5);
  const hasCustomLevels = Number.isFinite(Number(input.stop)) && Number.isFinite(Number(input.target));
  const levels = hasCustomLevels
    ? { stop: Number(input.stop), target: Number(input.target) }
    : targetFor(input, input.range, input.atrValue, stopMultiplier);
  return {
    type: input.type,
    typeLabel: TYPE_LABELS[input.type] || input.type,
    direction: input.direction,
    entry: round(input.entry),
    stop: levels.stop,
    target: levels.target,
    support: input.support,
    resistance: input.resistance,
    breakoutLevel: input.breakoutLevel,
    confidence: Math.max(45, Math.min(96, Math.round(input.confidence))),
    evidence: input.evidence,
    adjustments: input.adjustments || [],
    gradeAdjustment: Number(input.gradeAdjustment || 0),
    rangePosition: round(input.rangePosition, 3),
    atr: round(input.atrValue, 3),
    atrRatio: round(input.atrRatio, 3),
    volatilityRatio: round(input.volatilityRatio ?? input.atrRatio, 3),
    stopMultiplier: round(stopMultiplier, 2)
  };
}

function detectFibRangeRevert(h4Candles, fib, atrValue, atrRatio, volatilityRatio, options = {}) {
  const latest = h4Candles.at(-1);
  const previous = h4Candles.at(-2);
  const range = { high: fib.high.value, low: fib.low.value };
  const direction = fib.direction === "pullbackFromHigh" ? "LONG" : "SHORT";
  const confirmation = confirmationFor(direction, latest, previous);
  const candidates = [];

  if (touchesLevel(latest, fib.levels["0.618"], atrValue * 0.05)) {
    const ok = confirmation.pin || confirmation.engulfing || confirmation.hammer;
    if (ok) {
      candidates.push({
        level: "0.618",
        confidence: confirmation.pin ? 80 : 70,
        pattern: confirmation.pin ? (direction === "LONG" ? "Pin Bar" : "Shooting Star")
          : confirmation.engulfing ? (direction === "LONG" ? "Bullish Engulfing" : "Bearish Engulfing")
            : "Hammer"
      });
    }
  }
  if (touchesLevel(latest, fib.levels["0.50"], atrValue * 0.05) && confirmation.engulfing) {
    candidates.push({
      level: "0.50",
      confidence: 70,
      pattern: direction === "LONG" ? "Bullish Engulfing" : "Bearish Engulfing"
    });
  }
  if (touchesLevel(latest, fib.levels["0.382"], atrValue * 0.05) && confirmation.pin) {
    candidates.push({
      level: "0.382",
      confidence: 65,
      pattern: direction === "LONG" ? "Pin Bar" : "Shooting Star"
    });
  }
  const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
  if (!best) return null;

  return makeSignal({
    type: "range_revert",
    direction,
    entry: latest.close,
    range,
    rangePosition: fibRangePosition(latest.close, fib),
    atrValue,
    atrRatio,
    volatilityRatio,
    stopMultiplier: stopMultiplierForVolatility(volatilityRatio, options),
    confidence: best.confidence,
    evidence: [
      `H4 swing ${fib.direction === "pullbackFromHigh" ? "高点回落" : "低点反弹"}`,
      `触及 Fib ${best.level} (${round(fib.levels[best.level])})`,
      `${best.pattern} 确认`,
      `前高 ${round(fib.high.value)} / 前低 ${round(fib.low.value)}`
    ]
  });
}

function keyFibLevels(fib) {
  return [
    ...FIB_LEVELS.map((level) => ({ label: `Fib ${level.key}`, price: fib.levels[level.key] })),
    { label: "前高", price: fib.high.value },
    { label: "前低", price: fib.low.value }
  ];
}

function fakeoutVolumeCheck(h4Candles, breakIndex, enabled) {
  if (!enabled) return { allow: true, confidence: 70, evidence: [] };
  const breakCandle = h4Candles[breakIndex];
  const sample = h4Candles.slice(Math.max(0, breakIndex - 5), breakIndex);
  const avgVolume = average(sample.map((candle) => Number(candle.volume || 0)));
  const breakVolume = Number(breakCandle?.volume || 0);
  if (!avgVolume || !breakVolume) return { allow: true, confidence: 70, evidence: ["量能样本不足，保留假突破"] };
  const ratio = breakVolume / avgVolume;
  if (ratio > 1.5) {
    return {
      allow: false,
      confidence: 0,
      evidence: [`突破量能 ${round(ratio, 2)}x 前5均量，疑似真突破，跳过`]
    };
  }
  if (ratio < 1) {
    return {
      allow: true,
      confidence: 78,
      evidence: [`突破量能 ${round(ratio, 2)}x 前5均量，低量假突破确认`]
    };
  }
  return {
    allow: true,
    confidence: 70,
    evidence: [`突破量能 ${round(ratio, 2)}x 前5均量，未放大`]
  };
}

function detectFibFakeout(h4Candles, fib, atrValue, atrRatio, volatilityRatio, options = {}) {
  const latest = h4Candles.at(-1);
  const previousBars = h4Candles.slice(-3, -1).map((candle, offset) => ({
    candle,
    index: h4Candles.length - 3 + offset
  }));
  const range = { high: fib.high.value, low: fib.low.value };
  const tolerance = atrValue * 0.03;
  const volumeFilter = boolOption(options.volumeFilter, false);

  for (const level of keyFibLevels(fib)) {
    const upsideBreak = previousBars.find(({ candle }) => candle.high > level.price + tolerance && candle.close > level.price);
    if (upsideBreak && latest.close < level.price - tolerance) {
      const volume = fakeoutVolumeCheck(h4Candles, upsideBreak.index, volumeFilter);
      if (!volume.allow) continue;
      return makeSignal({
        type: "fakeout",
        direction: "SHORT",
        entry: latest.close,
        range,
        rangePosition: fibRangePosition(latest.close, fib),
        atrValue,
        atrRatio,
        volatilityRatio,
        stopMultiplier: stopMultiplierForVolatility(volatilityRatio, options),
        confidence: volume.confidence,
        evidence: [
          `${level.label} 上破后2根H4内收回`,
          `关键位 ${round(level.price)}`,
          ...volume.evidence,
          "假突破反向确认"
        ]
      });
    }

    const downsideBreak = previousBars.find(({ candle }) => candle.low < level.price - tolerance && candle.close < level.price);
    if (downsideBreak && latest.close > level.price + tolerance) {
      const volume = fakeoutVolumeCheck(h4Candles, downsideBreak.index, volumeFilter);
      if (!volume.allow) continue;
      return makeSignal({
        type: "fakeout",
        direction: "LONG",
        entry: latest.close,
        range,
        rangePosition: fibRangePosition(latest.close, fib),
        atrValue,
        atrRatio,
        volatilityRatio,
        stopMultiplier: stopMultiplierForVolatility(volatilityRatio, options),
        confidence: volume.confidence,
        evidence: [
          `${level.label} 下破后2根H4内收回`,
          `关键位 ${round(level.price)}`,
          ...volume.evidence,
          "假突破反向确认"
        ]
      });
    }
  }
  return null;
}

function detectMomentum(h4Candles, range, atrValue, atrRatio, volatilityRatio, options = {}) {
  const lastDay = h4Candles.slice(-6);
  const london = sessionDirection(lastDay, 7, 12);
  const newYork = sessionDirection(lastDay, 12, 17);
  if (london === "FLAT" || london !== newYork) return null;
  const latest = h4Candles.at(-1);
  return makeSignal({
    type: "momentum",
    direction: london,
    entry: latest.close,
    range,
    rangePosition: (latest.close - range.low) / Math.max(0.0001, range.high - range.low),
    atrValue,
    atrRatio,
    volatilityRatio,
    stopMultiplier: stopMultiplierForVolatility(volatilityRatio, options),
    confidence: 55,
    evidence: [
      `伦敦H4方向 ${london}`,
      `纽约H4方向 ${newYork}`,
      "H4 时段动量同向"
    ]
  });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ma(candles, period = 5) {
  return average(candles.slice(-period).map((candle) => candle.close));
}

function lineValue(first, second, index) {
  const width = Math.max(1, second.index - first.index);
  const slope = (second.value - first.value) / width;
  return first.value + slope * (index - first.index);
}

function lowerHighs(highs) {
  const last = highs.slice(-3);
  return last.length === 3 && last[0].value > last[1].value && last[1].value > last[2].value;
}

function higherLows(lows) {
  const last = lows.slice(-3);
  return last.length === 3 && last[0].value < last[1].value && last[1].value < last[2].value;
}

function clusterPivotZone(pivots, candles, side, atrValue) {
  const recent = pivots.filter((pivot) => pivot.index >= candles.length - 80);
  let best = null;
  for (const pivot of recent) {
    const tolerance = Math.max(pivot.value * 0.0035, atrValue * 0.5);
    const group = recent.filter((item) => Math.abs(item.value - pivot.value) <= tolerance);
    if (group.length < 2) continue;
    const value = median(group.map((item) => item.value));
    const firstIndex = Math.min(...group.map((item) => item.index));
    const invalid = candles.slice(firstIndex + 1).some((candle) => (
      side === "support"
        ? candle.close < value - atrValue * 0.35
        : candle.close > value + atrValue * 0.35
    ));
    if (invalid) continue;
    const candidate = {
      value,
      touches: group.length,
      firstIndex,
      lastIndex: Math.max(...group.map((item) => item.index))
    };
    if (!best || candidate.touches > best.touches || candidate.lastIndex > best.lastIndex) best = candidate;
  }
  return best;
}

function slowMoveConfirmed(candles, direction, atrValue, atr50, enabled) {
  if (!enabled) return true;
  const recent = candles.slice(-12);
  if (recent.length < 12) return false;
  const move = recent.at(-1).close - recent[0].open;
  const bodyTooLarge = recent.some((candle) => {
    const body = Math.abs(candle.close - candle.open);
    if (body <= atrValue * 1.2) return false;
    return direction === "LONG" ? candle.close < candle.open : candle.close > candle.open;
  });
  if (bodyTooLarge || !(atrValue < atr50)) return false;
  if (direction === "LONG") return move < 0 && Math.abs(move) <= atrValue * 2;
  return move > 0 && Math.abs(move) <= atrValue * 2;
}

function supportReversalTrigger(candles, setup, direction, atrValue, index = candles.length - 1) {
  const candle = candles[index];
  const trendline = lineValue(setup.line[0], setup.line[1], index);
  const ma5 = average(candles.slice(Math.max(0, index - 4), index + 1).map((item) => item.close));
  if (direction === "LONG") {
    return candle.close > trendline + atrValue * 0.15
      && candle.close > setup.breakoutLevel
      && candle.close > ma5;
  }
  return candle.close < trendline - atrValue * 0.15
    && candle.close < setup.breakoutLevel
    && candle.close < ma5;
}

function supportReversalRetest(candles, setup, direction, atrValue) {
  const latest = candles.at(-1);
  const tolerance = atrValue * 0.35;
  for (let index = Math.max(0, candles.length - 9); index <= candles.length - 2; index += 1) {
    if (!supportReversalTrigger(candles, setup, direction, atrValue, index)) continue;
    if (direction === "LONG") {
      return latest.low <= setup.breakoutLevel + tolerance && latest.close > setup.breakoutLevel;
    }
    return latest.high >= setup.breakoutLevel - tolerance && latest.close < setup.breakoutLevel;
  }
  return false;
}

function detectSupportReversal(candles, atrValue, atrRatio, volatilityRatio, options = {}) {
  if (!boolOption(options.supportReversalEnabled, false) || candles.length < 120) return null;
  const pivotBars = Number(options.supportReversalPivotBars || 3);
  const entryMode = options.supportReversalEntry === "retest" ? "retest" : "direct";
  const slowFilter = boolOption(options.supportReversalSlowFilter, true);
  const { highs, lows } = findSwingPoints(candles, 180, pivotBars);
  const atr50 = atr(candles, Math.min(50, candles.length));
  const latest = candles.at(-1);
  const latestIndex = candles.length - 1;
  const signals = [];

  if (lowerHighs(highs)) {
    const line = highs.slice(-2);
    const support = clusterPivotZone(lows, candles, "support", atrValue);
    const breakoutLevel = line.at(-1)?.value;
    const setup = { line, support, breakoutLevel };
    const triggered = entryMode === "retest"
      ? supportReversalRetest(candles, setup, "LONG", atrValue)
      : supportReversalTrigger(candles, setup, "LONG", atrValue, latestIndex);
    if (support && breakoutLevel && triggered && slowMoveConfirmed(candles, "LONG", atrValue, atr50, slowFilter)) {
      const stop = support.value - atrValue * 0.5;
      const risk = Math.max(0.01, latest.close - stop);
      signals.push(makeSignal({
        type: "support_reversal",
        direction: "LONG",
        entry: latest.close,
        stop,
        target: latest.close + risk * 3,
        support: round(support.value),
        breakoutLevel: round(breakoutLevel),
        range: { high: breakoutLevel, low: support.value },
        rangePosition: 0.35,
        atrValue,
        atrRatio,
        volatilityRatio,
        stopMultiplier: 0.5,
        confidence: entryMode === "retest" ? 76 : 70,
        evidence: [
          "3个pivot high逐步降低",
          `支撑区 ${round(support.value)} ${support.touches}次触碰`,
          entryMode === "retest" ? "突破后回踩R1不破" : "突破下降趋势线与短线压力",
          slowFilter ? "慢跌缩波确认" : "慢跌过滤关闭"
        ]
      }));
    }
  }

  if (higherLows(lows)) {
    const line = lows.slice(-2);
    const resistance = clusterPivotZone(highs, candles, "resistance", atrValue);
    const breakoutLevel = line.at(-1)?.value;
    const setup = { line, resistance, breakoutLevel };
    const triggered = entryMode === "retest"
      ? supportReversalRetest(candles, setup, "SHORT", atrValue)
      : supportReversalTrigger(candles, setup, "SHORT", atrValue, latestIndex);
    if (resistance && breakoutLevel && triggered && slowMoveConfirmed(candles, "SHORT", atrValue, atr50, slowFilter)) {
      const stop = resistance.value + atrValue * 0.5;
      const risk = Math.max(0.01, stop - latest.close);
      signals.push(makeSignal({
        type: "support_reversal",
        direction: "SHORT",
        entry: latest.close,
        stop,
        target: latest.close - risk * 3,
        resistance: round(resistance.value),
        breakoutLevel: round(breakoutLevel),
        range: { high: resistance.value, low: breakoutLevel },
        rangePosition: 0.65,
        atrValue,
        atrRatio,
        volatilityRatio,
        stopMultiplier: 0.5,
        confidence: entryMode === "retest" ? 76 : 70,
        evidence: [
          "3个pivot low逐步抬高",
          `压力区 ${round(resistance.value)} ${resistance.touches}次触碰`,
          entryMode === "retest" ? "跌破后回踩支撑不破" : "跌破上升趋势线与短线支撑",
          slowFilter ? "慢涨缩波确认" : "慢涨过滤关闭"
        ]
      }));
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)[0] || null;
}

function adjustConfidence(signal, delta, reason) {
  return {
    ...signal,
    confidence: Math.max(45, Math.min(96, Math.round(signal.confidence + delta))),
    adjustments: [...(signal.adjustments || []), reason],
    evidence: [...(signal.evidence || []), reason]
  };
}

function downgradeSignal(signal, reason) {
  return {
    ...signal,
    gradeAdjustment: Number(signal.gradeAdjustment || 0) - 1,
    adjustments: [...(signal.adjustments || []), reason],
    evidence: [...(signal.evidence || []), reason]
  };
}

function nearPreviousDayLevel(signal, previousDay, tolerancePct = 0.001) {
  if (!previousDay) return null;
  const highTolerance = previousDay.high * tolerancePct;
  const lowTolerance = previousDay.low * tolerancePct;
  if (Math.abs(signal.entry - previousDay.high) <= highTolerance) return "前日高点";
  if (Math.abs(signal.entry - previousDay.low) <= lowTolerance) return "前日低点";
  return null;
}

function applySignalEnhancements(signals, context, options = {}) {
  return signals.map((signal) => {
    let next = signal;
    if (boolOption(options.bollingerRegimeFilter, false)) {
      if (context.bb.regime === "contraction" && next.type === "fakeout") {
        next = downgradeSignal(next, `BB宽度 ${round(context.bb.percentile, 1)}分位收缩期，假突破降一级`);
      }
      if (context.bb.regime === "expansion" && next.type === "breakout") {
        next = downgradeSignal(next, `BB宽度 ${round(context.bb.percentile, 1)}分位扩张期，突破降一级`);
      }
    }
    if (boolOption(options.previousDayLevelBoost, false) && next.type === "fakeout") {
      const level = nearPreviousDayLevel(next, context.previousDay);
      if (level) next = adjustConfidence(next, 15, `假突破贴近${level}±0.1%，置信度+15`);
    }
    if (boolOption(options.rsiDivergenceBoost, false) && next.type === "fakeout") {
      if (next.direction === "SHORT" && context.rsi > 70) {
        next = adjustConfidence(next, 10, `RSI ${round(context.rsi, 1)} 超买，做空假突破置信度+10`);
      }
      if (next.direction === "LONG" && context.rsi < 30) {
        next = adjustConfidence(next, 10, `RSI ${round(context.rsi, 1)} 超卖，做多假突破置信度+10`);
      }
    }
    if (boolOption(options.londonOpenDirectionFilter, false)
      && context.londonDirection !== "FLAT"
      && next.direction !== context.londonDirection) {
      next = downgradeSignal(next, `伦敦开盘方向${context.londonDirection}，反向信号降一级`);
    }
    return next;
  });
}

export function detectTechnicalSignals(candles = [], options = {}) {
  if (candles.length < 20) return [];
  const atrThreshold = numberOption(options.atrThreshold, 1.12);
  const fakeoutVolumeFilter = boolOption(options.fakeoutVolumeFilter, false);
  const latest = candles.at(-1);
  const lookback = candles.slice(-Math.min(candles.length, 120));
  const priorRange = lookback.slice(0, -1);
  const rangeHigh = Math.max(...priorRange.map((item) => item.high));
  const rangeLow = Math.min(...priorRange.map((item) => item.low));
  const rangeWidth = Math.max(0.0001, rangeHigh - rangeLow);
  const rangePosition = (latest.close - rangeLow) / rangeWidth;
  const atrValue = atr(candles, 14);
  const longAtr = atr(candles, Math.min(48, candles.length));
  const atrRatio = longAtr ? atrValue / longAtr : 1;
  const volatilityAtr = atr(candles, Math.min(60 * 24, candles.length));
  const volatilityRatio = volatilityAtr ? atrValue / volatilityAtr : 1;
  const breakoutRange = { high: rangeHigh, low: rangeLow };
  const signals = [];

  const h4Candles = toH4Candles(candles);
  const h4AtrValue = atr(h4Candles, Math.min(14, h4Candles.length));
  const h4LongAtr = atr(h4Candles, Math.min(48, h4Candles.length));
  const h4AtrRatio = h4LongAtr ? h4AtrValue / h4LongAtr : 1;
  const h4VolatilityAtr = atr(h4Candles, Math.min(60 * 6, h4Candles.length));
  const h4VolatilityRatio = h4VolatilityAtr ? h4AtrValue / h4VolatilityAtr : 1;
  const fib = buildFibSwing(h4Candles);

  if (fib) {
    const fibRangeSignal = detectFibRangeRevert(
      h4Candles,
      fib,
      h4AtrValue || atrValue,
      h4AtrRatio || atrRatio,
      h4VolatilityRatio || volatilityRatio,
      options
    );
    if (fibRangeSignal) signals.push(fibRangeSignal);

    const fakeoutSignal = detectFibFakeout(
      h4Candles,
      fib,
      h4AtrValue || atrValue,
      h4AtrRatio || atrRatio,
      h4VolatilityRatio || volatilityRatio,
      { ...options, volumeFilter: fakeoutVolumeFilter }
    );
    if (fakeoutSignal) signals.push(fakeoutSignal);
  }

  const momentumSignal = detectMomentum(
    h4Candles,
    fib ? { high: fib.high.value, low: fib.low.value } : breakoutRange,
    h4AtrValue || atrValue,
    h4AtrRatio || atrRatio,
    h4VolatilityRatio || volatilityRatio,
    options
  );
  if (momentumSignal) signals.push(momentumSignal);

  const supportReversalSignal = detectSupportReversal(
    candles,
    atrValue,
    atrRatio,
    volatilityRatio,
    options
  );
  if (supportReversalSignal) signals.push(supportReversalSignal);

  const breakUp = latest.close > rangeHigh && atrRatio > atrThreshold;
  const breakDown = latest.close < rangeLow && atrRatio > atrThreshold;
  if (breakUp || breakDown) {
    signals.push(makeSignal({
      type: "breakout",
      direction: breakUp ? "LONG" : "SHORT",
      entry: latest.close,
      range: breakoutRange,
      rangePosition,
      atrValue,
      atrRatio,
      volatilityRatio,
      stopMultiplier: stopMultiplierForVolatility(volatilityRatio, options),
      confidence: 72 + Math.min(18, Math.abs(rangePosition - (breakUp ? 1 : 0)) * 18),
      evidence: [
        breakUp ? "收盘突破5日高点" : "收盘跌破5日低点",
        `ATR 比率 ${round(atrRatio, 2)} > ${atrThreshold}`,
        "突破伴随波动率放大"
      ]
    }));
  }

  const context = {
    bb: boolOption(options.bollingerRegimeFilter, false)
      ? bollingerRegime(candles)
      : { regime: "normal", percentile: 50, width: 0 },
    previousDay: boolOption(options.previousDayLevelBoost, false)
      ? previousDayRange(candles, latest.t)
      : null,
    rsi: boolOption(options.rsiDivergenceBoost, false) ? rsi(candles, 14) : 50,
    londonDirection: boolOption(options.londonOpenDirectionFilter, false)
      ? londonOpenDirection(candles, latest.t)
      : "FLAT"
  };
  return applySignalEnhancements(signals, context, options).sort((a, b) => b.confidence - a.confidence);
}

export function technicalTypeLabels() {
  return TYPE_LABELS;
}
