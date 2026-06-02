/**
 * voucher-ledger-reconciliation — Story 2.6 (v1.11.0 Epic 2 / Wave 2).
 * Podstawa: ADR-139 D2 (atomowość post-COMMIT + reconciliation-INWARIANT).
 *
 * INWARIANT KOMPLETNOŚCI, NIE TEST. Posting entitlement-ledgera jest post-COMMIT
 * i best-effort (event emit może 2× zawieść ⇒ event nie trafia na bus). Ten job
 * jest JEDYNĄ gwarancją, że każde zdarzenie księgowe (ISSUED / KAŻDA rata REDEEMED /
 * EXPIRED→BREAKAGE) ma swój wpis w `ledger_posting_applied`: enumeruje OCZEKIWANE
 * zdarzenia księgowe (audit-envelope / projekcja redempcji — SSOT zdarzeń, NIE live
 * state) i dosyła te bez wpisu, z PERSYSTOWANEGO SNAPSHOTU.
 *
 * DLACZEGO ENUMERACJA OCZEKIWANYCH ZDARZEŃ, NIE SKAN STANU (AI-Review H1/H2):
 *   - Skan po bieżącym `entitlement_instance.state` jest FAIL-OPEN: po zgubionym
 *     postingu stan awansuje (REDEEMED_FULL→SETTLED→CLOSED, EXPIRED→CLOSED), więc
 *     skan po `state='REDEEMED_FULL'/'EXPIRED'` NIGDY już nie znajdzie luki (H1).
 *   - Granularność per (entitlement_id, lifecycle_event) gubi zgubioną 2.+ ratę
 *     MPV: rata #1 applied ⇒ "REDEEMED istnieje" ⇒ rata #2 pominięta, output VAT
 *     raty #2 nierozpoznany (błąd podatkowy niewykrywalny) (H2).
 *   Inwariant porównuje więc per `transaction_id` (PK `ledger_posting_applied`,
 *   per-rata) OCZEKIWANE zdarzenia (każde z deterministycznym `transaction_id`
 *   z dyskryminatora redemption_id / remaining_gross_snapshot), NIEZALEŻNIE od
 *   bieżącego stanu entitlementu. Źródłem oczekiwanych zdarzeń jest projekcja
 *   audit-envelope materializowana przez E3/E4 (kontrakt poniżej).
 *
 * FAIL-CLOSED:
 *   - oczekiwane zdarzenie bez snapshotu ⇒ ALARM `missing_snapshot` (log error +
 *     metryka), NIGDY cicha dosyłka z live state, NIGDY silent skip;
 *   - entitlement terminalny REFUNDED ⇒ ALARM `refund_out_of_scope` (ADR-139
 *     §Granice: refund-after-redeem NO posting + ALARM; osobny ADR) — NIE silent skip;
 *   - `market_id` NULL dla oczekiwanego zdarzenia ⇒ ALARM `null_market_id`
 *     (denormalizacja per-market traci wartość; ADR-139 D1 — obserwowalność);
 *   - oczekiwane zdarzenia gdy posting nieaktywny (`runtime_enabled:false`) ⇒
 *     ALARM `unexpected_events_while_disabled` + BEZ dosyłki (D5 kontrakt: źródło
 *     oczekiwanych zdarzeń puste do aktywacji; defensywny guard).
 *
 * GRANICE (ADR-139 D5 / §Granice):
 *   - NIE aktywuje postingu (`runtime_enabled` zostaje `false`) — job tylko domyka
 *     kompletność istniejącej zdolności; dosyłka tylko gdy posting aktywny (L4);
 *   - REFUNDED: NO posting + alarm (out-of-scope, osobny ADR; M1);
 *   - dosyłka idzie przez `VoucherLedgerWriter` (idempotentny) → ponowny przebieg
 *     jest no-op dla już-dosłanych.
 *
 * KONTRAKT projekcji oczekiwanych zdarzeń (E3/E4 — TODO-ADR, patrz
 * `createPgExpectedEventScanner`): audit-envelope persystuje per-rata wiersz
 * oczekiwanego zdarzenia z precomputed `expected_transaction_id` (= ten sam
 * `deriveLedgerTransactionId`, deterministyczny). Reconciliation re-derywuje id
 * z dyskryminatora i fail-closed odrzuca dryf projekcji. Dopóki projekcja nie jest
 * podpięta (pre-E3), kontenerowe wiring jest INERT (świadomy no-op).
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import {
  generateVoucherPosting,
  VOUCHER_LIABILITY_ONLY_V1,
  type VoucherLifecycleEvent,
  type VoucherPostingInput,
} from "../modules/voucher/posting-profile"
import {
  deriveLedgerTransactionId,
  VoucherLedgerWriter,
  type LedgerPgPool,
  type VoucherLedgerWriteResult,
} from "../modules/voucher/ledger-writer"

export const SCHEDULE_NAME = "voucher-ledger-reconciliation" as const
/** Co 6h (defense-in-depth wobec best-effort event emit, ADR-139 D2). */
export const SCHEDULE_CRON = "0 */6 * * *" as const

