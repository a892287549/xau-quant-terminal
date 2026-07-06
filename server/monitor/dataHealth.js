import { logger } from "../logger.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ageHours(value) {
  if (!value) return Infinity;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return Infinity;
  return (Date.now() - time) / HOUR_MS;
}

function issue(label, age, limit, latest) {
  return {
    label,
    ageHours: Number(age.toFixed(2)),
    limitHours: limit,
    latest
  };
}

export class DataHealthMonitor {
  constructor({ storage, notifier = null, getSettings, okxAdapter = null, intervalMinutes = 30 } = {}) {
    this.storage = storage;
    this.notifier = notifier;
    this.getSettings = getSettings;
    this.okx = okxAdapter;
    this.intervalMs = Math.max(1, Number(intervalMinutes || 30)) * 60 * 1000;
    this.timer = null;
    this.lastCheck = null;
    this.lastIssues = [];
    this.lastSnapshot = null;
    this.alertedKeys = new Set();
  }

  status() {
    return {
      running: Boolean(this.timer),
      lastCheck: this.lastCheck,
      issues: this.lastIssues,
      snapshot: this.lastSnapshot
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkOnce().catch((error) => {
      logger.warn({ module: "dataHealth", error: error.message }, "data health check failed");
    }), this.intervalMs);
    setTimeout(() => this.checkOnce().catch((error) => {
      logger.warn({ module: "dataHealth", error: error.message }, "data health check failed");
    }), 6000);
    logger.info({ module: "dataHealth", intervalMinutes: this.intervalMs / 60000 }, "data health monitor started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkOnce() {
    const settings = await this.getSettings?.();
    const okxInstrument = this.okx?.instrument;
    const oandaInstrument = process.env.OANDA_INSTRUMENT || "XAU_USD";
    const snapshot = await this.storage?.getDataHealthSnapshot?.({
      instruments: [okxInstrument, oandaInstrument]
    });
    const issues = [];
    const okxLatest = snapshot?.candlesH1ByInstrument?.[okxInstrument] || null;
    const oandaLatest = snapshot?.candlesH1ByInstrument?.[oandaInstrument] || null;
    const candleLatest = okxLatest || snapshot?.candlesH1Latest;
    const candleAge = ageHours(candleLatest);
    const oandaAge = ageHours(oandaLatest);
    const tipsAge = ageHours(snapshot?.macroLatest?.tips);
    const cotAge = ageHours(snapshot?.macroLatest?.cot);
    if (settings?.api?.dataProvider === "okx" && candleAge > 2) issues.push(issue(`OKX ${okxInstrument} H1`, candleAge, 2, candleLatest));
    if (settings?.api?.backtestProvider === "oanda" && oandaAge > 96) issues.push(issue(`OANDA ${oandaInstrument} H1`, oandaAge, 96, oandaLatest));
    if (tipsAge > 24) issues.push(issue("TIPS", tipsAge, 24, snapshot?.macroLatest?.tips));
    if (cotAge > 8 * 24) issues.push(issue("COT", cotAge, 8 * 24, snapshot?.macroLatest?.cot));
    this.lastCheck = new Date().toISOString();
    this.lastIssues = issues;
    this.lastSnapshot = snapshot;
    if (issues.length) await this.alert(settings, issues);
    return this.status();
  }

  async alert(settings, issues) {
    const key = `${new Date().toISOString().slice(0, 13)}:${issues.map((item) => item.label).join(",")}`;
    if (this.alertedKeys.has(key)) return;
    this.alertedKeys.add(key);
    try {
      await this.notifier?.send?.(
        settings,
        `⚠️ **数据质量告警**\n\n${issues.map((item) => `- ${item.label}: 最新 ${item.latest || "无"}，延迟 ${item.ageHours}h，阈值 ${item.limitHours}h`).join("\n")}`,
        "XAU 数据质量"
      );
    } catch (error) {
      logger.warn({ module: "dataHealth", error: error.message }, "data health notify failed");
    }
  }

  async checkBeforeTrade(settings) {
    const rate = this.okx?.lastRateLimit;
    if (!rate || !Number.isFinite(rate.remainingPct)) return { ok: true, skipped: true };
    if (rate.remainingPct >= 20) return { ok: true, rate };
    const issueItem = {
      label: "OKX API rate limit",
      ageHours: 0,
      limitHours: 0,
      latest: `${rate.remainingPct}% remaining`
    };
    await this.alert(settings, [issueItem]);
    return { ok: false, rate };
  }
}
