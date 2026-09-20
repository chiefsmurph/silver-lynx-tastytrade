import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRealizedPnlReport,
  classifyLegKind,
  formatRealizedPnlReport,
  normalizeOptionRoot,
  type LedgerRow,
} from "../realized-pnl-report";

// REGRESSION — 2026-08-08. The realized-P&L tool understated realized loss by
// roughly 3× over 2026-07-17→08-07. Two independent analyses nearly shipped the
// wrong conclusion off it. Causes, each covered below:
//   1. expired-worthless contracts never matched a close and were dropped
//   2. `value` (pre-commission) was used instead of `net-value`
// Plus two shapes hit in practice: an OCC root rename mid-position, and manual
// equity round-trips sitting in the same ledger.

/** Nullable-number reads, kept out of the test bodies so each stays branchless. */
const num = (value: number | null | undefined): number => value ?? 0;
const near = (actual: number, expected: number, epsilon = 1e-9): boolean =>
  Math.abs(actual - expected) < epsilon;

const OPEN_ROW: LedgerRow = {
  symbol: "AAPL  260619C00100000",
  "underlying-symbol": "AAPL",
  "instrument-type": "Equity Option",
  "transaction-type": "Trade",
  "transaction-sub-type": "Buy to Open",
  action: "Buy to Open",
  quantity: 2,
  price: 1.0,
  value: 200,
  "value-effect": "Debit",
  "net-value": 202,
  "net-value-effect": "Debit",
  "executed-at": "2026-07-20T14:30:00Z",
};

const CLOSE_ROW: LedgerRow = {
  symbol: "AAPL  260619C00100000",
  "underlying-symbol": "AAPL",
  "instrument-type": "Equity Option",
  "transaction-type": "Trade",
  "transaction-sub-type": "Sell to Close",
  action: "Sell to Close",
  quantity: 2,
  price: 1.2,
  value: 240,
  "value-effect": "Credit",
  "net-value": 239.76,
  "net-value-effect": "Credit",
  "executed-at": "2026-07-22T16:30:00Z",
};

// ── Defect 1a: expirations ──────────────────────────────────────────────────
// Arrives as Receive Deliver / Expiration with no `action` and no matching
// Sell-to-Close. The old filter+matcher left the open leg dangling in the FIFO
// map and printed nothing at all, so a −100% outcome simply vanished.
const EXPIRATION_ROW: LedgerRow = {
  symbol: "WEN   260717C00012000",
  "underlying-symbol": "WEN",
  "instrument-type": "Equity Option",
  "transaction-type": "Receive Deliver",
  "transaction-sub-type": "Expiration",
  description: "Removal of 5 WEN 07/17/26 Call 12.00 due to expiration.",
  quantity: 5,
  value: 0,
  "value-effect": "None",
  "net-value": 0,
  "net-value-effect": "None",
  "executed-at": "2026-07-17T20:00:00Z",
};

const EXPIRED_OPEN_ROW: LedgerRow = {
  ...OPEN_ROW,
  symbol: "WEN   260717C00012000",
  "underlying-symbol": "WEN",
  quantity: 5,
  value: 500,
  "net-value": 505,
  "executed-at": "2026-07-15T14:30:00Z",
};

test("an expiration with no matching close is a realized -100%, not a dropped row", () => {
  const report = buildRealizedPnlReport([EXPIRED_OPEN_ROW, EXPIRATION_ROW]);

  assert.equal(report.trips.length, 1, "the expired contract must produce a round trip");
  const trip = report.trips[0]!;
  assert.equal(trip.outcome, "expired");
  assert.equal(trip.underlying, "WEN");
  assert.equal(trip.quantity, 5);
  assert.equal(trip.netProceeds, 0);
  assert.equal(trip.netCost, 505);
  assert.equal(report.totals.netReturnPct, -100);

  // And nothing is left dangling.
  assert.equal(report.reconciliation.stillOpen.length, 0);
  assert.equal(report.reconciliation.expirationLegs, 1);
  assert.equal(report.reconciliation.trips, 1);
});

test("an expiration is not silently swallowed when it lands with real closes", () => {
  // The blended number is what gets quoted. With the expiration dropped it read
  // a small gain; with it included the window is deeply negative.
  const withExpiry = buildRealizedPnlReport([
    OPEN_ROW,
    CLOSE_ROW,
    EXPIRED_OPEN_ROW,
    EXPIRATION_ROW,
  ]);
  const withoutExpiry = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]);

  assert.equal(withExpiry.trips.length, 2);
  assert.equal(withoutExpiry.trips.length, 1);
  assert.ok(num(withoutExpiry.totals.netReturnPct) > 0, "the closed trip alone is a gain");
  assert.ok(
    num(withExpiry.totals.netReturnPct) < -50,
    "including the expiration must swing the window deeply negative",
  );
});

