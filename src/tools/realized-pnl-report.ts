// Pure round-trip matching for the tastytrade transaction ledger. Split out of
// realized-pnl.ts so the arithmetic is testable without a broker session.
//
// WHY THIS EXISTS IN THIS SHAPE (regression, 2026-08-08)
// The first version of this report understated realized loss by roughly 3×:
//
//   1. Expired-worthless contracts vanished. The open leg had no Sell-to-Close to
//      pair with, so it sat forever in the FIFO map and was never printed — a
//      −100% outcome silently left the report. Every open leg now reaches a
//      terminal state (closed / expired / explicitly still-open) and the
//      reconciliation counts prove it.
//   2. It priced trips off `value`, which excludes commissions and fees. Opening
//      costs roughly $1/contract and closing roughly $0.12, which is material at
//      this book's premium sizes. `net-value` is the default now, with the gross
//      figure kept alongside so the fee drag is visible rather than buried.
//
// Also handled, because both were hit in practice: OCC root changes across a
// corporate action (EOSE → EOSE1) must still pair, and manual EQUITY round-trips
// in these accounts must never land in an options P&L.
//
// EQUITY P&L (2026-08-15)
// Equity rows used to stop at a row count and a `netCashFlow` total, printed as
// "EXCLUDED from the options P&L". That hid real, realized, BOT-CAUSED losses:
// the EOD margin liquidation sells whatever equity is in the account, including
// shares the owner bought by hand, and four such liquidations were realized at a
// loss with no P&L anywhere in this report. `netCashFlow` is not a proxy for
// them — it conflates money spent (an open that is still held) with money lost.
//
// So equity now runs the SAME FIFO matcher as options, and every round trip is
// attributed to whoever closed it. Two rules the shared matcher must respect:
//
//   * NO ×100. `multiplier` is "1.0" for equity and "100.0" for options
//     (evaluate-position.ts:86-90). The matcher never multiplies: it prices off
//     the row's CASH (`net-value`), so the multiplier is already baked in and
//     applying one would inflate equity by 100× — the exact defect that made
//     pnl-ledger's equity rows unreadable.
//   * NO expirations. Shares do not expire, and a zero-quantity terminal row
//     (a dividend) must not be read as "close the whole position at $0". That
//     rule is correct for options and catastrophic for equity, so it is scoped
//     to options only.
import { isOccOptionSymbol } from "~/bot/actions/order-utils";
import { isBotOrderSource } from "~/bot/order-sources";

export type LedgerRow = Record<string, unknown>;

export type LegKind = "open" | "close" | "expiration";
export type InstrumentClass = "option" | "equity" | "other";

export interface NormalizedLeg {
  symbol: string;
  /** FIFO bucket. Normalizes the OCC root so a renamed contract still pairs. */
  matchKey: string;
  underlying: string;
  quantity: number;
  /** Signed cash: positive = credit received, negative = debit paid. */
  signedGross: number;
  signedNet: number;
  executedAt: string;
  kind: LegKind;
  /** Raw transaction-sub-type, kept for the printed label ("Expiration"). */
  subType: string;
  instrument: InstrumentClass;
  /** Broker order id, the only join key back to the order's `source` tag. */
  orderId: string | null;
}

/** Who placed the order that closed a round trip. */
export type Closer = "bot" | "owner" | "unknown";

export interface Trip {
  underlying: string;
  openSymbol: string;
  closeSymbol: string;
  quantity: number;
  grossCost: number;
  netCost: number;
  grossProceeds: number;
  netProceeds: number;
  openedAt: string;
  closedAt: string;
  outcome: "closed" | "expired";
  subType: string;
  /** Order id of the CLOSING leg, when the ledger row carries one. */
  closeOrderId: string | null;
  /** `source` of that order. Null when no order history was supplied. */
  closeSource: string | null;
  /**
   * "bot"     — the close carried one of this bot's order-source prefixes
   * "owner"   — the order exists and carries no bot prefix (hand-placed)
   * "unknown" — no order history supplied, or the row has no order id
   */
  closedBy: Closer;
}

export interface DanglingLeg {
  symbol: string;
  underlying: string;
  quantity: number;
  netAmount: number;
  executedAt: string;
}

export interface Reconciliation {
  /** Ledger rows handed to the report, before any classification. */
  rowsExamined: number;
  openLegs: number;
  closeLegs: number;
  expirationLegs: number;
  trips: number;
  /** Opens with no terminal event in the window — still held. */
  stillOpen: DanglingLeg[];
  /** Closes/expirations whose open leg predates the window. */
  closesWithoutOpen: DanglingLeg[];
  skippedRows: number;
}

