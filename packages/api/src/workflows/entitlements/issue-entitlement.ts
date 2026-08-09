import { createHash, randomUUID } from "node:crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"

import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
  assertTransition,
  snapshotPolicy,
} from "../../modules/voucher/models/entitlement"
// v1.15.0 Story 5.9 (FR-12, AD-17, SM-7): JEDYNY producent stanu kodu vouchera.
import {
  VOUCHER_BACKED_ENTITLEMENT_TYPES,
  invalidateVoucherCode,
  type VoucherCodeInvalidationOutcome,
} from "../../modules/voucher/voucher-code-state"
import type { TransitionEventEnvelope } from "../../modules/voucher/entitlement-transition-wiring"
import { createRedeemPartialOperationFromTransaction } from "../../modules/voucher/workflows/redeem-partial-entitlement"
// v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): most kod → uprawnienie
// POWSTAJE przy wystawieniu, także na ścieżce `payment.captured`. Nośnik kodu
// i wiersza `voucher` jest WSPÓLNY z Path Y — dwa wyrażenia budujące ten sam
// wiersz rozjechałyby się cicho.
import {
  buildVoucherCode,
  computeValidityEnd,
  issueVoucherCodeWithinTx,
} from "./live-issue-from-payment-intent"

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
export type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release?: () => void
}
type PgPool = {
  connect: () => Promise<PgClient>
}
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

export type EntitlementProfilePayload = {
  profile_id?: string
  entitlement_type?: EntitlementType | string
  policy?: Record<string, unknown>
  currency?: string
  amount_minor?: number
  line_item_id?: string | null
  /**
   * v1.9.0 Wave F6 / HIGH-05: recipient identity bound at issuance time.
   * Drives `assertTransferabilityAllowed` enforcement for `personalized` and
   * `hybrid` profiles. Null/undefined = bearer (unbound) — historical default.
   */
  recipient_customer_id?: string | null
}

export type IssueEntitlementInput = {
  event_id: string
  order_id: string
  payment_id?: string
  payment_intent_id?: string
  market_id?: string | null
  amount_minor?: number | null
  currency?: string | null
  entitlement_profile?: EntitlementProfilePayload | null
}

export type IssueEntitlementResult = {
  entitlement_id: string
  idempotent: boolean
  /**
   * v1.9.0 Wave F6 / HIGH-04: claim_token surfaced from issuance so the
   * `apps/web` claim page + recipient email can deep-link to the Layer 4
   * (gp_mercur) entitlement. Idempotent re-issues return the existing token
   * (FOR UPDATE lock ensures a single token per entitlement).
   */
  claim_token: string
}

export class MissingEntitlementProfileError extends Error {
  constructor(orderId: string) {
    super(
      `payment.captured order ${orderId} has no entitlement_profile augmentation; ` +
        `Story 2.1 declarative profile enrichment must provide it before issuing`
    )
    this.name = "MissingEntitlementProfileError"
  }
}

/**
 * v1.15.0 Story 5.9 review-fix cyklu 3 (REG-HIGH-2) — RODZINA „wystawienie
 * kodu zablokowane danymi", nie kolejna warstwa fail-loudu.
 *
 * ── Co zmierzono ───────────────────────────────────────────────────────────
 * Cykl 2 dołożył na ścieżce `payment.captured` wołanie
 * `issueVoucherCodeWithinTx`, które jest fail-loud na braku któregokolwiek
 * z `seller_id`/`seller_name`/`seller_handle`/`product_title`. Jedynym źródłem
 * tych pól są LEFT JOIN-y (`VOUCHER_LINE_CONTEXT_JOINS`), a LEFT JOIN na
 * produkcie bez aktywnego `product_product_seller_seller` daje `null`, a nie
 * brak wiersza — czyli trafia prosto w rzut. Ścieżka ta PRZED cyklem 2
 * przechodziła.
 *
 * PEŁNA LISTA WOŁAJĄCYCH (`grep -rn "issueEntitlementsForAllLineItems"`,
 * bez testów) i co każdy z nich robił z takim rzutem PRZED tym fixem:
 *
 *   1. `workflows/payment/stripe-payment-audit.ts:253` — wołanie leży w
 *      transakcji audytu webhooka, a `catch` przepuszczał dalej wszystko poza
 *      `MissingEntitlementProfileError`. Rzut wywracał CAŁĄ transakcję: brak
 *      uprawnienia, brak wiersza audytu/dedupe, więc Stripe ponawiał w kółko,
 *      a każde ponowienie wywracało się identycznie.
 *   2. `subscribers/on-order-placed-stripe-retry.ts:275` — `catch` obsługiwał
 *      WYŁĄCZNIE `MissingEntitlementProfileError`; każdy inny wyjątek uciekał
 *      z `withTransaction`, `markDeferredResolved` nigdy się nie wykonywało,
 *      więc odroczone przechwycenie zostawało w kolejce i było odtwarzane bez
 *      końca.
 *
 * Trzeci potencjalny wołający, `issueEntitlementWithinPaymentTransaction`
 * (linia 155), deleguje do `issueEntitlementsForAllLineItems` i ma jedno
 * wywołanie produkcyjne (`issue-entitlement.ts:933`), czyli dziedziczy
 * zachowanie wołających (1) i (2) — nie jest osobnym przypadkiem.
 *
 * ── Czego ten fix NIE robi ─────────────────────────────────────────────────
 * NIE bramkuje wołania i NIE wystawia uprawnienia bez kodu: to przywróciłoby
 * defekt sedna story (wiersz, którego zwrot nie unieważni, SM-7 > 0).
 * Fail-closed ZOSTAJE. Zmienia się wyłącznie jego ZASIĘG RAŻENIA — z „wywróć
 * transakcję webhooka i pętl się w nieskończoność" na „nazwij powód, utrwal go
 * w kopercie audytu, nie wystawiaj". To jest DOKŁADNIE kształt, który ten plik
 * stosuje już dla `MissingEntitlementProfileError`; rodzina istnieje po to,
 * żeby oba wołające miejsca obsługiwały jeden warunek zamiast listy nazw.
 *
 * Wspólna nadklasa jest tu nośnikiem kontraktu: dopisanie kolejnego powodu
 * zablokowania wystawienia NIE wymaga edycji dwóch `catch`-ów — a to właśnie
 * rozjazd między rzutem a jego obsługą zrodził ten finding.
 */
export abstract class VoucherIssuanceBlockedError extends Error {
  readonly order_id: string
  readonly line_item_id: string | null
  /** Krótki, stabilny dyskryminator do kopert audytu i logów. */
  readonly reason: string
  protected constructor(
    message: string,
    name: string,
    reason: string,
    orderId: string,
    lineItemId: string | null
  ) {
    super(message)
    this.name = name
    this.reason = reason
    this.order_id = orderId
    this.line_item_id = lineItemId
  }
}