test("classifyLegKind recognises the Receive Deliver termination shapes", () => {
  assert.equal(classifyLegKind(EXPIRATION_ROW), "expiration");
  assert.equal(
    classifyLegKind({ "transaction-type": "Receive Deliver", "transaction-sub-type": "Assignment" }),
    "expiration",
  );
  assert.equal(
    classifyLegKind({ "transaction-type": "Receive Deliver", "transaction-sub-type": "Exercise" }),
    "expiration",
  );
  // An expiration row with only a description still terminates the lot.
  assert.equal(
    classifyLegKind({ "transaction-type": "Receive Deliver", description: "… due to expiration." }),
    "expiration",
  );
  assert.equal(classifyLegKind(OPEN_ROW), "open");
  assert.equal(classifyLegKind(CLOSE_ROW), "close");
});

test("a quantity-less expiration removes the whole remaining position", () => {
  const report = buildRealizedPnlReport([
    EXPIRED_OPEN_ROW,
    { ...EXPIRATION_ROW, quantity: 0 },
  ]);
  assert.equal(report.trips.length, 1);
  assert.equal(report.trips[0]!.quantity, 5);
  assert.equal(report.reconciliation.stillOpen.length, 0);
});

// ── Defect 1b: commissions ──────────────────────────────────────────────────
test("a commission-bearing round trip carries both gross and net cash", () => {
  const trip = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]).trips[0]!;
  // $1/contract to open, $0.12/contract to close.
  assert.equal(trip.grossCost, 200);
  assert.equal(trip.netCost, 202);
  assert.equal(trip.grossProceeds, 240);
  assert.ok(near(trip.netProceeds, 239.76));
});

test("fee drag is reported separately and always makes the net return worse", () => {
  const t = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]).totals;
  assert.notEqual(t.grossPnl, t.netPnl);
  assert.ok(near(t.fees, 2.24));
  // 40/200 = +20.0% gross vs 37.76/202 = +18.69% net — 1.11pp of fee drag.
  assert.ok(near(num(t.grossReturnPct), 20));
  assert.ok(near(num(t.netReturnPct), 18.693069, 1e-4));
  assert.ok(near(num(t.feeDragPp), 1.108911, 1e-4));
  assert.ok(num(t.netReturnPct) < num(t.grossReturnPct), "fees must reduce the net return");
});

test("fees are allocated pro-rata across a partial close", () => {
  const report = buildRealizedPnlReport([
    OPEN_ROW, // 2 contracts, net cost 202
    { ...CLOSE_ROW, quantity: 1, value: 120, "net-value": 119.88 },
  ]);
  assert.equal(report.trips.length, 1);
  assert.equal(report.trips[0]!.netCost, 101);
  assert.equal(report.reconciliation.stillOpen.length, 1);
  assert.equal(report.reconciliation.stillOpen[0]!.quantity, 1);
});

test("a row without net-value falls back to value rather than pricing at zero", () => {
  const report = buildRealizedPnlReport([
    { ...OPEN_ROW, "net-value": undefined, "net-value-effect": undefined },
    { ...CLOSE_ROW, "net-value": undefined, "net-value-effect": undefined },
  ]);
  assert.equal(report.trips[0]!.netCost, 200);
  assert.equal(report.trips[0]!.netProceeds, 240);
  assert.equal(report.totals.fees, 0);
});

// ── Symbol changes ──────────────────────────────────────────────────────────
test("normalizeOptionRoot strips the corporate-action suffix", () => {
  assert.equal(normalizeOptionRoot("EOSE1 "), "EOSE");
  assert.equal(normalizeOptionRoot("EOSE  "), "EOSE");
  assert.equal(normalizeOptionRoot("AAPL  "), "AAPL");
});

