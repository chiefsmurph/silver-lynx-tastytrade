/**
 * Position provenance — who opened this position, the bot or the owner?
 *
 * WHY THIS EXISTS. The owner hand-places "double-down" orders in the margin
 * account from the tastytrade app. Until now the bot could not tell those apart
 * from its own, so it managed them as its own (stopped them out, added to them,
 * swept them at the margin EOD liquidation) and mis-attributed their P&L to
 * itself. On 2026-08-08 a single hand-placed position was the large majority of
 * the window's loss and was initially credited to the bot.
 *
 * HOW WE KNOW. tastytrade's order API takes a client-supplied `source` string on
 * submission (`OrderRequest.source` is REQUIRED — see `core/types.ts`) and
 * echoes it back on every order read (`TastytradeOrder.source`). This bot has
 * always populated it (`order-sources.ts`). So provenance is already recorded at
 * the BROKER, on the order itself, and no local ledger is needed: the record
 * survives restarts, fresh deploys, and a wiped `data/` directory, none of which
 * a local file would. We read it back rather than re-deriving it.
 *
 * THREE DECISION STATES, NOT TWO. The decision is MANAGED / DO-NOT-TOUCH /
 * UNKNOWN, and provenance carries a fourth value so the observation log can say
 * WHY something is hands-off:
 *
 *   - `bot`            — every opening order carries one of our STRATEGY tags.      => managed
 *   - `manual`         — an opening order carries a source that is POSITIVELY
 *                        someone else's (present, non-empty, not ours).            => do-not-touch
 *   - `owner-directed` — placed by this process but on the owner's instruction
 *                        (the planned SMS path). His conviction, his exit.         => do-not-touch
 *   - `unknown`        — we could not positively identify the opener: no opening
 *                        order in the lookback window, the history call failed,
 *                        or the order came back with a blank source.               => MANAGED (as today)
 *
 * `unknown` MUST behave exactly like today (manage normally). The failure mode
 * we are guarding against is a missing/short/failed history read being read as
 * "manual" and silently disarming every stop in the account — strictly worse
 * than the problem this module solves. Every "we don't know" path in here
 * therefore resolves to `unknown`, never to a hands-off state. See the tests.
 *
 * DERIVED FROM THE SOURCE, NOT FROM MERE PRESENCE. The hands-off decision reads
 * the source CATEGORY, never "did we find a record for this order". That is what
 * lets `owner-directed` be a bot-placed order that is nonetheless hands-off, and
 * it is why adding the SMS path is a one-line change (pass the new source) rather
 * than a refactor.
 *
 * EQUITY IS COVERED. The owner hand-buys SHARES, not only contracts. An equity
 * order has no C/P suffix, so it keys as `TICKER::none` through the SAME
 * `getOrderGroupKey` path as options, and `do-not-touch-groups.ts` already
 * aliases `::none` <-> `::stock` (commit f99b67c). No second stock-detection
 * path is introduced here.
 */

import { TastytradeOrder } from "~/core/types";
import { readEnvBool, readEnvInt } from "~/core/env-utils";
import { buildGroupKey, getOrderGroupKey } from "./do-not-touch-groups";
import { isBotOrderSource, isOwnerDirectedOrderSource } from "./order-sources";

export type PositionProvenance = "bot" | "manual" | "owner-directed" | "unknown";

/**
 * The one place the hands-off decision is made. `unknown` is deliberately absent
 * from the hands-off set — that is the safety invariant this whole module exists
 * to protect, asserted directly in the tests.
 */
export function isDoNotTouchProvenance(provenance: PositionProvenance): boolean {
  return provenance === "manual" || provenance === "owner-directed";
}

/** Managed normally by the strategy. `unknown` lives here on purpose. */
export function isManagedProvenance(provenance: PositionProvenance): boolean {
  return !isDoNotTouchProvenance(provenance);
}

/** Opening actions. A position's provenance is decided by who OPENED it. */
const OPENING_ACTIONS = new Set(["Buy to Open", "Sell to Open", "Buy", "Allocate"]);

/** Terminal statuses that actually moved contracts. A rejected order opened nothing. */
const FILLED_STATUSES = new Set(["filled", "partially filled"]);

// `isBotOrderSource` — including its dual-aware, migration-safe list of every
// brand-era prefix the bot has ever stamped — lives in `order-sources.ts`, the
// single source of truth for source classification. Re-exported here so existing
// importers of `~/bot/position-provenance` keep working unchanged.
export { isBotOrderSource };

