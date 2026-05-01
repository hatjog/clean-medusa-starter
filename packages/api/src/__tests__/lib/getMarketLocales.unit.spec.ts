/**
 * STORY-MIG-A T4.2 — Forward-compat shim unit tests.
 * Covers the 3 cases enumerated in the AC #8 + R3-AI-06 named-test table:
 *   - present (full block)
 *   - missing (locales absent / null)
 *   - partial (only `default`, no `supported`)
 * Plus an extra symmetric case (only `supported`, no `default`) and the
 * `fallback_chain` passthrough behaviour.
 */

import {
  getMarketLocales,
  type MarketLocaleConfig,
} from "../../lib/get-market-locales";

describe("getMarketLocales (forward-compat shim)", () => {
  const ORIGINAL_ENV = process.env.DEFAULT_LOCALE;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.DEFAULT_LOCALE;
    } else {
      process.env.DEFAULT_LOCALE = ORIGINAL_ENV;
    }
  });

  describe("case 1 — locales present and complete", () => {
    it("returns the locales block verbatim when default + supported are populated", () => {
      const market = {
        locales: {
          default: "pl",
          supported: ["pl", "en"],
        },
      };
      const result = getMarketLocales("bonbeauty", market);
      expect(result).toEqual({
        default: "pl",
        supported: ["pl", "en"],
      });
    });

    it("includes fallback_chain when present", () => {
      const market = {
        locales: {
          default: "pl",
          supported: ["pl", "en"],
          fallback_chain: ["pl", "en"],
        },
      };
      const result = getMarketLocales("bonbeauty", market);
      expect(result.fallback_chain).toEqual(["pl", "en"]);
    });
  });

  describe("case 2 — locales missing or null", () => {
    it("returns env-derived fallback when market is undefined", () => {
      process.env.DEFAULT_LOCALE = "pl";
      const result = getMarketLocales("any-market");
      expect(result).toEqual<MarketLocaleConfig>({
        default: "pl",
        supported: ["pl"],
      });
    });

    it("returns env-derived fallback when market.locales is null", () => {
      process.env.DEFAULT_LOCALE = "en";
      const result = getMarketLocales("any-market", { locales: null });
      expect(result).toEqual<MarketLocaleConfig>({
        default: "en",
        supported: ["en"],
      });
    });

    it("returns env-derived fallback when market.locales is undefined", () => {
      process.env.DEFAULT_LOCALE = "ua";
      const result = getMarketLocales("any-market", {});
      expect(result).toEqual<MarketLocaleConfig>({
        default: "ua",
        supported: ["ua"],
      });
    });

    it("falls back to 'pl' when DEFAULT_LOCALE env is unset", () => {
      delete process.env.DEFAULT_LOCALE;
      const result = getMarketLocales("any-market");
      expect(result).toEqual<MarketLocaleConfig>({
        default: "pl",
        supported: ["pl"],
      });
    });
  });

  describe("case 3 — locales partial (only default)", () => {
    it("derives supported from default when supported is missing", () => {
      const market = {
        locales: {
          default: "en",
        },
      };
      const result = getMarketLocales("mercur", market);
      expect(result).toEqual<MarketLocaleConfig>({
        default: "en",
        supported: ["en"],
      });
    });

    it("derives supported from default when supported is empty", () => {
      const market = {
        locales: {
          default: "pl",
          supported: [],
        },
      };
      const result = getMarketLocales("bonbeauty", market);
      expect(result).toEqual<MarketLocaleConfig>({
        default: "pl",
        supported: ["pl"],
      });
    });
  });

  describe("case 4 — locales partial (only supported)", () => {
    it("derives default from supported[0] when default is missing", () => {
      const market = {
        locales: {
          supported: ["en", "pl"],
        },
      };
      const result = getMarketLocales("mercur", market);
      expect(result).toEqual<MarketLocaleConfig>({
        default: "en",
        supported: ["en", "pl"],
      });
    });
  });

  describe("invariants", () => {
    it("never returns a `supported` array shorter than 1", () => {
      const result = getMarketLocales("any-market");
      expect(result.supported.length).toBeGreaterThanOrEqual(1);
    });

    it("`default` is always present in `supported` for the fallback path", () => {
      process.env.DEFAULT_LOCALE = "ua";
      const result = getMarketLocales("any-market", { locales: null });
      expect(result.supported).toContain(result.default);
    });
  });
});
