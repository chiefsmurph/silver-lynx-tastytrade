import { CurrentPosition } from "~/core/types";
import type {
  OrderRequest,
  TastytradeInstrumentType,
  TastytradeOrderAction,
} from "~/core/types";
import type { PositionQuoteSnapshot } from "../evaluate-position";

export interface OrderLeg {
  action: TastytradeOrderAction;
  symbol: string;
  quantity: number;
  "instrument-type": TastytradeInstrumentType;
}

export type OrderPayload = OrderRequest;

export function getPositionQuantity(position: CurrentPosition): number {
  return Math.abs(Number(position.quantity) || 0);
}

export function isShortPosition(position: CurrentPosition): boolean {
  const quantityDirection = String(position["quantity-direction"] ?? "").toLowerCase();
  if (quantityDirection === "short") {
    return true;
  }
  if (quantityDirection === "long") {
    return false;
  }

  return String(position["cost-effect"] ?? "").toLowerCase() === "credit";
}

export function getClosingAction(position: CurrentPosition): TastytradeOrderAction {
  return isShortPosition(position) ? "Buy to Close" : "Sell to Close";
}

export function normalizeInstrumentType(
  instrumentType: string,
): TastytradeInstrumentType {
  switch (instrumentType.trim().toLowerCase()) {
    case "equity":
      return "Equity";
    case "option":
    case "equity option":
      return "Equity Option";
    case "future":
      return "Future";
    case "future option":
      return "Future Option";
    case "cryptocurrency":
    case "crypto":
      return "Cryptocurrency";
    default:
      return instrumentType as TastytradeInstrumentType;
  }
}

/**
 * One band of tastytrade's `tick-sizes` array (TastytradeOptionChain['tick-sizes']).
 * `threshold` is the price at which the band stops applying; the entry without one
 * is the final, open-ended band.
 */
export interface OptionTickSize {
  threshold?: string | number;
  value: string | number;
}

/**
 * Fallback bands, used when the instrument's own `tick-sizes` are not to hand.
 *
 * NOT a guess: the broker rejected live orders with
 * "Price must be in increments of $0.05 for this order. [invalid_price_increment]"
 * at limit prices of 3.28, 3.23 and 3.03 — every rejection at or above $3.00 and
 * none below it. That is the penny-pilot convention ($0.01 under $3, $0.05 at or
 * above) and it is what these bands encode. Prefer the chain's real `tick-sizes`
 * when a caller has them; this is only the floor.
 */
export const DEFAULT_OPTION_TICK_SIZES: readonly OptionTickSize[] = [
  { value: "0.01", threshold: "3.0" },
  { value: "0.05" },
];

/**
 * Shares quote in pennies at every price. The $3.00 nickel band is an OPTIONS
 * rule, and this bot does place share orders — the EOD margin liquidation clears
 * every instrument in the account, including equity the owner bought by hand — so
 * borrowing the option grid there would move a share limit by up to 2c for nothing.
 */
export const EQUITY_TICK_SIZES: readonly OptionTickSize[] = [{ value: "0.01" }];

/**
 * Pick the grid for an order leg's `instrument-type`.
 *
 * "Equity Option" contains "Equity", so options must be matched FIRST. Unknown
 * types fall back to the option grid on purpose: a nickel price is always a legal
 * penny price, so the option grid is never rejected, only coarser.
 */
export function tickSizesForInstrument(
  instrumentType: string | null | undefined,
): readonly OptionTickSize[] {
  const normalized = String(instrumentType ?? "").toLowerCase();
  if (normalized.includes("option")) return DEFAULT_OPTION_TICK_SIZES;
  return normalized.includes("equity") ? EQUITY_TICK_SIZES : DEFAULT_OPTION_TICK_SIZES;
}

