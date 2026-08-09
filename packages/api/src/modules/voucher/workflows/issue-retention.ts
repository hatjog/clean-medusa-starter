import { createHash } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"

import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
  assertTransition,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"
import {
  RETENTION_AMOUNT_PCT_MAX,
  RETENTION_AMOUNT_PCT_MIN,
  isRetentionAmountWithinBoundary,
} from "../entitlement-boundary"
// Import sentinel from reissue-lost-code (single source — F-02 fix).
// Also re-exported so callers that resolve via issue-retention get the same value.
import {
  decideVoucherCodeInvalidation,
  invalidateVoucherCode,
  type VoucherCodeInvalidationResult,
} from "../voucher-code-state"
import type {
  SuccessorVoucherCodeOutcome,
  VoucherStatus,
} from "../models/types"
import {
  GP_PLATFORM_SCOPE_SENTINEL,
  SuccessorVoucherCodeBridgeError,
} from "./reissue-lost-code"
export { GP_PLATFORM_SCOPE_SENTINEL } from "./reissue-lost-code"
export { SuccessorVoucherCodeBridgeError } from "./reissue-lost-code"

export const ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE =
  "gp.entitlements.entitlement_retention_issued.v1" as const

export type RetentionEventEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE
  occurred_at: string
  actor: "market_operator"
  scope: {
    instance_id: string
    market_id: string
    vendor_id?: string | null
    location_id?: string | null
  }
  idempotency_key: string
  payload: {
    original_entitlement_id: string
    retention_entitlement_id: string
    reason: string
    reason_code?: string
    amount: number
    admin_user_id: string
    issued_at: string
    retention_voucher_template_id?: string
    entitlement_type?: EntitlementType
    order_id?: string
  }
}

export type RetentionEntitlement = {
  id: string
  entitlement_profile_id: string
  entitlement_type: EntitlementType
  order_id: string | null
  state: EntitlementInstanceState
  policy_snapshot: EntitlementPolicySnapshot
  metadata?: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  issued_at?: Date | null
  expires_at?: Date | null
  market_id?: string | null
  sales_channel_id?: string | null
  // Optional — absent from v1.8.0 DDL; populated when column exists for
  // idempotent amount recovery (F-01 fix).
  amount?: number | null
}

export type IssueRetentionInput = {
  entitlement_id: string
  amount: number
  reason: string
  reason_code?: string
  admin_user_id: string
  retention_voucher_template_id?: string
  idempotency_key?: string
  now?: Date
  market_id?: string | null
}

export type IssueRetentionResult = {
  original_entitlement_id: string
  retention_entitlement_id: string
  retention_code: string
  amount: number
  event: RetentionEventEnvelope
  idempotent: boolean
}

export class RetentionAmountBoundaryError extends Error {
  readonly amount: number
  readonly originalAmount: number | null

  constructor(amount: number, originalAmount: number | null) {
    const msg =
      originalAmount != null
        ? `Retention amount ${amount} violates incentive ratio boundary ` +
          `[${RETENTION_AMOUNT_PCT_MIN}%–${RETENTION_AMOUNT_PCT_MAX}%] of ` +
          `original value ${originalAmount}`
        : `Retention amount ${amount} must be > 0`
    super(msg)
    this.name = "RetentionAmountBoundaryError"
    this.amount = amount
    this.originalAmount = originalAmount
  }
}

/**
 * v1.15.0 Story 5.9 review-fix cyklu 2 (C2-MEDIUM-1).
 *
 * `input.amount` zasila od tego fixu DWA nośniki tej samej kwoty:
 * `entitlement_instance.amount` następcy i `voucher.value_minor` jego kodu.
 * Druga kolumna to `integer NOT NULL CHECK (value_minor >= 0)`, więc wartość
 * ułamkowa albo wywróciłaby INSERT w środku transakcji retencji, albo — gdyby
 * kiedyś typ się poluzował — rozjechałaby oba nośniki. Guard jest tu, PRZED
 * jakimkolwiek zapisem, i nazywa przyczynę. Minor units są konwencją całej
 * ścieżki pieniądza w GP (ADR-166), więc to jest doprecyzowanie kontraktu
 * wejścia, nie nowa reguła biznesowa.
 */