export type ReconciliationLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

export type ReconciliationMetrics = {
  increment: (name: string, tags?: Record<string, string>) => void
}

/**
 * Referencja OCZEKIWANEGO zdarzenia księgowego (per-rata, NIEZALEŻNA od bieżącego
 * stanu entitlementu — H1). Każde zdarzenie ma deterministyczny `transaction_id`
 * z dyskryminatora (redemption_id dla REDEEMED, remaining_gross_snapshot dla
 * EXPIRED) ⇒ porównanie per-rata przez `transaction_id` (H2).
 */
export type ExpectedLedgerEventRef = {
  entitlement_id: string
  lifecycle_event: VoucherLifecycleEvent
  /** REDEEMED: per-rata dyskryminator (multi-installment-safe). */
  redemption_id?: string | null
  /** EXPIRED/BREAKAGE: snapshot rezydualnego brutto na moment wygaśnięcia. */
  remaining_gross_snapshot?: number | null
  /** NULL = brak market_id w źródle (denormalizacja traci wartość — alarm L1). */
  market_id: string | null
  /**
   * Precomputed deterministyczny `transaction_id` (z projekcji audit-envelope).
   * Reconciliation re-derywuje go z dyskryminatora i fail-closed odrzuca dryf.
   */
  expected_transaction_id: string
}

/** Referencja terminalnego entitlementu REFUNDED (M1 — out-of-scope, alarm-only). */
export type RefundedEntitlementRef = {
  entitlement_id: string
  market_id: string | null
}

/**
 * Persystowany snapshot zdarzenia lifecycle (audit envelope) — SSOT do dosyłki.
 * NIE jest live state. Zawiera wszystko, by deterministycznie odtworzyć posting:
 * input do `generateVoucherPosting()` (z deterministycznym `transaction_id`) +
 * dyskryminatory idempotencji (redemption_id / remaining_gross_snapshot).
 */
export type LedgerEventSnapshot = {
  entitlement_id: string
  lifecycle_event: VoucherLifecycleEvent
  redemption_id?: string | null
  remaining_gross_snapshot?: number | null
  posting_input: VoucherPostingInput
  expected_currency?: string
}

/**
 * Port: enumeracja OCZEKIWANYCH zdarzeń księgowych bez wpisu w
 * `ledger_posting_applied` (per-rata, niezależna od bieżącego stanu — H1/H2).
 */
export type ExpectedLedgerEventSource = {
  scanExpectedEventsWithoutPosting(): Promise<ExpectedLedgerEventRef[]>
}

/** Port: enumeracja terminalnych entitlementów REFUNDED (M1, alarm-only). */
export type RefundedEntitlementScanner = {
  scanRefundedTerminal(): Promise<RefundedEntitlementRef[]>
}

