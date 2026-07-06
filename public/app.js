const apiBase = location.pathname.startsWith("/quant")
  ? "/quant"
  : location.pathname.startsWith("/xau")
    ? "/xau"
    : "";

const pages = {
  dashboard: ["主页", "状态总览"],
  signals: ["信号解释", "信号引擎"],
  macro: ["宏观因子", "宏观监控"],
  trades: ["持仓与盈亏", "交易中心"],
  backtests: ["策略实验", "回测实验室"],
  settings: ["参数与部署", "系统配置"]
};

const state = {
  page: location.hash.replace("#", "") || "dashboard",
  timeframe: "H1",
  data: {},
  filters: {
    grades: [],
    directions: [],
    types: [],
    dateFrom: "",
    dateTo: ""
  },
  tradeFilters: {
    direction: "ALL",
    type: "ALL",
    grade: "ALL",
    dateFrom: "",
    dateTo: "",
    sort: "closedAtDesc"
  },
  selectedSignalId: "",
  backtestResult: null,
  settingsTab: "api"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
let particleFrame = null;
let particles = [];
let tradeRefreshTimer = null;
let tradeRefreshInFlight = false;
let wsClient = null;
let wsReconnectTimer = null;
const ADMIN_TOKEN_KEY = "xauAdminToken";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function adminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function setAdminToken(value) {
  const token = String(value || "").trim();
  if (token) {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  }
}

function fmt(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "待接入";
  return `${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
}

function dateShort(value) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function dateOnly(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function inDateRange(value, from, to) {
  const day = dateOnly(value);
  return (!from || day >= from) && (!to || day <= to);
}

function countdownLabel(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.ceil(minutes / 1440)} 天`;
}

function directionLabel(direction) {
  return {
    ALL: "全部",
    LONG: "做多",
    SHORT: "做空",
    FLAT: "观望"
  }[direction] || direction;
}

function localizeDirectionText(value) {
  return String(value ?? "")
    .replace(/\bLONG\b/g, "做多")
    .replace(/\bSHORT\b/g, "做空")
    .replace(/\bFLAT\b/g, "观望")
    .replace(/\blots?\b/gi, "手");
}

async function api(path, options = {}) {
  const token = adminToken();
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadData() {
  const [health, dashboard, signals, macro, trades, backtests, settings] = await Promise.all([
    api("/api/health"),
    api(`/api/dashboard?timeframe=${state.timeframe}`),
    api("/api/signals"),
    api("/api/macro"),
    api("/api/trades"),
    api("/api/backtests"),
    api("/api/settings")
  ]);
  state.data = { health, dashboard, signals, macro, trades, backtests, settings };
  if (!state.selectedSignalId && signals.signals.length) state.selectedSignalId = signals.signals[0].id;
  updateChrome();
}

function connectRealtime() {
  if (wsClient || wsReconnectTimer) return;
  if (!adminToken()) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const token = adminToken();
  const path = `${apiBase || ""}/ws${token ? `?adminToken=${encodeURIComponent(token)}` : ""}`;
  wsClient = new WebSocket(`${protocol}://${location.host}${path}`);
  wsClient.onmessage = (event) => {
    const message = JSON.parse(event.data || "{}");
    if (message.type === "signal" && state.data.signals) {
      state.data.signals.signals = message.data || [];
      if (state.data.dashboard) state.data.dashboard.activeSignals = message.data || [];
      if (["dashboard", "signals"].includes(state.page)) render();
    }
    if (message.type === "position" && state.data.trades) {
      state.data.trades.positions = message.data || [];
      if (state.data.dashboard) state.data.dashboard.positions = message.data || [];
      if (["dashboard", "trades"].includes(state.page)) render();
    }
    if (message.type === "risk" && state.data.dashboard) {
      state.data.dashboard.risk = message.data || state.data.dashboard.risk;
      if (state.page === "dashboard") render();
    }
  };
  wsClient.onclose = () => {
    wsClient = null;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectRealtime();
    }, 5000);
  };
  wsClient.onerror = () => wsClient?.close();
}

function updateChrome() {
  const health = state.data.health;
  $("#healthBadge").textContent = health?.ok ? "服务正常" : "连接中";
  $("#healthBadge").className = health?.ok ? "status-pill ok" : "status-pill";
  $("#systemDot").className = health?.ok ? "status-dot ok" : "status-dot error";
  $("#tradingState").textContent = health?.trading?.enabled ? "开启" : "关闭";
  $("#runtimeMode").textContent = stageLabel(health?.stage);
  const meta = pages[state.page] || pages.dashboard;
  $("#pageEyebrow").textContent = meta[0];
  $("#pageTitle").textContent = meta[1];
  $$(".nav button").forEach((button) => button.classList.toggle("active", button.dataset.page === state.page));
}

function tickClock() {
  const node = $("#clock");
  if (!node) return;
  node.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  $$(".scan-countdown").forEach((item) => {
    item.textContent = nextScanCountdown();
  });
}

function stageLabel(stage) {
  return {
    "six-module-architecture": "六模块架构",
    "server-ready": "服务器就绪"
  }[stage] || "架构预览";
}