/**
 * v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1).
 *
 * Uprawnienie typu voucherowego wystawiane bez rynku, z którego da się
 * wyprowadzić kod. FAIL-CLOSED przed INSERT-em, nie po nim: wiersz wystawiony
 * bez mostu do kodu jest wierszem, którego ZWROT nie da się unieważnić —
 * czyli dokładnie defekt, który ta story usuwa, tyle że przesunięty z fazy
 * zwrotu do fazy wystawienia, gdzie nikt go już nie łączy z 5.9.
 *
 * review-fix cyklu 3 (REG-LOW-2): wciągnięty do rodziny
 * {@link VoucherIssuanceBlockedError}. Soczewka regresji słusznie zauważyła, że
 * `IssueEntitlementInput.market_id` jest w typie OPCJONALNE, a obaj produkcyjni
 * wołający podają je przelotowo z danych, których nie kontrolują (`payload.market_id`
 * z webhooka, `row.market_id` z odroczonego wiersza audytu). Rzut zostaje —
 * wiersz bez rynku jest niezapisywalny pod RLS i nieunieważnialny przy zwrocie —
 * ale przestaje być nieobsłużonym wyjątkiem u obu wołających.
 */
export class MissingVoucherIssuanceMarketError extends VoucherIssuanceBlockedError {
  constructor(orderId: string, lineItemId: string | null, type: string) {
    super(
      `issueSingleEntitlementRow: uprawnienie typu ${type} (order ${orderId}, ` +
        `linia ${lineItemId ?? "brak"}) jest voucher-backed, ale payload nie niesie ` +
        "`market_id` — kodu vouchera nie da się wyprowadzić, a wiersz bez kodu " +
        "byłby uprawnieniem, którego zwrot NIE unieważni (SM-7). Fail-closed " +
        "PRZED zapisem.",
      "MissingVoucherIssuanceMarketError",
      "missing_market",
      orderId,
      lineItemId
    )
  }
}

/**
 * v1.15.0 Story 5.9 review-fix cyklu 3 (REG-HIGH-2).
 *
 * Linia voucherowa, dla której nie da się ustalić salonu ani tytułu usługi —
 * produkt bez aktywnego `product_product_seller_seller` albo sprzedawca bez
 * `handle`. Kolumny `voucher.*` są NOT NULL, a kod bez salonu jest kodem,
 * którego nikt nie zrealizuje.
 *
 * Rzucany PRZED `INSERT INTO entitlement_instance`, nie po nim: to jest różnica
 * między „nie wystawiliśmy nic" a „wystawiliśmy uprawnienie bez kodu", czyli
 * między odmową a defektem SM-7. Producent (`issueVoucherCodeWithinTx`) ma ten
 * sam zestaw kontroli i ZOSTAJE — jest ostatnią barierą dla Path Y i dla
 * przyszłych wołających; tutaj wyprzedzamy go, żeby rzut nie zostawiał po sobie
 * połowicznego zapisu.
 */
export class MissingVoucherLineContextError extends VoucherIssuanceBlockedError {
  readonly missing_fields: readonly string[]
  constructor(orderId: string, lineItemId: string | null, missing: readonly string[]) {
    super(
      `issueSingleEntitlementRow: linia voucherowa (order ${orderId}, linia ` +
        `${lineItemId ?? "brak"}) nie ma wymaganych danych [${missing.join(", ")}]. ` +
        "Kolumny `voucher.*` są NOT NULL, a kod bez salonu jest kodem, którego " +
        "kosmetolożka nie zrealizuje, i mailem z pustym salonem do kupującej. " +
        "Fail-closed PRZED zapisem uprawnienia — wiersz bez kodu byłby " +
        "uprawnieniem, którego zwrot NIE unieważni (SM-7).",
      "MissingVoucherLineContextError",
      "missing_line_context",
      orderId,
      lineItemId
    )
    this.missing_fields = missing
  }
}

/**
 * v1.15.0 Story 5.9 review-fix cyklu 3 (REG-MEDIUM-1).
 *
 * Ścieżka direct-payload bez `line_item_id` na zamówieniu WIELOPOZYCYJNYM.
 * Do tego fixu `resolveVoucherLineContext` pomijał wtedy predykat linii
 * i kończył zapytanie `ORDER BY oi.created_at ASC LIMIT 1`, czyli brał
 * DOWOLNĄ (pierwszą chronologicznie) linię — a jej `seller_id` szedł prosto
 * do `INSERT INTO voucher`.
 *
 * Koszt nie był kosmetyczny: `claimVoucherCode` zawęża realizację po najemcy
 * (`AND seller_id = $N`), więc właściwy salon kodu BY NIE ZREALIZOWAŁ,
 * a obcy salon zobaczyłby go u siebie; `voucher.seller_name` i `product_title`
 * idą dodatkowo do maila do kupującej. Zgadywanie najemcy jest gorsze niż
 * odmowa wystawienia.
 */
export class AmbiguousVoucherLineError extends VoucherIssuanceBlockedError {
  constructor(orderId: string) {
    super(
      `resolveVoucherLineContext: zamówienie ${orderId} ma więcej niż jedną ` +
        "pozycję, a payload nie wskazuje `line_item_id` — nie da się ustalić, " +
        "do której linii (a więc do którego SALONU) należy kod vouchera. " +
        "Wybranie pierwszej chronologicznie przypisałoby kod cudzemu " +
        "sprzedawcy: trasa realizacji zawęża po `seller_id`, więc właściwy " +
        "salon by go nie zrealizował. Fail-closed zamiast zgadywania.",
      "AmbiguousVoucherLineError",
      "ambiguous_line",
      orderId,
      null
    )
  }
}

/**
 * Dane linii zamówienia potrzebne do WYDANIA kodu vouchera (kolumny `voucher`
 * są NOT NULL). Ten sam zestaw, który Path Y czyta w
 * `liveIssueEntitlementsWithinTx` — zapytanie jest tu powtórzone, bo captured-path
 * ma inny kształt pętli, ale KOLUMNY i JOIN-y są te same.
 */
type VoucherLineContext = {
  line_title: string | null
  seller_id: string | null
  seller_name: string | null
  seller_handle: string | null
}

const VOUCHER_LINE_CONTEXT_COLUMNS = `COALESCE(oli.title, p.title) AS line_title,
            s.id     AS seller_id,
            s.name   AS seller_name,
            s.handle AS seller_handle`

const VOUCHER_LINE_CONTEXT_JOINS = `LEFT JOIN product p
         ON p.id = oli.product_id
       LEFT JOIN product_product_seller_seller pss
         ON pss.product_id = oli.product_id
        AND pss.deleted_at IS NULL
       LEFT JOIN seller s
         ON s.id = pss.seller_id`

function isVoucherBackedType(type: string | undefined | null): boolean {
  return VOUCHER_BACKED_ENTITLEMENT_TYPES.has((type ?? "").trim())
}