test("a symbol change between open and close still pairs the round trip", () => {
  const open: LedgerRow = {
    ...OPEN_ROW,
    symbol: "EOSE  260918C00006000",
    "underlying-symbol": "EOSE",
    "executed-at": "2026-07-21T14:30:00Z",
  };
  const close: LedgerRow = {
    ...CLOSE_ROW,
    symbol: "EOSE1 260918C00006000",
    "underlying-symbol": "EOSE1",
    "executed-at": "2026-07-30T16:30:00Z",
  };

  const report = buildRealizedPnlReport([open, close]);
  assert.equal(report.trips.length, 1, "renamed contract must still pair with its open");
  assert.equal(report.trips[0]!.quantity, 2);
  assert.equal(report.reconciliation.stillOpen.length, 0);
  assert.equal(report.reconciliation.closesWithoutOpen.length, 0);
});

test("different contracts on the same root are not merged by the rename rule", () => {
  const report = buildRealizedPnlReport([
    OPEN_ROW,
    { ...CLOSE_ROW, symbol: "AAPL  260619C00110000" }, // different strike
  ]);
  assert.equal(report.trips.length, 0);
  assert.equal(report.reconciliation.stillOpen.length, 1);
  assert.equal(report.reconciliation.closesWithoutOpen.length, 1);
});

// ── Equity rows ─────────────────────────────────────────────────────────────
test("manual equity round-trips never pollute the options P&L", () => {
  const equityBuy: LedgerRow = {
    symbol: "SNWV",
    "underlying-symbol": "SNWV",
    "instrument-type": "Equity",
    "transaction-type": "Trade",
    "transaction-sub-type": "Buy to Open",
    quantity: 1000,
    value: 5000,
    "value-effect": "Debit",
    "net-value": 5000,
    "net-value-effect": "Debit",
    "executed-at": "2026-07-18T14:30:00Z",
  };
  const equitySell: LedgerRow = {
    ...equityBuy,
    "transaction-sub-type": "Sell to Close",
    value: 4000,
    "value-effect": "Credit",
    "net-value": 3999,
    "net-value-effect": "Credit",
    "executed-at": "2026-07-19T14:30:00Z",
  };

  const optionsOnly = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]);
  const mixed = buildRealizedPnlReport([OPEN_ROW, equityBuy, CLOSE_ROW, equitySell]);

  assert.equal(mixed.trips.length, 1, "only the option round trip counts");
  assert.equal(mixed.totals.netReturnPct, optionsOnly.totals.netReturnPct);
  assert.equal(mixed.totals.netCost, optionsOnly.totals.netCost);

  // …but they are reported, in their own bucket.
  assert.equal(mixed.equity.rowCount, 2);
  assert.deepEqual(mixed.equity.symbols, ["SNWV"]);
  assert.ok(near(mixed.equity.netCashFlow, -1001));
});

// ── Equity round trips ──────────────────────────────────────────────────────
// REGRESSION — 2026-08-15. Equity stopped at a row count and a `netCashFlow`
// total, printed as "EXCLUDED from the options P&L". The bot's EOD margin
// liquidation sells whatever equity is in the account — including shares the
// owner bought by hand — and four such liquidations realized a loss that appeared
// nowhere in the bot's own P&L. netCashFlow cannot stand in for that: it mixes
// money SPENT (an open still held) with money LOST.
//
// Synthetic round numbers in the SHAPE of such a liquidation: shares bought, then
// sold by the bot a day later at a loss.
const SHARE_BUY: LedgerRow = {
  symbol: "SNWV",
  "underlying-symbol": "SNWV",
  "instrument-type": "Equity",
  "transaction-type": "Trade",
  "transaction-sub-type": "Buy to Open",
  action: "Buy to Open",
  quantity: 200,
  price: 4,
  value: 800,
  "value-effect": "Debit",
  "net-value": 800,
  "net-value-effect": "Debit",
  "order-id": "900000001",
  "executed-at": "2026-08-13T14:30:00Z",
};

const SHARE_SELL_BY_BOT: LedgerRow = {
  ...SHARE_BUY,
  "transaction-sub-type": "Sell to Close",
  action: "Sell to Close",
  price: 3.8,
  value: 760,
  "value-effect": "Credit",
  "net-value": 760,
  "net-value-effect": "Credit",
  "order-id": "900000002",
  "executed-at": "2026-08-14T19:50:48Z",
};

const BOT_SOURCES = { "900000002": "tastytrade-silver-lynx" };

test("an equity round trip reports real FIFO P&L, not just a cash flow", () => {
  const equity = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT]).equity;

  assert.equal(equity.trips.length, 1, "the share round trip must be matched");
  const trip = equity.trips[0]!;
  assert.equal(trip.underlying, "SNWV");
  assert.equal(trip.quantity, 200);
  assert.ok(near(trip.netCost, 800));
  assert.ok(near(trip.netProceeds, 760));
  assert.ok(near(equity.totals.netPnl, -40), "a realized loss, now visible");
  assert.ok(near(num(equity.totals.netReturnPct), -5));
  assert.ok(num(equity.totals.netReturnPct) < 0);
});