export class RetentionAmountNotMinorUnitsError extends Error {
  readonly amount: number
  constructor(amount: number) {
    super(
      `Retention amount ${amount} nie jest całkowitą liczbą minor units — ` +
        "kwota zasila `voucher.value_minor` (integer NOT NULL) oraz `amount` " +
        "wiersza następcy, więc musi być jednym, całkowitym wyrażeniem."
    )
    this.name = "RetentionAmountNotMinorUnitsError"
    this.amount = amount
  }
}

export class RetentionEntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "RetentionEntitlementNotFoundError"
  }
}

// Re-export for route convenience.
export { EntitlementTransitionError }

export interface IssueRetentionStore {
  withTransaction<T>(fn: (tx: IssueRetentionTx) => Promise<T>): Promise<T>
}

export interface IssueRetentionTx {
  getEntitlementForUpdate(id: string): Promise<RetentionEntitlement | null>
  getEntitlement(id: string): Promise<RetentionEntitlement | null>
  voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
  createRetentionEntitlement(row: RetentionEntitlement): Promise<void>
  /**
   * v1.15.0 Story 5.9 (FR-12, AD-17): unieważnienie STANU KODU starego
   * vouchera — w TEJ SAMEJ transakcji, co `voidEntitlement`. Retencja
   * wymienia voucher na nowy; stary kod ma przestać działać razem
   * z uprawnieniem, nie kilka zapisów później i nie „prawie zawsze".
   */
  invalidateVoucherCode(input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }): Promise<VoucherCodeInvalidationResult>
  /**
   * v1.15.0 Story 5.9 review-fix (MEDIUM-1): WYDANIE kodu następcy — wiersz
   * `voucher` sklonowany ze starego kodu, z nowym kodem i stanem `idle`,
   * w TEJ SAMEJ transakcji.
   *
   * Do tego fixu następca dziedziczył `voucher_code` STAREGO kodu przez
   * `snapshotPolicy(old.policy_snapshot)`, a żaden nowy wiersz `voucher` nie
   * powstawał. Skutki były dwa i oba realne: (1) most 5.7
   * (`policy_snapshot->>'voucher_code'`) przestawał być jednoznaczny — dwa
   * uprawnienia wskazywały ten sam kod; (2) `new_code` zwracany klientce nie
   * istniał w tabeli, po której rozstrzyga trasa realizacji, więc „nowy kod"
   * był kodem martwym, a stary — od 5.9 — `withdrawn`. Klientka zostawała
   * z niczym.
   *
   * review-fix cyklu 2 (C2-MEDIUM-1): `value_minor` NIE jest przepisywane
   * z klonu. Kwota retencji jest osobnym wejściem, a jej granica to
   * [100 %, 200 %] kwoty źródłowej — klon rozjeżdżał więc nośnik kodu
   * z nośnikiem uprawnienia dla KAŻDEJ retencji ≠ 100 %, i to w liczbie, którą
   * kosmetolożka widzi przed realizacją (`GET /vendor/vouchers/:code/lookup`
   * projektuje `value_minor` prosto z wiersza `voucher`).
   *
   * review-fix cyklu 2 (C2-MEDIUM-2): wynik jest ROZŁĄCZNY
   * ({@link SuccessorVoucherCodeOutcome}), nie `boolean` — `false` znaczyło
   * dwie różne rzeczy i obie prowadziły do cichego fallbacku na kod, który ta
   * sama transakcja właśnie unieważniła.
   */
  issueSuccessorVoucherCode(input: {
    from_code: string
    to_code: string
    /**
     * Kwota nośnika kodu (minor units). `null` = przepisz z klonu — używane
     * przez odzysk zgubionego kodu, gdzie kwota z definicji się nie zmienia.
     */
    value_minor: number | null
    now: Date
  }): Promise<SuccessorVoucherCodeOutcome>
}

export type RetentionEventEmitter = {
  emit: (envelope: RetentionEventEnvelope) => Promise<void>
}

/**
 * IssueRetentionWorkflow — mirrors ReissueLostCodeWorkflow (Story 2.5).
 *
 * Atomicity: void(old) + issue(new) in a single DB transaction; ROLLBACK
 * on any step failure compensates automatically (no orphaned VOIDED instance).
 * Event emitted post-COMMIT with best-effort retry (mirrors Story 2.5 M2).
 *
 * Key differences vs lost-code reissue (per Dev Notes):
 *   1. No 30-day window check — retention is not time-gated.
 *   2. Carries mandatory `amount` with boundary validation (AC4).
 *   3. Retention profile resolution (AC3): body override > metadata > verbatim snapshot fallback.
 *   4. Idempotency key: `entitlement:<old_id>:retention`.
 *   5. New code generated via same generator (GP-XXXX-XXXX-XXXX).
 */