/** The increment that applies at `price`, per tastytrade's banded tick schema. */
export function resolveTickSize(
  price: number,
  tickSizes: readonly OptionTickSize[] = DEFAULT_OPTION_TICK_SIZES,
): number {
  const bands = (tickSizes ?? [])
    .map((band) => ({
      value: Number(band?.value),
      // No threshold = the open-ended top band, so it must sort last.
      threshold: band?.threshold === undefined ? Infinity : Number(band.threshold),
    }))
    .filter((band) => Number.isFinite(band.value) && band.value > 0)
    .sort((a, b) => a.threshold - b.threshold);

  if (bands.length === 0) return 0.01;
  const match = bands.find((band) => price < band.threshold);
  return (match ?? bands[bands.length - 1]!).value;
}

/**
 * Snap a limit price to the instrument's tick grid.
 *
 * This used to round to $0.01 unconditionally, which is only legal below $3.00.
 * At or above it the broker requires nickels and rejects the order outright, so an
 * otherwise-valid order was thrown away at the preflight check — invisibly, since
 * a rejected seed just reads as a skip.
 *
 * Rounds to NEAREST, which is the policy already in force at $0.01. Switching to
 * directional rounding would change how aggressively the bot bids and concedes,
 * and that is a strategy decision rather than a formatting one.
 */
export function roundOrderPrice(
  price: number,
  tickSizes?: readonly OptionTickSize[],
): string {
  const tick = resolveTickSize(price, tickSizes);
  let rounded = Math.round(price / tick) * tick;
  // A positive price must never round away to a $0.00 limit — that is an instant
  // rejection on a buy and giving the position away on a sell.
  if (rounded <= 0 && price > 0) rounded = tick;
  return rounded.toFixed(2);
}

export function buildClosingOrderPayload(
  snapshot: PositionQuoteSnapshot,
  source?: string,
): OrderPayload | null {
  const quantity = getPositionQuantity(snapshot.position);
  if (quantity <= 0) {
    return null;
  }

  const price = getMidpointPrice(snapshot.currentBidPrice, snapshot.currentAskPrice);

  if (!(price > 0)) {
    return null;
  }

  const action = getClosingAction(snapshot.position);
  const instrumentType = normalizeInstrumentType(
    String(snapshot.position["instrument-type"] ?? ""),
  );

  return {
    source: source ?? "silver-lynx-tastytrade",
    "time-in-force": "Day",
    "order-type": "Limit",
    price: roundOrderPrice(price, tickSizesForInstrument(instrumentType)),
    "price-effect": action.startsWith("Buy") ? "Debit" : "Credit",
    "advanced-instructions": {
      "strict-position-effect-validation": true,
    },
    legs: [
      {
        action,
        symbol: snapshot.position.symbol,
        quantity,
        "instrument-type": instrumentType,
      },
    ],
  };
}

export function getGroupMarketValue(positionSnapshots: PositionQuoteSnapshot[]): number {
  return positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentBidPrice * snapshot.quantityWeight,
    0,
  );
}

// Total option contracts held across a group's snapshots (absolute lot count,
// multiplier-agnostic — 15 long calls => 15). This is the unit the underlying
// contract cap is expressed in: exit liquidity scales with lot count vs. the
// book's depth, not with premium dollars.
export function getGroupContractCount(positionSnapshots: PositionQuoteSnapshot[]): number {
  return positionSnapshots.reduce(
    (sum, snapshot) => sum + Math.abs(Number(snapshot.position.quantity) || 0),
    0,
  );
}

export function inferOptionSide(symbol: string): "call" | "put" | null {
  const trimmed = symbol.trim();
  const match = trimmed.match(/([CP])(\d+)$/i);
  if (!match) {
    return null;
  }

  return match[1].toUpperCase() === "P" ? "put" : "call";
}

// OCC option symbol: 6-char padded root, YYMMDD expiration, C/P, strike ×1000
const OCC_OPTION_SYMBOL_PATTERN = /^.{6}(\d{6})[CP]\d{8}$/;

/**
 * True only for a well-formed 21-character OCC contract symbol
 * ("AAPL  260619C00100000"). Deliberately positive-matching: a plain equity
 * ticker ("SNWV") and an empty/garbled symbol both answer false.
 */
export function isOccOptionSymbol(symbol: string): boolean {
  return OCC_OPTION_SYMBOL_PATTERN.test(String(symbol ?? ""));
}

