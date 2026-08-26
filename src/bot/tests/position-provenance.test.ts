import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { TastytradeOrder } from "~/core/types";
import {
  buildProvenanceReport,
  classifyGroupProvenance,
  classifyOrderSource,
  getManualProvenanceLookbackDays,
  groupOpeningOrdersByGroupKey,
  isBotOrderSource,
  isDoNotTouchProvenance,
  isManagedProvenance,
  isManualProvenanceAutoProtectEnabled,
  lookbackStartDate,
  type PositionProvenance,
} from "../position-provenance";
import {
  BOT_ORDER_SOURCE,
  OVERNIGHT_REDUCTION_ORDER_SOURCE,
  OWNER_DIRECTED_ORDER_SOURCE,
  SECRET_AUTO_SEED_ORDER_SOURCE,
  SPRAY_BUY_ORDER_SOURCE,
  MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
  CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
  isOwnerDirectedOrderSource,
  isSecretAutoSeedOrderSource,
  isSprayBuyOrderSource,
  isOvernightReductionOrderSource,
  isMarginSeedFromCashOrderSource,
} from "../order-sources";
import { isEvaluationDoNotTouch } from "../do-not-touch-groups";
import { localTimeAt } from "./test-clock";

/** A filled OPTION opening order. */
function optionOpen(
  underlying: string,
  source: string | undefined,
  contractSymbol = `${underlying.padEnd(6)}260918C00005000`,
): TastytradeOrder {
  return {
    id: `${underlying}-${source ?? "none"}`,
    status: "Filled",
    source,
    "underlying-symbol": underlying,
    legs: [
      {
        action: "Buy to Open",
        "instrument-type": "Equity Option",
        symbol: contractSymbol,
        quantity: 1,
      },
    ],
  } as TastytradeOrder;
}

/** A filled EQUITY (shares) opening order — the owner's actual hand-trade shape. */
function equityOpen(
  ticker: string,
  source: string | undefined,
  { withUnderlyingSymbol = true } = {},
): TastytradeOrder {
  return {
    id: `${ticker}-equity-${source ?? "none"}`,
    status: "Filled",
    source,
    ...(withUnderlyingSymbol ? { "underlying-symbol": ticker } : {}),
    legs: [
      { action: "Buy to Open", "instrument-type": "Equity", symbol: ticker, quantity: 100 },
    ],
  } as TastytradeOrder;
}