export class IssueRetentionWorkflow {
  constructor(
    private readonly store: IssueRetentionStore,
    private readonly events: RetentionEventEmitter
  ) {}

  async issueRetention(
    input: IssueRetentionInput
  ): Promise<IssueRetentionResult> {
    const reason = input.reason.trim()
    if (!reason) throw new Error("reason is required")
    if (!input.admin_user_id.trim()) throw new Error("admin_user_id is required")

    const now = input.now ?? new Date()
    const idempotencyKey =
      input.idempotency_key?.trim() ||
      `entitlement:${input.entitlement_id}:retention`

    const retentionCode = generateRetentionEntitlementCode(
      input.entitlement_id,
      idempotencyKey
    )

    const result = await this.store.withTransaction(async (tx) => {
      const old = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!old) throw new RetentionEntitlementNotFoundError(input.entitlement_id)

      // Idempotency: if retention successor already exists, return it without mutation.
      const existing = await tx.getEntitlement(retentionCode)
      if (existing) {
        // F-01 fix: prefer the stored amount from the existing row when available
        // (requires `amount` column in DDL — v1.8.0 DDL absent so falls back to
        // input.amount). This prevents returning a misleading new request amount
        // on idempotent retries. When amount column is absent, input.amount is
        // returned as the best available approximation; documented in Completion Notes.
        const resolvedAmount =
          existing.amount != null ? existing.amount : input.amount
        return {
          result: buildResult({
            old,
            next: existing,
            retentionCode,
            amount: resolvedAmount,
            reason,
            reason_code: input.reason_code,
            retention_voucher_template_id:
              input.retention_voucher_template_id,
            admin_user_id: input.admin_user_id,
            idempotencyKey,
            now,
            market_id: input.market_id,
            idempotent: true,
          }),
          shouldEmit: false,
        }
      }

      // AC4 boundary: amount > 0 (always) + incentive ratio (when original resolvable).
      // Original amount is carried in policy_snapshot when present; DDL drift
      // means the `amount` column may not exist — degrade to amount > 0 only.
      const originalAmount = resolveOriginalAmount(old)
      if (!isRetentionAmountWithinBoundary(input.amount, originalAmount)) {
        throw new RetentionAmountBoundaryError(input.amount, originalAmount)
      }
      // review-fix cyklu 2 (C2-MEDIUM-1): od tego fixu kwota zasila TAKŻE
      // `voucher.value_minor` (integer NOT NULL) — jedno wyrażenie dla obu
      // nośników. Guard PRZED jakimkolwiek zapisem.
      if (!Number.isInteger(input.amount)) {
        throw new RetentionAmountNotMinorUnitsError(input.amount)
      }

      // AC2 void old entitlement (assertTransition throws EntitlementTransitionError
      // when the source state does not permit VOIDED).
      assertTransition(old.state, EntitlementInstanceState.VOIDED)
      await tx.voidEntitlement(old.id, old.state, now)
      // v1.15.0 Story 5.9 (AC3): stan kodu schodzi RAZEM z uprawnieniem.
      await tx.invalidateVoucherCode({
        entitlement_id: old.id,
        to_state: EntitlementInstanceState.VOIDED,
        now,
      })

      // AC3 retention profile resolution:
      //   (a) body override → retention_voucher_template_id from input
      //   (b) source metadata.retention_voucher_template_id
      //   (c) fallback: verbatim snapshot copy (current BonBeauty state)
      const templateId =
        input.retention_voucher_template_id ??
        resolveMetadataTemplateId(old.metadata) ??
        null

      // When a named template is declared, TTL/policy should ideally be loaded
      // from the profile catalog (v1.9.0+ Voucher Runda 2). In v1.8.0 the
      // catalog is OOS, so we always copy the source policy_snapshot verbatim
      // regardless of whether templateId is set, and document this in the
      // Completion Notes. This is the AC3 fallback path for all BonBeauty cases.
      // v1.15.0 Story 5.9 review-fix (MEDIUM-1): voucher retencyjny dostaje
      // WŁASNY kod — kopiowanie kodu źródłowego zostawiało klientce kod,
      // który ta sama transakcja przed chwilą przestawiła na `withdrawn`.
      const oldSnapshot = old.policy_snapshot as Record<string, unknown>
      const oldCode =
        typeof oldSnapshot.voucher_code === "string"
          ? oldSnapshot.voucher_code
          : null
      //
      // review-fix cyklu 2 (C2-MEDIUM-1/C2-MEDIUM-2): kwota nośnika kodu
      // pochodzi z `input.amount` — TEGO SAMEGO wyrażenia, co `amount` wiersza
      // następcy niżej — a wynik wydania jest ROZŁĄCZNY, bez fallbacku na kod
      // przed chwilą unieważniony.
      if (oldCode) {
        const outcome = await tx.issueSuccessorVoucherCode({
          from_code: oldCode,
          to_code: retentionCode,
          value_minor: input.amount,
          now,
        })
        if (outcome === "source_missing") {
          throw new SuccessorVoucherCodeBridgeError(
            oldCode,
            retentionCode,
            "retencja"
          )
        }
      }
      const retentionPolicy = snapshotPolicy(
        oldCode
          ? { ...oldSnapshot, voucher_code: retentionCode }
          : oldSnapshot
      )

      const next: RetentionEntitlement = {
        id: retentionCode,
        entitlement_profile_id: old.entitlement_profile_id,
        entitlement_type: old.entitlement_type,
        order_id: old.order_id,
        state: EntitlementInstanceState.ACTIVE,
        policy_snapshot: retentionPolicy,
        created_at: now,
        updated_at: now,
        // Optional columns preserved when present (DDL-drift safe):
        market_id: old.market_id ?? null,
        sales_channel_id: old.sales_channel_id ?? null,
        // issued_at / expires_at — retention is a new voucher; TTL from
        // retention profile (v1.9.0+) or fallback source snapshot. In v1.8.0
        // copy expires_at from source as the safest fallback (prevents zero TTL).
        issued_at: now,
        expires_at: old.expires_at ?? null,
        // amount: stored when column exists (F-01 fix — idempotent recovery).
        // In v1.8.0 DDL the column is absent; Postgres store writes it only
        // when OPTIONAL_RETENTION_COLUMNS detection finds the column present.
        amount: input.amount,
      }
      await tx.createRetentionEntitlement(next)

      return {
        result: buildResult({
          old,
          next,
          retentionCode,
          amount: input.amount,
          reason,
          reason_code: input.reason_code,
          retention_voucher_template_id: templateId ?? undefined,
          admin_user_id: input.admin_user_id,
          idempotencyKey,
          now,
          market_id: input.market_id,
          idempotent: false,
        }),
        shouldEmit: true,
      }
    })