/** Port: odczyt persystowanego snapshotu zdarzenia (audit envelope). */
export type LedgerSnapshotSource = {
  loadSnapshot(ref: ExpectedLedgerEventRef): Promise<LedgerEventSnapshot | null>
}

export type ReconciliationDeps = {
  expected: ExpectedLedgerEventSource
  /** M1: opcjonalny skaner REFUNDED (alarm-only, NO posting). */
  refunded?: RefundedEntitlementScanner
  snapshots: LedgerSnapshotSource
  writer: Pick<VoucherLedgerWriter, "write">
  logger: ReconciliationLogger
  metrics?: ReconciliationMetrics
  /**
   * L4/D5: czy posting jest AKTYWNY (resolver-driven runtime flag, D5 warstwa 1).
   * Default `false` (bezpiecznie — persystencja ≠ aktywacja). Gdy `false`, a źródło
   * zwraca oczekiwane zdarzenia ⇒ kontrakt naruszony ⇒ alarm + BEZ dosyłki.
   */
  runtimeEnabled?: boolean
}

export type ReconciliationAlarmReason =
  | "missing_snapshot"
  | "refund_out_of_scope"
  | "null_market_id"
  | "unexpected_events_while_disabled"
  | "projection_drift"

export type ReconciliationAlarm = {
  entitlement_id: string
  lifecycle_event: VoucherLifecycleEvent | null
  reason: ReconciliationAlarmReason
}

export type ReconciliationReport = {
  scanned: number
  /** wpisy fizycznie dosłane (writer applied=true). */
  backfilled: number
  /** wpisy które okazały się już zaksięgowane (idempotencja, deduped). */
  deduped: number
  /** snapshoty dające no-op księgowy (np. SPV REDEEMED, EXPIRED bez salda). */
  noop: number
  /** ALARMY fail-closed (luki kompletności / out-of-scope). */
  alarms: ReconciliationAlarm[]
}

const METRIC_MISSING_SNAPSHOT = "voucher_ledger.reconciliation.missing_snapshot"
const METRIC_BACKFILLED = "voucher_ledger.reconciliation.backfilled"
const METRIC_REFUND_OUT_OF_SCOPE = "voucher_ledger.reconciliation.refund_out_of_scope"
const METRIC_NULL_MARKET = "voucher_ledger.reconciliation.null_market_id"
const METRIC_UNEXPECTED_WHILE_DISABLED =
  "voucher_ledger.reconciliation.unexpected_events_while_disabled"
const METRIC_PROJECTION_DRIFT = "voucher_ledger.reconciliation.projection_drift"

/**
 * Uruchamia inwariant reconciliation. Zwraca raport.
 *
 * 1. REFUNDED (M1): dla każdego terminalnego REFUNDED ⇒ ALARM `refund_out_of_scope`
 *    (NO posting; ADR-139 §Granice) — widoczne w monitoringu LNE, NIE silent skip.
 * 2. Oczekiwane zdarzenia (per-rata, H1/H2): dla każdego bez wpisu:
 *    - re-derywuj `transaction_id` z dyskryminatora; dryf vs projekcja ⇒ alarm;
 *    - `market_id` NULL ⇒ alarm `null_market_id` (obserwowalność), kontynuuj;
 *    - posting NIEAKTYWNY (`runtimeEnabled:false`) ⇒ alarm `unexpected_events_while_disabled`
 *      + BEZ dosyłki (D5 kontrakt, L4);
 *    - snapshot OBECNY ⇒ odtwórz posting z snapshotu i dosyłaj (idempotentnie);
 *      no-op księgowy gdy `posted:false`;
 *    - snapshot BRAK ⇒ ALARM `missing_snapshot`, NIE cicha dosyłka.
 *
 * Job NIE rzuca przy pojedynczym alarmie (skanuje całość), ale alarmy są zwrócone
 * w raporcie i zalogowane na error — monitoring LNE je wychwytuje.
 */
