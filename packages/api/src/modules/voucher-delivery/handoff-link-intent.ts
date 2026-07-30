/**
 * handoff-link-intent.ts — payload handoff-maila do obdarowanej
 * (Story 2.4, AC1 / AC3; AD-7 / AD-8, FR-15a; Story 5.7, AC3).
 *
 * ── To NIE jest druga ścieżka wysyłki ───────────────────────────────────────
 * Ten plik buduje WYŁĄCZNIE payload. Base URL i deep-link pochodzą z
 * `voucher-page-url.ts`, klucz idempotencji z `purchase-confirmation-intent.ts`
 * — zero kopii logiki. Rezerwacja w ledgerze, wysyłka przez
 * `Modules.NOTIFICATION` i tranzycja `queued→sent|failed` dzieją się w TYM
 * SAMYM subscriberze (`voucher-purchase-delivery.ts`), tą samą sekwencją, w tej
 * samej tabeli `voucher_delivery_dispatch`.
 *
 * ── Story 5.7: `claim_url` → `handoff_url` ──────────────────────────────────
 * Payload niósł `claim_url`, a szablon handoffu czyta `handoff_url`. Żaden
 * szablon nie czytał `claim_url` — stąd pusty `href` przycisku „Otwórz voucher"
 * w realnym mailu z 2026-07-30. `claim_url` NIE występuje już jako zmienna body
 * tego intentu; jedyną nazwą linku jest `handoff_url`, a komplet `body_vars`
 * jest walidowany fail-loud przed wysyłką.
 *
 * ── Locale: KUPUJĄCEJ, nie odbiorczyni (AD-8, ADR-162, ADR-163) ─────────────
 * Locale odbiorczyni jest NIEZNANE (nie pytamy o nie w UI i nie zgadujemy go
 * z domeny adresu). Handoff idzie w `purchase_locale` — locale zakupu, zawsze
 * znane — i link niesie prefiks tego samego locale. Wołający przekazuje już
 * rozwiązane `locale` i link; ten plik ich nie renegocjuje.
 *
 * ── Zero PII poza polem `to` ────────────────────────────────────────────────
 * Adres obdarowanej pojawia się WYŁĄCZNIE w `to`. Do `data`/`metadata` idzie
 * `recipient_hash` (D-70). `customer_first_name` to imię KUPUJĄCEJ wymagane
 * przez manifest („Magda kupiła dla Ciebie voucher"), nigdy adres.
 * Wiadomość od kupującej (`gift_recipient_message`) NIE wchodzi do payloadu:
 * personalizacja treści to `voucher-personalization.v1`, którego FR-15 świadomie
 * NIE mapuje w v1.14.0.
 */

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import {
  assertBodyVarsCovered,
  VOUCHER_HANDOFF_LINK_BODY_VARS,
} from "./notification-body-vars"
import { formatDateForLocale } from "./notification-formatting"
import {
  buildDispatchIdempotencyKey,
  VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
  type VoucherDeliveryIntentInput,
} from "./purchase-confirmation-intent"

/**
 * Handoff dzieli flow governance-owy z buyer-mailem: to ta sama mechanika
 * dostarczania (AD-7), więc ta sama flaga i ten sam KPI (ADR-161). Osobny
 * `flow_id` rozjechałby wiring flag/KPI dowieziony w Story 2.3.
 */
export const VOUCHER_HANDOFF_FLOW_ID = VOUCHER_PURCHASE_DELIVERY_FLOW_ID

export type HandoffLinkIntentInput = VoucherDeliveryIntentInput

/**
 * Payload dla `Modules.NOTIFICATION.createNotifications` (AD-5).
 *
 * `template` i `data.template_key` pochodzą z TEJ SAMEJ stałej rejestru
 * (`NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK`, AD-6) — zero literałów
 * `template_key` w kodzie produkcyjnym. Wpis w
 * `specs/contracts/notifications/templates.yaml` istnieje od Story 2.1
 * (`recipient: recipient`); ta funkcja go konsumuje, nie dopisuje.
 *
 * Rzuca `NotificationBodyVarsIncompleteError`, gdy którakolwiek zmienna
 * kontraktu jest pusta (Story 5.7 AC3).
 */
export function buildHandoffLinkNotification(
  input: HandoffLinkIntentInput,
): Record<string, unknown> {
  const templateKey = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK
  const idempotencyKey = buildDispatchIdempotencyKey({
    entitlement_id: input.entitlement_id,
    recipient_hash: input.recipient_hash,
    template_key: templateKey,
  })

  const data = {
    template_key: templateKey,
    market_id: input.market_id,
    flow_id: VOUCHER_HANDOFF_FLOW_ID,
    locale: input.locale,
    idempotency_key: idempotencyKey,
    entitlement_id: input.entitlement_id,
    dispatch_id: input.dispatch_id,
    recipient_hash: input.recipient_hash,

    // ── body_vars manifestu (Story 5.7, AC3) ────────────────────────────────
    customer_first_name: input.customer_first_name ?? "",
    voucher_code: input.voucher_code,
    salon_name: input.salon_name ?? "",
    salon_address: input.salon_address ?? "",
    // Jedyna nazwa linku w tym payloadzie — `claim_url` już nie istnieje.
    handoff_url: input.voucher_page_url,
    voucher_expires_at:
      formatDateForLocale(input.voucher_expires_at, input.locale) ?? "",
    market_url: input.market_url ?? "",
    support_email: input.support_email ?? "",
  }

  assertBodyVarsCovered(templateKey, VOUCHER_HANDOFF_LINK_BODY_VARS, data)

  return {
    // Patrz purchase-confirmation-intent: `dispatch_id` jest stabilnym ID
    // rekordu Notification Medusy również dla retry handoffu.
    id: input.dispatch_id,
    to: input.recipient_email,
    channel: "email",
    template: templateKey,
    idempotency_key: idempotencyKey,
    data,
    metadata: {
      notification_type: templateKey,
      triggered_by: "system",
      entitlement_id: input.entitlement_id,
      dispatch_id: input.dispatch_id,
      locale: input.locale,
      recipient_hash: input.recipient_hash,
    },
  }
}
