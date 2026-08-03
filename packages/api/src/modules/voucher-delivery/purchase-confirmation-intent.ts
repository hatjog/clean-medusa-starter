/**
 * purchase-confirmation-intent.ts — budowa payloadu maila potwierdzenia zakupu
 * vouchera (Story 2.3 AC4; Story 5.7 AC4 — pokrycie kontraktu szablonu).
 *
 * Rozdzielone od subscribera świadomie: kształt payloadu to czysta funkcja
 * (testowalna bez kontenera Medusy i bez DB), a subscriber zostaje orkiestracją
 * I/O.
 *
 * ── Story 5.7: payload MUSI pokrywać manifest ───────────────────────────────
 * Do 5.7 payload niósł dziesięć pól governance i ani jednej zmiennej, której
 * realnie oczekiwał szablon poza `voucher_code`. Mail wychodził z pustym
 * imieniem, pustym salonem, pustym „Ważny do" i martwym przyciskiem, a ledger
 * pokazywał `sent`. Odtąd komplet `body_vars` jest zadeklarowany maszynowo
 * (`notification-body-vars.ts`) i sprawdzany fail-loud PRZED wywołaniem
 * providera: payload bez pokrycia kończy się kontrolowanym błędem, który
 * single-writer ledgera zapisuje jako `failed` — nigdy jako `sent`.
 *
 * ── `voucher_pdf_url` nie obiecuje PDF-a (AC4.6) ────────────────────────────
 * Klucz zostaje, bo wymaga go istniejący manifest, ale jego wartością jest
 * strona vouchera w storefroncie — dokładnie ten sam kształt linku co
 * `handoff_url`. PDF przy wystawieniu nie powstaje, więc link do niego byłby
 * obietnicą bez pokrycia. Copy CTA w szablonach zostało poprawione na
 * „Otwórz voucher".
 *
 * ── Link: jeden builder dla obu maili (AC6.5) ───────────────────────────────
 * Base URL, walidacja osiągalności i ścieżka `/{locale}/voucher/{code}` żyją w
 * `voucher-page-url.ts`. Ten plik ich nie liczy i nie renegocjuje.
 *
 * ── Zero PII w payloadzie poza polem `to` i personalizacją treści ───────────
 * Adres pojawia się WYŁĄCZNIE w `to`. Do `data` idzie `recipient_hash`, nigdy
 * adres (D-70). `customer_first_name` jest świadomym wyjątkiem: to zmienna
 * treści wymagana przez manifest — imię, nigdy adres, nigdy nazwisko.
 */

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import {
  assertBodyVarsCovered,
  VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS,
} from "./notification-body-vars"
import {
  formatDateForLocale,
  formatMinorAmountForLocale,
} from "./notification-formatting"
import type { RecipientHash } from "./recipient-hash"

/** Flow governance-owy tej wysyłki (parity z `voucher-pii` dispatch adapterem). */
export const VOUCHER_PURCHASE_DELIVERY_FLOW_ID = "voucher_purchase_delivery"

/**
 * Wspólne wejście obu intentów voucherowych (Story 5.7).
 *
 * Wartości są SUROWE (daty jako ISO/`Date`, kwota w minor units): formatowanie
 * dla locale należy do buildera, żeby nie mogło się rozjechać między dwoma
 * mailami ani wyciec do szablonu.
 */
export interface VoucherDeliveryIntentInput {
  /** Adres odbiorcy — jedyne miejsce, w którym opuszcza projekcję. */
  recipient_email: string
  recipient_hash: RecipientHash
  entitlement_id: string
  voucher_code: string
  market_id: string
  /** `purchase_locale` — locale ZAKUPU (AD-8), nigdy locale odbiorczyni. */
  locale: string
  dispatch_id: string
  /** Deep-link `/{locale}/voucher/{code}` z `voucher-page-url.ts`. */
  voucher_page_url: string
  customer_first_name: string | null
  salon_name: string | null
  salon_address: string | null
  /** `market_runtime_config.support_email` — nigdy env, nigdy hardkod (AC2). */
  support_email: string | null
  /** `market_runtime_config.market_url` — nigdy env, nigdy hardkod (AC2). */
  market_url: string | null
  voucher_expires_at: string | Date | null
}

