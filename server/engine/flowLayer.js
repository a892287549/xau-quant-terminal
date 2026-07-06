function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function factorByKey(macroSnapshot, key) {
  return (macroSnapshot?.factors || []).find((item) => item.key === key);
}

function directionScore(direction, bullishScore) {
  if (direction === "LONG") return bullishScore;
  if (direction === "SHORT") return 100 - bullishScore;
  return 50;
}

export function validateFlow(signal, macroSnapshot = {}) {
  const cot = factorByKey(macroSnapshot, "cot") || { value: 50, change: 0 };
  const cotBullish = clamp(50 + (Number(cot.value || 50) - 50) * 1.4 + Number(cot.change || 0) * 4, 0, 100);
  const cotScore = directionScore(signal.direction, cotBullish);
  const etfScore = 50;
  const termStructureScore = 50;
  const score = Math.round(cotScore * 0.55 + etfScore * 0.25 + termStructureScore * 0.2);
  const bias = score >= 62 ? "顺风" : score <= 42 ? "逆风" : "中性";

  return {
    score,
    bias,
    confirmed: bias === "顺风",
    diverged: bias === "逆风",
    details: [
      `COT 净多分位 ${cot.value ?? 50}，变化 ${cot.change ?? 0}`,
      "ETF 持仓数据待接入，按中性处理",
      "期限结构数据待接入，按中性处理"
    ],
    components: {
      cot: Math.round(cotScore),
      etf: etfScore,
      termStructure: termStructureScore
    }
  };
}
