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
  if (value === "paper" || value === "local") return "paper";
  return value === "live" || value === "real" ? "live" : "demo";
}

function normalizeMarginMode(value) {
  return "isolated";
}

function compactId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
}

function roundLot(value) {
  return Math.max(0.01, Math.floor(Number(value || 0) * 100) / 100);
}

function floorLot(value) {
  return Math.floor(Number(value || 0) * 100) / 100;
}

function closeSide(direction) {
  return direction === "LONG" ? "sell" : "buy";
}

function directionSign(direction) {
  return direction === "SHORT" ? -1 : 1;
}

function responseData(payload) {
  return payload?.data?.[0] || payload?.response || payload || {};
}

function ensureAccepted(payload, operation = "OKX order") {
  const row = responseData(payload);
  const sCode = row.sCode || payload?.code;
  if (sCode && sCode !== "0") {
    throw new OkxExecutionError(row.sMsg || payload?.msg || `${operation} rejected by OKX`, {
      status: 400,
      retryable: sCode === "50011",
      payload,
      reason: `okx_${sCode}`
    });
  }
  return row;
}

function orderIdentifier(payload = {}) {
  const row = responseData(payload);
  return {
    ordId: row.ordId || payload.ordId || "",
    clOrdId: row.clOrdId || payload.request?.clOrdId || payload.clOrdId || ""
  };
}

