# Order-source migration: `tastytrade-silver-lynx*` → `silver-lynx-tastytrade*`

_Status: prepared on branch `order-id-convention` — NOT deployed._

The Tastytrade order `source` tag is moving from the OLD venue-first form
`tastytrade-silver-lynx*` to the NEW system-first form `silver-lynx-tastytrade*`
(matching the sibling repos `silver-lynx-alpaca` / `silver-lynx-tastytrade`). The
legacy golden-lion line `tastytrade-golden-lion*` gets the matching new form
`silver-lynx-golden-lion*`.

## Why this is delicate

`source` is a **wire identifier**: it is written into Tastytrade's immutable order
history and read back on every order. The bot uses it, on a **shared** account, to
decide "my order vs. someone else's":

- The per-cycle cancel sweep (`cancelAllLiveOrders`) cancels only orders it can
  positively identify as its own (`classifyOrderSource(source) === "bot"` via
  `isSweepEligibleSource`). A hand-placed order in the shared margin account must be
  left alone.
- Position provenance disarms stops / EOD-sweep for `manual` and `owner-directed`
  groups.
- Realized-P&L attribution credits fills to `bot` vs `owner`.

If placement flipped to the new tag before the matchers understood it, the bot would
stop recognising its **own** freshly-placed orders — leaving its stale limits resting
and mis-attributing its own fills to "the owner". Conversely, in-flight and historical
orders keep the OLD tag forever (history is immutable), so the matchers can never drop
the legacy forms either.

## The two stages (ship SEPARATELY, in order)

### Stage 1 — dual-aware matchers (commit "matcher")

Every place that classifies a `source` string now accepts **all four** brand-era
prefixes — the two NEW (`silver-lynx-tastytrade`, `silver-lynx-golden-lion`) and the
two LEGACY (`tastytrade-silver-lynx`, `tastytrade-golden-lion`):

- `src/bot/order-sources.ts` — single source of truth. `BOT_ORDER_SOURCE_PREFIXES`
  now lists all four. `isBotOrderSource` prefix-matches against them.
  The per-subsystem predicates (`isOwnerDirectedOrderSource`,
  `isSprayBuyOrderSource`, `isSecretAutoSeedOrderSource`,
  `isOvernightReductionOrderSource`, `isMarginSeedFromCashOrderSource`) now match on
  the **suffix** after stripping any known prefix, so a resting slice placed under
  any brand era is still spared.
- `src/bot/position-provenance.ts` — dropped its duplicate prefix list and
  `isBotOrderSource`; it now imports (and re-exports) the one in `order-sources.ts`.
  `classifyOrderSource` / `classifyGroupProvenance` are unchanged and inherit the
  dual-awareness. This is what `isSweepEligibleSource` (in
  `execute-position-evaluations.ts`) and realized-P&L attribution
  (`realized-pnl-report.ts`) call through.

**Placement is UNCHANGED in stage 1** — newly-placed orders still carry the OLD
`tastytrade-silver-lynx*` tag. This commit is safe to deploy on its own and changes
no observable behaviour except that the sweep/provenance/P&L now *also* recognise the
new tag (which nothing yet emits).

### Stage 2 — flip placement (commit "placement")

Only after stage 1 is deployed and verified, flip the tags the bot **writes**:

- `src/bot/order-sources.ts` — the six placement constants → `silver-lynx-tastytrade*`.
- `src/bot/actions/manage-allocation.ts` — the `source:` literal.
- `src/bot/actions/order-utils.ts` — the `source ?? …` fallback literal.

(The submission sites in `seed-symbol.ts`, `spray-buy.ts`,
`overnight-position-reduction.ts`, `secret-auto-seed.ts`, and `run-cycle-seed.ts`
carry the constants, so they follow automatically.)

## Deploy / rollout sequence

1. **Deploy Stage 1 alone.** Verify on the box that the sweep still classifies
   correctly — `pm2 logs` should show `position-provenance` counts unchanged and
   cancel-sweep `skippedReason: protected non-bot order (...)` only for genuinely
   foreign orders. No bot order should newly classify as `manual`.
2. **Then deploy Stage 2.** New orders now carry `silver-lynx-tastytrade*`; confirm
   they are still swept/managed as the bot's own and that legacy resting orders (old
   tag) remain correctly classified.

Rolling back Stage 2 alone is safe (matchers stay dual-aware). Never deploy Stage 2
without Stage 1 live first.
