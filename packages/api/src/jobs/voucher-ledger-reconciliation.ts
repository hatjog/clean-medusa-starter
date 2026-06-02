/**
 * voucher-ledger-reconciliation — Story 2.6 (v1.11.0 Epic 2 / Wave 2).
 * Podstawa: ADR-139 D2 (atomowość post-COMMIT + reconciliation-INWARIANT).
 *
 * INWARIANT KOMPLETNOŚCI, NIE TEST. Posting entitlement-ledgera jest post-COMMIT
 * i best-effort (event emit może 2× zawieść ⇒ event nie trafia na bus). Ten job
 * jest JEDYNĄ gwarancją, że każdy terminalny entitlement ma swój wpis księgowy:
 * skanuje terminalne entitlementy bez wpisu w `ledger_posting_applied` i dosyła
 * posting z PERSYSTOWANEGO SNAPSHOTU ZDARZENIA (audit envelope) — NIE z live state
 * (live state mógł się zmienić; snapshot jest SSOT zdarzenia, ADR-139 D2).
 *
 * FAIL-CLOSED: brak snapshotu dla terminalnego entitlementu ⇒ ALARM (log error +
 * metryka), NIGDY cicha dosyłka i NIGDY silent skip. Brakujący snapshot to luka
 * audytowalności — musi być widoczny operacyjnie (monitoring LNE).
 *
 * GRANICE (ADR-139 D5 / §Granice):
 *   - NIE aktywuje postingu (`runtime_enabled` zostaje `false`) — job tylko domyka
 *     kompletność istniejącej zdolności;
 *   - NIE reconcile `REFUNDED` (refund-after-redeem OUT-OF-SCOPE, osobny ADR) —
 *     domyślny scan wyklucza REFUNDED;
 *   - dosyłka idzie przez `VoucherLedgerWriter` (idempotentny) → ponowny przebieg
 *     jest no-op dla już-dosłanych.
 *
 * Snapshot store (audit envelope) jest persystowany przez E3/E4 (okablowanie
 * order-flow). Ta story dostarcza INWARIANT + jego punkty zależności jako
 * wstrzykiwalne porty (testowalne bez live-stacku). Dopóki snapshot store nie jest
 * podpięty (pre-E3), kontenerowe wiring jest INERT (świadomy no-op, NIE silent
 * skip brakującego snapshotu znanego entitlementu — patrz `runFromContainer`).
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import {
  generateVoucherPosting,
  type VoucherLifecycleEvent,
  type VoucherPostingInput,
} from "../modules/voucher/posting-profile"
import {
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

/** Referencja terminalnego entitlementu wymagającego wpisu księgowego. */
export type TerminalEntitlementRef = {
  entitlement_id: string
  lifecycle_event: VoucherLifecycleEvent
  market_id: string
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

/** Port: skan terminalnych entitlementów bez wpisu w ledger_posting_applied. */
export type TerminalEntitlementScanner = {
  scanTerminalWithoutPosting(): Promise<TerminalEntitlementRef[]>
}

/** Port: odczyt persystowanego snapshotu zdarzenia (audit envelope). */
export type LedgerSnapshotSource = {
  loadSnapshot(ref: TerminalEntitlementRef): Promise<LedgerEventSnapshot | null>
}

export type ReconciliationDeps = {
  scanner: TerminalEntitlementScanner
  snapshots: LedgerSnapshotSource
  writer: Pick<VoucherLedgerWriter, "write">
  logger: ReconciliationLogger
  metrics?: ReconciliationMetrics
}

export type ReconciliationAlarm = {
  entitlement_id: string
  lifecycle_event: VoucherLifecycleEvent
  reason: "missing_snapshot"
}

export type ReconciliationReport = {
  scanned: number
  /** wpisy fizycznie dosłane (writer applied=true). */
  backfilled: number
  /** wpisy które okazały się już zaksięgowane (idempotencja, deduped). */
  deduped: number
  /** snapshoty dające no-op księgowy (np. SPV REDEEMED, EXPIRED bez salda). */
  noop: number
  /** ALARMY fail-closed (brak snapshotu) — luki kompletności. */
  alarms: ReconciliationAlarm[]
}

const METRIC_MISSING_SNAPSHOT = "voucher_ledger.reconciliation.missing_snapshot"
const METRIC_BACKFILLED = "voucher_ledger.reconciliation.backfilled"

/**
 * Uruchamia inwariant reconciliation. Zwraca raport. Dla KAŻDEGO terminalnego
 * entitlementu bez wpisu:
 *   - snapshot OBECNY  → odtwórz posting z snapshotu i dosyłaj przez writer
 *                        (idempotentnie); no-op księgowy gdy `posted:false`;
 *   - snapshot BRAK    → ALARM fail-closed (log error + metryka), NIE cicha dosyłka.
 *
 * Job NIE rzuca przy pojedynczym alarmie (skanuje całość), ale alarmy są zwrócone
 * w raporcie i zalogowane na error — monitoring LNE je wychwytuje.
 */
export async function runVoucherLedgerReconciliation(
  deps: ReconciliationDeps
): Promise<ReconciliationReport> {
  const { scanner, snapshots, writer, logger, metrics } = deps
  const report: ReconciliationReport = {
    scanned: 0,
    backfilled: 0,
    deduped: 0,
    noop: 0,
    alarms: [],
  }

  const refs = await scanner.scanTerminalWithoutPosting()
  report.scanned = refs.length

  for (const ref of refs) {
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
        market_id: ref.market_id,
      })
      logger.error(
        `[${SCHEDULE_NAME}] ALARM fail-closed: terminalny entitlement ` +
          `'${ref.entitlement_id}' (${ref.lifecycle_event}) bez persystowanego ` +
          `snapshotu zdarzenia — NIE dosyłam z live state (ADR-139 D2). ` +
          `Luka kompletności do interwencji operacyjnej.`
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
        market_id: ref.market_id,
      })
    } else {
      report.deduped += 1
    }
  }

  if (report.alarms.length > 0) {
    logger.error(
      `[${SCHEDULE_NAME}] zakończono z ${report.alarms.length} alarmami ` +
        `(brak snapshotu) na ${report.scanned} skanowanych — interwencja wymagana.`
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
// Domyślny scanner PG (terminalne entitlementy bez wpisu — bez JOIN dzięki
// denormalizacji market_id; ADR-139 D1/D2).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mapowanie stanu terminalnego → lifecycle_event księgowy. REFUNDED CELOWO
 * pominięty (OUT-OF-SCOPE, ADR-139 §Granice — refund-after-redeem osobny ADR).
 */
const TERMINAL_STATE_TO_LIFECYCLE: ReadonlyArray<{
  state: string
  lifecycle_event: VoucherLifecycleEvent
}> = [
  { state: "REDEEMED_FULL", lifecycle_event: "REDEEMED" },
  { state: "EXPIRED", lifecycle_event: "EXPIRED" },
]

export function createPgTerminalScanner(
  pool: LedgerPgPool
): TerminalEntitlementScanner {
  return {
    async scanTerminalWithoutPosting(): Promise<TerminalEntitlementRef[]> {
      const client = await pool.connect()
      try {
        const out: TerminalEntitlementRef[] = []
        for (const { state, lifecycle_event } of TERMINAL_STATE_TO_LIFECYCLE) {
          const res = await client.query<{ id: string; market_id: string | null }>(
            `SELECT e.id AS id, e.market_id AS market_id
               FROM entitlement_instance e
              WHERE e.state = $1
                AND NOT EXISTS (
                  SELECT 1 FROM ledger_posting_applied a
                   WHERE a.entitlement_id = e.id
                     AND a.lifecycle_event = $2
                )`,
            [state, lifecycle_event]
          )
          for (const row of res.rows) {
            out.push({
              entitlement_id: row.id,
              lifecycle_event,
              market_id: row.market_id ?? "unknown",
            })
          }
        }
        return out
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
 * Kontenerowe wejście crona. Snapshot store (audit envelope) jest podpinany w
 * E3/E4; dopóki port nie istnieje w kontenerze, job jest INERT (świadomy no-op —
 * NIE silent skip znanej luki: po prostu brak źródła snapshotów do działania,
 * runtime posting jeszcze nieaktywny per ADR-139 D5). Gdy port jest obecny,
 * uruchamia pełny inwariant na realnym PG.
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
  const scanner = createPgTerminalScanner(pool)
  const metrics = (() => {
    try {
      return resolve?.("voucherLedgerMetrics") as ReconciliationMetrics | undefined
    } catch {
      return undefined
    }
  })()

  await runVoucherLedgerReconciliation({
    scanner,
    snapshots,
    writer,
    logger,
    metrics,
  })
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
