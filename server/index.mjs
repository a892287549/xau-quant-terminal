import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploymentInfo,
  logs
} from "./mockData.mjs";
import { LiveDataProvider, isRealDataMode } from "./data/liveProvider.js";
import { MacroFetcher, startMacroScheduler } from "./data/macroFetcher.js";
import { OandaAdapter } from "./data/oandaAdapter.js";
import { OkxAdapter } from "./data/okxAdapter.js";
import { OkxExecutor } from "./execution/okxExecutor.js";
import { TradeDaemon } from "./daemon/tradeDaemon.js";
import { FeishuNotifier } from "./notifications/feishuNotifier.js";
import { createDatabase } from "./db/postgres.js";
import { Storage } from "./db/storage.js";
import { SettingsStore } from "./settingsStore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = process.env.DATA_DIR || path.join(rootDir, "data");
const port = Number(process.env.PORT || 4899);
const startedAt = new Date().toISOString();
const db = createDatabase();
const storage = new Storage(db);
const settingsStore = new SettingsStore(dataDir, storage);
const oandaAdapter = new OandaAdapter();
const okxAdapter = new OkxAdapter();
const okxExecutor = new OkxExecutor();
const macroFetcher = new MacroFetcher({ dataDir, storage });
const feishuNotifier = new FeishuNotifier();
const dataProvider = new LiveDataProvider({ oandaAdapter, okxAdapter, macroFetcher, storage });
const tradeDaemon = new TradeDaemon({
  getSettings: async () => runtimeSettings(await settingsStore.read()),
  okxAdapter,
  okxExecutor,
  macroFetcher,
  storage,
  notifier: feishuNotifier
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(isBuffer ? body : String(body));
}

function json(res, payload, status = 200) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8"
  });
}

