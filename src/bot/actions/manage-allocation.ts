import { getAccountMarginOrCash } from "~/core/default-account";
import tastytradeApi from "~/core/tastytrade-client";
import { PositionGroupEvaluation } from "../evaluate-position";
import { AllocationBudget } from "../allocation-budget";
import {
  evaluateOptionHealthForTargetDTE,
  getOptionHealthForSymbol,
  getTopOptionCandidateForSymbol,
  getMarginTargetCallDelta,
  TopOptionCandidateForSymbolResult,
} from "~/strategy/option-candidate";
import {
  evaluateLiquidityGate,
  getMaxEntrySpreadPctForAccountType,
  logLiquidityGateDecision,
} from "~/strategy/liquidity-gate";
import {
  getGroupContractCount,
  getGroupMarketValue,
  getMidpointPrice,
  getOccExpirationDate,
  inferOptionSide,
  normalizeInstrumentType,
  OrderPayload,
  roundOrderPrice,
  waitForOrderFillById,
} from "./order-utils";
import {
  ExecutionTargets,
  getNoBuyCutoffMinute,
  type StrategyAccountType,
} from "~/strategy/evaluate-trading-strategy";
import {
  getMaxBuyExposurePctForAccountType,
  getMaxUnderlyingContracts,
  getMaxUnderlyingNotional,
} from "~/strategy/risk-limits";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import {
  buildSuppressedAllocationReason,
  isAllocationBlockedByInstrumentGuard,
  logSuppressedAllocation,
} from "../allocation-instrument-guard";
import { readEnvBool, readEnvFraction, readEnvInt, readEnvPct, toBooleanFlag } from "~/core/env-utils";

// Budget helpers live in a leaf module to keep this file out of the
// effective-buying-power import cycle; re-exported for existing consumers.
export type { AllocationBudget };
export {
  buildInitialBudget,
  getCurrentAllocationBudget,
} from "../allocation-budget";


// "rung" is the resting-ladder route (see the RESTING LADDER block below): a
// limit order that sits at a fixed price inside the bid→ask band and never
// chases. bid/mid/ask are the legacy chase routes.
export type AllocationRoute = "bid" | "mid" | "ask" | "rung";

export interface AllocationRouteResult {
  estimatedOrderValue: number;
  limitPrice: number;
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  quantity: number;
  route: AllocationRoute;
  skippedReason?: string;
  weight: number;
}

export interface AllocationExecutionResult {
  accountNumber: string;
  action: "MANAGE_ALLOCATION";
  candidateSymbol?: string;
  candidateDTE?: number;
  estimatedOrderValue?: number;
  maxDTE?: number;
  minDTE?: number;
  orderResponses?: TastytradePlacedOrderResponse[];
  placedOrder: boolean;
  preferredDTE?: number;
  quantity?: number;
  routeOrders: AllocationRouteResult[];
  skippedReason?: string;
  underlyingSymbol: string;
  usedDteFallback?: boolean;
  usedHeldContractFallback?: boolean;
}

interface ManageAllocationOptions {
  dryRun?: boolean;
  accountMarginOrCash?: "margin" | "cash";
}

// The `?? "call"` default is right for an OPTION group whose symbols will not
// parse, and wrong for the other thing that reaches a sideless group: a hand-bought
// share lot, which has no C/P suffix and so groups as `TICKER::none`. That case is
// filtered out before this is ever called — see the instrument guard at the top of
// manageAllocationForGroup (allocation-instrument-guard.ts).
function getCandidateSide(evaluation: PositionGroupEvaluation): "call" | "put" {
  const inferredSides = evaluation.positions
    .map((position) => inferOptionSide(position.symbol))
    .filter((side): side is "call" | "put" => side != null);

  return inferredSides[0] ?? "call";
}

// ── RESTING LADDER execution mode ────────────────────────────────────────────
// The legacy path builds three chase routes (bid/mid/ask) whose weight schedule
// is ask-heavy as the morning progresses, and allocateContractsByWeight's
// floor+greedy sizing tends to pile a cheap contract's whole lot onto one route
// (see the diagnostic at the bottom of placeRouteOrders). The net effect is a
// single ask-chasing lump. The resting ladder is the opposite: N patient limit
// orders spread across the bid→ask band that SIT and fill on dips, with the
// quantity split as evenly as possible across the rungs.
//
// The whole feature is OFF unless STRATEGY_RESTING_LADDER_ENABLED is truthy, so
// with the flag off buildRouteOrders / allocateContractsByWeight are byte for
// byte the current three-route behavior. Nothing below runs until the human
// flips the flag on.

// Master flag. Default OFF → buildRouteOrders keeps the 3-route chase path.
export function isRestingLadderEnabled(): boolean {
  return readEnvBool("STRATEGY_RESTING_LADDER_ENABLED", false);
}

// How many resting rungs to spread across the band. Clamped to [1, 20]. The
// effective count is further capped by the contract count in the sizing step —
// you can't have more rungs than contracts.
export function getRestingLadderRungCount(): number {
  const raw = readEnvInt("STRATEGY_RESTING_LADDER_RUNGS", 5, (n) => n >= 1);
  return Math.max(1, Math.min(20, raw));
}

// The band the rungs occupy, as fractions of the bid→ask spread measured FROM
// THE BID. Both are clamped to [0, 1] and ordered so top ≥ bottom. Defaults
// place every rung strictly inside the spread and never at/above the ask:
//   bottom 0.00 → deepest rung rests AT the bid (a genuinely patient order)
//   top    0.80 → shallowest rung rests at bid + 80% of the spread (below mid+;
//                 well under the ask, so no rung is a marketable ask-chase)
// A one-rung ladder rests at the midpoint of [bottom, top].
export function getRestingLadderBandBottomFraction(): number {
  const raw = readEnvFraction("STRATEGY_RESTING_LADDER_BAND_BOTTOM_PCT", 0.0);
  return Math.max(0, Math.min(1, raw));
}
export function getRestingLadderBandTopFraction(): number {
  const raw = readEnvFraction("STRATEGY_RESTING_LADDER_BAND_TOP_PCT", 0.8);
  return Math.max(0, Math.min(1, raw));
}

// Build the resting-ladder rung prices inside the bid→ask band. Returns rung
// limit prices from DEEPEST (near/at the bid) to SHALLOWEST (near the top of the
// band), each strictly below the ask by construction. Every rung carries an
// equal weight of 1 — the ladder splits quantity evenly, not by a schedule.
// Falls back to the midpoint when the quote is one-sided or degenerate.
export function buildRestingLadderRouteOrders(
  bid: number,
  ask: number,
  rungCount: number = getRestingLadderRungCount(),
): AllocationRouteResult[] {
  const midpoint = getMidpointPrice(bid, ask);
  const rungs = Math.max(1, Math.floor(rungCount));

  // One-sided or crossed/degenerate quote: no real band to spread across. Rest
  // the whole ladder at a single safe price (the midpoint) rather than invent a
  // band around a price we don't have.
  if (!(bid > 0) || !(ask > bid)) {
    return midpoint > 0
      ? [
          {
            estimatedOrderValue: 0,
            limitPrice: midpoint,
            placedOrder: false,
            quantity: 0,
            route: "rung" as const,
            weight: 1,
          },
        ]
      : [];
  }

  const spread = ask - bid;
  const bottom = getRestingLadderBandBottomFraction();
  const top = Math.max(bottom, getRestingLadderBandTopFraction());

  const routeOrders: AllocationRouteResult[] = [];
  for (let i = 0; i < rungs; i += 1) {
    // Even placement across [bottom, top]. A single rung sits at the band's
    // midpoint; multiple rungs span bottom→top inclusive.
    const t = rungs === 1 ? (bottom + top) / 2 : bottom + ((top - bottom) * i) / (rungs - 1);
    const limitPrice = bid + spread * t;
    if (limitPrice > 0) {
      routeOrders.push({
        estimatedOrderValue: 0,
        limitPrice,
        placedOrder: false,
        quantity: 0,
        route: "rung" as const,
        weight: 1,
      });
    }
  }

  return routeOrders;
}

