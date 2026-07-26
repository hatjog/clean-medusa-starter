/**
 * read-market-locales.ts — runtime'owy odczyt bloku `locales` rynku
 * (Story 2.3, AC3).
 *
 * Źródłem jest kolumna `market_runtime_config.locales` (jsonb, STORY-MIG-A /
 * D-61 + D-55). Tabela bywa NIEZMATERIALIZOWANA w części lokalnych runtime'ów
 * (patrz `migrations-legacy-base/Migration20260427120000AddLocalesToMarketRuntimeConfig.ts`),
 * dlatego odczyt jest DEFENSYWNY: każdy błąd zapytania degraduje do shimu
 * `getMarketLocales(marketId, null)` (env `DEFAULT_LOCALE`) i loguje `warn`.
 *
 * Degradacja NIE jest cicha: bez ostrzeżenia „mail w locale domyślnym" wygląda
 * jak poprawny wynik. Sam wybór locale wysyłki robi `resolveMarketLocale`
 * (`lib/get-market-locales.ts`) — tutaj wyłącznie dostarczamy konfigurację.
 */

import {
  getMarketLocales,
  type MarketLocaleConfig,
} from "./get-market-locales"

type LocalesReaderLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/** Minimalny port SQL — Knex `raw` z kontenera Medusy spełnia go bez adaptera. */
export interface MarketLocalesSql {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>
}

export interface MarketLocalesReader {
  read(marketId: string): Promise<MarketLocaleConfig>
}

export function createMarketLocalesReader(
  sql: MarketLocalesSql,
  logger?: LocalesReaderLogger,
): MarketLocalesReader {
  return {
    async read(marketId: string): Promise<MarketLocaleConfig> {
      try {
        const result = await sql.raw(
          `SELECT locales FROM market_runtime_config WHERE market_id = $1 LIMIT 1`,
          [marketId],
        )
        const rows = extractRows(result)
        const raw = rows.length > 0 ? rows[0]?.locales : null
        const locales = parseLocalesBlock(raw)

        if (!locales) {
          logger?.warn?.(
            "[market-locales] brak bloku locales dla rynku — użyto shimu env DEFAULT_LOCALE",
            { market_id: marketId },
          )
          return getMarketLocales(marketId, null)
        }

        return getMarketLocales(marketId, { locales })
      } catch (error) {
        logger?.warn?.(
          "[market-locales] odczyt market_runtime_config.locales nieudany — " +
            "degradacja do shimu env DEFAULT_LOCALE (tabela może nie istnieć w tym runtime)",
          {
            market_id: marketId,
            error_class:
              error instanceof Error ? error.constructor.name : typeof error,
          },
        )
        return getMarketLocales(marketId, null)
      }
    },
  }
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>
  }
  return []
}

function parseLocalesBlock(
  raw: unknown,
): Partial<MarketLocaleConfig> | null {
  let value: unknown = raw

  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Partial<MarketLocaleConfig>
}
