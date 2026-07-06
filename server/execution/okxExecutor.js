import crypto from "node:crypto";

const DEFAULT_LIVE_API_BASE = "https://www.okx.com";
const DEFAULT_DEMO_API_BASE = "https://demo.okx.com";
const DEFAULT_INST_ID = "XAU-USDT-SWAP";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function normalizeMode(value) {
  return value === "live" || value === "real" ? "live" : "demo";
}

function compactId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
}

class OkxExecutionError extends Error {
  constructor(message, { status = 400, retryable = false, retryAfterMs = 0, payload = null, reason = "" } = {}) {
    super(message);
    this.name = "OkxExecutionError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.payload = payload;
    this.reason = reason || message;
  }
}

class RateLimiter {
  constructor(limitPerSecond = 5) {
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

export class OkxExecutor {
  constructor(options = {}) {
    this.liveApiBase = (options.liveApiBase || process.env.OKX_LIVE_API_BASE || process.env.OKX_API_BASE || DEFAULT_LIVE_API_BASE).replace(/\/$/, "");
    this.demoApiBase = (options.demoApiBase || process.env.OKX_DEMO_API_BASE || DEFAULT_DEMO_API_BASE).replace(/\/$/, "");
    this.instrument = options.instrument || process.env.OKX_INST_ID || DEFAULT_INST_ID;
    this.apiKey = options.apiKey || process.env.OKX_API_KEY || "";
    this.apiSecret = options.apiSecret || process.env.OKX_API_SECRET || "";
    this.passphrase = options.passphrase || process.env.OKX_API_PASSPHRASE || "";
    this.timeoutMs = Number(options.timeoutMs || process.env.OKX_EXECUTION_TIMEOUT_MS || 8000);
    this.maxRetries = Number(options.maxRetries || process.env.OKX_EXECUTION_MAX_RETRIES || 1);
    this.rateLimiter = new RateLimiter(Number(options.limitPerSecond || process.env.OKX_EXECUTION_RATE_LIMIT_PER_SECOND || 5));
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiSecret && this.passphrase);
  }

  tradingMode(settings = {}) {
    return normalizeMode(settings?.api?.tradeMode || process.env.OKX_TRADING_MODE || "demo");
  }

  apiBaseFor(settings = {}) {
    return this.tradingMode(settings) === "demo" ? this.demoApiBase : this.liveApiBase;
  }

  status(settings = {}) {
    const mode = this.tradingMode(settings);
    const guard = this.guard(settings);
    return {
      provider: "okx",
      mode,
      instrument: this.instrument,
      configured: this.isConfigured(),
      demoTradingEnabled: bool(process.env.OKX_DEMO_TRADING_ENABLED),
      liveTradingEnabled: bool(process.env.TRADING_ENABLED),
      canSubmit: guard.ok,
      reason: guard.reason
    };
  }

  guard(settings = {}) {
    const mode = this.tradingMode(settings);
    if (settings?.api?.broker !== "okx") return { ok: false, reason: "broker_not_okx" };
    if (!this.isConfigured()) return { ok: false, reason: "okx_credentials_missing" };
    if (mode === "live" && !bool(process.env.TRADING_ENABLED)) {
      return { ok: false, reason: "live_trading_disabled" };
    }
    if (mode === "demo" && !bool(process.env.OKX_DEMO_TRADING_ENABLED) && !bool(process.env.TRADING_ENABLED)) {
      return { ok: false, reason: "demo_trading_disabled" };
    }
    return { ok: true, reason: "ready" };
  }

  sign(timestamp, method, requestPath, bodyText = "") {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(`${timestamp}${method.toUpperCase()}${requestPath}${bodyText}`)
      .digest("base64");
  }

  headers({ timestamp, method, requestPath, bodyText, mode }) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": this.sign(timestamp, method, requestPath, bodyText),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase
    };
    if (mode === "demo") headers["x-simulated-trading"] = "1";
    return headers;
  }

  async request(pathname, { method = "POST", body = {}, settings = {} } = {}) {
    const url = new URL(`${this.apiBaseFor(settings)}${pathname}`);
    const requestPath = `${url.pathname}${url.search}`;
    const bodyText = JSON.stringify(body);
    const mode = this.tradingMode(settings);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.rateLimiter.schedule(() => this.fetchJson(url, {
          method,
          requestPath,
          bodyText,
          mode
        }));
      } catch (error) {
        const canRetry = error.retryable && attempt < this.maxRetries;
        if (!canRetry) throw error;
        const backoffMs = error.retryAfterMs || 250 * 2 ** attempt;
        await sleep(backoffMs);
      }
    }
    throw new OkxExecutionError("OKX execution request failed after retries", { status: 502 });
  }

  async fetchJson(url, { method, requestPath, bodyText, mode }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const timestamp = new Date().toISOString();
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers({ timestamp, method, requestPath, bodyText, mode }),
        body: bodyText,
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
      if (!response.ok) {
        throw new OkxExecutionError(payload.msg || `OKX HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs,
          payload
        });
      }
      if (payload.code && payload.code !== "0") {
        throw new OkxExecutionError(payload.msg || `OKX code ${payload.code}`, {
          status: 400,
          retryable: payload.code === "50011",
          retryAfterMs,
          payload
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof OkxExecutionError) throw error;
      throw new OkxExecutionError(error.message || "OKX execution network error", {
        status: 502,
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  }

  buildPerpetualMarketOrder({ instrument = this.instrument, side, size, stopLossPrice, takeProfitPrice, tdMode = "cross", clientOrderId } = {}) {
    if (!["buy", "sell"].includes(side)) {
      throw new OkxExecutionError("OKX order side must be buy or sell", { reason: "invalid_side" });
    }
    if (!size) {
      throw new OkxExecutionError("OKX order size is required", { reason: "missing_size" });
    }
    const clOrdId = clientOrderId || compactId("xau");
    const body = {
      instId: instrument,
      tdMode,
      side,
      ordType: "market",
      sz: String(size),
      clOrdId
    };
    if (stopLossPrice) {
      const stop = {
        attachAlgoClOrdId: compactId("sl"),
        slTriggerPx: String(stopLossPrice),
        slOrdPx: "-1"
      };
      if (takeProfitPrice) {
        stop.tpTriggerPx = String(takeProfitPrice);
        stop.tpOrdPx = "-1";
      }
      body.attachAlgoOrds = [stop];
    }
    return body;
  }

  async placePerpetualMarketOrder(input = {}, settings = {}) {
    const guard = this.guard(settings);
    if (!guard.ok) {
      throw new OkxExecutionError("OKX order submission is disabled", {
        status: 400,
        reason: guard.reason
      });
    }
    const body = this.buildPerpetualMarketOrder(input);
    const payload = await this.request("/api/v5/trade/order", {
      method: "POST",
      body,
      settings
    });
    return {
      mode: this.tradingMode(settings),
      request: body,
      response: payload.data?.[0] || payload
    };
  }
}