// Split a total contract quantity as evenly as possible across resting rungs.
// The quantity is derived the same way the legacy path would size the WHOLE
// ladder — Math.floor(availableCapital / cheapest-rung-cost) is NOT used;
// instead we spend against the average rung cost so the even split fits the
// budget. If quantity < rungs we drop the shallowest rungs (keep the deepest,
// best-priced ones) so we never place more rungs than contracts and never put
// the whole quantity on one rung when we don't have to. No-op on empty capital.
export function allocateContractsAcrossRungs(
  routeOrders: AllocationRouteResult[],
  availableCapital: number,
): AllocationRouteResult[] {
  if (routeOrders.length === 0 || availableCapital <= 0) {
    return routeOrders;
  }

  // Zero every rung first so a re-used array can't carry stale sizing.
  for (const routeOrder of routeOrders) {
    routeOrder.quantity = 0;
    routeOrder.estimatedOrderValue = 0;
  }

  // Total contracts affordable, sized against the AVERAGE rung cost so the even
  // split actually fits the budget (sizing against the cheapest rung would
  // over-buy once the split lands on the pricier rungs).
  const rungCosts = routeOrders.map((routeOrder) => routeOrder.limitPrice * 100);
  const averageCost =
    rungCosts.reduce((sum, cost) => sum + cost, 0) / rungCosts.length;
  if (!(averageCost > 0)) {
    return routeOrders;
  }

  const totalContracts = Math.floor(availableCapital / averageCost);
  if (totalContracts < 1) {
    return routeOrders;
  }

  // Can't have more rungs than contracts. Keep the DEEPEST (best-priced) rungs —
  // buildRestingLadderRouteOrders emits deepest-first, so slice from the front.
  const activeRungCount = Math.min(routeOrders.length, totalContracts);
  const activeRungs = routeOrders.slice(0, activeRungCount);

  // Even split: base lots to every active rung, then hand the remainder one at a
  // time to the DEEPEST rungs (front of the array = best price).
  const base = Math.floor(totalContracts / activeRungCount);
  let remainder = totalContracts - base * activeRungCount;
  for (const routeOrder of activeRungs) {
    let quantity = base;
    if (remainder > 0) {
      quantity += 1;
      remainder -= 1;
    }
    routeOrder.quantity = quantity;
    routeOrder.estimatedOrderValue = quantity * routeOrder.limitPrice * 100;
  }

  return routeOrders;
}

export function buildRouteOrders(
  bid: number,
  ask: number,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
): AllocationRouteResult[] {
  if (isRestingLadderEnabled()) {
    return buildRestingLadderRouteOrders(bid, ask);
  }

  const midpoint = getMidpointPrice(bid, ask);

  return [
    {
      estimatedOrderValue: 0,
      limitPrice: bid > 0 ? bid : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "bid" as const,
      weight: targets.bidWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: midpoint,
      placedOrder: false,
      quantity: 0,
      route: "mid" as const,
      weight: targets.midWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: ask > 0 ? ask : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "ask" as const,
      weight: targets.askWeight,
    },
  ].filter((routeOrder) => routeOrder.weight > 0 && routeOrder.limitPrice > 0);
}

export function allocateContractsByWeight(
  routeOrders: AllocationRouteResult[],
  availableCapital: number,
): AllocationRouteResult[] {
  // Resting-ladder routes are sized by an EVEN split, not the weight schedule.
  // Detecting the rung route (rather than re-reading the flag) keeps sizing and
  // pricing in lockstep: whatever buildRouteOrders emitted gets sized the right
  // way, even when these functions are exercised directly.
  if (routeOrders.some((routeOrder) => routeOrder.route === "rung")) {
    return allocateContractsAcrossRungs(routeOrders, availableCapital);
  }

  const totalWeight = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.weight,
    0,
  );

  if (totalWeight <= 0 || availableCapital <= 0) {
    return routeOrders;
  }

  const targets = routeOrders.map((routeOrder) => ({
    contractCost: routeOrder.limitPrice * 100,
    routeOrder,
    targetSpend: availableCapital * (routeOrder.weight / totalWeight),
  }));

  for (const target of targets) {
    if (target.contractCost <= 0) {
      continue;
    }

    target.routeOrder.quantity = Math.floor(
      target.targetSpend / target.contractCost,
    );
    target.routeOrder.estimatedOrderValue =
      target.routeOrder.quantity * target.contractCost;
  }

  let remainingCapital =
    availableCapital -
    targets.reduce(
      (sum, target) => sum + target.routeOrder.estimatedOrderValue,
      0,
    );

  let iterationCount = 0;
  while (remainingCapital > 0 && iterationCount < 100) {
    iterationCount += 1;

    const affordableTargets = targets.filter(
      (target) => target.contractCost > 0 && target.contractCost <= remainingCapital,
    );
    if (affordableTargets.length === 0) {
      break;
    }

    affordableTargets.sort((left, right) => {
      const leftShortfall = left.targetSpend - left.routeOrder.estimatedOrderValue;
      const rightShortfall =
        right.targetSpend - right.routeOrder.estimatedOrderValue;

      if (rightShortfall !== leftShortfall) {
        return rightShortfall - leftShortfall;
      }

      return left.contractCost - right.contractCost;
    });

    const nextTarget = affordableTargets[0];
    nextTarget.routeOrder.quantity += 1;
    nextTarget.routeOrder.estimatedOrderValue += nextTarget.contractCost;
    remainingCapital -= nextTarget.contractCost;
  }

  return routeOrders;
}

// The route to give up the next contract: the one holding the most (ties:
// lowest weight), so trimming keeps the executed mix close to the configured
// weights. Ignores routes already at zero.
function pickTrimTarget(
  routeOrders: AllocationRouteResult[],
): AllocationRouteResult | undefined {
  let trimTarget: AllocationRouteResult | undefined;
  for (const routeOrder of routeOrders) {
    if (routeOrder.quantity <= 0) {
      continue;
    }
    if (
      !trimTarget ||
      routeOrder.quantity > trimTarget.quantity ||
      (routeOrder.quantity === trimTarget.quantity &&
        routeOrder.weight < trimTarget.weight)
    ) {
      trimTarget = routeOrder;
    }
  }
  return trimTarget;
}