function nextScanCountdown() {
  const interval = 15 * 60 * 1000;
  const left = interval - (Date.now() % interval);
  const totalSeconds = Math.max(0, Math.floor(left / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function sparklineSvg(values = []) {
  const series = values.map(Number).filter((value) => Number.isFinite(value)).slice(-24);
  if (series.length < 2) return "";
  const width = 60;
  const height = 28;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series.map((value, index) => {
    const x = (index / (series.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const delta = series.at(-1) - series[0];
  const color = delta > 0.01 ? "#00FF88" : delta < -0.01 ? "#FF3355" : "#6B7B8D";
  return `
    <svg class="metric-sparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

function metric(label, value, foot = "", className = "", series = [], cardClass = "") {
  return `
    <div class="metric ${cardClass}">
      <div class="metric-body">
        <div class="metric-label">${esc(label)}</div>
        <div class="metric-value number-tick ${className}">${value}</div>
        <div class="metric-foot">${esc(foot)}</div>
      </div>
      ${sparklineSvg(series)}
    </div>
  `;
}

function gradeBadge(grade) {
  return `<span class="grade grade-${esc(grade)}">${esc(grade)}</span>`;
}

function directionClass(direction) {
  if (direction === "LONG") return "positive";
  if (direction === "SHORT") return "negative";
  return "neutral";
}

function directionTagClass(direction) {
  if (direction === "LONG") return "long";
  if (direction === "SHORT") return "short";
  return "";
}

function durationText(position) {
  if (position?.durationLabel) return position.durationLabel;
  const minutes = Number(position?.durationMinutes || 0);
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时${Math.round(minutes % 60)}分钟`;
  return `${Math.floor(minutes / 1440)}天${Math.round((minutes % 1440) / 60)}小时`;
}

function exitReasonLabel(reason) {
  const value = String(reason || "");
  return {
    stop_loss: "止损",
    trailing_stop: "移动止损",
    take_profit: "止盈",
    fakeout_take_profit: "假突破止盈",
    timeout: "超时平仓",
    closed: "已平仓"
  }[value] || value || "已平仓";
}

function okxVerifyLabel(position) {
  if (position.okxVerified === true) return "OKX已校验";
  if (position.okxVerified === false) return "OKX未匹配";
  return "OKX待校验";
}

function isExecutableSignal(signal) {
  return signal?.direction !== "FLAT" && Number.isFinite(Number(signal?.entry));
}

function biasClass(bias) {
  if (bias === "利多") return "positive";
  if (bias === "利空") return "negative";
  return "warning";
}

function matrixLevel(value) {
  const score = Number(value) || 0;
  if (score >= 76) return "matrix-hot";
  if (score >= 51) return "matrix-high";
  if (score >= 26) return "matrix-mid";
  return "matrix-low";
}

function heatColor(value) {
  const t = Math.max(0, Math.min(1, Number(value) / 100));
  return `rgba(0, 240, 255, ${0.08 + t * 0.32})`;
}

function macroGauge(score) {
  const biasScore = Math.max(-10, Math.min(10, Math.round((Number(score) - 50) / 5)));
  const bias = biasScore > 2 ? "利多" : biasScore < -2 ? "利空" : "中性";
  const cx = 120;
  const cy = 116;
  const radius = 82;
  const point = (deg, r = radius) => {
    const rad = (deg * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * r,
      y: cy - Math.sin(rad) * r
    };
  };
  const arc = (start, end) => {
    const a = point(start);
    const b = point(end);
    return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} A${radius} ${radius} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  const needleAngle = 180 - ((biasScore + 10) / 20) * 180;
  const needle = point(needleAngle, 70);
  const headLeft = point(needleAngle + 4, 60);
  const headRight = point(needleAngle - 4, 60);
  const ticks = [-10, -5, 0, 5, 10].map((tick) => {
    const deg = 180 - ((tick + 10) / 20) * 180;
    const outer = point(deg, 90);
    const inner = point(deg, 78);
    const label = point(deg, 62);
    return `
      <line x1="${outer.x.toFixed(1)}" y1="${outer.y.toFixed(1)}" x2="${inner.x.toFixed(1)}" y2="${inner.y.toFixed(1)}" class="gauge-tick" />
      <text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" class="gauge-tick-label" text-anchor="middle">${tick > 0 ? "+" : ""}${tick}</text>
    `;
  }).join("");
  return `
    <svg class="macro-gauge" viewBox="0 0 240 140" role="img" aria-label="宏观罗盘 ${biasScore}">
      <defs>
        <linearGradient id="needleGradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#00F0FF" stop-opacity="0.1" />
          <stop offset="100%" stop-color="#00F0FF" />
        </linearGradient>
      </defs>
      <path d="${arc(180, 120)}" class="gauge-arc gauge-arc-bear" />
      <path d="${arc(120, 60)}" class="gauge-arc gauge-arc-neutral" />
      <path d="${arc(60, 0)}" class="gauge-arc gauge-arc-bull" />
      ${ticks}
      <line x1="${cx}" y1="${cy}" x2="${needle.x.toFixed(1)}" y2="${needle.y.toFixed(1)}" class="gauge-needle" />
      <polygon points="${needle.x.toFixed(1)},${needle.y.toFixed(1)} ${headLeft.x.toFixed(1)},${headLeft.y.toFixed(1)} ${headRight.x.toFixed(1)},${headRight.y.toFixed(1)}" class="gauge-needle-head" />
      <circle cx="${cx}" cy="${cy}" r="6" class="gauge-hub" />
      <text x="${cx}" y="102" text-anchor="middle" class="gauge-score">${biasScore > 0 ? "+" : ""}${biasScore}</text>
      <text x="${cx}" y="132" text-anchor="middle" class="gauge-bias">${bias}</text>
    </svg>
  `;
}

function macroMetric(compass) {
  const biasScore = Math.round((compass.score - 50) / 5);
  const trend = compass.factors.flatMap((factor) => factor.history.slice(-8).map((point) => point.v));
  return `
    <div class="metric card-glass metric-gauge">
      <div class="metric-body">
        <div class="metric-label">宏观偏置</div>
        <div class="metric-value number-tick text-glow-cyan">${compass.score}</div>
        <div class="metric-foot">偏置分 ${biasScore > 0 ? "+" : ""}${biasScore} · ${esc(compass.bias)}</div>
      </div>
      ${macroGauge(compass.score)}
      ${sparklineSvg(trend)}
    </div>
  `;
}

function renderDashboard() {
  const d = state.data.dashboard;
  const trades = state.data.trades || {};
  const position = d.positions[0];
  const risk = d.risk;
  const deviation = trades.deviation || {};
  const decision = d.tradeDecision;
  const executableSignals = d.activeSignals.filter(isExecutableSignal);
  const activeTrend = d.macroCompass.factors[1]?.history?.slice(-24).map((point) => point.v) || [];
  const pnlTrend = position
    ? d.macroCompass.factors[0]?.history?.slice(-24).map((point, index) => point.v + index * (position.pnl >= 0 ? 0.2 : -0.2)) || []
    : Array.from({ length: 24 }, () => 0);
  const riskTrend = Array.from({ length: 24 }, (_, index) => risk.remainingNotionalPct - Math.sin(index / 2.8) * 3);
  const sessionLabel = risk.sessionStatus || (risk.sessionLocked ? "锁仓" : "交易中");
  const deviationLabel = deviation.expectedPnl ? `${fmt(deviation.ratioPct, "%")}` : "待对比";
  return `
    <div class="grid">
      <section class="decision-card span-12 ${decision.action === "NO_TRADE" ? "danger" : decision.action?.startsWith("ALLOW_") ? "go" : "watch"}">
        <div>
          <div class="metric-label">3 秒交易结论</div>
          <div class="decision-title">${esc(decision.label)}</div>
        </div>
        <div class="decision-meta">
          ${gradeBadge(decision.grade)}
          <span class="${directionClass(decision.direction)}">${esc(directionLabel(decision.direction))}</span>
          <strong>${decision.confidence}</strong>
        </div>
        <div class="decision-reasons">
          ${decision.reasons.map((reason) => `<span>${esc(localizeDirectionText(reason))}</span>`).join("")}
        </div>
      </section>
      ${macroMetric(d.macroCompass)}
      ${metric("活跃信号", fmt(executableSignals.length), "S/A/B/C", "", activeTrend)}
      ${metric("持仓浮盈", position ? fmt(position.pnl, " USD") : "0 USD", position ? `${directionLabel(position.direction)} ${position.size} 手` : "无持仓", position ? (position.pnl >= 0 ? "positive flash-up" : "negative flash-down") : "neutral", pnlTrend)}
      ${metric("风控状态", risk.circuitBreaker ? "熔断" : "正常", `剩余额度 ${risk.remainingNotionalPct}%`, risk.circuitBreaker ? "negative flash-down" : "positive flash-up", riskTrend)}

      <section class="panel span-5">
        <div class="panel-head">
          <h2>风控面板</h2>
          <span class="status-pill ${risk.circuitBreaker ? "" : "ok"}">${esc(risk.status || "正常")}</span>
        </div>
        <div class="risk-card-row">
          <div class="risk-card"><span>日内止损</span><strong>${risk.stoppedOutToday}/${risk.maxDailyStops}</strong></div>
          <div class="risk-card"><span>周回撤</span><strong class="${risk.weeklyLossPct > 0 ? "warning" : "positive"}">${fmt(risk.weeklyLossPct, "%")}</strong></div>
          <div class="risk-card"><span>熔断</span><strong class="${risk.circuitBreaker ? "negative" : "positive"}">${risk.circuitBreaker ? "触发" : "正常"}</strong></div>
          <div class="risk-card"><span>时段</span><strong class="${risk.sessionLocked ? "warning" : "positive"}">${esc(sessionLabel)}</strong></div>
        </div>
        <div class="position-line"><span>回测偏离率</span><strong class="${Math.abs(Number(deviation.ratioPct || 0)) > 120 ? "warning" : "blue"}">${deviationLabel}</strong></div>
        <div class="position-line"><span>实际 / 预期 PnL</span><strong>${fmt(deviation.actualPnl || 0, " USD")} / ${fmt(deviation.expectedPnl || 0, " USD")}</strong></div>
      </section>

      <section class="panel span-7">
        <div class="panel-head">
          <h2>账户净值走势</h2>
          <div class="chart-legend" aria-label="净值曲线图例">
            <span><i class="legend-dot legend-pnl"></i>实际净值</span>
            <span><i class="legend-dot legend-xau"></i>回测预期</span>
          </div>
        </div>
        <canvas id="dashboardEquityChart" class="chart"></canvas>
      </section>

      <section class="panel span-7">
        <div class="panel-head">
          <h2>实时 K 线</h2>
          <div class="segmented" data-action="timeframe">
            ${["H1", "H4", "D"].map((tf) => `<button class="${state.timeframe === tf ? "active" : ""}" data-tf="${tf}">${tf}</button>`).join("")}
          </div>
        </div>
        <canvas id="klineChart" class="chart"></canvas>
      </section>

      <section class="panel span-5">
        <h2>宏观罗盘</h2>
        <div class="factor-grid">
          ${d.macroCompass.factors.map((factor) => `
            <div class="factor">
              <div class="factor-top">
                <span class="label">${esc(factor.label)}</span>
                <span class="${biasClass(factor.bias)}">${esc(factor.bias)}</span>
              </div>
              <div class="factor-value">${fmt(factor.value)}${factor.unit === "%" ? "%" : ""}</div>
              <canvas class="mini-chart" data-series='${JSON.stringify(factor.history.map((point) => point.v))}'></canvas>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="panel span-6">
        <h2>信号面板</h2>
        <div class="signal-list">
          ${executableSignals.length ? executableSignals.map((signal) => `
            <div class="signal-row grade-line-${esc(signal.grade)}">
              <div class="signal-main">
                ${gradeBadge(signal.grade)}
                <span class="direction-tag ${signal.direction === "SHORT" ? "short" : signal.direction === "LONG" ? "long" : ""}">${esc(directionLabel(signal.direction))}</span>
                <span class="label">${esc(typeLabel(signal.type))}</span>
                <strong class="number">${fmt(signal.entry)}</strong>
              </div>
              <div class="signal-countdown">
                <span>${signal.expiresInMinutes}m</span>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(8, Math.min(100, signal.expiresInMinutes / 3))}%"></div></div>
              </div>
            </div>
          `).join("") : `<div class="empty-state">等待信号中 · 下次扫描 <span class="scan-countdown">${nextScanCountdown()}</span></div>`}
        </div>
      </section>

      <section class="panel span-3">
        <h2>持仓快照</h2>
        ${position ? `
          <div class="position-line"><span>入场</span><strong>${fmt(position.entry)}</strong></div>
          <div class="position-line"><span>现价</span><strong>${fmt(position.price)}</strong></div>
          <div class="position-line"><span>止损</span><strong class="negative">${fmt(position.stop)}</strong></div>
          <div class="position-line"><span>时长</span><strong>${position.durationMinutes}m</strong></div>
        ` : `<p class="neutral">无持仓</p>`}
      </section>

      <section class="panel span-3">
        <h2>风控细节</h2>
        <div class="position-line"><span>日亏损</span><strong>${risk.dailyLossPct}% / ${risk.dailyLimitPct}%</strong></div>
        <div class="position-line"><span>周限制</span><strong>${risk.weeklyLossPct}% / ${risk.weeklyLimitPct}%</strong></div>
        <div class="position-line"><span>事件熔断</span><strong>${risk.eventCircuitBreaker ? "开启" : "关闭"}</strong></div>
      </section>
    </div>
  `;
}

function typeLabel(type) {
  return {
    range_revert: "斐波回归",
    breakout: "突破",
    fakeout: "斐波假突破",
    momentum: "时段动量",
    support_reversal: "支撑反转",
    structural_breakdown: "结构性崩溃",
    rangeRegression: "斐波回归",
    falseBreakout: "斐波假突破",
    eventDriven: "时段动量",
    "区间回归": "斐波回归",
    "假突破": "斐波假突破",
    "事件驱动": "时段动量"
  }[type] || type;
}

function typeKey(type) {
  return {
    rangeRegression: "range_revert",
    falseBreakout: "fakeout",
    eventDriven: "momentum"
  }[type] || type;
}

function renderMatrix(matrix) {
  const headers = ["斐波回归", "突破", "斐波假突破", "支撑反转", "时段动量", "结构崩溃"];
  return `
    <div class="matrix">
      <div class="matrix-row">
        <div class="matrix-axis"></div>
        ${headers.map((header) => `<div class="matrix-col">${esc(header)}</div>`).join("")}
      </div>
      ${matrix.map((row) => `
        <div class="matrix-row">
          <div class="matrix-axis">${esc(row.row)}</div>
          ${row.cells.map((cell, index) => `
            <div class="matrix-cell ${matrixLevel(cell.value)}">
              <strong>${cell.value}</strong>
              <span>${esc(typeLabel(cell.col || headers[index]))}</span>
            </div>
          `).join("")}
        </div>
      `).join("")}
    </div>
  `;
}

function signalFiltersActive() {
  const f = state.filters;
  return Boolean(f.grades.length || f.directions.length || f.types.length);
}

function signalFilterTags() {
  const tags = [
    { label: "全部", key: "all", active: !signalFiltersActive() },
    { label: "S级", key: "grades", value: "S" },
    { label: "A级", key: "grades", value: "A" },
    { label: "B级", key: "grades", value: "B" },
    { label: "LONG", key: "directions", value: "LONG" },
    { label: "SHORT", key: "directions", value: "SHORT" },
    { label: "斐波回归", key: "types", value: "range_revert" },
    { label: "突破", key: "types", value: "breakout" },
    { label: "斐波假突破", key: "types", value: "fakeout" },
    { label: "支撑反转", key: "types", value: "support_reversal" },
    { label: "结构崩溃", key: "types", value: "structural_breakdown" }
  ];
  return `
    <div class="signal-filter-tags">
      ${tags.map((tag) => {
        const active = tag.key === "all" ? tag.active : state.filters[tag.key].includes(tag.value);
        const attrs = tag.key === "all"
          ? "data-filter-all"
          : `data-filter-chip="${esc(tag.key)}" data-filter-value="${esc(tag.value)}"`;
        return `<button class="filter-chip ${active ? "active" : ""}" ${attrs} type="button">${esc(tag.label)}</button>`;
      }).join("")}
    </div>
  `;
}

function macroSignalLine(signal) {
  const values = Object.values(signal.macro || {}).map(Number).filter((value) => Number.isFinite(value));
  const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 50;
  const delta = Math.round((avg - 50) / 5);
  const bias = delta > 1 ? "利多" : delta < -1 ? "利空" : "中性";
  return `宏观 ${delta > 0 ? "+" : ""}${delta} ${bias}`;
}

function signalCard(signal, selected = false) {
  const hasTrade = Number.isFinite(Number(signal.entry));
  const atr = hasTrade && Number.isFinite(Number(signal.stop)) ? Math.abs(Number(signal.entry) - Number(signal.stop)).toFixed(1) : "待确认";
  const flowOk = signal.flow?.length ? "资金确认 OK" : "资金待确认";
  return `
    <button class="signal-card grade-line-${esc(signal.grade)} ${selected ? "active" : ""}" data-signal="${esc(signal.id)}" type="button">
      <span class="signal-ribbon" aria-hidden="true"></span>
      <span class="signal-card-row signal-card-title">
        <strong>${esc(signal.grade)}级</strong>
        <span class="${directionClass(signal.direction)}">${esc(signal.direction)}</span>
        <span>${esc(typeLabel(signal.type))}</span>
        <span>${esc(countdownLabel(signal.expiresInMinutes))}</span>
      </span>
      <span class="signal-card-row">
        <span>入场 <strong>${hasTrade ? fmt(signal.entry) : "待确认"}</strong></span>
        <span>止损 <strong>${hasTrade ? fmt(signal.stop) : "待确认"}</strong></span>
        <span>ATR <strong>${atr}</strong></span>
      </span>
      <span class="signal-card-row muted-row">
        <span>${esc(macroSignalLine(signal))}</span>
        <span>${esc(flowOk)}</span>
        <span>${esc(signal.title)}</span>
      </span>
    </button>
  `;
}

function signalEmptyState() {
  return `
    <div class="radar-empty">
      <div class="radar-ring">
        <span class="radar-sweep"></span>
        <span class="radar-icon">⏳</span>
      </div>
      <strong class="text-glow-cyan">等待信号触发</strong>
      <span>下次扫描 <span class="scan-countdown">${nextScanCountdown()}</span></span>
    </div>
  `;
}

function renderSignals() {
  const data = state.data.signals;
  const executableSignals = data.signals.filter(isExecutableSignal);
  const filtered = executableSignals.filter((signal) => {
    const f = state.filters;
    return (!f.grades.length || f.grades.includes(signal.grade))
      && (!f.directions.length || f.directions.includes(signal.direction))
      && (!f.types.length || f.types.includes(typeKey(signal.type)))
      && inDateRange(signal.createdAt, f.dateFrom, f.dateTo);
  });
  const selected = filtered.find((signal) => signal.id === state.selectedSignalId) || filtered[0] || null;
  return `
    <div class="grid">
      <section class="panel span-12">
        <div class="toolbar">
          <div class="chip-filter-stack">
            ${signalFilterTags()}
            <div class="filters compact">
              ${dateFilter("dateFrom", "开始日期", state.filters.dateFrom, "signal")}
              ${dateFilter("dateTo", "结束日期", state.filters.dateTo, "signal")}
            </div>
          </div>
          <span class="status-pill">${filtered.length} 条</span>
        </div>
      </section>

      <section class="panel span-7">
        <h2>信号流水</h2>
        <div class="signal-feed">
          ${filtered.length ? filtered.map((signal) => signalCard(signal, selected?.id === signal.id)).join("") : signalEmptyState()}
        </div>
      </section>

      <section class="panel span-5">
        <h2>信号详情</h2>
        ${selected ? renderSignalDetail(selected) : `<div class="empty-state">暂无可执行信号</div>`}
      </section>

      <section class="panel span-7">
        <h2>共振矩阵</h2>
        ${renderMatrix(selected?.matrix || data.matrix)}
      </section>

      <section class="panel span-5">
        <h2>信号统计</h2>
        <div class="stat-list">
          ${data.stats.map((item) => `
            <div class="factor">
              <div class="factor-top"><span>${esc(item.label)}</span><strong>${item.count}</strong></div>
              <div class="factor-value">${item.winRate}%</div>
              <div class="label">平均收益 ${item.avgReturn}%</div>
            </div>
          `).join("")}
        </div>
        <div class="details">
          ${data.typeStats.map((item) => `
            <div class="bar-row">
              <span>${esc(item.type)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(5, item.winRate)}%"></div></div>
              <strong class="${item.pnl >= 0 ? "positive" : "negative"}">${item.pnl}%</strong>
            </div>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderSignalDetail(signal) {
  const targetText = signal.target === null && signal.exitMode === "ma20_h4_trailing" ? "MA20(H4)移动止损" : fmt(signal.target);
  return `
    <div class="row"><span>${gradeBadge(signal.grade)} ${esc(signal.title)}</span><strong>${signal.score}</strong></div>
    <div class="row"><span>触发时间</span><strong>${dateShort(signal.createdAt)}</strong></div>
    <div class="row"><span>方向</span><strong class="${directionClass(signal.direction)}">${esc(directionLabel(signal.direction))}</strong></div>
    <div class="row"><span>入场 / 止损 / 目标</span><strong>${fmt(signal.entry)} / ${fmt(signal.stop)} / ${targetText}</strong></div>
    ${signal.sentinelScore ? `<div class="row"><span>Sentinel 总分</span><strong>${fmt(signal.sentinelScore)}</strong></div>` : ""}
    <div class="detail-grid">
      <div>
        <h3>宏观评分</h3>
        <ul class="list">
          ${Object.entries(signal.macro).map(([key, value]) => `<li>${esc(key.toUpperCase())}: <strong>${value}</strong></li>`).join("")}
        </ul>
      </div>
      <div>
        <h3>技术触发</h3>
        <ul class="list">${signal.technical.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      </div>
      <div>
        <h3>资金确认</h3>
        <ul class="list">${signal.flow.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      </div>
    </div>
  `;
}

function selectFilter(key, label, options, labeler = (value) => value) {
  return `
    <label>${esc(label)}
      <select data-filter="${esc(key)}">
        ${options.map((option) => `<option value="${esc(option)}" ${state.filters[key] === option ? "selected" : ""}>${esc(labeler(option))}</option>`).join("")}
      </select>
    </label>
  `;
}

function chipGroup(key, options) {
  return `
    <div class="chip-row">
      <button class="filter-chip ${state.filters[key].length ? "" : "active"}" data-filter-reset="${esc(key)}" type="button">全部</button>
      ${options.map(([value, label]) => `
        <button class="filter-chip ${state.filters[key].includes(value) ? "active" : ""}" data-filter-chip="${esc(key)}" data-filter-value="${esc(value)}" type="button">${esc(label)}</button>
      `).join("")}
    </div>
  `;
}

function tradeSelectFilter(key, label, options, labeler = (value) => value) {
  return `
    <label>${esc(label)}
      <select data-trade-filter="${esc(key)}">
        ${options.map((option) => `<option value="${esc(option)}" ${state.tradeFilters[key] === option ? "selected" : ""}>${esc(labeler(option))}</option>`).join("")}
      </select>
    </label>
  `;
}

function tradeSortLabel(value) {
  return {
    closedAtDesc: "时间新到旧",
    closedAtAsc: "时间旧到新",
    pnlDesc: "PnL 高到低",
    pnlAsc: "PnL 低到高",
    rDesc: "R 倍数高到低"
  }[value] || value;
}

function dateFilter(key, label, value, group) {
  return `
    <label>${esc(label)}
      <input data-date-filter="${esc(key)}" data-filter-group="${esc(group)}" type="date" value="${esc(value)}">
    </label>
  `;
}

function renderMacro() {
  const data = state.data.macro;
  return `
    <div class="grid">
      <section class="panel span-12">
        <h2>核心指标仪表盘</h2>
        <div class="factor-grid">
          ${data.indicators.map((item) => `
            <div class="factor">
              <div class="factor-top">
                <span>${esc(item.label)}</span>
                <span class="${biasClass(item.bias)}">${esc(item.bias)}</span>
              </div>
              <div class="factor-value">${fmt(item.value)}${item.unit === "%" ? "%" : ""}</div>
              <div class="label">变化 ${item.change > 0 ? "+" : ""}${item.change}${item.unit === "%" ? "%" : ""}</div>
              <canvas class="mini-chart" data-series='${JSON.stringify(item.history.map((point) => point.v))}'></canvas>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="panel span-8">
        <h2>宏观评分历史</h2>
        <canvas id="macroScoreChart" class="chart"></canvas>
      </section>

      <section class="panel span-4">
        <h2>事件日历</h2>
        <div class="details">
          ${data.events.map((event) => `
            <div class="factor ${event.isNext ? "next-event" : ""}">
              <div class="factor-top"><strong>${esc(event.type)}</strong><span class="${event.impact === "high" ? "warning" : "blue"}">${event.isNext ? "下一事件" : esc(event.impact)}</span></div>
              <div>${esc(event.name)}</div>
              <div class="label">${dateShort(event.at)}</div>
              <div class="factor-value">${countdownLabel(event.countdownMinutes)}</div>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="panel span-12">
        <h2>央行购金追踪</h2>
        <div class="heat-grid">
          ${data.centralBankGold.map((item) => `
            <div class="heat-cell" style="background:${heatColor(Math.min(100, item.tonnes / 2.2))}">
              <strong>${esc(item.quarter)}</strong><br>${item.tonnes}t<br><span class="label">${esc(item.direction)}</span>
            </div>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

function tradeTypeStat(data, type) {
  return (data.typeStats || []).find((item) => item.type === type)
    || { type, count: 0, pnl: 0, winRate: 0 };
}

function tradeStatCard(stat) {
  return `
    <div class="trade-stat-card">
      <span>${esc(typeLabel(stat.type))}</span>
      <strong class="${Number(stat.pnl || 0) >= 0 ? "positive" : "negative"}">${fmt(stat.pnl, " USD")}</strong>
      <small>${stat.count}笔 · 胜率 ${fmt(stat.winRate, "%")}</small>
    </div>
  `;
}

function renderPositionCard(position) {
  const pnlClass = Number(position.pnl || 0) >= 0 ? "positive" : "negative";
  const verifyClass = position.okxVerified === true ? "ok" : "";
  return `
    <div class="position-card ${position.direction === "SHORT" ? "short" : "long"}">
      <div class="position-card-head">
        <div>
          <strong>${esc(position.symbol || "XAU-USDT-SWAP")}</strong>
          <span class="label">${esc(typeLabel(position.signalType || position.type || "manual"))}</span>
        </div>
        <div class="position-badges">
          <span class="direction-tag ${directionTagClass(position.direction)}">${esc(directionLabel(position.direction))}</span>
          <span class="status-pill ${verifyClass}">${esc(okxVerifyLabel(position))}</span>
        </div>
      </div>
      <div class="position-value ${pnlClass}">
        ${fmt(position.pnl, " USD")} <span>${fmt(position.pnlPct, "%")}</span>
      </div>
      <div class="position-grid">
        <div><span>入场价</span><strong>${fmt(position.entry)}</strong></div>
        <div><span>当前价</span><strong>${fmt(position.price)}</strong></div>
        <div><span>持仓时长</span><strong>${esc(durationText(position))}</strong></div>
        <div><span>信号</span><strong>${esc(position.signalId || position.signalType || "未绑定")}</strong></div>
      </div>
      ${position.halfProfitLabel ? `<div class="profit-lock">${esc(position.halfProfitLabel)}</div>` : ""}
    </div>
  `;
}

function renderTrades() {
  const data = state.data.trades;
  const tf = state.tradeFilters;
  const account = data.account || {};
  const fakeoutStat = tradeTypeStat(data, "fakeout");
  const breakoutStat = tradeTypeStat(data, "breakout");
  const tradeTypes = ["ALL", ...new Set(data.history.map((trade) => trade.type))];
  const filteredHistory = data.history
    .filter((trade) => (tf.direction === "ALL" || trade.direction === tf.direction)
      && (tf.type === "ALL" || trade.type === tf.type)
      && (tf.grade === "ALL" || trade.signalGrade === tf.grade)
      && inDateRange(trade.closedAt, tf.dateFrom, tf.dateTo))
    .sort((a, b) => {
      if (tf.sort === "pnlDesc") return b.pnl - a.pnl;
      if (tf.sort === "pnlAsc") return a.pnl - b.pnl;
      if (tf.sort === "rDesc") return b.rMultiple - a.rMultiple;
      if (tf.sort === "closedAtAsc") return new Date(a.closedAt) - new Date(b.closedAt);
      return new Date(b.closedAt) - new Date(a.closedAt);
    });
  return `
    <div class="grid">
      ${metric("模拟余额", fmt(account.balance, " USDT"), `初始 ${fmt(account.initialBalance, " USDT")}`)}
      ${metric("可用保证金", fmt(account.availableMargin, " USDT"), `占用 ${fmt(account.usedMargin, " USDT")}`)}
      ${metric("总 PnL", fmt(data.metrics.totalPnl, " USD"), "已平仓", data.metrics.totalPnl >= 0 ? "positive" : "negative")}
      ${metric("胜率", fmt(data.metrics.winRate, "%"), "动态更新")}
      ${metric("盈亏比", fmt(data.metrics.profitFactor), "Profit Factor")}
      ${metric("夏普", fmt(data.metrics.sharpe), `最大回撤 ${data.metrics.maxDrawdown}%`)}

      <section class="panel span-12">
        <div class="panel-head">
          <h2>交易分组统计</h2>
          <span class="status-pill ${data.okxStatus === "ok" ? "ok" : ""}">${data.okxStatus === "ok" ? "OKX持仓已校验" : "OKX持仓待校验"}</span>
        </div>
        <div class="trade-stat-row">
          ${tradeStatCard(fakeoutStat)}
          ${tradeStatCard(breakoutStat)}
          <div class="trade-stat-card">
            <span>全部已平仓</span>
            <strong class="${data.metrics.totalPnl >= 0 ? "positive" : "negative"}">${fmt(data.metrics.totalPnl, " USD")}</strong>
            <small>${data.history.length}笔 · 胜率 ${fmt(data.metrics.winRate, "%")}</small>
          </div>
        </div>
      </section>

      <section class="panel span-5">
        <div class="panel-head">
          <h2>实时持仓</h2>
          <span class="status-pill">5秒自动刷新</span>
        </div>
        ${data.positions.length ? data.positions.map(renderPositionCard).join("") : `<div class="empty-state">当前没有真实持仓</div>`}
        ${data.warnings?.length ? `<p class="warning small-note">${esc(data.warnings.join("；"))}</p>` : ""}
      </section>

      <section class="panel span-7">
        <div class="panel-head">
          <h2>PnL 日线对比</h2>
          <div class="chart-actions">
            <div class="chart-legend" aria-label="收益曲线图例">
              <span><i class="legend-dot legend-pnl"></i>PnL收益（日线）</span>
              <span><i class="legend-dot legend-xau"></i>回测预期</span>
            </div>
            <button id="exportTrades" class="ghost" type="button">导出 CSV</button>
          </div>
        </div>
        <canvas id="pnlChart" class="chart"></canvas>
      </section>

      <section class="panel span-8">
        <div class="panel-head">
          <h2>交易历史</h2>
          <span class="status-pill">${filteredHistory.length}/${data.history.length} 笔</span>
        </div>
        <div class="filters trade-filters">
          ${tradeSelectFilter("direction", "方向", ["ALL", "LONG", "SHORT"], directionLabel)}
          ${tradeSelectFilter("type", "类型", tradeTypes)}
          ${tradeSelectFilter("grade", "信号等级", ["ALL", "S", "A", "B", "C"])}
          ${tradeSelectFilter("sort", "排序", ["closedAtDesc", "closedAtAsc", "pnlDesc", "pnlAsc", "rDesc"], tradeSortLabel)}
          ${dateFilter("dateFrom", "开始日期", tf.dateFrom, "trade")}
          ${dateFilter("dateTo", "结束日期", tf.dateTo, "trade")}
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>信号</th><th>方向</th><th>入场 / 出场价</th><th>PnL</th><th>退出原因</th></tr></thead>
            <tbody>
              ${filteredHistory.length ? filteredHistory.map((trade) => `
                <tr>
                  <td>${dateShort(trade.closedAt)}</td>
                  <td>${gradeBadge(trade.signalGrade)} ${esc(typeLabel(trade.type))}</td>
                  <td class="${directionClass(trade.direction)}">${esc(directionLabel(trade.direction))}</td>
                  <td>${fmt(trade.entry)} / ${fmt(trade.exit)}</td>
                  <td class="${trade.pnl >= 0 ? "positive" : "negative"}">${fmt(trade.pnl)}</td>
                  <td>${esc(exitReasonLabel(trade.exitReason))}</td>
                </tr>
              `).join("") : `<tr><td colspan="6" class="neutral">暂无真实交易记录</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel span-4">
        <h2>归因分析</h2>
        ${data.attribution.length ? data.attribution.map((item) => `
          <div class="bar-row">
            <span>${esc(item.type)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, Math.abs(item.share) * 1.6)}%"></div></div>
            <strong class="${item.pnl >= 0 ? "positive" : "negative"}">${fmt(item.pnl)}</strong>
          </div>
        `).join("") : `<div class="empty-state">暂无归因数据</div>`}
      </section>

      <section class="panel span-6">
        <h2>周度收益热力图</h2>
        <div class="heat-grid">${heatCells(data.weeklyHeatmap, "week")}</div>
      </section>
      <section class="panel span-6">
        <h2>月度收益热力图</h2>
        <div class="heat-grid">${heatCells(data.monthlyHeatmap, "month")}</div>
      </section>
    </div>
  `;
}

function heatCells(rows, key) {
  return rows.map((row) => `
    <div class="heat-cell" style="background:${row.pnlPct >= 0 ? heatColor(54 + row.pnlPct * 12) : "rgba(255,112,112,.24)"}">
      <strong>${esc(row[key])}</strong><br><span class="${row.pnlPct >= 0 ? "positive" : "negative"}">${row.pnlPct}%</span>
    </div>
  `).join("");
}

function paramDiffRows(left, right) {
  const labels = {
    rangeDays: "区间天数",
    atrThreshold: "ATR 阈值",
    positionFactor: "仓位系数",
    macroWeight: "宏观权重",
    technicalWeight: "技术权重",
    flowWeight: "资金权重",
    minSignalLevel: "最低信号等级",
    allowBSignals: "B级入场",
    allowCSignals: "C级入场"
  };
  return Object.keys(labels)
    .filter((key) => left.params[key] !== right.params[key])
    .map((key) => ({
      label: labels[key],
      left: left.params[key],
      right: right.params[key]
    }));
}

function metricDiffRows(left, right) {
  return [
    { key: "annualReturn", label: "年化收益", suffix: "%", higherIsBetter: true },
    { key: "maxDrawdown", label: "最大回撤", suffix: "%", lowerAbsIsBetter: true },
    { key: "winRate", label: "胜率", suffix: "%", higherIsBetter: true },
    { key: "profitFactor", label: "盈亏比", suffix: "", higherIsBetter: true },
    { key: "sharpe", label: "夏普", suffix: "", higherIsBetter: true }
  ].map((row) => ({
    ...row,
    delta: Number((left.metrics[row.key] - right.metrics[row.key]).toFixed(2)),
    improved: row.lowerAbsIsBetter
      ? Math.abs(left.metrics[row.key]) <= Math.abs(right.metrics[row.key])
      : left.metrics[row.key] >= right.metrics[row.key]
  }));
}

function resultMetricClass(key, value) {
  const number = Number(value);
  if (key === "sharpe") {
    if (number > 1) return "metric-good";
    if (number >= 0.5) return "metric-warn";
    if (number >= 0) return "metric-muted";
    return "metric-bad";
  }
  if (key === "maxDrawdown") {
    const drawdown = Math.abs(number);
    if (drawdown <= 5) return "metric-good";
    if (drawdown <= 15) return "metric-warn";
    return "metric-bad";
  }
  return "";
}

function resultMetric(label, value, foot, key, previous) {
  const raw = Number(value);
  const old = Number(previous);
  const hasPrevious = Number.isFinite(raw) && Number.isFinite(old);
  const delta = hasPrevious ? raw - old : 0;
  const improved = key === "maxDrawdown" ? Math.abs(raw) <= Math.abs(old) : delta >= 0;
  const suffix = key === "winRate" || key === "maxDrawdown" ? "%" : "";
  const deltaText = hasPrevious
    ? `${improved ? "↑" : "↓"} ${delta > 0 ? "+" : ""}${delta.toFixed(2)}${suffix}`
    : foot;
  return `
    <div class="metric result-metric ${resultMetricClass(key, value)}">
      <div class="metric-label">${esc(label)}</div>
      <div class="metric-value number-tick">${fmt(value, suffix)}</div>
      <div class="metric-foot metric-change ${hasPrevious ? (improved ? "positive" : "negative") : ""}">${esc(deltaText || foot)}</div>
    </div>
  `;
}

function compareMetricSummary(item) {
  return `
    <div class="compare-metrics">
      <span>年化 <strong>${item.metrics.annualReturn}%</strong></span>
      <span>回撤 <strong>${item.metrics.maxDrawdown}%</strong></span>
      <span>夏普 <strong>${item.metrics.sharpe}</strong></span>
    </div>
  `;
}

function renderExecutionAudit(rows = []) {
  const slippages = rows.map((row) => Number(row.slippagePct || 0)).filter((value) => Number.isFinite(value));
  const avgSlip = slippages.length ? slippages.reduce((sum, value) => sum + Math.abs(value), 0) / slippages.length : 0;
  const maxSlip = slippages.length ? Math.max(...slippages.map((value) => Math.abs(value))) : 0;
  const totalFee = rows.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  return `
    <div class="metric-strip">
      ${metric("平均滑点", fmt(avgSlip, "%"), "最近20笔")}
      ${metric("最大滑点", fmt(maxSlip, "%"), "绝对值")}
      ${metric("手续费", fmt(totalFee, " USDT"), "审计样本")}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>时间</th><th>Trade</th><th>信号价</th><th>成交价</th><th>滑点</th><th>止损单</th><th>手续费</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map((row) => `
            <tr>
              <td>${dateShort(row.createdAt)}</td>
              <td>${esc(row.tradeId || "")}</td>
              <td>${fmt(row.signalEntry)}</td>
              <td>${fmt(row.actualFill)}</td>
              <td class="${Math.abs(Number(row.slippagePct || 0)) > 0.05 ? "warning" : "neutral"}">${fmt(row.slippagePct, "%")}</td>
              <td>${esc(row.stopOrderId || "")}</td>
              <td>${fmt(row.fee, ` ${row.feeAsset || "USDT"}`)}</td>
            </tr>
          `).join("") : `<tr><td colspan="7" class="neutral">暂无执行审计记录</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderBacktests() {
  const catalog = state.data.backtests;
  const result = state.backtestResult || catalog.lastRuns[0];
  const compare = catalog.lastRuns[1];
  if (!result) {
    return `
      <div class="grid">
        <section class="panel span-12">
          <h2>回测结果</h2>
          <div class="empty-state">暂无真实回测记录</div>
        </section>
      </div>
    `;
  }
  const allowBSignals = result.params.allowBSignals ?? true;
  const allowCSignals = result.params.allowCSignals ?? false;
  return `
    <div class="grid">
      <section class="panel span-4">
        <h2>参数配置</h2>
        <form id="backtestForm" class="form-grid">
          <label>开始日期<input name="from" type="date" value="${esc(result.params.from)}"></label>
          <label>结束日期<input name="to" type="date" value="${esc(result.params.to)}"></label>
          <label>区间天数<input name="rangeDays" type="number" min="30" max="1200" value="${result.params.rangeDays}"></label>
          <label>ATR 阈值<input name="atrThreshold" type="number" step="0.01" min="0.5" max="3" value="${result.params.atrThreshold}"></label>
          <label>宏观权重<input name="macroWeight" type="number" step="0.01" min="0" max="1" value="${result.params.macroWeight}"></label>
          <label>技术权重<input name="technicalWeight" type="number" step="0.01" min="0" max="1" value="${result.params.technicalWeight}"></label>
          <label>资金权重<input name="flowWeight" type="number" step="0.01" min="0" max="1" value="${result.params.flowWeight}"></label>
          <label>仓位系数<input name="positionFactor" type="number" step="0.01" min="0.01" max="0.5" value="${result.params.positionFactor}"></label>
          <label>蒙特卡洛次数<input name="monteCarloRuns" type="number" min="20" max="1000" value="${result.monteCarlo.length}"></label>
          ${toggle("allowBSignals", "允许 B 级信号入场（半仓）", allowBSignals)}
          ${toggle("allowCSignals", "允许 C 级信号入场（1/4仓）", allowCSignals)}
          <button class="primary" type="submit">一键回测</button>
        </form>
      </section>

      <section class="panel span-8">
        <h2>结果分析</h2>
        <div class="metric-strip">
          ${resultMetric("夏普比率", result.metrics.sharpe, "Sharpe", "sharpe", compare?.metrics?.sharpe)}
          ${resultMetric("胜率", result.metrics.winRate, `${result.metrics.trades} 笔`, "winRate", compare?.metrics?.winRate)}
          ${resultMetric("盈亏比", result.metrics.profitFactor, "Profit Factor", "profitFactor", compare?.metrics?.profitFactor)}
          ${resultMetric("最大回撤", result.metrics.maxDrawdown, "标注区间", "maxDrawdown", compare?.metrics?.maxDrawdown)}
          ${resultMetric("Calmar", result.metrics.calmar, `期望 ${result.metrics.expectancyR}R`, "calmar", compare?.metrics?.calmar)}
        </div>
        <canvas id="backtestEquityChart" class="chart"></canvas>
        <div class="details">
          <h3>最大回撤区间标注</h3>
          ${result.drawdownWindows.map((window) => `
            <div class="row">
              <span>${esc(window.start)} → ${esc(window.end)}</span>
              <strong class="negative">${window.drawdown}%</strong>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="panel span-6">
        <h2>参数对比</h2>
        <div class="compare-grid">
          ${compare ? `
            <div class="compare-card">
              <span class="metric-label">旧参数</span>
              <h3>${esc(compare.name)}</h3>
              ${compareMetricSummary(compare)}
            </div>
          ` : ""}
          <div class="compare-card active">
            <span class="metric-label">新参数</span>
            <h3>${esc(result.name)}</h3>
            ${compareMetricSummary(result)}
          </div>
        </div>
        <div class="details">
          <h3>改了什么参数</h3>
          ${compare ? paramDiffRows(compare, result).map((row) => `
            <div class="row"><span>${esc(row.label)}</span><strong><span>${esc(row.left)}</span> → <span class="param-diff-tag">${esc(row.right)}</span></strong></div>
          `).join("") : `<div class="empty-state">暂无对比方案</div>`}
          <h3>效果差多少</h3>
          ${compare ? metricDiffRows(result, compare).map((row) => `
            <div class="row"><span>${esc(row.label)}</span><strong class="metric-delta ${row.improved ? "positive" : "negative"}">${row.improved ? "↑" : "↓"} ${row.delta > 0 ? "+" : ""}${row.delta}${esc(row.suffix)}</strong></div>
          `).join("") : `<div class="empty-state">暂无对比数据</div>`}
        </div>
      </section>

      <section class="panel span-6">
        <h2>蒙特卡洛</h2>
        <canvas id="monteCarloChart" class="chart"></canvas>
      </section>

      <section class="panel span-6">
        <h2>月度收益柱状图</h2>
        <canvas id="monthlyReturnsChart" class="chart"></canvas>
      </section>

      <section class="panel span-6">
        <h2>交易分布</h2>
        ${result.tradeDistribution.map((item) => `
          <div class="bar-row">
            <span>${esc(item.bucket)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, item.count * 4)}%"></div></div>
            <strong>${item.count}</strong>
          </div>
        `).join("")}
      </section>
    </div>
  `;
}

function renderSettings() {
  const payload = state.data.settings;
  const settings = payload.settings;
  const deployment = payload.deployment;
  const security = payload.security || {};
  const executionAudit = payload.executionAudit || [];
  return `
    <form id="settingsForm" class="grid">
      <section class="panel span-6">
        <h2>访问控制</h2>
        <div class="form-grid">
          <label>本机管理令牌<input data-admin-token type="password" value="${esc(adminToken())}" placeholder="${security.adminTokenConfigured ? "已启用，填入后可保存配置" : "服务器未配置 XAU_ADMIN_TOKEN"}"></label>
          <button class="primary" type="button" id="saveAdminToken">保存令牌</button>
          <label>写接口保护<input value="${security.protectedWrites ? "已开启" : "未开启"}" disabled></label>
          <label>当前权限<input value="${security.admin ? "管理员" : "只读"}" disabled></label>
        </div>
      </section>

      <section class="panel span-6">
        <h2>API 配置</h2>
        <div class="form-grid">
          <label>OANDA 账户<input name="api.oandaAccountId" value="${esc(settings.api.oandaAccountId)}" placeholder="未配置"></label>
          <label>数据源<select name="api.dataMode">
            ${[["mock", "Mock"], ["real", "真实"]].map(([value, label]) => `<option value="${value}" ${settings.api.dataMode === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <label>行情提供商<select name="api.dataProvider">
            ${[["okx", "OKX 实时"], ["oanda", "OANDA 历史"], ["mock", "Mock"], ["mt5", "MT5"], ["ib", "IB"]].map(([value, label]) => `<option value="${value}" ${settings.api.dataProvider === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <label>回测数据<select name="api.backtestProvider">
            ${[["oanda", "OANDA 历史K线"], ["mock", "Mock"]].map(([value, label]) => `<option value="${value}" ${settings.api.backtestProvider === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <label>交易接口<select name="api.broker">
            ${[["disabled", "禁用"], ["okx", "OKX"], ["oanda", "OANDA"], ["mt5", "MT5"], ["ib", "IB"]].map(([value, label]) => `<option value="${value}" ${settings.api.broker === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <label>交易模式<select name="api.tradeMode">
            ${[["demo", "模拟"], ["live", "实盘"]].map(([value, label]) => `<option value="${value}" ${settings.api.tradeMode === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          ${toggle("api.oandaTokenConfigured", "OANDA Key 已放入服务器", settings.api.oandaTokenConfigured)}
          ${toggle("api.okxTradingConfigured", "OKX 交易 Key 已放入服务器", settings.api.okxTradingConfigured)}
          <label>模拟账户初始余额 USDT<input name="paper.initialBalanceUsdt" type="number" step="1" min="0" value="${settings.paper?.initialBalanceUsdt ?? 10000}"></label>
        </div>
      </section>

      <section class="panel span-6">
        <h2>交易 Daemon</h2>
        <div class="form-grid">
          ${toggle("daemon.enabled", "启用自动扫描", settings.daemon?.enabled ?? true)}
          ${toggle("daemon.autoExecute", "自动执行下单", settings.daemon?.autoExecute ?? false)}
          ${toggle("daemon.useFixedOrderSize", "使用固定下单手数", settings.daemon?.useFixedOrderSize ?? false)}
          <label>扫描间隔（分钟）<input name="daemon.scanIntervalMinutes" type="number" step="1" min="1" value="${settings.daemon?.scanIntervalMinutes ?? 5}"></label>
          <label>固定手数<input name="daemon.orderSize" type="number" step="0.01" min="0.01" value="${settings.daemon?.orderSize ?? 0.01}"></label>
          <label>最小下单单位<input name="daemon.minOrderSize" type="number" step="0.01" min="0.01" value="${settings.daemon?.minOrderSize ?? 0.01}"></label>
          <label>PnL/合约乘数<input name="daemon.pnlMultiplier" type="number" step="1" min="1" value="${settings.daemon?.pnlMultiplier ?? 100}"></label>
          ${toggle("daemon.eventCalendar.enabled", "自动经济日历", settings.daemon?.eventCalendar?.enabled ?? true)}
          ${toggle("daemon.eventCalendar.sources.fomc", "FOMC 熔断", settings.daemon?.eventCalendar?.sources?.fomc ?? true)}
          ${toggle("daemon.eventCalendar.sources.nfp", "NFP 熔断", settings.daemon?.eventCalendar?.sources?.nfp ?? true)}
          <label>事件前保护分钟<input name="daemon.eventCalendar.beforeMinutes" type="number" step="1" min="0" value="${settings.daemon?.eventCalendar?.beforeMinutes ?? 30}"></label>
          <label>事件后保护分钟<input name="daemon.eventCalendar.afterMinutes" type="number" step="1" min="0" value="${settings.daemon?.eventCalendar?.afterMinutes ?? 30}"></label>
          <label>日历刷新小时<input name="daemon.eventCalendar.refreshIntervalHours" type="number" step="1" min="1" value="${settings.daemon?.eventCalendar?.refreshIntervalHours ?? 12}"></label>
        </div>
      </section>

      <section class="panel span-6">
        <h2>飞书告警</h2>
        <div class="form-grid">
          ${toggle("notifications.feishu.enabled", "启用飞书机器人", settings.notifications?.feishu?.enabled ?? false)}
          <label>Webhook URL<input name="notifications.feishu.webhookUrl" value="${esc(settings.notifications?.feishu?.webhookUrl || "")}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."></label>
        </div>
      </section>

      <section class="panel span-12">
        <h2>执行审计</h2>
        ${renderExecutionAudit(executionAudit)}
      </section>

      <section class="panel span-6">
        <h2>风险参数</h2>
        <div class="form-grid">
          <label>单笔基础风险 %<input name="risk.perTradeRiskPct" type="number" step="0.1" value="${settings.risk.perTradeRiskPct}"></label>
          <label>单笔仓位上限 %<input name="risk.maxPositionPct" type="number" step="0.1" value="${settings.risk.maxPositionPct}"></label>
          <label>ATR 止损倍率<input name="risk.atrStopMultiplier" type="number" step="0.1" value="${settings.risk.atrStopMultiplier}"></label>
          <label>固定 ATR 止损<input name="risk.fixedStopAtrMultiplier" type="number" step="0.1" value="${settings.risk.fixedStopAtrMultiplier ?? 1.5}"></label>
          ${toggle("risk.dynamicATRStop", "动态 ATR 止损", settings.risk.dynamicATRStop)}
          <label>高波动止损<input name="risk.dynamicStopHigh" type="number" step="0.1" value="${settings.risk.dynamicStopHigh ?? 2.0}"></label>
          <label>正常波动止损<input name="risk.dynamicStopMedium" type="number" step="0.1" value="${settings.risk.dynamicStopMedium ?? 1.5}"></label>
          <label>低波动止损<input name="risk.dynamicStopLow" type="number" step="0.1" value="${settings.risk.dynamicStopLow ?? 1.2}"></label>
          ${toggle("risk.adaptiveLeverage", "自适应杠杆", settings.risk.adaptiveLeverage)}
          <label>S级风险倍率<input name="risk.signalRiskMultipliers.S" type="number" step="0.1" value="${settings.risk.signalRiskMultipliers?.S ?? 2.5}"></label>
          <label>A级风险倍率<input name="risk.signalRiskMultipliers.A" type="number" step="0.1" value="${settings.risk.signalRiskMultipliers?.A ?? 1.5}"></label>
          <label>B级风险倍率<input name="risk.signalRiskMultipliers.B" type="number" step="0.1" value="${settings.risk.signalRiskMultipliers?.B ?? 1.0}"></label>
          <label>低波动风险倍率<input name="risk.volatilityRiskMultipliers.low" type="number" step="0.1" value="${settings.risk.volatilityRiskMultipliers?.low ?? 1.3}"></label>
          <label>正常波动风险倍率<input name="risk.volatilityRiskMultipliers.medium" type="number" step="0.1" value="${settings.risk.volatilityRiskMultipliers?.medium ?? 1.0}"></label>
          <label>高波动风险倍率<input name="risk.volatilityRiskMultipliers.high" type="number" step="0.1" value="${settings.risk.volatilityRiskMultipliers?.high ?? 0.5}"></label>
          <label>最大单笔风险 %<input name="risk.maxSingleTradeRiskPct" type="number" step="0.1" value="${settings.risk.maxSingleTradeRiskPct ?? 8}"></label>
          <label>最大等效杠杆<input name="risk.maxEffectiveLeverage" type="number" step="0.1" value="${settings.risk.maxEffectiveLeverage ?? 4}"></label>
          <label>盈利放大阈值1 %<input name="risk.profitAmplifiers.tier1Pct" type="number" step="0.1" value="${settings.risk.profitAmplifiers?.tier1Pct ?? 5}"></label>
          <label>盈利放大倍率1<input name="risk.profitAmplifiers.tier1" type="number" step="0.1" value="${settings.risk.profitAmplifiers?.tier1 ?? 1.5}"></label>
          <label>盈利放大阈值2 %<input name="risk.profitAmplifiers.tier2Pct" type="number" step="0.1" value="${settings.risk.profitAmplifiers?.tier2Pct ?? 10}"></label>
          <label>盈利放大倍率2<input name="risk.profitAmplifiers.tier2" type="number" step="0.1" value="${settings.risk.profitAmplifiers?.tier2 ?? 2.0}"></label>
          <label>盈利放大阈值3 %<input name="risk.profitAmplifiers.tier3Pct" type="number" step="0.1" value="${settings.risk.profitAmplifiers?.tier3Pct ?? 20}"></label>
          <label>盈利放大倍率3<input name="risk.profitAmplifiers.tier3" type="number" step="0.1" value="${settings.risk.profitAmplifiers?.tier3 ?? 2.5}"></label>
          <label>周回撤降风险 %<input name="risk.weeklyDrawdownReducePct" type="number" step="0.1" value="${settings.risk.weeklyDrawdownReducePct ?? 10}"></label>
          <label>周回撤暂停 %<input name="risk.weeklyDrawdownPausePct" type="number" step="0.1" value="${settings.risk.weeklyDrawdownPausePct ?? 15}"></label>
          <label>降后基础风险 %<input name="risk.weeklyDrawdownReducedRiskPct" type="number" step="0.1" value="${settings.risk.weeklyDrawdownReducedRiskPct ?? 1}"></label>
          <label>支撑反转最长H1<input name="risk.supportReversalMaxHoldBars" type="number" step="1" value="${settings.risk.supportReversalMaxHoldBars ?? 48}"></label>
          <label>支撑反转失败K数<input name="risk.supportReversalFailureBars" type="number" step="1" value="${settings.risk.supportReversalFailureBars ?? 3}"></label>
          <label>失败缓冲ATR<input name="risk.supportReversalFailureAtr" type="number" step="0.1" value="${settings.risk.supportReversalFailureAtr ?? 0.2}"></label>
          <label>1R超时K数<input name="risk.supportReversalOneRTimeoutBars" type="number" step="1" value="${settings.risk.supportReversalOneRTimeoutBars ?? 24}"></label>
          <label>TP1 R倍数<input name="risk.supportReversalTp1R" type="number" step="0.1" value="${settings.risk.supportReversalTp1R ?? 1.5}"></label>
          <label>结构崩溃仓位系数<input name="risk.structuralBreakdownPositionFactor" type="number" step="0.05" min="0.05" max="1" value="${settings.risk.structuralBreakdownPositionFactor ?? 0.5}"></label>
          <label>日熔断 %<input name="risk.dailyCircuitLossPct" type="number" step="0.1" value="${settings.risk.dailyCircuitLossPct}"></label>
          <label>周熔断 %<input name="risk.weeklyCircuitLossPct" type="number" step="0.1" value="${settings.risk.weeklyCircuitLossPct}"></label>
          <label>今日最大止损次数<input name="risk.maxDailyStops" type="number" value="${settings.risk.maxDailyStops}"></label>
          ${toggle("risk.eventCircuitBreaker", "事件熔断", settings.risk.eventCircuitBreaker)}
        </div>
      </section>

      <section class="panel span-6">
        <h2>策略参数</h2>
        <div class="form-grid">
          <label>宏观权重<input name="strategy.weights.macro" type="number" step="0.01" value="${settings.strategy.weights.macro}"></label>
          <label>技术权重<input name="strategy.weights.technical" type="number" step="0.01" value="${settings.strategy.weights.technical}"></label>
          <label>资金权重<input name="strategy.weights.flow" type="number" step="0.01" value="${settings.strategy.weights.flow}"></label>
          <label>S 阈值<input name="strategy.thresholds.S" type="number" value="${settings.strategy.thresholds.S}"></label>
          <label>A 阈值<input name="strategy.thresholds.A" type="number" value="${settings.strategy.thresholds.A}"></label>
          <label>B 阈值<input name="strategy.thresholds.B" type="number" value="${settings.strategy.thresholds.B}"></label>
          ${toggle("strategy.enabledSignalTypes.range_revert", "斐波回归", settings.strategy.enabledSignalTypes.range_revert)}
          ${toggle("strategy.enabledSignalTypes.breakout", "突破", settings.strategy.enabledSignalTypes.breakout)}
          ${toggle("strategy.enabledSignalTypes.fakeout", "斐波假突破", settings.strategy.enabledSignalTypes.fakeout)}
          ${toggle("strategy.enabledSignalTypes.momentum", "时段动量", settings.strategy.enabledSignalTypes.momentum)}
          ${toggle("strategy.enabledSignalTypes.support_reversal", "支撑反转", settings.strategy.enabledSignalTypes.support_reversal)}
          ${toggle("strategy.enabledSignalTypes.structural_breakdown", "结构性崩溃", settings.strategy.enabledSignalTypes.structural_breakdown)}
          ${toggle("strategy.exitRules.newExitRules", "新B退出框架", settings.strategy.exitRules?.newExitRules ?? false)}
          ${toggle("strategy.exitRules.fakeoutPartialTP", "假突破半仓止盈", settings.strategy.exitRules?.fakeoutPartialTP ?? false)}
          <label>假突破TP1 R倍数<input name="strategy.exitRules.fakeoutTp1R" type="number" step="0.1" value="${settings.strategy.exitRules?.fakeoutTp1R ?? 1.5}"></label>
          <label>假突破移动均线(H4)<input name="strategy.exitRules.fakeoutTrailingMaPeriod" type="number" step="1" min="1" value="${settings.strategy.exitRules?.fakeoutTrailingMaPeriod ?? 10}"></label>
          ${toggle("strategy.exitRules.legacyBreakoutExit", "突破统一退出", settings.strategy.exitRules?.legacyBreakoutExit ?? false)}
          ${toggle("strategy.structuralBreakdown.useFundingData", "结构崩溃资金层", settings.strategy.structuralBreakdown?.useFundingData ?? false)}
          <label>结构崩溃A级阈值<input name="strategy.structuralBreakdown.thresholdA" type="number" step="1" value="${settings.strategy.structuralBreakdown?.thresholdA ?? 30}"></label>
          <label>结构崩溃S级阈值<input name="strategy.structuralBreakdown.thresholdS" type="number" step="1" value="${settings.strategy.structuralBreakdown?.thresholdS ?? 40}"></label>
          <label>UTC开始小时<input name="strategy.structuralBreakdown.allowedUtcStart" type="number" step="1" min="0" max="23" value="${settings.strategy.structuralBreakdown?.allowedUtcStart ?? 8}"></label>
          <label>UTC结束小时<input name="strategy.structuralBreakdown.allowedUtcEnd" type="number" step="1" min="0" max="23" value="${settings.strategy.structuralBreakdown?.allowedUtcEnd ?? 17}"></label>
          <label>大单BTC等值<input name="strategy.structuralBreakdown.largeOrderBtcEquivalent" type="number" step="0.1" min="0.1" value="${settings.strategy.structuralBreakdown?.largeOrderBtcEquivalent ?? 1}"></label>
          <label>支撑反转入场<select name="strategy.supportReversal.entry">
            ${[["retest", "回踩确认"], ["direct", "突破直接"]].map(([value, label]) => `<option value="${value}" ${settings.strategy.supportReversal?.entry === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <label>Pivot左右K<input name="strategy.supportReversal.pivotBars" type="number" step="1" min="2" max="6" value="${settings.strategy.supportReversal?.pivotBars ?? 3}"></label>
          ${toggle("strategy.supportReversal.slowFilter", "慢跌/慢涨过滤", settings.strategy.supportReversal?.slowFilter ?? true)}
          ${toggle("strategy.enhancements.bollingerRegimeFilter", "布林带波动择时", settings.strategy.enhancements?.bollingerRegimeFilter)}
          ${toggle("strategy.enhancements.previousDayLevelBoost", "前日高低增强", settings.strategy.enhancements?.previousDayLevelBoost)}
          ${toggle("strategy.enhancements.rsiDivergenceBoost", "RSI 假突破确认", settings.strategy.enhancements?.rsiDivergenceBoost)}
          ${toggle("strategy.enhancements.londonOpenDirectionFilter", "伦敦开盘过滤", settings.strategy.enhancements?.londonOpenDirectionFilter)}
        </div>
      </section>

      <section class="panel span-6">
        <h2>时段与部署</h2>
        <div class="form-grid">
          ${toggle("strategy.defaultSession.asia", "亚洲段", settings.strategy.defaultSession.asia)}
          ${toggle("strategy.defaultSession.london", "伦敦段", settings.strategy.defaultSession.london)}
          ${toggle("strategy.defaultSession.newYork", "纽约段", settings.strategy.defaultSession.newYork)}
        </div>
        <div class="details">
          <div class="row"><span>系统版本</span><strong>${esc(deployment.version)}</strong></div>
          <div class="row"><span>运行时长</span><strong>${deployment.uptimeSeconds}s</strong></div>
          <div class="row"><span>数据延迟</span><strong>${deployment.dataLatencySeconds}s</strong></div>
          <div class="row"><span>页面入口</span><strong>${esc(deployment.routeBase)}</strong></div>
        </div>
      </section>

      <section class="panel span-12">
        <div class="panel-head">
          <h2>日志查看</h2>
          <button class="primary" type="submit">保存配置</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>等级</th><th>消息</th></tr></thead>
            <tbody>
              ${payload.logs.map((item) => `<tr><td>${dateShort(item.at)}</td><td>${esc(item.level)}</td><td>${esc(item.message)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </form>
  `;
}

function toggle(name, label, checked) {
  return `
    <label class="toggle-line">
      <span>${esc(label)}</span>
      <input name="${esc(name)}" type="checkbox" ${checked ? "checked" : ""}>
    </label>
  `;
}

function setNested(target, path, value) {
  const keys = path.split(".");
  let cursor = target;
  keys.slice(0, -1).forEach((key) => {
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  });
  cursor[keys.at(-1)] = value;
}

function formToObject(form) {
  const out = {};
  Array.from(new FormData(form).entries()).forEach(([name, value]) => {
    const input = form.elements[name];
    let parsed = value;
    if (input?.type === "number") parsed = Number(value);
    if (input?.type === "checkbox") parsed = input.checked;
    setNested(out, name, parsed);
  });
  Array.from(form.querySelectorAll('input[type="checkbox"]')).forEach((input) => {
    if (!input.checked) setNested(out, input.name, false);
  });
  return out;
}

function render() {
  updateChrome();
  const view = $("#view");
  if (!state.data.health) {
    view.innerHTML = `<section class="panel"><h2>加载中</h2></section>`;
    return;
  }
  view.innerHTML = {
    dashboard: renderDashboard,
    signals: renderSignals,
    macro: renderMacro,
    trades: renderTrades,
    backtests: renderBacktests,
    settings: renderSettings
  }[state.page]();
  bindPageEvents();
  drawCharts();
  syncParticleBackground();
  syncTradeRefresh();
}

async function refreshOpenTrades() {
  if (tradeRefreshInFlight || state.page !== "trades") return;
  tradeRefreshInFlight = true;
  try {
    const fresh = await api("/api/trades?status=open");
    const current = state.data.trades || {};
    state.data.trades = {
      ...current,
      ...fresh,
      history: current.history || [],
      attribution: fresh.attribution || current.attribution || [],
      typeStats: fresh.typeStats || current.typeStats || []
    };
    render();
  } catch (error) {
    console.warn("trade refresh failed", error);
  } finally {
    tradeRefreshInFlight = false;
  }
}

function syncTradeRefresh() {
  if (state.page === "trades" && !tradeRefreshTimer) {
    tradeRefreshTimer = setInterval(refreshOpenTrades, 5000);
    return;
  }
  if (state.page !== "trades" && tradeRefreshTimer) {
    clearInterval(tradeRefreshTimer);
    tradeRefreshTimer = null;
  }
}

function bindPageEvents() {
  $$("[data-tf]").forEach((button) => button.addEventListener("click", async () => {
    state.timeframe = button.dataset.tf;
    state.data.dashboard = await api(`/api/dashboard?timeframe=${state.timeframe}`);
    render();
  }));
  $$("[data-filter]").forEach((select) => select.addEventListener("change", () => {
    state.filters[select.dataset.filter] = select.value;
    render();
  }));
  $$("[data-filter-chip]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.filterChip;
    const value = button.dataset.filterValue;
    const current = new Set(state.filters[key]);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    state.filters[key] = Array.from(current);
    render();
  }));
  $$("[data-filter-all]").forEach((button) => button.addEventListener("click", () => {
    state.filters.grades = [];
    state.filters.directions = [];
    state.filters.types = [];
    render();
  }));
  $$("[data-filter-reset]").forEach((button) => button.addEventListener("click", () => {
    state.filters[button.dataset.filterReset] = [];
    render();
  }));
  $$("[data-date-filter]").forEach((input) => input.addEventListener("change", () => {
    const group = input.dataset.filterGroup;
    if (group === "trade") {
      state.tradeFilters[input.dataset.dateFilter] = input.value;
    } else {
      state.filters[input.dataset.dateFilter] = input.value;
    }
    render();
  }));
  $$("[data-trade-filter]").forEach((select) => select.addEventListener("change", () => {
    state.tradeFilters[select.dataset.tradeFilter] = select.value;
    render();
  }));
  $$("[data-signal]").forEach((button) => button.addEventListener("click", () => {
    state.selectedSignalId = button.dataset.signal;
    render();
  }));
  $("#exportTrades")?.addEventListener("click", () => {
    exportTradesCsv().catch((error) => toast(error.message));
  });
  $("#backtestForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.backtestResult = await api("/api/backtests/run", {
        method: "POST",
        body: JSON.stringify(formToObject(event.currentTarget))
      });
      toast("回测完成");
      render();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#settingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(formToObject(event.currentTarget))
      });
      state.data.settings.settings = result.settings;
      toast("配置已保存");
      render();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#saveAdminToken")?.addEventListener("click", () => {
    setAdminToken($("[data-admin-token]")?.value || "");
    if (wsClient) wsClient.close();
    toast("管理令牌已保存到本机");
    loadData().then(render).catch((error) => toast(error.message));
  });
}

async function exportTradesCsv() {
  const token = adminToken();
  const response = await fetch(`${apiBase}/api/export/trades.csv`, {
    cache: "no-store",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || "导出失败");
  }
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "xau-trades.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
}

function drawCharts() {
  const dashboard = state.data.dashboard;
  const macro = state.data.macro;
  const trades = state.data.trades;
  const backtests = state.data.backtests;
  drawCandles($("#klineChart"), dashboard?.kline);
  $$(".mini-chart").forEach((canvas) => {
    const series = JSON.parse(canvas.dataset.series || "[]");
    drawLine(canvas, series, { compact: true });
  });
  drawLine($("#macroScoreChart"), macro?.scoreHistory?.map((point) => point.v), { fill: true });
  drawPnlComparison($("#pnlChart"), trades?.pnlCurve, trades?.expectedCurve || trades?.goldCurve);
  drawPnlComparison($("#dashboardEquityChart"), trades?.pnlCurve, trades?.expectedCurve || trades?.goldCurve);
  const result = state.backtestResult || backtests?.lastRuns?.[0];
  drawLine($("#backtestEquityChart"), result?.equity?.map((point) => point.v), { fill: true });
  drawBars($("#monteCarloChart"), result?.monteCarlo?.slice(0, 80).map((point) => point.terminalReturn));
  drawBars($("#monthlyReturnsChart"), result?.monthlyReturns?.map((point) => point.value));
}

function setupCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  return { ctx, w: rect.width, h: rect.height };
}

function normalizePctSeries(points = []) {
  const values = points.map((point) => Number(point?.v)).filter((value) => Number.isFinite(value));
  if (!values.length) return [];
  const first = values.find((value) => value !== 0) || values[0] || 1;
  return values.map((value) => ((value - first) / Math.abs(first || 1)) * 100);
}

function drawSeriesPath(ctx, values, { w, h, pad, min, span, color, width = 2, dash = [], fill = false }) {
  if (!values.length) return;
  const points = values.map((value, index) => ({
    x: pad + (index * (w - pad * 2)) / Math.max(1, values.length - 1),
    y: h - pad - ((value - min) / span) * (h - pad * 2)
  }));
  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.setLineDash([]);
  if (fill) {
    ctx.lineTo(points.at(-1).x, h - pad);
    ctx.lineTo(points[0].x, h - pad);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.restore();
}

function drawPnlComparison(canvas, pnlCurve = [], goldCurve = []) {
  const env = setupCanvas(canvas);
  if (!env) return;
  const { ctx, w, h } = env;
  const pad = 24;
  const pnlValues = normalizePctSeries(pnlCurve);
  const goldValues = normalizePctSeries(goldCurve);
  const allValues = [...pnlValues, ...goldValues];
  if (!allValues.length) return;
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 0);
  const span = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + (i * (h - pad * 2)) / 3;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  const zeroY = h - pad - ((0 - min) / span) * (h - pad * 2);
  ctx.strokeStyle = "rgba(107,123,141,.22)";
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(pad, zeroY);
  ctx.lineTo(w - pad, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);
  drawSeriesPath(ctx, goldValues, {
    w,
    h,
    pad,
    min,
    span,
    color: "#ffb800",
    width: 2,
    dash: [6, 4],
    fill: "rgba(255,184,0,.07)"
  });
  drawSeriesPath(ctx, pnlValues, {
    w,
    h,
    pad,
    min,
    span,
    color: "#00f0ff",
    width: 2.4,
    fill: "rgba(0,240,255,.08)"
  });
  ctx.fillStyle = "rgba(107,123,141,.9)";
  ctx.font = "11px sans-serif";
  ctx.fillText(`${max.toFixed(1)}%`, pad, pad - 7);
  ctx.fillText(`${min.toFixed(1)}%`, pad, h - 7);
}

function drawLine(canvas, values = [], opts = {}) {
  const env = setupCanvas(canvas);
  if (!env || !values?.length) return;
  const { ctx, w, h } = env;
  const pad = opts.compact ? 3 : 20;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;
  if (!opts.compact) {
    for (let i = 0; i < 4; i += 1) {
      const y = pad + (i * (h - pad * 2)) / 3;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }
  }
  const points = values.map((value, index) => ({
    x: pad + (index * (w - pad * 2)) / Math.max(1, values.length - 1),
    y: h - pad - ((value - min) / span) * (h - pad * 2)
  }));
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.strokeStyle = opts.compact ? "#ffb800" : "#00f0ff";
  ctx.lineWidth = opts.compact ? 1.5 : 2;
  ctx.stroke();
  if (opts.fill) {
    ctx.lineTo(w - pad, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,240,255,.10)";
    ctx.fill();
  }
}

function drawBars(canvas, values = []) {
  const env = setupCanvas(canvas);
  if (!env || !values?.length) return;
  const { ctx, w, h } = env;
  const pad = 20;
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);
  const zero = h / 2;
  const barW = (w - pad * 2) / values.length;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.beginPath();
  ctx.moveTo(pad, zero);
  ctx.lineTo(w - pad, zero);
  ctx.stroke();
  values.forEach((value, index) => {
    const x = pad + index * barW + 1;
    const height = (Math.abs(value) / maxAbs) * (h / 2 - pad);
    ctx.fillStyle = value >= 0 ? "rgba(0,255,136,.75)" : "rgba(255,51,85,.75)";
    ctx.fillRect(x, value >= 0 ? zero - height : zero, Math.max(2, barW - 2), height);
  });
}

function drawCandles(canvas, kline) {
  const env = setupCanvas(canvas);
  if (!env || !kline?.candles?.length) return;
  const { ctx, w, h } = env;
  const candles = kline.candles.slice(-70);
  const pad = 28;
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);
  const signalPrices = kline.signalEntries?.map((item) => item.price).filter(Boolean) || [];
  const max = Math.max(...highs, ...kline.keyLevels.map((item) => item.price), ...signalPrices);
  const min = Math.min(...lows, ...kline.keyLevels.map((item) => item.price), ...signalPrices);
  const span = max - min || 1;
  const xStep = (w - pad * 2) / candles.length;
  const y = (price) => h - pad - ((price - min) / span) * (h - pad * 2);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const gy = pad + (i * (h - pad * 2)) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(w - pad, gy);
    ctx.stroke();
  }
  candles.forEach((candle, index) => {
    const x = pad + index * xStep + xStep / 2;
    const up = candle.close >= candle.open;
    ctx.strokeStyle = up ? "#00ff88" : "#ff3355";
    ctx.fillStyle = up ? "rgba(0,255,136,.85)" : "rgba(255,51,85,.85)";
    ctx.beginPath();
    ctx.moveTo(x, y(candle.high));
    ctx.lineTo(x, y(candle.low));
    ctx.stroke();
    const bodyY = Math.min(y(candle.open), y(candle.close));
    const bodyH = Math.max(2, Math.abs(y(candle.open) - y(candle.close)));
    ctx.fillRect(x - xStep * 0.28, bodyY, Math.max(3, xStep * 0.56), bodyH);
  });
  ctx.font = "12px sans-serif";
  kline.keyLevels.forEach((level) => {
    const ly = y(level.price);
    ctx.strokeStyle = "rgba(255,184,0,.45)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(pad, ly);
    ctx.lineTo(w - pad, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffb800";
    ctx.fillText(`${level.label} ${level.price}`, pad + 4, ly - 4);
  });
  canvas.title = (kline.signalEntries || [])
    .map((entry) => `${entry.grade}级 ${entry.direction} ${typeLabel(entry.type)} @${entry.price}`)
    .join("\n");
  (kline.signalEntries || []).forEach((entry, index) => {
    const candleIndex = Math.max(4, Math.min(candles.length - 5, candles.length - 16 + index * 5));
    const x = pad + candleIndex * xStep + xStep / 2;
    const baseY = y(entry.price);
    const isLong = entry.direction === "LONG";
    const ey = baseY + (isLong ? 14 : -14);
    ctx.fillStyle = isLong ? "#00ff88" : "#ff3355";
    ctx.strokeStyle = "rgba(12,16,22,.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (isLong) {
      ctx.moveTo(x, ey - 8);
      ctx.lineTo(x - 8, ey + 6);
      ctx.lineTo(x + 8, ey + 6);
    } else {
      ctx.moveTo(x, ey + 8);
      ctx.lineTo(x - 8, ey - 6);
      ctx.lineTo(x + 8, ey - 6);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.fillStyle = "rgba(232,236,241,.9)";
    ctx.font = "10px sans-serif";
    ctx.fillText(`${entry.grade}`, x + 10, ey + 4);
  });
}

async function boot() {
  try {
    await loadData();
    render();
    connectRealtime();
  } catch (error) {
    $("#view").innerHTML = `<section class="panel"><h2>服务异常</h2><p class="negative">${esc(error.message)}</p></section>`;
  }
}

$$(".nav button").forEach((button) => button.addEventListener("click", () => {
  state.page = button.dataset.page;
  location.hash = state.page;
  render();
}));

$("#refreshButton").addEventListener("click", async () => {
  await loadData();
  render();
  toast("已刷新");
});

window.addEventListener("resize", () => drawCharts());
window.addEventListener("resize", () => syncParticleBackground());
window.addEventListener("hashchange", () => {
  state.page = location.hash.replace("#", "") || "dashboard";
  render();
});

function syncParticleBackground() {
  const canvas = $("#particleCanvas");
  if (!canvas) return;
  const shouldRun = state.page === "dashboard" && window.innerWidth >= 768 && !document.hidden;
  canvas.classList.toggle("active", shouldRun);
  if (shouldRun && !particleFrame) startParticles(canvas);
  if (!shouldRun && particleFrame) {
    cancelAnimationFrame(particleFrame);
    particleFrame = null;
  }
}

function startParticles(canvas) {
  const ctx = canvas.getContext("2d");
  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  if (!particles.length) {
    particles = Array.from({ length: 48 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: 1 + Math.random(),
      vx: -0.12 + Math.random() * 0.24,
      vy: -0.18 - Math.random() * 0.2
    }));
  }
  const animate = () => {
    resize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,240,255,0.28)";
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -10) p.y = canvas.height + 10;
      if (p.x < -10) p.x = canvas.width + 10;
      if (p.x > canvas.width + 10) p.x = -10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    particleFrame = requestAnimationFrame(animate);
  };
  animate();
}

document.addEventListener("visibilitychange", () => syncParticleBackground());
tickClock();
setInterval(tickClock, 1000);
boot();
