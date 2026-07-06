const DEFAULT_API_BASE = "https://api-fxtrade.oanda.com";
const DEFAULT_INSTRUMENT = "XAU_USD";
const GRANULARITY_BY_TIMEFRAME = {
  M5: "M5",
  H1: "H1",
  H4: "H4",
  D: "D"
};
const GRANULARITY_SECONDS = {
  M5: 5 * 60,
  H1: 60 * 60,
  H4: 4 * 60 * 60,
  D: 24 * 60 * 60
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

function candleFromOanda(candle) {
  return {
    t: candle.time,
    open: round(candle.mid.o),
    high: round(candle.mid.h),
    low: round(candle.mid.l),
    close: round(candle.mid.c),
    volume: Number(candle.volume || 0)
  };
}

class OandaHttpError extends Error {
  constructor(message, { status, retryable = false, retryAfterMs = 0, payload = null } = {}) {
    super(message);
    this.name = "OandaHttpError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.payload = payload;
  }
}

class RateLimiter {
  constructor(limitPerSecond = 20) {
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

export class OandaAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OANDA_API_KEY || "";
    this.accountId = options.accountId || process.env.OANDA_ACCOUNT_ID || "";
    this.apiBase = (options.apiBase || process.env.OANDA_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
    this.instrument = options.instrument || process.env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT;
    this.timeoutMs = Number(options.timeoutMs || process.env.OANDA_TIMEOUT_MS || 8000);
    this.maxRetries = Number(options.maxRetries || process.env.OANDA_MAX_RETRIES || 2);
    this.rateLimiter = new RateLimiter(Number(options.limitPerSecond || process.env.OANDA_RATE_LIMIT_PER_SECOND || 20));
    this.resolvedAccountId = "";
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async request(pathname, params = {}) {
    if (!this.isConfigured()) {
      throw new OandaHttpError("OANDA_API_KEY is not configured", { status: 0 });
    }

    const url = new URL(`${this.apiBase}${pathname}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.rateLimiter.schedule(() => this.fetchJson(url));
      } catch (error) {
        const canRetry = error.retryable && attempt < this.maxRetries;
        if (!canRetry) throw error;
        const backoffMs = error.retryAfterMs || 250 * 2 ** attempt;
        await sleep(backoffMs);
      }
    }
    throw new OandaHttpError("OANDA request failed after retries", { status: 0 });
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json"
        },
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (response.ok) return payload;

      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
      throw new OandaHttpError(payload.errorMessage || payload.message || `OANDA HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs,
        payload
      });
    } catch (error) {
      if (error instanceof OandaHttpError) throw error;
      throw new OandaHttpError(error.message || "OANDA network error", {
        status: 0,
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccounts() {
    const payload = await this.request("/v3/accounts");
    return payload.accounts || [];
  }

  async resolveAccountId() {
    if (this.accountId) return this.accountId;
    if (this.resolvedAccountId) return this.resolvedAccountId;
    const [account] = await this.getAccounts();
    if (!account?.id) {
      throw new OandaHttpError("No OANDA account is available for this token", { status: 0 });
    }
    this.resolvedAccountId = account.id;
    return this.resolvedAccountId;
  }

  async getPricing(instrument = this.instrument) {
    const accountId = await this.resolveAccountId();
    const payload = await this.request(`/v3/accounts/${encodeURIComponent(accountId)}/pricing`, {
      instruments: instrument
    });
    const price = payload.prices?.[0];
    if (!price) throw new OandaHttpError(`No OANDA pricing returned for ${instrument}`, { status: 0 });

    const bid = toNumber(price.bids?.[0]?.price);
    const ask = toNumber(price.asks?.[0]?.price);
    const mid = bid !== null && ask !== null ? round((bid + ask) / 2, 3) : toNumber(price.closeoutBid);
    return {
      instrument: price.instrument || instrument,
      time: price.time,
      bid,
      ask,
      mid,
      spread: bid !== null && ask !== null ? round(ask - bid, 3) : null,
      tradeable: Boolean(price.tradeable)
    };
  }

  async getCandles({ timeframe = "H1", count, instrument = this.instrument, from, to } = {}) {
    const granularity = GRANULARITY_BY_TIMEFRAME[timeframe] || timeframe;
    const defaultCount = granularity === "D" ? 80 : granularity === "M5" ? 288 : 96;
    const payload = await this.request(`/v3/instruments/${encodeURIComponent(instrument)}/candles`, {
      price: "M",
      granularity,
      count: count || defaultCount,
      from,
      to
    });

    return (payload.candles || [])
      .filter((candle) => candle.mid)
      .map(candleFromOanda);
  }

  async getHistoricalCandles({ timeframe = "H1", days = 730, instrument = this.instrument, from, to, pageSize = 5000 } = {}) {
    const granularity = GRANULARITY_BY_TIMEFRAME[timeframe] || timeframe;
    const stepMs = (GRANULARITY_SECONDS[granularity] || 60 * 60) * 1000;
    const endTime = to ? new Date(to) : new Date();
    const startTime = from ? new Date(from) : new Date(endTime.getTime() - Number(days) * 24 * 60 * 60 * 1000);
    const maxPageSize = Math.max(1, Math.min(5000, Number(pageSize || 5000)));
    const output = [];
    const seen = new Set();
    let cursor = startTime.toISOString();

    for (let page = 0; page < 80 && new Date(cursor) <= endTime; page += 1) {
      const candles = await this.getCandles({
        timeframe,
        instrument,
        count: maxPageSize,
        from: cursor
      });
      if (!candles.length) break;

      for (const candle of candles) {
        const time = new Date(candle.t);
        if (time < startTime || time > endTime || seen.has(candle.t)) continue;
        seen.add(candle.t);
        output.push(candle);
      }

      const last = candles.at(-1);
      const nextCursor = new Date(new Date(last.t).getTime() + stepMs).toISOString();
      if (new Date(nextCursor) <= new Date(cursor) || new Date(last.t) >= endTime) break;
      cursor = nextCursor;
    }

    return output.sort((a, b) => new Date(a.t) - new Date(b.t));
  }
}

export function timeframeToGranularity(timeframe) {
  return GRANULARITY_BY_TIMEFRAME[timeframe] || timeframe;
}
