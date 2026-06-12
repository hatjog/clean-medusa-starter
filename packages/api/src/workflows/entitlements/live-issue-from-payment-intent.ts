import { createHash } from "node:crypto"

import {
  EntitlementInstanceState,
  EntitlementType,
  isActiveEntitlementType,
  isEntitlementType,
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
import { VoucherPostingInvariantError } from "../../modules/voucher/posting-profile"

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
 *   2. Czyta recipientów + profil z line-item metadata. ŹRÓDŁO ZAMROŻENIA (finding
 *      L-2): NIE payload płatności (envelope niesie wyłącznie payment_intent_id /
 *      order_id / currency / amount_minor / psp_occurred_at), lecz IMMUTABLE
 *      `order_line_item.metadata` czytane z bieżącego stanu DB. Determinizm
 *      `recipient_index`/`dedupe_key` opiera się na PRECONDITION ADR-137: metadata
 *      linii (profil + recipients) jest NIEMUTOWALNA po `payment_intent.succeeded`.
 *      Ścieżka redemption/refund/edycji metadata NIE mutuje tych pól (regulamin § 12).
 *      C1 (DEFEROWANY, odgrodzony fail-loud): model „N recipientów na TEJ SAMEJ
 *      linii" jest scope-narrowed. Linia z >1 recipientem ⇒ FAIL-LOUD przed INSERT
 *      (kolidowałaby z ZACHOWANYM partial UNIQUE `(order_id, line_item_id)` z v1.9.0
 *      H-6 ⇒ poison-retry). FR10 realizujemy przez RÓŻNE linie (1 recipient/linia).
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

type ChoiceSetSnapshotItem = {
  item_key: string
  label: string | null
  reference_amount_minor: number
  vat_classification: VatClassification
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
      // H2 (silent-failure na ścieżce finansowej): rozróżnij "linia non-voucher
      // (legalne pominięcie)" od "linia voucherowa bez kompletnego profilu
      // (anomalia)". Voucher-intent (metadata niesie KTÓRYKOLWIEK marker
      // entitlement) BEZ kompletnego profilu ⇒ FAIL-LOUD: rzut wycofuje CAŁĄ tx
      // (w tym `event_processed`), więc Medusa ponawia event / kieruje do DLQ.
      // NIGDY cichy `processed` z zero entitlementów na OPŁACONEJ linii voucherowej
      // (to byłaby utrata realizacji opłaconej usługi — silent financial loss).
      if (hasVoucherIntent(line.metadata)) {
        throw new Error(
          `liveIssueEntitlementsWithinTx: linia voucherowa ${line.line_item_id} ` +
            `(payment_intent ${payload.payment_intent_id}) niesie markery entitlement, ` +
            `ale profil jest NIEKOMPLETNY (brak profile_id/entitlement_type/policy) — ` +
            `fail-loud (retry/DLQ), NIE ciche pominięcie`
        )
      }
      continue // linia faktycznie non-voucher (zero markerów) — legalne pominięcie
    }

    // L4: entitlement_type MUSI być znanym, AKTYWNYM typem PRZED INSERT — zła
    // wartość inaczej rzuca check_violation w DB ⇒ rollback ⇒ poison-retry. Tu
    // fail-closed z czytelnym komunikatem (nieznany typ poza taksonomią ADR-099
    // ALBO nieaktywny np. SUBSCRIPTION_B2C hard-gate ⇒ odrzut).
    assertIssuableEntitlementType(profile.entitlement_type, line.line_item_id, payload)

    // H1 (deferred-from-3.2): live-issue MUSI nieść sales_channel_id — fail-loud
    // gdy nierozwiązywalny (NIE `null` silent). Brak źródła ⇒ błąd + retry, NIE
    // wystawienie z `sales_channel_id = NULL` (cicha luka izolacji per-channel,
    // NFR3). Egzekwowane PRZED INSERT (spójnie z CHECK migracji 1778928300000).
    const resolvedSalesChannelId = assertScopeResolved(
      salesChannelId,
      "sales_channel_id",
      line.line_item_id,
      payload
    )

    // M2: `market_id` wymagany — defense-in-depth (subscriber waliduje
    // `scope.market_id` PRZED tx; tu last-resort dla writer-direct/replay).
    // Fail-loud PRZED INSERT zamiast poison-retry na `market_scope_chk` w pętli.
    const resolvedMarketId = assertScopeResolved(
      marketId,
      "market_id",
      line.line_item_id,
      payload
    )

    const recipients = extractFrozenRecipients(line.metadata)

    // C1 (multi-recipient-per-line) — ODGRODZENIE FAIL-LOUD (model świadomie deferowany).
    // Pełna obsługa „N recipientów na TEJ SAMEJ linii ⇒ N entitlementów" jest
    // scope-narrowed przy integracji epiku. Powód twardy: ZACHOWANY (v1.9.0 H-6)
    // partial UNIQUE `entitlement_instance_order_line_uniq_idx (order_id, line_item_id)`
    // (migracja `1778925500000`) dopuszcza JEDEN wiersz na (order_id, line_item_id).
    // N INSERT-ów z identycznym (order_id, line_item_id), różniących się tylko
    // `recipient_index`/`entitlement_dedupe_key`, naruszyłby ten index na realnym PG
    // (`ON CONFLICT (entitlement_dedupe_key)` NIE przechwytuje kolizji na INNEJ kolumnie)
    // ⇒ `unique_violation` ⇒ ROLLBACK całej tx ⇒ `event_processed` cofnięty ⇒
    // poison-retry na OPŁACONEJ płatności (utrata realizacji opłaconej usługi).
    // Zamiast CICHO wejść w tę ścieżkę (silent finance-bug), fail-loud PRZED
    // jakimkolwiek INSERT: czytelny błąd ⇒ tx rollback ⇒ event ponawiany/DLQ/alarm.
    // FR10 happy-path (N recipientów na RÓŻNYCH liniach = różny `line_item_id`)
    // działa normalnie — każda linia to osobny (order_id, line_item_id).
    if (recipients.length > 1) {
      throw new Error(
        `liveIssueEntitlementsWithinTx: multi-recipient-per-line NIEOBSŁUGIWANY ` +
          `(C1 deferowany) — linia ${line.line_item_id} (order ${payload.order_id}, ` +
          `payment_intent ${payload.payment_intent_id}) niesie ${recipients.length} ` +
          `recipientów na JEDNEJ linii, co naruszyłoby partial UNIQUE ` +
          `entitlement_instance_order_line_uniq_idx (order_id, line_item_id) na realnym PG. ` +
          `Fail-loud przed INSERT (retry/DLQ/alarm), NIE cicha kolizja/poison-retry. ` +
          `FR10: jeden recipient per line_item (osobna linia per obdarowany).`
      )
    }

    for (const recipient of recipients) {
      const issuedRow = await issueSingleIssuedRow(
        client,
        payload,
        scope,
        {
          lineItemId: line.line_item_id,
          recipient,
          profile,
          marketId: resolvedMarketId,
          salesChannelId: resolvedSalesChannelId,
        },
        now
      )
      issued.push(issuedRow)
    }
  }

  return { event_processed: true, issued }
}