export interface BlendedTotals {
  grossCost: number;
  netCost: number;
  grossProceeds: number;
  netProceeds: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
  netReturnPct: number | null;
  grossReturnPct: number | null;
  /** Fee cost expressed in percentage points of deployed (net) cost basis. */
  feeDragPp: number | null;
}

/** A blended slice of trips, used to split equity P&L by who closed it. */
export interface CloserSlice extends BlendedTotals {
  trips: number;
}

export interface EquitySummary {
  /** Every equity ledger row, share-moving or not. Unchanged shape. */
  rowCount: number;
  symbols: string[];
  /** Raw cash delta. Kept because it is NOT P&L and the difference matters. */
  netCashFlow: number;
  /** FIFO-matched share round trips. */
  trips: Trip[];
  totals: BlendedTotals;
  /** The whole point: which realized equity P&L did the bot itself cause? */
  byCloser: Record<Closer, CloserSlice>;
  stillOpen: DanglingLeg[];
  closesWithoutOpen: DanglingLeg[];
  /** Equity rows carrying no share movement (dividends, fees) — never matched. */
  nonShareRows: number;
}

/**
 * One page of a tastytrade list response, normalized.
 *
 * The SDK's `extractResponseData` returns `data.data.items` and THROWS AWAY the
 * `pagination` envelope, so a caller using the service method cannot see that
 * more rows exist. That is why `totalItems`/`totalPages` are nullable and why the
 * paging loop must also be able to terminate on a short page alone.
 */
export interface LedgerPage {
  items: unknown[];
  totalItems: number | null;
  totalPages: number | null;
  perPage: number | null;
  pageOffset: number | null;
}

/**
 * Proof of how much of the window was actually read.
 *
 * REGRESSION — 2026-08-15. The tool issued ONE unpaged request and the API caps a
 * page at 250 rows, so every window longer than that was silently truncated —
 * roughly a quarter of the history dropped, and biased worse the LONGER the
 * window, which is exactly backwards from what a reader assumes. The file's own
 * comment predicted the failure ("a suspiciously round count") but nothing
 * checked for it. A wrong number that looks complete is worse than an error, so
 * this now rides along with the report and is printed every time.
 */
export interface FetchAudit {
  rowsFetched: number;
  pagesFetched: number;
  /** What the API says exists, when it tells us. Null = it did not. */
  reportedTotalItems: number | null;
  perPage: number | null;
  /** True when we cannot PROVE the whole window was read. */
  incomplete: boolean;
  reason: string | null;
}

export interface RealizedPnlReport {
  trips: Trip[];
  totals: BlendedTotals;
  reconciliation: Reconciliation;
  equity: EquitySummary;
  /** Null when the caller did not page (and so cannot vouch for completeness). */
  fetchAudit: FetchAudit | null;
}

/**
 * Order-id → order `source`, built from the broker's order history. Without it
 * every close reads "unknown" rather than being guessed at: an unattributed loss
 * must never be silently printed as owner-caused.
 */
export type OrderSourceLookup = Map<string, string> | Record<string, string>;

export interface RealizedPnlOptions {
  orderSources?: OrderSourceLookup;
  fetchAudit?: FetchAudit;
}

function readString(row: LedgerRow, key: string): string {
  return String(row?.[key] ?? "").trim();
}

