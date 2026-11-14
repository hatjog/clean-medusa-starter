import { createHash, randomUUID } from "node:crypto"

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
import { readDatabaseMinorIntegerStrict } from "../../lib/payment/numeric-minor"

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
 *   1. EVENT-LEVEL dedupe (ADR-166 amendment do DEC-5): INSERT do
 *      `event_processed` (external_id = `payment_intent_id:order_id`, event_type)
 *      `ON CONFLICT DO NOTHING`
 *      jako PIERWSZY krok transakcji. 0 affected ⇒ event już skonsumowany ⇒
 *      pomiń tworzenie entitlementów (replay/multi-replica = no-op).
 *   2. Czyta recipientów + profil z line-item metadata. Dla historycznych linii
 *      Mercur bez skopiowanego profilu używa `product.metadata.gp.entitlement_profile`,
 *      ale kwotę bierze ze snapshotu `order_line_item.unit_price`, nigdy z pełnej
 *      kwoty PaymentIntenta obejmującej wielu sellerów. Determinizm
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

/**
 * Story 8.4 (FR-16, AD-19, NFR-4) — zamknięty zbiór stanów wyniku pozycji.
 * Kontrakt: `specs/contracts/checkout/gift-line-issue-outcome.v1.md`.
 *   - `issued`         — co najmniej jeden entitlement linii powstał w TYM przebiegu;
 *   - `already_issued` — wszystkie entitlementy linii już istniały (dedupe no-op);
 *   - `not_voucher`    — linia bez żadnego markera entitlement (legalne pominięcie);
 *   - `failed`         — wystawienie linii zawiodło; `reason` jest NAZWANY.
 * Brak stanu domyślnego: każda linia zamówienia dostaje DOKŁADNIE jeden wpis.
 */
export const LINE_ISSUE_STATES = ["issued", "already_issued", "not_voucher", "failed"] as const
export type LineIssueState = (typeof LINE_ISSUE_STATES)[number]

/** Zamknięty zbiór nazwanych przyczyn porażki pozycji (bez wartości domyślnej). */
export const LINE_ISSUE_FAILURE_REASONS = [
  "incomplete_voucher_profile",
  "entitlement_type_not_issuable",
  "scope_unresolved",
  "multi_recipient_per_line",
  "posting_invariant_violated",
  "issue_write_failed",
] as const
export type LineIssueFailureReason = (typeof LINE_ISSUE_FAILURE_REASONS)[number]

export type LineIssueOutcome =
  | {
      line_item_id: string
      state: "issued" | "already_issued"
      entitlements: LiveIssuedEntitlement[]
    }
  | { line_item_id: string; state: "not_voucher" }
  | {
      line_item_id: string
      state: "failed"
      reason: LineIssueFailureReason
      error_message: string
    }

/**
 * Wynik trybu izolacji per linia. `event_processed` = event SKONSUMOWANY przez
 * ten przebieg (wiersz `event_processed` zapisany). Przy częściowej porażce event
 * NIE jest konsumowany (wiersz wycofany do savepointu), więc ponowna dostawa
 * wraca do linii nieudanych, a linie udane są no-opem (`already_issued`).
 */
export type LiveIssuePerLineResult = LiveIssueResult & {
  line_outcomes: LineIssueOutcome[]
  failed_lines: Extract<LineIssueOutcome, { state: "failed" }>[]
}

/** Błąd pozycji z nazwaną przyczyną (klasyfikacja AC2 — bez domyślnej). */
export class LineIssueError extends Error {
  readonly reason: LineIssueFailureReason
  readonly line_item_id: string
  constructor(reason: LineIssueFailureReason, lineItemId: string, message: string) {
    super(message)
    this.name = "LineIssueError"
    this.reason = reason
    this.line_item_id = lineItemId
  }
}

/**
 * Częściowa porażka zakupu prezentowego (Story 8.4). Rzucana przez subscriber
 * PO commicie linii udanych, żeby Medusa ponowiła event (retry/DLQ) — niesie
 * pełny wynik per pozycja, nie zbiorczy komunikat.
 */
export class LiveIssuePartialFailureError extends Error {
  readonly line_outcomes: LineIssueOutcome[]
  readonly failed_lines: Extract<LineIssueOutcome, { state: "failed" }>[]
  constructor(paymentIntentId: string, orderId: string, result: LiveIssuePerLineResult) {
    super(
      `live-issue: częściowa porażka (payment_intent ${paymentIntentId}, order ${orderId}) — ` +
        `failed=${result.failed_lines.length}/${result.line_outcomes.length}: ` +
        result.failed_lines
          .map((f) => `${f.line_item_id}:${f.reason}`)
          .join(", ")
    )
    this.name = "LiveIssuePartialFailureError"
    this.line_outcomes = result.line_outcomes
    this.failed_lines = result.failed_lines
  }
}

