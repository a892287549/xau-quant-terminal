import crypto from "node:crypto";

const DEFAULT_API_BASE = "https://www.okx.com";
const DEFAULT_DEMO_API_BASE = "https://demo.okx.com";
const DEFAULT_INST_ID = "XAU-USDT-SWAP";
const BAR_BY_TIMEFRAME = {
  M5: "5m",
  H1: "1H",
  H4: "4H",
  D: "1D"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

class OkxHttpError extends Error {
  constructor(message, { status, retryable = false, retryAfterMs = 0, payload = null } = {}) {
    super(message);
    this.name = "OkxHttpError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.payload = payload;
  }
}

class RateLimiter {
  constructor(limitPerSecond = 10) {
    this.minIntervalMs = Math.ceil(1000 / limitPerSecond);
    this.nextAt = 0;
    this.queue = Promise.resolve();
  }

  schedule(task) {
    const run = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextAt - Date.now());
      if (waitMs) await sleep(waitMs);
      this.nextAt = Date.now() + this.minIntervalMs;
      return task();
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function normalizeCandle(row) {
  const [timestamp, open, high, low, close, volume] = row;
  return {
    t: new Date(Number(timestamp)).toISOString(),
    open: round(open),
    high: round(high),
    low: round(low),
    close: round(close),
    volume: toNumber(volume) || 0
  };
}

function normalizeTrade(row) {
  return {
    tradeId: row.tradeId,
    t: row.ts ? new Date(Number(row.ts)).toISOString() : new Date().toISOString(),
    side: row.side,
    price: toNumber(row.px),
    size: toNumber(row.sz),
    notional: (toNumber(row.px) || 0) * (toNumber(row.sz) || 0)
  };
}

function normalizePosition(row) {
  const signedSize = toNumber(row.pos) || 0;
  const size = Math.abs(signedSize);
  const posSide = String(row.posSide || "").toLowerCase();
  const direction = posSide.includes("short") || signedSize < 0 ? "SHORT" : "LONG";
  const entry = toNumber(row.avgPx);
  const price = toNumber(row.markPx) || toNumber(row.last) || entry;
  const pnl = toNumber(row.upl) || 0;
  const ratio = toNumber(row.uplRatio);
  const sign = direction === "SHORT" ? -1 : 1;
  const fallbackPct = entry && price ? ((price - entry) / entry) * 100 * sign : 0;
  return {
    id: row.posId || `${row.instId || "OKX"}-${row.posSide || direction}`,
    symbol: row.instId,
    direction,
    size,
    entry,
    price,
    pnl: round(pnl, 2),
    pnlPct: round(ratio !== null ? ratio * 100 : fallbackPct, 2),
    leverage: toNumber(row.lever),
    marginMode: row.mgnMode || "",
    updatedAt: row.uTime ? new Date(Number(row.uTime)).toISOString() : new Date().toISOString(),
    openedAt: row.cTime ? new Date(Number(row.cTime)).toISOString() : "",
    source: "okx",
    raw: row
  };
}

export class OkxAdapter {
  constructor(options = {}) {
    this.apiBase = (options.apiBase || process.env.OKX_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
    this.liveApiBase = (options.liveApiBase || process.env.OKX_LIVE_API_BASE || process.env.OKX_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
    this.demoApiBase = (options.demoApiBase || process.env.OKX_DEMO_API_BASE || DEFAULT_DEMO_API_BASE).replace(/\/$/, "");
    this.instrument = options.instrument || process.env.OKX_INST_ID || DEFAULT_INST_ID;
    this.apiKey = options.apiKey || process.env.OKX_API_KEY || "";
    this.apiSecret = options.apiSecret || process.env.OKX_API_SECRET || "";
    this.passphrase = options.passphrase || process.env.OKX_API_PASSPHRASE || "";
    this.simulated = String(options.simulated ?? process.env.OKX_SIMULATED ?? "1") === "1";
    this.timeoutMs = Number(options.timeoutMs || process.env.OKX_TIMEOUT_MS || 8000);
    this.maxRetries = Number(options.maxRetries || process.env.OKX_MAX_RETRIES || 2);
    this.rateLimiter = new RateLimiter(Number(options.limitPerSecond || process.env.OKX_RATE_LIMIT_PER_SECOND || 10));
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiSecret && this.passphrase);
  }

  isTradingEnabled() {
    return this.isConfigured() && process.env.TRADING_ENABLED === "true";
  }

  sign(timestamp, method, requestPath, bodyText = "") {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(`${timestamp}${method.toUpperCase()}${requestPath}${bodyText}`)
      .digest("base64");
  }

  async request(pathname, { method = "GET", params = {}, body = null, auth = false, apiBase = this.apiBase } = {}) {
    const url = new URL(`${apiBase}${pathname}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });
    const requestPath = `${url.pathname}${url.search}`;
    const bodyText = body ? JSON.stringify(body) : "";

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.rateLimiter.schedule(() => this.fetchJson(url, {
          method,
          requestPath,
          bodyText,
          auth
        }));
      } catch (error) {
        const canRetry = error.retryable && attempt < this.maxRetries;
        if (!canRetry) throw error;
        const backoffMs = error.retryAfterMs || 250 * 2 ** attempt;
        await sleep(backoffMs);
      }
    }
    throw new OkxHttpError("OKX request failed after retries", { status: 0 });
  }

  async fetchJson(url, { method, requestPath, bodyText, auth }) {
    if (auth && !this.isConfigured()) {
      throw new OkxHttpError("OKX credentials are not configured", { status: 0 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      Accept: "application/json"
    };
    if (bodyText) headers["Content-Type"] = "application/json";
    if (auth) {
      const timestamp = new Date().toISOString();
      headers["OK-ACCESS-KEY"] = this.apiKey;
      headers["OK-ACCESS-SIGN"] = this.sign(timestamp, method, requestPath, bodyText);
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      headers["OK-ACCESS-PASSPHRASE"] = this.passphrase;
      if (this.simulated) headers["x-simulated-trading"] = "1";
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyText || undefined,
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
      if (!response.ok) {
        throw new OkxHttpError(payload.msg || `OKX HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs,
          payload
        });
      }
      if (payload.code && payload.code !== "0") {
        throw new OkxHttpError(payload.msg || `OKX code ${payload.code}`, {
          status: response.status,
          retryable: payload.code === "50011",
          retryAfterMs,
          payload
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof OkxHttpError) throw error;
      throw new OkxHttpError(error.message || "OKX network error", {
        status: 0,
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getTicker(instrument = this.instrument) {
    const payload = await this.request("/api/v5/market/ticker", {
      params: { instId: instrument }
    });
    const ticker = payload.data?.[0];
    if (!ticker) throw new OkxHttpError(`No OKX ticker returned for ${instrument}`, { status: 0, payload });

    const bid = toNumber(ticker.bidPx);
    const ask = toNumber(ticker.askPx);
    const last = toNumber(ticker.last);
    const mid = bid !== null && ask !== null ? round((bid + ask) / 2) : last;
    return {
      instrument: ticker.instId || instrument,
      time: ticker.ts ? new Date(Number(ticker.ts)).toISOString() : new Date().toISOString(),
      bid,
      ask,
      mid,
      last,
      spread: bid !== null && ask !== null ? round(ask - bid) : null,
      tradeable: true
    };
  }

  async getPricing(instrument = this.instrument) {
    return this.getTicker(instrument);
  }

  async getCandles({ timeframe = "H1", count, instrument = this.instrument } = {}) {
    const bar = BAR_BY_TIMEFRAME[timeframe] || timeframe;
    const defaultCount = bar === "1D" ? 80 : bar === "5m" ? 288 : 96;
    const payload = await this.request("/api/v5/market/candles", {
      params: {
        instId: instrument,
        bar,
        limit: count || defaultCount
      }
    });
    return (payload.data || [])
      .map(normalizeCandle)
      .filter((candle) => Number.isFinite(candle.close))
      .sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  async getTrades({ limit = 500, instrument = this.instrument } = {}) {
    const payload = await this.request("/api/v5/market/trades", {
      params: {
        instId: instrument,
        limit: Math.min(500, Math.max(1, Number(limit) || 500))
      }
    });
    return (payload.data || [])
      .map(normalizeTrade)
      .filter((trade) => Number.isFinite(trade.price) && Number.isFinite(trade.size))
      .sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  async getPositions({ instrument = this.instrument } = {}) {
    const apiBases = this.simulated
      ? Array.from(new Set([this.demoApiBase, this.apiBase, this.liveApiBase].filter(Boolean)))
      : [this.liveApiBase];
    let payload = null;
    let lastError = null;
    for (const apiBase of apiBases) {
      try {
        payload = await this.request("/api/v5/account/positions", {
          params: { instId: instrument },
          auth: true,
          apiBase
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payload && lastError) throw lastError;
    return (payload.data || [])
      .map(normalizePosition)
      .filter((position) => position.size > 0);
  }

  async placeOrder({ instrument = this.instrument, side, size, orderType = "market", price, clientOrderId, tradeMode = "cross" } = {}) {
    if (!this.isTradingEnabled()) {
      throw new OkxHttpError("OKX trading is disabled or credentials are missing", { status: 0 });
    }
    if (!["buy", "sell"].includes(side)) {
      throw new OkxHttpError("OKX order side must be buy or sell", { status: 0 });
    }
    const body = {
      instId: instrument,
      tdMode: tradeMode,
      side,
      ordType: orderType,
      sz: String(size)
    };
    if (price !== undefined && price !== null && price !== "") body.px = String(price);
    if (clientOrderId) body.clOrdId = clientOrderId;
    const payload = await this.request("/api/v5/trade/order", {
      method: "POST",
      body,
      auth: true
    });
    return payload.data?.[0] || payload;
  }
}

export function timeframeToOkxBar(timeframe) {
  return BAR_BY_TIMEFRAME[timeframe] || timeframe;
}
