import { createHash } from "node:crypto"

import {
  EntitlementInstanceState,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../../modules/voucher/models/entitlement"
import {
  buildEventProcessedDedupeInsert,
  EVENT_PROCESSED_TABLE,
} from "../../modules/voucher/models/event-processed"
import {
  buildEntitlementDedupeKey,
  ENTITLEMENT_DEDUPE_ON_CONFLICT_CLAUSE,
} from "../../modules/voucher/models/entitlement-dedupe"
import {
  resolveVatClassification,
  type VatClassification,
} from "../../modules/voucher/vat-resolver"

/**
 * live-issue-from-payment-intent.ts — Story 3.3 (v1.11.0 Epic 3) — RDZEŃ live-issue
 * Path Y: konsumuje fakt `gp.stripe.payment_intent_succeeded.v1` (kontrakt Story 3.1,
 * envelope.v1) i IDEMPOTENTNIE wystawia L4 `entitlement_instance` w stanie ISSUED.
 *
 * Podstawa normatywna: ADR-137 (live-issue + DEC-5 dwupoziomowa idempotencja),
 * ADR-118 (Path Y: webhook-thin + subscriber = business logic), ADR-052/118 (zakaz
 * custom route / `GpCoreService.createEntitlement`), FR10/FR11/FR15/FR32.
 *
 * ── CO ROBI (AC2/AC3/AC4) ───────────────────────────────────────────────────
 *   1. EVENT-LEVEL dedupe (DEC-5 pkt 3.i): INSERT do `event_processed`
 *      (external_id = payment_intent_id, event_type) `ON CONFLICT DO NOTHING`
 *      jako PIERWSZY krok transakcji. 0 affected ⇒ event już skonsumowany ⇒
 *      pomiń tworzenie entitlementów (replay/multi-replica = no-op).
 *   2. Czyta IMMUTABLE recipientów z line-item metadata (zamrożeni w momencie
 *      płatności — precondition ADR-137); `recipient_index` deterministyczny.
 *   3. Dla każdej (line_item × recipient_index): liczy `entitlement_dedupe_key`
 *      (PEŁNY sha256, finding L-2), snapshotuje `policy_snapshot` + `vat_classification`
 *      (resolver 2.2), wypełnia `market_id` + `sales_channel_id` (ontologia 3.2),
 *      INSERT-uje wiersz ISSUED `ON CONFLICT (entitlement_dedupe_key) DO NOTHING`.
 *   4. `order_id` NON-NULLABLE na ścieżce live (live-issue ZAWSZE ma order).
 *
 * ── GRANICE (E3 — issue ≠ posting) ──────────────────────────────────────────
 *   - Stan = ISSUED (NIE ACTIVE: ta ścieżka NIE okablowuje maszyny stanów L4 —
 *     event+audit+posting hook = Story 3.4). To celowa różnica wobec aktywnej
 *     ścieżki `payment.captured` (issue-entitlement.ts), która tworzy ACTIVE.
 *   - NIE woła `ledger-writer.ts` (2.6), NIE aktywuje postingu (`runtime_enabled`
 *     zostaje `false`, flip = E6/P6), NIE rusza hard-gate'ów.
 *   - Side-effecty (email/.ics/MinIO) NALEŻĄ do warstwy PO-commit subscribera —
 *     ten rdzeń wykonuje WYŁĄCZNIE pracę w obrębie jednej DB-tx (atomicity).
 */

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>

/**
 * Minimalny kontrakt klienta PG w obrębie transakcji (spójny z
 * `issue-entitlement.ts`). Rdzeń NIE zarządza tx — caller (subscriber) otwiera
 * BEGIN/COMMIT i przekazuje `client`; side-effecty idą PO commit u callera.
 */
export type LiveIssuePgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
}

/** Payload kontraktu `gp.stripe.payment_intent_succeeded.v1` (Story 3.1). */
export type PaymentIntentSucceededPayload = {
  payment_intent_id: string
  order_id: string
  currency: string
  amount_minor: number
  psp_occurred_at: string
}

/** Scope envelope.v1 (Story 3.1) — źródło `market_id` (ontologia 3.2). */
export type LiveIssueScope = {
  instance_id?: string
  market_id?: string | null
  vendor_id?: string | null
  location_id?: string | null
}