/**
 * Markery "voucher-intent" w line-item metadata (H2). Obecność KTÓREGOKOLWIEK
 * oznacza, że linia MIAŁA być voucherem — brak kompletnego profilu to anomalia
 * (fail-loud), nie legalne pominięcie. Linia bez żadnego markera = faktyczny
 * non-voucher SKU (pomijana cicho — poprawnie).
 */
const VOUCHER_INTENT_KEYS = [
  "entitlement_profile",
  "entitlement_profile_id",
  "profile_id",
  "entitlement_type",
  "entitlement_policy",
  "recipients",
] as const

function hasVoucherIntent(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  if (!metadata || typeof metadata !== "object") return false
  return VOUCHER_INTENT_KEYS.some(
    (k) => (metadata as Record<string, unknown>)[k] != null
  )
}

/**
 * Walidacja typu entitlementu względem taksonomii (L4). Nieznany (poza enumem
 * ADR-099) LUB nieaktywny (poza `ACTIVE_ENTITLEMENT_TYPES`, np. hard-gate
 * SUBSCRIPTION_B2C) ⇒ fail-closed PRZED INSERT, NIE poison-retry na check_violation.
 */
function assertIssuableEntitlementType(
  entitlementType: string,
  lineItemId: string,
  payload: PaymentIntentSucceededPayload
): void {
  if (!isEntitlementType(entitlementType)) {
    throw new Error(
      `liveIssueEntitlementsWithinTx: nieznany entitlement_type "${entitlementType}" ` +
        `(linia ${lineItemId}, payment_intent ${payload.payment_intent_id}) — odrzucony ` +
        `fail-closed przed INSERT (poza taksonomią ADR-099)`
    )
  }
  if (!isActiveEntitlementType(entitlementType as EntitlementType)) {
    throw new Error(
      `liveIssueEntitlementsWithinTx: entitlement_type "${entitlementType}" jest NIEAKTYWNY ` +
        `(linia ${lineItemId}, payment_intent ${payload.payment_intent_id}) — live-issue ` +
        `dozwolony wyłącznie dla aktywnych typów (bonbeauty SPV/MPV); hard-gate'y ` +
        `(np. SUBSCRIPTION_B2C) pozostają zamknięte`
    )
  }
}