test("equity P&L is NOT the net cash flow the report used to print", () => {
  // One closed trip plus one still-held buy. netCashFlow counts the money spent
  // on the open position; realized P&L must not.
  const stillHeld: LedgerRow = {
    ...SHARE_BUY,
    symbol: "RUM",
    "underlying-symbol": "RUM",
    quantity: 100,
    value: 320,
    "net-value": 320,
    "order-id": "900000003",
    "executed-at": "2026-08-14T15:00:00Z",
  };
  const equity = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT, stillHeld]).equity;

  assert.ok(near(equity.netCashFlow, -360), "cash flow still includes the open buy");
  assert.ok(near(equity.totals.netPnl, -40), "realized P&L excludes it");
  assert.notEqual(equity.netCashFlow.toFixed(2), equity.totals.netPnl.toFixed(2));
  assert.equal(equity.stillOpen.length, 1);
  assert.equal(equity.stillOpen[0]!.underlying, "RUM");
});

test("equity is priced at multiplier 1 — never the option ×100", () => {
  const trip = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT]).equity.trips[0]!;
  // 200 shares × 4.00 = 800. An accidental ×100 would read 80,000.
  assert.ok(near(trip.netCost / trip.quantity, 4));
  assert.ok(
    trip.netCost < 10 * trip.quantity,
    "cost basis must stay share-scaled; a ×100 inflation blows straight past this",
  );
});

test("a bot-executed close is attributed to the bot, an owner-placed one is not", () => {
  const botClosed = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT], {
    orderSources: BOT_SOURCES,
  }).equity;
  assert.equal(botClosed.trips[0]!.closedBy, "bot");
  assert.equal(botClosed.byCloser.bot.trips, 1);
  assert.equal(botClosed.byCloser.owner.trips, 0);
  assert.ok(near(botClosed.byCloser.bot.netPnl, -40), "the loss is charged to the bot");

  // An order id present in the ledger but carrying no bot prefix is the owner's.
  const handPlaced = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT], {
    orderSources: new Map([["900000002", "tastytrade-web"]]),
  }).equity;
  assert.equal(handPlaced.trips[0]!.closedBy, "owner");
  assert.equal(handPlaced.byCloser.owner.trips, 1);
  assert.equal(handPlaced.byCloser.bot.trips, 0);

  // A blank source is not evidence of the owner either — it stays unknown.
  const blankSource = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT], {
    orderSources: { "900000002": "   " },
  }).equity;
  assert.equal(blankSource.trips[0]!.closedBy, "unknown");
});

test("the legacy golden-lion order prefix still counts as bot-executed", () => {
  // Orders placed before the 2026-07-27 rename (efda628) carry the old brand.
  // Reading them as owner-placed would clear the bot of its own pre-rename fills.
  const report = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT], {
    orderSources: { "900000002": "tastytrade-golden-lion-overnight-reduction" },
  });
  assert.equal(report.equity.trips[0]!.closedBy, "bot");
  assert.equal(report.equity.byCloser.bot.trips, 1);
});

test("a suffixed bot source still matches, and missing history reads unknown", () => {
  const suffixed = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT], {
    orderSources: { "900000002": "tastytrade-silver-lynx-secret-auto-seed" },
  });
  assert.equal(suffixed.equity.trips[0]!.closedBy, "bot");

  // No order history supplied: "unknown", never "owner". Collapsing the two would
  // clear the bot of a loss purely because a lookup was unavailable.
  const noHistory = buildRealizedPnlReport([SHARE_BUY, SHARE_SELL_BY_BOT]);
  assert.equal(noHistory.equity.trips[0]!.closedBy, "unknown");
  assert.equal(noHistory.equity.byCloser.unknown.trips, 1);
  assert.equal(noHistory.equity.byCloser.owner.trips, 0);
});

test("equity P&L never blends into the options P&L", () => {
  const optionsOnly = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]);
  const mixed = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW, SHARE_BUY, SHARE_SELL_BY_BOT]);

  assert.equal(mixed.trips.length, 1, "only the option trip is in the options bucket");
  assert.equal(mixed.totals.netCost, optionsOnly.totals.netCost);
  assert.equal(mixed.totals.netPnl, optionsOnly.totals.netPnl);
  assert.equal(mixed.totals.netReturnPct, optionsOnly.totals.netReturnPct);
  assert.equal(mixed.reconciliation.trips, 1);
  // …and the equity side carries its own, separately.
  assert.equal(mixed.equity.trips.length, 1);
  assert.notEqual(mixed.equity.totals.netPnl, mixed.totals.netPnl);
});

