import test from "node:test";
import assert from "node:assert/strict";
import { orderSizeFor } from "../server/daemon/tradeDaemon.js";

test("daemon order sizing follows percent-risk grade multipliers", () => {
  const settings = {
    paper: { initialBalanceUsdt: 10000 },
    risk: { perTradeRiskPct: 2 },
    daemon: { minOrderSize: 0.01, pnlMultiplier: 100 }
  };
  const signal = {
    grade: "B",
    entry: 2400,
    stop: 2380
  };
  const risk = { equity: 10000 };
  assert.equal(orderSizeFor(settings, signal, risk), "0.05");
});

test("daemon order sizing supports explicit fixed-size override", () => {
  const settings = {
    daemon: {
      useFixedOrderSize: true,
      orderSize: 0.37
    }
  };
  assert.equal(orderSizeFor(settings, {}, {}), "0.37");
});