/**
 * Fail-loud na nierozwiązany komponent scope (H1 `sales_channel_id` / M2
 * `market_id`) PRZED INSERT. Zwraca niepustą wartość lub rzuca — eliminuje
 * zapis z `NULL`/pustym scope (poison-retry na constraint w pętli, NFR3).
 */
function assertScopeResolved(
  value: string | null,
  field: "market_id" | "sales_channel_id",
  lineItemId: string,
  payload: PaymentIntentSucceededPayload
): string {
  const resolved = readString(value)
  if (!resolved) {
    throw new Error(
      `liveIssueEntitlementsWithinTx: ${field} nierozwiązywalny na ścieżce live ` +
        `(linia ${lineItemId}, order ${payload.order_id}, payment_intent ` +
        `${payload.payment_intent_id}) — fail-loud przed INSERT (retry), NIE zapis ` +
        `z null (NFR3 fail-closed izolacja)`
    )
  }
  return resolved
}

type IssueRowContext = {
  lineItemId: string
  recipient: FrozenRecipient
  profile: ResolvedProfile
  // H1/M2: rozwiązane fail-loud PRZED wejściem tu (niepuste, nigdy null).
  marketId: string
  salesChannelId: string
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
  const choiceSetItems = extractChoiceSetSnapshotItems(profile, vatClassification)
  const referencePriceMinor = computeReferencePriceMinor(
    profile,
    payload,
    choiceSetItems,
    lineItemId
  )
  assertReferencePriceInvariant(
    profile,
    referencePriceMinor,
    choiceSetItems,
    lineItemId,
    payload
  )

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
        reference_price_minor, entitlement_dedupe_key, recipient_index, recipient_customer_id,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $15)
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
      referencePriceMinor,
      dedupeKey,
      recipient.recipient_index,
      recipient.recipient_customer_id,
      now,
    ]
  )

  const created = (insert.rowCount ?? insert.rows.length) > 0
  if (created && choiceSetItems.length > 0) {
    await insertChoiceSetItems(client, entitlementId, ctx.marketId, choiceSetItems, now)
  }

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

function computeReferencePriceMinor(
  profile: ResolvedProfile,
  payload: PaymentIntentSucceededPayload,
  choiceSetItems: ChoiceSetSnapshotItem[],
  lineItemId: string
): number | null {
  if (profile.entitlement_type === EntitlementType.CREDIT_PACK) {
    return assertPositiveIntegerMinor(
      profile.amount_minor ??
        readNumber(profile.policy.face_value_minor) ??
        readNumber(profile.policy.amount_minor) ??
        payload.amount_minor,
      `CREDIT_PACK face_value_minor/amount_minor (linia ${lineItemId})`
    )
  }

  if (profile.entitlement_type === EntitlementType.BUNDLE) {
    if (choiceSetItems.length === 0) {
      throw new VoucherPostingInvariantError(
        `liveIssueEntitlementsWithinTx: BUNDLE ${lineItemId} nie niesie choice_set — ` +
          `nie można zamrozić reference_price_minor zgodnie z ADR-140 §2`
      )
    }
    return choiceSetItems.reduce((sum, item) => sum + item.reference_amount_minor, 0)
  }

  return null
}

function assertReferencePriceInvariant(
  profile: ResolvedProfile,
  referencePriceMinor: number | null,
  choiceSetItems: ChoiceSetSnapshotItem[],
  lineItemId: string,
  payload: PaymentIntentSucceededPayload
): void {
  if (profile.entitlement_type === EntitlementType.CREDIT_PACK) {
    const faceValueMinor = assertPositiveIntegerMinor(
      profile.amount_minor ??
        readNumber(profile.policy.face_value_minor) ??
        readNumber(profile.policy.amount_minor) ??
        payload.amount_minor,
      `CREDIT_PACK face_value_minor/amount_minor (linia ${lineItemId})`
    )
    if (referencePriceMinor !== faceValueMinor) {
      throw new VoucherPostingInvariantError(
        `liveIssueEntitlementsWithinTx: invariant CREDIT_PACK naruszony dla linii ${lineItemId}: ` +
          `reference_price_minor=${referencePriceMinor}, face_value_minor=${faceValueMinor}`
      )
    }
  }

  if (profile.entitlement_type === EntitlementType.BUNDLE) {
    const sum = choiceSetItems.reduce((acc, item) => acc + item.reference_amount_minor, 0)
    if (referencePriceMinor !== sum) {
      throw new VoucherPostingInvariantError(
        `liveIssueEntitlementsWithinTx: invariant BUNDLE naruszony dla linii ${lineItemId}: ` +
          `reference_price_minor=${referencePriceMinor}, SUM(choice_set)=${sum}`
      )
    }
  }
}