export async function runVoucherLedgerReconciliation(
  deps: ReconciliationDeps
): Promise<ReconciliationReport> {
  const { expected, refunded, snapshots, writer, logger, metrics } = deps
  const runtimeEnabled = deps.runtimeEnabled ?? false
  const report: ReconciliationReport = {
    scanned: 0,
    backfilled: 0,
    deduped: 0,
    noop: 0,
    alarms: [],
  }

  // (1) REFUNDED — out-of-scope, alarm-only (M1, ADR-139 §Granice).
  if (refunded) {
    const refundedRefs = await refunded.scanRefundedTerminal()
    for (const r of refundedRefs) {
      report.alarms.push({
        entitlement_id: r.entitlement_id,
        lifecycle_event: null,
        reason: "refund_out_of_scope",
      })
      metrics?.increment(METRIC_REFUND_OUT_OF_SCOPE, {
        market_id: r.market_id ?? "unknown",
      })
      logger.error(
        `[${SCHEDULE_NAME}] ALARM fail-closed: entitlement '${r.entitlement_id}' ` +
          `terminalny REFUNDED — refund-after-redeem OUT-OF-SCOPE (ADR-139 §Granice, ` +
          `osobny ADR). NO posting; alarm do interwencji operacyjnej (monitoring LNE).`
      )
    }
  }

  // (2) Oczekiwane zdarzenia księgowe (per-rata, niezależne od stanu — H1/H2).
  const refs = await expected.scanExpectedEventsWithoutPosting()
  report.scanned = refs.length

  for (const ref of refs) {
    // (2a) Fail-closed: re-derywacja deterministycznego transaction_id z dyskryminatora;
    // dryf vs projekcja ⇒ alarm + skip (NIE ufamy precomputed id w razie rozjazdu).
    const derived = deriveLedgerTransactionId({
      entitlement_id: ref.entitlement_id,
      lifecycle_event: ref.lifecycle_event,
      redemption_id: ref.redemption_id ?? null,
      remaining_gross_snapshot: ref.remaining_gross_snapshot ?? null,
    })
    if (derived !== ref.expected_transaction_id) {
      report.alarms.push({
        entitlement_id: ref.entitlement_id,
        lifecycle_event: ref.lifecycle_event,
        reason: "projection_drift",
      })
      metrics?.increment(METRIC_PROJECTION_DRIFT, {
        lifecycle_event: ref.lifecycle_event,
        market_id: ref.market_id ?? "unknown",
      })
      logger.error(
        `[${SCHEDULE_NAME}] ALARM fail-closed: dryf projekcji dla '${ref.entitlement_id}' ` +
          `(${ref.lifecycle_event}) — expected_transaction_id '${ref.expected_transaction_id}' ` +
          `≠ re-derywowany '${derived}'. NIE dosyłam (niejednoznaczna idempotencja).`
      )
      continue
    }

    // (2b) market_id NULL ⇒ alarm obserwowalności (L1) — kontynuuj dosyłkę
    // (snapshot niesie market_id; alarm zapewnia widoczność per-market luki).
    if (ref.market_id == null) {
      report.alarms.push({
        entitlement_id: ref.entitlement_id,
        lifecycle_event: ref.lifecycle_event,
        reason: "null_market_id",
      })
      metrics?.increment(METRIC_NULL_MARKET, { lifecycle_event: ref.lifecycle_event })
      logger.error(
        `[${SCHEDULE_NAME}] ALARM fail-closed: oczekiwane zdarzenie '${ref.entitlement_id}' ` +
          `(${ref.lifecycle_event}) ma market_id NULL — obserwowalność per-market ` +
          `(ADR-139 D1) podważona; wymaga backfill/NOT NULL przed aktywacją.`
      )
    }

    // (2c) L4/D5: posting nieaktywny, a źródło zwraca oczekiwane zdarzenia ⇒ kontrakt
    // naruszony (źródło MUSI być puste do aktywacji). Alarm + BEZ dosyłki.
    if (!runtimeEnabled) {
      report.alarms.push({
        entitlement_id: ref.entitlement_id,
        lifecycle_event: ref.lifecycle_event,
        reason: "unexpected_events_while_disabled",
      })
      metrics?.increment(METRIC_UNEXPECTED_WHILE_DISABLED, {
        lifecycle_event: ref.lifecycle_event,
        market_id: ref.market_id ?? "unknown",
      })
      logger.error(
        `[${SCHEDULE_NAME}] ALARM fail-closed: oczekiwane zdarzenie '${ref.entitlement_id}' ` +
          `(${ref.lifecycle_event}) przy runtime_enabled:false — posting nieaktywny ` +
          `(ADR-139 D5), źródło oczekiwanych zdarzeń MUSI być puste. NIE dosyłam.`
      )
      continue
    }

    const snapshot = await snapshots.loadSnapshot(ref)
    if (!snapshot) {
      // FAIL-CLOSED: brak snapshotu = luka audytowalności. Alarm, NIE silent skip,
      // NIE dosyłka z live state.
      report.alarms.push({
        entitlement_id: ref.entitlement_id,
        lifecycle_event: ref.lifecycle_event,
        reason: "missing_snapshot",
      })
      metrics?.increment(METRIC_MISSING_SNAPSHOT, {
        lifecycle_event: ref.lifecycle_event,
        market_id: ref.market_id ?? "unknown",
      })
      logger.error(
        `[${SCHEDULE_NAME}] ALARM fail-closed: oczekiwane zdarzenie '${ref.entitlement_id}' ` +
          `(${ref.lifecycle_event}) bez persystowanego snapshotu — NIE dosyłam z live ` +
          `state (ADR-139 D2). Luka kompletności do interwencji operacyjnej.`
      )
      continue
    }

    // Odtworzenie postingu WYŁĄCZNIE z persystowanego snapshotu (NIE live state).
    const result = generateVoucherPosting(snapshot.posting_input)
    if (!result.posted) {
      // Udokumentowany no-op księgowy (np. SPV REDEEMED, EXPIRED bez salda).
      report.noop += 1
      logger.info(
        `[${SCHEDULE_NAME}] entitlement '${ref.entitlement_id}' (${ref.lifecycle_event}): ` +
          `no-op księgowy ze snapshotu (${result.reason})`
      )
      continue
    }

    const written: VoucherLedgerWriteResult = await writer.write({
      entitlement_id: snapshot.entitlement_id,
      lifecycle_event: snapshot.lifecycle_event,
      redemption_id: snapshot.redemption_id ?? null,
      remaining_gross_snapshot: snapshot.remaining_gross_snapshot ?? null,
      transaction: result.transaction,
      expected_currency: snapshot.expected_currency,
    })

    if (written.applied) {
      report.backfilled += 1
      metrics?.increment(METRIC_BACKFILLED, {
        lifecycle_event: ref.lifecycle_event,
        market_id: ref.market_id ?? "unknown",
      })
    } else {
      report.deduped += 1
    }
  }

  if (report.alarms.length > 0) {
    logger.error(
      `[${SCHEDULE_NAME}] zakończono z ${report.alarms.length} alarmami na ` +
        `${report.scanned} skanowanych oczekiwanych zdarzeń — interwencja wymagana.`
    )
  } else {
    logger.info(
      `[${SCHEDULE_NAME}] OK: skan=${report.scanned} dosłane=${report.backfilled} ` +
        `dedup=${report.deduped} no-op=${report.noop}`
    )
  }

  return report
}