// Trim sized route orders so their combined quantity never exceeds
// maxTotalQuantity, removing one contract at a time via pickTrimTarget.
// estimatedOrderValue is recomputed for trimmed routes. No-op when
// maxTotalQuantity is Infinity (cap unset) or already satisfied.
export function clampRouteOrdersToMaxTotalQuantity(
  routeOrders: AllocationRouteResult[],
  maxTotalQuantity: number,
): AllocationRouteResult[] {
  if (!Number.isFinite(maxTotalQuantity)) {
    return routeOrders;
  }

  const maxQuantity = Math.max(0, Math.floor(maxTotalQuantity));
  let totalQuantity = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  while (totalQuantity > maxQuantity) {
    const trimTarget = pickTrimTarget(routeOrders);
    if (!trimTarget) {
      // Defensive: total > max implies a positive-quantity route exists.
      break;
    }

    trimTarget.quantity -= 1;
    trimTarget.estimatedOrderValue =
      trimTarget.quantity * trimTarget.limitPrice * 100;
    totalQuantity -= 1;
  }

  return routeOrders;
}

const TICK_UP_CHASE_ENABLED = true;
const TICK_UP_INTERVAL_MS = 30_000; // 30 seconds
const MAX_TICK_UPS = 10; // Maximum number of ticks
const ASK_ROUTE_TICK_INTERVAL_MS = 15_000; // ask route chases on a faster clock
const MID_ROUTE_MAX_TICKS = 3; // mid route concedes at most this many ticks

export interface RouteChasePlan {
  ceilingPrice: number;
  maxTicks: number;
  startPrice: number;
  tickIntervalMs: number;
}

// Route semantics (redesigned 2026-07-03 — IMPROVEMENTS.v4 strategy #9): the
// route name describes how much of the spread the order concedes and how
// fast, not just a starting price. Previously every route chased to the full
// ask, and the ask route paid the whole spread instantly.
//   bid — rest at the bid, never chase (a genuinely patient order).
//   mid — start at mid, concede at most MID_ROUTE_MAX_TICKS ticks.
//   ask — start at MID and chase to the full ask on the fast clock:
//         immediacy with a real attempt at spread capture. When the spread is
//         within two min-ticks there is nothing to capture — go straight to
//         the ask.
//   rung — resting-ladder rung: sit at its OWN limit price (restPrice) and
//          never chase (maxTicks 0). The next cycle's cancel-sweep re-evaluates.
export function getRouteChasePlan(
  route: AllocationRoute,
  bid: number,
  ask: number,
  restPrice?: number,
): RouteChasePlan {
  const midpoint = getMidpointPrice(bid, ask);
  const ceilingPrice = ask > 0 ? ask : midpoint;
  const minTick = midpoint < 3 ? 0.05 : 0.1;

  if (route === "rung") {
    // Rest at the rung's own price; if none was supplied fall back to the
    // midpoint (defensive — a laddered route always carries a limit price).
    const rest = restPrice && restPrice > 0 ? restPrice : midpoint;
    return {
      ceilingPrice: rest,
      maxTicks: 0,
      startPrice: rest,
      tickIntervalMs: TICK_UP_INTERVAL_MS,
    };
  }

  if (route === "bid") {
    const restPrice = bid > 0 ? bid : midpoint;
    return {
      ceilingPrice: restPrice,
      maxTicks: 0,
      startPrice: restPrice,
      tickIntervalMs: TICK_UP_INTERVAL_MS,
    };
  }

  if (route === "mid") {
    return {
      ceilingPrice,
      maxTicks: MID_ROUTE_MAX_TICKS,
      startPrice: midpoint,
      tickIntervalMs: TICK_UP_INTERVAL_MS,
    };
  }

  const spreadIsTight = ceilingPrice - midpoint <= 2 * minTick;
  return spreadIsTight
    ? {
        ceilingPrice,
        maxTicks: 0,
        startPrice: ceilingPrice,
        tickIntervalMs: ASK_ROUTE_TICK_INTERVAL_MS,
      }
    : {
        ceilingPrice,
        maxTicks: MAX_TICK_UPS,
        startPrice: midpoint,
        tickIntervalMs: ASK_ROUTE_TICK_INTERVAL_MS,
      };
}

// Cap a single allocation buy relative to the group's current market value,
// so adds scale with the position rather than the account: a $87 position
// with a 2.5x multiple can add at most ~$217 in one action, while a $1,000
// position can add $2,500. Keeps the first adds small without limiting later
// dip-averaging. Off unless set.
export function getMaxAllocationBuyPositionMultiple(): number {
  const raw = process.env.STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE;
  if (!raw) {
    return Infinity;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Infinity;
  }

  return parsed;
}

function calculateDynamicTickSize(midPrice: number, askPrice: number): number {
  // If we don't have a valid ask, fall back to SEC minimum tick rules
  if (askPrice <= midPrice || !Number.isFinite(askPrice)) {
    return midPrice < 3.0 ? 0.05 : 0.10;
  }

  // Calculate the spread gap between mid and ask
  const spreadGap = askPrice - midPrice;

  // Divide the spread into equal increments up to MAX_TICK_UPS
  // This allows aggressive chasing on wide spreads and conservative on tight spreads
  const tickSize = spreadGap / MAX_TICK_UPS;

  // But also respect SEC minimums: don't go below them
  const minTickSize = midPrice < 3.0 ? 0.05 : 0.10;
  
  return Math.max(tickSize, minTickSize);
}

async function cancelOrderById(
  accountNumber: string,
  orderId: string,
  cancelFn?: (accountNumber: string, orderId: number) => Promise<unknown>,
): Promise<boolean> {
  try {
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId)) {
      return false;
    }
    if (cancelFn) {
      await cancelFn(accountNumber, numericOrderId);
    } else {
      await tastytradeApi.orderService.cancelOrder(accountNumber, numericOrderId);
    }
    return true;
  } catch (err) {
    return false;
  }
}

export interface PlaceRouteOrdersDependencies {
  createOrder?: (accountNumber: string, order: OrderPayload) => Promise<TastytradePlacedOrderResponse>;
  cancelOrder?: (accountNumber: string, orderId: number) => Promise<unknown>;
  waitForFill?: (accountNumber: string, orderId: string, timeoutMs: number) => Promise<boolean>;
}

// Buy-to-open limit order for a single option contract at a given price.
function buildBuyToOpenOrder(
  candidateSymbol: string,
  quantity: number,
  price: number,
): OrderPayload {
  return {
    source: "tastytrade-silver-lynx",
    "time-in-force": "Day",
    "order-type": "Limit",
    price: roundOrderPrice(price),
    "price-effect": "Debit",
    legs: [
      {
        action: "Buy to Open",
        symbol: candidateSymbol,
        quantity,
        "instrument-type": normalizeInstrumentType("Equity Option"),
      },
    ],
  };
}

