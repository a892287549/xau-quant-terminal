const COLS = ["range_revert", "breakout", "fakeout", "support_reversal", "momentum", "structural_breakdown"];
const COL_LABELS = {
  range_revert: "斐波回归",
  breakout: "突破",
  fakeout: "斐波假突破",
  support_reversal: "支撑反转",
  momentum: "时段动量",
  structural_breakdown: "结构崩溃"
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function gradeFromScore(score) {
  if (score >= 86) return "S";
  if (score >= 74) return "A";
  if (score >= 62) return "B";
  return "C";
}

function downgradeGrade(grade) {
  return { S: "A", A: "B", B: "C", C: "C" }[grade] || "C";
}

function upgradeGrade(grade) {
  return { S: "S", A: "S", B: "A", C: "B" }[grade] || "C";
}

function scoreForGrade(grade, rawScore) {
  if (grade === "S") return Math.max(86, rawScore);
  if (grade === "A") return clamp(rawScore, 74, 85);
  if (grade === "B") return clamp(rawScore, 62, 73);
  return clamp(rawScore, 40, 61);
}

function isFlowConfirmed(flow) {
  return flow?.confirmed === true || flow?.bias === "顺风" || Number(flow?.score || 0) >= 62;
}

function applyFlowResonance(grade, flow, mode = "strict") {
  const confirmed = isFlowConfirmed(flow);
  if (mode === "relaxed") return confirmed ? upgradeGrade(grade) : grade;
  return confirmed ? grade : downgradeGrade(grade);
}

function macroAligned(macroLayer, signal) {
  if (macroLayer.bias === "利多" && signal.direction === "LONG") return true;
  if (macroLayer.bias === "利空" && signal.direction === "SHORT") return true;
  return false;
}

function specialRuleGrade(macroLayer, signal) {
  if (macroLayer.bias === "利多" && signal.type === "range_revert" && signal.direction === "LONG" && signal.rangePosition < 0.4) {
    return "S";
  }
  if (macroLayer.bias === "利空" && signal.type === "breakout" && signal.direction === "SHORT") {
    return "S";
  }
  if (signal.type === "support_reversal") {
    if (macroAligned(macroLayer, signal)) return "S";
    if (macroLayer.bias === "中性") return "A";
    return "B";
  }
  return null;
}

function typeValue(type, signals, macroLayer, flowMap) {
  const signal = signals.find((item) => item.type === type);
  if (!signal) return 18;
  const flow = flowMap.get(signal);
  if (signal.type === "structural_breakdown") {
    return clamp(Math.round(Number(signal.scoreOverride || signal.confidence || 78)), 18, 96);
  }
  const macroBoost = macroAligned(macroLayer, signal) ? 18 : macroLayer.bias === "中性" ? 0 : -14;
  return clamp(Math.round(signal.confidence * 0.55 + (flow?.score || 50) * 0.25 + 50 * 0.2 + macroBoost), 18, 96);
}

export function buildResonanceMatrix(macroLayer, signals, flowMap) {
  return [
    {
      row: "宏观顺风",
      cells: COLS.map((col) => ({
        col: COL_LABELS[col],
        value: clamp(Math.round(50 + macroLayer.score * 5 + (signals.some((signal) => signal.type === col && macroAligned(macroLayer, signal)) ? 18 : 0)), 18, 96)
      }))
    },
    {
      row: "技术触发",
      cells: COLS.map((col) => ({
        col: COL_LABELS[col],
        value: signals.find((signal) => signal.type === col)?.confidence || 18
      }))
    },
    {
      row: "资金确认",
      cells: COLS.map((col) => ({
        col: COL_LABELS[col],
        value: typeValue(col, signals, macroLayer, flowMap)
      }))
    }
  ];
}

export function rankSignals({ macroLayer, technicalSignals, flowValidations, options = {} }) {
  const flowMap = new Map(flowValidations.map((item) => [item.signal, item.flow]));
  const matrix = buildResonanceMatrix(macroLayer, technicalSignals, flowMap);
  const flowResonanceMode = options.flowResonanceMode === "relaxed" ? "relaxed" : "strict";
  return technicalSignals.map((signal) => {
    const flow = flowMap.get(signal) || { score: 50, details: [] };
    const alignment = macroAligned(macroLayer, signal) ? 14 : macroLayer.bias === "中性" ? 0 : -18;
    const rawScore = signal.scoreOverride
      ? clamp(Math.round(signal.scoreOverride), 40, 96)
      : clamp(Math.round(signal.confidence * 0.5 + flow.score * 0.25 + (50 + macroLayer.score * 5) * 0.25 + alignment), 40, 96);
    const forcedGrade = specialRuleGrade(macroLayer, signal);
    let grade = signal.gradeOverride || forcedGrade || gradeFromScore(rawScore);
    if (signal.type !== "structural_breakdown" && macroLayer.bias === "中性") grade = downgradeGrade(grade);
    if (signal.type !== "structural_breakdown") {
      grade = applyFlowResonance(grade, flow, flowResonanceMode);
    }
    return {
      signal,
      flow,
      grade,
      score: scoreForGrade(grade, rawScore),
      matrix
    };
  }).sort((a, b) => b.score - a.score);
}