// ──────────────────────────────────────────────────────────────────────────
// Domyślne skanery PG (per-rata, niezależne od bieżącego stanu — H1/H2).
// ──────────────────────────────────────────────────────────────────────────

/**
 * KONTRAKT projekcji oczekiwanych zdarzeń (E3/E4 — TODO-ADR voucher-ledger-expected-event):
 *
 *   voucher_ledger_expected_event(
 *     expected_transaction_id text,   -- = deriveLedgerTransactionId(...) (deterministyczny)
 *     entitlement_id          text,
 *     lifecycle_event         text,   -- ISSUED | REDEEMED | EXPIRED (gruboziarniste, do derywacji id)
 *     redemption_id           text NULL,   -- per-rata dyskryminator REDEEMED
 *     remaining_gross_snapshot bigint NULL, -- dyskryminator EXPIRED
 *     market_id               text NULL
 *   )
 *
 * Wiersz jest materializowany przez E3/E4 w momencie EMITU zdarzenia (audit-envelope),
 * z `expected_transaction_id` policzonym tym samym `deriveLedgerTransactionId`. Dzięki
 * temu skan jest:
 *   - NIEZALEŻNY od bieżącego `entitlement_instance.state` (wiersz persystuje mimo
 *     dalszych przejść stanu REDEEMED_FULL→SETTLED→CLOSED / EXPIRED→CLOSED) — H1;
 *   - PER-RATA (NOT EXISTS po `transaction_id` = PK `ledger_posting_applied`) — H2;
 *   - obejmuje REDEEMED_PARTIAL (każda rata = osobny wiersz z własnym redemption_id).
 *
 * Dopóki E3/E4 nie zmaterializują projekcji, kontenerowe wiring jest INERT (port
 * niepodpięty → early-return w `voucherLedgerReconciliationJob`). Reconciliation
 * re-derywuje `transaction_id` i fail-closed odrzuca dryf precomputed id.
 */
