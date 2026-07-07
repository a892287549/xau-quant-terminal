import test from "node:test";
import assert from "node:assert/strict";
import { OkxExecutor } from "../server/execution/okxExecutor.js";

test("perpetual orders default to isolated margin", () => {
  const executor = new OkxExecutor({ instrument: "XAU-USDT-SWAP" });
  const body = executor.buildPerpetualMarketOrder({
    side: "buy",
    size: "0.01",
    stopLossPrice: 4100
  }, {
    api: { marginMode: "isolated" }
  });
  assert.equal(body.tdMode, "isolated");
  assert.equal(body.attachAlgoOrds[0].slOrdPx, "-1");
});

test("explicit cross margin is ignored for managed XAU orders", () => {
  const executor = new OkxExecutor({ instrument: "XAU-USDT-SWAP" });
  const body = executor.buildPerpetualMarketOrder({
    side: "sell",
    size: "0.01",
    tdMode: "cross"
  }, {
    api: { marginMode: "isolated" }
  });
  assert.equal(body.tdMode, "isolated");
});