test("option round trips split by who closed them, and the split prints only with attribution", () => {
  // The base option fixtures carry no order-id; a real close does, which is the join key to its source.
  const closeWithOrder: LedgerRow = { ...CLOSE_ROW, "order-id": "900000002" };
  // Bot-closed: the option close order (900000002) carries a bot source prefix.
  const botClosed = buildRealizedPnlReport([OPEN_ROW, closeWithOrder], { orderSources: BOT_SOURCES });
  assert.equal(botClosed.trips[0]!.closedBy, "bot");
  assert.equal(botClosed.byCloser.bot.trips, 1);
  assert.equal(botClosed.byCloser.owner.trips, 0);
  assert.ok(near(botClosed.byCloser.bot.netPnl, botClosed.totals.netPnl), "the whole P&L is the bot's");
  assert.ok(formatRealizedPnlReport(botClosed).some((l) => l.includes("BOT-EXECUTED")), "the split is printed");

  // Hand-closed: same close order id, but a non-bot source → owner.
  const handClosed = buildRealizedPnlReport([OPEN_ROW, closeWithOrder], {
    orderSources: new Map([["900000002", "tastytrade-web"]]),
  });
  assert.equal(handClosed.byCloser.owner.trips, 1);
  assert.equal(handClosed.byCloser.bot.trips, 0);
  assert.ok(formatRealizedPnlReport(handClosed).some((l) => l.includes("owner-placed")));

  // No order history → everything is "unknown" → the split restates the blend, so it is NOT printed.
  const noHistory = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]);
  assert.equal(noHistory.byCloser.unknown.trips, 1);
  const lines = formatRealizedPnlReport(noHistory).join("\n");
  assert.ok(!/BOT-EXECUTED|owner-placed|unattributed/.test(lines), "no split without attribution");
});

test("a zero-share equity row is a dividend, not a close of the whole position", () => {
  // The options matcher treats a quantity-less terminal row as "remove the rest
  // of the position at $0". Applied to equity that invents a −100% round trip out
  // of a cash event.
  const dividend: LedgerRow = {
    symbol: "SNWV",
    "underlying-symbol": "SNWV",
    "instrument-type": "Equity",
    "transaction-type": "Money Movement",
    "transaction-sub-type": "Dividend",
    quantity: 0,
    value: 4.3,
    "value-effect": "Credit",
    "net-value": 4.3,
    "net-value-effect": "Credit",
    "executed-at": "2026-08-14T13:00:00Z",
  };
  const equity = buildRealizedPnlReport([SHARE_BUY, dividend]).equity;

  assert.equal(equity.trips.length, 0, "a dividend closes nothing");
  assert.equal(equity.stillOpen.length, 1, "the shares are still held");
  assert.equal(equity.stillOpen[0]!.quantity, 200);
  assert.equal(equity.nonShareRows, 1);
  assert.equal(equity.rowCount, 2, "it is still counted and still in the cash flow");
});

test("equity FIFO handles a partial close and a pre-window sale", () => {
  const partial = buildRealizedPnlReport([
    SHARE_BUY,
    { ...SHARE_SELL_BY_BOT, quantity: 50, value: 190, "net-value": 190 },
  ]).equity;
  assert.equal(partial.trips.length, 1);
  assert.equal(partial.trips[0]!.quantity, 50);
  assert.ok(near(partial.trips[0]!.netCost, 200), "50 of 200 shares at a 4.00 basis");
  assert.equal(partial.stillOpen[0]!.quantity, 150);

  const preWindow = buildRealizedPnlReport([SHARE_SELL_BY_BOT]).equity;
  assert.equal(preWindow.trips.length, 0);
  assert.equal(preWindow.closesWithoutOpen.length, 1, "cost basis predates the window");
  assert.equal(preWindow.closesWithoutOpen[0]!.quantity, 200);
});

