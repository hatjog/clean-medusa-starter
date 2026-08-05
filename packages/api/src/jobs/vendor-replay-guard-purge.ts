/**
 * vendor-replay-guard-purge — NOŚNIK zobowiązania retencyjnego dla tabeli
 * `vendor_replay_guard` (v1.15.0 Story 5.3, ADR-185 D4).
 *
 * ── Dlaczego to musi być job, a nie zdanie w ADR ───────────────────────────
 * Bariera anty-replay wstawia wiersz na KAŻDE uwierzytelnione żądanie
 * `/vendor/*`. Wpis żyje `2 × drift + 60` s (domyślnie 660 s), ale wygasanie
 * realizuje PREDYKAT stwierdzenia — nic wygasłego wiersza nie kasuje. Bez
 * odpalanego sprzątacza tabela w gorącej ścieżce uwierzytelnienia rośnie o
 * `86400 × R` wierszy dziennie i nigdy nie maleje, a PK na `TEXT(64)` puchnie
 * razem z nią. „Właściciel: Platform Ops" w komentarzu nie jest mechanizmem —
 * ten plik nim jest.
 *
 * ── To jest HIGIENA, nie poprawność ────────────────────────────────────────
 * Zatrzymanie tego joba NIE zmienia werdyktu bariery (okno siedzi w predykacie
 * `claimReplayGuardKey`). Dlatego job nigdy nie rzuca: brak `PG_CONNECTION` albo
 * błąd `DELETE` jest logowany i kończy przebieg, zamiast wywracać schedulera.
 * Odwrotna decyzja (fail-loud) obowiązuje w samej barierze — tam awaria oznacza
 * 503, bo tam awaria zmienia werdykt.
 */
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  purgeExpiredReplayGuardRows,
  type ReplayGuardDb,
} from "../lib/vendor-replay-guard"

export const SCHEDULE_NAME = "vendor-replay-guard-purge" as const
/** Co 15 minut: okno wpisu to 660 s, więc zaległość nigdy nie przekracza ~2 okien. */
export const SCHEDULE_CRON = "*/15 * * * *" as const

type JobLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, err?: unknown) => void
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (message) => console.log(`[${SCHEDULE_NAME}] ${message}`),
    warn: (message) => console.warn(`[${SCHEDULE_NAME}] ${message}`),
    error: (message, err) => console.error(`[${SCHEDULE_NAME}] ${message}`, err),
  }

  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved?.info) {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch {
    return fallback
  }

  return fallback
}

function resolveDb(container: MedusaContainer | undefined): ReplayGuardDb | null {
  try {
    const db = container?.resolve?.(ContainerRegistrationKeys.PG_CONNECTION) as
      | ReplayGuardDb
      | null
    return typeof db?.raw === "function" ? db : null
  } catch {
    return null
  }
}

export default async function vendorReplayGuardPurge(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container)
  const db = resolveDb(container)

  if (!db) {
    logger.warn("pg connection unavailable; skipping purge (barrier verdict unaffected)")
    return
  }

  try {
    const deleted = await purgeExpiredReplayGuardRows(db, Math.floor(Date.now() / 1000))
    logger.info(`deleted_expired_rows=${deleted ?? "unknown"}`)
  } catch (err) {
    // Higiena, nie poprawność — nie wywracamy schedulera.
    logger.error("purge failed; expired rows stay until the next run", err)
  }
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