export async function issueEntitlementWithinPaymentTransaction(
  client: PgClient,
  payload: IssueEntitlementInput,
  now: Date
): Promise<IssueEntitlementResult> {
  // v1.9.0 wf5 H-6 fix: prefer the multi-line path which iterates ALL voucher
  // line_items in the order. The legacy single-row return is preserved for
  // backward compat callers, but the result represents the FIRST issued/
  // existing entitlement (caller-aggregated event emission stays unchanged
  // for v1.8.0; H-6 callers using `issueEntitlementsForAllLineItems` get the
  // full set). If only one line is found, behavior is unchanged.
  //
  // Legacy order-level idempotency preserved: pre-migration data with one row
  // per order keyed by NULL `line_item_id` (the v1.8.0 shape) still
  // short-circuits without scanning the order_item table. New rows MUST carry
  // line_item_id (multi-line migration adds the column + UNIQUE constraint).
  // We ONLY accept the legacy short-circuit when the existing row is itself
  // legacy (line_item_id IS NULL); a row with line_item_id is part of the
  // multi-line shape and a fresh call for a different line must proceed.
  const legacy = await client.query<{
    id: string
    line_item_id: string | null
    claim_token: string | null
  }>(
    `SELECT id, line_item_id, claim_token FROM entitlement_instance
       WHERE order_id = $1 AND line_item_id IS NULL
       LIMIT 1 FOR UPDATE`,
    [payload.order_id]
  )
  if (legacy.rows[0]?.id) {
    const existingToken = legacy.rows[0].claim_token
    let claimToken: string
    if (existingToken) {
      claimToken = existingToken
    } else {
      // Backfill claim_token on legacy idempotent re-issue if missing (pre-F6
      // rows). Per CC-2 #1 elimination plan claim_token is the public handle
      // referenced by storefront/apps/web claim pages.
      claimToken = randomUUID()
      await client.query(
        `UPDATE entitlement_instance SET claim_token = $2, updated_at = NOW()
           WHERE id = $1 AND claim_token IS NULL`,
        [legacy.rows[0].id, claimToken]
      )
    }
    return {
      entitlement_id: legacy.rows[0].id,
      idempotent: true,
      claim_token: claimToken,
    }
  }

  const multi = await issueEntitlementsForAllLineItems(client, payload, now)
  if (multi.results.length === 0) {
    throw new MissingEntitlementProfileError(payload.order_id)
  }
  return multi.results[0]
}

/**
 * v1.9.0 wf5 H-6 fix — multi-product cart support.
 *
 * Issues one `entitlement_instance` per voucher-bearing order line item. The
 * legacy `issueEntitlementWithinPaymentTransaction` collapsed all lines into
 * a single row by using `LIMIT 1` on both the existence check and the profile
 * lookup. For BonBeauty MVP (single voucher profile across the catalog) this
 * happened to work as one-row-per-order; for v1.9.0+ multi-profile catalog or
 * any multi-product cart, customers paid for N vouchers but only received 1
 * entitlement (silent data loss).
 *
 * Behavior:
 *   - If the input payload carries an embedded `entitlement_profile`, fall
 *     back to single-row issuance (preserves direct-payload callers in tests
 *     and pure-API consumers).
 *   - Otherwise, scan ALL order line items with non-empty entitlement_profile
 *     metadata and issue one row per line. Each row carries the same
 *     `order_id` but distinct `line_item_id` so multi-line carts are
 *     queryable. Idempotency is per `(order_id, line_item_id)` instead of
 *     per `order_id` alone.
 *   - Lines without entitlement metadata (non-voucher SKUs) are skipped.
 *   - If the order has zero voucher lines, returns an empty result. Caller
 *     (`issueEntitlementWithinPaymentTransaction`) maps this to
 *     `MissingEntitlementProfileError` for fail-loud parity.
 */
export type MultiLineEntitlementResult = {
  results: IssueEntitlementResult[]
  line_item_ids: (string | null)[]
}

export async function issueEntitlementsForAllLineItems(
  client: PgClient,
  payload: IssueEntitlementInput,
  now: Date
): Promise<MultiLineEntitlementResult> {
  // Direct-payload path — single-row preserved behavior for tests and pure-API
  // consumers that pass `entitlement_profile` directly on the payload.
  if (
    payload.entitlement_profile?.profile_id &&
    payload.entitlement_profile.entitlement_type &&
    payload.entitlement_profile.policy
  ) {
    const lineItemId = payload.entitlement_profile.line_item_id ?? null
    // v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): kontekst sprzedawcy
    // czytany TYLKO gdy jest komu wydać kod — ścieżka direct-payload obsługuje
    // też typy niewsparte kodem (CREDIT_PACK/BUNDLE), dla których dodatkowe
    // zapytanie byłoby czystym kosztem.
    const lineContext = isVoucherBackedType(
      payload.entitlement_profile.entitlement_type as string | undefined
    )
      ? await resolveVoucherLineContext(client, payload.order_id, lineItemId)
      : null
    const result = await issueSingleEntitlementRow(
      client,
      payload,
      payload.entitlement_profile,
      lineItemId,
      lineContext,
      now
    )
    return { results: [result], line_item_ids: [lineItemId] }
  }

  // Multi-line path: scan ALL voucher-bearing order line items.
  //
  // v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): zapytanie niesie także
  // dane sprzedawcy i tytuł usługi — te same kolumny i te same JOIN-y, co
  // Path Y. Bez nich linia voucherowa dostawała uprawnienie BEZ kodu, więc
  // zwrot fail-closował na braku mostu i wywracał całą transakcję webhooka.
  const lines = await client.query<
    {
      line_item_id: string
      metadata: Record<string, unknown> | null
    } & VoucherLineContext
  >(
    `SELECT oli.id AS line_item_id, oli.metadata,
            ${VOUCHER_LINE_CONTEXT_COLUMNS}
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
       ${VOUCHER_LINE_CONTEXT_JOINS}
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
      ORDER BY oi.created_at ASC`,
    [payload.order_id]
  )

  const results: IssueEntitlementResult[] = []
  const lineItemIds: (string | null)[] = []

  for (const line of lines.rows) {
    const profile = extractProfileFromMetadata(
      line.metadata,
      payload.currency,
      payload.amount_minor
    )
    if (!profile?.profile_id || !profile.entitlement_type || !profile.policy) {
      continue // non-voucher SKU — skip
    }
    const result = await issueSingleEntitlementRow(
      client,
      payload,
      profile,
      line.line_item_id,
      {
        line_title: line.line_title ?? null,
        seller_id: line.seller_id ?? null,
        seller_name: line.seller_name ?? null,
        seller_handle: line.seller_handle ?? null,
      },
      now
    )
    results.push(result)
    lineItemIds.push(line.line_item_id)
  }

  return { results, line_item_ids: lineItemIds }
}

/**
 * Kontekst sprzedawcy dla POJEDYNCZEJ linii (ścieżka direct-payload).
 *
 * Zwraca `null`, gdy linii nie da się wskazać — wołający zamienia to na
 * fail-loud producenta kodu (`issueVoucherCodeWithinTx`), a nie na wydanie
 * z pustymi `seller_*`.
 */
