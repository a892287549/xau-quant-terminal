import { scoreMacroLayer, macroScoreToCompass } from "./macroLayer.js";
import { detectTechnicalSignals, technicalTypeLabels } from "./techLayer.js";
import { validateFlow } from "./flowLayer.js";
import { buildResonanceMatrix, rankSignals } from "./resonance.js";
import { detectStructuralBreakdown, STRUCTURAL_BREAKDOWN_TYPE, STRUCTURAL_BREAKDOWN_LABEL } from "./sentinel.js";

const TYPE_LABELS = {
  ...technicalTypeLabels(),
  [STRUCTURAL_BREAKDOWN_TYPE]: STRUCTURAL_BREAKDOWN_LABEL
};
const GRADE_ORDER = ["S", "A", "B", "C"];

function addHours(value, hours) {
  return new Date(new Date(value).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function minutesUntil(value) {
  return Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 60000));
}

function titleFor(signal) {
  const directionText = signal.direction === "LONG" ? "做多" : signal.direction === "SHORT" ? "做空" : "观望";
  const map = {
    range_revert: signal.direction === "LONG" ? "斐波回撤做多" : "斐波反弹做空",
    breakout: signal.direction === "LONG" ? "5日区间向上突破" : "5日区间向下突破",
    fakeout: signal.direction === "LONG" ? "斐波下破收回" : "斐波上破收回",
    momentum: "伦敦纽约同向动量",
    support_reversal: signal.direction === "LONG" ? "支撑反转突破" : "压力反转跌破",
    structural_breakdown: signal.direction === "LONG" ? "结构性崩溃底部衰竭" : "结构性崩溃顶部衰竭"
  };
  return `${map[signal.type] || TYPE_LABELS[signal.type]}${directionText}`;
}

function macroPayload(macroLayer) {
  return Object.fromEntries(macroLayer.components.map((item) => [item.key, item.score]));
}

function downgradeGrade(grade) {
  return { S: "A", A: "B", B: "C", C: "C" }[grade] || "C";
}

function scoreForGrade(grade, rawScore) {
  if (grade === "S") return Math.max(86, rawScore);
  if (grade === "A") return Math.max(74, Math.min(85, rawScore));
  if (grade === "B") return Math.max(62, Math.min(73, rawScore));
  return Math.max(40, Math.min(61, rawScore));
}

function applyGradeAdjustments(rankedSignals) {
  return rankedSignals.map((ranked) => {
    let grade = ranked.grade;
    let score = ranked.score;
    const adjustments = [...(ranked.signal.adjustments || [])];
    const technicalAdjustment = Number(ranked.signal.gradeAdjustment || 0);
    const downgradeCount = Math.abs(Math.min(0, technicalAdjustment));

    for (let index = 0; index < downgradeCount; index += 1) {
      grade = downgradeGrade(grade);
    }

    if (grade !== ranked.grade) {
      score = scoreForGrade(grade, score);
    }

    return {
      ...ranked,
      grade,
      score,
      signal: {
        ...ranked.signal,
        adjustments,
        effectiveGrade: grade
      }
    };
  }).sort((a, b) => {
    const gradeDiff = GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade);
    return gradeDiff || b.score - a.score;
  });
}

function buildSignalPayload(ranked, macroLayer, createdAt) {
  const signal = ranked.signal;
  const validUntil = addHours(createdAt, ["momentum", STRUCTURAL_BREAKDOWN_TYPE].includes(signal.type) ? 4 : 6);
  const timeKey = signal.type === STRUCTURAL_BREAKDOWN_TYPE
    ? new Date(createdAt).toISOString().slice(0, 10).replaceAll("-", "")
    : new Date(createdAt).toISOString().slice(0, 13).replaceAll(/[-:T]/g, "");
  return {
    id: `SIG-XAU-${timeKey}-${signal.type}-${signal.direction}`,
    createdAt,
    grade: ranked.grade,
    direction: signal.direction,
    type: signal.type,
    title: titleFor(signal),
    score: ranked.score,
    validUntil,
    expiresInMinutes: minutesUntil(validUntil),
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    atr: signal.atr,
    atrRatio: signal.atrRatio,
    volatilityRatio: signal.volatilityRatio,
    stopMultiplier: signal.stopMultiplier,
    support: signal.support,
    resistance: signal.resistance,
    breakoutLevel: signal.breakoutLevel,
    sentinelScore: signal.sentinelScore,
    exitMode: signal.exitMode,
    sentinel: signal.sentinel,
    adjustments: signal.adjustments || [],
    macro: macroPayload(macroLayer),
    technical: signal.evidence,
    flow: ranked.flow.details,
    matrix: ranked.matrix
  };
}