/** Wejście rdzenia: payload + scope + event_type (do event-level dedupe). */
export type LiveIssueInput = {
  event_type: string
  payload: PaymentIntentSucceededPayload
  scope: LiveIssueScope
}

/** Pojedynczy wystawiony (lub idempotentnie pominięty) entitlement. */
export type LiveIssuedEntitlement = {
  entitlement_id: string
  entitlement_dedupe_key: string
  line_item_id: string
  recipient_index: number
  recipient_customer_id: string | null
  vat_classification: VatClassification
  /** true gdy wiersz powstał TERAZ; false gdy `ON CONFLICT DO NOTHING` (no-op). */
  created: boolean
}

export type LiveIssueResult = {
  /** false gdy event już skonsumowany (event-level dedupe) ⇒ zero pracy issue. */
  event_processed: boolean
  issued: LiveIssuedEntitlement[]
}

/** Surowy wiersz line-item z metadanymi (kształt jak w issue-entitlement.ts). */
type OrderLineRow = {
  line_item_id: string
  metadata: Record<string, unknown> | null
}

/** Recipient zamrożony w line-item metadata (immutable, ADR-137). */
type FrozenRecipient = {
  recipient_index: number
  recipient_customer_id: string | null
}

/**
 * Sygnatura wystawienia: gdzie subscriber wyłącznie deleguje issue (Path Y).
 * Eksport czysto dokumentacyjny — egzekwowany przez checker AC5
 * (`path-y-exclusivity.ts`): jedyną drogą do ISSUED jest TA funkcja wołana
 * z `@MedusaSubscriber`, NIE custom route ani `GpCoreService.createEntitlement`.
 */
export const LIVE_ISSUE_PATH = "path-y:subscriber:gp.stripe.payment_intent_succeeded.v1" as const

/**
 * Wystawia entitlementy ISSUED dla faktu płatności W OBRĘBIE przekazanej DB-tx
 * (atomicity: event_processed + INSERT-y entitlementów w jednej transakcji).
 * Idempotentne na DWÓCH poziomach (DEC-5). NIE wykonuje side-effectów — te idą
 * PO commit u callera.
 */
