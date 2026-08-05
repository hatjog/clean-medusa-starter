/**
 * system-market-context — jawny kontekst rynku dla wykonania POZA żądaniem HTTP
 * (v1.15.0 Story 2.1, AC1; FR-14d, AD-21).
 *
 * ── Sprzeczność, którą ten moduł likwiduje ──────────────────────────────────
 * Kontekst rynku i hook RLS ustawia dziś WYŁĄCZNIE łańcuch `/store/*`
 * (`api/middlewares.ts` → `marketContextStorage.run(...)` → `rls-pool-hook.ts`).
 * Subscriber, workflow albo job nie ma requestu, więc nie ma czym zadeklarować
 * rynku — i staje przed wyborem między WŁASNĄ PULĄ POŁĄCZEŃ (omijającą RLS,
 * patrz `modules/voucher/service.ts`) a BRAKIEM IZOLACJI. Na tej sprzeczności
 * stoi cała asynchroniczna połowa pętli wartości.
 *
 * ── Kontrakt nośnika (AD-21) ────────────────────────────────────────────────
 *   1. Lista rynków jest WYLICZONA i JAWNIE PODANA przez wywołującego.
 *   2. Lista nigdy nie jest pusta i nigdy dorozumiana. „Wszystkie rynki
 *      z konfiguracji" JEST dorozumianiem: nowy rynek rozszerzałby wtedy
 *      uprawnienia wstecz, bez żadnej decyzji.
 *   3. Kontekst bez zadeklarowanego rynku jest ODMOWĄ, nie dostępem do
 *      wszystkiego. Odmowa jest GŁOŚNA: kod błędu + log + metryka (NFR-2).
 *      `catch → return null` nie spełnia kontraktu.
 *   4. Nośnik jest JEDEN: ta sama `marketContextStorage`, ten sam hook RLS,
 *      ten sam kształt zmiennych sesji co `/store/*`. Żadnej drugiej puli
 *      połączeń i żadnego drugiego kształtu kontekstu — dwie prawdy o tym,
 *      jaki rynek obowiązuje, są defektem.
 *
 * ── Dlaczego wykonanie JEST rozwijane per rynek ─────────────────────────────
 * Zmienna sesji RLS (`app.gp_market_id`) niesie DOKŁADNIE JEDEN rynek — tak
 * działa hook i tak wyglądają polityki. Nośnik przyjmuje więc wyliczoną listę
 * i uruchamia pracę RAZ NA KAŻDY zadeklarowany rynek, każdorazowo w kontekście
 * o tym samym kształcie co request `/store/*`. Alternatywa — jeden przebieg
 * „dla wielu rynków naraz" — wymagałaby rozluźnienia RLS do listy, czyli
 * osłabienia dokładnie tego, co ta story wzmacnia.
 *
 * ── Reguła dla generatorów wielorynkowych (wiąże Story 2.2) ─────────────────
 * Artefakt obejmujący wiele rynków (sitemapa, feed, eksport) DEKLARUJE zbiór
 * rynków przy BUDOWANIU i stosuje wykluczenia przy SERWOWANIU. Budowanie
 * z wykluczeniami wpisanymi w generator daje artefakt, o którego zakresie nie
 * da się orzec po fakcie, a awaria backendu zamienia się w sygnał deindeksacji.
 *
 * @module lib/system-market-context
 */

import { marketContextStorage, type MarketContext } from "./market-context"

/** Powierzchnie wykonania poza żądaniem HTTP — dokładnie te trzy z AC1. */
export type SystemExecutionSurface = "subscriber" | "workflow" | "job"

export type SystemExecutionOrigin = {
  surface: SystemExecutionSurface
  /** Nazwa handlera/joba — trafia do logu odmowy i do metryki. */
  name: string
}

/**
 * Nazwa metryki odmowy. Zapisana W KODZIE, nie tylko w prozie: metryka bez
 * nazwy jest metryką, której nikt nie odpyta, czyli brakiem pomiaru (NFR-2).
 */