// Places one route order and tick-chases it up toward the plan ceiling until it
// fills, the chase is exhausted, or cancellation can't be confirmed. Returns the
// last order response placed — the working order the next cycle's sweep owns.
async function chaseRouteOrderFill(
  accountNumber: string,
  candidateSymbol: string,
  quantity: number,
  plan: RouteChasePlan,
  midPrice: number,
  createOrder: (accountNumber: string, order: OrderPayload) => Promise<TastytradePlacedOrderResponse>,
  waitForFill: (accountNumber: string, orderId: string, timeoutMs: number) => Promise<boolean>,
  cancelOrder?: (accountNumber: string, orderId: number) => Promise<unknown>,
): Promise<TastytradePlacedOrderResponse | undefined> {
  let currentPrice = plan.startPrice;
  let orderId: string | undefined;
  let lastOrderResponse: TastytradePlacedOrderResponse | undefined;
  let tickCount = 0;

  while (tickCount <= plan.maxTicks) {
    const order = buildBuyToOpenOrder(candidateSymbol, quantity, currentPrice);
    const orderResponse = await createOrder(accountNumber, order);
    lastOrderResponse = orderResponse;
    orderId = orderResponse?.order?.id;

    if (!TICK_UP_CHASE_ENABLED || tickCount >= plan.maxTicks) {
      // Route rests here (bid, or chase exhausted) — leave the order working;
      // the next cycle's cancelAllLiveOrders sweep owns cleanup.
      break;
    }

    const isFilled = orderId
      ? await waitForFill(accountNumber, orderId, plan.tickIntervalMs)
      : false;
    if (isFilled) {
      break;
    }

    const tickSize = calculateDynamicTickSize(midPrice, plan.ceilingPrice);
    const nextPrice = Math.min(plan.ceilingPrice, currentPrice + tickSize);
    if (nextPrice - currentPrice < 1e-9) {
      // At the ceiling — re-placing an identical price is pure request waste.
      break;
    }

    if (orderId) {
      const cancelled = await cancelOrderById(accountNumber, orderId, cancelOrder);
      if (!cancelled) {
        // Can't confirm cancellation — stop chasing to avoid duplicate live orders
        break;
      }
    }

    currentPrice = nextPrice;
    tickCount += 1;
  }

  return lastOrderResponse;
}

export async function placeRouteOrders(
  accountNumber: string,
  candidateSymbol: string,
  routeOrders: AllocationRouteResult[],
  bidPrice: number = 0,
  askPrice: number = 0,
  deps: PlaceRouteOrdersDependencies = {},
): Promise<AllocationRouteResult[]> {
  const effectiveCreateOrder = deps.createOrder ??
    ((acct: string, order: OrderPayload) => tastytradeApi.orderService.createOrder(acct, order) as Promise<TastytradePlacedOrderResponse>);
  const effectiveWaitForFill = deps.waitForFill ?? waitForOrderFillById;

  const placedOrders: AllocationRouteResult[] = [];

  for (const routeOrder of routeOrders) {
    if (routeOrder.quantity <= 0) {
      placedOrders.push({
        ...routeOrder,
        skippedReason: "allocated quantity rounded to zero",
      });
      continue;
    }

    const effectiveBid = bidPrice > 0 ? bidPrice : routeOrder.limitPrice;
    const effectiveAsk = askPrice > 0 ? askPrice : routeOrder.limitPrice;
    // Resting rungs rest at their OWN limit price; pass it so the plan sits
    // there with maxTicks 0 (no chase). Legacy routes derive their plan from
    // bid/ask and ignore the extra arg.
    const plan = getRouteChasePlan(
      routeOrder.route,
      effectiveBid,
      effectiveAsk,
      routeOrder.route === "rung" ? routeOrder.limitPrice : undefined,
    );
    const midPrice = getMidpointPrice(effectiveBid, effectiveAsk);

    const lastOrderResponse = await chaseRouteOrderFill(
      accountNumber,
      candidateSymbol,
      routeOrder.quantity,
      plan,
      midPrice,
      effectiveCreateOrder,
      effectiveWaitForFill,
      deps.cancelOrder,
    );

    placedOrders.push({
      ...routeOrder,
      orderResponse: lastOrderResponse,
      placedOrder: true,
    });
  }

  // Diagnostic (v6 #18): allocateContractsByWeight's floor+greedy sizing can
  // silently collapse a multi-route order onto one or two routes (e.g. a
  // 3-contract order becoming bid-only), so the configured weights and what
  // actually executed can diverge. Log both so the drift is visible in the data.
  const executedQuantity = placedOrders.reduce((sum, order) => sum + order.quantity, 0);
  console.log(
    JSON.stringify({
      scope: "manage-allocation-executed-weights",
      accountNumber,
      candidateSymbol,
      executedQuantity,
      routes: placedOrders.map((order) => ({
        route: order.route,
        configuredWeight: order.weight,
        executedQuantity: order.quantity,
        executedShare:
          executedQuantity > 0 ? Number((order.quantity / executedQuantity).toFixed(3)) : 0,
      })),
    }),
  );

  return placedOrders;
}

// ── Age-scaled "give" on continued (held-contract) margin adds ───────────────
// The margin average-down guard blocks any add whose ask sits above our
// weighted-average fill (average down only). That is the right rule for a fresh
// entry — never chase a just-entered spike — but too rigid for an OLD, held
// position we still have conviction in: topping up conviction is not the same as
// chasing entry. The "give" allows adds a small amount ABOVE the average, where
// the tolerance grows with position AGE:
//   · fresh position (age 0) → near-zero give (unchanged: average down only)
//   · older held position    → more give (top up above cost, within a cap)
//
// The whole feature is OFF unless STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_ENABLED is
// truthy, so default behavior is exactly the current average-down-only rule.

// Master flag. Default OFF → getHeldAddAgeGivePct always returns 0 (unchanged).
export function isHeldAddAgeGiveEnabled(): boolean {
  return toBooleanFlag(process.env.STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_ENABLED);
}

// Age (in days) at which the give reaches its configured maximum. Younger
// positions get a linearly smaller give. Floored at a small positive number so
// the curve can never divide by zero or invert.
function getHeldAddAgeGiveFullDays(): number {
  const raw = readEnvPct("STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_FULL_DAYS", 3);
  return raw > 0 ? raw : 3;
}

// The give at full age, as a fraction of the weighted-average fill (0.04 = allow
// adds up to 4% above our average once the position is fully "aged"). This is the
// tunable target; the hard cap below bounds it regardless.
function getHeldAddAgeGiveMaxPct(): number {
  const raw = readEnvPct("STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_MAX_PCT", 0.05);
  return raw > 0 ? raw : 0;
}

// Absolute ceiling on the give, independent of the tunables above — a
// belt-and-suspenders guard so a fat-fingered env can never let margin chase far
// above its cost basis. Give is min(scaled, this).
export const HELD_ADD_AGE_GIVE_HARD_CAP_PCT = 0.10;

// Age → give curve: 0 at age 0, ramping LINEARLY to getHeldAddAgeGiveMaxPct at
// getHeldAddAgeGiveFullDays, then flat. Result is a fraction of the average fill
// and is hard-capped at HELD_ADD_AGE_GIVE_HARD_CAP_PCT. Returns 0 when the flag
// is off or age is unknown, so the caller falls back to average-down-only.
export function getHeldAddAgeGivePct(positionAgeDays: number | null): number {
  if (!isHeldAddAgeGiveEnabled()) return 0;
  if (positionAgeDays === null || !Number.isFinite(positionAgeDays) || positionAgeDays <= 0) {
    return 0;
  }

  const fullDays = getHeldAddAgeGiveFullDays();
  const t = Math.max(0, Math.min(1, positionAgeDays / fullDays));
  const scaled = getHeldAddAgeGiveMaxPct() * t;
  return Math.max(0, Math.min(scaled, HELD_ADD_AGE_GIVE_HARD_CAP_PCT));
}

