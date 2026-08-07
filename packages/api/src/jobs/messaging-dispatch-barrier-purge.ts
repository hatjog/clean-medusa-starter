/**
 * messaging-dispatch-barrier-purge — NOŚNIK zobowiązania retencyjnego dla tabeli
 * `messaging_dispatch_barrier` (v1.15.0 Story 4.1, ADR-196 §D11) — wykonywany
 * w JAWNIE ZADEKLAROWANYM kontekście rynku (AD-21, ADR-177).
 *
 * ── Dlaczego to musi być job, a nie zdanie w ADR ───────────────────────────
 * Bariera wstawia wiersz na KAŻDĄ wysyłkę. Wygasanie realizuje PREDYKAT
 * stwierdzenia `claim` — nic wygasłego wiersza nie kasuje. Bez odpalanego
 * sprzątacza tabela rośnie liniowo z liczbą wysyłek i nigdy nie maleje.
 * „Właściciel: Platform Ops" w komentarzu nie jest mechanizmem — ten plik nim jest.
 *
 * ── To jest HIGIENA, nie poprawność ────────────────────────────────────────
 * Zatrzymanie tego joba NIE zmienia werdyktu bariery. Dlatego job nigdy nie
 * rzuca: brak `PG_CONNECTION`, odmowa kontekstu albo błąd `DELETE` jest logowany
 * GŁOŚNO i kończy przebieg, zamiast wywracać schedulera.
 *
 * ── Czego ten job NIE kasuje ───────────────────────────────────────────────
 * Wierszy BEZTERMINOWYCH (`expires_at IS NULL`) — to są dostawy, które POSZŁY.
 * Ich skasowanie zamieniłoby „mail już poszedł" w „mail nigdy nie poszedł",
 * czyli produkowałoby duplikat. Ta granica siedzi w `WHERE` funkcji
 * `purgeExpiredDispatchBarrierRows`, a nie w tym pliku, żeby nie było dwóch
 * definicji tego, co wolno skasować.
 *
 * ── Dlaczego ten job DEKLARUJE RYNKI (AD-21) ───────────────────────────────
 * To NOWA powierzchnia zapisu poza HTTP, więc nie ma requestu, z którego
 * wziąłby się kontekst rynku. Lista rynków jest WYLICZONA I JAWNA
 * (`MESSAGING_DISPATCH_BARRIER_PURGE_MARKETS`), a praca biegnie raz na każdy
 * zadeklarowany rynek. Brak deklaracji jest ODMOWĄ, nie dostępem do wszystkiego.
 *
 * Ten job jest NOWY, więc świadomie NIE jest wpisywany do inwentarza powierzchni
 * zastanych w `_grow/tools/validate_system_market_context_adoption.py` — wpis
 * tam byłby cichym długiem, a nie zgodnością.
 */
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  purgeExpiredDispatchBarrierRows,
  type DispatchBarrierDb,
} from "../lib/messaging-dispatch-barrier"
import {
  runInSystemMarketContext,
  SystemMarketContextError,
  type SystemExecutionOrigin,
  type SystemMarketScope,
} from "../lib/system-market-context"

export const SCHEDULE_NAME = "messaging-dispatch-barrier-purge" as const
/**
 * Raz na dobę. Okno wpisu niejednoznacznego to 8 dni, a wpisu `in_flight`
 * 15 minut, więc częstszy przebieg nie zmniejsza szczytu tabeli w sposób,
 * który uzasadniałby dodatkowe obciążenie.
 */
export const SCHEDULE_CRON = "17 3 * * *" as const

/** Jawna deklaracja rynków, których wolno dotknąć sprzątaczowi (CSV). */
export const MARKETS_ENV_VAR = "MESSAGING_DISPATCH_BARRIER_PURGE_MARKETS" as const

export const PURGE_ORIGIN: SystemExecutionOrigin = {
  surface: "job",
  name: SCHEDULE_NAME,
}

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

function resolveDb(container: MedusaContainer | undefined): DispatchBarrierDb | null {
  try {
    const db = container?.resolve?.(ContainerRegistrationKeys.PG_CONNECTION) as
      | DispatchBarrierDb
      | null
    return typeof db?.raw === "function" ? db : null
  } catch {
    return null
  }
}

/**
 * Czyta ZADEKLAROWANĄ listę rynków. `undefined` (zmienna nieustawiona) jest
 * ODRÓŻNIONE od pustej listy — nośnik rozróżnia te dwie odmowy, a operator
 * patrzący na metrykę musi wiedzieć, czy zapomniał zmiennej, czy wpisał śmieci.
 */
export function readDeclaredMarkets(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = env[MARKETS_ENV_VAR]
  if (raw === undefined) {
    return undefined
  }
  return raw
    .split(",")
    .map((market) => market.trim())
    .filter((market) => market.length > 0)
}

export default async function messagingDispatchBarrierPurge(
  container: MedusaContainer,
): Promise<void> {
  const logger = resolveLogger(container)
  const db = resolveDb(container)

  if (!db) {
    logger.warn("pg connection unavailable; skipping purge (barrier verdict unaffected)")
    return
  }

  const declared = readDeclaredMarkets()
  const scope = {
    // `undefined` jedzie do nośnika CELOWO: odmowę ma wystawić nośnik (z jej
    // kodem, logiem i metryką), a nie własna kopia kontroli w tym pliku.
    markets: declared as unknown as readonly string[],
    origin: PURGE_ORIGIN,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) =>
        logger.warn(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (message: string, meta?: Record<string, unknown>) =>
        logger.error(`${message} ${JSON.stringify(meta ?? {})}`),
    },
  } satisfies SystemMarketScope

  const now = new Date()

  try {
    const deletedPerMarket = await runInSystemMarketContext(scope, async (marketId) => {
      const deleted = await purgeExpiredDispatchBarrierRows(db, now, {
        origin: PURGE_ORIGIN,
        logger: scope.logger,
      })
      logger.info(`market=${marketId} deleted_expired_rows=${deleted ?? "unknown"}`)
      return deleted
    })

    logger.info(
      `markets=${(declared ?? []).join(",")} ` +
        `deleted_expired_rows=${deletedPerMarket.reduce<number>(
          (sum, deleted) => sum + (deleted ?? 0),
          0,
        )}`,
    )
  } catch (err) {
    if (err instanceof SystemMarketContextError) {
      logger.error(
        `purge DENIED (${err.reason}): brak zadeklarowanego rynku — ustaw ` +
          `${MARKETS_ENV_VAR} (CSV). Nic nie zostało skasowane; ` +
          "werdykt bariery bez zmian",
        err,
      )
      return
    }
    // Higiena, nie poprawność — nie wywracamy schedulera.
    logger.error("purge failed; expired rows stay until the next run", err)
  }
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