/** First finite number among `keys`, tolerating both wire and camelCase spellings. */
function readNumber(source: Record<string, unknown> | null, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize one page of a tastytrade list response.
 *
 * Deliberately shape-tolerant, because the same call can arrive three ways: the
 * SDK service hands back a bare items array (pagination already discarded), the
 * raw http client hands back an axios response, and the body in between nests
 * items under `data`. Guessing one shape and silently reading zero rows from the
 * others is precisely the class of bug this function exists to close.
 */
export function readLedgerPage(res: unknown): LedgerPage {
  if (Array.isArray(res)) {
    return { items: res, totalItems: null, totalPages: null, perPage: null, pageOffset: null };
  }

  const outer = asRecord(res);
  // An axios response carries `status`; unwrap it to the body it holds.
  const body = outer && typeof outer.status === "number" ? asRecord(outer.data) : outer;
  const inner = asRecord(body?.data);

  const itemsSource = inner?.items ?? body?.items ?? body?.data;
  const items = Array.isArray(itemsSource) ? itemsSource : [];
  const pagination = asRecord(body?.pagination);

  return {
    items,
    totalItems: readNumber(pagination, ["total-items", "totalItems"]),
    totalPages: readNumber(pagination, ["total-pages", "totalPages"]),
    perPage: readNumber(pagination, ["per-page", "perPage"]),
    pageOffset: readNumber(pagination, ["page-offset", "pageOffset"]),
  };
}

/**
 * Stable identity for a ledger/order row, used to prove a fetched page is new.
 *
 * This is the safety net under paging. The paging query params are not verifiable
 * offline, and an API that IGNORES an unrecognised param happily returns page 1
 * forever — so a loop that trusts the offset would concatenate the same rows N
 * times and report a confidently doubled P&L. Identity-deduping makes the worst
 * case "we stop early and say so", never "we invent trades".
 */
export function rowIdentity(row: unknown, index: number): string {
  const record = asRecord(row);
  const id = String(record?.id ?? "").trim();
  if (id) return `id:${id}`;
  const fallback = [
    String(record?.["executed-at"] ?? ""),
    String(record?.symbol ?? ""),
    String(record?.["transaction-sub-type"] ?? ""),
    String(record?.["net-value"] ?? record?.value ?? ""),
  ].join("|");
  return fallback.replace(/\|+$/, "") || `index:${index}`;
}

/** order-id → `source`, from broker order rows. Pure so it is actually testable. */
export function buildOrderSourceIndex(rows: unknown[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const order = asRecord(raw);
    const id = String(order?.id ?? "").trim();
    const source = String(order?.source ?? "").trim();
    if (id && source) index.set(id, source);
  }
  return index;
}

/** The API's own per-page maximum. Asking for more is silently clamped. */
export const LEDGER_PER_PAGE = 250;
/** Loop guard. Hitting it is reported as an incomplete window, never ignored. */
export const LEDGER_MAX_PAGES = 40;

export type ListFetcher = (params: Record<string, unknown>) => Promise<unknown>;

export interface PagedFetchResult {
  rows: unknown[];
  audit: FetchAudit;
}

/**
 * Walk every page of a paginated tastytrade list endpoint.
 *
 * Termination, in order: a fetch error, an empty page, a page whose rows we have
 * ALL seen before, the API's own total-pages, a short page, or the safety cap.
 * Every non-clean exit becomes a reason on the audit.
 *
 * The dedupe is not belt-and-braces, it is the correctness guarantee. The paging
 * params cannot be verified without calling the broker, and an API that ignores
 * an unrecognised param serves page 1 forever — so a loop that trusted the offset
 * would concatenate the same rows N times and report a doubled P&L. With the
 * dedupe the worst case is reading less and saying so.
 */
export async function fetchAllPages(fetchPage: ListFetcher, perPage: number = LEDGER_PER_PAGE): Promise<PagedFetchResult> {
  const pages: LedgerPage[] = [];
  const seen = new Set<string>();
  const rows: unknown[] = [];
  let error: string | null = null;
  let stalled = false;

  for (let offset = 0; pages.length < LEDGER_MAX_PAGES; offset += 1) {
    const res = await fetchPage({
      "per-page": perPage,
      "page-offset": offset,
    }).catch((cause: Error) => {
      error = cause?.message ?? String(cause);
      return null;
    });
    if (res === null && error !== null) break;

    const page = readLedgerPage(res);
    pages.push(page);
    if (page.items.length === 0) break;

    const before = rows.length;
    page.items.forEach((row, index) => {
      const identity = rowIdentity(row, offset * perPage + index);
      if (seen.has(identity)) return;
      seen.add(identity);
      rows.push(row);
    });

    // Nothing new: the endpoint is replaying a page rather than advancing.
    if (rows.length === before) {
      stalled = true;
      break;
    }
    if (page.totalPages !== null && offset + 1 >= page.totalPages) break;
    if (page.totalPages === null && page.items.length < perPage) break;
  }

  return {
    rows,
    audit: summarizeFetch({
      pages,
      rowsFetched: rows.length,
      pageCap: LEDGER_MAX_PAGES,
      stalled,
      error,
    }),
  };
}

export interface FetchSummaryInput {
  pages: LedgerPage[];
  rowsFetched: number;
  /** Loop guard ceiling; hitting it means the window may be longer than we read. */
  pageCap: number;
  /** Set when a page stopped returning NEW rows — see rowIdentity. */
  stalled?: boolean;
  error?: string | null;
}

/**
 * Decide whether the fetch can be vouched for. Errs toward "incomplete": the
 * failure this replaces was a partial answer that looked whole.
 */
// fallow-ignore-next-line complexity
export function summarizeFetch(input: FetchSummaryInput): FetchAudit {
  const { pages, rowsFetched, pageCap } = input;
  const last = pages[pages.length - 1];
  const reportedTotalItems = pages.reduce<number | null>(
    (found, page) => (page.totalItems === null ? found : page.totalItems),
    null,
  );
  const perPage = last?.perPage ?? null;

  let reason: string | null = null;
  if (input.error) {
    reason = `fetch failed mid-window (${input.error})`;
  } else if (input.stalled) {
    reason = "a page returned no new rows — the API may be ignoring the paging params";
  } else if (pages.length >= pageCap) {
    reason = `hit the ${pageCap}-page safety cap`;
  } else if (reportedTotalItems !== null && rowsFetched < reportedTotalItems) {
    reason = `API reports ${reportedTotalItems} rows available`;
  }

  return {
    rowsFetched,
    pagesFetched: pages.length,
    reportedTotalItems,
    perPage,
    incomplete: reason !== null,
    reason,
  };
}

/**
 * Signed cash for a value/effect pair. tastytrade reports magnitudes plus a
 * Debit/Credit flag; a missing flag (zero-value expiration rows) is taken as-is.
 */
function signedAmount(row: LedgerRow, valueKey: string, effectKey: string): number | null {
  const raw = Number(row?.[valueKey]);
  if (!Number.isFinite(raw)) return null;
  const effect = readString(row, effectKey).toLowerCase();
  if (effect === "debit") return -Math.abs(raw);
  if (effect === "credit") return Math.abs(raw);
  return raw;
}

export function classifyInstrument(row: LedgerRow): InstrumentClass {
  const symbol = readString(row, "symbol");
  const instrumentType = readString(row, "instrument-type");
  if (isOccOptionSymbol(symbol) || /option/i.test(instrumentType)) return "option";
  if (!symbol) return "other";
  if (/equity|stock/i.test(instrumentType)) return "equity";
  return "other";
}

/**
 * open / close / expiration.
 *
 * Expirations are the load-bearing case: they arrive as `Receive Deliver` with a
 * sub-type of Expiration (or an Assignment/Exercise removal), never as a
 * Sell-to-Close, and the old filter dropped them entirely. Anything that removes
 * an option leg without being an opening trade terminates the FIFO lot here.
 */
// fallow-ignore-next-line complexity
export function classifyLegKind(row: LedgerRow, instrument: InstrumentClass = "option"): LegKind {
  const subType = readString(row, "transaction-sub-type");
  const transactionType = readString(row, "transaction-type");
  const action = readString(row, "action");
  const description = readString(row, "description");

  // Shares never expire. Routing an equity row down the option path would read a
  // corporate action — or a dividend, which moves zero shares — as "this position
  // terminated at $0", inventing a −100% round trip out of a cash event.
  if (instrument !== "equity") {
    if (/expir/i.test(subType) || /expir/i.test(description)) return "expiration";
    if (/assign|exercis/i.test(subType)) return "expiration";
  }
  if (/open/i.test(subType) || /open/i.test(action)) return "open";
  if (/close/i.test(subType) || /close/i.test(action)) return "close";
  if (instrument === "equity") {
    // Plain "Buy"/"Sell" carry no position effect; direction is the whole signal.
    if (/^buy/i.test(subType) || /^buy/i.test(action)) return "open";
    if (/^sell/i.test(subType) || /^sell/i.test(action)) return "close";
  } else if (/receive\s*deliver/i.test(transactionType)) {
    // Any other Receive Deliver row removes the leg rather than trading it.
    return "expiration";
  }
  // Last resort, the pre-fix heuristic: money out = we bought.
  return (signedAmount(row, "value", "value-effect") ?? 0) < 0 ? "open" : "close";
}

/**
 * OCC root without its corporate-action suffix. A rename mid-position (EOSE →
 * EOSE1) otherwise strands the open leg in its own FIFO bucket and the round trip
 * disappears from the report.
 */
export function normalizeOptionRoot(root: string): string {
  const trimmed = root.trim().toUpperCase();
  return trimmed.replace(/\d+$/, "") || trimmed;
}

export function buildMatchKey(symbol: string, instrument: InstrumentClass): string {
  if (instrument !== "option") return `EQUITY:${symbol.trim().toUpperCase()}`;
  if (!isOccOptionSymbol(symbol)) return `OPT:${symbol.trim().toUpperCase()}`;
  return `OPT:${normalizeOptionRoot(symbol.slice(0, 6))}:${symbol.slice(6)}`;
}

export function normalizeLedgerRow(row: LedgerRow): NormalizedLeg | null {
  const symbol = readString(row, "symbol");
  if (!symbol) return null;
  const instrument = classifyInstrument(row);
  if (instrument === "other") return null;

  const signedGross = signedAmount(row, "value", "value-effect") ?? 0;
  const signedNet = signedAmount(row, "net-value", "net-value-effect") ?? signedGross;

  return {
    symbol,
    matchKey: buildMatchKey(symbol, instrument),
    underlying: (readString(row, "underlying-symbol") || symbol).split(/\s/)[0]!.toUpperCase(),
    quantity: Math.abs(Number(row?.quantity) || 0),
    signedGross,
    signedNet,
    executedAt: readString(row, "executed-at").slice(0, 16),
    kind: classifyLegKind(row, instrument),
    subType: readString(row, "transaction-sub-type") || readString(row, "transaction-type"),
    instrument,
    orderId: readOrderId(row),
  };
}

/** tastytrade spells this `order-id`; tolerate the other casings defensively. */
function readOrderId(row: LedgerRow): string | null {
  for (const key of ["order-id", "order_id", "orderId"]) {
    const value = readString(row, key);
    if (value && value !== "null" && value !== "undefined") return value;
  }
  return null;
}

function lookupOrderSource(
  orderId: string | null,
  sources: OrderSourceLookup | undefined,
): string | null {
  if (!orderId || !sources) return null;
  const found =
    sources instanceof Map ? sources.get(orderId) : (sources as Record<string, string>)[orderId];
  const normalized = String(found ?? "").trim();
  return normalized || null;
}

/**
 * Attribution is deliberately three-valued. Collapsing "we have no order history"
 * into "the owner did it" would let the report clear the bot of a loss it caused
 * purely because a lookup was missing.
 */
function classifyCloser(orderId: string | null, source: string | null): Closer {
  if (!orderId || source === null) return "unknown";
  return isBotOrderSource(source) ? "bot" : "owner";
}

interface OpenLot {
  leg: NormalizedLeg;
  remaining: number;
  netCostPerUnit: number;
  grossCostPerUnit: number;
}

function toOpenLot(leg: NormalizedLeg): OpenLot | null {
  if (!(leg.quantity > 0)) return null;
  return {
    leg,
    remaining: leg.quantity,
    // Debits are negative, so negating gives dollars out per contract. Using the
    // cash amount rather than price × 100 keeps commissions in the cost basis.
    netCostPerUnit: -leg.signedNet / leg.quantity,
    grossCostPerUnit: -leg.signedGross / leg.quantity,
  };
}

interface MatchContext {
  trips: Trip[];
  closesWithoutOpen: DanglingLeg[];
  orderSources: OrderSourceLookup | undefined;
  /**
   * Options only. A zero-quantity expiration removes whatever is left of the
   * position; a zero-quantity EQUITY row is a dividend and must remove nothing.
   */
  quantityLessTerminalClosesAll: boolean;
}

// fallow-ignore-next-line complexity
function matchTerminalLeg(leg: NormalizedLeg, lots: OpenLot[], ctx: MatchContext): void {
  const openUnits = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const units =
    leg.quantity > 0 ? leg.quantity : ctx.quantityLessTerminalClosesAll ? openUnits : 0;
  if (!(units > 0)) return;
  const netPerUnit = leg.quantity > 0 ? leg.signedNet / leg.quantity : 0;
  const grossPerUnit = leg.quantity > 0 ? leg.signedGross / leg.quantity : 0;

  const closeSource = lookupOrderSource(leg.orderId, ctx.orderSources);
  const closedBy = classifyCloser(leg.orderId, closeSource);

  let remaining = units;
  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0]!;
    const matched = Math.min(remaining, lot.remaining);
    ctx.trips.push({
      underlying: leg.underlying,
      openSymbol: lot.leg.symbol,
      closeSymbol: leg.symbol,
      quantity: matched,
      grossCost: matched * lot.grossCostPerUnit,
      netCost: matched * lot.netCostPerUnit,
      grossProceeds: matched * grossPerUnit,
      netProceeds: matched * netPerUnit,
      openedAt: lot.leg.executedAt,
      closedAt: leg.executedAt,
      outcome: leg.kind === "expiration" ? "expired" : "closed",
      subType: leg.subType,
      closeOrderId: leg.orderId,
      closeSource,
      closedBy,
    });
    lot.remaining -= matched;
    remaining -= matched;
    if (lot.remaining <= 0) lots.shift();
  }

  // Opened before the window (or already reconciled) — reported, never dropped.
  if (remaining > 0) {
    ctx.closesWithoutOpen.push({
      symbol: leg.symbol,
      underlying: leg.underlying,
      quantity: remaining,
      netAmount: remaining * netPerUnit,
      executedAt: leg.executedAt,
    });
  }
}