export async function liveIssueEntitlementsWithinTx(
  client: LiveIssuePgClient,
  input: LiveIssueInput,
  now: Date
): Promise<LiveIssueResult> {
  const { payload, scope, event_type } = input

  if (!payload.order_id) {
    // order_id NON-NULLABLE na ścieżce live (ADR-137 DEC pkt 2) — fail-loud.
    throw new Error(
      `liveIssueEntitlementsWithinTx: order_id wymagany na ścieżce live (payment_intent ${payload.payment_intent_id})`
    )
  }

  // ── (i) EVENT-LEVEL dedupe (DEC-5 pkt 3.i) — PIERWSZY krok transakcji ──────
  const dedupeInsert = buildEventProcessedDedupeInsert({
    external_id: payload.payment_intent_id,
    event_type,
    processed_at: now.getTime(),
  })
  const dedupe = await client.query(dedupeInsert.sql, dedupeInsert.params)
  if ((dedupe.rowCount ?? 0) === 0) {
    // event już skonsumowany (retry webhooka / multi-replica) ⇒ no-op.
    return { event_processed: false, issued: [] }
  }

  // ── kontekst orderu: sales_channel_id + market_id (ontologia 3.2) ──────────
  const orderRow = await client.query<{
    sales_channel_id: string | null
    metadata: Record<string, unknown> | null
  }>(
    `SELECT sales_channel_id, metadata FROM "order" WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [payload.order_id]
  )
  const order = orderRow.rows[0]
  const salesChannelId = readString(order?.sales_channel_id) ?? null
  const marketId =
    readString(scope.market_id) ??
    readNestedString(order?.metadata, ["gp", "market_id"]) ??
    readNestedString(order?.metadata, ["market_id"]) ??
    null

  // ── voucher line items (immutable metadata = źródło profilu + recipientów) ──
  const lines = await client.query<OrderLineRow>(
    `SELECT oli.id AS line_item_id, oli.metadata
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
      ORDER BY oi.created_at ASC`,
    [payload.order_id]
  )

  const issued: LiveIssuedEntitlement[] = []

  for (const line of lines.rows) {
    const profile = extractProfile(line.metadata, payload)
    if (!profile) {
      continue // non-voucher SKU — pomiń
    }
    const recipients = extractFrozenRecipients(line.metadata)

    for (const recipient of recipients) {
      const issuedRow = await issueSingleIssuedRow(
        client,
        payload,
        scope,
        {
          lineItemId: line.line_item_id,
          recipient,
          profile,
          marketId,
          salesChannelId,
        },
        now
      )
      issued.push(issuedRow)
    }
  }

  return { event_processed: true, issued }
}

type IssueRowContext = {
  lineItemId: string
  recipient: FrozenRecipient
  profile: ResolvedProfile
  marketId: string | null
  salesChannelId: string | null
}

async function issueSingleIssuedRow(
  client: LiveIssuePgClient,
  payload: PaymentIntentSucceededPayload,
  scope: LiveIssueScope,
  ctx: IssueRowContext,
  now: Date
): Promise<LiveIssuedEntitlement> {
  const { lineItemId, recipient, profile } = ctx

  // ── per-entitlement klucz dedupe (DEC-5 pkt 3.ii, PEŁNY digest L-2) ────────
  const dedupeKey = buildEntitlementDedupeKey(
    payload.payment_intent_id,
    lineItemId,
    recipient.recipient_index
  )

  // ── snapshot VAT (resolver 2.2) — niezmienny po ISSUED (FR32, TSUE C-68/23) ─
  // `vat_rates` przekazujemy WYŁĄCZNIE gdy policy realnie niesie listę stawek;
  // przekazanie `null`/`undefined` wymusiłoby gałąź rate-set resolvera (fail-closed
  // MPV) nawet gdy źródłem jest flaga `vat_rate_uniqueness`.
  const vatRates = extractVatRates(profile.policy)
  const vatClassification: VatClassification = resolveVatClassification({
    vat_rate_uniqueness: profile.policy.vat_rate_uniqueness,
    ...(vatRates ? { vat_rates: vatRates } : {}),
  })

  // ── snapshot policy (regulamin § 12 — immutable post-ISSUED) ───────────────
  const snapshot: EntitlementPolicySnapshot = snapshotPolicy({
    ...profile.policy,
    currency: profile.currency ?? payload.currency,
    amount_minor: profile.amount_minor ?? payload.amount_minor,
    source_payment_intent_id: payload.payment_intent_id,
    line_item_id: lineItemId,
    recipient_index: recipient.recipient_index,
  })

  const entitlementId = buildIssuedEntitlementId(dedupeKey)

  // INSERT ISSUED `ON CONFLICT (entitlement_dedupe_key) DO NOTHING` — barriera
  // per-entitlement. Zwraca id przy faktycznym INSERT; brak wiersza ⇒ no-op
  // (retry). `vat_classification` snapshotowany TU (kolumna z migracji 3.2).
  const insert = await client.query<{ id: string }>(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
        state, policy_snapshot, market_id, sales_channel_id, vat_classification,
        entitlement_dedupe_key, recipient_index, recipient_customer_id,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $14)
     ${ENTITLEMENT_DEDUPE_ON_CONFLICT_CLAUSE}
     RETURNING id`,
    [
      entitlementId,
      profile.profile_id,
      profile.entitlement_type,
      payload.order_id,
      lineItemId,
      EntitlementInstanceState.ISSUED,
      JSON.stringify(snapshot),
      ctx.marketId,
      ctx.salesChannelId,
      vatClassification,
      dedupeKey,
      recipient.recipient_index,
      recipient.recipient_customer_id,
      now,
    ]
  )

  const created = (insert.rowCount ?? insert.rows.length) > 0
  return {
    entitlement_id: insert.rows[0]?.id ?? entitlementId,
    entitlement_dedupe_key: dedupeKey,
    line_item_id: lineItemId,
    recipient_index: recipient.recipient_index,
    recipient_customer_id: recipient.recipient_customer_id,
    vat_classification: vatClassification,
    created,
  }
}

