/**
 * stripe-payment-intent-transport.ts — Story 5.1 AC4 (v1.14.0) — warstwa
 * TRANSPORTOWA idempotencji webhooka Path Y + dostęp do PG dla route'u.
 *
 * ── Dwie ortogonalne warstwy idempotencji (nie mylić ich) ───────────────────
 *  1. TRANSPORT — `webhook_event_processed (event_id, provider)`: „ten pakiet od
 *     Stripe'a już przyjęliśmy". Klucz to `event.id` (`evt_…`). Chroni przed
 *     powtórną EMISJĄ przy `stripe events resend` / multi-replice forwardera.
 *  2. ISSUANCE — `event_processed (external_id, event_type)` w rdzeniu
 *     `live-issue-from-payment-intent.ts`: „ten PaymentIntent już wystawił
 *     entitlementy". Klucz to `payment_intent_id:order_id` (ADR-166). Chroni
 *     przed drugim voucherem per zamówienie nawet wtedy, gdy Stripe przyśle
 *     DWA różne `evt_…` dla tego samego PI.
 *
 * Obie są potrzebne i żadna nie zastępuje drugiej: warstwa 1 nie wie nic
 * o entitlementach, warstwa 2 nie wie nic o dostawach. Po tej zmianie ponowna
 * dostawa TEGO SAMEGO zdarzenia zatrzymuje się już na warstwie 1 (bez emisji),
 * a inne zdarzenie tego samego PI — na warstwie 2 (bez drugiego vouchera).
 *
 * ── `provider` celowo różny od natywnego hooka ──────────────────────────────
 * `workflows/payment/stripe-payment-audit.ts` pisze wiersze z `provider = 'stripe'`
 * i KASUJE je w kompensacji (`DELETE … WHERE provider = 'stripe'`). Path Y ma
 * własną wartość, żeby kompensacja jednej ścieżki nigdy nie zdjęła rezerwacji
 * drugiej. To dwie różne ścieżki dostawy, nie dwa zapisy tej samej.
 */
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { toKnexPositionalSql } from "../knex-positional-sql"
import type { PaymentLinkQueryClient } from "./stripe-payment-intent-link"

/** Wartość `webhook_event_processed.provider` dla cienkiego webhooka Path Y. */
export const STRIPE_PATH_Y_WEBHOOK_PROVIDER = "stripe_payment_intent_webhook"

export const RESERVE_WEBHOOK_DELIVERY_SQL = `
  INSERT INTO webhook_event_processed
    (event_id, provider, market_id, envelope, received_at)
  VALUES ($1, $2, $3, $4::jsonb, NOW())
  ON CONFLICT (event_id, provider) DO NOTHING
`

export const RELEASE_WEBHOOK_DELIVERY_SQL = `
  DELETE FROM webhook_event_processed
   WHERE event_id = $1
     AND provider = $2
`

/**
 * Rezerwuje dostawę zdarzenia. `true` = rezerwacja nasza (wołający emituje),
 * `false` = zdarzenie już przyjęte wcześniej ⇒ NIE emituj ponownie.
 */
export async function reserveWebhookDelivery(
  client: PaymentLinkQueryClient,
  input: { event_id: string; market_id: string | null; envelope: unknown }
): Promise<boolean> {
  const result = await client.query(RESERVE_WEBHOOK_DELIVERY_SQL, [
    input.event_id,
    STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    input.market_id,
    JSON.stringify(input.envelope),
  ])
  return (result.rowCount ?? 0) === 1
}

/**
 * Zwalnia rezerwację, gdy emisja NIE doszła do skutku.
 *
 * Bez tego nieudany `emit` zostawiałby wiersz, który na zawsze wyciszałby
 * ponowienia Stripe'a dla TEGO zdarzenia — opłacony zakup zostałby bez vouchera,
 * a licznik transportu pokazywałby „przyjęte". Kompensacja jest tu warunkiem
 * poprawności, nie sprzątaniem.
 */
export async function releaseWebhookDelivery(
  client: PaymentLinkQueryClient,
  eventId: string
): Promise<void> {
  await client.query(RELEASE_WEBHOOK_DELIVERY_SQL, [
    eventId,
    STRIPE_PATH_Y_WEBHOOK_PROVIDER,
  ])
}

type PgPoolLike = { connect: () => Promise<PgClientLike> }
type PgClientLike = PaymentLinkQueryClient & { release?: () => void }
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
}

export type WebhookPgHandle = {
  client: PaymentLinkQueryClient
  release: () => void
}

/**
 * Klient PG dla route'u webhooka.
 *
 * Route pozostaje CIENKI w sensie ADR-118 — nie tworzy entitlementów, nie woła
 * service'ów domenowych, nie otwiera transakcji biznesowej. Sięga do bazy
 * wyłącznie po (a) powiązanie płatność→zamówienie i (b) rezerwację dostawy.
 * Bez tego nie da się zbudować koperty wymaganej przez kontrakt (zmierzone
 * 2026-07-28: 100 % realnych zakupów kończyło się 400).
 *
 * Zwraca `null`, gdy w kontenerze nie ma żadnego dostępu do PG — wołający
 * decyduje, czy to sytuacja do ponowienia (5xx), czy do pominięcia.
 *
 * Rozróżnienie dialektów (`__pg_pool__` = `$N`, `PG_CONNECTION` = Knex/`?`) jest
 * w repo zastane; konwersję trzyma `lib/knex-positional-sql.ts`.
 */
export async function resolveWebhookPgHandle(scope: {
  resolve: (key: string) => unknown
}): Promise<WebhookPgHandle | null> {
  const pool = tryResolve<PgPoolLike>(scope, "__pg_pool__")
  if (pool && typeof pool.connect === "function") {
    const client = await pool.connect()
    return { client, release: () => client.release?.() }
  }

  const knex = tryResolve<KnexLike>(scope, ContainerRegistrationKeys.PG_CONNECTION)
  if (knex && typeof knex.raw === "function") {
    return { client: createKnexQueryClient(knex), release: () => {} }
  }

  return null
}

export function createKnexQueryClient(db: KnexLike): PaymentLinkQueryClient {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values: ReadonlyArray<unknown> = []
    ) => {
      const { text: sql, bindings } = toKnexPositionalSql(text, values)
      const result = await db.raw(sql, bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = ((result as { rows?: unknown[] }).rows ?? []) as T[]
      return {
        rows,
        rowCount: (result as { rowCount?: number | null }).rowCount ?? rows.length,
      }
    },
  }
}

function tryResolve<T>(
  scope: { resolve: (key: string) => unknown },
  key: string
): T | null {
  try {
    return (scope.resolve(key) as T | undefined) ?? null
  } catch {
    return null
  }
}