/**
 * Contracts/shares -> dollars multiplier for a per-unit price.
 *
 * REGRESSION GUARD: the realized-P&L paths used to hard-code ×100. Both managed
 * accounts also carry manually-traded EQUITY rows (a bare ticker, side "none"),
 * and those were being inflated 100× — one row read as roughly a hundred times
 * its true loss and dominated the window total. An option contract still gets
 * ×100 because `isOccOptionSymbol` matches the full OCC shape; anything that is
 * not an option contract is priced per share.
 */
export function getContractMultiplier(symbol: string): number {
  return isOccOptionSymbol(symbol) ? 100 : 1;
}

export function getOccExpirationDate(symbol: string): Date | null {
  const match = OCC_OPTION_SYMBOL_PATTERN.exec(symbol);
  if (!match) return null;
  const yymmdd = match[1];
  return new Date(
    2000 + Number(yymmdd.slice(0, 2)),
    Number(yymmdd.slice(2, 4)) - 1,
    Number(yymmdd.slice(4, 6)),
  );
}

// Midpoint of a two-sided quote, degrading to whichever side exists when one
// is missing. Shared by the allocation and close paths.
export function getMidpointPrice(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return ask || bid;
}

type GetOrderFn = (
  accountNumber: string,
  orderId: number,
) => Promise<{ status?: string } | null | undefined>;

// Statuses that mean "this order is still working, keep waiting".
//
// This list was missing every status tastytrade actually assigns a freshly-placed
// order — Received, Routed, In Flight, Live — and carried "Pending"/"Open", which
// the broker does not use for a new order. The consequence was severe and silent:
// waitForOrderFillById treats an unrecognised status as terminal and returns false
// IMMEDIATELY, so the close tick-chase concluded "didn't fill" about a second after
// posting, dropped a rung, and repeated. A chase designed to rest 30s per rung over
// 10 moves (~5 minutes) burned through its whole ladder in ~1 second and landed on
// the BID essentially every time — handing the market maker the full spread on
// every close. Observed 2026-08-03: EOSE posted 0.82 / 0.77 / 0.73 within one
// second and filled at the bid rung; two of three sells that morning filled below
// mid for that reason.
//
// It also explains why fills went missing from the run history: the chase returned
// before the broker reported the fill, so the cycle recorded fills: [].
//
// Kept identical to LIVE_STATUSES in actions/spray-buy.ts, which had the correct
// set all along. The bot's own tests corroborate it — spray-buy.test.ts models a
// newly placed order as status "Received".
const LIVE_ORDER_STATUSES = [
  "Received",
  "Routed",
  "In Flight",
  "Live",
  "Pending",
  "Open",
  "Pending Cancel",
  "Cancel Requested",
];

// Polls a single order by id (not the full order list) until it fills or the
// timeout lapses. A missing order (404) counts as NOT filled — the previous
// copies of this loop treated a vanished order as filled, silently mislabeling
// cancelled/expired/rejected orders and feeding phantom fills to the chase loops.
export async function waitForOrderFillById(
  accountNumber: string,
  orderId: string,
  timeoutMs: number,
  options: { pollIntervalMs?: number; getOrder?: GetOrderFn } = {},
): Promise<boolean> {
  const numericOrderId = Number(orderId);
  if (!Number.isFinite(numericOrderId)) {
    return false;
  }

  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const getOrder: GetOrderFn =
    options.getOrder ??
    (async (resolvedAccountNumber, resolvedOrderId) => {
      const { default: tastytradeApi } = await import("~/core/tastytrade-client");
      return tastytradeApi.orderService.getOrder(resolvedAccountNumber, resolvedOrderId);
    });

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const order = await getOrder(accountNumber, numericOrderId);
      const status = order?.status;

      if (status === "Filled" || status === "Partially Filled") {
        return true;
      }

      if (!status || !LIVE_ORDER_STATUSES.includes(status)) {
        return false;
      }
    } catch (error) {
      const httpStatus = (error as { response?: { status?: number } })?.response?.status;
      if (httpStatus === 404) {
        return false;
      }
      // Transient failure — keep polling until the timeout.
    }

    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }

  return false;
}