const ENV_KEYS = [
  "BOT_MANUAL_PROVENANCE_AUTO_PROTECT",
  "BOT_MANUAL_PROVENANCE_LOOKBACK_DAYS",
  "BOT_DO_NOT_TOUCH_GROUPS",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("order-source classification", () => {
  it("recognises every source this bot writes as BOT", () => {
    for (const source of [
      BOT_ORDER_SOURCE,
      SECRET_AUTO_SEED_ORDER_SOURCE,
      SPRAY_BUY_ORDER_SOURCE,
      OVERNIGHT_REDUCTION_ORDER_SOURCE,
      MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
      CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
    ]) {
      assert.equal(classifyOrderSource(source), "bot", `${source} should be bot`);
      assert.equal(isBotOrderSource(source), true);
    }
  });

  it("still recognises the PRE-RENAME source as BOT (commit efda628)", () => {
    // Orders placed before 2026-07-27 sit at the broker tagged with the old
    // self-brand. If we forgot them, real bot positions would be classified
    // MANUAL and their stops silently disarmed.
    assert.equal(classifyOrderSource("tastytrade-golden-lion"), "bot");
    assert.equal(classifyOrderSource("tastytrade-golden-lion-spray-buy"), "bot");
    assert.equal(classifyOrderSource("tastytrade-golden-lion-secret-auto-seed"), "bot");
  });

  it("recognises the NEW system-first source as BOT (order-source migration)", () => {
    // Stage 2 of the rename flips placement to `silver-lynx-tastytrade*`. Once
    // deployed, the bot's own orders carry the new tag; classifying them MANUAL
    // would disarm their stops — the failure this whole module guards against.
    for (const source of [
      "silver-lynx-tastytrade",
      "silver-lynx-tastytrade-spray-buy",
      "silver-lynx-tastytrade-secret-auto-seed",
      "silver-lynx-golden-lion",
      "silver-lynx-golden-lion-overnight-reduction",
    ]) {
      assert.equal(classifyOrderSource(source), "bot", `${source} should be bot`);
      assert.equal(isBotOrderSource(source), true);
    }
  });

  it("classifies a foreign source as MANUAL", () => {
    for (const source of ["tastytrade-web", "tastyworks-desktop", "MANUAL", "iOS"]) {
      assert.equal(classifyOrderSource(source), "manual", `${source} should be manual`);
    }
  });

  it("classifies a BLANK or missing source as UNKNOWN, never MANUAL", () => {
    // `source` is optional on the read side. An omission is not evidence a human
    // placed the order, and treating it as such would disarm a live stop.
    for (const source of [undefined, null, "", "   "]) {
      assert.equal(classifyOrderSource(source), "unknown");
    }
  });

  it("classifies the owner-directed (SMS) source as OWNER-DIRECTED, not BOT", () => {
    // It shares our brand prefix, so a naive prefix check would call it `bot`
    // and the 12:50 margin EOD sweep would flatten his conviction trade.
    assert.equal(classifyOrderSource(OWNER_DIRECTED_ORDER_SOURCE), "owner-directed");
    assert.equal(isDoNotTouchProvenance("owner-directed"), true);
  });
});

// The cancel-sweep spares resting slices (spray-buy, seeds, overnight reduction)
// and the owner-directed conviction order via per-subsystem predicates that key on
// the source SUFFIX. Stage 2 of the rename flips the brand prefix while legacy and
// in-flight orders keep the old one, so each predicate MUST match its suffix under
// EVERY brand era or a legacy resting slice gets swept the moment placement flips.
describe("per-subsystem source predicates are brand-agnostic (order-source migration)", () => {
  const BRANDS = [
    "silver-lynx-tastytrade", // NEW system-first (stage-2 placement)
    "silver-lynx-golden-lion", // NEW golden-lion line
    "tastytrade-silver-lynx", // OLD venue-first (stage-1 placement + in-flight)
    "tastytrade-golden-lion", // pre-2026-07-27 self-brand
  ];

  const CASES: Array<[string, (s: string) => boolean]> = [
    ["-owner-directed", isOwnerDirectedOrderSource],
    ["-secret-auto-seed", isSecretAutoSeedOrderSource],
    ["-spray-buy", isSprayBuyOrderSource],
    ["-overnight-reduction", isOvernightReductionOrderSource],
    ["-margin-seed-from-cash", isMarginSeedFromCashOrderSource],
  ];

  for (const [suffix, predicate] of CASES) {
    it(`matches ${suffix} under every brand era`, () => {
      for (const brand of BRANDS) {
        assert.equal(predicate(`${brand}${suffix}`), true, `${brand}${suffix}`);
      }
      // Must NOT match a different suffix or a bare foreign source.
      assert.equal(predicate("silver-lynx-tastytrade-spray-buy-extra"), false);
      assert.equal(predicate("tastytrade-web"), false);
    });
  }
});

describe("group rollup", () => {
  it("is BOT only when every opener is positively ours", () => {
    assert.equal(
      classifyGroupProvenance([optionOpen("RUM", BOT_ORDER_SOURCE), optionOpen("RUM", SPRAY_BUY_ORDER_SOURCE)]),
      "bot",
    );
  });

  it("is MANUAL when ANY opener is the owner's (fungible pile)", () => {
    // The bot cannot sell only its own contracts, so a hand-added double-down
    // makes the whole group his to exit.
    assert.equal(
      classifyGroupProvenance([optionOpen("ERIC", BOT_ORDER_SOURCE), optionOpen("ERIC", "tastytrade-web")]),
      "manual",
    );
  });

  it("prefers OWNER-DIRECTED over a bot opener, but MANUAL outranks both", () => {
    assert.equal(
      classifyGroupProvenance([optionOpen("X", BOT_ORDER_SOURCE), optionOpen("X", OWNER_DIRECTED_ORDER_SOURCE)]),
      "owner-directed",
    );
    assert.equal(
      classifyGroupProvenance([optionOpen("X", OWNER_DIRECTED_ORDER_SOURCE), optionOpen("X", "tastytrade-web")]),
      "manual",
    );
  });

  it("is UNKNOWN when no opening order was found at all", () => {
    assert.equal(classifyGroupProvenance([]), "unknown");
    assert.equal(classifyGroupProvenance(undefined), "unknown");
    assert.equal(classifyGroupProvenance(null), "unknown");
  });

  it("is UNKNOWN when a bot opener is mixed with an indeterminate one", () => {
    // Not positively all-ours => we do not claim `bot`; still MANAGED though.
    const provenance = classifyGroupProvenance([
      optionOpen("Y", BOT_ORDER_SOURCE),
      optionOpen("Y", undefined),
    ]);
    assert.equal(provenance, "unknown");
    assert.equal(isManagedProvenance(provenance), true);
  });

  it("ignores orders that never filled", () => {
    const rejected = { ...optionOpen("Z", "tastytrade-web"), status: "Rejected" };
    assert.equal(groupOpeningOrdersByGroupKey([rejected]).size, 0);
  });

  it("ignores closing orders — provenance is about who OPENED the position", () => {
    const closing = {
      ...optionOpen("Z", "tastytrade-web"),
      legs: [
        { action: "Sell to Close", "instrument-type": "Equity Option", symbol: "Z 260918C00005000", quantity: 1 },
      ],
    } as TastytradeOrder;
    assert.equal(groupOpeningOrdersByGroupKey([closing]).size, 0);
  });
});

describe("equity (shares) coverage", () => {
  it("keys a hand-bought EQUITY order as TICKER::NONE via the shared group key", () => {
    // The owner hand-buys shares (AMPG/BTDR/OPFI/UAMY), not only contracts.
    const byGroup = groupOpeningOrdersByGroupKey([equityOpen("AMPG", "tastytrade-web")]);
    assert.deepEqual([...byGroup.keys()], ["AMPG::NONE"]);
    assert.equal(classifyGroupProvenance(byGroup.get("AMPG::NONE")), "manual");
  });

  it("falls back to the equity leg symbol when underlying-symbol is absent", () => {
    const byGroup = groupOpeningOrdersByGroupKey([
      equityOpen("UAMY", "tastytrade-web", { withUnderlyingSymbol: false }),
    ]);
    assert.deepEqual([...byGroup.keys()], ["UAMY::NONE"]);
  });

  it("a manual equity group is protected through the EXISTING ::none/::stock alias", () => {
    // Reuse, not a parallel path: whichever token the auto-protect injects, the
    // f99b67c alias resolves it to the same equity leg.
    for (const injected of ["AMPG::NONE", "AMPG::STOCK", "AMPG"]) {
      assert.equal(
        isEvaluationDoNotTouch({ groupKey: "AMPG::none" }, new Set([injected])),
        true,
        `${injected} should protect the AMPG equity leg`,
      );
    }
  });

  it("keeps equity and option legs of the same ticker as separate groups", () => {
    const byGroup = groupOpeningOrdersByGroupKey([
      equityOpen("BTDR", "tastytrade-web"),
      optionOpen("BTDR", BOT_ORDER_SOURCE),
    ]);
    assert.equal(classifyGroupProvenance(byGroup.get("BTDR::NONE")), "manual");
    assert.equal(classifyGroupProvenance(byGroup.get("BTDR::CALL")), "bot");
  });
});

describe("the UNKNOWN safety invariant", () => {
  it("UNKNOWN is NEVER hands-off — a lost/short/failed history cannot disarm a stop", () => {
    // THE single most important property of this change. If UNKNOWN were treated
    // as manual, one unavailable order-history call would silently disarm every
    // stop in the account, which is strictly worse than the problem being solved.
    assert.equal(isDoNotTouchProvenance("unknown"), false);
    assert.equal(isManagedProvenance("unknown"), true);

    const handsOff: PositionProvenance[] = ["manual", "owner-directed"];
    const managed: PositionProvenance[] = ["bot", "unknown"];
    for (const provenance of handsOff) assert.equal(isDoNotTouchProvenance(provenance), true);
    for (const provenance of managed) assert.equal(isDoNotTouchProvenance(provenance), false);
  });

  it("a FAILED order-history call classifies every group UNKNOWN and protects nothing", async () => {
    const report = await buildProvenanceReport({
      accountNumber: "TEST",
      groupKeys: ["ERIC::CALL", "AMPG::NONE"],
      fetchOrders: async () => {
        throw new Error("502 Bad Gateway");
      },
      now: localTimeAt(10, 0),
    });

    assert.equal(report.historyAvailable, false);
    assert.equal(report.manualGroupKeys.size, 0, "a failed read must protect NOTHING");
    assert.equal(report.byGroupKey.get("ERIC::CALL"), "unknown");
    assert.equal(report.byGroupKey.get("AMPG::NONE"), "unknown");
    assert.match(report.error ?? "", /502/);
  });

  it("an EMPTY order history classifies every group UNKNOWN and protects nothing", async () => {
    // The fresh-deploy / truncated-window case.
    const report = await buildProvenanceReport({
      accountNumber: "TEST",
      groupKeys: ["ERIC::CALL"],
      fetchOrders: async () => [],
      now: localTimeAt(10, 0),
    });
    assert.equal(report.historyAvailable, true);
    assert.equal(report.byGroupKey.get("ERIC::CALL"), "unknown");
    assert.equal(report.manualGroupKeys.size, 0);
  });
});

describe("provenance report", () => {
  it("separates bot, manual and unknown groups off one history read", async () => {
    const report = await buildProvenanceReport({
      accountNumber: "TEST",
      groupKeys: ["RUM::CALL", "ERIC::CALL", "AMPG::NONE", "GHOST::CALL"],
      fetchOrders: async () => [
        optionOpen("RUM", BOT_ORDER_SOURCE),
        optionOpen("ERIC", "tastytrade-web"),
        equityOpen("AMPG", "tastytrade-web"),
      ],
      now: localTimeAt(10, 0),
    });

    assert.equal(report.byGroupKey.get("RUM::CALL"), "bot");
    assert.equal(report.byGroupKey.get("ERIC::CALL"), "manual");
    assert.equal(report.byGroupKey.get("AMPG::NONE"), "manual");
    assert.equal(report.byGroupKey.get("GHOST::CALL"), "unknown");
    assert.deepEqual([...report.manualGroupKeys].sort(), ["AMPG::NONE", "ERIC::CALL"]);
  });

  it("requests a bounded, dated, filled-only history window", async () => {
    let seen: Record<string, unknown> | undefined;
    await buildProvenanceReport({
      accountNumber: "TEST",
      groupKeys: [],
      fetchOrders: async (_account, queryParams) => {
        seen = queryParams;
        return [];
      },
      now: localTimeAt(10, 0),
      lookbackDays: 30,
    });
    // MUST be <= 100: the orders endpoint hard-caps per-page at 100 and returns a
    // 400 (not a clamp) for anything larger. A prior value of 250 made every
    // provenance read fail, silently disarming provenance for every position.
    assert.equal(seen?.["per-page"], 100);
    assert.ok((seen?.["per-page"] as number) <= 100, "per-page must not exceed the API's 100 cap");
    assert.equal(seen?.["start-date"], lookbackStartDate(localTimeAt(10, 0), 30));
  });

  it("matches group keys case-insensitively", async () => {
    const report = await buildProvenanceReport({
      accountNumber: "TEST",
      groupKeys: ["eric::call"],
      fetchOrders: async () => [optionOpen("ERIC", "tastytrade-web")],
      now: localTimeAt(10, 0),
    });
    assert.equal(report.byGroupKey.get("ERIC::CALL"), "manual");
  });
});

describe("the arming flag", () => {
  it("is OFF by default and OFF when present-but-blank", () => {
    delete process.env.BOT_MANUAL_PROVENANCE_AUTO_PROTECT;
    assert.equal(isManualProvenanceAutoProtectEnabled(), false);
    process.env.BOT_MANUAL_PROVENANCE_AUTO_PROTECT = "";
    assert.equal(isManualProvenanceAutoProtectEnabled(), false);
  });

  it("arms only on an explicit truthy value", () => {
    for (const raw of ["true", "1", "yes", "TRUE"]) {
      process.env.BOT_MANUAL_PROVENANCE_AUTO_PROTECT = raw;
      assert.equal(isManualProvenanceAutoProtectEnabled(), true, raw);
    }
    for (const raw of ["false", "0", "no", "maybe"]) {
      process.env.BOT_MANUAL_PROVENANCE_AUTO_PROTECT = raw;
      assert.equal(isManualProvenanceAutoProtectEnabled(), false, raw);
    }
  });

  it("falls back to the in-code lookback default on a blank value", () => {
    process.env.BOT_MANUAL_PROVENANCE_LOOKBACK_DAYS = "";
    assert.equal(getManualProvenanceLookbackDays(), 90);
    process.env.BOT_MANUAL_PROVENANCE_LOOKBACK_DAYS = "0";
    assert.equal(getManualProvenanceLookbackDays(), 90, "non-positive is rejected");
    process.env.BOT_MANUAL_PROVENANCE_LOOKBACK_DAYS = "30";
    assert.equal(getManualProvenanceLookbackDays(), 30);
  });
});