    if (result.shouldEmit) {
      // Post-COMMIT emit (mirrors Story 2.5 M2 best-effort pattern).
      let emitError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.events.emit(result.result.event)
          emitError = undefined
          break
        } catch (err) {
          emitError = err
        }
      }
      if (emitError) {
        throw Object.assign(
          new Error(
            `Retention issue committed but audit event emit failed for ` +
              `idempotency_key=${result.result.event.idempotency_key} — ` +
              `state is mutated; retry the emit or check event bus. ` +
              `Underlying: ${emitError instanceof Error ? emitError.message : String(emitError)}`
          ),
          { cause: emitError }
        )
      }
    }

    return result.result
  }
}

/**
 * Generate a deterministic, human-readable retention entitlement successor code.
 * Mirrors generateReadableEntitlementCode from reissue-lost-code (same algorithm,
 * different idempotency_key prefix → guaranteed distinct from reissue codes).
 */
export function generateRetentionEntitlementCode(
  oldEntitlementId: string,
  idempotencyKey: string
): string {
  const digest = createHash("sha256")
    .update(`${oldEntitlementId}:${idempotencyKey}`)
    .digest("hex")
    .toUpperCase()
  return `GP-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`
}

/**
 * Resolve the original entitlement's monetary value for incentive ratio check.
 * Returns null when not resolvable from the current DDL (DDL drift posture).
 * In v1.8.0 the `amount` column does not exist on entitlement_instance; the
 * policy_snapshot may carry the value in some profiles. This is best-effort.
 */