export const SYSTEM_MARKET_CONTEXT_DENIED_METRIC =
  "gp_system_market_context_denied_total"

/** Powód odmowy — wymiar metryki i kod błędu naraz. */
export type SystemMarketContextDenialReason =
  /** Wywołanie bez zadeklarowanej listy rynków. */
  | "markets_not_declared"
  /** Lista podana, ale pusta — „nic" nie jest deklaracją zakresu. */
  | "markets_empty"
  /** Identyfikator rynku niezgodny z kształtem akceptowanym przez hook RLS. */
  | "market_id_invalid"
  /** Operacja wymagająca kontekstu wykonana poza jakimkolwiek kontekstem. */
  | "context_missing"

export class SystemMarketContextError extends Error {
  readonly error_code = "GP_SYSTEM_MARKET_CONTEXT_DENIED"
  readonly reason: SystemMarketContextDenialReason
  readonly origin: SystemExecutionOrigin | null

  constructor(
    reason: SystemMarketContextDenialReason,
    message: string,
    origin: SystemExecutionOrigin | null = null,
  ) {
    super(message)
    this.name = "SystemMarketContextError"
    this.reason = reason
    this.origin = origin
  }
}

/**
 * Ten sam kształt identyfikatora, którego pilnuje `rls-pool-hook.ts`.
 * Rozjazd tych dwóch wyrażeń oznaczałby, że nośnik przepuszcza wartość,
 * którą hook po cichu ZIGNORUJE — czyli wykonanie bez izolacji mimo
 * „zadeklarowanego" rynku.
 */
const SAFE_MARKET_ID_RE = /^[a-zA-Z0-9_-]+$/

type LoggerLike = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
  error?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Licznik odmów, per powód i per powierzchnia. Proces-lokalny i in-memory —
 * dokładnie tak jak `alert-emit.ts` trzyma ring buffer. Jest ODPYTYWALNY
 * (`getSystemMarketContextDenials`), więc test może asertować NA METRYCE,
 * a nie na treści linii logu.
 */
const denialCounters = new Map<string, number>()

function counterKey(reason: string, surface: string): string {
  return `${reason}|${surface}`
}

export function getSystemMarketContextDenials(filter?: {
  reason?: SystemMarketContextDenialReason
  surface?: SystemExecutionSurface | "unknown"
}): number {
  let total = 0
  for (const [key, value] of denialCounters) {
    const [reason, surface] = key.split("|")
    if (filter?.reason && filter.reason !== reason) continue
    if (filter?.surface && filter.surface !== surface) continue
    total += value
  }
  return total
}

/** Snapshot metryki — do eksportu i do asercji w testach. */
export function getSystemMarketContextMetrics(): Array<{
  metric: string
  reason: string
  surface: string
  value: number
}> {
  return [...denialCounters.entries()].map(([key, value]) => {
    const [reason, surface] = key.split("|")
    return {
      metric: SYSTEM_MARKET_CONTEXT_DENIED_METRIC,
      reason,
      surface,
      value,
    }
  })
}

/** Reset licznika — wyłącznie dla testów. */
export function _resetSystemMarketContextMetrics(): void {
  denialCounters.clear()
}

function deny(
  reason: SystemMarketContextDenialReason,
  message: string,
  origin: SystemExecutionOrigin | null,
  logger?: LoggerLike,
): never {
  const surface = origin?.surface ?? "unknown"
  const key = counterKey(reason, surface)
  denialCounters.set(key, (denialCounters.get(key) ?? 0) + 1)

  // Odmowa jest GŁOŚNA na trzech poziomach naraz: metryka (wyżej),
  // log (tutaj) i wyjątek (niżej). Usunięcie któregokolwiek z nich
  // zamienia fail-closed w cichą degradację.
  logger?.error?.("system market context denied", {
    metric: SYSTEM_MARKET_CONTEXT_DENIED_METRIC,
    error_code: "GP_SYSTEM_MARKET_CONTEXT_DENIED",
    reason,
    surface,
    origin: origin?.name ?? null,
  })

  throw new SystemMarketContextError(reason, message, origin)
}