function normalizeOrderFill(row = {}, fallback = {}) {
  const fillPx = Number(row.avgPx || row.fillPx || row.px || fallback.fillPx || fallback.avgPx);
  const accFillSz = Number(row.accFillSz || row.fillSz || fallback.accFillSz || fallback.fillSz || 0);
  const state = String(row.state || fallback.state || "").toLowerCase();
  return {
    confirmed: state === "filled",
    state,
    ordId: row.ordId || fallback.ordId || "",
    clOrdId: row.clOrdId || fallback.clOrdId || "",
    fillPx: Number.isFinite(fillPx) ? fillPx : null,
    accFillSz: Number.isFinite(accFillSz) ? accFillSz : 0,
    fee: Number(row.fee || fallback.fee || 0),
    feeCcy: row.feeCcy || fallback.feeCcy || "",
    raw: row
  };
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

  marginMode(settings = {}, fallback = "") {
    return normalizeMarginMode(fallback || settings?.api?.marginMode || process.env.OKX_MARGIN_MODE || "isolated");
  }

  apiBaseFor(settings = {}) {
    return this.tradingMode(settings) === "demo" ? this.demoApiBase : this.liveApiBase;
  }

  status(settings = {}) {
    const mode = this.tradingMode(settings);
    const guard = mode === "paper"
      ? { ok: true, reason: "local_paper_execution" }
      : this.guard(settings);
    return {
      provider: "okx",
      mode,
      marginMode: this.marginMode(settings),
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
    if (mode === "paper") return { ok: false, reason: "paper_execution_does_not_use_okx_private_api" };
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

  async request(pathname, { method = "POST", body = null, params = {}, settings = {} } = {}) {
    const url = new URL(`${this.apiBaseFor(settings)}${pathname}`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });
    const requestPath = `${url.pathname}${url.search}`;
    const upperMethod = method.toUpperCase();
    const bodyText = upperMethod === "GET" || body === null ? "" : JSON.stringify(body);
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
        body: bodyText || undefined,
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

  buildPerpetualMarketOrder({
    instrument = this.instrument,
    side,
    size,
    stopLossPrice,
    takeProfitPrice,
    tdMode = "",
    clientOrderId,
    reduceOnly = false,
    posSide = ""
  } = {}, settings = {}) {
    if (!["buy", "sell"].includes(side)) {
      throw new OkxExecutionError("OKX order side must be buy or sell", { reason: "invalid_side" });
    }
    if (!size) {
      throw new OkxExecutionError("OKX order size is required", { reason: "missing_size" });
    }
    const clOrdId = clientOrderId || compactId("xau");
    const body = {
      instId: instrument,
      tdMode: this.marginMode(settings, tdMode),
      side,
      ordType: "market",
      sz: String(size),
      clOrdId
    };
    if (reduceOnly) body.reduceOnly = "true";
    if (posSide) body.posSide = posSide;
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

  async getOrderDetails({ instrument = this.instrument, ordId = "", clOrdId = "", settings = {} } = {}) {
    if (!ordId && !clOrdId) return null;
    const payload = await this.request("/api/v5/trade/order", {
      method: "GET",
      params: {
        instId: instrument,
        ordId,
        clOrdId
      },
      settings
    });
    return responseData(payload);
  }

  async getManagedOrderFill({ instrument = this.instrument, ordId = "", clOrdId = "", settings = {} } = {}) {
    const details = await this.getOrderDetails({ instrument, ordId, clOrdId, settings });
    return details ? normalizeOrderFill(details, { ordId, clOrdId }) : null;
  }

  async waitForOrderFill(order, { instrument = this.instrument, settings = {}, timeoutMs = 12000, pollMs = 600 } = {}) {
    const ids = orderIdentifier(order);
    const fallback = responseData(order);
    if (!ids.ordId && !ids.clOrdId) return normalizeOrderFill(fallback);
    const started = Date.now();
    let last = fallback;
    while (Date.now() - started <= timeoutMs) {
      const details = await this.getOrderDetails({
        instrument,
        ordId: ids.ordId,
        clOrdId: ids.clOrdId,
        settings
      });
      if (details) last = details;
      const fill = normalizeOrderFill(last, fallback);
      if (fill.confirmed) return fill;
      if (["canceled", "rejected"].includes(fill.state)) {
        throw new OkxExecutionError(`OKX order ${fill.state}`, {
          reason: `order_${fill.state}`,
          payload: last
        });
      }
      await sleep(pollMs);
    }
    return {
      ...normalizeOrderFill(last, fallback),
      confirmed: false,
      timedOut: true
    };
  }

  async placePerpetualMarketOrder(input = {}, settings = {}, options = {}) {
    const guard = this.guard(settings);
    if (!guard.ok) {
      throw new OkxExecutionError("OKX order submission is disabled", {
        status: 400,
        reason: guard.reason
      });
    }
    const body = this.buildPerpetualMarketOrder(input, settings);
    const payload = await this.request("/api/v5/trade/order", {
      method: "POST",
      body,
      settings
    });
    const response = ensureAccepted(payload, "OKX market order");
    const result = {
      mode: this.tradingMode(settings),
      request: body,
      response
    };
    if (options.confirmFill !== false) {
      const fill = await this.waitForOrderFill(result, {
        instrument: body.instId,
        settings,
        timeoutMs: options.timeoutMs
      });
      if (!fill.confirmed) {
        throw new OkxExecutionError("OKX order was accepted but fill was not confirmed", {
          reason: "fill_not_confirmed",
          payload: { order: result, fill }
        });
      }
      result.fill = fill;
    }
    return {
      ...result
    };
  }

  async placeReduceOnlyLimitOrder({
    instrument = this.instrument,
    side,
    size,
    price,
    tdMode = "",
    clientOrderId
  } = {}, settings = {}) {
    const guard = this.guard(settings);
    if (!guard.ok) {
      throw new OkxExecutionError("OKX order submission is disabled", {
        status: 400,
        reason: guard.reason
      });
    }
    if (!["buy", "sell"].includes(side)) {
      throw new OkxExecutionError("OKX order side must be buy or sell", { reason: "invalid_side" });
    }
    const roundedSize = roundLot(size);
    const roundedPrice = Number(price);
    if (!Number.isFinite(roundedPrice) || roundedPrice <= 0) {
      throw new OkxExecutionError("OKX limit price is required", { reason: "missing_price" });
    }
    const body = {
      instId: instrument,
      tdMode: this.marginMode(settings, tdMode),
      side,
      ordType: "limit",
      px: String(roundedPrice),
      sz: String(roundedSize),
      clOrdId: clientOrderId || compactId("ptgt"),
      reduceOnly: "true"
    };
    const payload = await this.request("/api/v5/trade/order", {
      method: "POST",
      body,
      settings
    });
    return {
      mode: this.tradingMode(settings),
      request: body,
      response: ensureAccepted(payload, "OKX limit order")
    };
  }

  async cancelOrder({ instrument = this.instrument, ordId = "", clOrdId = "", settings = {} } = {}) {
    if (!ordId && !clOrdId) return { skipped: true, reason: "missing_order_id" };
    const body = {
      instId: instrument
    };
    if (ordId) body.ordId = ordId;
    if (clOrdId) body.clOrdId = clOrdId;
    const payload = await this.request("/api/v5/trade/cancel-order", {
      method: "POST",
      body,
      settings
    });
    return {
      request: body,
      response: ensureAccepted(payload, "OKX cancel order")
    };
  }

  async cancelManagedOrder(orderRef = {}, settings = {}) {
    const ordId = orderRef.ordId || orderRef.orderId || orderRef.partialTargetOrderId || "";
    const clOrdId = orderRef.clOrdId || orderRef.clientOrderId || orderRef.partialTargetClOrdId || "";
    const instrument = orderRef.instrument || this.instrument;
    if (!ordId && !clOrdId) return { skipped: true, reason: "missing_order_id" };
    try {
      return await this.cancelOrder({ instrument, ordId, clOrdId, settings });
    } catch (error) {
      return {
        skipped: false,
        error: error.reason || error.message,
        payload: error.payload || null
      };
    }
  }

  async closePosition(positionId, { storage, settings = {}, reason = "closed", exitPrice = null } = {}) {
    if (!storage?.enabled) {
      throw new OkxExecutionError("Storage is required to close a managed position", { reason: "storage_missing" });
    }
    const trade = await storage.getTradeById(positionId);
    if (!trade) {
      throw new OkxExecutionError(`Trade ${positionId} was not found`, { reason: "trade_not_found" });
    }
    const partialTargetCancel = await this.cancelManagedOrder({
      instrument: trade.symbol || this.instrument,
      ordId: trade.payload?.partialTargetOrderId,
      clOrdId: trade.payload?.partialTargetClOrdId
    }, settings);
    const size = roundLot(trade.size);
    const order = await this.placePerpetualMarketOrder({
      instrument: trade.symbol || this.instrument,
      side: closeSide(trade.direction),
      size,
      clientOrderId: compactId("cls"),
      reduceOnly: true
    }, settings);
    const fill = Number(order.fill?.fillPx || responseData(order).fillPx || responseData(order).avgPx || exitPrice || trade.exit || trade.entry);
    const pnlMultiplier = Number(settings?.daemon?.pnlMultiplier || 100);
    const pnl = Number.isFinite(fill)
      ? (fill - Number(trade.entry)) * directionSign(trade.direction) * Number(trade.size || 0) * pnlMultiplier
      : Number(trade.pnl || 0);
    const status = reason === "timeout" ? "timeout" : reason === "stop_loss" ? "stopped_out" : "closed";
    await storage.updateTrade(positionId, {
      closedAt: new Date().toISOString(),
      exit: Number.isFinite(fill) ? fill : null,
      pnl: Number(Number(pnl || 0).toFixed(2)),
      status,
      payload: {
        ...(trade.payload || {}),
        exitReason: reason,
        closeOrder: order,
        partialTargetCancel,
        events: [
          ...((trade.payload || {}).events || []),
          { at: new Date().toISOString(), type: "closed", reason, order, partialTargetCancel }
        ]
      }
    });
    await storage.recordExecutionAudit?.({
      tradeId: positionId,
      signalEntry: trade.entry,
      actualFill: null,
      slippagePct: null,
      expectedStop: trade.payload?.stop || null,
      actualStopOrderId: order.response?.ordId || order.response?.clOrdId || "",
      stopFillPrice: Number.isFinite(fill) ? fill : null,
      stopSlippagePct: Number.isFinite(fill) && trade.payload?.stop
        ? ((fill - Number(trade.payload.stop)) / Number(trade.payload.stop)) * 100 * directionSign(trade.direction)
        : null,
      fee: order.fill?.fee || 0,
      feeAsset: order.fill?.feeCcy || "USDT",
      payload: {
        reason,
        order
      }
    });
    return {
      tradeId: positionId,
      status,
      sizeClosed: size,
      remainingSize: 0,
      pnl: Number(Number(pnl || 0).toFixed(2)),
      order
    };
  }

  async closeHalfPosition(positionId, { storage, settings = {} } = {}) {
    if (!storage?.enabled) {
      throw new OkxExecutionError("Storage is required to close half a managed position", { reason: "storage_missing" });
    }
    const trade = await storage.getTradeById(positionId);
    if (!trade) {
      throw new OkxExecutionError(`Trade ${positionId} was not found`, { reason: "trade_not_found" });
    }
    const totalSize = Number(trade.size || 0);
    if (totalSize < 0.02) {
      throw new OkxExecutionError("Position is too small for partial close", { reason: "partial_size_too_small" });
    }
    const partialTargetCancel = await this.cancelManagedOrder({
      instrument: trade.symbol || this.instrument,
      ordId: trade.payload?.partialTargetOrderId,
      clOrdId: trade.payload?.partialTargetClOrdId
    }, settings);
    const size = roundLot(totalSize / 2);
    const remainingSize = floorLot(totalSize - size);
    const order = await this.placePerpetualMarketOrder({
      instrument: trade.symbol || this.instrument,
      side: closeSide(trade.direction),
      size,
      clientOrderId: compactId("ptp"),
      reduceOnly: true
    }, settings);
    await storage.updateTrade(positionId, {
      size: remainingSize,
      status: "partial_closed",
      payload: {
        ...(trade.payload || {}),
        partialTpAt: new Date().toISOString(),
        partialTpOrder: order,
        partialTargetCancel,
        originalSize: trade.payload?.originalSize || trade.size,
        events: [
          ...((trade.payload || {}).events || []),
          { at: new Date().toISOString(), type: "partial_tp", sizeClosed: size, remainingSize, order, partialTargetCancel }
        ]
      }
    });
    await storage.recordExecutionAudit?.({
      tradeId: positionId,
      signalEntry: trade.entry,
      actualFill: order.fill?.fillPx || null,
      slippagePct: null,
      expectedStop: trade.payload?.stop || null,
      actualStopOrderId: order.response?.ordId || order.response?.clOrdId || "",
      stopFillPrice: null,
      stopSlippagePct: null,
      fee: order.fill?.fee || 0,
      feeAsset: order.fill?.feeCcy || "USDT",
      payload: {
        reason: "partial_take_profit",
        sizeClosed: size,
        remainingSize,
        order
      }
    });
    return {
      tradeId: positionId,
      sizeClosed: size,
      remainingSize,
      order
    };
  }

  async cancelStopAlgo({ instrument = this.instrument, algoId, settings = {} } = {}) {
    if (!algoId) return { skipped: true, reason: "missing_algo_id" };
    const payload = await this.request("/api/v5/trade/cancel-algos", {
      method: "POST",
      body: [{ instId: instrument, algoId }],
      settings
    });
    return responseData(payload);
  }

  async placeStopAlgo({ instrument = this.instrument, direction, size, stopPrice, settings = {} } = {}) {
    const body = {
      instId: instrument,
      tdMode: this.marginMode(settings),
      side: closeSide(direction),
      ordType: "conditional",
      sz: String(roundLot(size)),
      slTriggerPx: String(stopPrice),
      slOrdPx: "-1",
      reduceOnly: "true"
    };
    const payload = await this.request("/api/v5/trade/order-algo", {
      method: "POST",
      body,
      settings
    });
    return {
      request: body,
      response: ensureAccepted(payload, "OKX stop algo")
    };
  }

  async updateTrailingStop(positionId, newStopPrice, { storage, settings = {} } = {}) {
    if (!storage?.enabled) {
      throw new OkxExecutionError("Storage is required to update a managed stop", { reason: "storage_missing" });
    }
    const trade = await storage.getTradeById(positionId);
    if (!trade) {
      throw new OkxExecutionError(`Trade ${positionId} was not found`, { reason: "trade_not_found" });
    }
    const oldAlgoId = trade.payload?.stopAlgoId || trade.payload?.actualStopOrderId || trade.payload?.stopOrderId;
    const cancelResult = await this.cancelStopAlgo({
      instrument: trade.symbol || this.instrument,
      algoId: oldAlgoId,
      settings
    });
    const stopOrder = await this.placeStopAlgo({
      instrument: trade.symbol || this.instrument,
      direction: trade.direction,
      size: trade.size,
      stopPrice: newStopPrice,
      settings
    });
    const nextAlgoId = stopOrder.response?.algoId || stopOrder.response?.ordId || "";
    await storage.updateTrade(positionId, {
      payload: {
        ...(trade.payload || {}),
        stop: newStopPrice,
        stopAlgoId: nextAlgoId,
        trailingStopUpdatedAt: new Date().toISOString(),
        events: [
          ...((trade.payload || {}).events || []),
          { at: new Date().toISOString(), type: "trailing_stop_update", oldAlgoId, newStopPrice, stopOrder, cancelResult }
        ]
      }
    });
    return {
      tradeId: positionId,
      stop: newStopPrice,
      stopAlgoId: nextAlgoId,
      cancelResult,
      stopOrder
    };
  }
}