function resolveOriginalAmount(
  row: RetentionEntitlement
): number | null {
  // Try policy_snapshot.amount if present (some profiles carry it).
  const snap = row.policy_snapshot as Record<string, unknown>
  if (typeof snap.amount === "number" && Number.isFinite(snap.amount) && snap.amount > 0) {
    return snap.amount
  }
  // DDL drift: no `amount` column on the row in v1.8.0 DDL.
  return null
}

/**
 * Resolve retention_voucher_template_id from instance metadata (AC3 priority b).
 */
function resolveMetadataTemplateId(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata) return null
  const id = metadata["retention_voucher_template_id"]
  if (typeof id === "string" && id.trim()) return id.trim()
  return null
}

function buildResult(args: {
  old: RetentionEntitlement
  next: RetentionEntitlement
  retentionCode: string
  amount: number
  reason: string
  reason_code?: string
  retention_voucher_template_id?: string
  admin_user_id: string
  idempotencyKey: string
  now: Date
  market_id?: string | null
  idempotent: boolean
}): IssueRetentionResult {
  const occurredAt = args.now.toISOString()
  const payload: RetentionEventEnvelope["payload"] = {
    original_entitlement_id: args.old.id,
    retention_entitlement_id: args.next.id,
    reason: args.reason,
    amount: args.amount,
    admin_user_id: args.admin_user_id,
    issued_at: occurredAt,
    entitlement_type: args.old.entitlement_type,
  }
  if (args.reason_code) payload.reason_code = args.reason_code
  if (args.retention_voucher_template_id)
    payload.retention_voucher_template_id = args.retention_voucher_template_id
  if (args.old.order_id) payload.order_id = args.old.order_id

  const event: RetentionEventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: "market_operator",
    scope: {
      instance_id: args.old.id,
      market_id:
        args.old.market_id ?? args.market_id ?? GP_PLATFORM_SCOPE_SENTINEL,
    },
    idempotency_key: args.idempotencyKey,
    payload,
  }

  return {
    original_entitlement_id: args.old.id,
    retention_entitlement_id: args.next.id,
    retention_code: args.retentionCode,
    amount: args.amount,
    event,
    idempotent: args.idempotent,
  }
}

// ---------------------------------------------------------------------------
// Postgres store implementation
// ---------------------------------------------------------------------------

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release: () => void
}
type PgPool = {
  connect: () => Promise<PgClient>
}

export class PostgresIssueRetentionStore implements IssueRetentionStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(fn: (tx: IssueRetentionTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresIssueRetentionTx(client))
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }
}

const OPTIONAL_RETENTION_COLUMNS = [
  "issued_at",
  "expires_at",
  "market_id",
  "sales_channel_id",
  // `metadata` column: absent in v1.8.0 DDL (DDL drift — Debug Log 2026-05-16).
  // Added here so AC3 priority (b) [metadata.retention_voucher_template_id] fires
  // automatically when the column is present in a future DDL migration. When absent
  // (current state), resolveMetadataTemplateId(null) returns null and the verbatim
  // snapshot fallback is used — consistent with Completion Notes item 3. F-03 fix.
  "metadata",
  // `amount` column: absent in v1.8.0 DDL (DDL drift). Added for forward-compatibility
  // so the idempotent path can recover the originally committed amount when the column
  // is added in a future migration (F-01 fix). In v1.8.0 this is a no-op.
  "amount",
] as const

class PostgresIssueRetentionTx implements IssueRetentionTx {
  private optionalColumns: Set<string> | null = null

  constructor(private readonly client: PgClient) {}

