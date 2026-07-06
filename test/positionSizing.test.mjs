import test from "node:test";
import assert from "node:assert/strict";
import { orderSizeFor, paperExecutionPrice, partialTargetForSignal } from "../server/daemon/tradeDaemon.js";

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

test("fakeout partial target plans half-size reduce-only target", () => {
  const settings = {
    daemon: { minOrderSize: 0.01 },
    strategy: { exitRules: { fakeoutPartialTP: true, fakeoutTp1R: 1.5 } }
  };
  assert.deepEqual(partialTargetForSignal({
    type: "fakeout",
    direction: "LONG",
    entry: 2400,
    stop: 2380
  }, 2400, "0.10", settings), {
    type: "fakeout",
    reason: "fakeout_1.5R",
    r: 1.5,
    side: "sell",
    price: 2430,
    size: "0.05",
    remainingSize: "0.05"
  });
  assert.equal(partialTargetForSignal({
    type: "fakeout",
    direction: "SHORT",
    entry: 2400,
    stop: 2420
  }, 2400, "0.10", settings).price, 2370);
});

test("fakeout partial target obeys feature switch and minimum lot", () => {
  const settings = {
    daemon: { minOrderSize: 0.01 },
    strategy: { exitRules: { fakeoutPartialTP: false } }
  };
  assert.equal(partialTargetForSignal({
    type: "fakeout",
    direction: "LONG",
    entry: 2400,
    stop: 2380
  }, 2400, "0.10", settings), null);
  assert.equal(partialTargetForSignal({
    type: "support_reversal",
    direction: "LONG",
    entry: 2400,
    stop: 2380
  }, 2400, "0.01", settings), null);
});

test("paper execution prices use bid/ask plus configurable slippage", () => {
  const settings = { paper: { slippageUsd: 0.1, spreadUsd: 0.3 } };
  const quote = { bid: 2400, ask: 2400.3, mid: 2400.15, spread: 0.3 };
  assert.equal(paperExecutionPrice({ side: "buy", quote, fallback: 2400.15, settings }).price, 2400.4);
  assert.equal(paperExecutionPrice({ side: "sell", quote, fallback: 2400.15, settings }).price, 2399.9);
  assert.equal(paperExecutionPrice({ side: "buy", quote: { mid: 2400 }, fallback: 2400, settings }).price, 2400.25);
});
