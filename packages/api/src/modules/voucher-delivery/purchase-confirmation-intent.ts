/**
 * purchase-confirmation-intent.ts — budowa payloadu maila potwierdzenia zakupu
 * vouchera (Story 2.3, AC4).
 *
 * Rozdzielone od subscribera świadomie: kształt payloadu i budowa linku claim to
 * czysta funkcja (testowalna bez kontenera Medusy i bez DB), a subscriber
 * zostaje orkiestracją I/O.
 *
 * ── Link claim z prefiksem locale ───────────────────────────────────────────
 * Deep-link per-kod w storefroncie to `/{locale}/voucher/{code}`
 * (`GP/storefront/src/app/[locale]/(main)/voucher/[code]`). Locale w linku to
 * **locale ZAKUPU** (AC3/AC4) — nigdy twarde `pl`.
 *
 * ── Base URL: konfiguracja, nigdy hardcode ──────────────────────────────────
 * Kolejność: per-market env (`GP_STOREFRONT_URL_<MARKET>`) → globalny
 * `STOREFRONT_URL` / `STOREFRONT_BASE_URL` / `NEXT_PUBLIC_BASE_URL`. Brak
 * konfiguracji = **fail-loud** z kodem błędu; NIGDY `http://localhost` w linku
 * produkcyjnego maila (to jest realny tryb awarii, nie hipoteza — wzorzec
 * `DEFAULT_STOREFRONT_URL` z `lib/auth/recover-magic-link-email.ts` robi
 * dokładnie to, czego AC4 zakazuje dla tej ścieżki).
 *
 * ── Zero PII w payloadzie poza polem `to` ───────────────────────────────────
 * Adres pojawia się WYŁĄCZNIE w `to` (wymóg kanału). Do `data`/`metadata` idzie
 * `recipient_hash`, nigdy adres — te struktury trafiają do logów providera
 * i audytu (D-70).
 */

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import type { RecipientHash } from "./recipient-hash"

/** Flow governance-owy tej wysyłki (parity z `voucher-pii` dispatch adapterem). */
export const VOUCHER_PURCHASE_DELIVERY_FLOW_ID = "voucher_purchase_delivery"

export class StorefrontBaseUrlNotConfiguredError extends Error {
  readonly error_code = "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED"

  constructor(marketId: string) {
    super(
      `[voucher-purchase-delivery] brak skonfigurowanego base URL storefrontu dla rynku '${marketId}' ` +
        "(ustaw GP_STOREFRONT_URL_<MARKET> albo STOREFRONT_URL/STOREFRONT_BASE_URL) — " +
        "mail z linkiem do localhost jest gorszy niż brak maila",
    )
    this.name = "StorefrontBaseUrlNotConfiguredError"
  }
}

/** `bonbeauty` → `GP_STOREFRONT_URL_BONBEAUTY`; `bon-garden` → `..._BON_GARDEN`. */
export function marketStorefrontUrlEnvKey(marketId: string): string {
  const normalized = marketId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
  return `GP_STOREFRONT_URL_${normalized}`
}

export function resolveStorefrontBaseUrl(input: {
  marketId: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = input.env ?? process.env
  const candidates = [
    env[marketStorefrontUrlEnvKey(input.marketId)],
    env.STOREFRONT_URL,
    env.STOREFRONT_BASE_URL,
    env.NEXT_PUBLIC_BASE_URL,
  ]

  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed) {
      return trimmed.replace(/\/+$/, "")
    }
  }

  throw new StorefrontBaseUrlNotConfiguredError(input.marketId)
}

export function buildClaimUrl(input: {
  baseUrl: string
  locale: string
  voucherCode: string
}): string {
  return (
    `${input.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.locale)}` +
    `/voucher/${encodeURIComponent(input.voucherCode)}`
  )
}

export interface PurchaseConfirmationIntentInput {
  recipient_email: string
  recipient_hash: RecipientHash
  entitlement_id: string
  voucher_code: string
  market_id: string
  locale: string
  claim_url: string
  dispatch_id: string
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
 */
export function buildPurchaseConfirmationNotification(
  input: PurchaseConfirmationIntentInput,
): Record<string, unknown> {
  const templateKey = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION
  const idempotencyKey = buildDispatchIdempotencyKey(input)

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
    data: {
      template_key: templateKey,
      // Bez tej trójki provider brevo nie rozwiąże nadawcy ani market-scoped
      // audytu (Completion Notes 2.2).
      market_id: input.market_id,
      flow_id: VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
      locale: input.locale,
      idempotency_key: idempotencyKey,
      entitlement_id: input.entitlement_id,
      dispatch_id: input.dispatch_id,
      // AC4: kod vouchera + link claim z prefiksem locale zakupu.
      voucher_code: input.voucher_code,
      claim_url: input.claim_url,
      // D-70: identyfikator odbiorcy w danych = hash, nigdy adres.
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