test("the printed report shows equity P&L and who executed the close", () => {
  const lines = formatRealizedPnlReport(
    buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW, SHARE_BUY, SHARE_SELL_BY_BOT], {
      orderSources: BOT_SOURCES,
    }),
  ).join("\n");

  assert.match(lines, /EQUITY \(shares, multiplier 1/);
  assert.match(lines, /SNWV\s+200 sh/);
  assert.match(lines, /equity blended NET/);
  assert.match(lines, /BOT-EXECUTED/);
  assert.doesNotMatch(lines, /EXCLUDED from the options P&L/);
  // The options half is untouched.
  assert.match(lines, /---- blended NET/);
  assert.match(lines, /reconciliation: rows 4 \| opens 1 \| closes 1/);
});

test("the options printout is byte-identical when equity rows are present", () => {
  // The equity section is appended; it must not perturb a single options line.
  const withoutEquity = formatRealizedPnlReport(buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]));
  const withEquity = formatRealizedPnlReport(
    buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW, SHARE_BUY, SHARE_SELL_BY_BOT]),
  );
  // Same rows-examined count aside, every options line is reproduced verbatim.
  const optionLines = withoutEquity.filter((line) => !line.includes("reconciliation"));
  for (const line of optionLines) {
    assert.ok(withEquity.includes(line), `options line changed: ${line}`);
  }
});

test("money-movement rows are skipped rather than treated as trades", () => {
  const report = buildRealizedPnlReport([
    { "transaction-type": "Money Movement", "transaction-sub-type": "Credit Interest", value: 3, "value-effect": "Credit" },
    OPEN_ROW,
    CLOSE_ROW,
  ]);
  assert.equal(report.trips.length, 1);
  assert.equal(report.reconciliation.skippedRows, 1);
  assert.equal(report.equity.rowCount, 0);
});

// ── Reconciliation ──────────────────────────────────────────────────────────
test("every open leg reaches a terminal state and the counts balance", () => {
  const stillOpenRow: LedgerRow = {
    ...OPEN_ROW,
    symbol: "RUM   260821C00009000",
    "underlying-symbol": "RUM",
    "executed-at": "2026-08-01T14:30:00Z",
  };
  const preWindowClose: LedgerRow = {
    ...CLOSE_ROW,
    symbol: "TSLA  260619C00300000",
    "underlying-symbol": "TSLA",
    "executed-at": "2026-07-18T16:30:00Z",
  };

  const report = buildRealizedPnlReport([
    OPEN_ROW,
    CLOSE_ROW,
    EXPIRED_OPEN_ROW,
    EXPIRATION_ROW,
    stillOpenRow,
    preWindowClose,
  ]);
  const r = report.reconciliation;

  assert.equal(r.rowsExamined, 6);
  assert.equal(r.openLegs, 3);
  assert.equal(r.closeLegs, 2);
  assert.equal(r.expirationLegs, 1);
  assert.equal(r.trips, 2);
  assert.equal(r.stillOpen.length, 1);
  assert.equal(r.stillOpen[0]!.underlying, "RUM");
  assert.equal(r.closesWithoutOpen.length, 1);
  assert.equal(r.closesWithoutOpen[0]!.underlying, "TSLA");

  // Contract-level conservation: opened contracts = matched + still open.
  const openedContracts = 2 + 5 + 2;
  const matched = report.trips.reduce((s, t) => s + t.quantity, 0);
  const dangling = r.stillOpen.reduce((s, l) => s + l.quantity, 0);
  assert.equal(matched + dangling, openedContracts);
});

test("the printed report surfaces reconciliation, fees and dangling legs", () => {
  const lines = formatRealizedPnlReport(
    buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW, EXPIRED_OPEN_ROW, EXPIRATION_ROW]),
  ).join("\n");

  assert.match(lines, /reconciliation: rows 4 \| opens 2 \| closes 1 \| expirations 1 \| trips 2/);
  assert.match(lines, /gross \(pre-fee\)/);
  assert.match(lines, /fee/i);
  assert.match(lines, /Expiration/);
});

test("an all-expired window reports -100% instead of an empty report", () => {
  const report = buildRealizedPnlReport([EXPIRED_OPEN_ROW, EXPIRATION_ROW]);
  const lines = formatRealizedPnlReport(report).join("\n");
  assert.doesNotMatch(lines, /no round trips closed/);
  assert.match(lines, /-100\.0%/);
});

test("an empty ledger degrades to an explicit empty report", () => {
  const report = buildRealizedPnlReport([]);
  assert.equal(report.trips.length, 0);
  assert.equal(report.totals.netReturnPct, null);
  assert.match(formatRealizedPnlReport(report).join("\n"), /no round trips closed/);
});
