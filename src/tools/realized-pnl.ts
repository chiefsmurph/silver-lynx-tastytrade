// Authoritative realized round-trips for a date window, straight from the
// tastytrade transaction ledger (getAccountTransactions). Read-only.
//
//   node --import tsx src/tools/realized-pnl.ts 2026-07-20
//
// The data-pull run NDJSON is a per-cycle DECISION log and misses async fill
// confirmations, so it under-reports (and can mislabel a realized win as
// "idle"). This ledger is the truth: it matches every opening leg to a terminal
// event (Sell-to-Close OR expiration/assignment), FIFO, options and equity
// separately, and prints realized $ + %.
//
// PAGING (regression, 2026-08-15)
// This used to issue ONE request. The endpoint is paginated and caps a page at
// 250 rows, so any window longer than that was silently cut off — and the bias
// grows with the window, which is the opposite of what a reader assumes. The old
// comment here claimed a truncated fetch would be visible as "a suspiciously
// round count"; nothing actually checked, and nobody ever noticed.
//
// Two things make the fix safe rather than merely longer:
//   1. the SDK's extractResponseData throws away the `pagination` envelope, so
//      the loop cannot rely on `total-pages` being present and must also be able
//      to stop on a short page;
//   2. an API that IGNORES an unrecognised paging param returns page 1 forever,
//      and a loop that trusted the offset would concatenate duplicates into a
//      confidently doubled P&L. Every row is therefore identity-deduped, and a
//      page that adds nothing new STOPS the loop and marks the window
//      incomplete. The worst case is "we read less and say so, loudly".
//
// All matching arithmetic, response-shape parsing and the paging loop itself live
// in realized-pnl-report.ts so they can be tested without a broker session; this
// file only supplies the broker calls and prints.
import { config } from "dotenv";

import { writeFileSync } from "node:fs";

import {
  buildOrderSourceIndex,
  buildRealizedPnlReport,
  fetchAllPages,
  formatRealizedPnlReport,
  type CloserSlice,
  type RealizedPnlReport,
} from "./realized-pnl-report";

config();

// Optional machine-readable side-output for the Owl dashboard: set REALIZED_PNL_JSON to a path and
// the run also writes a compact per-account summary (deposit-adjusted P&L + bot-vs-owner split) there.
const round = (n: number): number => Math.round(n);
function closerJson(s: CloserSlice): { trips: number; net: number; netPct: number | null; cost: number } {
  return { trips: s.trips, net: round(s.netPnl), netPct: s.netReturnPct, cost: round(s.netCost) };
}
function summarize(account: string, label: string, report: RealizedPnlReport): Record<string, unknown> {
  const o = report.totals;
  return {
    account,
    label,
    options: {
      net: round(o.netPnl),
      netPct: o.netReturnPct,
      cost: round(o.netCost),
      fees: round(o.fees),
      byCloser: {
        bot: closerJson(report.byCloser.bot),
        owner: closerJson(report.byCloser.owner),
        unknown: closerJson(report.byCloser.unknown),
      },
    },
    equity: { netCashFlow: round(report.equity.netCashFlow), net: round(report.equity.totals.netPnl) },
    complete: !report.fetchAudit?.incomplete,
  };
}

const ACCOUNTS: [string, string][] = [
  ["5WU18519", "cash"],
  ["5WI88116", "margin"],
];

type TransactionsService = {
  getAccountTransactions: (account: string, params: Record<string, unknown>) => Promise<unknown>;
};

type OrderService = {
  getOrders: (account: string, params?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * order-id → order `source`, the only way to tell a bot-caused fill from one the
 * owner placed by hand. A failure here degrades the report to "unattributed"
 * rather than silently reading every close as owner-placed.
 */
async function fetchOrderSources(
  orders: OrderService,
  account: string,
  startDate: string,
): Promise<Map<string, string>> {
  const { rows, audit } = await fetchAllPages(
    (params) => orders.getOrders(account, { "start-date": startDate, ...params }),
    100, // the orders endpoint hard-caps per-page at 100 and 400s on anything larger (transactions allow 250)
  );
  if (audit.incomplete) {
    console.log(
      `  order-history incomplete (${audit.reason}) — ` +
        "some closes will read \"unattributed\" rather than being mis-attributed.",
    );
  }
  return buildOrderSourceIndex(rows);
}

async function reportAccount(
  svc: TransactionsService,
  orders: OrderService,
  account: string,
  label: string,
  startDate: string,
): Promise<Record<string, unknown> | null> {
  console.log(`\n=== ${label} (${account}) — realized round-trips since ${startDate} ===`);

  const { rows, audit } = await fetchAllPages((params) =>
    svc.getAccountTransactions(account, { "start-date": startDate, ...params }),
  );
  if (rows.length === 0 && audit.incomplete) {
    console.log(`  ledger error: ${audit.reason}`);
    return null;
  }

  const orderSources = await fetchOrderSources(orders, account, startDate);
  const report = buildRealizedPnlReport(rows, { orderSources, fetchAudit: audit });
  for (const line of formatRealizedPnlReport(report)) {
    console.log(line);
  }
  return summarize(account, label, report);
}

async function main() {
  const startDate = process.argv[2] ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { default: api } = await import("../core/tastytrade-client");
  const client = api as unknown as {
    transactionsService: TransactionsService;
    orderService: OrderService;
  };

  const accounts: Record<string, unknown>[] = [];
  for (const [account, label] of ACCOUNTS) {
    const summary = await reportAccount(client.transactionsService, client.orderService, account, label, startDate);
    if (summary) accounts.push(summary);
  }

  const jsonPath = process.env.REALIZED_PNL_JSON;
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), startDate, accounts }, null, 2));
    console.log(`\n  → wrote ${jsonPath} (${accounts.length} accounts) for the Owl dashboard`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
