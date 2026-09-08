// Startup config hygiene: print the resolved trading config once at boot and
// warn loudly on recognized-but-obsolete env names, so a stale .env fails
// visibly instead of silently reverting to in-code defaults (the class of
// drift behind the 07-02 prod incident: a pre-refactor server .env would
// silently disable ~30 renamed vars on the next deploy).
import { getMaxOptionSpreadPct, getMinIvRankPct, getMarginTargetCallDelta } from "~/strategy/entry-filters";
import {
  getMarginMaxEntrySpreadPct,
  getMinOpenInterest,
  isPhantomQuoteGuardEnabled,
} from "~/strategy/liquidity-gate";
import { getMarginMaxBuyExposurePct, getCashMaxBuyExposurePct } from "~/strategy/risk-limits";
import {
  getCombinedUnderlyingCapPct,
  getMaxUnderlyingAccountPct,
  getMinLiquidityCapMultiplier,
} from "~/strategy/option-liquidity-quality";
import { getMarginSeedConfig, getCashSeedFromMarginConfig } from "~/strategy/seed-decision";
import { getSeedSizingFloorPct, getSeedSizingCeilingPct } from "~/strategy/seed-sizing-model";
import { getMarginMaxTotalUtilization } from "~/strategy/seed-sizing-live";
import {
  getIntradayStopLossFloor,
  getStopLossMidConfirmFloor,
  isStopLossMidConfirmEnabled,
} from "~/strategy/evaluate-trading-strategy";
import { getMinBidRouteDepthPct } from "~/bot/actions/manage-allocation";
import { getSprayBuyConfigSnapshot } from "~/bot/actions/spray-buy";

export interface EnvNameFinding {
  name: string;
  guidance: string;
}

// Old name → what happened to it. Setting any of these does nothing today.
const OBSOLETE_ENV_VARS: Record<string, string> = {
  BASE_URL: "renamed to CORE_BASE_URL",
  API_CLIENT_SECRET: "renamed to CORE_API_CLIENT_SECRET",
  API_REFRESH_TOKEN: "renamed to CORE_API_REFRESH_TOKEN",
  BOT_MAX_OPTION_SPREAD_PCT: "renamed to STRATEGY_MAX_OPTION_SPREAD_PCT",
  BOT_MIN_IV_RANK_PCT: "renamed to STRATEGY_MIN_IV_RANK_PCT",
  BOT_MARGIN_TARGET_CALL_DELTA: "renamed to STRATEGY_MARGIN_TARGET_CALL_DELTA",
  BOT_MARGIN_MAX_TARGET_DTE: "renamed to STRATEGY_MARGIN_MAX_TARGET_DTE",
  BOT_CASH_MIN_TARGET_DTE: "renamed to STRATEGY_CASH_MIN_TARGET_DTE",
  BOT_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT: "renamed to STRATEGY_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT",
  BOT_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT: "renamed to STRATEGY_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT",
  BOT_CROSS_ACCOUNT_YES_DOWN_PCT: "renamed to STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT",
  BOT_INTRADAY_STOP_LOSS_PCT: "renamed to STRATEGY_INTRADAY_STOP_LOSS_PCT",
  BOT_EOD_STOP_LOSS_PCT: "renamed to STRATEGY_EOD_STOP_LOSS_PCT",
  BOT_MAX_BUY_POWER_PCT:
    "removed — see STRATEGY_MARGIN_MAX_BUY_EXPOSURE_PCT / STRATEGY_CASH_MAX_BUY_EXPOSURE_PCT",
  BOT_RUN_HISTORY_DIR: "removed — run history always lives under BOT_DATA_DIR (default ./data)",
  BOT_SEED_ONLY_TO_MARGIN_ACCOUNTS: "removed — no replacement",
  SECRET_AUTO_SEED_END_TIME: "removed — the seed window end is fixed at 13:00 PT",
  // daytradeScore gate legs removed 2026-07-19 (forward-return backtest:
  // dip polarity granted tiers inside the -70..-150 death valley).
  STRATEGY_GATE_BASIC_DAYTRADE_SCORE_THRESHOLD:
    "removed — daytradeScore dropped from all decision paths 2026-07-19",
  STRATEGY_GATE_STRONG_DAYTRADE_SCORE_THRESHOLD:
    "removed — daytradeScore dropped from all decision paths 2026-07-19",
  STRATEGY_GATE_STRONG_DAYTRADE_SCORE_MAX:
    "removed — daytradeScore dropped from all decision paths 2026-07-19",
  // Dollar-denominated sizing knobs retired 2026-07-21: every seed / position
  // limit is now a PERCENT of NLV.
  BOT_MAX_SEED_ORDER_COST:
    "removed — seed size is governed by SECRET_SEED_SIZING_FLOOR_PCT/_CEILING_PCT (%-of-NLV) + the %-of-account concentration caps; no dollar clip",
  STRATEGY_MAX_UNDERLYING_NOTIONAL:
    "removed — redundant with STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT (%-of-account) + STRATEGY_MAX_UNDERLYING_CONTRACTS; no dollar cap",
};