// Age of a held group in days, derived from the earliest broker "created-at"
// across its snapshots (the leg we've held longest). Returns null when no
// snapshot carries a parseable timestamp — the give then resolves to 0.
export function getHeldGroupAgeDays(
  evaluation: PositionGroupEvaluation,
  currentTime: Date,
): number | null {
  let earliestMs: number | null = null;
  for (const snapshot of evaluation.positionSnapshots) {
    const createdAt = snapshot.position?.["created-at"];
    if (!createdAt) continue;
    const ms = Date.parse(String(createdAt));
    if (!Number.isFinite(ms)) continue;
    if (earliestMs === null || ms < earliestMs) earliestMs = ms;
  }
  if (earliestMs === null) return null;
  return (currentTime.getTime() - earliestMs) / 86_400_000;
}

// The margin average-down check, with the age-scaled give applied. Returns a skip
// reason when the ask exceeds our allowed add (avg × (1 + give)), or null when the
// add is permitted. Non-margin accounts and unknown/zero cost basis never block
// here (cash keeps its overnight-hold accumulation). With the give flag OFF the
// give is 0, so this reduces to "ask above our average → block" — the original
// average-down-only rule, message unchanged.
function getMarginAverageDownBlockReason(
  accountMarginOrCash: "margin" | "cash" | "unknown",
  heldWeightedAverageFill: number,
  ask: number,
  positionAgeDays: number | null,
): string | null {
  if (accountMarginOrCash !== "margin" || !(heldWeightedAverageFill > 0)) {
    return null;
  }

  const givePct = getHeldAddAgeGivePct(positionAgeDays);
  const maxAllowedAdd = heldWeightedAverageFill * (1 + givePct);
  if (ask <= maxAllowedAdd) {
    return null;
  }

  const avgText = `above our avg $${heldWeightedAverageFill.toFixed(2)}`;
  // givePct === 0 (flag off, or age 0/unknown) → the exact average-down-only
  // message; give > 0 annotates the age-scaled allowance it exceeded.
  if (givePct > 0) {
    const ageText = positionAgeDays !== null ? `${positionAgeDays.toFixed(1)}d old` : "age unknown";
    return `margin held add blocked: ask $${ask.toFixed(2)} ${avgText} + ${(givePct * 100).toFixed(1)}% age-give (max $${maxAllowedAdd.toFixed(2)}, ${ageText}) (average down only)`;
  }
  return `margin held add blocked: ask $${ask.toFixed(2)} ${avgText} (average down only)`;
}

// When the chain search finds nothing buyable for a group we already hold,
// fall back to adding to the held contract instead of skipping the group —
// gated by the same time-aware entry spread limit and a DTE floor so the
// fallback can't average into an expiring contract.
export function getHeldContractFallbackCandidate(
  evaluation: PositionGroupEvaluation,
  accountMarginOrCash: "margin" | "cash" | "unknown",
  currentTime = new Date(),
): TopOptionCandidateForSymbolResult {
  const snapshot = [...evaluation.positionSnapshots]
    .filter((positionSnapshot) =>
      Boolean(getOccExpirationDate(String(positionSnapshot.position.symbol ?? ""))),
    )
    .sort((a, b) => b.quantityWeight - a.quantityWeight)[0];

  if (!snapshot) {
    return { skippedReason: "no held option contract to fall back to" };
  }

  const symbol = String(snapshot.position.symbol);
  const expiration = getOccExpirationDate(symbol) as Date;
  const dte = Math.max(
    0,
    Math.ceil((expiration.getTime() - currentTime.getTime()) / 86_400_000),
  );
  const minHeldDte = accountMarginOrCash === "margin" ? 0 : 1;

  if (dte < minHeldDte) {
    return {
      dte,
      skippedReason: `held contract too close to expiry (${dte} DTE < ${minHeldDte})`,
    };
  }

  const bid = snapshot.currentBidPrice;
  const ask = snapshot.currentAskPrice;

  if (!(bid > 0) || !(ask > 0)) {
    return { dte, skippedReason: "held contract quote unavailable" };
  }

  const spreadPct = (ask - bid) / ((ask + bid) / 2);
  const maxAllowedSpreadPct = getMaxEntrySpreadPctForAccountType(
    accountMarginOrCash,
    currentTime,
  );

  // Held-contract adds are entries too, so they face the same account-aware
  // gate. Open interest and quote sizes aren't available from position
  // snapshots, so those checks degrade gracefully (pass + missing-field note).
  const liquidityGate = evaluateLiquidityGate({
    accountType: accountMarginOrCash,
    askSize: undefined,
    bidSize: undefined,
    currentTime,
    maxAllowedSpreadPct,
    openInterest: undefined,
    spreadPct,
  });
  logLiquidityGateDecision(
    {
      candidateSymbol: symbol,
      source: "held-contract-fallback",
      underlyingSymbol: evaluation.underlyingSymbol,
    },
    liquidityGate,
  );

  if (!liquidityGate.passed) {
    return {
      dte,
      spreadPct,
      skippedReason: liquidityGate.failedChecks.includes("spread")
        ? `held contract spread ${(spreadPct * 100).toFixed(2)}% exceeds ${(maxAllowedSpreadPct * 100).toFixed(2)}% max`
        : `held contract blocked by the entry liquidity gate (${liquidityGate.failedChecks.join(", ")})`,
    };
  }

  // Margin average-down guard (with age-scaled give): keep adding to a held
  // contract only while its ask is at or below our weighted-average fill plus the
  // age-scaled give — average down, never chase a fresh entry. Cash keeps its
  // overnight-hold accumulation behavior. See getMarginAverageDownBlockReason.
  const averageDownBlock = getMarginAverageDownBlockReason(
    accountMarginOrCash,
    snapshot.weightedAverageFill,
    ask,
    getHeldGroupAgeDays(evaluation, currentTime),
  );
  if (averageDownBlock) {
    return { askPrice: ask, bidPrice: bid, dte, spreadPct, skippedReason: averageDownBlock };
  }

  return {
    askPrice: ask,
    bidPrice: bid,
    dte,
    maxAllowedSpreadPct,
    meetsSpreadRequirement: true,
    quoteSymbol:
      (snapshot.position["streamer-symbol"] as string | undefined) ||
      (snapshot.position["quote-symbol"] as string | undefined) ||
      symbol,
    spreadPct,
    symbol,
  };
}

// Candidate-derived DTE fields carried on every post-candidate result.
export function candidateDteResultFields(
  candidate: TopOptionCandidateForSymbolResult | null | undefined,
): Pick<
  AllocationExecutionResult,
  "candidateDTE" | "maxDTE" | "minDTE" | "preferredDTE" | "usedDteFallback"
> {
  return {
    candidateDTE: candidate?.dte,
    maxDTE: candidate?.maxDTE,
    minDTE: candidate?.minDTE,
    preferredDTE: candidate?.preferredDTE,
    usedDteFallback: candidate?.usedDteFallback,
  };
}

// Reads the configured run-cycle interval in ms from the same env vars as the
// scheduler (BOT_RUN_INTERVAL_MS → BOT_RUN_INTERVAL_MINUTES → 4 min default).
function getRunIntervalMs(): number {
  const fromMs = Number(process.env.BOT_RUN_INTERVAL_MS);
  if (Number.isFinite(fromMs) && fromMs > 0) {
    return Math.floor(fromMs);
  }
  const fromMinutes = Number(process.env.BOT_RUN_INTERVAL_MINUTES);
  if (Number.isFinite(fromMinutes) && fromMinutes > 0) {
    return Math.floor(fromMinutes * 60 * 1000);
  }
  return 4 * 60 * 1000;
}

