/**
 * handoff-link-intent.ts — payload handoff-maila do obdarowanej
 * (Story 2.4, AC1 / AC3; AD-7 / AD-8, FR-15a).
 *
 * ── To NIE jest druga ścieżka wysyłki ───────────────────────────────────────
 * Ten plik buduje WYŁĄCZNIE payload. Base URL, link claim i klucz idempotencji
 * pochodzą z `purchase-confirmation-intent.ts` (`resolveStorefrontBaseUrl`,
 * `buildClaimUrl`, `buildDispatchIdempotencyKey`) — zero kopii logiki. Rezerwacja
 * w ledgerze, wysyłka przez `Modules.NOTIFICATION` i tranzycja `queued→sent|failed`
 * dzieją się w TYM SAMYM subscriberze (`voucher-purchase-delivery.ts`), tą samą
 * sekwencją, w tej samej tabeli `voucher_delivery_dispatch`.
 *
 * ── Locale: KUPUJĄCEJ, nie odbiorczyni (AD-8, ADR-162, ADR-163) ─────────────
 * Locale odbiorczyni jest NIEZNANE (nie pytamy o nie w UI i nie zgadujemy go
 * z domeny adresu). Handoff idzie w `purchase_locale` — locale zakupu, zawsze
 * znane — i link claim niesie prefiks tego samego locale. Wołający przekazuje
 * już rozwiązane `locale` i `claim_url`; ten plik ich nie renegocjuje.
 *
 * ── Zero PII poza polem `to` ────────────────────────────────────────────────
 * Adres obdarowanej pojawia się WYŁĄCZNIE w `to`. Do `data`/`metadata` idzie
 * `recipient_hash` (D-70) — te struktury trafiają do logów providera i audytu.
 * Wiadomość od kupującej (`gift_recipient_message`) NIE wchodzi do payloadu:
 * personalizacja treści to `voucher-personalization.v1`, którego FR-15 świadomie
 * NIE mapuje w v1.14.0.
 */

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import {
  buildDispatchIdempotencyKey,
  VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
} from "./purchase-confirmation-intent"
import type { RecipientHash } from "./recipient-hash"

/**
 * Handoff dzieli flow governance-owy z buyer-mailem: to ta sama mechanika
 * dostarczania (AD-7), więc ta sama flaga i ten sam KPI (ADR-161). Osobny
 * `flow_id` rozjechałby wiring flag/KPI dowieziony w Story 2.3.
 */
export const VOUCHER_HANDOFF_FLOW_ID = VOUCHER_PURCHASE_DELIVERY_FLOW_ID

export interface HandoffLinkIntentInput {
  /** Adres OBDAROWANEJ — jedyne miejsce, w którym opuszcza projekcję. */
  recipient_email: string
  recipient_hash: RecipientHash
  entitlement_id: string
  voucher_code: string
  market_id: string
  /** `purchase_locale` (locale KUPUJĄCEJ) — nigdy locale odbiorczyni. */
  locale: string
  claim_url: string
  dispatch_id: string
}

/**
 * Payload dla `Modules.NOTIFICATION.createNotifications` (AD-5).
 *
 * `template` i `data.template_key` pochodzą z TEJ SAMEJ stałej rejestru
 * (`NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK`, AD-6) — zero literałów
 * `template_key` w kodzie produkcyjnym. Wpis w
 * `specs/contracts/notifications/templates.yaml` istnieje od Story 2.1
 * (`recipient: recipient`); ta funkcja go konsumuje, nie dopisuje.
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

  return {
    to: input.recipient_email,
    channel: "email",
    template: templateKey,
    idempotency_key: idempotencyKey,
    data: {
      template_key: templateKey,
      market_id: input.market_id,
      flow_id: VOUCHER_HANDOFF_FLOW_ID,
      locale: input.locale,
      idempotency_key: idempotencyKey,
      entitlement_id: input.entitlement_id,
      dispatch_id: input.dispatch_id,
      voucher_code: input.voucher_code,
      claim_url: input.claim_url,
      recipient_hash: input.recipient_hash,
    },
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