export type SystemMarketScope = {
  /** Wyliczona, niepusta lista rynków, których wolno dotknąć temu wykonaniu. */
  markets: readonly string[]
  origin: SystemExecutionOrigin
  /**
   * Opcjonalny sales channel per rynek. Kształt kontekstu jest ten sam co
   * dla `/store/*`; asynchroniczne wykonanie zwykle go nie potrzebuje,
   * a `undefined` jest tu UCZCIWSZE niż podstawiony pusty string.
   */
  salesChannelIdByMarket?: Readonly<Record<string, string>>
  logger?: LoggerLike
}

/**
 * Uruchom pracę w jawnym kontekście systemowym — raz na każdy zadeklarowany
 * rynek. Zwraca wyniki w kolejności deklaracji.
 *
 * Rzuca `SystemMarketContextError` (i inkrementuje metrykę) gdy lista rynków
 * jest nieobecna, pusta albo zawiera identyfikator, którego hook RLS by nie
 * przyjął. NIGDY nie uruchamia pracy bez kontekstu.
 */
export async function runInSystemMarketContext<T>(
  scope: SystemMarketScope,
  work: (marketId: string) => Promise<T>,
): Promise<T[]> {
  const origin = scope?.origin ?? null
  const logger = scope?.logger

  if (!scope || !Array.isArray(scope.markets)) {
    deny(
      "markets_not_declared",
      "wykonanie poza żądaniem HTTP musi jawnie zadeklarować listę rynków " +
        "(AD-21); brak listy nie oznacza „wszystkie rynki”",
      origin,
      logger,
    )
  }

  if (scope.markets.length === 0) {
    deny(
      "markets_empty",
      "pusta lista rynków nie jest deklaracją zakresu — jest odmową (AD-21)",
      origin,
      logger,
    )
  }

  for (const marketId of scope.markets) {
    if (typeof marketId !== "string" || !SAFE_MARKET_ID_RE.test(marketId)) {
      deny(
        "market_id_invalid",
        `identyfikator rynku '${String(marketId)}' nie ma kształtu, który ` +
          "przyjmuje hook RLS — kontekst zostałby po cichu zignorowany",
        origin,
        logger,
      )
    }
  }

  const results: T[] = []
  for (const marketId of scope.markets) {
    const context: MarketContext = {
      market_id: marketId,
      sales_channel_id: scope.salesChannelIdByMarket?.[marketId],
      system: origin ?? undefined,
    }
    // Ten sam nośnik co `/store/*`: ta sama ALS, ten sam hook, ta sama pula.
    results.push(
      await marketContextStorage.run(context, () => work(marketId)),
    )
  }
  return results
}

/**
 * Zwróć rynek obowiązujący dla bieżącego wykonania albo ODMÓW.
 *
 * To jest strażnik dla ścieżek zapisu poza żądaniem HTTP: wywołanie bez
 * kontekstu kończy się błędem, nie zapisem poza izolacją.
 */
export function requireMarketContext(
  operation: string,
  options?: { origin?: SystemExecutionOrigin; logger?: LoggerLike },
): MarketContext {
  const context = marketContextStorage.getStore()
  if (!context?.market_id) {
    deny(
      "context_missing",
      `operacja '${operation}' wymaga zadeklarowanego rynku — kontekst bez ` +
        "rynku jest odmową, nie dostępem do wszystkiego (AD-21)",
      options?.origin ?? null,
      options?.logger,
    )
  }
  return context
}

/** Czy bieżące wykonanie działa w kontekście systemowym (nie w requeście). */
export function currentSystemOrigin(): SystemExecutionOrigin | null {
  return marketContextStorage.getStore()?.system ?? null
}