  /**
   * v1.15.0 Story 5.9: delegacja do JEDYNEGO producenta stanu kodu, na
   * `this.client` — bez własnego `connect()`, `BEGIN` i `COMMIT`.
   */
  async invalidateVoucherCode(input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }): Promise<VoucherCodeInvalidationResult> {
    return invalidateVoucherCode(this.client, input)
  }

  /**
   * v1.15.0 Story 5.9 review-fix (MEDIUM-1): WYDANIE kodu następcy — wiersz
   * `voucher` sklonowany ze starego kodu, z nowym kodem i stanem `idle`,
   * w TEJ SAMEJ transakcji.
   *
   * Do tego fixu następca dziedziczył `voucher_code` STAREGO kodu przez
   * `snapshotPolicy(old.policy_snapshot)`, a żaden nowy wiersz `voucher` nie
   * powstawał. Skutki były dwa i oba realne: (1) most 5.7
   * (`policy_snapshot->>'voucher_code'`) przestawał być jednoznaczny — dwa
   * uprawnienia wskazywały ten sam kod; (2) `new_code` zwracany klientce nie
   * istniał w tabeli, po której rozstrzyga trasa realizacji, więc „nowy kod"
   * był kodem martwym, a stary — od 5.9 — `withdrawn`. Klientka zostawała
   * z niczym.
   *
   * review-fix cyklu 2 (C2-MEDIUM-1): `value_minor` bierzemy z `input`, a nie
   * z klonu, gdy wołający poda kwotę — kwota retencji jest osobnym wejściem
   * ([100 %, 200 %] źródła), więc klon rozjeżdżał nośnik kodu z nośnikiem
   * uprawnienia. `null` = przepisz z klonu (odzysk: ta sama kwota).
   *
   * review-fix cyklu 2 (C2-MEDIUM-2): wynik ROZŁĄCZNY — `issued` /
   * `already_issued` / `source_missing`. Poprzedni `boolean` sklejał dwie
   * ostatnie przyczyny w jedno `false`, a wołający na obu wpadał w fallback do
   * kodu przed chwilą unieważnionego.
   */
  async issueSuccessorVoucherCode(input: {
    from_code: string
    to_code: string
    value_minor: number | null
    now: Date
  }): Promise<SuccessorVoucherCodeOutcome> {
    const res = await this.client.query(
      `INSERT INTO voucher
         (code, market_id, seller_id, seller_name, seller_handle, product_title,
          value_minor, currency_code, status, expires_at, created_at, updated_at)
       SELECT $2, market_id, seller_id, seller_name, seller_handle, product_title,
              COALESCE($4::integer, value_minor), currency_code, 'idle',
              expires_at, $3, $3
         FROM voucher WHERE code = $1
       ON CONFLICT (code) DO NOTHING`,
      [input.from_code, input.to_code, input.now, input.value_minor]
    )
    if ((res.rowCount ?? 0) > 0) return "issued"
    // `rowCount = 0` ma DWIE przyczyny i wołający musi je rozróżnić: brak
    // wiersza źródłowego (złamany most) vs `ON CONFLICT DO NOTHING` na własnym
    // wierszu z wcześniejszej próby. Jedno dodatkowe zapytanie w ścieżce
    // rzadkiej jest tańsze niż `boolean`, który je sklejał.
    const existing = await this.client.query(
      `SELECT 1 FROM voucher WHERE code = $1`,
      [input.to_code]
    )
    return (existing.rowCount ?? 0) > 0 ? "already_issued" : "source_missing"
  }

  async getEntitlementForUpdate(id: string): Promise<RetentionEntitlement | null> {
    const columns = await this.selectColumns()
    return this.getEntitlementBySql(
      `SELECT ${columns}
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
  }

  async getEntitlement(id: string): Promise<RetentionEntitlement | null> {
    const columns = await this.selectColumns()
    return this.getEntitlementBySql(
      `SELECT ${columns}
         FROM entitlement_instance
        WHERE id = $1`,
      [id]
    )
  }

  async voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE entitlement_instance
          SET state = $3, updated_at = $4
        WHERE id = $1 AND state = $2`,
      [id, fromState, EntitlementInstanceState.VOIDED, now]
    )
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`void entitlement ${id} affected ${result.rowCount ?? 0} rows`)
    }
  }

  async createRetentionEntitlement(row: RetentionEntitlement): Promise<void> {
    const optionalColumns = await this.getOptionalColumns()
    const columns = [
      "id",
      "entitlement_profile_id",
      "entitlement_type",
      "order_id",
      "state",
      "policy_snapshot",
      "created_at",
      "updated_at",
    ]
    const values: unknown[] = [
      row.id,
      row.entitlement_profile_id,
      row.entitlement_type,
      row.order_id,
      row.state,
      row.policy_snapshot,
      row.created_at,
      row.updated_at,
    ]

    for (const column of OPTIONAL_RETENTION_COLUMNS) {
      if (!optionalColumns.has(column)) continue
      columns.push(column)
      values.push(row[column])
    }

    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ")
    const result = await this.client.query(
      `INSERT INTO entitlement_instance (${columns.join(", ")})
       VALUES (${placeholders})`,
      values
    )
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(
        `createRetentionEntitlement ${row.id} affected ${result.rowCount ?? 0} rows — expected 1`
      )
    }
  }

  private async getEntitlementBySql(
    sql: string,
    params: ReadonlyArray<unknown>
  ): Promise<RetentionEntitlement | null> {
    const result = await this.client.query<Record<string, unknown>>(sql, params)
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id as string,
      entitlement_profile_id: row.entitlement_profile_id as string,
      entitlement_type: row.entitlement_type as EntitlementType,
      order_id: (row.order_id ?? null) as string | null,
      state: row.state as EntitlementInstanceState,
      policy_snapshot: snapshotPolicy(
        row.policy_snapshot as Record<string, unknown>
      ),
      // metadata: optional column (not in v1.8.0 DDL); populated when present so
      // AC3 priority (b) [metadata.retention_voucher_template_id] fires for future
      // DDL that includes the column. Falls back to null when absent (F-03 fix).
      metadata:
        row.metadata != null
          ? (row.metadata as Record<string, unknown>)
          : null,
      created_at: new Date(row.created_at as Date | string),
      updated_at: new Date(row.updated_at as Date | string),
      issued_at:
        row.issued_at == null ? null : new Date(row.issued_at as Date | string),
      expires_at:
        row.expires_at == null
          ? null
          : new Date(row.expires_at as Date | string),
      market_id: (row.market_id ?? null) as string | null,
      sales_channel_id: (row.sales_channel_id ?? null) as string | null,
      // amount: optional column (absent in v1.8.0 DDL); read when present so
      // idempotent retries can return the originally committed amount (F-01 fix).
      amount:
        typeof row.amount === "number" && Number.isFinite(row.amount)
          ? row.amount
          : null,
    }
  }

  private async selectColumns(): Promise<string> {
    const optionalColumns = await this.getOptionalColumns()
    return [
      "id",
      "entitlement_profile_id",
      "entitlement_type",
      "order_id",
      "state",
      "policy_snapshot",
      "created_at",
      "updated_at",
      ...OPTIONAL_RETENTION_COLUMNS.filter((c) => optionalColumns.has(c)),
    ].join(", ")
  }

  private async getOptionalColumns(): Promise<Set<string>> {
    if (this.optionalColumns) return this.optionalColumns
    const result = await this.client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'entitlement_instance'
          AND column_name = ANY($1::text[])`,
      [OPTIONAL_RETENTION_COLUMNS]
    )
    this.optionalColumns = new Set(result.rows.map((r) => r.column_name))
    return this.optionalColumns
  }
}

// ---------------------------------------------------------------------------
// In-memory store for unit tests
// ---------------------------------------------------------------------------

export class InMemoryIssueRetentionStore implements IssueRetentionStore {
  private rows: Map<string, RetentionEntitlement>
  private codes: Map<string, VoucherStatus>

  constructor(
    rows: RetentionEntitlement[] = [],
    /** v1.15.0 Story 5.9: stany kodów vouchera — `kod → status`. */
    codes: Record<string, VoucherStatus> = {}
  ) {
    this.rows = new Map(rows.map((r) => [r.id, cloneEntitlement(r)]))
    this.codes = new Map(Object.entries(codes))
    // Kody z fixture'ów rejestrowane jako `idle`, chyba że podano inaczej.
    for (const row of this.rows.values()) {
      const snap = row.policy_snapshot as Record<string, unknown>
      const code = typeof snap?.voucher_code === "string" ? snap.voucher_code : null
      if (code && !this.codes.has(code)) {
        this.codes.set(code, "idle")
      }
    }
  }

  /** Stan kodu po operacji — do asercji AC3 (oba wiersze, nie tylko jeden). */
  getVoucherStatus(code: string): VoucherStatus | undefined {
    return this.codes.get(code)
  }

  get(id: string): RetentionEntitlement | undefined {
    const row = this.rows.get(id)
    return row ? cloneEntitlement(row) : undefined
  }

  all(): RetentionEntitlement[] {
    return [...this.rows.values()].map(cloneEntitlement)
  }

  async withTransaction<T>(fn: (tx: IssueRetentionTx) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, cloneEntitlement(r)])
    )
    // v1.15.0 Story 5.9: stany kodów WCHODZĄ do migawki rollbacku.
    const codesSnapshot = new Map(this.codes)
    try {
      return await fn(new InMemoryIssueRetentionTx(this.rows, this.codes))
    } catch (err) {
      this.rows = snapshot
      this.codes = codesSnapshot
      throw err
    }
  }
}

class InMemoryIssueRetentionTx implements IssueRetentionTx {
  constructor(
    private readonly rows: Map<string, RetentionEntitlement>,
    private readonly codes: Map<string, VoucherStatus>
  ) {}

  /** v1.15.0 Story 5.9: mirror semantyki producenta (ta sama reguła co PG). */
  async invalidateVoucherCode(input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }): Promise<VoucherCodeInvalidationResult> {
    const row = this.rows.get(input.entitlement_id)
    const snapshot = (row?.policy_snapshot ?? {}) as Record<string, unknown>
    const code =
      typeof snapshot.voucher_code === "string" ? snapshot.voucher_code : null
    const decision = decideVoucherCodeInvalidation({
      entitlement_id: input.entitlement_id,
      entitlement_type: (row?.entitlement_type as string | undefined) ?? null,
      voucher_code: code,
      current_status: code ? this.codes.get(code) ?? null : null,
      to_state: input.to_state,
    })
    if (decision.outcome === "invalidated" && decision.voucher_code) {
      this.codes.set(decision.voucher_code, decision.target_status)
    }
    return decision
  }

  /**
   * v1.15.0 Story 5.9 review-fix: mirror wydania kodu następcy — rozłączny
   * wynik, tak jak w PG (review-fix cyklu 2, C2-MEDIUM-2). Atrapa nie trzyma
   * `value_minor`, więc parametr jest tu bez efektu; kwotę mierzą testy PG
   * i evidence, a nie ta mapa.
   */
  async issueSuccessorVoucherCode(input: {
    from_code: string
    to_code: string
    value_minor: number | null
    now: Date
  }): Promise<SuccessorVoucherCodeOutcome> {
    if (this.codes.has(input.to_code)) return "already_issued"
    if (!this.codes.has(input.from_code)) return "source_missing"
    this.codes.set(input.to_code, "idle")
    return "issued"
  }

  async getEntitlementForUpdate(id: string): Promise<RetentionEntitlement | null> {
    return this.getEntitlement(id)
  }

  async getEntitlement(id: string): Promise<RetentionEntitlement | null> {
    const row = this.rows.get(id)
    return row ? cloneEntitlement(row) : null
  }

  async voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.state !== fromState) {
      throw new Error(`void entitlement ${id} affected 0 rows`)
    }
    this.rows.set(id, {
      ...row,
      state: EntitlementInstanceState.VOIDED,
      updated_at: now,
    })
  }

  async createRetentionEntitlement(row: RetentionEntitlement): Promise<void> {
    // F-04 fix: throw on duplicate to mirror Postgres rowCount==1 guard.
    if (this.rows.has(row.id)) {
      throw new Error(
        `createRetentionEntitlement: duplicate id ${row.id} — mirrors Postgres unique constraint`
      )
    }
    this.rows.set(row.id, cloneEntitlement(row))
  }
}

function cloneEntitlement(row: RetentionEntitlement): RetentionEntitlement {
  return {
    ...row,
    policy_snapshot: snapshotPolicy(
      row.policy_snapshot as Record<string, unknown>
    ),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    issued_at: row.issued_at ? new Date(row.issued_at) : row.issued_at,
    expires_at: row.expires_at ? new Date(row.expires_at) : row.expires_at,
    // amount is a scalar — spread (...row) already covers it; kept explicit for clarity.
    amount: row.amount ?? null,
  }
}

// ---------------------------------------------------------------------------
// Factory for route/scope wiring
// ---------------------------------------------------------------------------

type EventBusLike = {
  emit?: (message: { name: string; data: RetentionEventEnvelope }) => Promise<unknown>
}

export function createIssueRetentionWorkflowFromScope(scope: {
  resolve: (key: string) => unknown
}): IssueRetentionWorkflow {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new IssueRetentionWorkflow(new PostgresIssueRetentionStore(pool), {
    async emit(envelope) {
      await eventBus?.emit?.({
        name: ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
        data: envelope,
      })
    },
  })
}