function notFound(res) {
  json(res, { ok: false, error: "not_found" }, 404);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function toTradeCsv(trades) {
  const headers = ["id", "closedAt", "symbol", "direction", "type", "entry", "exit", "size", "pnl", "rMultiple", "signalGrade"];
  const rows = trades.map((trade) => headers.map((key) => csvEscape(trade[key])).join(","));
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

function runtimeSettings(settings) {
  return {
    ...settings,
    api: {
      ...settings.api,
      oandaTokenConfigured: settings.api.oandaTokenConfigured || Boolean(process.env.OANDA_API_KEY),
      okxTradingConfigured: Boolean(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE)
    },
    runtime: {
      ...settings.runtime,
      tradingEnabled: process.env.TRADING_ENABLED === "true"
    }
  };
}

async function handleApi(req, res, url) {
  const savedSettings = await settingsStore.read();
  const settings = runtimeSettings(savedSettings);
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, {
      ok: true,
      service: "xau-quant-terminal",
      stage: "six-module-architecture",
      trading: {
        enabled: process.env.TRADING_ENABLED === "true",
        mode: process.env.TRADING_ENABLED === "true" ? "live-enabled-by-env" : "disabled",
        execution: okxExecutor.status(settings)
      },
      daemon: tradeDaemon.status(),
      dataSource: {
        mode: settings.api.dataMode,
        provider: settings.api.dataProvider,
        realtimeProvider: "okx",
        backtestProvider: "oanda",
        okxInstrument: okxAdapter.instrument,
        oandaInstrument: oandaAdapter.instrument,
        okxTradingConfigured: okxAdapter.isConfigured(),
        oandaConfigured: oandaAdapter.isConfigured(),
        status: isRealDataMode(settings) && oandaAdapter.isConfigured() ? "configured" : settings.api.dataMode === "mock" ? "mock" : "not_configured"
      },
      modules: ["dashboard", "signals", "macro", "trades", "backtests", "settings"],
      database: {
        enabled: storage.enabled
      },
      deployment: deploymentInfo(startedAt)
    });
  }
  if (req.method === "GET" && pathname === "/api/dashboard") {
    return json(res, await dataProvider.dashboard(settings, url.searchParams.get("timeframe") || "H1"));
  }
  if (req.method === "GET" && pathname === "/api/signals") {
    return json(res, await dataProvider.signalCenter(settings));
  }
  if (req.method === "GET" && pathname.startsWith("/api/signals/")) {
    const id = decodeURIComponent(pathname.split("/").at(-1));
    const found = await dataProvider.signalById(id, settings);
    return found ? json(res, found) : notFound(res);
  }
  if (req.method === "GET" && pathname === "/api/macro") {
    return json(res, await dataProvider.macroMonitor(settings));
  }
  if (req.method === "GET" && pathname === "/api/trades") {
    return json(res, await dataProvider.tradeCenter(settings, {
      status: url.searchParams.get("status") || "all"
    }));
  }
  if (req.method === "POST" && pathname === "/api/orders") {
    const input = await readBody(req);
    const side = input.side || (input.direction === "LONG" ? "buy" : input.direction === "SHORT" ? "sell" : "");
    const stopLossPrice = input.stopLossPrice || input.slTriggerPx || input.stop;
    const takeProfitPrice = input.takeProfitPrice || input.tpTriggerPx || input.target;
    try {
      const order = await okxExecutor.placePerpetualMarketOrder({
        instrument: input.instrument || okxAdapter.instrument,
        side,
        size: input.size || input.sz,
        stopLossPrice,
        takeProfitPrice,
        clientOrderId: input.clientOrderId || input.clOrdId,
        tdMode: input.tdMode || input.tradeMode || "cross"
      }, settings);
      return json(res, { ok: true, order });
    } catch (error) {
      return json(res, {
        ok: false,
        error: error.reason || error.message,
        message: error.message
      }, error.status || 400);
    }
  }
  if (req.method === "GET" && pathname === "/api/export/trades.csv") {
    const trades = await dataProvider.tradeCenter(settings);
    return send(res, 200, toTradeCsv(trades.history), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"xau-trades.csv\""
    });
  }
  if (req.method === "GET" && pathname === "/api/backtests") {
    return json(res, await dataProvider.backtestCatalog(settings));
  }
  if (req.method === "POST" && pathname === "/api/backtests/run") {
    const input = await readBody(req);
    return json(res, await dataProvider.createBacktestResult(input, settings));
  }
  if (req.method === "GET" && pathname === "/api/settings") {
    return json(res, {
      settings,
      deployment: deploymentInfo(startedAt),
      executionAudit: await storage.getExecutionAudit?.(20) || [],
      logs: dataProvider.logs()
    });
  }
  if (req.method === "PUT" && pathname === "/api/settings") {
    const input = await readBody(req);
    const next = await settingsStore.write(input);
    return json(res, { ok: true, settings: runtimeSettings(next) });
  }
  if (req.method === "GET" && pathname === "/api/logs") {
    return json(res, { logs: logs() });
  }
  return notFound(res);
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) return notFound(res);
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    return send(res, 200, data, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream"
    });
  } catch {
    const index = await readFile(path.join(publicDir, "index.html"));
    return send(res, 200, index, { "Content-Type": mimeTypes[".html"] });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
});

if (storage.enabled) {
  try {
    await storage.init();
  } catch (error) {
    console.warn(`database init failed, continuing with file fallback: ${error.message}`);
    storage.disable();
  }
}

if (process.argv.includes("--smoke")) {
  const settings = await settingsStore.read();
  const runtime = runtimeSettings(settings);
  console.log(JSON.stringify({
    dashboard: (await dataProvider.dashboard(runtime)).activeSignals.length,
    signals: (await dataProvider.signalCenter(runtime)).signals.length,
    macro: (await dataProvider.macroMonitor(runtime)).indicators.length,
    trades: (await dataProvider.tradeCenter(runtime)).history.length,
    backtest: (await dataProvider.createBacktestResult({}, runtime)).metrics.trades,
    settings: settings.runtime.version
  }));
} else {
  startMacroScheduler(macroFetcher, {
    enabled: async () => isRealDataMode(runtimeSettings(await settingsStore.read()))
  });
  tradeDaemon.start();
  server.listen(port, "0.0.0.0", () => {
    console.log(`xau-quant-terminal listening on ${port}`);
  });
}