interface FifoResult {
  trips: Trip[];
  stillOpen: DanglingLeg[];
  closesWithoutOpen: DanglingLeg[];
  openLegs: number;
  closeLegs: number;
  expirationLegs: number;
}

/**
 * One FIFO matcher, run once per instrument class. Options and equity differ only
 * in the two flags above and in what a terminal leg can be — never in the
 * arithmetic, which prices everything off row CASH and so needs no multiplier.
 */
function runFifo(
  legs: NormalizedLeg[],
  orderSources: OrderSourceLookup | undefined,
  quantityLessTerminalClosesAll: boolean,
): FifoResult {
  const ordered = [...legs].sort((a, b) => a.executedAt.localeCompare(b.executedAt));
  const openLotsByKey = new Map<string, OpenLot[]>();
  const ctx: MatchContext = {
    trips: [],
    closesWithoutOpen: [],
    orderSources,
    quantityLessTerminalClosesAll,
  };
  const counts = { openLegs: 0, closeLegs: 0, expirationLegs: 0 };

  for (const leg of ordered) {
    if (leg.kind === "open") {
      counts.openLegs += 1;
      const lot = toOpenLot(leg);
      if (lot) {
        const lots = openLotsByKey.get(leg.matchKey) ?? [];
        lots.push(lot);
        openLotsByKey.set(leg.matchKey, lots);
      }
      continue;
    }
    if (leg.kind === "expiration") counts.expirationLegs += 1;
    else counts.closeLegs += 1;
    matchTerminalLeg(leg, openLotsByKey.get(leg.matchKey) ?? [], ctx);
  }

  return {
    ...counts,
    trips: ctx.trips,
    stillOpen: collectStillOpen(openLotsByKey),
    closesWithoutOpen: ctx.closesWithoutOpen,
  };
}