async function resolveVoucherLineContext(
  client: PgClient,
  orderId: string,
  lineItemId: string | null
): Promise<VoucherLineContext | null> {
  const params: unknown[] = [orderId]
  let linePredicate = ""
  if (lineItemId) {
    params.push(lineItemId)
    linePredicate = ` AND oli.id = $${params.length}`
  }
  // review-fix cyklu 3 (REG-MEDIUM-1): `LIMIT 2`, nie `LIMIT 1`.
  //
  // Przy WSKAZANEJ linii `oli.id` jest kluczem głównym, więc drugi wiersz nie
  // powstanie i limit jest bez znaczenia. Przy linii NIEWSKAZANEJ drugi wiersz
  // jest JEDYNYM sygnałem, że wybór „pierwsza chronologicznie" byłby
  // zgadywaniem najemcy — a `LIMIT 1` ten sygnał USUWAŁ, zanim ktokolwiek
  // mógł go zobaczyć. Zapytanie musi zwrócić dowód niejednoznaczności, żeby
  // wołający miał na czym oprzeć odmowę.
  const rows = await client.query<VoucherLineContext>(
    `SELECT ${VOUCHER_LINE_CONTEXT_COLUMNS}
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
       ${VOUCHER_LINE_CONTEXT_JOINS}
      WHERE oi.order_id = $1${linePredicate}
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
      ORDER BY oi.created_at ASC
      LIMIT 2`,
    params
  )
  if (!lineItemId && rows.rows.length > 1) {
    throw new AmbiguousVoucherLineError(orderId)
  }
  return rows.rows[0] ?? null
}

/**
 * Pola `voucher.*`, które są NOT NULL — jeden zestaw dla kontroli wyprzedzającej
 * tutaj i dla fail-loudu producenta (`issueVoucherCodeWithinTx`). Dwie listy
 * rozjechałyby się cicho, a wtedy kontrola wyprzedzająca przepuszczałaby wiersz,
 * na którym producent i tak by się wywrócił — czyli dokładnie ten połowiczny
 * zapis, którego ten fix unika.
 */
function missingVoucherLineFields(
  ctx: VoucherLineContext | null
): readonly string[] {
  const isBlank = (v: string | null | undefined) =>
    typeof v !== "string" || v.trim().length === 0
  return (
    [
      ["seller_id", ctx?.seller_id],
      ["seller_name", ctx?.seller_name],
      ["seller_handle", ctx?.seller_handle],
      ["product_title", ctx?.line_title],
    ] as const
  )
    .filter(([, value]) => isBlank(value))
    .map(([field]) => field)
}

async function issueSingleEntitlementRow(
  client: PgClient,
  payload: IssueEntitlementInput,
  profile: EntitlementProfilePayload,
  lineItemId: string | null,
  lineContext: VoucherLineContext | null,
  now: Date
): Promise<IssueEntitlementResult> {
  // Per-line idempotency: row uniqueness is (order_id, line_item_id).
  // Backward-compat fallback for legacy data without line_item_id: behave as
  // before (one row per order). Multi-line carts MUST pass line_item_id so
  // each line gets its own row.
  const existing = lineItemId
    ? await client.query<{ id: string; claim_token: string | null }>(
        `SELECT id, claim_token FROM entitlement_instance
           WHERE order_id = $1 AND line_item_id = $2
           LIMIT 1 FOR UPDATE`,
        [payload.order_id, lineItemId]
      )
    : await client.query<{ id: string; claim_token: string | null }>(
        `SELECT id, claim_token FROM entitlement_instance
           WHERE order_id = $1 AND line_item_id IS NULL
           LIMIT 1 FOR UPDATE`,
        [payload.order_id]
      )

  if (existing.rows[0]?.id) {
    let claimToken = existing.rows[0].claim_token
    if (!claimToken) {
      claimToken = randomUUID()
      await client.query(
        `UPDATE entitlement_instance SET claim_token = $2, updated_at = NOW()
           WHERE id = $1 AND claim_token IS NULL`,
        [existing.rows[0].id, claimToken]
      )
    }
    return {
      entitlement_id: existing.rows[0].id,
      idempotent: true,
      claim_token: claimToken,
    }
  }

  // v1.9.0 wf5 (closes CC-1 F-CC1-015 / Epic-1 I-1): document that ISSUED is
  // conceptual and the persisted row is created already-ACTIVE for the
  // instant-issue flow (entitlement is live the moment payment captures).
  // `assertTransition(ISSUED, ACTIVE)` here is a structural guard that the
  // state machine declares the transition legal; it does NOT imply two rows
  // or two writes. ADR-099 amendment (deferred to ADR-099a) clarifies.
  assertTransition(EntitlementInstanceState.ISSUED, EntitlementInstanceState.ACTIVE)
  const entitlementId = buildEntitlementId(
    payload.order_id,
    `${payload.event_id}:${lineItemId ?? "_"}`
  )

  // ── MOST kod → uprawnienie POWSTAJE TUTAJ (review-fix cyklu 2, C2-HIGH-1) ──
  //
  // Do tego fixu ta ścieżka NIE zapisywała `voucher_code` do snapshotu i nie
  // tworzyła wiersza `voucher` w ogóle. Skutek był mierzalny na produkcji:
  // `revokeEntitlementsOnRefund` woła producenta stanu kodu dla każdego wiersza
  // zamówienia, a producent na parze „typ voucherowy + brak kodu" rzuca
  // `VoucherCodeBridgeMissingError` — leżąc w transakcji webhooka, wywracał
  // CAŁY zwrot (uprawnienie zostawało ACTIVE, wiersz dedupe nie powstawał,
  // Stripe retry'ował w kółko). Samo bramkowanie wołania uciszyłoby objaw
  // i zostawiło defekt sedna story: voucher wystawiony tą ścieżką NIE dałby
  // się unieważnić przy zwrocie, czyli SM-7 przestałby wynosić zero.
  //
  // Kod jest DETERMINISTYCZNY z pary (order_id, line_item_id) — tej samej,
  // która jest kluczem idempotencji wiersza wyżej. Ponowienie webhooka z innym
  // `event_id` zwarłoby się na `existing` przed dojściem tutaj, więc jeden
  // opłacony wiersz linii ma dokładnie jeden kod.
  const isVoucherBacked = isVoucherBackedType(
    profile.entitlement_type as string | undefined
  )
  const currency = profile.currency ?? payload.currency ?? "PLN"
  const amountMinor = profile.amount_minor ?? payload.amount_minor ?? 0
  const validityMonths = readNumber(profile.policy?.validity_months)
  let voucherCode: string | null = null
  if (isVoucherBacked) {
    const marketId = readString(payload.market_id ?? undefined)
    if (!marketId) {
      throw new MissingVoucherIssuanceMarketError(
        payload.order_id,
        lineItemId,
        String(profile.entitlement_type)
      )
    }
    voucherCode = buildVoucherCode(
      `${payload.order_id}:${lineItemId ?? "_"}`,
      marketId
    )
    // review-fix cyklu 3 (REG-HIGH-2): kontrola danych salonu WYPRZEDZA
    // `INSERT INTO entitlement_instance`.
    //
    // Do tego fixu ten sam warunek sprawdzał dopiero producent kodu, wołany
    // PO wstawieniu uprawnienia — więc rzut zostawiał w transakcji wiersz
    // uprawnienia bez kodu i wywracał ją w całości u wołającego. Przesunięcie
    // kontroli przed pierwszy zapis sprawia, że odmowa nie ma czego cofać:
    // dla tej linii nie powstaje NIC, a wołający dostaje nazwany powód
    // (`VoucherIssuanceBlockedError`) zamiast anonimowego `Error`, którego
    // oba `catch`-e przepuszczały dalej.
    const missing = missingVoucherLineFields(lineContext)
    if (missing.length > 0) {
      throw new MissingVoucherLineContextError(
        payload.order_id,
        lineItemId,
        missing
      )
    }
  }

  const snapshot = snapshotPolicy({
    ...profile.policy,
    currency,
    amount_minor: amountMinor,
    ...(voucherCode ? { voucher_code: voucherCode } : {}),
    source_event_id: payload.event_id,
    line_item_id: lineItemId,
  })

  // `expires_at` na uprawnieniu jest tym, po czym sweeper wybiera kandydatów do
  // wygaszenia — a od 5.9 to wygaszenie jest JEDYNYM producentem stanu
  // `expired` po stronie kodu. Wyliczane tym samym wyrażeniem, co
  // `voucher.expires_at` (review-fix HIGH-2 cyklu 1, rozszerzone na ten writer).
  const expiresAt = computeValidityEnd(now, validityMonths)

  const claimToken = randomUUID()
  await client.query(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
        state, policy_snapshot, market_id, claim_token, recipient_customer_id,
        expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $12, $11, $11)`,
    [
      entitlementId,
      profile.profile_id,
      profile.entitlement_type,
      payload.order_id,
      lineItemId,
      EntitlementInstanceState.ACTIVE,
      JSON.stringify(snapshot),
      payload.market_id ?? null,
      claimToken,
      profile.recipient_customer_id ?? null,
      now,
      expiresAt,
    ]
  )

  if (voucherCode) {
    // Wiersz `voucher` — TEN SAM producent, co Path Y (jeden `INSERT INTO
    // voucher`, jeden zestaw fail-loudów na brakach `seller_*`/`product_title`).
    await issueVoucherCodeWithinTx(client, {
      code: voucherCode,
      marketId: payload.market_id as string,
      sellerId: lineContext?.seller_id ?? null,
      sellerName: lineContext?.seller_name ?? null,
      sellerHandle: lineContext?.seller_handle ?? null,
      productTitle: lineContext?.line_title ?? null,
      valueMinor: amountMinor,
      currency,
      validityMonths,
      lineItemId: lineItemId ?? "_",
      context: `order ${payload.order_id}, ścieżka payment.captured`,
      now,
    })
  }

  return {
    entitlement_id: entitlementId,
    idempotent: false,
    claim_token: claimToken,
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function extractProfileFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  fallbackCurrency: string | null | undefined,
  fallbackAmount: number | null | undefined
): EntitlementProfilePayload | null {
  if (!metadata || typeof metadata !== "object") return null

  const embedded = (metadata as Record<string, unknown>).entitlement_profile
  if (isEntitlementProfilePayload(embedded)) {
    return embedded
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
    currency:
      readString((metadata as Record<string, unknown>).currency) ??
      fallbackCurrency ??
      undefined,
    amount_minor:
      typeof (metadata as Record<string, unknown>).amount_minor === "number"
        ? ((metadata as Record<string, unknown>).amount_minor as number)
        : fallbackAmount ?? undefined,
    line_item_id: readString((metadata as Record<string, unknown>).line_item_id),
    recipient_customer_id: readString(
      (metadata as Record<string, unknown>).recipient_customer_id
    ),
  }
}

