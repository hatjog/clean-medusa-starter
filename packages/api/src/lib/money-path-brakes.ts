/**
 * money-path-brakes — JEDEN helper odczytu hamulca ścieżki pieniądza
 * (v1.15.0 Story 2.1, AC4; NFR-8, AD-25, ADR-177).
 *
 * ── Dlaczego jeden helper, a nie pięć flag ──────────────────────────────────
 * Pięć wymagań tego wydania (FR-6/7, FR-9, FR-10, FR-12, FR-14) zmienia
 * zachowanie ścieżki pieniądza. Najtańszą drogą dla story pod presją jest
 * dopisanie własnego `process.env.FEATURE_X_ENABLED`. Powstaje wtedy pięć
 * niezależnych nośników, z których żaden nie jest per rynek, żaden nie jest
 * w warstwie RUNTIME i żaden nie zostawia śladu przy przestawieniu — czyli
 * pięć różnych prawd o tym, co jest włączone. Bramka
 * `_grow/tools/validate_money_path_brake_carrier.py` odrzuca taki kod.
 *
 * ── Skąd bierze się wartość ─────────────────────────────────────────────────
 *   gp-ops/markets/** (SOURCE)   ← jedyne miejsce edycji
 *     → gp-ops config load --apply
 *   GP/config/** (RUNTIME)       ← jedyna warstwa, którą czyta runtime
 *     → pnpm gp-config-sync-market-runtime <instance> <market> --apply
 *   market_runtime_config.money_path_brakes (jsonb)
 *     → TEN helper
 *
 * ── Fail-closed, nie „ciche false” ──────────────────────────────────────────
 * Brak wiersza, brak kolumny, brak klucza, niepoprawna wartość albo błąd
 * odczytu dają `engaged` — wartość BEZPIECZNĄ ustaloną w ADR-177, czyli
 * zachowanie sprzed zmiany. To NIE jest to samo co `undefined → false`:
 * wartość domyślna jest tu decyzją zapisaną w ADR, a każde jej użycie
 * zostawia `warn` z powodem, więc „hamulec nie działa, bo nikt nie
 * zsynchronizował konfiguracji" nie może przejść niezauważone.
 *
 * @module lib/money-path-brakes
 */

import { toKnexPositionalSql } from "./knex-positional-sql"

/** Pięć nazwanych przełączników — zamrożone w ADR-177, nie przemianowywać. */
export const MONEY_PATH_BRAKE_SWITCHES = [
  "fr_6_7_multi_seller_purchase_return",
  "fr_9_delivery_idempotency",
  "fr_10_panel_redemption",
  "fr_12_redemption_ledger",
  "fr_14_market_isolation",
] as const

export type MoneyPathBrakeSwitch = (typeof MONEY_PATH_BRAKE_SWITCHES)[number]

export const MONEY_PATH_BRAKE_STATES = ["engaged", "released"] as const
export type MoneyPathBrakeState = (typeof MONEY_PATH_BRAKE_STATES)[number]

/** Wartość bezpieczna (fail-closed) — zachowanie sprzed zmiany wydania. */
export const MONEY_PATH_BRAKE_SAFE_STATE: MoneyPathBrakeState = "engaged"

type BrakeLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/** Minimalny port SQL — Knex `raw` z kontenera Medusy (składnia `?`). */
export interface MoneyPathBrakesSql {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>
}

export type MoneyPathBrakeRead = {
  state: MoneyPathBrakeState
  /** `true` = wartość NIE pochodzi z konfiguracji rynku, tylko z domyślnej. */
  degraded: boolean
  reason: string | null
}

function extractRows<T>(result: unknown): T[] {
  const record = result as { rows?: unknown }
  if (Array.isArray(record?.rows)) return record.rows as T[]
  if (Array.isArray(result)) return result as T[]
  return []
}

function parseBlock(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return null
}

export interface MoneyPathBrakeReader {
  /** Pełny odczyt z informacją o degradacji — dla diagnostyki i testów. */
  read(marketId: string, brake: MoneyPathBrakeSwitch): Promise<MoneyPathBrakeRead>
  /**
   * Jedyna forma, której powinien używać kod produkcyjny:
   * „czy wolno wykonać nowe zachowanie dla tego rynku".
   */
  isReleased(marketId: string, brake: MoneyPathBrakeSwitch): Promise<boolean>
}

export function createMoneyPathBrakeReader(
  sql: MoneyPathBrakesSql,
  logger?: BrakeLogger,
): MoneyPathBrakeReader {
  async function read(
    marketId: string,
    brake: MoneyPathBrakeSwitch,
  ): Promise<MoneyPathBrakeRead> {
    const safe = (reason: string): MoneyPathBrakeRead => {
      logger?.warn?.("money path brake fell back to safe state", {
        market_id: marketId,
        brake,
        state: MONEY_PATH_BRAKE_SAFE_STATE,
        reason,
      })
      return { state: MONEY_PATH_BRAKE_SAFE_STATE, degraded: true, reason }
    }

    if (!marketId) {
      return safe("brak market_id")
    }

    let rows: Array<{ money_path_brakes: unknown }>
    try {
      const query = toKnexPositionalSql(
        `SELECT money_path_brakes
           FROM market_runtime_config
          WHERE market_id = $1
          LIMIT 1`,
        [marketId],
      )
      const result = await sql.raw(query.text, query.bindings)
      rows = extractRows(result)
    } catch (error) {
      return safe(
        `odczyt market_runtime_config nieudany: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    if (rows.length === 0) {
      return safe("brak wiersza market_runtime_config dla rynku")
    }

    const block = parseBlock(rows[0]?.money_path_brakes)
    if (!block) {
      return safe("brak bloku money_path_brakes w konfiguracji rynku")
    }

    const value = block[brake]
    if (
      typeof value !== "string" ||
      !(MONEY_PATH_BRAKE_STATES as readonly string[]).includes(value)
    ) {
      return safe(`przełącznik '${brake}' nieustawiony albo niepoprawny`)
    }

    return { state: value as MoneyPathBrakeState, degraded: false, reason: null }
  }

  return {
    read,
    async isReleased(marketId, brake) {
      return (await read(marketId, brake)).state === "released"
    },
  }
}
