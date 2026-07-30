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

/**
 * Story 5.7 (AC2/AC3) — pełny wiersz runtime config rynku.
 *
 * `support_email` i `market_url` NIE mają shimu env ani wartości domyślnej:
 * decyzja PO z 2026-07-30 mówi, że jedynym ich źródłem jest ożywiony kanał
 * gp-config → `market_runtime_config`. Dlatego ten typ dopuszcza `null`, a
 * konsument (builder payloadu) traktuje brak jako BŁĄD, nie jako degradację.
 */
export type MarketRuntimeConfigRow = {
  locales: Partial<MarketLocaleConfig> | null
  support_email: string | null
  market_url: string | null
}

export type MarketRuntimeConfigRead = {
  /** `null` = brak wiersza dla rynku albo nieudany odczyt (patrz `degraded`). */
  row: MarketRuntimeConfigRow | null
  /**
   * `true` = konfiguracja rynku NIE jest znana (błąd odczytu, np. brak tabeli).
   * Odróżnia „rynek nieskonfigurowany" od „nie wiemy, bo odczyt padł".
   */
  degraded: boolean
}

export interface MarketLocalesReader {
  read(marketId: string): Promise<MarketLocaleConfigRead>
  /**
   * Opcjonalna w interfejsie WYŁĄCZNIE ze względu na zastane atrapy testowe.
   * Konsument, któremu jej brakuje, MUSI zachować się fail-loud — brak metody
   * nie może oznaczać „konfiguracja jest w porządku" (to byłaby dokładnie ta
   * cicha degradacja, którą Story 5.7 likwiduje).
   */
  readRuntimeConfig?(marketId: string): Promise<MarketRuntimeConfigRead>
}

export function createMarketLocalesReader(
  sql: MarketLocalesSql,
  logger?: LocalesReaderLogger,
): MarketLocalesReader {
  async function readRuntimeConfig(
    marketId: string,
  ): Promise<MarketRuntimeConfigRead> {
    try {
      const query = toKnexPositionalSql(
        `SELECT locales, support_email, market_url
           FROM market_runtime_config
          WHERE market_id = $1
          LIMIT 1`,
        [marketId],
      )
      const result = await sql.raw(query.text, query.bindings)
      const rows = extractRows(result)

      if (rows.length === 0) {
        return { row: null, degraded: false }
      }

      const row = rows[0] ?? {}
      return {
        row: {
          locales: parseLocalesBlock(row.locales),
          support_email: nonEmptyString(row.support_email),
          market_url: nonEmptyString(row.market_url),
        },
        degraded: false,
      }
    } catch (error) {
      logger?.warn?.(
        "[market-locales] odczyt market_runtime_config nieudany — " +
          "konfiguracja rynku NIEZNANA (tabela może nie istnieć w tym runtime)",
        {
          market_id: marketId,
          error_class:
            error instanceof Error ? error.constructor.name : typeof error,
        },
      )
      return { row: null, degraded: true }
    }
  }

  return {
    readRuntimeConfig,
    async read(marketId: string): Promise<MarketLocaleConfigRead> {
      // Jedna implementacja odczytu runtime config (Project Structure Notes
      // 5.7: „zachowaj jedną implementację źródła runtime config") — ta metoda
      // jest wyłącznie projekcją bloku `locales`, nie drugim kanałem SQL.
      const runtime = await readRuntimeConfig(marketId)
      const locales = runtime.row?.locales ?? null

      if (!locales) {
        logger?.warn?.(
          runtime.degraded
            ? "[market-locales] odczyt market_runtime_config.locales nieudany — " +
                "degradacja do shimu env DEFAULT_LOCALE (tabela może nie istnieć w tym runtime)"
            : "[market-locales] brak bloku locales dla rynku — użyto shimu env DEFAULT_LOCALE",
          { market_id: marketId },
        )
        return { config: getMarketLocales(marketId, null), degraded: true }
      }

      return { config: getMarketLocales(marketId, { locales }), degraded: false }
    },
  }
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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
