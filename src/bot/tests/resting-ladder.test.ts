import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateContractsAcrossRungs,
  allocateContractsByWeight,
  buildRestingLadderRouteOrders,
  buildRouteOrders,
  getRouteChasePlan,
  placeRouteOrders,
} from "../actions/manage-allocation";

const TARGETS = { bidWeight: 0.2, midWeight: 0.3, askWeight: 0.5 };

// Every ladder test sets the flag explicitly and restores it, so the suite is
// order-independent and never leaks the flag into the flag-off legacy tests.
function withLadderFlag<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.STRATEGY_RESTING_LADDER_ENABLED;
  if (value === undefined) delete process.env.STRATEGY_RESTING_LADDER_ENABLED;
  else process.env.STRATEGY_RESTING_LADDER_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.STRATEGY_RESTING_LADDER_ENABLED;
    else process.env.STRATEGY_RESTING_LADDER_ENABLED = prior;
  }
}

test("flag OFF leaves buildRouteOrders on the legacy 3-route path", () => {
  withLadderFlag(undefined, () => {
    const routes = buildRouteOrders(1.2, 1.35, TARGETS);
    assert.deepEqual(routes.map((r) => r.route), ["bid", "mid", "ask"]);
  });
});

test("flag ON builds N resting rungs, all inside the band and below the ask", () => {
  withLadderFlag("1", () => {
    const routes = buildRouteOrders(1.2, 1.35, TARGETS);
    assert.equal(routes.length, 5, "default 5 rungs");
    assert.ok(
      routes.every((r) => r.route === "rung"),
      "every route is a resting rung",
    );
    // Deepest rung rests at the bid; no rung sits at or above the ask.
    assert.ok(Math.abs(routes[0].limitPrice - 1.2) < 1e-9, "deepest rung at bid");
    assert.ok(
      routes.every((r) => r.limitPrice < 1.35),
      "no rung is a marketable ask-chase",
    );
    // Prices ascend deepest → shallowest.
    for (let i = 1; i < routes.length; i += 1) {
      assert.ok(routes[i].limitPrice > routes[i - 1].limitPrice);
    }
  });
});

test("quantity splits as evenly as possible across the rungs", () => {
  const rungs = buildRestingLadderRouteOrders(1.2, 1.35, 5);
  // Average rung cost ≈ $126; capital for 12 contracts ≈ $1512.
  const capital = 12 * ((1.2 + 1.35) / 2) * 100 + 1;
  const sized = allocateContractsAcrossRungs(rungs, capital);
  const total = sized.reduce((sum, r) => sum + r.quantity, 0);
  assert.equal(total, 12, "all 12 contracts placed");
  const quantities = sized.map((r) => r.quantity);
  assert.ok(
    Math.max(...quantities) - Math.min(...quantities) <= 1,
    "even split: rungs differ by at most one contract",
  );
  // Never dumps the whole quantity on one rung.
  assert.ok(Math.max(...quantities) < total);
});

test("quantity < rungs uses fewer rungs (the deepest), never one lump", () => {
  const rungs = buildRestingLadderRouteOrders(0.1, 0.14, 5);
  const capital = 3 * ((0.1 + 0.14) / 2) * 100 + 1; // room for ~3 contracts
  const sized = allocateContractsAcrossRungs(rungs, capital);
  const priced = sized.filter((r) => r.quantity > 0);
  assert.equal(priced.length, 3, "3 contracts → 3 priced rungs");
  assert.ok(
    priced.every((r) => r.quantity === 1),
    "one contract per active rung",
  );
  // The active rungs are the DEEPEST (best-priced) three.
  assert.deepEqual(
    priced.map((r) => r.limitPrice),
    sized.slice(0, 3).map((r) => r.limitPrice),
  );
});

test("qty=1 yields a single resting rung at the bid", () => {
  const rungs = buildRestingLadderRouteOrders(5.0, 5.4, 5);
  const capital = 1 * ((5.0 + 5.4) / 2) * 100 + 1;
  const sized = allocateContractsAcrossRungs(rungs, capital);
  const priced = sized.filter((r) => r.quantity > 0);
  assert.equal(priced.length, 1, "exactly one resting order");
  assert.equal(priced[0].quantity, 1);
  assert.ok(Math.abs(priced[0].limitPrice - 5.0) < 1e-9, "rests at the bid");
});

test("allocateContractsByWeight routes rung arrays to the even splitter", () => {
  const rungs = buildRestingLadderRouteOrders(1.2, 1.35, 5);
  const capital = 6 * ((1.2 + 1.35) / 2) * 100 + 1;
  const viaByWeight = allocateContractsByWeight(rungs, capital);
  assert.equal(
    viaByWeight.reduce((sum, r) => sum + r.quantity, 0),
    6,
    "sizes rungs via the even splitter, not the weight schedule",
  );
});

test("a rung's chase plan rests at its own price with zero ticks", () => {
  const plan = getRouteChasePlan("rung", 1.2, 1.35, 1.26);
  assert.equal(plan.maxTicks, 0, "no chase");
  assert.equal(plan.startPrice, 1.26, "starts at the rung price");
  assert.equal(plan.ceilingPrice, 1.26, "ceiling is the rung price");
});

test("placeRouteOrders rests each rung once and never chases", async () => {
  const rungs = allocateContractsAcrossRungs(
    buildRestingLadderRouteOrders(1.2, 1.35, 5),
    12 * ((1.2 + 1.35) / 2) * 100 + 1,
  );
  const submittedPrices: string[] = [];
  let waitForFillCalls = 0;

  const placed = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    rungs,
    1.2,
    1.35,
    {
      createOrder: async (_acct, order) => {
        submittedPrices.push(String((order as { price?: string }).price ?? ""));
        return { order: { id: String(submittedPrices.length) } } as never;
      },
      waitForFill: async () => {
        waitForFillCalls += 1;
        return false;
      },
    },
  );

  assert.equal(waitForFillCalls, 0, "resting rungs never poll for a fill");
  assert.equal(submittedPrices.length, 5, "one order per priced rung");
  assert.deepEqual(submittedPrices, ["1.20", "1.23", "1.26", "1.29", "1.32"]);
  assert.ok(placed.every((r) => r.placedOrder));
});
