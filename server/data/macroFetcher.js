import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { macroCompass as mockMacroCompass } from "../mockData.mjs";
import { logger } from "../logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREASURY_REAL_YIELD_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView";
const CME_FEDWATCH_URL = "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html";
const CFTC_GOLD_COT_URL = "https://www.cftc.gov/dea/futures/deacmxsf.htm";
const FETCH_TIMEOUT_MS = 15000;

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseNumber(value) {
  if (value === null || value === undefined || value === ".") return null;
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreFromRange(value, min, max, invert = false) {
  const raw = clamp((value - min) / (max - min), 0, 1);
  const normalized = invert ? 1 - raw : raw;
  return Math.round(normalized * 100);
}

function biasFromScore(score) {
  if (score >= 66) return "利多";
  if (score <= 44) return "利空";
  return "中性";
}

function scoreThreeFactorMacro({ tips, fedwatch, commercialNet, nonCommercialNet }) {
  let score = 0;
  score += clamp(-Number(tips || 0) * 3.0, -6, 6);
  score += clamp((Number(fedwatch || 50) - 50) * 0.10, -5, 5);
  const cotSignal = (Number(commercialNet || 0) > 0 ? 1 : -1)
    + (Number(nonCommercialNet || 0) < 0 ? 1 : -1);
  score += cotSignal * 2.0;
  score = clamp(score, -10, 10);
  return {
    rawScore: Math.round(score * 100) / 100,
    score: clamp(Math.round(50 + score * 5), 0, 100),
    bias: score >= 4 ? "利多" : score <= -4 ? "利空" : "中性"
  };
}

function factor({
  key,
  label,
  value,
  unit,
  change,
  score,
  history,
  commercialNet,
  nonCommercialNet,
  nonCommercialLong,
  nonCommercialShort,
  totalOpenInterest,
  longCrowding,
  shortCrowding
}) {
  return {
    key,
    label,
    value: round(value, key === "cot" ? 0 : 2),
    unit,
    change: round(change || 0, 2),
    bias: biasFromScore(score),
    score,
    ...(commercialNet !== undefined ? { commercialNet } : {}),
    ...(nonCommercialNet !== undefined ? { nonCommercialNet } : {}),
    ...(nonCommercialLong !== undefined ? { nonCommercialLong } : {}),
    ...(nonCommercialShort !== undefined ? { nonCommercialShort } : {}),
    ...(totalOpenInterest !== undefined ? { totalOpenInterest } : {}),
    ...(longCrowding !== undefined ? { longCrowding } : {}),
    ...(shortCrowding !== undefined ? { shortCrowding } : {}),
    history: history?.length ? history : undefined
  };
}

function withFallbackHistory(factors) {
  const fallback = new Map(mockMacroCompass().factors.map((item) => [item.key, item]));
  return factors.map((item) => ({
    ...item,
    history: item.history || fallback.get(item.key)?.history || []
  }));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; xau-quant-terminal/0.1; +https://advance688.xyz)"
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

export class MacroFetcher {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.DATA_DIR || path.resolve("data");
    this.cachePath = path.join(this.dataDir, "macro-cache.json");
    this.storage = options.storage || null;
    this.lastFetchStarted = null;
  }

  async getSnapshot({ force = false } = {}) {
    const cached = await this.readCache();
    const isFresh = cached?.updatedAt && Date.now() - new Date(cached.updatedAt).getTime() < DAY_MS;
    if (!force && isFresh) {
      await this.storage?.persistMacroSnapshot?.(cached);
      return cached;
    }

    try {
      const snapshot = await this.fetchSnapshot(cached);
      await this.writeCache(snapshot);
      await this.storage?.persistMacroSnapshot?.(snapshot);
      return snapshot;
    } catch (error) {
      if (cached) return { ...cached, stale: true, error: error.message };
      return this.fallbackSnapshot(error);
    }
  }

  async fetchSnapshot(previous = null) {
    this.lastFetchStarted = new Date().toISOString();
    const [tips, fedwatch, cot] = await Promise.allSettled([
      this.fetchTreasuryRealYield(),
      this.fetchFedWatchProbability(),
      this.fetchGoldCot()
    ]);

    const previousByKey = new Map((previous?.factors || []).map((item) => [item.key, item]));
    const fallbackByKey = new Map(mockMacroCompass().factors.map((item) => [item.key, item]));
    const getValue = (result, key) => {
      if (result.status === "fulfilled" && result.value) return result.value;
      return previousByKey.get(key) || fallbackByKey.get(key);
    };

    const tipsData = getValue(tips, "tips");
    const fedwatchData = getValue(fedwatch, "fedwatch");
    const cotData = getValue(cot, "cot");

    const factors = withFallbackHistory([
      factor({
        key: "tips",
        label: "TIPS 实际利率",
        value: tipsData.value,
        unit: "%",
        change: tipsData.change,
        score: scoreFromRange(tipsData.value, 0.5, 3.2, true),
        history: tipsData.history
      }),
      factor({
        key: "fedwatch",
        label: "FedWatch 降息概率",
        value: fedwatchData.value,
        unit: "%",
        change: fedwatchData.change,
        score: scoreFromRange(fedwatchData.value, 20, 80),
        history: fedwatchData.history
      }),
      factor({
        key: "cot",
        label: "COT 持仓方向",
        value: cotData.value,
        unit: "净多分位",
        change: cotData.change,
        score: scoreFromRange(cotData.value, 35, 85),
        commercialNet: cotData.commercialNet,
        nonCommercialNet: cotData.nonCommercialNet,
        nonCommercialLong: cotData.nonCommercialLong,
        nonCommercialShort: cotData.nonCommercialShort,
        totalOpenInterest: cotData.totalOpenInterest,
        longCrowding: cotData.longCrowding,
        shortCrowding: cotData.shortCrowding,
        history: cotData.history
      })
    ]);
    const macroScore = scoreThreeFactorMacro({
      tips: tipsData.value,
      fedwatch: fedwatchData.value,
      commercialNet: cotData.commercialNet,
      nonCommercialNet: cotData.nonCommercialNet
    });
    return {
      updatedAt: new Date().toISOString(),
      score: macroScore.score,
      rawScore: macroScore.rawScore,
      bias: macroScore.bias,
      factors,
      sources: {
        treasuryRealYield: tips.status === "fulfilled",
        cmeFedWatch: fedwatch.status === "fulfilled",
        cftcCot: cot.status === "fulfilled"
      }
    };
  }

  async fetchTreasuryRealYield() {
    const year = process.env.TREASURY_REAL_YIELD_YEAR || String(new Date().getUTCFullYear());
    const url = new URL(TREASURY_REAL_YIELD_URL);
    url.searchParams.set("type", "daily_treasury_real_yield_curve");
    url.searchParams.set("field_tdr_date_value", year);
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const table = $("table").first();
    const headers = table.find("thead th, tr:first-child th, tr:first-child td")
      .map((_, item) => $(item).text().trim().replace(/\s+/g, " "))
      .get();
    const dateIndex = headers.findIndex((item) => /^date$/i.test(item));
    const tenYearIndex = headers.findIndex((item) => /^(10\s*(YR|YEAR)|10-Year)$/i.test(item));
    if (dateIndex < 0 || tenYearIndex < 0) throw new Error("Treasury real yield table headers were not parsed");
    const observations = table.find("tbody tr, tr").slice(1)
      .map((_, row) => {
        const cells = $(row).find("th,td").map((__, cell) => $(cell).text().trim()).get();
        const [month, day, rowYear] = String(cells[dateIndex] || "").split("/");
        const value = parseNumber(cells[tenYearIndex]);
        if (!month || !day || !rowYear || value === null) return null;
        return {
          t: `${rowYear.padStart(4, "20")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
          v: value
        };
      })
      .get()
      .filter(Boolean);
    const latest = observations.at(-1);
    const previous = observations.at(-2);
    if (!latest) throw new Error("Treasury returned no numeric 10-year real yield");
    return {
      value: latest.v,
      change: previous ? latest.v - previous.v : 0,
      history: observations.slice(-60)
    };
  }

  async fetchFedWatchProbability() {
    const html = await fetchText(CME_FEDWATCH_URL);
    const $ = cheerio.load(html);
    const text = $("body").text().replace(/\s+/g, " ");
    const match = text.match(/(?:cut|easing|probabilit)[^%]{0,160}?(\d{1,2}(?:\.\d+)?)%/i)
      || text.match(/(\d{1,2}(?:\.\d+)?)%\s+(?:probability|chance)/i);
    const value = match ? parseNumber(match[1]) : null;
    if (value === null) throw new Error("CME FedWatch probability was not found in page text");
    return { value, change: 0 };
  }

  async fetchGoldCot() {
    const html = await fetchText(CFTC_GOLD_COT_URL);
    const $ = cheerio.load(html);
    const text = $("body").text();
    const start = text.search(/GOLD\s+-\s+COMMODITY EXCHANGE INC\./i);
    if (start < 0) throw new Error("CFTC gold section was not found");
    const section = text.slice(start, start + 2200);
    const commitmentMatch = section.match(/COMMITMENTS\s*\n\s*([-\d,\s]+)/i);
    const changeMatch = section.match(/CHANGES FROM[^\n]*\n\s*([-\d,\s]+)/i);
    const commitmentNumbers = commitmentMatch?.[1]?.match(/-?\d[\d,]*/g)?.map(parseNumber) || [];
    const changeNumbers = changeMatch?.[1]?.match(/-?\d[\d,]*/g)?.map(parseNumber) || [];
    const [nonCommercialLong, nonCommercialShort, , commercialLong, commercialShort] = commitmentNumbers;
    const [longChange = 0, shortChange = 0] = changeNumbers;
    if (!nonCommercialLong || !nonCommercialShort) throw new Error("CFTC gold commitments were not parsed");
    const openInterestMatch = section.match(/OPEN\s+INTEREST[^\d-]*(-?\d[\d,]*)/i);
    const totalOpenInterest = parseNumber(openInterestMatch?.[1]) || (nonCommercialLong + nonCommercialShort + Number(commercialLong || 0) + Number(commercialShort || 0));
    const netLongRatio = nonCommercialLong / (nonCommercialLong + nonCommercialShort);
    const previousRatio = (nonCommercialLong - longChange) / ((nonCommercialLong - longChange) + (nonCommercialShort - shortChange));
    const nonCommercialNet = Number(nonCommercialLong || 0) - Number(nonCommercialShort || 0);
    return {
      value: round(netLongRatio * 100, 0),
      change: round((netLongRatio - previousRatio) * 100, 2),
      commercialNet: Number(commercialLong || 0) - Number(commercialShort || 0),
      nonCommercialNet,
      nonCommercialLong,
      nonCommercialShort,
      totalOpenInterest,
      longCrowding: totalOpenInterest ? Math.max(0, nonCommercialNet) / totalOpenInterest : null,
      shortCrowding: totalOpenInterest ? Math.max(0, -nonCommercialNet) / totalOpenInterest : null
    };
  }

  async readCache() {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeCache(snapshot) {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  fallbackSnapshot(error) {
    const fallback = mockMacroCompass();
    return {
      ...fallback,
      updatedAt: new Date().toISOString(),
      stale: true,
      error: error?.message || "macro fetch failed",
      sources: {
        treasuryRealYield: false,
        cmeFedWatch: false,
        cftcCot: false
      }
    };
  }
}

export function startMacroScheduler(fetcher, { enabled = async () => true } = {}) {
  let lastRunDate = "";
  const tick = async () => {
    try {
      if (!(await enabled())) return;
      const now = new Date();
      const runDate = now.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
      const hour = Number(new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: "Asia/Shanghai"
      }).format(now));
      if (hour === 9 && runDate !== lastRunDate) {
        lastRunDate = runDate;
        await fetcher.getSnapshot({ force: true });
      }
    } catch (error) {
      logger.warn({ module: "macroFetcher", error: error.message }, "macro scheduler skipped");
    }
  };
  const timer = setInterval(tick, 60 * 60 * 1000);
  tick();
  return () => clearInterval(timer);
}
