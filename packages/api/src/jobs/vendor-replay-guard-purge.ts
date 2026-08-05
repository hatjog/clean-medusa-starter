/**
 * vendor-replay-guard-purge — NOŚNIK zobowiązania retencyjnego dla tabeli
 * `vendor_replay_guard` (v1.15.0 Story 5.3, ADR-185 D4) — wykonywany
 * w JAWNIE ZADEKLAROWANYM kontekście rynku (AD-21, ADR-177).
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
 * ── Dlaczego ten job DEKLARUJE RYNKI (AD-21) ───────────────────────────────
 * To jest zapis (`DELETE`) poza żądaniem HTTP, więc nie ma requestu, z którego
 * wziąłby się kontekst rynku — a hook RLS przy braku kontekstu oddaje
 * połączenie NIETKNIĘTE, czyli jako rolę aplikacyjną, dla której RLS nie
 * obowiązuje. „Sprzątaj wszystko" byłoby więc zapisem bez izolacji i bez śladu.
 * Lista rynków jest WYLICZONA I JAWNA (`VENDOR_REPLAY_GUARD_PURGE_MARKETS`),
 * a praca biegnie RAZ NA KAŻDY zadeklarowany rynek — konwencja z
 * `jobs/voucher-pii-retention-sweep.ts` (`VOUCHER_PII_RETENTION_MARKETS`).
 *
 * Brak deklaracji jest ODMOWĄ, nie dostępem do wszystkiego: nośnik rzuca
 * `SystemMarketContextError`, podnosi metrykę
 * `gp_system_market_context_denied_total` i loguje — a job NIE kasuje niczego.
 * Świadomie NIE ma tu żadnej wartości domyślnej ani listy „wszystkie rynki
 * z konfiguracji": nowy rynek rozszerzałby wtedy zakres sprzątacza wstecz, bez
 * żadnej decyzji (AD-21, kontrakt nośnika pkt 2).
 *
 * ── To jest HIGIENA, nie poprawność ────────────────────────────────────────
 * Zatrzymanie tego joba NIE zmienia werdyktu bariery (okno siedzi w predykacie
 * `claimReplayGuardKey`). Dlatego job nigdy nie rzuca: brak `PG_CONNECTION`,
 * odmowa kontekstu albo błąd `DELETE` jest logowany GŁOŚNO i kończy przebieg,
 * zamiast wywracać schedulera. Odwrotna decyzja (fail-loud aż do 503)
 * obowiązuje w samej barierze — tam awaria zmienia werdykt.
 *
 * Cisza jest tu wykluczona osobno: odmowa kontekstu ma metrykę i `logger.error`
 * z kodem `GP_SYSTEM_MARKET_CONTEXT_DENIED`, więc „job chodzi, ale nic nie
 * sprząta" jest ODPYTYWALNE, a nie ciche (NFR-2).
 */
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  runInSystemMarketContext,
  SystemMarketContextError,
  type SystemExecutionOrigin,
  type SystemMarketScope,
} from "../lib/system-market-context"
import {
  purgeExpiredReplayGuardRows,
  type ReplayGuardDb,
} from "../lib/vendor-replay-guard"

export const SCHEDULE_NAME = "vendor-replay-guard-purge" as const
/** Co 15 minut: okno wpisu to 660 s, więc zaległość nigdy nie przekracza ~2 okien. */
export const SCHEDULE_CRON = "*/15 * * * *" as const

/** Jawna deklaracja rynków, których wolno dotknąć sprzątaczowi (CSV). */
export const MARKETS_ENV_VAR = "VENDOR_REPLAY_GUARD_PURGE_MARKETS" as const

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

/**
 * Czyta ZADEKLAROWANĄ listę rynków.
 *
 * `undefined` (zmienna nieustawiona) jest ODRÓŻNIONE od pustej listy
 * (ustawiona, ale nic nie deklaruje) — bo nośnik rozróżnia te dwie odmowy
 * (`markets_not_declared` vs `markets_empty`), a operator patrzący na metrykę
 * musi wiedzieć, czy zapomniał zmiennej, czy wpisał do niej śmieci.
 */
export function readDeclaredMarkets(
  env: NodeJS.ProcessEnv = process.env
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

export default async function vendorReplayGuardPurge(
  container: MedusaContainer
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
    // Druga kopia kontroli to druga prawda o tym, kiedy zapis jest dozwolony.
    markets: declared as unknown as readonly string[],
    origin: PURGE_ORIGIN,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) =>
        logger.warn(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (message: string, meta?: Record<string, unknown>) =>
        logger.error(`${message} ${JSON.stringify(meta ?? {})}`),
    },
  } satisfies SystemMarketScope

  const nowSec = Math.floor(Date.now() / 1000)

  try {
    const deletedPerMarket = await runInSystemMarketContext(scope, async (marketId) => {
      const deleted = await purgeExpiredReplayGuardRows(db, nowSec, {
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
          0
        )}`
    )
  } catch (err) {
    if (err instanceof SystemMarketContextError) {
      // Odmowa nośnika: metryka i log wewnątrz nośnika już się podniosły. Tu
      // zostaje druga, jawna linia — żeby „job chodzi i nic nie sprząta" dało
      // się przeczytać w logu joba, a nie tylko wywnioskować z metryki.
      logger.error(
        `purge DENIED (${err.reason}): brak zadeklarowanego rynku — ustaw ` +
          `${MARKETS_ENV_VAR} (CSV). Nic nie zostało skasowane; ` +
          "werdykt bariery bez zmian",
        err
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