/**
 * Classify ONE order's source string.
 *
 * A blank/missing source resolves to `unknown`, NOT `manual`: the field is
 * optional on the read side, and an omission by the API is not evidence that a
 * human placed the order.
 *
 * Order matters — the owner-directed tag shares our brand prefix, so it must be
 * tested BEFORE the bot-prefix check or the SMS path would classify as `bot` and
 * get flattened by the margin EOD sweep.
 */
export function classifyOrderSource(
  source: string | null | undefined,
): PositionProvenance {
  const normalized = String(source ?? "").trim();
  if (!normalized) return "unknown";
  if (isOwnerDirectedOrderSource(normalized)) return "owner-directed";
  return isBotOrderSource(normalized) ? "bot" : "manual";
}

function isOpeningOrder(order: TastytradeOrder): boolean {
  const status = String(order.status ?? "").trim().toLowerCase();
  if (!FILLED_STATUSES.has(status)) return false;
  return (order.legs ?? []).some((leg) => OPENING_ACTIONS.has(String(leg.action ?? "").trim()));
}

/**
 * Roll a group's opening orders up to a single provenance.
 *
 * Ordering of the rules is the safety property:
 *   1. no opening orders at all       -> `unknown` (we never saw the opener)
 *   2. ANY positively-manual opener   -> `manual`
 *   3. ANY owner-directed opener      -> `owner-directed`
 *   4. ANY indeterminate opener       -> `unknown`
 *   5. otherwise                      -> `bot`
 *
 * Rules 2 and 3 outrank rule 4 on purpose. A group is one fungible pile: if the
 * owner hand-added to a position the bot opened, the bot cannot sell only its own
 * shares/contracts, so any sell would be selling his. He owns that exit.
 * Conversely rule 4 outranks rule 5, so a group is only called `bot` when every
 * opener is positively identified as ours.
 */
export function classifyGroupProvenance(
  openingOrders: readonly TastytradeOrder[] | null | undefined,
): PositionProvenance {
  const orders = openingOrders ?? [];
  if (orders.length === 0) return "unknown";

  const classifications = orders.map((order) => classifyOrderSource(order.source));
  if (classifications.includes("manual")) return "manual";
  if (classifications.includes("owner-directed")) return "owner-directed";
  if (classifications.includes("unknown")) return "unknown";
  return "bot";
}

/** Arms the auto do-not-touch. OFF by default — classification still logs. */
export function isManualProvenanceAutoProtectEnabled(): boolean {
  return readEnvBool("BOT_MANUAL_PROVENANCE_AUTO_PROTECT", false);
}

/** How far back to read order history when looking for a position's opener. */
export function getManualProvenanceLookbackDays(): number {
  return readEnvInt("BOT_MANUAL_PROVENANCE_LOOKBACK_DAYS", 90, (n) => n > 0);
}

/**
 * Bucket filled opening orders by `UNDERLYING::side`.
 *
 * Equity orders flow through the very same `getOrderGroupKey`: a share symbol has
 * no C/P suffix, so `inferOptionSide` returns null and the order keys as
 * `TICKER::NONE` — which `do-not-touch-groups.ts` already aliases to `::STOCK`.
 *
 * The only extra step is a fallback for equity orders that arrive WITHOUT an
 * `underlying-symbol` (the field is really an option concept): we rebuild the key
 * from the equity leg's own symbol via the shared `buildGroupKey`. Orders we still
 * cannot key are dropped rather than guessed — a mis-keyed order would attach one
 * group's provenance to another, and dropping only ever costs us an `unknown`,
 * which is the safe direction.
 */
export function groupOpeningOrdersByGroupKey(
  orders: readonly TastytradeOrder[],
): Map<string, TastytradeOrder[]> {
  const byGroup = new Map<string, TastytradeOrder[]>();
  for (const order of orders) {
    if (!isOpeningOrder(order)) continue;
    const groupKey = getOrderGroupKey(order) ?? equityGroupKeyFallback(order);
    if (!groupKey) continue;
    const normalized = groupKey.toUpperCase();
    const bucket = byGroup.get(normalized);
    if (bucket) bucket.push(order);
    else byGroup.set(normalized, [order]);
  }
  return byGroup;
}

/** `TICKER::none` for an equity order whose `underlying-symbol` is absent. */
function equityGroupKeyFallback(order: TastytradeOrder): string | null {
  const equityLeg = (order.legs ?? []).find(
    (leg) => String(leg["instrument-type"] ?? "").trim() === "Equity",
  );
  const symbol = String(equityLeg?.symbol ?? "").trim();
  return symbol ? buildGroupKey(symbol, "none") : null;
}

