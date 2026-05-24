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
    const result = await issueSingleEntitlementRow(
      client,
      payload,
      payload.entitlement_profile,
      lineItemId,
      now
    )
    return { results: [result], line_item_ids: [lineItemId] }
  }

  // Multi-line path: scan ALL voucher-bearing order line items.
  const lines = await client.query<{
    line_item_id: string
    metadata: Record<string, unknown> | null
  }>(
    `SELECT oli.id AS line_item_id, oli.metadata
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
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
      now
    )
    results.push(result)
    lineItemIds.push(line.line_item_id)
  }

  return { results, line_item_ids: lineItemIds }
}

async function issueSingleEntitlementRow(
  client: PgClient,
  payload: IssueEntitlementInput,
  profile: EntitlementProfilePayload,
  lineItemId: string | null,
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
  const snapshot = snapshotPolicy({
    ...profile.policy,
    currency: profile.currency ?? payload.currency ?? "PLN",
    amount_minor: profile.amount_minor ?? payload.amount_minor ?? 0,
    source_event_id: payload.event_id,
    line_item_id: lineItemId,
  })

  const claimToken = randomUUID()
  await client.query(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
        state, policy_snapshot, market_id, claim_token, recipient_customer_id,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $11)`,
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
    ]
  )

  return {
    entitlement_id: entitlementId,
    idempotent: false,
    claim_token: claimToken,
  }
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
): Promise<void> {
  if (!result || result.idempotent) return
  // CC-1 F-CC1-016 fix (v1.9.0 wf5): transition to VOIDED instead of hard
  // DELETE. The compensation path runs on workflow rollback (insert→entitlement
  // failed → rollback both). Replacing DELETE with state transition preserves
  // an audit trail for downstream notifications/observers that may already
  // hold a reference, and avoids setting a precedent for the refund path
  // (F-CC1-002) of "compensation == DELETE row". Idempotency check: only
  // transition if not already in a terminal state.
  await client.query(
    `UPDATE entitlement_instance
        SET state = $2,
            updated_at = NOW()
      WHERE id = $1
        AND state NOT IN ('VOIDED','REFUNDED','CLOSED')`,
    [result.entitlement_id, EntitlementInstanceState.VOIDED]
  )
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
}

export async function revokeEntitlementsOnRefund(
  client: PgClient,
  orderId: string,
  refundedAt: Date = new Date()
): Promise<RefundEntitlementRevocationResult> {
  // Lock + select all entitlement rows for this order. Multi-line carts
  // (H-6 fix) yield N rows; we revoke them all atomically.
  const rows = await client.query<{ id: string; state: string }>(
    `SELECT id, state FROM entitlement_instance
       WHERE order_id = $1
       FOR UPDATE`,
    [orderId]
  )

  const revoked: string[] = []
  const alreadyTerminal: string[] = []

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
        // PENDING_VENDOR_DECISION → VOIDED is the only refund-class exit.
        // We treat refund as forfeiture in this path.
        assertTransition(currentState, EntitlementInstanceState.VOIDED)
        terminalState = EntitlementInstanceState.VOIDED
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
    revoked.push(row.id)
  }

  return {
    revoked_entitlement_ids: revoked,
    already_terminal_entitlement_ids: alreadyTerminal,
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
      await client.query("ROLLBACK").catch(() => undefined)
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