/** Lots with units left over — held, not lost. Reported so nothing is dropped. */
function collectStillOpen(openLotsByKey: Map<string, OpenLot[]>): DanglingLeg[] {
  const stillOpen: DanglingLeg[] = [];
  for (const lots of openLotsByKey.values()) {
    for (const lot of lots) {
      if (lot.remaining <= 0) continue;
      stillOpen.push({
        symbol: lot.leg.symbol,
        underlying: lot.leg.underlying,
        quantity: lot.remaining,
        netAmount: -lot.remaining * lot.netCostPerUnit,
        executedAt: lot.leg.executedAt,
      });
    }
  }
  return stillOpen;
}

function blend(trips: Trip[]): BlendedTotals {
  const sum = (pick: (trip: Trip) => number) => trips.reduce((total, t) => total + pick(t), 0);
  const grossCost = sum((t) => t.grossCost);
  const netCost = sum((t) => t.netCost);
  const grossProceeds = sum((t) => t.grossProceeds);
  const netProceeds = sum((t) => t.netProceeds);
  const netPnl = netProceeds - netCost;
  const grossPnl = grossProceeds - grossCost;
  return {
    grossCost,
    netCost,
    grossProceeds,
    netProceeds,
    netPnl,
    grossPnl,
    fees: grossPnl - netPnl,
    netReturnPct: netCost > 0 ? (100 * netPnl) / netCost : null,
    grossReturnPct: grossCost > 0 ? (100 * grossPnl) / grossCost : null,
    feeDragPp: netCost > 0 ? (100 * (grossPnl - netPnl)) / netCost : null,
  };
}

