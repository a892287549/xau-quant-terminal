function isEnabled(settings = {}) {
  return Boolean(settings?.notifications?.feishu?.enabled && settings?.notifications?.feishu?.webhookUrl);
}

function directionText(direction) {
  return direction === "LONG" ? "做多" : direction === "SHORT" ? "做空" : "观望";
}

function gradeIcon(grade) {
  return { S: "🟢", A: "🟡", B: "⚪" }[grade] || "⚪";
}

function sideIcon(direction) {
  return direction === "LONG" ? "📈" : "📉";
}

function money(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}$${number.toFixed(2)}`;
}

export class FeishuNotifier {
  constructor({ timeoutMs = 8000 } = {}) {
    this.timeoutMs = timeoutMs;
  }

  async send(settings, markdown, title = "XAU Quant Terminal") {
    if (!isEnabled(settings)) return { skipped: true, reason: "feishu_disabled" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(settings.notifications.feishu.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          msg_type: "interactive",
          card: {
            header: {
              title: {
                tag: "plain_text",
                content: title
              }
            },
            elements: [
              {
                tag: "markdown",
                content: markdown
              }
            ]
          }
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload.code && payload.code !== 0)) {
        throw new Error(payload.msg || `Feishu webhook HTTP ${response.status}`);
      }
      return { ok: true, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  notifySignal(settings, signal) {
    return this.send(
      settings,
      `${gradeIcon(signal.grade)} **${signal.grade}级** ${directionText(signal.direction)} ${signal.type}\n\n入场 ${signal.entry}  止损 ${signal.stop}`,
      "XAU 信号触发"
    );
  }

  notifyOpen(settings, { signal, size, entry, stop }) {
    return this.send(
      settings,
      `${sideIcon(signal.direction)} **开仓** ${directionText(signal.direction)} ${signal.type}\n\nsize=${size}  入场=${entry}  止损=${stop}`,
      "XAU 模拟开仓"
    );
  }

  notifyPartialTakeProfit(settings, { position, pnl = 0, label = "1.5R" }) {
    return this.send(
      settings,
      `💰 **半仓锁利** ${position.type || position.signalType || ""} ${money(pnl)} @${label}`,
      "XAU 半仓止盈"
    );
  }

  notifyClose(settings, { position, pnl = 0, reason = "" }) {
    const icon = Number(pnl) >= 0 ? "✅" : "❌";
    return this.send(
      settings,
      `${icon} **平仓** ${position.type || position.signalType || ""}\n\nPnL ${money(pnl)}  原因：${reason}`,
      "XAU 平仓"
    );
  }

  notifyDailyCircuit(settings, { stoppedOutToday, maxDailyStops }) {
    return this.send(
      settings,
      `🛑 日内止损 ${stoppedOutToday}/${maxDailyStops} 触发熔断`,
      "XAU 日熔断"
    );
  }

  notifyWeeklyDrawdown(settings, { weeklyDrawdownPct }) {
    return this.send(
      settings,
      `⚠️ 周回撤 ${weeklyDrawdownPct}% 触发降仓/暂停检查`,
      "XAU 周回撤"
    );
  }

  notifyDailySummary(settings, summary) {
    return this.send(
      settings,
      `📊 今日: ${summary.trades} 笔  PnL ${money(summary.pnl)}  胜率 ${summary.winRate}%\n\n当前持仓 ${summary.positions}  周PnL ${money(summary.weekPnl)}`,
      "XAU 每日汇总"
    );
  }

  notifyDeviationAlert(settings, deviations = []) {
    const lines = deviations.map((item) => `- ${item.label}: 回测 ${item.expected} / 实际 ${item.actual} / 偏差 ${item.deviationPct}%`);
    return this.send(
      settings,
      `🚨 **纸盘偏差超阈值**\n\n${lines.join("\n")}`,
      "XAU 偏差告警"
    );
  }

  notifyAcceptanceReport(settings, report) {
    const lines = report.rows.map((row) => `| ${row.metric} | ${row.backtest} | ${row.actual} | ${row.deviationPct}% | ${row.pass ? "通过" : "不通过"} |`);
    return this.send(
      settings,
      `**2周纸盘验收报告**\n\n| 指标 | 回测 | 实际 | 偏差 | 通过 |\n| --- | --- | --- | --- | --- |\n${lines.join("\n")}\n\n${report.allPassed ? "✅ 建议上微量实盘" : "⚠️ 需人工判断"}`,
      "XAU 纸盘验收"
    );
  }
}