async function resolveEntitlementProfile(
  client: PgClient,
  payload: IssueEntitlementInput
): Promise<EntitlementProfilePayload | null | undefined> {
  if (
    payload.entitlement_profile?.profile_id &&
    payload.entitlement_profile.entitlement_type &&
    payload.entitlement_profile.policy
  ) {
    return payload.entitlement_profile
  }

  const row = await client.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT oli.metadata
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
      ORDER BY oi.created_at ASC
      LIMIT 1`,
    [payload.order_id]
  )
  const metadata = row.rows[0]?.metadata
  if (!metadata || typeof metadata !== "object") return payload.entitlement_profile

  const embedded = metadata.entitlement_profile
  if (isEntitlementProfilePayload(embedded)) {
    return embedded
  }

  const profile_id =
    readString(metadata.entitlement_profile_id) ?? readString(metadata.profile_id)
  const entitlement_type = readString(metadata.entitlement_type)
  const policy = readObject(metadata.entitlement_policy) ?? readObject(metadata.policy)
  if (!profile_id || !entitlement_type || !policy) return payload.entitlement_profile

  return {
    profile_id,
    entitlement_type,
    policy,
    currency: readString(metadata.currency) ?? payload.currency ?? undefined,
    amount_minor:
      typeof metadata.amount_minor === "number"
        ? metadata.amount_minor
        : payload.amount_minor ?? undefined,
    line_item_id: readString(metadata.line_item_id),
  }
}

function isEntitlementProfilePayload(value: unknown): value is EntitlementProfilePayload {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return Boolean(
    readString(record.profile_id) &&
      readString(record.entitlement_type) &&
      readObject(record.policy)
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export async function compensateIssuedEntitlement(
  client: PgClient,
  result: IssueEntitlementResult | undefined
): Promise<VoucherCodeInvalidationOutcome | null> {
  if (!result || result.idempotent) return null
  // CC-1 F-CC1-016 fix (v1.9.0 wf5): transition to VOIDED instead of hard
  // DELETE. The compensation path runs on workflow rollback (insert→entitlement
  // failed → rollback both). Replacing DELETE with state transition preserves
  // an audit trail for downstream notifications/observers that may already
  // hold a reference, and avoids setting a precedent for the refund path
  // (F-CC1-002) of "compensation == DELETE row". Idempotency check: only
  // transition if not already in a terminal state.
  const voided = await client.query<{ entitlement_type: string | null }>(
    `UPDATE entitlement_instance
        SET state = $2,
            updated_at = NOW()
      WHERE id = $1
        AND state NOT IN ('VOIDED','REFUNDED','CLOSED')
      RETURNING entitlement_type`,
    [result.entitlement_id, EntitlementInstanceState.VOIDED]
  )
  // v1.15.0 Story 5.9 (FR-12, AD-17): VOIDED unieważnia uprawnienie, więc
  // stan kodu schodzi RAZEM z nim — na TYM SAMYM `client`-cie, czyli w tej
  // samej transakcji kompensacji. Bez tego rollback wystawienia zostawiał kod
  // w stanie realizowalnym przy uprawnieniu, którego już nie ma.
  //
  // review-fix 5.9: TYLKO gdy tranzycja FAKTYCZNIE zaszła. `UPDATE` wyżej jest
  // strzeżony (`state NOT IN ('VOIDED','REFUNDED','CLOSED')`), więc dla wiersza
  // już terminalnego obejmuje ZERO wierszy — a bezwarunkowe wołanie producenta
  // przestawiało wtedy stan kodu bez żadnej tranzycji uprawnienia. Dla wiersza
  // `CLOSED` (kod `claimed`) unieważniało to ZREALIZOWANY kod na `withdrawn`,
  // czyli zapis kłamiący o tym, co się wydarzyło. Ta gałąź jest jedynym
  // miejscem, w którym producent NIE jest wołany — i jest tak dlatego, że nie
  // ma tu tranzycji, którą miałby domykać.
  //
  // review-fix cyklu 2 (C2-HIGH-1): dodatkowo BRAMKOWANE przynależnością typu,
  // tym samym zbiorem co ścieżka zwrotu — `RETURNING entitlement_type` bierze
  // typ z wiersza, który TA transakcja właśnie przestawiła, więc nie ma tu
  // drugiego zapytania ani drugiego źródła prawdy.
  // review-fix cyklu 3 (REG-LOW-1): wynik producenta jest ZWRACANY, nie
  // odrzucany. Ta funkcja nie ma loggera ani koperty audytu, więc jedynym
  // uczciwym nośnikiem jest wartość zwracana — wołający, który zechce ją
  // odnotować, ma co odnotować, a test ma co zaasertować na ścieżce
  // produkcyjnej zamiast wyłącznie w testach samego producenta.
  if (
    (voided.rowCount ?? 0) > 0 &&
    isVoucherBackedType(voided.rows[0]?.entitlement_type)
  ) {
    const invalidation = await invalidateVoucherCode(client, {
      entitlement_id: result.entitlement_id,
      to_state: EntitlementInstanceState.VOIDED,
      now: new Date(),
    })
    return invalidation.outcome
  }
  return null
}

/**
 * v1.9.0 wf5 — Refund-path entitlement revocation (closes F-CC1-002 / H-3 /
 * CC-1 F-CC1-018 / ra-E5 P0_FINANCIAL_EXPOSURE_BEFORE_REDEMPTION_GO_LIVE).
 *
 * Transitions entitlement_instance ACTIVE/ISSUED/REDEMPTION_REQUESTED →
 * REFUNDED for ALL entitlement_instance rows attached to the refunded order.
 * Multi-line-item carts (Story 1.10.1 / H-6) yield N rows; this revokes them
 * all in one statement. Idempotent: re-running on a replayed refund webhook
 * is a no-op (terminal-state guard).
 *
 * IMPORTANT: this function MUST run inside the same DB transaction as the
 * audit-row insert so a half-applied refund (audit written, entitlement still
 * ACTIVE) is structurally impossible.
 *
 * Returns the list of revoked entitlement ids (for audit/event emission +
 * voucher-side propagation).
 *
 * Partial-refund posture (v1.8.0/v1.9.0): full revocation regardless of
 * refund amount. ADR-099 is silent on proportional revocation; v1.8.0+v1.9.0
 * BonBeauty has no partial-refund operational flow. Proportional semantics
 * are deferred to v1.10.0+ with an explicit ADR.
 */
export type RefundEntitlementRevocationResult = {
  revoked_entitlement_ids: string[]
  already_terminal_entitlement_ids: string[]
  reversal_redemption_ids: string[]
  transition_events: TransitionEventEnvelope[]
  /**
   * v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): wiersze zwrócone, dla
   * których producenta stanu kodu NIE wołano, bo typ uprawnienia nie jest
   * wsparty kodem (CREDIT_PACK/BUNDLE/SUBSCRIPTION_*). To NIE jest cichy
   * no-op: dla takiego wiersza nie ma PRZEDMIOTU unieważnienia, a fakt
   * pominięcia jest zwracany i asertowany, nie przemilczany.
   */
  code_invalidation_skipped_entitlement_ids: string[]
  /**
   * v1.15.0 Story 5.9 review-fix cyklu 3 (REG-LOW-1): wynik producenta stanu
   * kodu dla KAZDEGO wiersza voucherowego, ktory przeszedl przez zwrot.
   *
   * Producent rozroznia piec wynikow i opisuje to jako "wynik NAZWANY, nie
   * przemilczany". Pomiar pokazal, ze oba produkcyjne wolania odrzucaly
   * wartosc zwracana, wiec na sciezce produkcyjnej byly one nierozroznialne,
   * a wlasciwosc "nie cichy no-op" trzymala sie wylacznie na testach
   * jednostkowych producenta.
   */
  code_invalidation_outcomes: ReadonlyArray<{
    entitlement_id: string
    outcome: VoucherCodeInvalidationOutcome
  }>
}

export async function revokeEntitlementsOnRefund(
  client: PgClient,
  orderId: string,
  refundedAt: Date = new Date()
): Promise<RefundEntitlementRevocationResult> {
  // Lock + select all entitlement rows for this order. Multi-line carts
  // (H-6 fix) yield N rows; we revoke them all atomically.
  //
  // v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): `entitlement_type`
  // dociągnięty TUTAJ, bo decyzja „czy jest co unieważniać" należy do
  // wołającego, nie do producenta. Producent na parze „typ voucherowy + brak
  // kodu" rzuca — i ma rzucać — więc wołanie go dla wiersza, który kodu nie
  // ma z definicji taksonomii, byłoby wołaniem o porażkę bez przedmiotu.
  const rows = await client.query<{
    id: string
    state: string
    entitlement_type: string | null
  }>(
    `SELECT id, state, entitlement_type FROM entitlement_instance
       WHERE order_id = $1
       FOR UPDATE`,
    [orderId]
  )

  const revoked: string[] = []
  const alreadyTerminal: string[] = []
  const codeInvalidationSkipped: string[] = []
  const codeInvalidationOutcomes: {
    entitlement_id: string
    outcome: VoucherCodeInvalidationOutcome
  }[] = []
  const reversalRedemptionIds: string[] = []
  const transitionEvents: TransitionEventEnvelope[] = []
  const reversalOperation = createRedeemPartialOperationFromTransaction(
    client as Parameters<typeof createRedeemPartialOperationFromTransaction>[0],
    {
      events: {
        async emit(event) {
          transitionEvents.push(event)
        },
      },
    }
  )

  for (const row of rows.rows) {
    const currentState = row.state as EntitlementInstanceState
    // Already-terminal rows: REFUNDED (replay), VOIDED, CLOSED — leave alone.
    if (
      currentState === EntitlementInstanceState.REFUNDED ||
      currentState === EntitlementInstanceState.VOIDED ||
      currentState === EntitlementInstanceState.CLOSED
    ) {
      alreadyTerminal.push(row.id)
      continue
    }

    const redemptionRows = await client.query<{
      redemption_id: string
      already_reversed: boolean
    }>(
      `SELECT redemption.redemption_id,
              EXISTS (
                SELECT 1
                  FROM voucher_redemption reversal
                 WHERE reversal.reverses_redemption_id = redemption.redemption_id
                   AND reversal.kind = 'REVERSAL'
              ) AS already_reversed
         FROM voucher_redemption redemption
        WHERE redemption.entitlement_id = $1
          AND redemption.kind = 'REDEMPTION'
        ORDER BY redemption.created_at, redemption.redemption_id
        FOR UPDATE OF redemption`,
      [row.id]
    )

    if (redemptionRows.rows.length > 0) {
      const outstandingRedemptions = redemptionRows.rows.filter(
        (redemption) => !redemption.already_reversed
      )
      if (outstandingRedemptions.length === 0) {
        throw new Error(
          `revokeEntitlementsOnRefund: entitlement ${row.id} has only reversed ` +
            `redemptions but remains in non-terminal state ${currentState}`
        )
      }
      for (const redemption of outstandingRedemptions) {
        const reversed = await reversalOperation.reverse({
          reverses_redemption_id: redemption.redemption_id,
          actor: "system",
          actor_hint: "workflow:stripe-payment-audit:payment-refunded",
          now: refundedAt,
        })
        reversalRedemptionIds.push(reversed.redemption_id)
        if (reversed.code_invalidation_outcome) {
          codeInvalidationOutcomes.push({
            entitlement_id: row.id,
            outcome: reversed.code_invalidation_outcome,
          })
        }
      }
      revoked.push(row.id)
      continue
    }

    // Reach REFUNDED via the state machine. ACTIVE/ISSUED/REDEMPTION_REQUESTED
    // → REFUND_REQUESTED → REFUNDED. We collapse the two-step into one
    // UPDATE because the intermediate REFUND_REQUESTED has no business
    // semantics for Stripe-driven refunds (operator already pressed refund
    // in Stripe Dashboard — there is no pending state). The state machine
    // doesn't allow ACTIVE→REFUNDED directly, so we have to route through
    // REFUND_REQUESTED conceptually; we apply both rows atomically. Both
    // transitions are validated against ALLOWED_ENTITLEMENT_TRANSITIONS.
    //
    // For ISSUED → REFUNDED: ALLOWED_ENTITLEMENT_TRANSITIONS allows ISSUED →
    // VOIDED but NOT REFUNDED directly. We model this as ISSUED → ACTIVE
    // (legitimate) → REFUND_REQUESTED → REFUNDED. Since the row is hopefully
    // ACTIVE already (live issue flow makes it ACTIVE on creation), this is
    // a fast path. If ISSUED is encountered we transition through the
    // intermediates.
    //
    // For non-core states (EXPIRED, DISPUTED): EXPIRED → REFUND_REQUESTED →
    // REFUNDED is allowed; DISPUTED → REFUNDED is direct.
    // Determine the legitimate transition path to a "revoked" terminal state.
    // The state machine restricts which intermediates are reachable; we route
    // each origin state through the allowed path. Conceptually we coalesce
    // multi-step paths because the Stripe refund webhook is a single decision
    // (the operator already pressed refund in the Dashboard — there is no
    // pending intermediate). All transitions are still validated by
    // `assertTransition` so the state-machine invariants are not silently
    // bypassed.
    let terminalState: EntitlementInstanceState
    try {
      if (currentState === EntitlementInstanceState.DISPUTED) {
        assertTransition(currentState, EntitlementInstanceState.REFUNDED)
        terminalState = EntitlementInstanceState.REFUNDED
      } else if (
        currentState === EntitlementInstanceState.ACTIVE ||
        currentState === EntitlementInstanceState.EXPIRED ||
        currentState === EntitlementInstanceState.REDEEMED_PARTIAL ||
        currentState === EntitlementInstanceState.REDEEMED_FULL ||
        currentState === EntitlementInstanceState.SETTLED
      ) {
        // ACTIVE/EXPIRED/REDEEMED_*/SETTLED → REFUND_REQUESTED → REFUNDED.
        assertTransition(currentState, EntitlementInstanceState.REFUND_REQUESTED)
        assertTransition(
          EntitlementInstanceState.REFUND_REQUESTED,
          EntitlementInstanceState.REFUNDED
        )
        terminalState = EntitlementInstanceState.REFUNDED
      } else if (currentState === EntitlementInstanceState.REDEMPTION_REQUESTED) {
        // REDEMPTION_REQUESTED has no direct refund-class exit; the state
        // machine routes it through ACTIVE (redemption withdrawn) → REFUND_REQUESTED.
        assertTransition(currentState, EntitlementInstanceState.ACTIVE)
        assertTransition(
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REFUND_REQUESTED
        )
        assertTransition(
          EntitlementInstanceState.REFUND_REQUESTED,
          EntitlementInstanceState.REFUNDED
        )
        terminalState = EntitlementInstanceState.REFUNDED
      } else if (currentState === EntitlementInstanceState.ISSUED) {
        // ISSUED → ACTIVE → REFUND_REQUESTED → REFUNDED.
        assertTransition(currentState, EntitlementInstanceState.ACTIVE)
        assertTransition(
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REFUND_REQUESTED
        )
        assertTransition(
          EntitlementInstanceState.REFUND_REQUESTED,
          EntitlementInstanceState.REFUNDED
        )
        terminalState = EntitlementInstanceState.REFUNDED
      } else if (currentState === EntitlementInstanceState.REFUND_REQUESTED) {
        assertTransition(currentState, EntitlementInstanceState.REFUNDED)
        terminalState = EntitlementInstanceState.REFUNDED
      } else if (
        currentState === EntitlementInstanceState.PENDING_VENDOR_DECISION
      ) {
        // v1.15.0 Story 5.9 review-fix cyklu 2 (C2-INFO-1): zwrot NIE jest
        // przepadkiem. Do tego fixu ta gałąź szła `→ VOIDED` („vendor confirms
        // forfeiture"), więc producent zapisywał kod jako `withdrawn`,
        // a kosmetolożka widziała „Wycofany" — komunikat prawdziwy co do
        // mechanizmu i myląco fałszywy co do przyczyny: pieniądze WRÓCIŁY do
        // klientki. AC2 żąda powodu ROZRÓŻNIALNEGO „zwrócony".
        //
        // Trasa jest w grafie i nie wymaga jego zmiany: `PENDING_VENDOR_DECISION
        // → ACTIVE` („vendor waives no-show") → `REFUND_REQUESTED → REFUNDED`.
        // To ta sama konstrukcja, którą ten plik stosuje już dla
        // `REDEMPTION_REQUESTED`; jedno zdarzenie ze Stripe, wieloetapowa
        // ścieżka w maszynie stanów, każdy etap asertowany.
        assertTransition(currentState, EntitlementInstanceState.ACTIVE)
        assertTransition(
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REFUND_REQUESTED
        )
        assertTransition(
          EntitlementInstanceState.REFUND_REQUESTED,
          EntitlementInstanceState.REFUNDED
        )
        terminalState = EntitlementInstanceState.REFUNDED
      } else {
        throw new EntitlementTransitionError(
          currentState,
          EntitlementInstanceState.REFUNDED
        )
      }
    } catch (err) {
      // Re-throw with order context so the workflow can roll back the audit row.
      if (err instanceof EntitlementTransitionError) {
        throw new Error(
          `revokeEntitlementsOnRefund: cannot transition entitlement ` +
            `${row.id} (state=${currentState}) to REFUNDED for order ${orderId}: ${err.message}`
        )
      }
      throw err
    }

    await client.query(
      `UPDATE entitlement_instance
          SET state = $2,
              updated_at = $3
        WHERE id = $1`,
      [row.id, terminalState, refundedAt]
    )
    // v1.15.0 Story 5.9 (FR-12, SM-7): to jest ŚCIEŻKA, na której SM-7 się
    // rozstrzyga — zwrot ze Stripe unieważnia uprawnienie. Do tej story kod
    // vouchera zostawał nietknięty, więc kosmetolożka realizowała zabieg za
    // coś, za co nikt nie zapłacił. Zapis idzie tym samym `client`-em, czyli
    // w tej samej transakcji, co zmiana stanu uprawnienia i wiersz audytu.
    //
    // review-fix cyklu 2 (C2-HIGH-1): wołanie BRAMKOWANE rzeczywistą
    // przynależnością typu, wyprowadzoną z wyczerpującego
    // `Record<EntitlementType, boolean>` w nośniku producenta — nie z listy
    // literałów powtórzonej tutaj. Dla typu voucherowego BEZ kodu producent
    // nadal rzuca (fail-closed): po dołożeniu mostu przy wystawieniu taki
    // wiersz może pochodzić już tylko z danych zastanych, a te mają jawną
    // dyspozycję (DW-15-114), nie ciche `continue`.
    if (isVoucherBackedType(row.entitlement_type)) {
      // review-fix cyklu 3 (REG-LOW-1): wynik producenta jest ZACHOWYWANY.
      //
      // Do tego fixu oba produkcyjne wołania miały postać
      // `await invalidateVoucherCode(...)` z ODRZUCONĄ wartością zwracaną —
      // bez przypisania, bez logu, bez asercji. Producent starannie rozróżnia
      // `invalidated` / `already_invalidated` / `already_invalidated_other` /
      // `already_redeemed_code` / `no_voucher_code` i opisuje to jako
      // „wynik NAZWANY, nie przemilczany" — ale na ścieżce produkcyjnej
      // wszystkie te wyniki były nierozróżnialne, bo nikt ich nie czytał.
      //
      // Konkretny koszt: `already_redeemed_code` (kod `claimed` przy
      // uprawnieniu schodzącym do stanu unieważniającego) oznacza rozjazd
      // „uprawnienie zwrócone, kod nadal zrealizowany". SM-7 nie rośnie, bo
      // `claimed` jest poza allow-listą wejściową realizacji — ale bez śladu
      // ten rozjazd jest operacyjnie niewidoczny.
      const invalidation = await invalidateVoucherCode(client, {
        entitlement_id: row.id,
        to_state: terminalState,
        now: refundedAt,
      })
      codeInvalidationOutcomes.push({
        entitlement_id: row.id,
        outcome: invalidation.outcome,
      })
    } else {
      codeInvalidationSkipped.push(row.id)
    }
    revoked.push(row.id)
  }

  return {
    revoked_entitlement_ids: revoked,
    already_terminal_entitlement_ids: alreadyTerminal,
    reversal_redemption_ids: reversalRedemptionIds,
    transition_events: transitionEvents,
    code_invalidation_skipped_entitlement_ids: codeInvalidationSkipped,
    code_invalidation_outcomes: codeInvalidationOutcomes,
  }
}

