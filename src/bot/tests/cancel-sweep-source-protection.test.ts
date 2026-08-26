import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSweepEligibleSource } from "../execute-position-evaluations";
import {
  BOT_ORDER_SOURCE,
  SECRET_AUTO_SEED_ORDER_SOURCE,
  SPRAY_BUY_ORDER_SOURCE,
  OVERNIGHT_REDUCTION_ORDER_SOURCE,
  MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
  CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
  OWNER_DIRECTED_ORDER_SOURCE,
} from "../order-sources";

// The per-cycle cancel sweep (`cancelAllLiveOrders`) uses `isSweepEligibleSource`
// as its FIRST gate: only orders positively identified as the bot's own may be
// cancelled. This is the safety property that keeps the sweep from wiping a
// hand-placed order resting in the shared tastytrade margin account — the exact
// failure that cancelled a hand-placed AVEX ladder on 2026-08-26.
describe("cancel sweep — source protection gate", () => {
  it("sweeps every order the bot itself places", () => {
    for (const source of [
      BOT_ORDER_SOURCE,
      SECRET_AUTO_SEED_ORDER_SOURCE,
      SPRAY_BUY_ORDER_SOURCE,
      OVERNIGHT_REDUCTION_ORDER_SOURCE,
      MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
      CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
    ]) {
      // Sweep-eligible BY SOURCE. Slices that rest across cycles (spray-buy, seeds,
      // overnight reduction) are still spared by their own dedicated checks further
      // down the sweep — this gate only decides "is it ours at all".
      assert.equal(isSweepEligibleSource(source), true, `${source} is the bot's own`);
    }
  });

  it("still recognises the PRE-RENAME bot brand as ours (commit efda628)", () => {
    // Orders placed before 2026-07-27 sit at the broker tagged with the old brand.
    // Forgetting them would leave the bot's own stale pre-rename orders uncancelled.
    assert.equal(isSweepEligibleSource("tastytrade-golden-lion"), true);
    assert.equal(isSweepEligibleSource("tastytrade-golden-lion-spray-buy"), true);
  });

  it("recognises the NEW system-first brand as ours (order-source migration)", () => {
    // Stage 2 of the rename flips placement to `silver-lynx-tastytrade*`. The
    // sweep must already know that form (deployed stage-1) or it would stop
    // recognising its OWN freshly-placed orders and leave them resting.
    assert.equal(isSweepEligibleSource("silver-lynx-tastytrade"), true);
    assert.equal(isSweepEligibleSource("silver-lynx-tastytrade-overnight-reduction"), true);
    // The new form of the legacy golden-lion line, for completeness.
    assert.equal(isSweepEligibleSource("silver-lynx-golden-lion"), true);
  });

  it("NEVER sweeps a hand-placed order (tastytrade UI / Copper Jaguar / other)", () => {
    for (const source of ["copper-jaguar", "tastytrade-web", "tastyworks-desktop", "iOS", "MANUAL"]) {
      assert.equal(isSweepEligibleSource(source), false, `${source} is hand-placed, leave it alone`);
    }
  });

  it("NEVER sweeps a blank/unattributable-source order", () => {
    // A bot order always carries a source; a blank one is not positively ours, so we
    // leave it alone rather than risk cancelling something a human placed.
    for (const source of [undefined, null, "", "   "]) {
      assert.equal(isSweepEligibleSource(source), false);
    }
  });

  it("NEVER sweeps an owner-directed conviction order", () => {
    // Bot-placed but the owner owns the exit; it shares our brand prefix, so this
    // guards against a naive prefix check re-classifying it as sweepable.
    assert.equal(isSweepEligibleSource(OWNER_DIRECTED_ORDER_SOURCE), false);
  });
});
