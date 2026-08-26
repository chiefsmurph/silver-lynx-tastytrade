// ---------------------------------------------------------------------------
// Order-source tags this bot stamps on every order it submits to Tastytrade.
//
// NAMING MIGRATION (in progress). The brand is moving from the OLD venue-first
// form `tastytrade-silver-lynx*` to the NEW system-first form
// `silver-lynx-tastytrade*` (matching the sibling repos silver-lynx-alpaca /
// silver-lynx-tastytrade). Order sources are a WIRE identifier — they are written
// into the broker's immutable order history — so this is a two-stage migration,
// NOT a rename-in-place:
//
//   1. First, teach EVERY source matcher to accept BOTH the new and every legacy
//      form (this file's predicates + `position-provenance.ts` + the cancel-sweep
//      per-source protections). In-flight and historical orders still classify and
//      protect correctly.
//   2. ONLY THEN flip the PLACEMENT constants below to the new `silver-lynx-*`
//      values, so newly-submitted orders carry the new tag.
//
// Stage 1 is live-safe on its own; stage 2 must never ship before it. See
// docs/RENAME-STATUS.md and docs/ORDER-SOURCE-MIGRATION.md.
// ---------------------------------------------------------------------------

// PLACEMENT constants — stamped on newly-submitted orders.
//
// STAGE 2 (this commit): flipped to the NEW system-first form. Safe ONLY because
// stage 1 (dual-aware matchers) is already live — the sweep/provenance/P&L already
// recognise this tag. The legacy `tastytrade-silver-lynx*` forms remain matched
// forever for in-flight and historical orders. See docs/ORDER-SOURCE-MIGRATION.md.
export const BOT_ORDER_SOURCE = "silver-lynx-tastytrade";
export const MARGIN_SEED_FROM_CASH_ORDER_SOURCE =
  "silver-lynx-tastytrade-margin-seed-from-cash";
export const CASH_SEED_FROM_MARGIN_ORDER_SOURCE =
  "silver-lynx-tastytrade-cash-seed-from-margin";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "silver-lynx-tastytrade-secret-auto-seed";
export const OVERNIGHT_REDUCTION_ORDER_SOURCE =
  "silver-lynx-tastytrade-overnight-reduction";
// Spray-buy slices carry this source so the per-cycle cancel sweep leaves resting
// limit slices in place across cycles (a spray spans several ~4min cycles). The
// spray executor owns their lifecycle: it fills, expires (Day TIF), or aborts them.
export const SPRAY_BUY_ORDER_SOURCE = "silver-lynx-tastytrade-spray-buy";

/**
 * OWNER-DIRECTED: placed BY this process but expressing the OWNER's conviction,
 * not a strategy decision (e.g. the planned inbound-SMS "text a ticker to buy it"
 * path). It is deliberately NOT a managed source: the owner owns the exit, so
 * `position-provenance.ts` classifies it do-not-touch exactly like a hand-placed
 * order, which also keeps it out of the 12:50 margin EOD sweep that would
 * otherwise flatten a conviction trade the same day it was opened.
 *
 * No producer yet — wiring the SMS path means passing this as `orderSource`.
 */
export const OWNER_DIRECTED_ORDER_SOURCE = "silver-lynx-tastytrade-owner-directed";

// ---------------------------------------------------------------------------
// SUFFIXES + PREFIX FAMILIES (the migration back-compat layer).
//
// Every source string is `<prefix>` or `<prefix><suffix>`, where `<prefix>` is
// one of the four brand-eras below and `<suffix>` names the subsystem. The
// per-subsystem predicates match on the SUFFIX after stripping any known prefix,
// so a spray-buy slice placed under ANY brand era (old or new) is still spared by
// the sweep. Adding the new prefix here is what makes stage 1 dual-aware.
// ---------------------------------------------------------------------------