// Legacy names the code still honors via explicit fallback (readEnvPctWithLegacy).
// They work today but should be renamed before the fallback is ever dropped.
const LEGACY_HONORED_ENV_VARS: Record<string, string> = {
  STRATEGY_GATE_STRONG_STOCK_YES_MAX_PCT:
    "rename to STRATEGY_GATE_STRONG_PERCENT_OF_BALANCE_THRESHOLD",
};

const CONFIG_PREFIX_PATTERN = /^(CORE_|BOT_|STRATEGY_|SECRET_|TASTYTRADE_)/;
const SENSITIVE_KEY_PATTERN = /TOKEN|CLIENT_SECRET|SOCKET_URL|POSITIONS_KEY|AUTH_KEY/;

function isSet(value: string | undefined): boolean {
  return value != null && value.trim().length > 0;
}

export function findObsoleteEnvNames(env: NodeJS.ProcessEnv = process.env): EnvNameFinding[] {
  const findings: EnvNameFinding[] = [];

  for (const [name, guidance] of Object.entries(OBSOLETE_ENV_VARS)) {
    if (isSet(env[name])) {
      findings.push({ name, guidance });
    }
  }

  // The whole TASTYTRADE_ prefix family predates the July-1 rename.
  for (const name of Object.keys(env)) {
    if (name.startsWith("TASTYTRADE_") && isSet(env[name])) {
      findings.push({
        name,
        guidance: name === "TASTYTRADE_BOT_SOCKET"
          ? "renamed to CORE_IPC_SOCKET"
          : "obsolete TASTYTRADE_* name — removed in the July-1 prefix refactor",
      });
    }
  }

  return findings.sort((left, right) => left.name.localeCompare(right.name));
}

