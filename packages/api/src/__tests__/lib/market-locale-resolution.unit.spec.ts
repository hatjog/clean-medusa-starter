/**
 * market-locale-resolution.unit.spec.ts — Story 2.3 (AC3).
 *
 * `resolveMarketLocale` jest KANONICZNĄ normalizacją locale wysyłki (story 2.3
 * zakazuje dodawania trzeciego lokalnego `resolveLocale`). Testy pokrywają całą
 * macierz decyzji + wymóg, żeby fallback NIGDY nie był cichy.
 */

import {
  getMarketLocales,
  resolveMarketLocale,
} from "../../lib/get-market-locales"
import { createMarketLocalesReader } from "../../lib/read-market-locales"

const MARKET_ID = "bonbeauty"
const LOCALES = { default: "pl", supported: ["pl", "en", "ua", "de"] }

function makeLogger() {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
  return {
    warnings,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) =>
        warnings.push({ message, meta }),
    },
  }
}

describe("resolveMarketLocale (AC3)", () => {
  it("locale obecne i wspierane → używane, bez ostrzeżenia", () => {
    const { logger, warnings } = makeLogger()

    const result = resolveMarketLocale({
      requested: "ua",
      marketId: MARKET_ID,
      locales: LOCALES,
      callSite: "test",
      logger,
    })

    expect(result).toEqual({
      locale: "ua",
      source: "requested",
      reason: "requested_supported",
    })
    expect(warnings).toHaveLength(0)
  })

  it("normalizuje wielkość znaków i whitespace wejścia", () => {
    expect(
      resolveMarketLocale({
        requested: "  UA  ",
        marketId: MARKET_ID,
        locales: LOCALES,
        callSite: "test",
      }).locale,
    ).toBe("ua")
  })

  it.each([null, undefined, "", "   "])(
    "brak locale (%p) → fallback locales.default Z OSTRZEŻENIEM",
    (requested) => {
      const { logger, warnings } = makeLogger()

      const result = resolveMarketLocale({
        requested: requested as string | null | undefined,
        marketId: MARKET_ID,
        locales: LOCALES,
        callSite: "voucher-purchase-delivery",
        logger,
      })

      expect(result).toEqual({
        locale: "pl",
        source: "market_default",
        reason: "missing",
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0].meta).toMatchObject({
        market_id: MARKET_ID,
        call_site: "voucher-purchase-delivery",
        reason: "missing",
      })
    },
  )

  it("locale spoza listy rynku → fallback + ostrzeżenie z powodem", () => {
    const { logger, warnings } = makeLogger()

    const result = resolveMarketLocale({
      requested: "fr",
      marketId: MARKET_ID,
      locales: { default: "pl", supported: ["pl", "en"] },
      callSite: "test",
      logger,
    })

    expect(result).toEqual({
      locale: "pl",
      source: "market_default",
      reason: "not_supported_by_market",
    })
    expect(warnings[0].meta).toMatchObject({
      requested_locale: "fr",
      reason: "not_supported_by_market",
    })
  })

  it("fallback bez loggera nie rzuca (logger jest opcjonalny)", () => {
    expect(() =>
      resolveMarketLocale({
        requested: null,
        marketId: MARKET_ID,
        locales: LOCALES,
        callSite: "test",
      }),
    ).not.toThrow()
  })

  it("zwraca kanoniczny wariant z listy rynku, nie surowe wejście wołającego", () => {
    expect(
      resolveMarketLocale({
        requested: "PL",
        marketId: MARKET_ID,
        locales: { default: "pl", supported: ["pl"] },
        callSite: "test",
      }).locale,
    ).toBe("pl")
  })

  it("współpracuje z shimem getMarketLocales (jedno źródło konfiguracji locale)", () => {
    const locales = getMarketLocales(MARKET_ID, {
      locales: { default: "en", supported: ["en", "de"] },
    })

    expect(
      resolveMarketLocale({
        requested: "de",
        marketId: MARKET_ID,
        locales,
        callSite: "test",
      }).locale,
    ).toBe("de")
    expect(
      resolveMarketLocale({
        requested: "ua",
        marketId: MARKET_ID,
        locales,
        callSite: "test",
      }).locale,
    ).toBe("en")
  })
})

describe("createMarketLocalesReader (AC3)", () => {
  it("czyta blok locales z market_runtime_config", async () => {
    const reader = createMarketLocalesReader({
      async raw() {
        return { rows: [{ locales: { default: "ua", supported: ["ua", "pl"] } }] }
      },
    })

    expect(await reader.read(MARKET_ID)).toEqual({
      default: "ua",
      supported: ["ua", "pl"],
    })
  })

  it("toleruje jsonb zwrócone jako string", async () => {
    const reader = createMarketLocalesReader({
      async raw() {
        return {
          rows: [{ locales: JSON.stringify({ default: "de", supported: ["de"] }) }],
        }
      },
    })

    expect((await reader.read(MARKET_ID)).default).toBe("de")
  })

  it("brak wiersza → shim env + OSTRZEŻENIE (degradacja nie jest cicha)", async () => {
    const { logger, warnings } = makeLogger()
    const reader = createMarketLocalesReader(
      {
        async raw() {
          return { rows: [] }
        },
      },
      logger,
    )

    const result = await reader.read(MARKET_ID)

    expect(result.supported.length).toBeGreaterThan(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].meta).toMatchObject({ market_id: MARKET_ID })
  })

  it("brak tabeli market_runtime_config → degradacja z ostrzeżeniem, NIE wyjątek", async () => {
    const { logger, warnings } = makeLogger()
    const reader = createMarketLocalesReader(
      {
        async raw() {
          throw new Error('relation "market_runtime_config" does not exist')
        },
      },
      logger,
    )

    await expect(reader.read(MARKET_ID)).resolves.toMatchObject({
      default: expect.any(String),
    })
    expect(warnings[0].message).toContain("market_runtime_config")
    // Komunikat błędu sterownika NIE jest przepisywany do loga w całości —
    // idzie tylko klasa błędu.
    expect(warnings[0].meta).toMatchObject({ error_class: "Error" })
  })
})
