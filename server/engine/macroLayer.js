function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function byKey(macroSnapshot) {
  return new Map((macroSnapshot?.factors || []).map((item) => [item.key, item]));
}

function component(label, key, value, score, reason) {
  return {
    label,
    key,
    value,
    score: round(score),
    reason
  };
}

function englishBiasToCn(bias) {
  return {
    bullish: "利多",
    bearish: "利空",
    neutral: "中性"
  }[bias] || "中性";
}

function macroFields(macroSnapshot = {}) {
  const factors = byKey(macroSnapshot);
  const tips = factors.get("tips") || {};
  const fedwatch = factors.get("fedwatch") || {};
  const cot = factors.get("cot") || {};
  return {
    tips_10y: Number(macroSnapshot.tips_10y ?? tips.value ?? 1.8),
    fed_prob_cut: Number(macroSnapshot.fed_prob_cut ?? fedwatch.value ?? 50),
    cot_commercial_net: Number(macroSnapshot.cot_commercial_net ?? cot.commercialNet ?? 0),
    cot_noncommercial_net: Number(macroSnapshot.cot_noncommercial_net ?? cot.nonCommercialNet ?? 0)
  };
}

export function computeMacroScore(macro) {
  let score = 0;

  score += clamp(-Number(macro.tips_10y || 0) * 3.0, -6, 6);
  score += clamp((Number(macro.fed_prob_cut || 50) - 50) * 0.10, -5, 5);

  const cotSignal = (Number(macro.cot_commercial_net || 0) > 0 ? 1 : -1)
    + (Number(macro.cot_noncommercial_net || 0) < 0 ? 1 : -1);
  score += cotSignal * 2.0;

  score = clamp(score, -10, 10);
  const bias = score >= 4 ? "bullish" : score <= -4 ? "bearish" : "neutral";
  return { score: Math.round(score * 100) / 100, bias };
}

export function scoreMacroLayer(macroSnapshot = {}) {
  const factors = byKey(macroSnapshot);
  const fields = macroFields(macroSnapshot);
  const tips = fields.tips_10y;
  const fedwatch = fields.fed_prob_cut;
  const cot = factors.get("cot") || {};
  const raw = computeMacroScore(fields);
  const tipsScore = clamp(-tips * 3.0, -6, 6);
  const fedwatchScore = clamp((fedwatch - 50) * 0.10, -5, 5);
  const cotSignal = (fields.cot_commercial_net > 0 ? 1 : -1)
    + (fields.cot_noncommercial_net < 0 ? 1 : -1);
  const cotScore = cotSignal * 2.0;
  const score = raw.score;
  const bias = englishBiasToCn(raw.bias);

  return {
    score,
    bias,
    rawBias: raw.bias,
    components: [
      component("TIPS 实际利率", "tips", tips, tipsScore, "TIPS 上升压制无息资产黄金"),
      component("FedWatch 降息概率", "fedwatch", fedwatch, fedwatchScore, "降息概率上升利多黄金"),
      component("COT 持仓结构", "cot", cot.value ?? 0, cotScore, "商业/非商业净持仓方向作为资金验证")
    ],
    factors: Object.fromEntries((macroSnapshot?.factors || []).map((item) => [item.key, item.score ?? item.value]))
  };
}

export function macroScoreToCompass(layer) {
  const normalized = Math.round(50 + layer.score * 5);
  return {
    score: clamp(normalized, 0, 100),
    bias: layer.bias,
    components: layer.components
  };
}