export interface PurchaseConfirmationIntentInput
  extends VoucherDeliveryIntentInput {
  /** `order.display_id` (fallback `order.id`) — z prawdziwego zamówienia. */
  order_id: string | null
  purchase_date: string | Date | null
  /** Minor units z wystawionego vouchera; `string` bo `pg` zwraca `numeric`. */
  voucher_value_minor: unknown
  voucher_currency: string | null
  /** `/{locale}/sellers/{handle}` wyprowadzony z tabelowego `market_url`. */
  salon_url: string | null
}

/**
 * Payload dla `Modules.NOTIFICATION.createNotifications` (AD-5).
 *
 * `template` (pole kontraktu Medusy) i `data.template_key` (kanoniczne GP,
 * ADR-158) pochodzą z TEJ SAMEJ stałej rejestru — zero literałów
 * `template_key` w kodzie produkcyjnym (AD-6).
 *
 * `idempotency_key` jest wyprowadzony z klucza ledgera, więc trwały dedupe
 * Medusy (`NotificationModuleService.createNotifications_` szuka po
 * `idempotency_key`) pokrywa się z idempotencją ledgera — dwie warstwy tego
 * samego niezmiennika, nie dwie różne tożsamości wysyłki.
 *
 * Rzuca `NotificationBodyVarsIncompleteError`, gdy którakolwiek zmienna
 * kontraktu jest pusta (Story 5.7 AC4.8).
 */
export function buildPurchaseConfirmationNotification(
  input: PurchaseConfirmationIntentInput,
): Record<string, unknown> {
  const templateKey = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION
  const idempotencyKey = buildDispatchIdempotencyKey(input)

  const data = {
    template_key: templateKey,
    // Bez tej trójki provider brevo nie rozwiąże nadawcy ani market-scoped
    // audytu (Completion Notes 2.2).
    market_id: input.market_id,
    flow_id: VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
    locale: input.locale,
    idempotency_key: idempotencyKey,
    entitlement_id: input.entitlement_id,
    dispatch_id: input.dispatch_id,
    // D-70: identyfikator odbiorcy w danych = hash, nigdy adres.
    recipient_hash: input.recipient_hash,

    // ── body_vars manifestu (Story 5.7, AC4) ────────────────────────────────
    customer_first_name: input.customer_first_name ?? "",
    voucher_code: input.voucher_code,
    voucher_value: formatMinorAmountForLocale(
      input.voucher_value_minor,
      input.locale,
    ) ?? "",
    voucher_currency: input.voucher_currency ?? "",
    voucher_expires_at:
      formatDateForLocale(input.voucher_expires_at, input.locale) ?? "",
    salon_name: input.salon_name ?? "",
    salon_address: input.salon_address ?? "",
    salon_url: input.salon_url ?? "",
    order_id: input.order_id ?? "",
    purchase_date: formatDateForLocale(input.purchase_date, input.locale) ?? "",
    // AC4.6: klucz manifestu zostaje, wartością jest strona vouchera.
    voucher_pdf_url: input.voucher_page_url,
    market_url: input.market_url ?? "",
    support_email: input.support_email ?? "",
  }

  assertBodyVarsCovered(
    templateKey,
    VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS,
    data,
  )

  return {
    // Retry musi aktualizować TEN SAM rekord Notification Medusy. Bez stabilnego
    // ID Medusa generuje nowe `noti_*`, a jej `finally` próbuje zaktualizować
    // rekord, którego nie utworzyła przy deduplikacji po `idempotency_key`.
    // Ten sam błąd zastępuje wtedy marker providera i ledger widzi fallback.
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

/**
 * Klucz idempotencji Medusy wyprowadzony z klucza ledgera
 * `(entitlement_id, template_key, recipient_hash)`.
 *
 * Story 2.4: `template_key` jest PARAMETREM (domyślnie potwierdzenie zakupu),
 * bo handoff-mail (`voucher_handoff_link`) współistnieje z buyer-mailem na tym
 * samym entitlemencie. Gdyby klucz pozostał zaszyty na jednym szablonie, dwie
 * różne wysyłki miałyby jedną tożsamość w Medusie i druga zostałaby cicho
 * zdedupowana — czyli obdarowana nie dostałaby maila.
 */
export function buildDispatchIdempotencyKey(input: {
  entitlement_id: string
  recipient_hash: RecipientHash
  template_key?: string
}): string {
  const templateKey =
    input.template_key ?? NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION
  return `voucher-purchase-delivery:${input.entitlement_id}:${templateKey}:${input.recipient_hash}`
}
