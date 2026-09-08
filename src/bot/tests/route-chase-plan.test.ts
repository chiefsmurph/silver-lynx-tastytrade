import test from "node:test";
import assert from "node:assert/strict";
import { getRouteChasePlan } from "../actions/manage-allocation";

// Wide spread: bid 1.00 / ask 1.40 → mid 1.20, gap mid→ask 0.20 (> 2 × 0.05)
const BID = 1.0;
const ASK = 1.4;

test("bid route rests at the bid and never chases", () => {
  const plan = getRouteChasePlan("bid", BID, ASK);
  assert.equal(plan.startPrice, 1.0);
  assert.equal(plan.maxTicks, 0);
});

test("mid route starts at mid and concedes at most 3 ticks", () => {
  const plan = getRouteChasePlan("mid", BID, ASK);
  assert.equal(plan.startPrice, 1.2);
  assert.equal(plan.maxTicks, 3);
  assert.equal(plan.ceilingPrice, 1.4);
  assert.equal(plan.tickIntervalMs, 30_000);
});

test("ask route starts at MID (not the ask) and fast-chases to the full ask", () => {
  const plan = getRouteChasePlan("ask", BID, ASK);
  assert.equal(plan.startPrice, 1.2, "ask route must not pay the full spread instantly");
  assert.equal(plan.ceilingPrice, 1.4);
  assert.equal(plan.maxTicks, 10);
  assert.equal(plan.tickIntervalMs, 15_000, "ask route chases on the faster clock");
});

test("ask route goes straight to the ask when the spread is already tight", () => {
  // bid 1.00 / ask 1.10 → mid 1.05, gap 0.05 ≤ 2 × 0.05 — nothing to capture
  const plan = getRouteChasePlan("ask", 1.0, 1.1);
  assert.equal(plan.startPrice, 1.1);
  assert.equal(plan.maxTicks, 0);
});

test("missing ask degrades to the midpoint fallback without chasing past it", () => {
  const plan = getRouteChasePlan("ask", 1.0, 0);
  assert.equal(plan.startPrice, plan.ceilingPrice);
  assert.equal(plan.maxTicks, 0);
});

// Bid-route min-depth floor: on a tight spread the bid is too close to mid to
// give meaningful resting room. The floor (STRATEGY_BID_ROUTE_MIN_DEPTH_PCT,
// default 6%) extends the resting price below the natural bid.
test("bid route on wide spread stays at the natural bid — floor does not apply", () => {
  // bid 1.00 / ask 1.40 → mid 1.20; floor = 1.20 × 0.94 = 1.128 > bid → stays at bid
  const plan = getRouteChasePlan("bid", 1.0, 1.4);
  assert.equal(plan.startPrice, 1.0);
  assert.equal(plan.maxTicks, 0);
});

test("bid route on tight spread floors below the bid to guarantee minimum depth", () => {
  // bid 1.00 / ask 1.10 → mid 1.05; floor = 1.05 × (1 − 0.06) = 0.987 < bid → floor wins
  const plan = getRouteChasePlan("bid", 1.0, 1.1);
  assert.ok(plan.startPrice < 1.0, "tight-spread bid route must rest below the natural bid");
  assert.equal(plan.startPrice, 1.05 * (1 - 0.06));
  assert.equal(plan.maxTicks, 0);
});

test("bid route floor does not apply on a degenerate quote (missing ask)", () => {
  // No valid two-sided market — fall back to natural bid, no floor.
  const plan = getRouteChasePlan("bid", 1.0, 0);
  assert.equal(plan.startPrice, 1.0);
  assert.equal(plan.maxTicks, 0);
});
