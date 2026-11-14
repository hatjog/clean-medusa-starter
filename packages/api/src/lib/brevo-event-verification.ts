/**
 * ADR-213 wariant C — weryfikacja zwrotna zdarzenia dostawy przez API Brevo.
 *
 * Webhook Brevo nie jest podpisany. Wariant A (sekret w ścieżce) jest tylko
 * tanią barierą wstępu (bearer token bez ochrony przed powtórzeniem), więc
 * stan dostarczenia trafia do rejestru dopiero wtedy, gdy DOSTAWCA potwierdzi
 * go odpowiedzią na `GET /v3/smtp/statistics/events?messageId=…&event=…`.
 * Treść żądania jest WSKAZÓWKĄ, nie prawdą.
 *
 * Wynik jest trójdzielny i każda gałąź ma nazwany kod — brak potwierdzenia,
 * niedostępność weryfikatora i awaria wywołania to TRZY różne stany, nie jeden
 * „nie udało się”. Klucz API nigdy nie trafia do wyniku ani komunikatu błędu.
 */
import type { NotificationDeliveryEventType } from "@gp/messaging"

export const BREVO_EVENTS_ENDPOINT = "https://api.brevo.com/v3/smtp/statistics/events"

export const DELIVERY_EVENT_PROVIDER_UNCONFIRMED_CODE =
  "DELIVERY_EVENT_PROVIDER_UNCONFIRMED"
export const DELIVERY_EVENT_VERIFICATION_UNAVAILABLE_CODE =
  "DELIVERY_EVENT_VERIFICATION_UNAVAILABLE"
export const DELIVERY_EVENT_VERIFICATION_FAILED_CODE =
  "DELIVERY_EVENT_VERIFICATION_FAILED"

/**
 * Słownik filtra `event` endpointu statystyk Brevo (dokumentacja API v3,
 * `getEmailEventReport`). Mapa jest ZAMKNIĘTA: brak wpisu = błąd kompilacji.
 *
 * R-1 (checkpoint 6.6, PO D-4): pole `events[].event` w odpowiedzi ma TEN SAM
 * enum co filtr — liczba mnoga (`bounces`, `hardBounces`, `softBounces`,
 * `delivered`, `spam`, `requests`, `opened`, `clicks`, `invalid`, `deferred`,
 * `blocked`, `unsubscribed`, `error`, `loadedByProxy`). Porównanie idzie po
 * wartości filtra; mapowanie na liczbę pojedynczą dawało `unconfirmed` dla
 * każdego prawdziwego odbicia i kliknięcia.
 */
export const BREVO_STATISTICS_EVENT_BY_TYPE: Readonly<
  Record<NotificationDeliveryEventType, string>
> = Object.freeze({
  delivered: "delivered",
  opened: "opened",
  clicked: "clicks",
  bounced_permanent: "hardBounces",
  bounced_transient: "softBounces",
  blocked: "blocked",
  invalid_address: "invalid",
  deferred: "deferred",
  complaint: "spam",
  unsubscribed: "unsubscribed",
  failed: "error",
})

export type BrevoEventVerificationResult =
  | { outcome: "confirmed"; statistics_event: string }
  | { outcome: "unconfirmed"; statistics_event: string; error_code: string }
  | { outcome: "verification_failed"; statistics_event: string; error_code: string; http_status?: number }

export type BrevoDeliveryEventVerifier = {
  verify: (input: {
    provider_message_id: string
    event_type: NotificationDeliveryEventType
  }) => Promise<BrevoEventVerificationResult>
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>

export function createBrevoDeliveryEventVerifier(options: {
  apiKey: string
  fetch?: FetchLike
  endpoint?: string
}): BrevoDeliveryEventVerifier {
  const apiKey = options.apiKey.trim()
  const doFetch: FetchLike =
    options.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>)
  const endpoint = options.endpoint ?? BREVO_EVENTS_ENDPOINT

  return {
    async verify({ provider_message_id, event_type }) {
      const statisticsEvent = BREVO_STATISTICS_EVENT_BY_TYPE[event_type]
      const query = new URLSearchParams({
        messageId: provider_message_id,
        event: statisticsEvent,
        limit: "10",
      })
      let response: Awaited<ReturnType<FetchLike>>
      try {
        response = await doFetch(`${endpoint}?${query.toString()}`, {
          method: "GET",
          headers: { accept: "application/json", "api-key": apiKey },
        })
      } catch {
        return {
          outcome: "verification_failed",
          statistics_event: statisticsEvent,
          error_code: DELIVERY_EVENT_VERIFICATION_FAILED_CODE,
        }
      }
      if (response.status !== 200) {
        return {
          outcome: "verification_failed",
          statistics_event: statisticsEvent,
          error_code: DELIVERY_EVENT_VERIFICATION_FAILED_CODE,
          http_status: response.status,
        }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = null
      }
      const events =
        body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
          ? ((body as { events: unknown[] }).events as Array<Record<string, unknown>>)
          : []
      const confirmed = events.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          entry.messageId === provider_message_id &&
          entry.event === statisticsEvent,
      )
      return confirmed
        ? { outcome: "confirmed", statistics_event: statisticsEvent }
        : {
            outcome: "unconfirmed",
            statistics_event: statisticsEvent,
            error_code: DELIVERY_EVENT_PROVIDER_UNCONFIRMED_CODE,
          }
    },
  }
}