export function findLegacyHonoredEnvNames(env: NodeJS.ProcessEnv = process.env): EnvNameFinding[] {
  return Object.entries(LEGACY_HONORED_ENV_VARS)
    .filter(([name]) => isSet(env[name]))
    .map(([name, guidance]) => ({ name, guidance }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function maskEnvValue(key: string, value: string): string {
  if (!SENSITIVE_KEY_PATTERN.test(key)) {
    return value;
  }

  return value.length <= 4 ? "•••" : `${value.slice(0, 4)}…(${value.length} chars)`;
}

const EXPECTED_TIMEZONE = "America/Los_Angeles";

// Every schedule (EOD liquidation, cutoffs, exposure ramp, spread ramp, seed
// windows) computes minute-of-day from the local clock and assumes Pacific.
// A mis-set box would silently shift all of them by the TZ offset. Returns the
// warning string (or null) so it's testable; the caller logs it.
export function getTimezoneWarning(
  resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  if (resolvedTimeZone === EXPECTED_TIMEZONE) {
    return null;
  }
  return `[config] TIMEZONE is ${resolvedTimeZone}, expected ${EXPECTED_TIMEZONE} — every intraday schedule assumes Pacific and will be shifted. Set TZ=${EXPECTED_TIMEZONE} and restart.`;
}

export interface StartupConfigSnapshot {
  vars: Record<string, string>;
  resolved: Record<string, unknown>;
}

// The masked env vars + resolved trading config. Shared by the boot log and the
// read-only `config:show` IPC command so both report exactly the same view.
export function getStartupConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): StartupConfigSnapshot {
  const vars: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (CONFIG_PREFIX_PATTERN.test(key) && value != null) {
      vars[key] = maskEnvValue(key, value);
    }
  }

  let resolved: Record<string, unknown> = {};
  try {
    resolved = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      maxOptionSpreadPct: getMaxOptionSpreadPct(),
      marginMaxEntrySpreadPct: getMarginMaxEntrySpreadPct(),
      minOpenInterest: getMinOpenInterest(),
      phantomQuoteGuardEnabled: isPhantomQuoteGuardEnabled(),
      intradayStopLossFloor: getIntradayStopLossFloor(),
      // Both stop-side risk switches, resolved, so "is the mid confirmation armed?"
      // is answerable from the boot log rather than by reading the server .env.
      stopLossMidConfirmEnabled: isStopLossMidConfirmEnabled(),
      stopLossMidConfirmFloor: getStopLossMidConfirmFloor(
        getIntradayStopLossFloor(),
      ),
      minIvRankPct: getMinIvRankPct(),
      marginTargetCallDelta: getMarginTargetCallDelta(),
      marginMaxBuyExposurePct: getMarginMaxBuyExposurePct(),
      cashMaxBuyExposurePct: getCashMaxBuyExposurePct(),
      marginSeedFromCash: getMarginSeedConfig(),
      cashSeedFromMargin: getCashSeedFromMarginConfig(),
      maxUnderlyingAccountPct: getMaxUnderlyingAccountPct(),
      minLiquidityCapMultiplier: getMinLiquidityCapMultiplier(),
      combinedUnderlyingCapPct: getCombinedUnderlyingCapPct(),
      seedSizingFloorPct: getSeedSizingFloorPct(),
      seedSizingCeilingPct: getSeedSizingCeilingPct(),
      marginMaxTotalUtilization: getMarginMaxTotalUtilization(),
      bidRouteMinDepthPct: getMinBidRouteDepthPct(),
      sprayBuy: getSprayBuyConfigSnapshot(),
    };
  } catch (error) {
    resolved = { error: error instanceof Error ? error.message : String(error) };
  }

  return { vars, resolved };
}

// fallow-ignore-next-line complexity
export function logStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const { vars, resolved } = getStartupConfigSnapshot(env);
  const maxSpreadPct =
    typeof resolved.maxOptionSpreadPct === "number" ? resolved.maxOptionSpreadPct : 0;
  const intradayStopFloor =
    typeof resolved.intradayStopLossFloor === "number" ? resolved.intradayStopLossFloor : 0;

  console.log(JSON.stringify({ scope: "startup-config", vars, resolved }));

  if (maxSpreadPct > 0 && intradayStopFloor > 0 && maxSpreadPct >= intradayStopFloor) {
    console.warn(
      `[config] SPREAD/STOP COUPLING: STRATEGY_MAX_OPTION_SPREAD_PCT (${(maxSpreadPct * 100).toFixed(0)}%) >= STRATEGY_INTRADAY_STOP_LOSS_PCT (${(intradayStopFloor * 100).toFixed(0)}%) — a position entered near the ask at max spread can be born within range of the stop-loss floor. Consider tightening the spread gate or widening the stop floor.`,
    );
  }

  const timezoneWarning = getTimezoneWarning();
  if (timezoneWarning) {
    console.warn(timezoneWarning);
  }

  for (const finding of findObsoleteEnvNames(env)) {
    console.warn(
      `[config] OBSOLETE env var ${finding.name} is set and IGNORED — ${finding.guidance}. The in-code default is in effect instead.`,
    );
  }

  for (const finding of findLegacyHonoredEnvNames(env)) {
    console.warn(`[config] legacy env var ${finding.name} still honored — ${finding.guidance}.`);
  }
}
