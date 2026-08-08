import type { MedusaContainer } from "@medusajs/framework/types"

import {
  EntitlementInstanceState,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
} from "../modules/voucher/models/entitlement"
import {
  createExpireEntitlementOperationFromScope,
  EXPIRY_SOURCE_STATES,
} from "../modules/voucher/workflows/expire-entitlement"

/**
 * entitlement-expiry-sweeper — v1.9.0 Wave F6 / Epic-2 HIGH-07.
 *
 * Daily cron sweep that flips stale entitlements and vouchers to their
 * terminal expired state. Closes the HIGH-07 + HIGH-08 gap where:
 *   - The `EXPIRED` enum value was defined on `entitlement_instance.state`
 *     and the transition map but never written by any code path.
 *   - The `voucher.status` CHECK constraint disallowed `expired` (fixed in
 *     migration 1778926100000) and the service-layer `claim()` only branched
 *     on expiry at read-time, never persisting.
 *
 * Behavior:
 *   1. UPDATE entitlement_instance SET state='EXPIRED' WHERE state IN
 *      (ISSUED, ACTIVE, REDEMPTION_REQUESTED) AND expires_at < NOW().
 *      All three source states have EXPIRED in the legal transition list
 *      (per ALLOWED_ENTITLEMENT_TRANSITIONS — assertion baked into the SQL
 *      filter so the state machine cannot drift away silently).
 *   2. (v1.15.0 Story 5.9) Stan kodu vouchera NIE jest już przestawiany osobnym
 *      bulk-UPDATE-em w tym pliku. Schodzi razem z uprawnieniem, w transakcji
 *      `ExpireEntitlementOperation` — patrz `modules/voucher/voucher-code-state.ts`
 *      (jedyny producent `UPDATE voucher SET status`). Poprzedni kształt
 *      (`WHERE status IN ('idle','consent_pending') AND expires_at < NOW()`)
 *      był drugim, nieatomowym producentem stanu kodu.
 *   3. Emit `gp.entitlements.entitlement_expired.v1` and `voucher.expired.v1`
 *      heartbeats to PostHog (per-row events are batched into counts only —
 *      individual event emission is deferred to the subscriber layer).
 *
 * Idempotent by design (filters by source state). Safe to re-run every
 * minute; the only mutation rows are those genuinely past expires_at.
 *
 * Schedule: every 6 hours. Eager-sweep semantics for vouchers with a
 * trailing-week expiry are not required for BonBeauty MVP; this is a
 * defense-in-depth job complementing the read-time expiry check in
 * `VoucherService.claim`.
 *
 * ── AI-Review-1: JEDEN punkt wygaszenia przez `ExpireEntitlementOperation` ────
 * Sweeper NIE używa już bulk-UPDATE. Każdy wiersz jest wygaszany per-row przez
 * `ExpireEntitlementOperation` (Story 4.2, `expire-entitlement.ts`), co gwarantuje
 * że tranzycja `<source>→EXPIRED` routuje przez `wireEntitlementTransitionPersisted`
 * (3.4) → posting hook → `ledger-writer` (2.6). Posting GATED (runtime_enabled=false
 * ⇒ audit-only/no-op) — flip = E6/P6 (ADR-139 D5).
 *
 * Po aktywacji E6/P6 CALLER MUSI przekazać `voucher_net_minor`/`vat_minor` do
 * ExpireEntitlementOperation (fail-closed gdy brak przy runtime_enabled=true).
 * Sweep wywołuje expire() bez kwot emisji (runtime_enabled=false ⇒ safe no-op
 * dla postingu); kwoty wymagane przy integracji E6/P6.
 *
 * Brak dwóch ścieżek: bulk-UPDATE usunięty. JEDEN punkt wygaszenia (AI-Review-1).
 */

export const SCHEDULE_NAME = "entitlement-expiry-sweeper" as const
export const SCHEDULE_CRON = "0 */6 * * *" as const

interface JobLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

interface PosthogClient {
  capture(args: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
  }): void
}

type PgClientLike = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
  release?: () => void
}

type PgPoolLike = { connect: () => Promise<PgClientLike> }
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, e) => console.error(`[${SCHEDULE_NAME}] ${m}`, e),
  }
  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved && typeof resolved.info === "function") {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch {
    // fall through
  }
  return fallback
}

function resolveOptional<T>(
  container: MedusaContainer | undefined,
  key: string
): T | null {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null
  } catch {
    return null
  }
}

type ExecResult = { rows: unknown[]; rowCount?: number | null }
type ExecFn = (sql: string, params?: unknown[]) => Promise<ExecResult>