// Returns true when a new buy placed right now would land inside the EOD
// liquidation window. The guard fires if:
//   now > accumulationCutoff - 2 × runIntervalMs
// Two intervals back means: one interval to be sure the *next* cycle won't also
// buy (the entry cycle), and one more so the position has at least one full
// interval of life before the cutoff cycle can arrive and liquidate it.
export function isTooCloseToAccumulationCutoff(
  currentTime: Date,
  accountType: StrategyAccountType,
  runIntervalMs = getRunIntervalMs(),
): boolean {
  const timeInMinutes = currentTime.getHours() * 60 + currentTime.getMinutes()
    + currentTime.getSeconds() / 60;
  const cutoffMinute = getNoBuyCutoffMinute(accountType);
  const bufferMinutes = (2 * runIntervalMs) / (60 * 1000);
  return timeInMinutes > cutoffMinute - bufferMinutes;
}

// Injectable broker dependencies so manageAllocationForGroup can be characterized
// in tests without hitting the network (mirrors PlaceRouteOrdersDependencies).
export interface ManageAllocationDependencies {
  getOptionHealth?: typeof getOptionHealthForSymbol;
  getAccountType?: typeof getAccountMarginOrCash;
  getTopCandidate?: typeof getTopOptionCandidateForSymbol;
  getBidAsk?: (
    symbol: string,
    timeoutMs: number,
  ) => Promise<{ bid?: number | null; ask?: number | null } | null | undefined>;
  placeOrders?: typeof placeRouteOrders;
}