async function insertChoiceSetItems(
  client: LiveIssuePgClient,
  entitlementId: string,
  marketId: string,
  items: ChoiceSetSnapshotItem[],
  now: Date
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    await client.query(
      `INSERT INTO entitlement_choice_set_item
         (id, instance_id, market_id, label, reference_amount_minor,
          remaining_minor, vat_classification, status, redemption_id,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'ACTIVE', NULL, $7, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        buildChoiceSetItemId(entitlementId, item, index),
        entitlementId,
        marketId,
        item.label,
        item.reference_amount_minor,
        item.vat_classification,
        now,
      ]
    )
  }
}

function buildChoiceSetItemId(
  entitlementId: string,
  item: ChoiceSetSnapshotItem,
  index: number
): string {
  const digest = createHash("sha256")
    .update(entitlementId)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(item.item_key)
    .update("\0")
    .update(String(item.reference_amount_minor))
    .digest("hex")
  return `ecsi_${digest}`
}

/**
 * Deterministyczny id entitlementu z klucza dedupe (stabilny przy retry).
 * PEŁNY digest (finding L-1/L-2) — BEZ truncacji: id jest 1:1 z `dedupe_key`
 * (oba pełne sha256, 64 hex), więc dwa różne klucze NIE mogą skolidować na PK
 * przez wspólny 24-hex prefiks. Retry trafia w `ON CONFLICT (entitlement_dedupe_key)`
 * (no-op) ZANIM dojdzie do jakiejkolwiek kolizji PK.
 */
function buildIssuedEntitlementId(dedupeKey: string): string {
  return `ent_${dedupeKey}`
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
 * (kupujący/bearer) z `recipient_index = 0`.
 *
 * UWAGA (C1 deferowany): zwrócenie listy o długości >1 dla JEDNEJ linii jest
 * fail-loud-odgrodzone w `liveIssueEntitlementsWithinTx` (kolizja z partial UNIQUE
 * `(order_id, line_item_id)`). FR10 (jeden zakup ⇒ wiele entitlementów) realizujemy
 * przez RÓŻNE linie (1 recipient per `line_item_id`), nie przez N recipientów na
 * tej samej linii.
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

function extractChoiceSetSnapshotItems(
  profile: ResolvedProfile,
  fallbackVatClassification: VatClassification
): ChoiceSetSnapshotItem[] {
  if (profile.entitlement_type !== EntitlementType.BUNDLE) return []

  const raw =
    profile.policy.choice_set ??
    profile.policy.choice_set_items ??
    profile.policy.selected_choice_set ??
    profile.policy.items
  if (!Array.isArray(raw)) return []

  return raw.map((entry, index) => {
    const record = readObject(entry)
    if (!record) {
      throw new VoucherPostingInvariantError(
        `liveIssueEntitlementsWithinTx: BUNDLE choice_set[${index}] ma nieprawidłowy kształt`
      )
    }
    const referenceAmountMinor = assertPositiveIntegerMinor(
      readNumber(record.reference_amount_minor) ??
        readNumber(record.amount_minor) ??
        readNumber(record.face_value_minor),
      `BUNDLE choice_set[${index}].reference_amount_minor`
    )
    const vatClassification =
      readVatClassification(record.vat_classification) ??
      resolveVatClassification({
        vat_rate_uniqueness: record.vat_rate_uniqueness,
        ...(Array.isArray(record.vat_rates) ? { vat_rates: record.vat_rates } : {}),
      }) ??
      fallbackVatClassification

    return {
      item_key:
        readString(record.item_key) ??
        readString(record.id) ??
        readString(record.sku) ??
        String(index),
      label: readString(record.label) ?? readString(record.name) ?? null,
      reference_amount_minor: referenceAmountMinor,
      vat_classification: vatClassification,
    }
  })
}

function readVatClassification(value: unknown): VatClassification | undefined {
  return value === "SPV" || value === "MPV" ? value : undefined
}

function assertPositiveIntegerMinor(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new VoucherPostingInvariantError(
      `liveIssueEntitlementsWithinTx: ${field} musi być dodatnią liczbą całkowitą minor units`
    )
  }
  return value
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