/**
 * Klasyfikacja błędu linii do zamkniętego zbioru przyczyn. Każdy błąd spoza
 * nazwanych klas trafia do `issue_write_failed` z zachowanym komunikatem —
 * to nazwana przyczyna („zapis linii zawiódł”), nie cichy fallback.
 */
function classifyLineError(err: unknown): LineIssueFailureReason {
  if (err instanceof LineIssueError) return err.reason
  if (err instanceof VoucherPostingInvariantError) return "posting_invariant_violated"
  return "issue_write_failed"
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** Nazwy savepointów (stałe — identyfikatory SQL, bez danych wejściowych). */
const SAVEPOINT_EVENT = "gp_live_issue_event"
const SAVEPOINT_LINE = "gp_live_issue_line"

/** Surowy wiersz line-item z metadanymi (kształt jak w issue-entitlement.ts). */
type OrderLineRow = {
  line_item_id: string
  metadata: Record<string, unknown> | null
  product_metadata: Record<string, unknown> | null
  /** pg zwraca NUMERIC jako string; nie ufamy deklaracji TypeScript na granicy SQL. */
  line_unit_price: unknown
  /**
   * Dane sprzedawcy i tytuł usługi — nośnik `voucher.seller_*` / `product_title`
   * przy genezie kodu (patrz `issueVoucherCodeWithinTx`). Kolumny są NOT NULL w
   * `voucher`, więc brak któregokolwiek MUSI być widoczny, nie łatany pustym
   * stringiem: pusty „Salon" w mailu to dokładnie ten defekt, który tu domykamy.
   */
  line_title: string | null
  seller_id: string | null
  seller_name: string | null
  seller_handle: string | null
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
 * Jednostka konsumpcji biznesowej po ADR-166: jedno zdarzenie Stripe może
 * odpowiadać N zamówieniom Mercur (po jednym per seller), więc sam PI nie
 * wystarcza jako dedupe. Separator jest bezpieczny dla identyfikatorów Stripe/
 * Medusa i odpowiada semantyce klucza koperty (market jest w osobnym scope).
 */
export function buildPaymentIntentOrderExternalId(
  paymentIntentId: string,
  orderId: string
): string {
  return `${paymentIntentId}:${orderId}`
}

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
  // Tryb all-or-nothing (zachowanie sprzed Story 8.4, jawnie nazwane w
  // kontrakcie gift-line-issue-outcome.v1): pierwszy błąd linii rzuca ORYGINALNY
  // wyjątek ⇒ caller wycofuje CAŁĄ tx. Ścieżka produkcyjna Path Y (subscriber)
  // używa trybu izolacji `liveIssueEntitlementsPerLineWithinTx`.
  const result = await runLiveIssue(client, input, now, "all_or_nothing")
  return { event_processed: result.event_processed, issued: result.issued }
}

/**
 * Story 8.4 (FR-16, AD-19) — tryb izolacji per linia. Każda linia voucherowa
 * w osobnym SAVEPOINT: porażka linii cofa WYŁĄCZNIE jej zapisy, linie udane
 * zostają. Przy jakiejkolwiek porażce wiersz `event_processed` NIE zostaje
 * zapisany (rola runtime ma na nim tylko INSERT, więc cofnięcie idzie przez
 * savepoint sprzed INSERT-u i ponowne, idempotentne wystawienie linii udanych),
 * dzięki czemu retry eventu wraca do linii nieudanych. Caller MUSI po commicie
 * potraktować `failed_lines.length > 0` jako porażkę (fail-loud, retry/DLQ).
 */
export async function liveIssueEntitlementsPerLineWithinTx(
  client: LiveIssuePgClient,
  input: LiveIssueInput,
  now: Date
): Promise<LiveIssuePerLineResult> {
  const first = await runLiveIssue(client, input, now, "isolate_lines")
  // Replay (event-level no-op) — savepoint już zwolniony w runLiveIssue.
  if (!first.event_processed) return first
  if (first.failed_lines.length === 0) {
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_EVENT}`)
    return first
  }

  // Częściowa porażka: wycofaj CAŁY przebieg do savepointu sprzed INSERT-u
  // event_processed (event zostaje NIEskonsumowany), po czym wystaw ponownie
  // WYŁĄCZNIE linie, które się udały — bez zapisu event_processed.
  await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_EVENT}`)
  const succeeded = new Set(
    first.line_outcomes
      .filter((o) => o.state === "issued" || o.state === "already_issued")
      .map((o) => o.line_item_id)
  )
  const second = await runLiveIssue(client, input, now, "isolate_lines", {
    onlyLineIds: succeeded,
    skipEventInsert: true,
  })
  await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_EVENT}`)

  // Scal: wynik linii udanych z drugiego przebiegu (realny stan po rollbacku),
  // porażki z pierwszego; kolejność = kolejność linii zamówienia.
  const secondById = new Map(second.line_outcomes.map((o) => [o.line_item_id, o]))
  const line_outcomes: LineIssueOutcome[] = first.line_outcomes.map((o) =>
    succeeded.has(o.line_item_id) ? requireOutcome(secondById, o.line_item_id) : o
  )
  const failed_lines = line_outcomes.filter(
    (o): o is Extract<LineIssueOutcome, { state: "failed" }> => o.state === "failed"
  )
  return {
    event_processed: false,
    issued: second.issued,
    line_outcomes,
    failed_lines,
  }
}

function requireOutcome(
  byId: Map<string, LineIssueOutcome>,
  lineItemId: string
): LineIssueOutcome {
  const outcome = byId.get(lineItemId)
  if (!outcome) {
    throw new Error(
      `liveIssueEntitlementsPerLineWithinTx: brak wyniku linii ${lineItemId} w przebiegu ponownym`
    )
  }
  return outcome
}

type LiveIssueMode = "all_or_nothing" | "isolate_lines"

async function runLiveIssue(
  client: LiveIssuePgClient,
  input: LiveIssueInput,
  now: Date,
  mode: LiveIssueMode,
  options: { onlyLineIds?: ReadonlySet<string>; skipEventInsert?: boolean } = {}
): Promise<LiveIssuePerLineResult> {
  const { payload, scope, event_type } = input

  if (!payload.order_id) {
    // order_id NON-NULLABLE na ścieżce live (ADR-137 DEC pkt 2) — fail-loud.
    throw new Error(
      `liveIssueEntitlementsWithinTx: order_id wymagany na ścieżce live (payment_intent ${payload.payment_intent_id})`
    )
  }

  const dedupeMarketId = readString(scope.market_id)
  if (!dedupeMarketId) {
    throw new Error("liveIssueEntitlementsWithinTx: market_id nierozwiązywalny przed business dedupe")
  }
  const dedupeInstanceId = readString(scope.instance_id)
  if (!dedupeInstanceId) {
    throw new Error("liveIssueEntitlementsWithinTx: instance_id nierozwiązywalny przed business dedupe")
  }

  // ── (i) EVENT-LEVEL dedupe (DEC-5 pkt 3.i) — PIERWSZY krok transakcji ──────
  const dedupeInsert = buildEventProcessedDedupeInsert({
    instance_id: dedupeInstanceId,
    market_id: dedupeMarketId,
    external_id: buildPaymentIntentOrderExternalId(
      payload.payment_intent_id,
      payload.order_id
    ),
    event_type,
    processed_at: now.getTime(),
    // Klucz zakupu (AD-16 / ADR-190): `payment_intent_id` na KAŻDYM wierszu
    // pętli, więc N wystawień jednego zakupu koreluje się po kolumnie zamiast
    // przez parsowanie `external_id` po separatorze.
    purchase_key: payload.payment_intent_id,
  })
  if (!options.skipEventInsert) {
    if (mode === "isolate_lines") {
      await client.query(`SAVEPOINT ${SAVEPOINT_EVENT}`)
    }
    const dedupe = await client.query(dedupeInsert.sql, dedupeInsert.params)
    if ((dedupe.rowCount ?? 0) === 0) {
      // event już skonsumowany (retry webhooka / multi-replica) ⇒ no-op.
      if (mode === "isolate_lines") {
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_EVENT}`)
      }
      return { event_processed: false, issued: [], line_outcomes: [], failed_lines: [] }
    }
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

  // ── voucher line items (snapshot linii + fallback profilu katalogowego) ─────
  const lines = await client.query<OrderLineRow>(
    `SELECT oli.id AS line_item_id,
            oli.metadata,
            p.metadata AS product_metadata,
            oli.unit_price AS line_unit_price,
            COALESCE(oli.title, p.title) AS line_title,
            s.id     AS seller_id,
            s.name   AS seller_name,
            s.handle AS seller_handle
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
       LEFT JOIN product p
         ON p.id = oli.product_id
       LEFT JOIN product_product_seller_seller pss
         ON pss.product_id = oli.product_id
        AND pss.deleted_at IS NULL
       LEFT JOIN seller s
         ON s.id = pss.seller_id
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
      ORDER BY oi.created_at ASC`,
    [payload.order_id]
  )

  const issued: LiveIssuedEntitlement[] = []
  const line_outcomes: LineIssueOutcome[] = []

  for (const line of lines.rows) {
    if (options.onlyLineIds && !options.onlyLineIds.has(line.line_item_id)) continue
    if (mode === "all_or_nothing") {
      const outcome = await issueOrderLine(client, line, payload, scope, salesChannelId, marketId, now)
      line_outcomes.push(outcome)
      if (outcome.state === "issued" || outcome.state === "already_issued") {
        issued.push(...outcome.entitlements)
      }
      continue
    }
    // isolate_lines: SAVEPOINT per linia — porażka cofa tylko zapisy TEJ linii.
    await client.query(`SAVEPOINT ${SAVEPOINT_LINE}`)
    try {
      const outcome = await issueOrderLine(client, line, payload, scope, salesChannelId, marketId, now)
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_LINE}`)
      line_outcomes.push(outcome)
      if (outcome.state === "issued" || outcome.state === "already_issued") {
        issued.push(...outcome.entitlements)
      }
    } catch (err) {
      // NFR-4: catch MA skutek — cofnięcie zapisów linii + nazwany stan `failed`
      // z przyczyną z zamkniętego zbioru; caller rzuca po commicie (retry/DLQ).
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_LINE}`)
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_LINE}`)
      line_outcomes.push({
        line_item_id: line.line_item_id,
        state: "failed",
        reason: classifyLineError(err),
        error_message: errorMessage(err),
      })
    }
  }

  const failed_lines = line_outcomes.filter(
    (o): o is Extract<LineIssueOutcome, { state: "failed" }> => o.state === "failed"
  )
  return { event_processed: !options.skipEventInsert, issued, line_outcomes, failed_lines }
}

/**
 * Wystawienie JEDNEJ linii zamówienia (Story 8.4: wyodrębnione z pętli, żeby
 * tryb izolacji mógł objąć linię savepointem). Rzuca `LineIssueError` z nazwaną
 * przyczyną; zwraca wynik linii z zamkniętego zbioru stanów.
 */
async function issueOrderLine(
  client: LiveIssuePgClient,
  line: OrderLineRow,
  payload: PaymentIntentSucceededPayload,
  scope: LiveIssueScope,
  salesChannelId: string | null,
  marketId: string | null,
  now: Date
): Promise<LineIssueOutcome> {
  {
    const profile =
      extractProfile(line.metadata, payload) ??
      extractProductProfile(line.product_metadata, payload)
    if (!profile) {
      // H2 (silent-failure na ścieżce finansowej): rozróżnij "linia non-voucher
      // (legalne pominięcie)" od "linia voucherowa bez kompletnego profilu
      // (anomalia)". Voucher-intent (metadata niesie KTÓRYKOLWIEK marker
      // entitlement) BEZ kompletnego profilu ⇒ FAIL-LOUD: rzut wycofuje CAŁĄ tx
      // (w tym `event_processed`), więc Medusa ponawia event / kieruje do DLQ.
      // NIGDY cichy `processed` z zero entitlementów na OPŁACONEJ linii voucherowej
      // (to byłaby utrata realizacji opłaconej usługi — silent financial loss).
      if (
        hasVoucherIntent(line.metadata) ||
        hasProductVoucherIntent(line.product_metadata)
      ) {
        throw new LineIssueError(
          "incomplete_voucher_profile",
          line.line_item_id,
          `liveIssueEntitlementsWithinTx: linia voucherowa ${line.line_item_id} ` +
            `(payment_intent ${payload.payment_intent_id}) niesie markery entitlement ` +
            `w linii albo produkcie, ale profil jest NIEKOMPLETNY ` +
            `(brak profile_id/entitlement_type/policy) — ` +
            `fail-loud (retry/DLQ), NIE ciche pominięcie`
        )
      }
      // linia faktycznie non-voucher (zero markerów) — legalne pominięcie, ale
      // z JAWNYM stanem (AC2: żadna pozycja bez stanu).
      return { line_item_id: line.line_item_id, state: "not_voucher" }
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
      throw new LineIssueError(
        "multi_recipient_per_line",
        line.line_item_id,
        `liveIssueEntitlementsWithinTx: multi-recipient-per-line NIEOBSŁUGIWANY ` +
          `(C1 deferowany) — linia ${line.line_item_id} (order ${payload.order_id}, ` +
          `payment_intent ${payload.payment_intent_id}) niesie ${recipients.length} ` +
          `recipientów na JEDNEJ linii, co naruszyłoby partial UNIQUE ` +
          `entitlement_instance_order_line_uniq_idx (order_id, line_item_id) na realnym PG. ` +
          `Fail-loud przed INSERT (retry/DLQ/alarm), NIE cicha kolizja/poison-retry. ` +
          `FR10: jeden recipient per line_item (osobna linia per obdarowany).`
      )
    }

    const lineIssued: LiveIssuedEntitlement[] = []
    for (const recipient of recipients) {
      const issuedRow = await issueSingleIssuedRow(
        client,
        payload,
        scope,
        {
          lineItemId: line.line_item_id,
          recipient,
          profile,
          voucherAmountMinor:
            profile.amount_minor ?? readDatabaseNumber(line.line_unit_price),
          marketId: resolvedMarketId,
          salesChannelId: resolvedSalesChannelId,
          lineTitle: line.line_title,
          sellerId: line.seller_id,
          sellerName: line.seller_name,
          sellerHandle: line.seller_handle,
        },
        now
      )
      lineIssued.push(issuedRow)
    }
    if (lineIssued.length === 0) {
      // Linia voucherowa bez recipientów nie może dać stanu „pustego sukcesu”.
      throw new LineIssueError(
        "incomplete_voucher_profile",
        line.line_item_id,
        `liveIssueEntitlementsWithinTx: linia voucherowa ${line.line_item_id} nie dała żadnego entitlementu`
      )
    }
    return {
      line_item_id: line.line_item_id,
      state: lineIssued.some((e) => e.created) ? "issued" : "already_issued",
      entitlements: lineIssued,
    }
  }
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

function hasProductVoucherIntent(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  const gp = readObject(metadata?.gp)
  return gp?.entitlement_profile != null
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
    throw new LineIssueError(
      "entitlement_type_not_issuable",
      lineItemId,
      `liveIssueEntitlementsWithinTx: nieznany entitlement_type "${entitlementType}" ` +
        `(linia ${lineItemId}, payment_intent ${payload.payment_intent_id}) — odrzucony ` +
        `fail-closed przed INSERT (poza taksonomią ADR-099)`
    )
  }
  if (!isActiveEntitlementType(entitlementType as EntitlementType)) {
    throw new LineIssueError(
      "entitlement_type_not_issuable",
      lineItemId,
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
    throw new LineIssueError(
      "scope_unresolved",
      lineItemId,
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
  /** Cena linii SQL; tylko dla snapshotu voucherowego, nigdy dla face value CREDIT_PACK. */
  voucherAmountMinor: number | undefined
  // H1/M2: rozwiązane fail-loud PRZED wejściem tu (niepuste, nigdy null).
  marketId: string
  salesChannelId: string
  /** Nośniki `voucher.*` NOT NULL — patrz `issueVoucherCodeWithinTx`. */
  lineTitle: string | null
  sellerId: string | null
  sellerName: string | null
  sellerHandle: string | null
}

/**
 * Alfabet kodu vouchera BEZ znaków dwuznacznych (0/O, 1/I/L). Kod bywa
 * przepisywany z ekranu telefonu albo dyktowany przez telefon w salonie, więc
 * `0` nieodróżnialne od `O` to realny koszt obsługi, nie estetyka.
 */
const VOUCHER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

/**
 * Kod vouchera jest DETERMINISTYCZNY z `entitlement_dedupe_key`.
 *
 * Ścieżka webhooka jest ponawialna (Stripe retry, DLQ, `stripe events resend`),
 * a `voucher.code` jest kluczem głównym. Losowy kod przy ponowieniu albo
 * wywróciłby transakcję na kolizji, albo — gorzej — wydał DRUGI kod na to samo
 * opłacone wydanie. Wyprowadzenie z klucza dedupe daje idempotencję za darmo:
 * ten sam entitlement zawsze wskazuje ten sam kod, a `ON CONFLICT DO NOTHING`
 * czyni powtórzony INSERT no-opem.
 */
export function buildVoucherCode(dedupeKey: string, marketId: string): string {
  const prefix = (marketId.toUpperCase().replace(/[^A-Z0-9]/g, "") + "XX").slice(0, 2)
  const digest = createHash("sha256").update(`voucher-code:${dedupeKey}`).digest()
  let body = ""
  for (let i = 0; i < 8; i += 1) {
    body += VOUCHER_CODE_ALPHABET[digest[i] % VOUCHER_CODE_ALPHABET.length]
  }
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`
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
  const referencePriceMinor = computeReferencePriceMinor(profile, choiceSetItems, lineItemId)
  // Asercja invariantu z niezależnymi wyroczniami (ADR-140 §2, M1-fix):
  //   - CREDIT_PACK oracle = face_value z policy/profilu (resolveCreditPackFaceValueMinor,
  //     inna ścieżka niż compute — resolvuje wyłącznie z policy, bez payload fallbacku).
  //   - BUNDLE oracle = lista `reference_amount_minor` z przygotowanych wierszy choice_set
  //     (tablica itemAmounts zbudowana niezależnie, nie ta sama zmienna co choiceSetItems.reduce).
  const creditPackOracle =
    profile.entitlement_type === EntitlementType.CREDIT_PACK
      ? resolveCreditPackFaceValueMinor(profile, lineItemId)
      : undefined
  const bundleAmountsOracle =
    profile.entitlement_type === EntitlementType.BUNDLE
      ? choiceSetItems.map((item) => item.reference_amount_minor)
      : undefined
  assertReferencePriceInvariant(profile.entitlement_type as EntitlementType, referencePriceMinor, lineItemId, {
    faceValueMinor: creditPackOracle,
    itemAmounts: bundleAmountsOracle,
  })

  // ── snapshot policy (regulamin § 12 — immutable post-ISSUED) ───────────────
  // `amount_minor` jest wartością finansową entitlementu, nie faktem PSP.
  // Brak ceny profilu/linii to anomalia danych: pełna kwota PI mogłaby obejmować
  // inne zamówienia (ADR-166 pkt 8), więc fallback jest zakazany.
  const amountMinor = assertPositiveIntegerMinor(
    ctx.voucherAmountMinor,
    `amount_minor vouchera (linia ${lineItemId})`
  )
  // ── geneza kodu vouchera (Story 5.3, korekta PO 2026-07-30) ───────────────
  // Kod POWSTAJE przy wystawieniu i wchodzi do snapshotu polityki, bo snapshot
  // jest immutable po ISSUED — to czyni kod trwałym faktem wydania, a nie
  // wartością doklejaną później. Wcześniej kodu nie było wcale, a warstwa
  // odczytu (`findBuyerClaimSource`) podstawiała identyfikator entitlementu,
  // przez co kupujący dostawał w mailu `ent_…` zamiast kodu do okazania.
  const voucherCode = buildVoucherCode(dedupeKey, ctx.marketId)
  const currency = profile.currency ?? payload.currency
  const snapshot: EntitlementPolicySnapshot = snapshotPolicy({
    ...profile.policy,
    currency,
    amount_minor: amountMinor,
    voucher_code: voucherCode,
    source_payment_intent_id: payload.payment_intent_id,
    line_item_id: lineItemId,
    recipient_index: recipient.recipient_index,
  })

  const entitlementId = buildIssuedEntitlementId(dedupeKey)
  const validityEnd = computeValidityEnd(now, readNumber(snapshot.validity_months))
  const claimToken = randomUUID()

  // INSERT ISSUED `ON CONFLICT (entitlement_dedupe_key) DO NOTHING` — barriera
  // per-entitlement. Zwraca id przy faktycznym INSERT; brak wiersza ⇒ no-op
  // (retry). `vat_classification` snapshotowany TU (kolumna z migracji 3.2).
  const insert = await client.query<{ id: string }>(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
        state, policy_snapshot, market_id, sales_channel_id, vat_classification,
        reference_price_minor, entitlement_dedupe_key, recipient_index, recipient_customer_id,
        claim_token, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $17, $16, $16)
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
      claimToken,
      now,
      // v1.15.0 Story 5.9 review-fix (HIGH-2): termin ważności zapisany TAKŻE
      // na uprawnieniu — to on steruje sweeperem wygaszeń, a więc i zejściem
      // stanu kodu. Wyliczany tą samą funkcją, co `voucher.expires_at`.
      validityEnd,
    ]
  )

  const created = (insert.rowCount ?? insert.rows.length) > 0
  if (created && choiceSetItems.length > 0) {
    await insertChoiceSetItems(client, entitlementId, ctx.marketId, choiceSetItems, now)
  }

  if (created) {
    await issueVoucherCodeWithinTx(client, {
      code: voucherCode,
      marketId: ctx.marketId,
      sellerId: ctx.sellerId,
      sellerName: ctx.sellerName,
      sellerHandle: ctx.sellerHandle,
      productTitle: ctx.lineTitle,
      valueMinor: amountMinor,
      currency,
      validityMonths: readNumber(snapshot.validity_months),
      lineItemId,
      context:
        `order ${payload.order_id}, payment_intent ${payload.payment_intent_id}`,
      now,
    })
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

/**
 * Rozwiązuje face_value_minor dla CREDIT_PACK wyłącznie z profilu/policy (bez
 * fallbacku do kwoty zapłaconej przez Stripe). ADR-140 §2: `reference_price_minor`
 * = face_value_minor — NIE kwota transakcji. Przy braku jawnej wartości rzuca
 * fail-closed (nieokreślony face_value to błąd konfiguracji, nie edge-case).
 */
function resolveCreditPackFaceValueMinor(
  profile: ResolvedProfile,
  lineItemId: string
): number {
  const resolved =
    profile.amount_minor ??
    readNumber(profile.policy.face_value_minor) ??
    readNumber(profile.policy.amount_minor)
  if (resolved === undefined || resolved === null) {
    throw new VoucherPostingInvariantError(
      `liveIssueEntitlementsWithinTx: CREDIT_PACK ${lineItemId} nie ma jawnego ` +
        `face_value_minor ani amount_minor w profilu/policy — nie można zamrozić ` +
        `reference_price_minor (fallback do kwoty Stripe payload narusza ADR-140 §2)`
    )
  }
  return assertPositiveIntegerMinor(
    resolved,
    `CREDIT_PACK face_value_minor/amount_minor (linia ${lineItemId})`
  )
}

function computeReferencePriceMinor(
  profile: ResolvedProfile,
  choiceSetItems: ChoiceSetSnapshotItem[],
  lineItemId: string
): number | null {
  if (profile.entitlement_type === EntitlementType.CREDIT_PACK) {
    return resolveCreditPackFaceValueMinor(profile, lineItemId)
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

/**
 * Asercja invariantu ADR-140 §2 — egzekwuje spójność zamrożonego snapshotu
 * względem niezależnie dostarczonych wartości oracle (fail-closed):
 *   - CREDIT_PACK: `referencePriceMinor` musi równać się `faceValueMinorOracle`
 *     (face_value z policy/profilu, rozwiązany niezależnie od `computeReferencePriceMinor`).
 *   - BUNDLE: `referencePriceMinor` musi równać się sumie `itemAmountsOracle`
 *     (lista `reference_amount_minor` z przygotowanych wierszy choice_set,
 *     dostarczona niezależnie od tablicy `choiceSetItems` użytej w compute).
 *
 * Eksportowana na potrzeby golden-testów niespójności (wywołanie z rozbieżnymi
 * wartościami oracle weryfikuje fail-closed bez round-tripu przez publiczne API).
 */
export function assertReferencePriceInvariant(
  entitlementType: EntitlementType,
  referencePriceMinor: number | null,
  lineItemId: string,
  oracle: { faceValueMinor?: number; itemAmounts?: readonly number[] }
): void {
  if (entitlementType === EntitlementType.CREDIT_PACK) {
    const faceValueMinor = oracle.faceValueMinor
    if (faceValueMinor === undefined) return // nie dostarczono oracle — brak weryfikacji
    if (referencePriceMinor !== faceValueMinor) {
      throw new VoucherPostingInvariantError(
        `liveIssueEntitlementsWithinTx: invariant CREDIT_PACK naruszony dla linii ${lineItemId}: ` +
          `reference_price_minor=${referencePriceMinor}, face_value_minor=${faceValueMinor}`
      )
    }
  }

  if (entitlementType === EntitlementType.BUNDLE) {
    const itemAmounts = oracle.itemAmounts
    if (!itemAmounts) return // nie dostarczono oracle — brak weryfikacji
    const sum = itemAmounts.reduce((acc, amt) => acc + amt, 0)
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

/**
 * Deterministyczny id wiersza choice_set (stabilny przy replay).
 *
 * I2: digest miesza `index` (pozycja w tablicy) i `item_key`. `index` jako
 * tie-breaker chroni przed kolizją gdy dwa items mają ten sam `item_key` (np.
 * zduplikowane linie w policy); przy jednorazowym issue kolejność tablicy
 * jest stała. Replay jest chroniony na poziomie entitlement-instance (`created=false`
 * ⇒ `insertChoiceSetItems` nie jest wywoływane — guard w `issueSingleIssuedRow`).
 */
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

function extractProductProfile(
  metadata: Record<string, unknown> | null | undefined,
  payload: PaymentIntentSucceededPayload
): ResolvedProfile | null {
  const embedded = readObject(readObject(metadata?.gp)?.entitlement_profile)
  if (!isProfileShape(embedded)) return null
  const profile = normalizeProfile(embedded, payload)
  return profile
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

  // L2-fix: czytamy wyłącznie jawne klucze choice_set — generyczny `items` usunięty,
  // bo koliduje z konwencją metadanych i mógłby omyłkowo serializować pozycje koszyka.
  const raw =
    profile.policy.choice_set ??
    profile.policy.choice_set_items ??
    profile.policy.selected_choice_set
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

/**
 * Zapisuje wiersz `voucher` — nośnik kodu okazywanego w salonie.
 *
 * Idempotencja: `ON CONFLICT (code) DO NOTHING`. Kod jest deterministyczny z
 * klucza dedupe, więc ponowienie webhooka trafia we WŁASNY wiersz, nigdy w cudzy.
 *
 * Fail-loud przy brakach: kolumny `seller_*` i `product_title` są NOT NULL, a
 * pusty string przeszedłby przez bazę i wyszedł do klienta jako mail z pustym
 * „Salon" — czyli dokładnie defekt, który ta funkcja domyka. Rzut wycofuje CAŁĄ
 * transakcję (w tym `event_processed`), więc zdarzenie wraca przez retry/DLQ z
 * czytelną przyczyną, zamiast utrwalać wydanie bez danych sprzedawcy.
 *
 * v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): funkcja jest EKSPORTOWANA
 * i wołana także przez ścieżkę `payment.captured`
 * (`workflows/entitlements/issue-entitlement.ts`). Powód jest pomiarem, nie
 * estetyką: gdyby tamta ścieżka dostała WŁASNY `INSERT INTO voucher`, rejestr
 * producentów (`redemption-producers.v2.yaml`) musiałby dostać drugi nazwany
 * wyjątek dla tabeli `voucher`, a dwa wyrażenia budujące ten sam wiersz
 * rozjechałyby się cicho — dokładnie ta klasa, którą 5.9 zamyka. `context`
 * zastąpił `payload`, bo wołający spoza Path Y nie ma `PaymentIntentSucceeded`.
 */
export async function issueVoucherCodeWithinTx(
  client: LiveIssuePgClient,
  args: {
    code: string
    marketId: string
    sellerId: string | null
    sellerName: string | null
    sellerHandle: string | null
    productTitle: string | null
    valueMinor: number
    currency: string
    validityMonths: number | undefined
    lineItemId: string
    /** Opis pochodzenia wydania — wchodzi WYŁĄCZNIE do komunikatu fail-loud. */
    context: string
    now: Date
  }
): Promise<void> {
  const sellerId = readString(args.sellerId)
  const sellerName = readString(args.sellerName)
  const sellerHandle = readString(args.sellerHandle)
  const productTitle = readString(args.productTitle)
  const missing = [
    ["seller_id", sellerId],
    ["seller_name", sellerName],
    ["seller_handle", sellerHandle],
    ["product_title", productTitle],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field)

  if (missing.length > 0) {
    throw new Error(
      `issueVoucherCodeWithinTx: brak wymaganych danych vouchera [${missing.join(", ")}] ` +
        `(linia ${args.lineItemId}, ${args.context}) — fail-loud przed INSERT. Zapis pustych ` +
        `wartości dałby kupującemu mail z pustym salonem i kodem bez pokrycia.`
    )
  }

  const expiresAt = computeValidityEnd(args.now, args.validityMonths)

  await client.query(
    `INSERT INTO voucher
       (code, market_id, seller_id, seller_name, seller_handle, product_title,
        value_minor, currency_code, status, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'idle', $9, $10, $10)
     ON CONFLICT (code) DO NOTHING`,
    [
      args.code,
      args.marketId,
      sellerId,
      sellerName,
      sellerHandle,
      productTitle,
      args.valueMinor,
      args.currency,
      expiresAt,
      args.now,
    ]
  )
}

/**
 * Koniec ważności wyliczony z `validity_months` — JEDNO miejsce dla OBU
 * nośników terminu (v1.15.0 Story 5.9 review-fix, HIGH-2).
 *
 * Do tego fixu termin trafiał WYŁĄCZNIE do `voucher.expires_at`, a
 * `entitlement_instance.expires_at` zostawało NULL-em (kolumny nie było na
 * liście INSERT-a). Dopóki stan kodu gasił bulk-UPDATE po `voucher.expires_at`,
 * nikt tego nie widział. Story 5.9 usunęła tamten zapis i przeniosła wygaszanie
 * na tranzycję uprawnienia, a sweeper bierze kandydatów po
 * `entitlement_instance.expires_at IS NOT NULL` — czyli od 5.9 voucher
 * wystawiony produkcyjną ścieżką Path Y NIGDY by nie wygasł: producent stanu
 * `expired` istniałby w kontrakcie i w bramce, a na realnej ścieżce nie
 * odpaliłby się ani razu. Dokładnie ta klasa defektu, którą story usuwa.
 *
 * Dwa nośniki terminu liczone dwoma wyrażeniami rozjechałyby się cicho, więc
 * wyrażenie jest tu jedno i wołane dwa razy.
 */
export function computeValidityEnd(
  now: Date,
  validityMonths: number | undefined
): Date | null {
  return validityMonths && validityMonths > 0
    ? new Date(new Date(now).setMonth(now.getMonth() + validityMonths))
    : null
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

/** Koercja wyłącznie wartości SQL; pg zwraca NUMERIC jako string. */
// Story 3.5 (FR-13, NFR-2): bez `Number(string)` — dokładna zamiana łańcucha
// NUMERIC (BigInt); wartość poza bezpiecznym zakresem ⇒ `undefined`
// (fail-loud w `assertPositiveIntegerMinor`), nie cicho zaokrąglona kwota.
function readDatabaseNumber(value: unknown): number | undefined {
  return readDatabaseMinorIntegerStrict(value) ?? undefined
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