function buildEntitlementId(orderId: string, eventId: string): string {
  const digest = createHash("sha256").update(`${orderId}:${eventId}`).digest("hex")
  return `ent_${digest.slice(0, 24)}`
}

export const issueEntitlementStep = createStep<
  IssueEntitlementInput,
  IssueEntitlementResult,
  IssueEntitlementResult
>(
  "gp-issue-entitlement",
  async (input, { container }) => {
    const result = await withResolvedTransaction(
      container as { resolve: (key: string) => unknown },
      async (client) => issueEntitlementWithinPaymentTransaction(
        client,
        input,
        new Date()
      )
    )
    return new StepResponse(result, result)
  },
  async (result, { container }) => {
    if (!result) return
    await withResolvedTransaction(container as { resolve: (key: string) => unknown }, async (client) => {
      await compensateIssuedEntitlement(client, result)
    })
  }
)

export const issueEntitlementWorkflow = createWorkflow<
  IssueEntitlementInput,
  IssueEntitlementResult,
  []
>("gp-issue-entitlement-workflow", function (input) {
  const result = issueEntitlementStep(input)
  return new WorkflowResponse(result)
})

async function withResolvedTransaction<T>(
  container: { resolve: (key: string) => unknown },
  handler: (client: PgClient) => Promise<T>
): Promise<T> {
  const db = resolvePgDatabase(container)
  if (isPgPool(db)) {
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const result = await handler(client)
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: Error) => {
        // Story 3.5 (FR-6c, AD-22): porazka ROLLBACK-u na sciezce pieniadza NIE
        // MOZE byc cichsza niz blad, ktory ja wywolal. Polkniecie zostawialo stan,
        // w ktorym transakcja moze byc nadal otwarta, a skutek nieodwrocony — i nie
        // mowilo o tym NIKOMU. Rzut laczy oba bledy w jeden, ktory i tak leci
        // wyzej; zaden nie ginie.
        const joined = new Error(
          "ROLLBACK po bledzie transakcji NIE doszedl do skutku: " +
            `${rollbackErr.message}; blad pierwotny: ${(err as Error).message}`
        )
        ;(joined as Error & { cause?: unknown }).cause = err
        throw joined
      })
      throw err
    } finally {
      client.release?.()
    }
  }

  return db.transaction(async (trx) => handler(createKnexPgClient(trx)))
}

function resolvePgDatabase(container: { resolve: (key: string) => unknown }): PgPool | KnexLike {
  try {
    return container.resolve("__pg_pool__") as PgPool
  } catch {
    return container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  }
}

function isPgPool(value: PgPool | KnexLike): value is PgPool {
  return typeof (value as PgPool).connect === "function"
}

function createKnexPgClient(db: KnexLike): PgClient {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values: ReadonlyArray<unknown> = []
    ) => {
      const query = toKnexSql(text, values)
      const result = await db.raw(query.sql, query.bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = (result.rows ?? []) as T[]
      return { rows, rowCount: result.rowCount ?? rows.length }
    },
    release: () => undefined,
  }
}

function toKnexSql(
  sql: string,
  values: ReadonlyArray<unknown>
): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    bindings.push(values[Number(index) - 1])
    return "?"
  })
  return { sql: text, bindings }
}
