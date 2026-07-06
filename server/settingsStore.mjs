import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

export const defaultSettings = {
  api: {
    dataMode: "real",
    oandaAccountId: "",
    oandaTokenConfigured: false,
    okxTradingConfigured: false,
    dataProvider: "okx",
    realtimeProvider: "okx",
    backtestProvider: "oanda",
    broker: "okx",
    tradeMode: "paper"
  },
  paper: {
    initialBalanceUsdt: 10000
  },
  daemon: {
    enabled: true,
    scanIntervalMinutes: 5,
    autoExecute: false,
    useFixedOrderSize: false,
    orderSize: 0.01,
    minOrderSize: 0.01,
    pnlMultiplier: 100,
    eventWindows: [],
    eventCalendar: {
      enabled: true,
      refreshIntervalHours: 12,
      beforeMinutes: 30,
      afterMinutes: 30,
      sources: {
        fomc: true,
        nfp: true
      }
    }
  },
  notifications: {
    feishu: {
      enabled: false,
      webhookUrl: ""
    }
  },
  risk: {
    maxPositionPct: 12,
    perTradeRiskPct: 2,
    atrStopMultiplier: 1.5,
    dailyCircuitLossPct: 2.5,
    weeklyCircuitLossPct: 4,
    maxDailyStops: 2,
    fixedStopAtrMultiplier: 1.5,
    dynamicATRStop: true,
    dynamicStopHigh: 2.0,
    dynamicStopMedium: 1.5,
    dynamicStopLow: 1.2,
    dynamicStopHighThreshold: 1.3,
    dynamicStopLowThreshold: 0.8,
    trailingStopEnabled: true,
    trailingCheckMinutes: 15,
    trailingBreakEvenAtr: 1,
    trailingLockAtr: 2,
    trailingLockProfitAtr: 1,
    fakeoutTakeProfitAtr: 1.5,
    maxHoldH4BarsByType: {
      fakeout: 12,
      breakout: 24,
      range_revert: 18
    },
    supportReversalMaxHoldBars: 48,
    supportReversalFailureBars: 3,
    supportReversalFailureAtr: 0.2,
    supportReversalOneRTimeoutBars: 24,
    supportReversalTp1R: 2,
    structuralBreakdownPositionFactor: 0.5,
    adaptiveLeverage: false,
    signalRiskMultipliers: {
      S: 2.5,
      A: 1.5,
      B: 1.0
    },
    volatilityRiskMultipliers: {
      low: 1.3,
      medium: 1.0,
      high: 0.5
    },
    profitAmplifiers: {
      base: 1.0,
      tier1Pct: 5,
      tier1: 1.5,
      tier2Pct: 10,
      tier2: 2.0,
      tier3Pct: 20,
      tier3: 2.5
    },
    maxSingleTradeRiskPct: 8,
    maxEffectiveLeverage: 4,
    weeklyDrawdownReducePct: 10,
    weeklyDrawdownPausePct: 15,
    weeklyDrawdownReducedRiskPct: 1,
    eventCircuitBreaker: true,
    noTradeUtcHours: [0, 1, 2, 3, 4, 5, 6, 7],
    weeklyDrawdownAction: "half_position"
  },
  strategy: {
    minSignalLevel: "B",
    gradePositionMultipliers: {
      S: 1.5,
      A: 1,
      B: 0.5,
      C: 0.25
    },
    allowCSignals: false,
    flowResonanceMode: "relaxed",
    fakeoutVolumeFilter: true,
    weights: {
      macro: 0.42,
      technical: 0.38,
      flow: 0.2
    },
    enabledSignalTypes: {
      range_revert: false,
      breakout: true,
      fakeout: true,
      momentum: false,
      support_reversal: true,
      structural_breakdown: false
    },
    exitRules: {
      newExitRules: true,
      fakeoutPartialTP: true,
      fakeoutTp1R: 1.5,
      fakeoutTrailingMaPeriod: 10,
      legacyBreakoutExit: true,
      breakoutMacroDirectionFilter: false,
      structuralTakeProfitR: 0
    },
    structuralBreakdown: {
      useFundingData: false,
      thresholdA: 30,
      thresholdS: 40,
      allowedUtcStart: 8,
      allowedUtcEnd: 17,
      largeOrderBtcEquivalent: 1,
      largeOrderUsd: 100000
    },
    supportReversal: {
      entry: "retest",
      slowFilter: true,
      pivotBars: 3
    },
    enhancements: {
      bollingerRegimeFilter: true,
      previousDayLevelBoost: true,
      rsiDivergenceBoost: true,
      londonOpenDirectionFilter: true
    },
    thresholds: {
      S: 86,
      A: 74,
      B: 62,
      C: 50
    },
    defaultSession: {
      asia: false,
      london: true,
      newYork: true
    }
  },
  runtime: {
    version: "0.1.0",
    mode: "architecture-preview",
    tradingEnabled: false
  }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key]) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizeSettings(settings) {
  if (settings?.api) {
    const allowedApiKeys = new Set(Object.keys(defaultSettings.api));
    settings.api = Object.fromEntries(Object.entries(settings.api).filter(([key]) => allowedApiKeys.has(key)));
    if (settings.api.tradeMode === "demo") settings.api.tradeMode = "paper";
  }
  const lockedHours = settings?.risk?.noTradeUtcHours;
  if (Array.isArray(lockedHours)
    && lockedHours.length === 7
    && [0, 1, 2, 3, 4, 5, 6].every((hour) => lockedHours.includes(hour))) {
    settings.risk.noTradeUtcHours = [...lockedHours, 7];
  }
  if (settings?.risk?.supportReversalTp1R === 1.5) settings.risk.supportReversalTp1R = 2;
  return settings;
}

export class SettingsStore {
  constructor(dataDir, storage = null) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "settings.json");
    this.storage = storage;
  }

  async read() {
    if (this.storage?.enabled) {
      try {
        const saved = await this.storage.readConfig("settings");
        if (saved) return normalizeSettings(deepMerge(defaultSettings, saved));
      } catch (error) {
        logger.warn({ module: "settingsStore", error: error.message }, "settings db read failed, falling back to file");
      }
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const merged = normalizeSettings(deepMerge(defaultSettings, JSON.parse(raw)));
      if (this.storage?.enabled) {
        try {
          await this.storage.writeConfig("settings", merged);
        } catch (error) {
          logger.warn({ module: "settingsStore", error: error.message }, "settings db migration failed");
        }
      }
      return merged;
    } catch (error) {
      if (error.code === "ENOENT") return normalizeSettings(deepMerge(defaultSettings, {}));
      throw error;
    }
  }

  async write(nextSettings) {
    await mkdir(this.dataDir, { recursive: true });
    const merged = normalizeSettings(deepMerge(defaultSettings, nextSettings));
    if (this.storage?.enabled) {
      try {
        await this.storage.writeConfig("settings", merged);
      } catch (error) {
        logger.warn({ module: "settingsStore", error: error.message }, "settings db write failed, keeping file fallback");
      }
    }
    await writeFile(this.filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return merged;
  }
}