export interface ProvenanceReport {
  /** `UNDERLYING::side` (uppercased) -> provenance. */
  byGroupKey: Map<string, PositionProvenance>;
  /** Group keys positively identified as the owner's. Empty when history is unavailable. */
  manualGroupKeys: Set<string>;
  /** False when order history could not be read — every group is then `unknown`. */
  historyAvailable: boolean;
  /** Set when the history read failed, for the observation log. */
  error?: string;
}

export function lookbackStartDate(now: Date, lookbackDays: number): string {
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}

export interface BuildProvenanceReportOptions {
  accountNumber: string;
  groupKeys: readonly string[];
  /** Injected for tests; defaults to the live order service at the call site. */
  fetchOrders: (
    accountNumber: string,
    queryParams: Record<string, unknown>,
  ) => Promise<TastytradeOrder[]>;
  now?: Date;
  lookbackDays?: number;
}

/**
 * Read order history once and classify every live group against it.
 *
 * Deliberately NOT paginated. We request the most recent page of filled orders;
 * anything older than that page falls off and its group resolves to `unknown`,
 * i.e. managed exactly as today. Truncation therefore fails safe, so a bounded
 * single call is the right trade rather than a loop that could stall a cycle.
 */
export async function buildProvenanceReport(
  options: BuildProvenanceReportOptions,
): Promise<ProvenanceReport> {
  const { accountNumber, groupKeys, fetchOrders } = options;
  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? getManualProvenanceLookbackDays();

  const byGroupKey = new Map<string, PositionProvenance>();
  const manualGroupKeys = new Set<string>();

  let orders: TastytradeOrder[];
  try {
    orders = await fetchOrders(accountNumber, {
      "start-date": lookbackStartDate(now, lookbackDays),
      // The orders endpoint hard-caps per-page at 100 and REJECTS anything larger
      // with a 400 (it does not clamp). Requesting 250 made every provenance read
      // fail, so every group fell back to `unknown` and nothing was ever protected.
      // 100 is the max single page; older orders fall off and resolve to `unknown`
      // (managed as today) — the deliberate single-call trade documented above.
      "per-page": 100,
    });
  } catch (error) {
    // History unreadable => we know nothing => everything stays `unknown` and
    // therefore keeps being managed exactly as it is today. Never `manual`.
    for (const groupKey of groupKeys) {
      byGroupKey.set(groupKey.toUpperCase(), "unknown");
    }
    return {
      byGroupKey,
      manualGroupKeys,
      historyAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const openingOrdersByGroup = groupOpeningOrdersByGroupKey(orders ?? []);

  for (const rawGroupKey of groupKeys) {
    const groupKey = rawGroupKey.toUpperCase();
    const provenance = classifyGroupProvenance(openingOrdersByGroup.get(groupKey));
    byGroupKey.set(groupKey, provenance);
    if (provenance === "manual") manualGroupKeys.add(groupKey);
  }

  return { byGroupKey, manualGroupKeys, historyAvailable: true };
}

/**
 * The observation log. Emitted EVERY cycle whether or not the flag is armed —
 * a dark launch is only worth running if it produces the evidence to arm it.
 * `armed` records whether this classification actually changed behaviour.
 */
export function logProvenanceReport(
  accountNumber: string,
  report: ProvenanceReport,
  armed: boolean,
): void {
  const groups = [...report.byGroupKey.entries()].map(([groupKey, provenance]) => ({
    groupKey,
    provenance,
  }));
  console.log(
    JSON.stringify({
      scope: "position-provenance",
      accountNumber,
      armed,
      historyAvailable: report.historyAvailable,
      ...(report.error ? { error: report.error } : {}),
      counts: {
        bot: groups.filter((g) => g.provenance === "bot").length,
        manual: groups.filter((g) => g.provenance === "manual").length,
        unknown: groups.filter((g) => g.provenance === "unknown").length,
      },
      // The actionable line: which groups WOULD be (or ARE) left alone.
      manualGroupKeys: [...report.manualGroupKeys],
      groups,
    }),
  );

  if (!report.historyAvailable) {
    console.warn(
      JSON.stringify({
        scope: "position-provenance-degraded",
        accountNumber,
        message:
          "order history unavailable - every group classified UNKNOWN and managed normally",
        error: report.error,
      }),
    );
  }
}
