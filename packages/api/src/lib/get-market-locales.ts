/**
 * Forward-compat shim for STORY-MIG-A `market.locales` block.
 *
 * Reads the structured `locales` block from market-runtime-config (v1.4 additive
 * minor per D-61 + D-55) and falls back to a single-locale config derived from
 * `process.env.DEFAULT_LOCALE` when absent. This keeps storefront / back-office
 * consumers tolerant of:
 *   1. Markets that have not yet been migrated (column NULL or block omitted).
 *   2. Partial blocks (e.g. only `default`, no `supported`).
 *   3. Rollback states where `down()` has dropped the column.
 *
 * Per AC #8 the shim lives in shared lib (`GP/backend/src/lib/`) — consumers MUST
 * NOT duplicate the fallback logic. Per D-55 the resolved value is constrained to
 * the locale enum `["pl","en","ua","de"]`; if env DEFAULT_LOCALE is outside that
 * set the shim still returns it (back-office can warn) — schema validator
 * `validate_market_locales.py` (WARN in v1.4.0) catches drift at fixture level.
 *
 * Refs: D-35, D-55, D-61, STORY-MIG-A AC #8.
 */

export type LocaleTag = "pl" | "en" | "ua" | "de" | string;

export interface MarketLocaleConfig {
  default: LocaleTag;
  supported: LocaleTag[];
  fallback_chain?: LocaleTag[];
}

/**
 * Subset of MarketRuntimeConfig the shim cares about. Consumers may pass the full
 * config object; only `locales` is read. Using `unknown`-typed input avoids tight
 * coupling to a specific row shape (Mikro-ORM entity vs YAML-loaded dict vs API
 * response) — the shim is meant to be the single read site.
 */
export interface MarketLocalesInput {
  locales?: Partial<MarketLocaleConfig> | null;
}

const DEFAULT_LOCALE_FALLBACK: LocaleTag = "pl";

function resolveEnvDefaultLocale(): LocaleTag {
  const fromEnv = process.env.DEFAULT_LOCALE;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_LOCALE_FALLBACK;
}

/**
 * Resolve the effective `MarketLocaleConfig` for a given market.
 *
 * @param marketId   Stable identifier of the market (used only for log/error context).
 * @param market     Optional market record; if it has a populated `locales` block
 *                   the block is returned as-is (after partial repair). If absent,
 *                   the shim returns `{ default: env.DEFAULT_LOCALE, supported: [env.DEFAULT_LOCALE] }`.
 *
 * Behaviour matrix (matches T4.2 unit test cases):
 *   1. Present + complete   → returns the block verbatim.
 *   2. Missing / null       → returns env-derived single-locale fallback.
 *   3. Partial (only default, no supported)
 *                            → fills `supported = [default]`; preserves provided default.
 *   4. Partial (only supported, no default)
 *                            → picks `default = supported[0]`.
 */
export function getMarketLocales(
  marketId: string,
  market?: MarketLocalesInput | null
): MarketLocaleConfig {
  const envDefault = resolveEnvDefaultLocale();
  const fallback: MarketLocaleConfig = {
    default: envDefault,
    supported: [envDefault],
  };

  if (!market || market.locales == null) {
    return fallback;
  }

  const locales = market.locales;
  const hasDefault = typeof locales.default === "string" && locales.default.length > 0;
  const hasSupported =
    Array.isArray(locales.supported) && locales.supported.length > 0;

  // Case 1 — fully populated.
  if (hasDefault && hasSupported) {
    const block: MarketLocaleConfig = {
      default: locales.default as LocaleTag,
      supported: locales.supported as LocaleTag[],
    };
    if (Array.isArray(locales.fallback_chain) && locales.fallback_chain.length > 0) {
      block.fallback_chain = locales.fallback_chain as LocaleTag[];
    }
    return block;
  }

  // Case 3 — only default → derive supported.
  if (hasDefault && !hasSupported) {
    const def = locales.default as LocaleTag;
    return {
      default: def,
      supported: [def],
    };
  }

  // Case 4 — only supported → derive default.
  if (!hasDefault && hasSupported) {
    const supported = locales.supported as LocaleTag[];
    return {
      default: supported[0],
      supported: [...supported],
    };
  }

  // No usable signal — fall back. Identifier reserved for future telemetry hook
  // (e.g. metric `market_locales_shim_fallback_total{market_id="..."}`).
  void marketId;
  return fallback;
}