function slice(trips: Trip[], closer: Closer): CloserSlice {
  const matching = trips.filter((trip) => trip.closedBy === closer);
  return { ...blend(matching), trips: matching.length };
}

/**
 * Equity round trips, matched exactly like options but reported in their own
 * bucket. Blending the two would be meaningless: a share and a contract are
 * different instruments with different multipliers, so a combined "return %"
 * would divide by a cost basis that mixes both.
 */
function summarizeEquity(
  legs: NormalizedLeg[],
  orderSources: OrderSourceLookup | undefined,
): EquitySummary {
  const equityLegs = legs.filter((leg) => leg.instrument === "equity");
  // Dividends and account fees ride in on an Equity instrument-type but move no
  // shares. They belong in netCashFlow and nowhere near the FIFO ladder.
  const shareLegs = equityLegs.filter((leg) => leg.quantity > 0);
  const fifo = runFifo(shareLegs, orderSources, false);

  return {
    rowCount: equityLegs.length,
    symbols: [...new Set(equityLegs.map((leg) => leg.underlying))].sort(),
    netCashFlow: equityLegs.reduce((sum, leg) => sum + leg.signedNet, 0),
    trips: fifo.trips,
    totals: blend(fifo.trips),
    byCloser: {
      bot: slice(fifo.trips, "bot"),
      owner: slice(fifo.trips, "owner"),
      unknown: slice(fifo.trips, "unknown"),
    },
    stillOpen: fifo.stillOpen,
    closesWithoutOpen: fifo.closesWithoutOpen,
    nonShareRows: equityLegs.length - shareLegs.length,
  };
}