export async function manageAllocationForGroup(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  budget: AllocationBudget,
  groupsRemainingForAllocation = 1,
  options: ManageAllocationOptions = {},
  deps: ManageAllocationDependencies = {},
): Promise<AllocationExecutionResult> {
  const getOptionHealth = deps.getOptionHealth ?? getOptionHealthForSymbol;
  const getAccountType = deps.getAccountType ?? getAccountMarginOrCash;
  const getTopCandidate = deps.getTopCandidate ?? getTopOptionCandidateForSymbol;
  const getBidAsk =
    deps.getBidAsk ??
    ((symbol: string, timeoutMs: number) =>
      tastytradeApi.johnsService.getBidAskForSymbol(symbol, timeoutMs));
  const placeOrders = deps.placeOrders ?? placeRouteOrders;
  // Every result shares these fields; skip returns spread this and add specifics.
  // routeOrders defaults to [] and is overridden by returns that carry real orders.
  const skip = (
    extra: Partial<AllocationExecutionResult> & { skippedReason: string },
  ): AllocationExecutionResult => ({
    accountNumber,
    action: "MANAGE_ALLOCATION",
    placedOrder: false,
    routeOrders: [],
    underlyingSymbol: evaluation.underlyingSymbol,
    ...extra,
  });

  const targets = evaluation.executionTargets;

  if (!targets) {
    return skip({ skippedReason: "execution targets missing" });
  }

  // A group the bot could not have opened is not an accumulation target. Checked
  // FIRST of the group-level gates so a share lot costs no chain lookup, no quote
  // and no health call, and so the suppression is reported before anything else
  // can skip for an unrelated reason. Default ON — see allocation-instrument-guard.
  if (isAllocationBlockedByInstrumentGuard(evaluation)) {
    logSuppressedAllocation({
      accountNumber,
      evaluation,
      targetDTE: targets.targetDTE,
      wouldHaveBoughtSide: getCandidateSide(evaluation),
    });
    return skip({ skippedReason: buildSuppressedAllocationReason(evaluation) });
  }

  // The dip boost multiplies after the normalization/gate clamp so it survives
  // both — a boost baked into targetAccountExposure gets rescaled away when
  // group targets are normalized to the account schedule (see ExecutionTargets).
  const effectiveTargetAccountExposure =
    (targets.maxTargetAccountExposure != null
      ? Math.min(targets.targetAccountExposure, targets.maxTargetAccountExposure)
      : targets.targetAccountExposure) *
    (1 + (targets.dipTargetBoostPct ?? 0));
  const targetExposure = budget.totalCapital * effectiveTargetAccountExposure;
  const exposureHeadroom = targetExposure - budget.portfolioExposure;
  const baseBuyExposurePct = getMaxBuyExposurePctForAccountType(options.accountMarginOrCash ?? "cash");
  const maxBuyAmountPerAction =
    budget.totalCapital * (baseBuyExposurePct + (targets.booleanSurplusPct ?? 0));
  const normalizedGroupsRemaining = Math.max(1, groupsRemainingForAllocation);
  const perGroupExposureHeadroom = exposureHeadroom / normalizedGroupsRemaining;
  const perGroupMaxBuyAmount = maxBuyAmountPerAction / normalizedGroupsRemaining;

  if (effectiveTargetAccountExposure <= 0) {
    return skip({ skippedReason: "target exposure is zero" });
  }

  if (exposureHeadroom <= 0 || budget.buyingPowerRemaining <= 0) {
    return skip({ skippedReason: "no remaining exposure or buying power" });
  }

  // Guard: do not open a new position when the current time is within two run
  // intervals of the accumulation cutoff. A buy placed that close is virtually
  // guaranteed to be EOD-liquidated in the very next cycle — a round-trip churn
  // loss with no chance to hold. Only applies when options.accountMarginOrCash is
  // known; if it's absent the guard is skipped (can't determine the right cutoff).
  const cutoffAccountType = options.accountMarginOrCash;
  if (cutoffAccountType) {
    const currentTime = evaluation.metrics.currentTime;
    if (isTooCloseToAccumulationCutoff(currentTime, cutoffAccountType)) {
      const cutoffMinute = getNoBuyCutoffMinute(cutoffAccountType);
      const cutoffHH = String(Math.floor(cutoffMinute / 60)).padStart(2, "0");
      const cutoffMM = String(cutoffMinute % 60).padStart(2, "0");
      console.log(
        JSON.stringify({
          scope: "manage-allocation-cutoff-guard",
          action: "skip",
          accountNumber,
          underlyingSymbol: evaluation.underlyingSymbol,
          accountType: cutoffAccountType,
          currentTime: currentTime.toISOString(),
          accumulationCutoff: `${cutoffHH}:${cutoffMM} PT`,
          runIntervalMs: getRunIntervalMs(),
          reason: "too close to accumulation cutoff — skipping new entry",
        }),
      );
      return skip({
        skippedReason: `too close to accumulation cutoff (${cutoffHH}:${cutoffMM} PT) — skipping new entry for ${evaluation.underlyingSymbol}`,
      });
    }
  }

  // Absolute per-underlying accumulation ceilings (IMPROVEMENTS.v8 #4): bound
  // the TOTAL a group may reach, on top of the per-action caps below. The
  // buy-position multiple alone compounds — it re-reads current value every
  // cycle, so a fast series of "small" adds grew a 15-lot WEN position in ~70
  // minutes on 2026-07-06. Headroom derives only from live broker positions
  // (stateless), so an intraday restart cannot re-open accumulation.
  const maxUnderlyingContracts = getMaxUnderlyingContracts();
  const maxUnderlyingNotional = getMaxUnderlyingNotional();
  const heldContracts = getGroupContractCount(evaluation.positionSnapshots);
  const groupMarketValue = getGroupMarketValue(evaluation.positionSnapshots);
  const underlyingContractsHeadroom = Number.isFinite(maxUnderlyingContracts)
    ? Math.max(0, maxUnderlyingContracts - heldContracts)
    : Infinity;
  const underlyingNotionalHeadroom = Number.isFinite(maxUnderlyingNotional)
    ? Math.max(0, maxUnderlyingNotional - groupMarketValue)
    : Infinity;

  if (underlyingContractsHeadroom < 1 || underlyingNotionalHeadroom <= 0) {
    console.log(
      JSON.stringify({
        scope: "allocation-underlying-cap",
        action: "skip",
        accountNumber,
        underlyingSymbol: evaluation.underlyingSymbol,
        heldContracts,
        maxUnderlyingContracts: Number.isFinite(maxUnderlyingContracts)
          ? maxUnderlyingContracts
          : null,
        groupMarketValue: Number(groupMarketValue.toFixed(2)),
        maxUnderlyingNotional: Number.isFinite(maxUnderlyingNotional)
          ? maxUnderlyingNotional
          : null,
      }),
    );
    return skip({
      skippedReason:
        underlyingContractsHeadroom < 1
          ? `underlying contract cap reached (holding ${heldContracts} >= max ${maxUnderlyingContracts})`
          : `underlying notional cap reached (position value $${groupMarketValue.toFixed(2)} >= max $${maxUnderlyingNotional.toFixed(2)})`,
    });
  }

  const optionSide = getCandidateSide(evaluation);
  const healthResult = await getOptionHealth(
    evaluation.underlyingSymbol,
    optionSide,
  );
  const healthGate = evaluateOptionHealthForTargetDTE(
    healthResult.summary,
    targets.targetDTE,
  );

  console.log(
    JSON.stringify({
      scope: "manage-allocation-health-gate",
      underlyingSymbol: evaluation.underlyingSymbol,
      requestedSide: optionSide,
      targetDTE: targets.targetDTE,
      requiredHealthyTargets: healthGate.requiredHealthyTargets,
      missingRequiredTargets: healthGate.missingRequiredTargets,
      passed: healthGate.passed,
      healthSummary: healthResult.summary,
    }),
  );

  if (!healthGate.passed) {
    return skip({
      skippedReason: `option health gate failed for target DTE ${targets.targetDTE}; missing healthy checkpoints: ${healthGate.missingRequiredTargets.join(", ")}`,
    });
  }

  const accountMarginOrCash = await getAccountType(accountNumber);
  // accountType drives the entry liquidity gate during selection: margin gets
  // its (potentially tighter) entry-spread ceiling, cash keeps the shared gate.
  let candidate = await getTopCandidate(
    evaluation.underlyingSymbol,
    optionSide,
    targets.targetDTE,
    accountMarginOrCash === "margin"
      ? {
          accountType: accountMarginOrCash,
          strikeTarget: "otm",
          targetDelta: getMarginTargetCallDelta(),
        }
      : { accountType: accountMarginOrCash },
  );
  let usedHeldContractFallback = false;
  let usedMarginItmFallback = false;

  // Margin ITM fallback: on low-priced/illiquid names the OTM strikes are
  // dead-quoted (wide spreads) while the ATM/ITM strike is tradeable. When the
  // OTM pick fails the entry-spread/liquidity gate (not the IV gate), and the
  // signal reads as a HOLD / high conviction (marginItmFallbackEligible, set in
  // run-cycle-context), retry with the ITM selector — nearest-the-money strike
  // that passes the margin gate.
  if (
    accountMarginOrCash === "margin" &&
    targets.marginItmFallbackEligible === true &&
    !candidate?.symbol &&
    !candidate?.skippedByIvGate
  ) {
    const itmCandidate = await getTopCandidate(
      evaluation.underlyingSymbol,
      optionSide,
      targets.targetDTE,
      { accountType: "margin", strikeTarget: "itm" },
    );
    console.log(
      JSON.stringify({
        scope: "manage-allocation-margin-itm-fallback",
        underlyingSymbol: evaluation.underlyingSymbol,
        targetDTE: targets.targetDTE,
        otmSkippedReason: candidate?.skippedReason ?? "no candidate",
        itmSymbol: itmCandidate?.symbol ?? null,
        itmSpreadPct: itmCandidate?.spreadPct ?? null,
        itmSkippedReason: itmCandidate?.skippedReason ?? null,
      }),
    );
    if (itmCandidate?.symbol) {
      candidate = itmCandidate;
      usedMarginItmFallback = true;
    }
  }

  // Fallback only — the chain pick stays authoritative. IV-gate skips are an
  // intentional entry filter, so they do not fall back.
  if (!candidate?.symbol && !candidate?.skippedByIvGate) {
    const heldFallback = getHeldContractFallbackCandidate(
      evaluation,
      accountMarginOrCash,
    );

    console.log(
      JSON.stringify({
        scope: "manage-allocation-held-contract-fallback",
        underlyingSymbol: evaluation.underlyingSymbol,
        targetDTE: targets.targetDTE,
        chainSkippedReason: candidate?.skippedReason ?? "no candidate",
        fallbackSymbol: heldFallback.symbol ?? null,
        fallbackDTE: heldFallback.dte ?? null,
        fallbackSkippedReason: heldFallback.skippedReason ?? null,
      }),
    );

    if (heldFallback.symbol) {
      candidate = heldFallback;
      usedHeldContractFallback = true;
    }
  }

  console.log(
    JSON.stringify({
      scope: "manage-allocation-candidate",
      underlyingSymbol: evaluation.underlyingSymbol,
      requestedSide: optionSide,
      targetDTE: targets.targetDTE,
      candidateDTE: candidate?.dte,
      minDTE: candidate?.minDTE,
      maxDTE: candidate?.maxDTE,
      preferredDTE: candidate?.preferredDTE,
      usedDteFallback: candidate?.usedDteFallback ?? false,
      usedMarginItmFallback,
      symbol: candidate?.symbol ?? null,
      // Liquidity distribution collection (IMPROVEMENTS.v4 strategy #4 step 1)
      dayVolume: candidate?.dayVolume ?? null,
      openInterest: candidate?.openInterest ?? null,
      bidSize: candidate?.bidSize ?? null,
      askSize: candidate?.askSize ?? null,
      spreadPct: candidate?.spreadPct ?? null,
    }),
  );

  if (!candidate?.symbol) {
    return skip({
      ...candidateDteResultFields(candidate),
      skippedReason: "no option candidate found",
    });
  }

  // Minimum DTE guard: reject new entries on options that are too close to
  // expiration. The held-contract fallback can surface an expiring contract
  // the chain pick would have filtered, so this check runs after ALL fallbacks
  // are resolved (chain pick → margin ITM → held-contract) but before any order
  // is dispatched. The ITM-fallback branch is intentionally NOT exempt: it is a
  // new-entry path for new positions on low-priced names, not an add to an
  // existing expiring lot.
  const minEntryDTE = readEnvInt("STRATEGY_MIN_ENTRY_DTE", 2, (n) => n >= 0);
  if (typeof candidate.dte === "number" && candidate.dte < minEntryDTE) {
    return skip({
      skippedReason: `candidate DTE too short for new entry (${candidate.dte} DTE < ${minEntryDTE} minimum) — ${candidate.symbol ?? "unknown"}`,
      candidateDTE: candidate.dte,
      minDTE: minEntryDTE,
      candidateSymbol: candidate.symbol,
    });
  }

  const bidAsk = await getBidAsk(
    candidate.quoteSymbol ?? candidate.streamerSymbol ?? candidate.symbol,
    3000,
  );
  let bid = bidAsk?.bid ?? 0;
  let ask = bidAsk?.ask ?? bid;
  const buyPositionMultiple = getMaxAllocationBuyPositionMultiple();
  const positionValueBuyCap = Number.isFinite(buyPositionMultiple)
    ? groupMarketValue * buyPositionMultiple
    : Infinity;
  const availableCapitalBeforeUnderlyingCap = Math.min(
    Math.max(0, perGroupExposureHeadroom),
    Math.max(0, perGroupMaxBuyAmount),
    budget.buyingPowerRemaining,
    positionValueBuyCap,
  );
  // The notional ceiling bounds the group's TOTAL value (held + this add), so
  // the spend allowance is the remaining headroom under it.
  const availableCapital = Math.min(
    availableCapitalBeforeUnderlyingCap,
    underlyingNotionalHeadroom,
  );
  if (availableCapital < availableCapitalBeforeUnderlyingCap) {
    console.log(
      JSON.stringify({
        scope: "allocation-underlying-cap",
        action: "clamp-capital",
        accountNumber,
        underlyingSymbol: evaluation.underlyingSymbol,
        availableCapitalBeforeCap: Number(
          availableCapitalBeforeUnderlyingCap.toFixed(2),
        ),
        availableCapital: Number(availableCapital.toFixed(2)),
        groupMarketValue: Number(groupMarketValue.toFixed(2)),
        maxUnderlyingNotional,
      }),
    );
  }

  // Trims sized route orders to the contract-cap headroom, logging when the
  // cap (not the budget) was the binding constraint. Applied to both the chain
  // pick and the held-contract fallback sizing.
  const applyUnderlyingContractCap = (
    sizedRouteOrders: AllocationRouteResult[],
  ): AllocationRouteResult[] => {
    const requestedQuantity = sizedRouteOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.quantity,
      0,
    );
    const clampedRouteOrders = clampRouteOrdersToMaxTotalQuantity(
      sizedRouteOrders,
      underlyingContractsHeadroom,
    );
    const clampedQuantity = clampedRouteOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.quantity,
      0,
    );
    if (clampedQuantity < requestedQuantity) {
      console.log(
        JSON.stringify({
          scope: "allocation-underlying-cap",
          action: "clamp-quantity",
          accountNumber,
          underlyingSymbol: evaluation.underlyingSymbol,
          requestedQuantity,
          clampedQuantity,
          heldContracts,
          maxUnderlyingContracts,
        }),
      );
    }
    return clampedRouteOrders;
  };

  let routeOrders = applyUnderlyingContractCap(
    allocateContractsByWeight(buildRouteOrders(bid, ask, targets), availableCapital),
  );

  if (routeOrders.length === 0) {
    return skip({
      ...candidateDteResultFields(candidate),
      skippedReason: "candidate quote unavailable",
    });
  }

  let totalQuantity = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  // The chain pick can be unaffordable under the per-action budget while the
  // contract we already hold is not (e.g. cash's 5% cap vs a fresh ITM pick).
  // Retry sizing with the held contract before giving up on the add.
  if (totalQuantity < 1 && !usedHeldContractFallback) {
    const heldFallback = getHeldContractFallbackCandidate(
      evaluation,
      accountMarginOrCash,
    );

    if (heldFallback.symbol && heldFallback.symbol !== candidate.symbol) {
      const heldBidAsk = await getBidAsk(
        heldFallback.quoteSymbol ?? heldFallback.streamerSymbol ?? heldFallback.symbol,
        3000,
      );
      const heldBid = heldBidAsk?.bid ?? heldFallback.bidPrice ?? 0;
      const heldAsk = heldBidAsk?.ask ?? heldFallback.askPrice ?? heldBid;
      const heldRouteOrders = applyUnderlyingContractCap(
        allocateContractsByWeight(
          buildRouteOrders(heldBid, heldAsk, targets),
          availableCapital,
        ),
      );
      const heldQuantity = heldRouteOrders.reduce(
        (sum, routeOrder) => sum + routeOrder.quantity,
        0,
      );

      console.log(
        JSON.stringify({
          scope: "manage-allocation-held-contract-fallback",
          underlyingSymbol: evaluation.underlyingSymbol,
          reason: "chain candidate unaffordable for per-action budget",
          chainCandidate: candidate.symbol,
          heldContract: heldFallback.symbol,
          availableCapital,
          heldQuantity,
        }),
      );

      if (heldQuantity >= 1) {
        candidate = heldFallback;
        bid = heldBid;
        ask = heldAsk;
        routeOrders = heldRouteOrders;
        totalQuantity = heldQuantity;
        usedHeldContractFallback = true;
      }
    }
  }

  if (totalQuantity < 1) {
    return skip({
      ...candidateDteResultFields(candidate),
      candidateSymbol: candidate.symbol,
      routeOrders,
      skippedReason: "insufficient budget for one contract",
    });
  }

  if (options.dryRun) {
    const estimatedOrderValue = routeOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
      0,
    );

    return skip({
      ...candidateDteResultFields(candidate),
      candidateSymbol: candidate.symbol,
      estimatedOrderValue,
      quantity: totalQuantity,
      routeOrders,
      skippedReason: "dry-run plan",
      usedHeldContractFallback: usedHeldContractFallback || undefined,
    });
  }

  const candidateSymbol = candidate.symbol;
  if (!candidateSymbol) {
    // Unreachable: both the chain guard above and the held fallback branch
    // require a symbol — this exists to keep the narrowing after reassignment.
    return skip({ skippedReason: "no option candidate found" });
  }

  const placedRouteOrders = await placeOrders(
    accountNumber,
    candidateSymbol,
    routeOrders,
    bid,
    ask,
  );
  const estimatedOrderValue = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
    0,
  );
  const quantity = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  return {
    accountNumber,
    action: "MANAGE_ALLOCATION",
    ...candidateDteResultFields(candidate),
    candidateSymbol: candidate.symbol,
    estimatedOrderValue,
    orderResponses: placedRouteOrders
      .map((routeOrder) => routeOrder.orderResponse)
      .filter(
        (orderResponse): orderResponse is TastytradePlacedOrderResponse =>
          orderResponse != null,
      ),
    placedOrder: placedRouteOrders.some((routeOrder) => routeOrder.placedOrder),
    quantity,
    routeOrders: placedRouteOrders,
    underlyingSymbol: evaluation.underlyingSymbol,
    usedHeldContractFallback: usedHeldContractFallback || undefined,
  };
}

export function getUpdatedBudgetAfterAllocation(
  budget: AllocationBudget,
  evaluation: PositionGroupEvaluation,
  executionResult: AllocationExecutionResult,
): AllocationBudget {
  if (!executionResult.placedOrder || !executionResult.estimatedOrderValue) {
    return budget;
  }

  return {
    buyingPowerRemaining: Math.max(
      0,
      budget.buyingPowerRemaining - executionResult.estimatedOrderValue,
    ),
    portfolioExposure:
      budget.portfolioExposure + executionResult.estimatedOrderValue,
    totalCapital: budget.totalCapital,
  };
}