export default async function entitlementExpirySweeper(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container)
  const posthog = resolveOptional<PosthogClient>(container, "posthog")

  // AI-Review-1: JEDEN punkt wygaszenia — EXPIRY_SOURCE_STATES derywowane z grafu.
  if (
    !ALLOWED_ENTITLEMENT_TRANSITIONS[EntitlementInstanceState.REDEMPTION_REQUESTED].includes(
      EntitlementInstanceState.EXPIRED
    )
  ) {
    logger.warn(
      "entitlement transition table omits REDEMPTION_REQUESTED→EXPIRED; sweeper will skip that source state"
    )
  }

  let pool: PgPoolLike | KnexLike | null = resolveOptional<PgPoolLike>(
    container,
    "__pg_pool__"
  )
  if (!pool) {
    pool = resolveOptional<KnexLike>(container, "pg")
  }
  if (!pool) {
    logger.warn("no postgres pool resolved — skipping expiry sweep")
    return
  }

  const exec = await pgExecFromUnion(pool)
  if (!exec) {
    logger.warn("postgres pool shape unrecognised — skipping expiry sweep")
    return
  }

  const startedAt = new Date()
  let entitlementsExpired = 0
  let entitlementsSkipped = 0
  let vouchersExpired = 0

  // ── AI-Review-1: per-row expiry przez ExpireEntitlementOperation (JEDEN punkt) ──
  // NIE bulk-UPDATE. Każdy wiersz routuje przez wireEntitlementTransitionPersisted
  // (3.4) → posting hook → ledger-writer (2.6). Posting GATED (runtime_enabled=false
  // ⇒ audit-only/no-op). Kwoty emisji (net/vat) nie są tu znane — przekazywane jako
  // undefined; operacja używa remaining jako proxy gross (bezpieczne przy no-op).
  // UWAGA PRE-AKTYWACJI E6/P6: przed flip runtime_enabled=true sweeper MUSI być
  // zaktualizowany o źródło kwot emisji (net/vat) dla poprawnego postingu breakage.

  // Faza 1: pobierz identyfikatory wierszy gotowych do wygaśnięcia.
  let expirableIds: string[] = []
  try {
    const res = await exec(
      `SELECT id, market_id
         FROM entitlement_instance
        WHERE state = ANY($1::text[])
          AND expires_at IS NOT NULL
          AND expires_at < NOW()`,
      [[...EXPIRY_SOURCE_STATES]]
    )
    expirableIds = (res.rows as { id: string; market_id: string | null }[])
      .map((r) => r.id)
  } catch (err) {
    logger.error("entitlement_instance expiry candidates query failed", err)
    throw err
  }

  // Faza 2: per-row routing przez ExpireEntitlementOperation.
  const op = createExpireEntitlementOperationFromScope(
    container as { resolve: (key: string) => unknown }
  )

  for (const id of expirableIds) {
    try {
      const result = await op.expire({
        entitlement_id: id,
        // Kwoty emisji nieznane w sweep — undefined (bezpieczne przy runtime_enabled=false).
        // Przy runtime_enabled=true operacja rzuca EntitlementNotExpirableError (AI-Review-1).
        voucher_net_minor: undefined,
        voucher_vat_minor: undefined,
      })
      if (!result.idempotent) {
        entitlementsExpired++
      }
      // Stan kodu unieważniony w TEJ SAMEJ transakcji (5.9).
      if (result.voucher_code_invalidated) {
        vouchersExpired++
      }
    } catch (err) {
      // Log per-row błędy; kontynuuj sweep dla pozostałych wierszy (defense-in-depth).
      logger.error(
        `entitlement ${id} expiry sweep failed — skipping row`,
        err
      )
      entitlementsSkipped++
    }
  }

  // ── v1.15.0 Story 5.9 (FR-12, AD-17): DRUGI PRODUCENT STANU KODU USUNIĘTY ──
  // Do tej story stał tu bulk `UPDATE voucher SET status='expired'` — JEDNO
  // zapytanie wykonane PO pętli wygaszania, poza transakcją którejkolwiek
  // tranzycji uprawnienia. Dawało to dwa niezależne zapisy: uprawnienie mogło
  // zejść do EXPIRED, a stan kodu zostać (albo odwrotnie), bo nic ich nie
  // spinało. Było to też DRUGIE miejsce piszące `voucher.status` w repo.
  //
  // review-fix 5.9: usunięcie drugiego producenta ZWĘZIŁO zakres. Bulk-UPDATE
  // gasił kody po `voucher.expires_at` NIEZALEŻNIE od tego, czy istnieje
  // uprawnienie i w jakim jest stanie; następca gasi kod tylko przez tranzycję
  // uprawnienia z `EXPIRY_SOURCE_STATES`. Kod po terminie, którego uprawnienie
  // nie ma krawędzi →EXPIRED (albo nie istnieje w ogóle), zostanie więc
  // `idle`/`consent_pending` NA ZAWSZE. To zwężenie jest ŚWIADOME (drugi
  // producent poza transakcją był defektem), ale NIE jest zerowe — więc jest
  // MIERZONE i głośne, zamiast niewidoczne. Pomiar jest read-only: ten job
  // przestał być producentem stanu kodu i nim nie wraca.
  //
  // Od 5.9 stan kodu schodzi RAZEM z uprawnieniem, w transakcji
  // `ExpireEntitlementOperation` — przez `wireEntitlementTransitionPersisted`
  // → `tx.invalidateVoucherCode` → jedyny producent (`voucher-code-state.ts`).
  // Licznik `vouchers_expired` liczy więc unieważnienia, które FAKTYCZNIE
  // zaszły w tych transakcjach, a nie osobny bulk-UPDATE.

  // Pomiar zwężenia zakresu (review-fix 5.9) — READ-ONLY, bez `UPDATE`.
  let vouchersOrphaned = 0
  try {
    const orphans = await exec(
      `SELECT count(*)::bigint AS n
         FROM voucher v
        WHERE v.status IN ('idle','consent_pending')
          AND v.expires_at IS NOT NULL
          AND v.expires_at < NOW()
          AND NOT EXISTS (
                SELECT 1
                  FROM entitlement_instance e
                 WHERE e.policy_snapshot->>'voucher_code' = v.code
                   AND e.state = ANY($1::text[])
                   AND e.expires_at IS NOT NULL
                   AND e.expires_at < NOW()
              )`,
      [[...EXPIRY_SOURCE_STATES]]
    )
    const raw = (orphans.rows[0] as { n?: unknown } | undefined)?.n
    // node-pg zwraca `bigint`/`numeric` jako STRING — `Number(undefined)` dałoby
    // NaN, więc konwersja jest jawna i domyślnie zerowa.
    vouchersOrphaned = raw == null ? 0 : Number(raw)
  } catch (err) {
    // Pomiar nie jest bramką sweepa: jego porażka nie może wywrócić wygaszania.
    logger.error("voucher expiry orphan measurement failed", err)
    vouchersOrphaned = -1
  }
  if (vouchersOrphaned > 0) {
    logger.warn(
      `voucher expiry orphans=${vouchersOrphaned}: kody po terminie bez ` +
        "uprawnienia z krawędzią →EXPIRED — stan kodu NIE zejdzie sam " +
        "(v1.15.0 Story 5.9 usunął bulk-UPDATE gasnący kody poza transakcją " +
        "tranzycji). Wymagają decyzji domenowej, nie cichego UPDATE-u."
    )
  }

  logger.info(
    `swept entitlements=${entitlementsExpired} skipped=${entitlementsSkipped} ` +
      `vouchers=${vouchersExpired} orphaned=${vouchersOrphaned} ` +
      `started=${startedAt.toISOString()} done=${new Date().toISOString()}`
  )

  posthog?.capture({
    distinctId: "entitlement-expiry-sweeper",
    event: "gp.entitlements.expiry_sweeper.heartbeat",
    properties: {
      entitlements_expired: entitlementsExpired,
      entitlements_skipped: entitlementsSkipped,
      vouchers_expired: vouchersExpired,
      // review-fix 5.9: `-1` ⇒ pomiaru NIE wykonano (zapytanie padło).
      // Zero i „nie wiem" muszą być rozróżnialne, inaczej brak sygnału czyta
      // się jak dowód braku problemu.
      vouchers_expiry_orphaned: vouchersOrphaned,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    },
  })
}

async function pgExecFromUnion(pool: PgPoolLike | KnexLike): Promise<ExecFn | null> {
  const asPool = pool as PgPoolLike
  if (typeof asPool.connect === "function") {
    return async (sql, params) => {
      const client = await asPool.connect()
      try {
        const res = await client.query(sql, params as ReadonlyArray<unknown>)
        return { rows: res.rows as unknown[], rowCount: res.rowCount ?? 0 }
      } finally {
        client.release?.()
      }
    }
  }
  const asKnex = pool as KnexLike
  if (typeof asKnex.raw === "function") {
    return async (sql, params) => {
      const bindings: unknown[] = []
      const text = sql.replace(/\$(\d+)/g, (_m, idx: string) => {
        bindings.push((params ?? [])[Number(idx) - 1])
        return "?"
      })
      const res = await asKnex.raw(text, bindings)
      if (Array.isArray(res)) {
        return { rows: res, rowCount: res.length }
      }
      const obj = res as { rows?: unknown[]; rowCount?: number | null }
      return { rows: obj.rows ?? [], rowCount: obj.rowCount ?? 0 }
    }
  }
  return null
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
