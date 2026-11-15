/**
 * v1.16.0 Story 11.6 (FR-20, AD-49, AD-51, NFR-2, NFR-3; DW-15-040, DW-15-049,
 * DW-15-360 `scope_extension_6_5`; D-35 p.15) — retencja danych obdarowanego
 * wykonywana RAZ NA RYNEK, pod rolą runtime, z wynikiem per nośnik.
 *
 * ── Dlaczego job nie woła już `container.resolve("voucher_pii")` ────────────
 * Medusa 2.13 NIE odkrywa katalogu `src/loaders/` aplikacji (loader
 * `@medusajs/medusa/dist/loaders/index.js` ładuje linki, workflowy,
 * subscribery i joby — nie loadery projektu; patrz też
 * `modules/payment-stripe-multi-market/resolve-stripe-options.ts`). Klucz
 * `voucher_pii` nie był więc w runtime rejestrowany i oba joby retencji kończyły
 * się `warn` „no voucher_pii service resolved” — martwe wiring zmierzone
 * w audycie 11.6. Retencja potrzebuje wyłącznie adaptera Postgresa, więc budujemy
 * go tutaj na `PG_CONNECTION` — bez drugiej puli i bez zależności od loadera.
 *
 * ── Rola runtime i kontekst rynku (AD-21, AD-49) ────────────────────────────
 * Praca biegnie WYŁĄCZNIE wewnątrz `runInSystemMarketContext` (ALS niesie
 * rynek). Hook RLS (`lib/rls-pool-hook.ts`) instaluje dopiero pierwsze żądanie
 * `/store/*`, a scheduler startuje wcześniej — dlatego transakcja sama przypina
 * `SET LOCAL ROLE medusa_store` i `app.gp_market_id` rynku z ALS (`is_local`,
 * znika z transakcją). To ten sam kształt zmiennych sesji co hook, nie drugi
 * nośnik: rynek pochodzi z ALS i jest porównany z argumentem (rozjazd = odmowa).
 *
 * ── Nośniki i metoda (D-35 p.15) ────────────────────────────────────────────
 *   - `voucher_recipient_pii` — DELETE tombstonowanych wierszy po terminie
 *     (zastane `purgeByMarketBefore`) + sieroty (`cleanupOrphans`, wymaga SELECT
 *     na `voucher_pii_consent_audit` — migracja 20261115160000);
 *   - `order_line_item.metadata` (DW-15-040) — REDAKCJA w miejscu kluczy
 *     `gift_recipient_email|name|message` po terminie; wiersz zostaje (zamówienie
 *     jest zapisem rozliczeniowym). Rynek z `entitlement_instance.market_id`
 *     (tabela pod RLS) — core Medusy nie ma kolumny rynku;
 *   - `notification.data` (DW-15-049) — REDAKCJA kluczy `customer_first_name`
 *     i `salon_address` po terminie, rynek z `data.market_id`.
 * Retriable handoff link: jedynym silnikiem retry jest
 * `jobs/voucher-delivery-reconciliation-sweep.ts` z dolną granicą skanu
 * `SWEEP_GAP_LOOKBACK_MS` = 7 dni; termin retencji (domyślnie 365 dni) jest
 * ostro dłuższy, więc redakcja nie odbiera adresu żadnemu retry (pomiar w teście
 * PG 11.6 i w `audyt-nosnikow.json`).
 *
 * Wynik nie niesie żadnej wartości PII — wyłącznie liczniki per nośnik.
 */
import type { Knex } from "knex"

import { marketContextStorage } from "../../lib/market-context"
import { GP_MARKET_SESSION_VAR } from "../../lib/rls-pool-hook"
import { PgVoucherPiiAdapter } from "./adapters/pg-pii"
import { RecipientPiiMarketAccessDeniedError } from "./recipient-pii-market-guard"

export const RECIPIENT_RETENTION_RUNTIME_ROLE = "medusa_store" as const

/** Klucze PII obdarowanej w `line_item.metadata` (ADR-163 gift-flow-v1). */
export const LINE_ITEM_GIFT_RECIPIENT_PII_KEYS = [
  "gift_recipient_email",
  "gift_recipient_name",
  "gift_recipient_message",
] as const

/** Klucze PII w `notification.data` intentów dostawy (DW-15-049). */
export const NOTIFICATION_DATA_PII_KEYS = ["customer_first_name", "salon_address"] as const

/** Znacznik redakcji — pozwala policzyć zredagowane wiersze bez czytania PII. */
export const RECIPIENT_PII_REDACTED_MARKER = "gp_recipient_pii_redacted_at" as const

/** Nazwy nośników w wyniku i w logu (stabilne — czyta je evidence 11.6). */
export const RETENTION_CARRIERS = {
  recipientPiiPurged: "voucher_recipient_pii.purged",
  recipientPiiOrphans: "voucher_recipient_pii.orphans",
  lineItemMetadata: "order_line_item.metadata.gift_recipient",
  notificationData: "notification.data.customer_first_name_salon_address",
} as const