/** Deterministyczny id entitlementu z klucza dedupe (stabilny przy retry). */
function buildIssuedEntitlementId(dedupeKey: string): string {
  return `ent_${dedupeKey.slice(0, 24)}`
}

type ResolvedProfile = {
  profile_id: string
  entitlement_type: string
  policy: Record<string, unknown>
  currency?: string
  amount_minor?: number
}

/** Wyciąga profil entitlementu z immutable line-item metadata. */
function extractProfile(
  metadata: Record<string, unknown> | null | undefined,
  payload: PaymentIntentSucceededPayload
): ResolvedProfile | null {
  if (!metadata || typeof metadata !== "object") return null

  const embedded = (metadata as Record<string, unknown>).entitlement_profile
  if (isProfileShape(embedded)) {
    return normalizeProfile(embedded, payload)
  }

  const profile_id =
    readString((metadata as Record<string, unknown>).entitlement_profile_id) ??
    readString((metadata as Record<string, unknown>).profile_id)
  const entitlement_type = readString(
    (metadata as Record<string, unknown>).entitlement_type
  )
  const policy =
    readObject((metadata as Record<string, unknown>).entitlement_policy) ??
    readObject((metadata as Record<string, unknown>).policy)
  if (!profile_id || !entitlement_type || !policy) return null

  return {
    profile_id,
    entitlement_type,
    policy,
    currency: readString((metadata as Record<string, unknown>).currency),
    amount_minor: readNumber((metadata as Record<string, unknown>).amount_minor),
  }
}

function normalizeProfile(
  value: Record<string, unknown>,
  _payload: PaymentIntentSucceededPayload
): ResolvedProfile {
  return {
    profile_id: readString(value.profile_id)!,
    entitlement_type: readString(value.entitlement_type)!,
    policy: readObject(value.policy)!,
    currency: readString(value.currency),
    amount_minor: readNumber(value.amount_minor),
  }
}

function isProfileShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return Boolean(
    readString(record.profile_id) &&
      readString(record.entitlement_type) &&
      readObject(record.policy)
  )
}

/**
 * Recipienci zamrożeni w line-item metadata (immutable, precondition ADR-137).
 * `metadata.recipients` (array) ⇒ jeden entitlement per recipient z deterministycznym
 * `recipient_index` (kolejność zamrożona). Brak/pusta lista ⇒ pojedynczy recipient
 * (kupujący/bearer) z `recipient_index = 0`. To realizuje FR10 (jeden zakup ⇒
 * wiele entitlementów per-recipient).
 */
function extractFrozenRecipients(
  metadata: Record<string, unknown> | null | undefined
): FrozenRecipient[] {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.recipients
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((entry, index) => ({
      recipient_index: index,
      recipient_customer_id: extractRecipientCustomerId(entry),
    }))
  }
  // Brak listy ⇒ kupujący jako jedyny recipient (bearer), index 0.
  return [{ recipient_index: 0, recipient_customer_id: null }]
}

function extractRecipientCustomerId(entry: unknown): string | null {
  if (typeof entry === "string") {
    return readString(entry) ?? null
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>
    return (
      readString(record.recipient_customer_id) ??
      readString(record.customer_id) ??
      readString(record.id) ??
      null
    )
  }
  return null
}

/** VAT-rate evidence z policy (cart/profile) — wejście resolvera 2.2. */
function extractVatRates(
  policy: Record<string, unknown>
): readonly unknown[] | null {
  const rates = policy.vat_rates
  return Array.isArray(rates) ? rates : null
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readNestedString(
  source: Record<string, unknown> | null | undefined,
  pathSegments: string[]
): string | undefined {
  let current: unknown = source
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return readString(current)
}

/**
 * Re-eksport `EVENT_PROCESSED_TABLE` na potrzeby asercji testowych writer-a
 * (spójność nazwy tabeli event-level dedupe między warstwą danych a writerem).
 */
export { EVENT_PROCESSED_TABLE }

/**
 * Stabilny hash materiału — pomocniczy eksport (np. korelacja logów). Pełny
 * digest, spójny z polityką L-2 (bez truncacji w kluczu dedupe).
 */
export function liveIssueTraceHash(material: string): string {
  return createHash("sha256").update(material).digest("hex")
}
