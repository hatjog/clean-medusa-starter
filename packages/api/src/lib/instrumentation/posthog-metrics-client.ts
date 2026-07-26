/**
 * posthog-metrics-client.ts — JEDEN nośnik metryk PostHoga dla jobów backendu
 * (Story 2.5, R-2.5-H2).
 *
 * ── Po co ten plik istnieje ─────────────────────────────────────────────────
 * Joby tego repo (`entitlement-expiry-sweeper`, `alert-evaluator-cron`,
 * `voucher-delivery-reconciliation-sweep`) czytają klienta PostHoga z kontenera
 * pod kluczem `"posthog"` — a tego klucza NIKT nie rejestrował. Efekt: każdy
 * `posthog?.capture(...)` był no-opem, więc metryka „obserwowalna bez czytania
 * logów" (AC3) nie mogła powstać w żadnym środowisku.
 *
 * Ten moduł domyka nośnik dokładnie tym wzorcem, który jest już żywy
 * w `@gp/messaging/flow-kpi-telemetry`: LAZY klient z `POSTHOG_API_KEY`,
 * `require("posthog-node")` dopiero po sprawdzeniu klucza (żeby brak SDK nie
 * wywracał bootu) i JEDEN `warn` na proces, gdy klucza nie ma — cisza jest
 * najgorszym możliwym zachowaniem nośnika alertu.
 */

/** Kształt kliena PostHoga, którego joby faktycznie używają. */
export type PosthogCaptureClient = {
  capture(args: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
  }): void
  shutdown?(): Promise<void>
}

/** Klucz kontenera — jeden literał dla loadera, jobów i testów. */
export const POSTHOG_CONTAINER_KEY = "posthog" as const

type WarnLike = (message: string, meta?: Record<string, unknown>) => void

let client: PosthogCaptureClient | null = null
let initAttempted = false
let unavailableWarned = false

/**
 * Zwraca klienta PostHoga zbudowanego z env albo `null`, gdy nośnik nie jest
 * skonfigurowany. Brak klucza NIE jest ciszą: pierwszy odczyt w procesie
 * zostawia `warn` z nazwą brakującej zmiennej.
 */
export function getPosthogCaptureClient(
  warn?: WarnLike,
): PosthogCaptureClient | null {
  if (initAttempted) {
    return client
  }
  initAttempted = true

  const apiKey = process.env.POSTHOG_API_KEY?.trim()
  if (!apiKey) {
    warnUnavailable(
      warn,
      "[posthog-metrics] POSTHOG_API_KEY nie jest ustawiony — metryki jobów " +
        "(w tym alert o entitlemencie bez dispatchu) NIE będą emitowane; " +
        "pozostaje wyłącznie ślad w logu",
      {},
    )
    return null
  }

  try {
    const { PostHog } = require("posthog-node") as {
      PostHog: new (
        key: string,
        options?: { host?: string; flushAt?: number; flushInterval?: number },
      ) => PosthogCaptureClient
    }
    client = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST,
      // Joby są krótkotrwałe — bufor przeżyłby proces, więc flushujemy od razu.
      flushAt: 1,
      flushInterval: 0,
    })
  } catch (error) {
    // Brak SDK / błąd konstrukcji NIE może wywrócić joba ani bootu.
    client = null
    warnUnavailable(
      warn,
      "[posthog-metrics] nie udało się zbudować klienta PostHoga — metryki " +
        "jobów będą wyłącznie w logach",
      { error_class: error instanceof Error ? error.constructor.name : typeof error },
    )
  }

  return client
}

/** JEDEN warn na proces — brak nośnika ma być głośny, ale nie spamujący. */
function warnUnavailable(
  warn: WarnLike | undefined,
  message: string,
  meta: Record<string, unknown>,
): void {
  if (unavailableWarned) return
  unavailableWarned = true
  if (warn) {
    warn(message, meta)
    return
  }
  // eslint-disable-next-line no-console
  console.warn(message, meta)
}

/** Wyłącznie dla testów — resetuje stan lazy-inicjalizacji. */
export function __resetPosthogMetricsClientForTests(
  override: PosthogCaptureClient | null = null,
): void {
  client = override
  initAttempted = override !== null
  unavailableWarned = false
}
