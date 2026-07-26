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
 * ── Degradacja jest RAPORTOWANA, nie tylko logowana ─────────────────────────
 * Sam `warn` nie wystarczał: konsument (subscriber wysyłki) dostawał wtedy
 * shim `{ default: 'pl', supported: ['pl'] }` NIEODRÓŻNIALNY od realnej
 * konfiguracji rynku jednojęzycznego i „normalizował" `purchase_locale = 'ua'`
 * do `pl`, czyli wysyłał maila w złym języku — dokładnie to, co rozstrzygnięcie
 * AC4 („FAIL-LOUD, bez downgrade'u") odrzuca. Dlatego `read()` zwraca
 * `MarketLocaleConfigRead` z flagą `degraded`, a decyzję „czy wolno wysłać"
 * podejmuje wołający (subscriber: locale nierozstrzygalne → `failed`
 * z `VOUCHER_DELIVERY_MARKET_LOCALES_UNAVAILABLE`).
 *
 * Sam wybór locale wysyłki robi `resolveMarketLocale`
 * (`lib/get-market-locales.ts`) — tutaj wyłącznie dostarczamy konfigurację.
 *
 * ── Dialekt bindingów ───────────────────────────────────────────────────────
 * `PG_CONNECTION` to instancja Knexa (składnia `?`), nie klient `pg` (`$N`) —
 * zapytanie jest konwertowane przez `toKnexPositionalSql`. Bez tego KAŻDY
 * odczyt kończył się wyjątkiem formattera i „cichą" degradacją do shimu.
 */

import {
  getMarketLocales,
  type MarketLocaleConfig,
} from "./get-market-locales"
import { toKnexPositionalSql } from "./knex-positional-sql"

type LocalesReaderLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/** Minimalny port SQL — Knex `raw` z kontenera Medusy (składnia `?`). */
export interface MarketLocalesSql {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>
}

export type MarketLocaleConfigRead = {
  config: MarketLocaleConfig
  /**
   * `true` = konfiguracja rynku NIE jest znana (błąd odczytu albo brak bloku
   * `locales`), a `config` to shim env. `false` = wartości pochodzą z rynku.
   */
  degraded: boolean
}

export interface MarketLocalesReader {
  read(marketId: string): Promise<MarketLocaleConfigRead>
}

export function createMarketLocalesReader(
  sql: MarketLocalesSql,
  logger?: LocalesReaderLogger,
): MarketLocalesReader {
  return {
    async read(marketId: string): Promise<MarketLocaleConfigRead> {
      try {
        const query = toKnexPositionalSql(
          `SELECT locales FROM market_runtime_config WHERE market_id = $1 LIMIT 1`,
          [marketId],
        )
        const result = await sql.raw(query.text, query.bindings)
        const rows = extractRows(result)
        const raw = rows.length > 0 ? rows[0]?.locales : null
        const locales = parseLocalesBlock(raw)

        if (!locales) {
          logger?.warn?.(
            "[market-locales] brak bloku locales dla rynku — użyto shimu env DEFAULT_LOCALE",
            { market_id: marketId },
          )
          return { config: getMarketLocales(marketId, null), degraded: true }
        }

        return { config: getMarketLocales(marketId, { locales }), degraded: false }
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
        return { config: getMarketLocales(marketId, null), degraded: true }
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