export const EXPECTED_EVENT_PROJECTION = "voucher_ledger_expected_event" as const

export function createPgExpectedEventScanner(
  pool: LedgerPgPool
): ExpectedLedgerEventSource {
  return {
    async scanExpectedEventsWithoutPosting(): Promise<ExpectedLedgerEventRef[]> {
      const client = await pool.connect()
      try {
        const res = await client.query<{
          expected_transaction_id: string
          entitlement_id: string
          lifecycle_event: string
          redemption_id: string | null
          remaining_gross_snapshot: string | number | null
          market_id: string | null
        }>(
          // NOT EXISTS po transaction_id (PK) = per-rata (H2); projekcja jest
          // niezależna od bieżącego stanu entitlementu (H1).
          `SELECT pe.expected_transaction_id AS expected_transaction_id,
                  pe.entitlement_id          AS entitlement_id,
                  pe.lifecycle_event         AS lifecycle_event,
                  pe.redemption_id           AS redemption_id,
                  pe.remaining_gross_snapshot AS remaining_gross_snapshot,
                  pe.market_id               AS market_id
             FROM ${EXPECTED_EVENT_PROJECTION} pe
            WHERE NOT EXISTS (
                    SELECT 1 FROM ledger_posting_applied a
                     WHERE a.transaction_id = pe.expected_transaction_id
                  )`
        )
        return res.rows.map((row) => ({
          entitlement_id: row.entitlement_id,
          lifecycle_event: row.lifecycle_event as VoucherLifecycleEvent,
          redemption_id: row.redemption_id ?? null,
          remaining_gross_snapshot:
            row.remaining_gross_snapshot == null
              ? null
              : Number(row.remaining_gross_snapshot),
          market_id: row.market_id ?? null,
          expected_transaction_id: row.expected_transaction_id,
        }))
      } finally {
        client.release?.()
      }
    },
  }
}