export type RecipientRetentionCarrierCounts = {
  [RETENTION_CARRIERS.recipientPiiPurged]: number
  [RETENTION_CARRIERS.recipientPiiOrphans]: number
  [RETENTION_CARRIERS.lineItemMetadata]: number
  [RETENTION_CARRIERS.notificationData]: number
}

export type RecipientRetentionResult = {
  market_id: string
  cutoff: string
  carriers: RecipientRetentionCarrierCounts
}

function rowCount(result: unknown): number {
  const r = result as { rowCount?: number | null } | null
  return typeof r?.rowCount === "number" ? r.rowCount : 0
}

function removeKeysSql(column: string, keys: readonly string[]): string {
  return keys.reduce((expr, key) => `(${expr} - '${key}')`, column)
}

function anyKeyPresentSql(column: string, keys: readonly string[]): string {
  return `(${keys.map((k) => `(${column} ->> '${k}') IS NOT NULL`).join(" OR ")})`
}

/** DW-15-040: redakcja kluczy obdarowanej w `order_line_item.metadata` rynku. */
export async function redactLineItemGiftRecipientPii(
  trx: Knex.Transaction,
  args: { market_id: string; cutoff: Date; batch_size: number }
): Promise<number> {
  const keys = LINE_ITEM_GIFT_RECIPIENT_PII_KEYS
  const result = await trx.raw(
    `UPDATE order_line_item AS li
        SET metadata = ${removeKeysSql("li.metadata", keys)}
                       || jsonb_build_object('${RECIPIENT_PII_REDACTED_MARKER}', to_jsonb(now()))
      WHERE li.id IN (
        SELECT li2.id
          FROM order_line_item AS li2
          JOIN entitlement_instance AS ei ON ei.line_item_id = li2.id
         WHERE ei.market_id = ?
           AND li2.created_at < ?
           AND ${anyKeyPresentSql("li2.metadata", keys)}
         LIMIT ?
      )`,
    [args.market_id, args.cutoff, args.batch_size]
  )
  return rowCount(result)
}

/** DW-15-049: redakcja `customer_first_name`/`salon_address` w `notification.data` rynku. */
export async function redactNotificationDataPii(
  trx: Knex.Transaction,
  args: { market_id: string; cutoff: Date; batch_size: number }
): Promise<number> {
  const keys = NOTIFICATION_DATA_PII_KEYS
  const result = await trx.raw(
    `UPDATE notification AS n
        SET data = ${removeKeysSql("n.data", keys)}
                   || jsonb_build_object('${RECIPIENT_PII_REDACTED_MARKER}', to_jsonb(now()))
      WHERE n.id IN (
        SELECT n2.id
          FROM notification AS n2
         WHERE (n2.data ->> 'market_id') = ?
           AND n2.created_at < ?
           AND ${anyKeyPresentSql("n2.data", keys)}
         LIMIT ?
      )`,
    [args.market_id, args.cutoff, args.batch_size]
  )
  return rowCount(result)
}

/**
 * Jeden przebieg retencji dla JEDNEGO rynku. Wymaga kontekstu ALS z tym samym
 * rynkiem (wołane z `runInSystemMarketContext`); brak albo rozjazd = nazwana
 * odmowa `RecipientPiiMarketAccessDeniedError`, nic nie jest usuwane.
 */
export async function runRecipientRetentionForMarket(
  db: Knex,
  args: { market_id: string; cutoff: Date; batch_size: number }
): Promise<RecipientRetentionResult> {
  const ctxMarket = marketContextStorage.getStore()?.market_id ?? null
  if (!ctxMarket) throw new RecipientPiiMarketAccessDeniedError("missing_market_context")
  if (ctxMarket !== args.market_id) throw new RecipientPiiMarketAccessDeniedError("market_mismatch")

  return db.transaction(async (trx) => {
    await trx.raw(`SET LOCAL ROLE ${RECIPIENT_RETENTION_RUNTIME_ROLE}`)
    await trx.raw(`SELECT set_config('${GP_MARKET_SESSION_VAR}', ?, true)`, [args.market_id])

    const pii = new PgVoucherPiiAdapter(trx)
    const purged = await pii.purgeByMarketBefore(args)
    const orphans = await pii.cleanupOrphans({ batch_size: args.batch_size })
    const lineItems = await redactLineItemGiftRecipientPii(trx, args)
    const notifications = await redactNotificationDataPii(trx, args)

    return {
      market_id: args.market_id,
      cutoff: args.cutoff.toISOString(),
      carriers: {
        [RETENTION_CARRIERS.recipientPiiPurged]: purged.rows_deleted,
        [RETENTION_CARRIERS.recipientPiiOrphans]: orphans.rows_deleted,
        [RETENTION_CARRIERS.lineItemMetadata]: lineItems,
        [RETENTION_CARRIERS.notificationData]: notifications,
      },
    }
  })
}

/** Linia logu bez PII: wyłącznie rynek i liczniki per nośnik. */
export function formatRetentionCarrierLog(result: RecipientRetentionResult): string {
  const parts = Object.entries(result.carriers).map(([k, v]) => `${k}=${v}`)
  return `market=${result.market_id} cutoff=${result.cutoff} ${parts.join(" ")}`
}