const MARGIN_SEED_FROM_CASH_SUFFIX = "-margin-seed-from-cash";
const SECRET_AUTO_SEED_SUFFIX = "-secret-auto-seed";
const OVERNIGHT_REDUCTION_SUFFIX = "-overnight-reduction";
const SPRAY_BUY_SUFFIX = "-spray-buy";
const OWNER_DIRECTED_SUFFIX = "-owner-directed";

/**
 * Every brand-era prefix this bot has EVER stamped on an order, newest first.
 *
 * All four are LOAD-BEARING, none are dead code:
 *   - `silver-lynx-tastytrade` — the NEW system-first brand (stage-2 placement).
 *   - `silver-lynx-golden-lion` — the NEW form of the legacy golden-lion line.
 *   - `tastytrade-silver-lynx`  — the OLD venue-first brand; every order placed
 *     before the stage-2 flip sits at the broker under it.
 *   - `tastytrade-golden-lion`  — the pre-2026-07-27 self-brand (commit efda628);
 *     orders older than that date still carry it in the broker's history.
 *
 * The broker's order history is IMMUTABLE. Dropping any prefix would reclassify
 * genuinely-bot orders as owner-placed — disarming their stops and un-protecting
 * them from the sweep — the exact failure the provenance module exists to prevent.
 * Never remove one.
 */
export const BOT_ORDER_SOURCE_PREFIXES = [
  "silver-lynx-tastytrade",
  "silver-lynx-golden-lion",
  "tastytrade-silver-lynx",
  "tastytrade-golden-lion",
] as const;

/** The known brand prefix at the head of `normalized`, or null if none. */
function matchedBotPrefix(normalized: string): string | null {
  return BOT_ORDER_SOURCE_PREFIXES.find((prefix) => normalized.startsWith(prefix)) ?? null;
}

/**
 * Does `source` carry `suffix` under ANY known brand prefix?
 *
 * `silver-lynx-tastytrade-spray-buy`  (new) and
 * `tastytrade-silver-lynx-spray-buy`  (legacy) and
 * `tastytrade-golden-lion-spray-buy`  (pre-rename) all match `-spray-buy`.
 *
 * This is exact on the suffix (the remainder after the prefix must equal it), so
 * `silver-lynx-tastytrade-spray-buy-extra` would NOT match — subsystem tags are a
 * closed set, and a partial match could mis-protect an unrelated future tag.
 */
function hasBotSourceSuffix(source: string | null | undefined, suffix: string): boolean {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const prefix = matchedBotPrefix(normalized);
  if (prefix === null) return false;
  return normalized.slice(prefix.length) === suffix.toLowerCase();
}

/**
 * Did THIS bot place the order? Prefix match, because each subsystem appends its
 * own suffix (`-overnight-reduction`, `-spray-buy`, …) and new ones get added
 * without this predicate knowing about them.
 *
 * An owner-placed order (dashboard, mobile app) carries none of the brand
 * prefixes, which is the only way to tell a bot-caused fill from a hand-placed
 * one after the fact.
 */
export function isBotOrderSource(source: string | null | undefined): boolean {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return matchedBotPrefix(normalized) !== null;
}

export function isOwnerDirectedOrderSource(source: string | null | undefined): boolean {
  return hasBotSourceSuffix(source, OWNER_DIRECTED_SUFFIX);
}

export function isMarginSeedFromCashOrderSource(
  source: string | null | undefined,
): boolean {
  return hasBotSourceSuffix(source, MARGIN_SEED_FROM_CASH_SUFFIX);
}

export function isSecretAutoSeedOrderSource(source: string | null | undefined): boolean {
  return hasBotSourceSuffix(source, SECRET_AUTO_SEED_SUFFIX);
}

export function isOvernightReductionOrderSource(
  source: string | null | undefined,
): boolean {
  return hasBotSourceSuffix(source, OVERNIGHT_REDUCTION_SUFFIX);
}

export function isSprayBuyOrderSource(source: string | null | undefined): boolean {
  return hasBotSourceSuffix(source, SPRAY_BUY_SUFFIX);
}