export function createPgRefundedScanner(
  pool: LedgerPgPool
): RefundedEntitlementScanner {
  return {
    async scanRefundedTerminal(): Promise<RefundedEntitlementRef[]> {
      const client = await pool.connect()
      try {
        // REFUNDED jest GENUINELY terminalny (brak outbound transitions —
        // models/entitlement.ts) ⇒ skan po stanie jest tu odporny (M1).
        const res = await client.query<{ id: string; market_id: string | null }>(
          `SELECT e.id AS id, e.market_id AS market_id
             FROM entitlement_instance e
            WHERE e.state = 'REFUNDED'`
        )
        return res.rows.map((row) => ({
          entitlement_id: row.id,
          market_id: row.market_id ?? null,
        }))
      } finally {
        client.release?.()
      }
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Medusa cron entrypoint (kontenerowe wiring).
// ──────────────────────────────────────────────────────────────────────────

function resolveLogger(container?: MedusaContainer): ReconciliationLogger {
  const fallback: ReconciliationLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, e) => console.error(`[${SCHEDULE_NAME}] ${m}`, e),
  }
  try {
    const resolved = (container as { resolve?: (k: string) => unknown })?.resolve?.(
      "logger"
    ) as ReconciliationLogger | undefined
    return resolved && typeof resolved.error === "function" ? resolved : fallback
  } catch {
    return fallback
  }
}

/**
 * Kontenerowe wejście crona. Projekcja oczekiwanych zdarzeń + snapshot store
 * (audit envelope) są podpinane w E3/E4; dopóki port snapshotów nie istnieje w
 * kontenerze, job jest INERT (świadomy no-op — runtime posting jeszcze nieaktywny
 * per ADR-139 D5). Gdy port jest obecny, uruchamia pełny inwariant na realnym PG.
 *
 * L4/D5: `runtimeEnabled` resolvowany z `voucherLedgerPostingEnabled` (default
 * `false`). Dopóki posting nieaktywny, dosyłka jest WSTRZYMANA (a oczekiwane
 * zdarzenia ⇒ alarm kontraktowy), zgodnie z „persystencja ≠ aktywacja".
 */
export default async function voucherLedgerReconciliationJob(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container)
  const resolve = (container as { resolve?: (k: string) => unknown })?.resolve

  const snapshots = (() => {
    try {
      return resolve?.("voucherLedgerSnapshotSource") as
        | LedgerSnapshotSource
        | undefined
    } catch {
      return undefined
    }
  })()

  if (!snapshots) {
    logger.info(
      `snapshot source niepodpięty (E3/E4 pending, runtime posting nieaktywny ` +
        `per ADR-139 D5) — inwariant reconciliation INERT w tym cyklu.`
    )
    return
  }

  const pool = (() => {
    try {
      const url = process.env.DATABASE_URL
      if (!url) return undefined
      // lazy require by uniknąć importu pg gdy job inert
      const { Pool } = require("pg") as typeof import("pg")
      return new Pool({ connectionString: url }) as unknown as LedgerPgPool
    } catch {
      return undefined
    }
  })()

  if (!pool) {
    logger.warn(`brak DATABASE_URL/pg — pomijam cykl (NIE alarm: brak stacku).`)
    return
  }

  const writer = new VoucherLedgerWriter(pool)
  const expected = createPgExpectedEventScanner(pool)
  const refunded = createPgRefundedScanner(pool)
  const metrics = (() => {
    try {
      return resolve?.("voucherLedgerMetrics") as ReconciliationMetrics | undefined
    } catch {
      return undefined
    }
  })()
  // L4/D5: resolver-driven runtime flag (warstwa 1). Default false (bezpiecznie) —
  // posting NIE jest aktywny dopóki E6/P6 nie zrobi governed flip; do tego czasu
  // const `runtime_enabled` w profilu też jest false (spójność).
  const runtimeEnabled = (() => {
    try {
      const flag = resolve?.("voucherLedgerPostingEnabled") as boolean | undefined
      return (flag ?? false) && VOUCHER_LIABILITY_ONLY_V1.runtime_enabled
    } catch {
      return false
    }
  })()

  await runVoucherLedgerReconciliation({
    expected,
    refunded,
    snapshots,
    writer,
    logger,
    metrics,
    runtimeEnabled,
  })
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