function observationSignal(macroLayer, matrix, createdAt) {
  const validUntil = addHours(createdAt, 4);
  return {
    id: `SIG-XAU-${new Date(createdAt).toISOString().slice(0, 13).replaceAll(/[-:T]/g, "")}-observe-FLAT`,
    createdAt,
    grade: "C",
    direction: "FLAT",
    type: "momentum",
    title: "等待技术触发",
    score: Math.max(45, Math.min(58, Math.round(50 + macroLayer.score))),
    validUntil,
    expiresInMinutes: minutesUntil(validUntil),
    entry: null,
    stop: null,
    target: null,
    macro: macroPayload(macroLayer),
    technical: ["未满足斐波回归/突破/斐波假突破/时段动量触发"],
    flow: ["无开仓方向，资金验证保持中性"],
    matrix
  };
}

function emptyMatrix(macroLayer) {
  return buildResonanceMatrix(macroLayer, [], new Map());
}

function filterEnabledSignalTypes(signals, settings = {}) {
  const enabled = settings?.strategy?.enabledSignalTypes;
  if (!enabled || typeof enabled !== "object") return signals;
  return signals.filter((signal) => enabled[signal.type] !== false);
}

export function runSignalEngine({ candles = [], macroSnapshot = {}, settings = {}, marketFlow = {} } = {}) {
  const macroLayer = scoreMacroLayer(macroSnapshot);
  const technicalSignals = filterEnabledSignalTypes(detectTechnicalSignals(candles, {
    atrThreshold: settings?.strategy?.atrThreshold || 1.12,
    rangeUpperThreshold: settings?.strategy?.rangeUpperThreshold ?? 0.85,
    rangeLowerThreshold: settings?.strategy?.rangeLowerThreshold ?? 0.15,
    requirePinBar: settings?.strategy?.requirePinBar ?? true,
    fakeoutVolumeFilter: settings?.strategy?.fakeoutVolumeFilter ?? false,
    dynamicATRStop: settings?.risk?.dynamicATRStop ?? false,
    fixedStopAtrMultiplier: settings?.risk?.fixedStopAtrMultiplier ?? 1.5,
    dynamicStopHigh: settings?.risk?.dynamicStopHigh ?? 2.0,
    dynamicStopMedium: settings?.risk?.dynamicStopMedium ?? 1.5,
    dynamicStopLow: settings?.risk?.dynamicStopLow ?? 1.2,
    dynamicStopHighThreshold: settings?.risk?.dynamicStopHighThreshold ?? 1.3,
    dynamicStopLowThreshold: settings?.risk?.dynamicStopLowThreshold ?? 0.8,
    bollingerRegimeFilter: settings?.strategy?.enhancements?.bollingerRegimeFilter ?? false,
    previousDayLevelBoost: settings?.strategy?.enhancements?.previousDayLevelBoost ?? false,
    rsiDivergenceBoost: settings?.strategy?.enhancements?.rsiDivergenceBoost ?? false,
    londonOpenDirectionFilter: settings?.strategy?.enhancements?.londonOpenDirectionFilter ?? false,
    supportReversalEnabled: settings?.strategy?.enabledSignalTypes?.support_reversal ?? false,
    supportReversalEntry: settings?.strategy?.supportReversal?.entry || "retest",
    supportReversalSlowFilter: settings?.strategy?.supportReversal?.slowFilter ?? true,
    supportReversalPivotBars: settings?.strategy?.supportReversal?.pivotBars || 3
  }), settings);
  const structuralSignal = detectStructuralBreakdown({
    candles,
    macroSnapshot,
    settings,
    marketFlow
  });
  const allSignals = structuralSignal
    ? filterEnabledSignalTypes([...technicalSignals, structuralSignal], settings)
    : technicalSignals;
  const flowValidations = allSignals.map((signal) => ({
    signal,
    flow: validateFlow(signal, macroSnapshot)
  }));
  const ranked = applyGradeAdjustments(rankSignals({
    macroLayer,
    technicalSignals: allSignals,
    flowValidations,
    options: {
      flowResonanceMode: settings?.strategy?.flowResonanceMode || "strict"
    }
  }));
  const createdAt = candles.at(-1)?.t || new Date().toISOString();
  const matrix = ranked[0]?.matrix || emptyMatrix(macroLayer);
  const signals = ranked.length
    ? ranked.map((item) => buildSignalPayload(item, macroLayer, createdAt))
    : [observationSignal(macroLayer, matrix, createdAt)];
  return {
    generatedAt: new Date().toISOString(),
    macroLayer,
    macroCompass: macroScoreToCompass(macroLayer),
    signals,
    matrix
  };
}

export function signalStats(signals = []) {
  const grades = ["S", "A", "B", "C"];
  const types = Object.entries(TYPE_LABELS);
  return {
    stats: grades.map((grade) => {
      const count = signals.filter((signal) => signal.grade === grade).length;
      return {
        label: `${grade} 级`,
        count,
        winRate: count ? Math.max(46, 72 - grades.indexOf(grade) * 8) : 0,
        avgReturn: count ? Number((1.2 - grades.indexOf(grade) * 0.28).toFixed(2)) : 0
      };
    }),
    typeStats: types.map(([type, label]) => {
      const count = signals.filter((signal) => signal.type === type).length;
      return {
        type: label,
        trades: count,
        winRate: count ? 58 : 0,
        pnl: count ? Number((count * 0.7).toFixed(2)) : 0
      };
    })
  };
}