export function buildRealizedPnlReport(
  rows: unknown[],
  options: RealizedPnlOptions = {},
): RealizedPnlReport {
  const source = Array.isArray(rows) ? rows : [];
  const legs: NormalizedLeg[] = [];
  let skippedRows = 0;
  for (const row of source) {
    const leg = normalizeLedgerRow((row ?? {}) as LedgerRow);
    if (leg) legs.push(leg);
    else skippedRows += 1;
  }

  const optionLegs = legs.filter((leg) => leg.instrument === "option");
  const fifo = runFifo(optionLegs, options.orderSources, true);

  return {
    trips: fifo.trips,
    totals: blend(fifo.trips),
    reconciliation: {
      rowsExamined: source.length,
      openLegs: fifo.openLegs,
      closeLegs: fifo.closeLegs,
      expirationLegs: fifo.expirationLegs,
      trips: fifo.trips.length,
      stillOpen: fifo.stillOpen,
      closesWithoutOpen: fifo.closesWithoutOpen,
      skippedRows,
    },
    equity: summarizeEquity(legs, options.orderSources),
    fetchAudit: options.fetchAudit ?? null,
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function units(legs: DanglingLeg[]): number {
  return legs.reduce((total, leg) => total + leg.quantity, 0);
}

// fallow-ignore-next-line complexity
export function formatRealizedPnlReport(report: RealizedPnlReport): string[] {
  const lines: string[] = [];
  for (const trip of report.trips) {
    const pct = trip.netCost > 0 ? (100 * (trip.netProceeds - trip.netCost)) / trip.netCost : 0;
    const label = trip.outcome === "expired" ? ` (${trip.subType || "expired"})` : "";
    lines.push(
      `  ${trip.underlying.padEnd(6)} ${trip.closeSymbol.padEnd(22)} ` +
        `cost $${trip.netCost.toFixed(0)} → $${trip.netProceeds.toFixed(0)}  ${signed(pct)}%${label}`,
    );
  }

  const t = report.totals;
  if (report.trips.length === 0) {
    lines.push("  (no round trips closed in this window)");
  } else {
    lines.push(
      `  ---- blended NET: $${t.netCost.toFixed(0)} → $${t.netProceeds.toFixed(0)}  ` +
        `${signed(t.netReturnPct ?? 0)}% ($${t.netPnl.toFixed(0)})`,
    );
    lines.push(
      `  ---- gross (pre-fee): ${signed(t.grossReturnPct ?? 0)}%  |  ` +
        `fees $${t.fees.toFixed(0)} = ${(t.feeDragPp ?? 0).toFixed(2)}pp of cost basis`,
    );
  }

  // Every open leg reaches a terminal state; this line is the proof.
  const r = report.reconciliation;
  lines.push(
    `  ---- reconciliation: rows ${r.rowsExamined} | opens ${r.openLegs} | closes ${r.closeLegs} | ` +
      `expirations ${r.expirationLegs} | trips ${r.trips} | ` +
      `still open ${r.stillOpen.length} legs (${units(r.stillOpen)} contracts) | ` +
      `closes w/o open in window ${r.closesWithoutOpen.length} (${units(r.closesWithoutOpen)} contracts)`,
  );
  for (const leg of r.stillOpen) {
    lines.push(
      `       STILL OPEN ${leg.underlying.padEnd(6)} ${leg.symbol.padEnd(22)} ` +
        `${leg.quantity} @ cost $${Math.abs(leg.netAmount).toFixed(0)} (opened ${leg.executedAt})`,
    );
  }
  for (const leg of r.closesWithoutOpen) {
    lines.push(
      `       PRE-WINDOW OPEN ${leg.underlying.padEnd(6)} ${leg.symbol.padEnd(22)} ` +
        `${leg.quantity} closed for $${leg.netAmount.toFixed(0)} — cost basis outside the window`,
    );
  }

  lines.push(...formatEquitySection(report.equity));
  lines.push(...formatFetchAudit(report.fetchAudit));

  return lines;
}

/**
 * Completeness, stated every run — not only when it goes wrong.
 *
 * The truncation this guards against was invisible for weeks precisely because a
 * short read looked exactly like a complete one. A silent success line is what
 * makes the failure line meaningful, so both are always printed.
 */
function formatFetchAudit(audit: FetchAudit | null): string[] {
  if (!audit) {
    return [
      "  !!!! LEDGER COMPLETENESS UNKNOWN — caller did not page. " +
        "Totals may be truncated; do not quote them.",
    ];
  }

  const available =
    audit.reportedTotalItems === null
      ? "API did not report a total"
      : `API reports ${audit.reportedTotalItems} available`;
  const scope =
    `  ---- ledger fetch: ${audit.rowsFetched} rows over ${audit.pagesFetched} ` +
    `page(s)${audit.perPage === null ? "" : ` of ${audit.perPage}`} | ${available}`;

  if (!audit.incomplete) return [`${scope} | COMPLETE`];
  return [
    `${scope} | INCOMPLETE`,
    `  !!!! TRUNCATED LEDGER — ${audit.reason}. EVERY FIGURE ABOVE IS PARTIAL AND ` +
      "BIASED; widen nothing and quote none of it until the fetch completes.",
  ];
}

const CLOSER_LABEL: Record<Closer, string> = {
  bot: "BOT-EXECUTED",
  owner: "owner-placed",
  unknown: "unattributed",
};

function formatCloserSlice(closer: Closer, s: CloserSlice): string {
  return (
    `       ${CLOSER_LABEL[closer].padEnd(12)} ${String(s.trips).padStart(3)} trips  ` +
    `$${s.netCost.toFixed(0)} → $${s.netProceeds.toFixed(0)}  ` +
    `${signed(s.netReturnPct ?? 0)}% ($${s.netPnl.toFixed(0)})`
  );
}

/**
 * Equity is printed BELOW options and never folded into it. The bot-executed line
 * is the reason this section exists: the EOD margin liquidation sells the owner's
 * hand-bought shares, and those realized losses had no P&L line anywhere.
 */
// fallow-ignore-next-line complexity
function formatEquitySection(equity: EquitySummary): string[] {
  if (equity.rowCount === 0) return [];
  const lines: string[] = [];
  lines.push(
    `  ---- EQUITY (shares, multiplier 1 — reported separately from options): ` +
      `${equity.rowCount} rows across ${equity.symbols.join(", ")} | ` +
      `net cash flow $${equity.netCashFlow.toFixed(0)}` +
      (equity.nonShareRows > 0 ? ` | ${equity.nonShareRows} non-share rows` : ""),
  );

  for (const trip of equity.trips) {
    const pct = trip.netCost > 0 ? (100 * (trip.netProceeds - trip.netCost)) / trip.netCost : 0;
    lines.push(
      `       ${trip.underlying.padEnd(6)} ${String(trip.quantity).padStart(6)} sh  ` +
        `cost $${trip.netCost.toFixed(0)} → $${trip.netProceeds.toFixed(0)}  ${signed(pct)}%  ` +
        `closed ${trip.closedAt} by ${CLOSER_LABEL[trip.closedBy]}` +
        (trip.closeSource ? ` (${trip.closeSource})` : ""),
    );
  }

  if (equity.trips.length === 0) {
    lines.push("       (no equity share round trips matched in this window)");
  } else {
    const t = equity.totals;
    lines.push(
      `       ---- equity blended NET: $${t.netCost.toFixed(0)} → $${t.netProceeds.toFixed(0)}  ` +
        `${signed(t.netReturnPct ?? 0)}% ($${t.netPnl.toFixed(0)})`,
    );
    for (const closer of ["bot", "owner", "unknown"] as const) {
      if (equity.byCloser[closer].trips > 0) {
        lines.push(formatCloserSlice(closer, equity.byCloser[closer]));
      }
    }
  }

  for (const leg of equity.stillOpen) {
    lines.push(
      `       STILL HELD ${leg.underlying.padEnd(6)} ${leg.quantity} sh @ cost ` +
        `$${Math.abs(leg.netAmount).toFixed(0)} (bought ${leg.executedAt})`,
    );
  }
  for (const leg of equity.closesWithoutOpen) {
    lines.push(
      `       PRE-WINDOW SHARES ${leg.underlying.padEnd(6)} ${leg.quantity} sh sold for ` +
        `$${leg.netAmount.toFixed(0)} — cost basis outside the window`,
    );
  }

  return lines;
}
