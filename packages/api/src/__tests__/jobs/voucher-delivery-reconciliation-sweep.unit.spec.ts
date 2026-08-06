/**
 * voucher-delivery-reconciliation-sweep.unit.spec.ts — Story 2.5 (AC1–AC5).
 *
 * Testy biegną BEZ kontenera Medusy, BEZ żywego Postgresa i BEZ SIECI. Atrapa
 * SQL (wzorzec 2.3) egzekwuje te niezmienniki bazy, na których stoi „zero
 * podwójnych maili":
 *   - `UNIQUE (entitlement_id, template_key, recipient_hash)` z `ON CONFLICT
 *     DO NOTHING`,
 *   - warunkowe `UPDATE … WHERE status = …` (0 wierszy, gdy guard nie pasuje),
 *   - guard staleness przy przejęciu porzuconego `queued` (`queued_at < próg`),
 *   - filtry skanu luk (wiek entitlementu, stan, status wiersza, limit batcha).
 * Dodatkowo atrapa pilnuje dialektu bindingów (do sterownika trafia wyłącznie
 * `?`), a `voucher-delivery-sql-dialect.unit.spec.ts` przepuszcza TEN SAM SQL
 * przez REALNY formatter Knexa.
 *
 * Żaden test nie może wysłać maila: dispatcher jest atrapą, klient Brevo nigdy
 * nie powstaje.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  ABANDONED_QUEUED_ERROR_CODE,
  buildSweepTrigger,
  config as sweepConfig,
  METRIC_GAP,
  METRIC_HEARTBEAT,
  runVoucherDeliveryReconciliationSweep,
  SCHEDULE_CRON,
  SCHEDULE_NAME,
  SWEEP_BATCH_LIMIT,
  SWEEP_ENTITLEMENT_GRACE_MS,
  SWEEP_EXPECTED_TEMPLATE_KEYS,
  SWEEP_GAP_LOOKBACK_MS,
  SWEEP_LEDGER_EPOCH_ENV,
  SWEEP_MAX_ATTEMPT_COUNT,
  SWEEP_SOURCE_ENTITLEMENT_TYPES,
  SWEEP_SOURCE_STATES,
  SWEEP_STALE_QUEUED_MS,
  isGlobalFailureErrorCode,
  resolveScanWindowStart,
  resolveSweepMetrics,
  type SweepDeps,
  type SweepMetricsPort,
} from "../../jobs/voucher-delivery-reconciliation-sweep"
import {
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
  type DeliveryGapScanPort,
  type DispatchLedgerPort,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { DISPATCH_STATES_ALLOWING_RETRY } from "../../modules/voucher-delivery/delivery-state"
import {
  handleVoucherPurchaseDelivery,
  MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE,
  STALE_QUEUED_THRESHOLD_MS,
  type PurchaseDeliveryDeps,
} from "../../subscribers/voucher-purchase-delivery"
import type { MarketRuntimeConfigRow } from "../../lib/read-market-locales"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"
import {
  isNotificationProviderReady,
  isNotificationProviderReadyForSweep,
} from "../../lib/vendor-notification-provider-readiness"
import {
  __resetPosthogMetricsClientForTests,
  getPosthogCaptureClient,
  POSTHOG_CONTAINER_KEY,
} from "../../lib/instrumentation/posthog-metrics-client"
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

const NOW = new Date("2026-07-26T12:00:00.000Z")
const BUYER_EMAIL = "Kupujaca@Example.Test"
const VOUCHER_CODE = "BB-ABCD-1234"
const MARKET_ID = "bonbeauty"
const TEMPLATE_KEY = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION

/** Znacznik czasu „o `minutes` minut przed NOW". */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString()
}

const OLD_ENOUGH = minutesAgo(90)
const TOO_FRESH = minutesAgo(5)

type Row = Record<string, unknown>

type EntitlementSeed = {
  id: string
  state: string
  market_id?: string | null
  created_at: string
  /** R-2.5-H4 — domyślnie voucher; typy spoza matrycy testujemy jawnie. */
  entitlement_type?: string
}

type DispatchSeed = {
  dispatch_id: string
  entitlement_id: string
  template_key?: string
  recipient_email?: string
  status: string
  queued_at?: string
  attempt_count?: number
  error_code?: string | null
  first_error_code?: string | null
  configuration_recovery_count?: number
  market_id?: string | null
}

/** Guard dialektu — ten sam, co w teście ledgera 2.3 (R-2.3-H1). */
function assertKnexDialect(sql: string, bindings: readonly unknown[]): void {
  const pgPlaceholders = sql.match(/\$\d+/g)
  if (pgPlaceholders) {
    throw new Error(
      `SQL trafił do sterownika z placeholderami dialektu pg (${pgPlaceholders.join(", ")})`,
    )
  }
  const expected = (sql.match(/\?/g) ?? []).length
  if (expected !== bindings.length) {
    throw new Error(`Expected ${expected} bindings, saw ${bindings.length}`)
  }
  const arrayBinding = bindings.findIndex((value) => Array.isArray(value))
  if (arrayBinding >= 0) {
    throw new Error(`Binding #${arrayBinding + 1} jest tablicą`)
  }
}

/**
 * Atrapa SQL: ledger 2.3 + skan luk 2.5 nad dwiema tabelami w pamięci.
 *
 * Bindingi skanu są odczytywane OD KOŃCA, bo tylko zbiór szablonów ma zmienną
 * długość: [szablony…, stany źródłowe(2), created_before, stale_before,
 * stany retry(2), limit]. Długości stałych zbiorów są asertowane, żeby zmiana
 * `DISPATCH_STATES_ALLOWING_RETRY` czy `SWEEP_SOURCE_STATES` zapaliła ten test,
 * a nie po cichu przesunęła odczyt.
 */
class FakeSql implements DispatchLedgerSql {
  readonly dispatch: Row[] = []
  readonly entitlements: Row[] = []
  readonly audit: Row[] = []
  readonly statements: string[] = []

  seedEntitlement(seed: EntitlementSeed): void {
    this.entitlements.push({
      id: seed.id,
      state: seed.state,
      market_id: seed.market_id === undefined ? MARKET_ID : seed.market_id,
      created_at: seed.created_at,
      entitlement_type: seed.entitlement_type ?? "VOUCHER_AMOUNT",
    })
  }

  seedDispatch(seed: DispatchSeed): void {
    this.dispatch.push({
      dispatch_id: seed.dispatch_id,
      entitlement_id: seed.entitlement_id,
      template_key: seed.template_key ?? TEMPLATE_KEY,
      recipient_hash: hashRecipientEmail(seed.recipient_email ?? BUYER_EMAIL),
      market_id: seed.market_id === undefined ? MARKET_ID : seed.market_id,
      flow_id: "voucher_purchase_delivery",
      locale: "pl",
      status: seed.status,
      provider: null,
      provider_message_id: null,
      error_code: seed.error_code ?? null,
      first_error_code: seed.first_error_code ?? null,
      configuration_recovery_count: seed.configuration_recovery_count ?? 0,
      attempt_count: seed.attempt_count ?? 1,
      queued_at: seed.queued_at ?? minutesAgo(60),
      sent_at: null,
      failed_at: null,
    })
  }

  /** Zapytania mutujące — AC4 sprawdza, że no-op nie wykonuje żadnego. */
  get mutatingStatements(): string[] {
    return this.statements.filter(
      (s) => s.startsWith("INSERT") || s.startsWith("UPDATE"),
    )
  }

  async raw(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
    assertKnexDialect(sql, bindings)
    const q = sql.replace(/\s+/g, " ").trim()
    this.statements.push(q)

    if (q.includes(`INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE}`)) {
      const [
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        from_status,
        to_status,
        error_code,
        attempt_count,
        occurred_at,
      ] = bindings
      this.audit.push({
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        from_status,
        to_status,
        error_code,
        attempt_count,
        occurred_at,
      })
      return { rows: [] }
    }

    if (q.includes(`INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)) {
      const [d, e, t, h, m, f, l, now] = bindings as string[]
      // UNIQUE + ON CONFLICT DO NOTHING.
      if (this.find(e, t, h)) return { rows: [] }
      const row: Row = {
        dispatch_id: d,
        entitlement_id: e,
        template_key: t,
        recipient_hash: h,
        market_id: m,
        flow_id: f,
        locale: l,
        status: "queued",
        provider: null,
        provider_message_id: null,
        error_code: null,
        configuration_recovery_count: 0,
        attempt_count: 1,
        queued_at: now,
        sent_at: null,
        failed_at: null,
      }
      this.dispatch.push(row)
      return { rows: [{ ...row }] }
    }

    if (q.includes("COUNT(*)::int AS parked")) {
      return { rows: this.countParkedByMarket(bindings) }
    }

    if (q.includes("COUNT(*)::int")) {
      return { rows: [{ gap_count: this.countBeyondStates(bindings) }] }
    }

    if (q.includes("CROSS JOIN (VALUES")) {
      return { rows: this.scanGaps(bindings) }
    }

    if (q.includes("JOIN entitlement_instance e ON e.id = d.entitlement_id")) {
      return { rows: this.scanStalled(bindings) }
    }

    if (q.includes("WHERE attempt_count >=") && q.includes("entitlement_id IN")) {
      return { rows: this.listParked(bindings) }
    }

    if (q.includes("SET attempt_count = LEAST")) {
      const [maxAttemptCount, , maxConfigurationRecoveries] = bindings as number[]
      const globalCodes = bindings.slice(3).map(String)
      const released = this.dispatch.filter(
        (row) =>
          row.status === "failed" &&
          Number(row.attempt_count ?? 0) >= maxAttemptCount &&
          row.error_code === "VOUCHER_DELIVERY_DISPATCH_FAILED" &&
          Number(row.configuration_recovery_count ?? 0) < maxConfigurationRecoveries &&
          (globalCodes.includes(String(row.first_error_code)) ||
            String(row.first_error_code).endsWith("_NOT_CONFIGURED")),
      )
      for (const row of released) {
        row.attempt_count = maxAttemptCount - 1
        row.configuration_recovery_count = Number(row.configuration_recovery_count ?? 0) + 1
      }
      return { rows: released.map((row) => ({ ...row })) }
    }

    if (q.includes("SET attempt_count = GREATEST")) {
      // releaseAttemptBudget (2.5, R-2.5-H3): guard status + kod błędu.
      const [, id, errorCode, maxConfigurationRecoveries] = bindings as string[]
      const row = this.byId(id)
      if (!row || row.status !== "failed" || row.error_code !== errorCode) {
        return { rows: [] }
      }
      if (Number(row.attempt_count ?? 0) <= 0) return { rows: [] }
      if (
        Number(row.configuration_recovery_count ?? 0) >=
        Number(maxConfigurationRecoveries)
      ) {
        return { rows: [] }
      }
      row.attempt_count = Math.max(Number(row.attempt_count) - 1, 1)
      row.configuration_recovery_count =
        Number(row.configuration_recovery_count ?? 0) + 1
      return { rows: [{ ...row }] }
    }

    if (q.startsWith("SELECT")) {
      const [e, t, h] = bindings as string[]
      const row = this.find(e, t, h)
      return { rows: row ? [{ ...row }] : [] }
    }

    if (q.includes(`UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)) {
      if (q.includes("SET status = 'sent'")) {
        // Liczymy od KONCA: `dispatch_id` (guard WHERE) jest ostatnim
        // wystapieniem, wiec dolozenie kolejnej kolumny SET nie przesuwa guardu.
        const values = bindings as (string | null)[]
        const id = values[values.length - 1] as string
        const now = values[values.length - 2] as string
        const [provider, messageId, correlationToken] = values
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "sent",
          provider,
          provider_message_id: messageId,
          // Zachowanie wywodzone z SQL-a pod testem, nie z uprzejmosci atrapy.
          correlation_token: q.includes("correlation_token = COALESCE(")
            ? correlationToken ?? row.correlation_token ?? null
            : correlationToken ?? null,
          error_code: null,
          sent_at: now,
        })
        return { rows: [{ ...row }] }
      }

      if (q.includes("provider = COALESCE")) {
        // markFailed (2.3): guard `status='queued'`.
        // `toKnexPositionalSql` rozwija bindingi w kolejnosci WYSTAPIEN `?`.
        // `dispatch_id` (guard WHERE) jest OSTATNIM wystapieniem, a odpowiedz
        // providera dwoma tuz przed nim — liczymy od konca, zeby dolozenie
        // kolejnej kolumny SET nie przesunelo znowu calej listy (dokladnie ten
        // ksztalt zlamal sie przy dodaniu `provider_status_code`).
        const [provider, errorCode, , now] = bindings as string[]
        const id = bindings[bindings.length - 1] as string
        const providerStatusCode = bindings[bindings.length - 3] ?? null
        const providerMessage = bindings[bindings.length - 2] ?? null
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "failed",
          provider: provider ?? row.provider,
          error_code: errorCode,
          first_error_code: row.first_error_code ?? errorCode,
          failed_at: now,
          provider_status_code: providerStatusCode,
          provider_message: providerMessage,
        })
        return { rows: [{ ...row }] }
      }

      if (q.includes("SET status = 'failed'")) {
        // abandonStaleQueued (2.5, D3): guard `status='queued' AND queued_at < prog`.
        const [errorCode, , now, , , id, staleBefore] = bindings as string[]
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        if (!(String(row.queued_at) < staleBefore)) return { rows: [] }
        Object.assign(row, {
          status: "failed",
          error_code: errorCode,
          first_error_code: row.first_error_code ?? errorCode,
          failed_at: now,
          // Przejecie PORZUCONEJ rezerwacji nie ma odpowiedzi providera:
          // proces, ktory wysylal, zniknal.
          provider_status_code: null,
          provider_message: null,
        })
        return { rows: [{ ...row }] }
      }

      // Przejęcie retry (2.3): guard `status IN (?, ?)`.
      const [now, , locale, market_id, flow_id, id, ...allowed] =
        bindings as string[]
      const row = this.byId(id)
      if (!row || !allowed.includes(row.status as string)) return { rows: [] }
      Object.assign(row, {
        status: "queued",
        attempt_count: Number(row.attempt_count ?? 0) + 1,
        error_code: null,
        failed_at: null,
        queued_at: now,
        locale,
        market_id,
        flow_id,
      })
      return { rows: [{ ...row }] }
    }

    throw new Error(`FakeSql: nieobsłużone zapytanie: ${q}`)
  }

  /**
   * Bindingi skanu, od końca (tylko zbiór szablonów ma zmienną długość):
   * [szablony…, stany(2), typy(2), created_before, created_after,
   *  stale_before, stany retry(2), max_attempt_count, limit].
   */
  private scanGaps(bindings: readonly unknown[]): Row[] {
    const b = bindings as (string | number)[]
    const L = b.length
    expect(SWEEP_SOURCE_STATES).toHaveLength(2)
    expect(SWEEP_SOURCE_ENTITLEMENT_TYPES).toHaveLength(2)
    expect(DISPATCH_STATES_ALLOWING_RETRY).toHaveLength(2)
    const limit = Number(b[L - 1])
    const maxAttemptCount = Number(b[L - 2])
    const retryStates = b.slice(L - 4, L - 2).map(String)
    const staleBefore = String(b[L - 5])
    const createdAfter = String(b[L - 6])
    const createdBefore = String(b[L - 7])
    const types = b.slice(L - 9, L - 7).map(String)
    const states = b.slice(L - 11, L - 9).map(String)
    const templates = b.slice(0, L - 11).map(String)

    const rows: Row[] = []
    const candidates: Row[] = []

    for (const entitlement of this.entitlements) {
      if (!states.includes(String(entitlement.state))) continue
      if (!types.includes(String(entitlement.entitlement_type))) continue
      if (!(String(entitlement.created_at) < createdBefore)) continue
      // R-2.5-H1 — dolna granica okna (backfill-guard).
      if (!(String(entitlement.created_at) >= createdAfter)) continue

      for (const templateKey of [...templates].sort()) {
        const row = this.dispatch.find(
          (d) =>
            d.entitlement_id === entitlement.id &&
            d.template_key === templateKey,
        )
        const isGap =
          !row ||
          (row.status === "queued" && String(row.queued_at) < staleBefore) ||
          retryStates.includes(String(row.status))
        if (!isGap) continue
        // R-2.5-H3 — zaparkowane wiersze NIE wracają ze skanu.
        if (row && Number(row.attempt_count ?? 0) >= maxAttemptCount) continue

        candidates.push({
          entitlement_id: entitlement.id,
          market_id: entitlement.market_id,
          entitlement_state: entitlement.state,
          template_key: templateKey,
          dispatch_id: row?.dispatch_id ?? null,
          dispatch_status: row?.status ?? null,
          queued_at: row?.queued_at ?? null,
          attempt_count: row?.attempt_count ?? 0,
          created_at: entitlement.created_at,
        })
      }
    }

    // ORDER BY COALESCE(attempt_count, 0), created_at, id, template_key —
    // wiersze z wieloma nieudanymi próbami NIE wypychają świeżych luk.
    candidates.sort((a, z) => {
      const attempts = Number(a.attempt_count ?? 0) - Number(z.attempt_count ?? 0)
      if (attempts !== 0) return attempts
      const created = String(a.created_at).localeCompare(String(z.created_at))
      if (created !== 0) return created
      const id = String(a.entitlement_id).localeCompare(String(z.entitlement_id))
      if (id !== 0) return id
      return String(a.template_key).localeCompare(String(z.template_key))
    })

    // Sterownik dostaje `limit + 1` (sonda `truncated`, R-2.5-I13).
    for (const candidate of candidates) {
      const { created_at: _created, ...row } = candidate
      rows.push(row)
      if (rows.length >= limit) break
    }

    return rows
  }

  /** Skan STALLED sterowany ledgerem (R-2.5-M8). */
  private scanStalled(bindings: readonly unknown[]): Row[] {
    const b = bindings as (string | number)[]
    const L = b.length
    const limit = Number(b[L - 1])
    const createdAfter = String(b[L - 2])
    const createdBefore = String(b[L - 3])
    const types = b.slice(L - 5, L - 3).map(String)
    const states = b.slice(L - 7, L - 5).map(String)
    const maxAttemptCount = Number(b[L - 8])
    const retryStates = b.slice(0, L - 8).map(String)

    const rows: Row[] = []
    for (const dispatch of this.dispatch) {
      if (!retryStates.includes(String(dispatch.status))) continue
      if (Number(dispatch.attempt_count ?? 0) >= maxAttemptCount) continue
      const entitlement = this.entitlements.find(
        (e) => e.id === dispatch.entitlement_id,
      )
      if (!entitlement) continue
      if (!states.includes(String(entitlement.state))) continue
      if (!types.includes(String(entitlement.entitlement_type))) continue
      if (!(String(entitlement.created_at) < createdBefore)) continue
      if (!(String(entitlement.created_at) >= createdAfter)) continue

      rows.push({
        entitlement_id: entitlement.id,
        market_id: entitlement.market_id,
        entitlement_state: entitlement.state,
        template_key: dispatch.template_key,
        dispatch_id: dispatch.dispatch_id,
        dispatch_status: dispatch.status,
        queued_at: dispatch.queued_at,
        attempt_count: dispatch.attempt_count,
      })
      if (rows.length >= limit) break
    }
    return rows
  }

  /** Wiersze zaparkowane wskazanych entitlementów (R-2.5-M6). */
  private listParked(bindings: readonly unknown[]): Row[] {
    const [max, ...ids] = bindings.map(String)
    return this.parkedRows(Number(max)).filter((row) =>
      ids.includes(String(row.entitlement_id)),
    )
  }

  /** Zaparkowane per rynek (R-2.5-H3) — nośnik alertu. */
  private countParkedByMarket(bindings: readonly unknown[]): Row[] {
    const byMarket = new Map<string | null, number>()
    for (const row of this.parkedRows(Number(bindings[0]))) {
      const key = (row.market_id ?? null) as string | null
      byMarket.set(key, (byMarket.get(key) ?? 0) + 1)
    }
    return [...byMarket.entries()].map(([market_id, parked]) => ({
      market_id,
      parked,
    }))
  }

  private parkedRows(maxAttemptCount: number): Row[] {
    return this.dispatch.filter(
      (row) =>
        Number(row.attempt_count ?? 0) >= maxAttemptCount &&
        !["sent", "delivered", "degraded"].includes(String(row.status)),
    )
  }

  /**
   * Bindingi licznika H1: [stany(2), typy(2), created_before, created_after,
   * szablony…, liczba oczekiwanych szablonów].
   */
  private countBeyondStates(bindings: readonly unknown[]): number {
    const b = bindings.map(String)
    const states = b.slice(0, 2)
    const types = b.slice(2, 4)
    const createdBefore = b[4]
    const createdAfter = b[5]
    const templates = b.slice(6, b.length - 1)
    const expectedTemplateCount = Number(b[b.length - 1])

    return this.entitlements.filter((entitlement) => {
      if (states.includes(String(entitlement.state))) return false
      if (!types.includes(String(entitlement.entitlement_type))) return false
      const createdAt = String(entitlement.created_at)
      if (!(createdAt < createdBefore)) return false
      if (!(createdAt >= createdAfter)) return false
      // R-2.5-L11: brakuje CHOĆ JEDNEGO oczekiwanego szablonu (ta sama
      // jednostka co skan), nie „nie ma żadnego wiersza".
      const present = new Set(
        this.dispatch
          .filter(
            (d) =>
              d.entitlement_id === entitlement.id &&
              templates.includes(String(d.template_key)),
          )
          .map((d) => String(d.template_key)),
      )
      return present.size < expectedTemplateCount
    }).length
  }

  private find(e: string, t: string, h: string): Row | undefined {
    return this.dispatch.find(
      (r) =>
        r.entitlement_id === e && r.template_key === t && r.recipient_hash === h,
    )
  }

  private byId(id: string): Row | undefined {
    return this.dispatch.find((r) => r.dispatch_id === id)
  }
}

type LogEntry = { level: "info" | "warn" | "error"; message: string; meta?: unknown }

function makeLogger() {
  const entries: LogEntry[] = []
  return {
    entries,
    info: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: "info", message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: "warn", message, meta }),
    error: (message: string, meta?: unknown) =>
      entries.push({ level: "error", message, meta }),
  }
}

function makeMetrics() {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = []
  const metrics: SweepMetricsPort = {
    capture: (event, properties) => captured.push({ event, properties }),
  }
  return { metrics, captured }
}

type HarnessOptions = {
  entitlements?: EntitlementSeed[]
  dispatchRows?: DispatchSeed[]
  providerReady?: boolean
  dispatchImpl?: (payload: Record<string, unknown>) => Promise<unknown>
  sql?: FakeSql
  ledgerOverride?: DispatchLedgerPort
  batchLimit?: number
  templateKeys?: readonly string[]
  giftSource?: boolean
  /** Prezent SPEŁNIAJĄCY predykat 2.4 (`now` + bound) — realna wysyłka handoffu. */
  eligibleGift?: boolean
  env?: NodeJS.ProcessEnv
  /**
   * Story 5.7 fix-round — `market_runtime_config` bez kompletu danych (albo
   * odczyt niedostępny). Kształt awarii, która kończy się PRZED wysyłką.
   */
  runtimeConfigRow?: MarketRuntimeConfigRow | null
  runtimeConfigDegraded?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const sql = options.sql ?? new FakeSql()
  for (const seed of options.entitlements ?? []) sql.seedEntitlement(seed)
  for (const seed of options.dispatchRows ?? []) sql.seedDispatch(seed)

  const logger = makeLogger()
  const { metrics, captured } = makeMetrics()
  const dispatchCalls: Array<Record<string, unknown>> = []
  let seq = 0

  const ledger = new PgDispatchLedger(sql, {
    uuid: () => `dispatch-sweep-${++seq}`,
    now: () => NOW,
  })

  const delivery: PurchaseDeliveryDeps = {
    sourceReader: {
      async findBuyerClaimSource() {
        return {
          buyer_email: BUYER_EMAIL,
          voucher_code: VOUCHER_CODE,
          market_id: MARKET_ID,
          purchase_locale: "pl",
          // Story 5.7 — projekcja niesie komplet danych treści maila; bez nich
          // builder odmawia zbudowania payloadu bez pokrycia kontraktu.
          customer_first_name: "Magda",
          seller_name: "Salon Bonbeauty",
          seller_handle: "salon-bonbeauty",
          order_id: "order_01KYSYPH78N80PE8YC85X6X3EK",
          order_display_id: "1042",
          purchase_date: "2026-07-30T09:15:00.000Z",
          voucher_expires_at: "2027-07-30T00:00:00.000Z",
          voucher_value_minor: 20000,
          voucher_currency: "PLN",
          salon_address_1: "ul. Handlowa 10",
          salon_address_2: null,
          salon_postal_code: "00-001",
          salon_city: "Warszawa",
          ...(options.giftSource
            ? {
                purchase_mode: "gift",
                gift_recipient_email: "obdarowana@example.test",
                // `immediate` NIE jest wartością kontraktu (ADR-163) — wariant
                // `eligibleGift` podaje `now`, gdy test potrzebuje wysyłki.
                gift_recipient_send_timing: options.eligibleGift
                  ? "now"
                  : "immediate",
                gift_recipient_bound_to_voucher_issue: options.eligibleGift
                  ? true
                  : undefined,
              }
            : {}),
        }
      },
    },
    ledger: options.ledgerOverride ?? ledger,
    dispatcher: {
      async dispatch(payload) {
        dispatchCalls.push(payload)
        if (options.dispatchImpl) return options.dispatchImpl(payload)
        return { id: "brevo-message-1" }
      },
    },
    marketLocales: {
      async read() {
        return {
          config: { default: "pl", supported: ["pl", "en", "ua", "de"] },
          degraded: false,
        }
      },
      // Story 5.7 (AC2) — dosyłka idzie tą samą ścieżką co subscriber, więc
      // potrzebuje tego samego, tabelowego źródła kontaktu i URL rynku.
      async readRuntimeConfig() {
        if (options.runtimeConfigRow !== undefined) {
          return {
            row: options.runtimeConfigRow,
            degraded: options.runtimeConfigDegraded ?? false,
          }
        }
        return {
          row: {
            locales: { default: "pl", supported: ["pl", "en", "ua", "de"] },
            support_email: "kontakt@bonbeauty.pl",
            market_url: "https://dev.bonbeauty.test",
          },
          degraded: false,
        }
      },
    },
    logger,
    env: { GP_STOREFRONT_URL_BONBEAUTY: "https://dev.bonbeauty.test" },
  }

  const deps: SweepDeps = {
    scanner: ledger,
    delivery,
    logger,
    metrics,
    now: () => NOW,
    isProviderReady: () => options.providerReady ?? true,
    batchLimit: options.batchLimit,
    templateKeys: options.templateKeys,
    // Okno skanu liczymy z JAWNEGO env — testy nie mogą zależeć od kotwicy
    // ustawionej na maszynie dewelopera.
    env: options.env ?? {},
  }

  return { deps, delivery, sql, logger, metrics, captured, dispatchCalls }
}

function issuedEntitlement(id: string, createdAt = OLD_ENOUGH): EntitlementSeed {
  return { id, state: "ISSUED", created_at: createdAt }
}

/**
 * Port skanu z podmienioną częścią metod. Metody `PgDispatchLedger` żyją na
 * PROTOTYPIE, więc `{...scanner}` zgubiłoby je bez śladu — bindujemy jawnie.
 */
function scannerWith(
  scanner: DeliveryGapScanPort,
  overrides: Partial<DeliveryGapScanPort>,
): DeliveryGapScanPort {
  return {
    scanDeliveryGaps: scanner.scanDeliveryGaps.bind(scanner),
    scanStalledDispatches: scanner.scanStalledDispatches.bind(scanner),
    countGapsBeyondSourceStates:
      scanner.countGapsBeyondSourceStates.bind(scanner),
    listParkedDispatches: scanner.listParkedDispatches.bind(scanner),
    countParkedDispatchesByMarket:
      scanner.countParkedDispatchesByMarket.bind(scanner),
    releaseParkedConfigurationFailureBudgets:
      scanner.releaseParkedConfigurationFailureBudgets.bind(scanner),
    abandonStaleQueued: scanner.abandonStaleQueued.bind(scanner),
    releaseAttemptBudget: scanner.releaseAttemptBudget.bind(scanner),
    ...overrides,
  }
}

// ── AC1: stałe i kształt joba ──────────────────────────────────────────────

describe("AC1 — cadence i próg wieku są ROZDZIELONYMI, nazwanymi stałymi", () => {
  it("D1: cadence to co 15 min, a `config` eksponuje ją wg konwencji jobów", () => {
    expect(SCHEDULE_CRON).toBe("*/15 * * * *")
    expect(sweepConfig).toEqual({
      name: SCHEDULE_NAME,
      schedule: SCHEDULE_CRON,
    })
  })

  it("próg wieku jest OSOBNĄ stałą, nie magiczną liczbą, i jest 2× cadence", () => {
    expect(SWEEP_ENTITLEMENT_GRACE_MS).toBe(30 * 60 * 1000)
    // Dwie różne liczby: „jak często patrzymy" ≠ „od kiedy to luka".
    expect(SWEEP_ENTITLEMENT_GRACE_MS).toBeGreaterThan(15 * 60 * 1000)
  })

  it("próg wieku ≥ progowi rozstrzygnięcia wysyłki w locie (`queued` z 2.3)", () => {
    // Inaczej sweep uznawałby entitlement za lukę, zanim rezerwacja jest
    // rozstrzygnięta — czyli ścigałby się z subscriberem.
    expect(SWEEP_ENTITLEMENT_GRACE_MS).toBeGreaterThanOrEqual(
      SWEEP_STALE_QUEUED_MS,
    )
  })

  it("D3: próg porzucenia `queued` REUŻYWA stałej z 2.3 (jedna definicja)", () => {
    expect(SWEEP_STALE_QUEUED_MS).toBe(STALE_QUEUED_THRESHOLD_MS)
  })

  it("zbiór oczekiwanych szablonów jest parametrem i dziś zawiera tylko szablon BEZWARUNKOWY", () => {
    expect([...SWEEP_EXPECTED_TEMPLATE_KEYS]).toEqual([TEMPLATE_KEY])
    // `voucher_handoff_link` jest warunkowy (gift ∧ „od razu") — w skanie
    // zamieniłby każdy zakup dla siebie w permanentną lukę.
    expect([...SWEEP_EXPECTED_TEMPLATE_KEYS]).not.toContain(
      NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK,
    )
  })

  it("stany źródłowe skanu to dokładnie ISSUED/ACTIVE (matryca AD-7)", () => {
    expect([...SWEEP_SOURCE_STATES]).toEqual(["ISSUED", "ACTIVE"])
  })
})

// ── AC5 (a): luka + sweep → jeden mail ─────────────────────────────────────

describe("AC5 (a) / AC2 — symulowany brak eventu kończy się mailem po sweepie", () => {
  it("entitlement ISSUED bez wiersza dispatch → dokładnie jeden mail i jeden wiersz `sent`", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_gap_1")],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.status).toBe("completed")
    expect(report.scanned).toBe(1)
    expect(report.attempted).toBe(1)
    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0]).toMatchObject({
      entitlement_id: "ent_gap_1",
      template_key: TEMPLATE_KEY,
      status: "sent",
    })
  })

  it("dosyłka idzie ŚCIEŻKĄ SUBSCRIBERA: ten sam szablon i locale zakupu", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_gap_2")],
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    expect(dispatchCalls[0]).toMatchObject({
      template: TEMPLATE_KEY,
    })
    expect(JSON.stringify(dispatchCalls[0])).toContain('"locale":"pl"')
  })

  it("ACTIVE (gdy ISSUED przepadł) jest dogoniony tak samo jak ISSUED", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [
        { id: "ent_active", state: "ACTIVE", created_at: OLD_ENOUGH },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
  })

  it("syntetyczny trigger niesie `scope.market_id` (bez niego rynek spadałby na fallback)", () => {
    expect(
      buildSweepTrigger({
        entitlement_id: "ent_x",
        market_id: MARKET_ID,
        entitlement_state: "ISSUED",
        template_key: TEMPLATE_KEY,
        dispatch_id: null,
        dispatch_status: null,
        queued_at: null,
        attempt_count: 0,
      }),
    ).toMatchObject({
      scope: { market_id: MARKET_ID },
      payload: { entitlement_id: "ent_x", to_state: "ISSUED", from_state: null },
    })
  })
})

// ── R-2.5-H1: dolna granica okna (backfill-guard) ──────────────────────────

describe("R-2.5-H1 — skan ma DOLNĄ granicę wieku: zero dosyłek do historii", () => {
  it("entitlement starszy niż okno skanu NIE dostaje maila", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [
        // Zakup sprzed wdrożenia ledgera 2.3 — z punktu widzenia LEFT JOIN-a
        // jest „luką", ale mail „dziękujemy za zakup" jest NIEODWRACALNY.
        issuedEntitlement("ent_prehistoric", minutesAgo(60 * 24 * 30)),
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
  })

  it("okno skanu jest RAPORTOWANE, nie domyślane", async () => {
    const { deps, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_window")],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scan_window_from).toBe(
      new Date(NOW.getTime() - SWEEP_GAP_LOOKBACK_MS).toISOString(),
    )
    expect(report.scan_window_to).toBe(
      new Date(NOW.getTime() - SWEEP_ENTITLEMENT_GRACE_MS).toISOString(),
    )
    expect(
      captured.find((c) => c.event === METRIC_HEARTBEAT)?.properties,
    ).toMatchObject({ scan_window_from: report.scan_window_from })
  })

  it("kotwica `GP_VOUCHER_DELIVERY_SWEEP_EPOCH` może okno tylko ZAWĘZIĆ", () => {
    const lookback = SWEEP_GAP_LOOKBACK_MS
    const rolling = new Date(NOW.getTime() - lookback).toISOString()

    // Kotwica PÓŹNIEJSZA niż okno kroczące — wygrywa (węższe okno).
    const anchored = resolveScanWindowStart(NOW, lookback, {
      [SWEEP_LEDGER_EPOCH_ENV]: "2026-07-24T00:00:00.000Z",
    })
    expect(anchored.toISOString()).toBe("2026-07-24T00:00:00.000Z")

    // Kotwica WCZEŚNIEJSZA nie rozszerza okna.
    expect(
      resolveScanWindowStart(NOW, lookback, {
        [SWEEP_LEDGER_EPOCH_ENV]: "2020-01-01T00:00:00.000Z",
      }).toISOString(),
    ).toBe(rolling)

    // Śmieciowa wartość nie otwiera okna po cichu.
    const logger = makeLogger()
    expect(
      resolveScanWindowStart(
        NOW,
        lookback,
        { [SWEEP_LEDGER_EPOCH_ENV]: "wczoraj" },
        logger,
      ).toISOString(),
    ).toBe(rolling)
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true)
  })

  it("kotwica obowiązuje w PRZEBIEGU, nie tylko w helperze", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_before_epoch", minutesAgo(240))],
      env: { [SWEEP_LEDGER_EPOCH_ENV]: minutesAgo(120) },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
  })
})

// ── R-2.5-H4: typ entitlementu i luki niedomykalne ─────────────────────────

describe("R-2.5-H4 — skan dotyczy WYŁĄCZNIE typów voucherowych", () => {
  it("subskrypcja i credit-pack nie są „luką buyer-maila”", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [
        {
          id: "ent_subscription",
          state: "ACTIVE",
          created_at: OLD_ENOUGH,
          entitlement_type: "SUBSCRIPTION_B2C",
        },
        {
          id: "ent_credit_pack",
          state: "ISSUED",
          created_at: OLD_ENOUGH,
          entitlement_type: "CREDIT_PACK",
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(report.per_market).toEqual([])
    expect(dispatchCalls).toHaveLength(0)
  })

  it("typy voucherowe nadal są skanowane (filtr nie jest za szeroki)", async () => {
    const { deps } = makeHarness({
      entitlements: [
        {
          id: "ent_service",
          state: "ISSUED",
          created_at: OLD_ENOUGH,
          entitlement_type: "VOUCHER_SERVICE",
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.recovered).toBe(1)
  })

  it("brak danych źródłowych to ALARM z własnym licznikiem, nie `skipped`", async () => {
    const { deps, logger, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_no_source")],
    })
    deps.delivery.sourceReader = {
      async findBuyerClaimSource() {
        return null
      },
    }

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.unresolvable).toBe(1)
    expect(report.skipped).toBe(0)
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "error" && entry.message.includes("NIEDOMYKALNE"),
      ),
    ).toBe(true)
    // Alert MOŻE zgasnąć: luka niedomykalna ma własny wymiar, więc reguła
    // `recovered + unresolvable == found` domyka się bez wysyłki.
    expect(
      captured.find((c) => c.event === METRIC_GAP)?.properties,
    ).toMatchObject({
      entitlements_without_dispatch: 1,
      recovered: 0,
      unresolvable: 1,
    })
  })
})

// ── Story 5.7 fix-round: awaria konfiguracji rynku JEST ograniczona ────────

describe("Story 5.7 fix-round — `market_runtime_config` bez danych nie robi pętli bez licznika", () => {
  /** Kształt awarii: `readRuntimeConfig` zwraca wiersz bez kontaktu/URL. */
  const brokenRuntimeConfig = {
    entitlements: [issuedEntitlement("ent_runtime_cfg")],
    runtimeConfigRow: {
      locales: { default: "pl", supported: ["pl"] },
      support_email: null,
      market_url: null,
    } as MarketRuntimeConfigRow,
  }

  it("pierwszy przebieg zostawia JEDEN wiersz `failed` z kodem konfiguracji, nie pustkę", async () => {
    const { deps, sql, dispatchCalls } = makeHarness(brokenRuntimeConfig)

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(dispatchCalls).toHaveLength(0)
    expect(report.still_failing).toBe(1)
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0].status).toBe("failed")
    expect(sql.dispatch[0].error_code).toBe(
      MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE,
    )
  })

  it("WIELE przebiegów: licznik prób rośnie i zatrzymuje się na progu — koniec dosyłek w nieskończoność", async () => {
    // Sedno finding-u: pojedynczy przebieg wyglądał poprawnie („failed, brak
    // maila"), a dopiero N przebiegów pokazywało, że nic tego nie ogranicza.
    // Przed poprawką ścieżka nie zostawiała wiersza, więc KAŻDY przebieg
    // widział „brak wiersza" i startował od zera — bez licznika i bez
    // parkowania. Ten test biegnie 12 razy, czyli daleko za progiem.
    const { deps, sql, dispatchCalls } = makeHarness(brokenRuntimeConfig)

    const attemptCounts: number[] = []
    const attemptedPerRun: number[] = []
    for (let run = 0; run < 12; run += 1) {
      const report = await runVoucherDeliveryReconciliationSweep(deps)
      attemptedPerRun.push(report.attempted)
      attemptCounts.push(Number(sql.dispatch[0]?.attempt_count ?? 0))
    }

    // Zero maili — awaria konfiguracji nadal wstrzymuje wysyłkę.
    expect(dispatchCalls).toHaveLength(0)
    // Jeden wiersz, nie dwanaście: dosyłka nie mnoży stanu.
    expect(sql.dispatch).toHaveLength(1)
    // Licznik prób jest OGRANICZONY progiem — to jest to, czego brakowało.
    expect(Math.max(...attemptCounts)).toBeLessThanOrEqual(
      SWEEP_MAX_ATTEMPT_COUNT,
    )
    // …a próby faktycznie ustają: ostatnie przebiegi nie ruszają już handlera.
    expect(attemptedPerRun[0]).toBe(1)
    expect(attemptedPerRun[attemptedPerRun.length - 1]).toBe(0)
    // Zaparkowany wiersz jest WIDOCZNY dla operatora, a nie cicho pominięty.
    const last = await runVoucherDeliveryReconciliationSweep(deps)
    expect(last.parked_total).toBe(1)
    expect(last.scanned).toBe(0)
  })

  /** Wariant harnessu z PRZESTAWIALNYM runtime configiem (naprawa operatora). */
  function repairableHarness(entitlementId: string) {
    let runtimeConfigRow: MarketRuntimeConfigRow = {
      locales: { default: "pl", supported: ["pl"] },
      support_email: null,
      market_url: null,
    }
    const sql = new FakeSql()
    const harness = makeHarness({
      entitlements: [issuedEntitlement(entitlementId)],
      sql,
    })
    harness.delivery.marketLocales.readRuntimeConfig = async () => ({
      row: runtimeConfigRow,
      degraded: false,
    })
    return {
      ...harness,
      sql,
      repair: () => {
        runtimeConfigRow = {
          locales: { default: "pl", supported: ["pl"] },
          support_email: "kontakt@bonbeauty.pl",
          market_url: "https://dev.bonbeauty.test",
        }
      },
    }
  }

  it("naprawa konfiguracji W OKNIE budżetu domyka lukę bez ręcznego UPDATE", async () => {
    // Ograniczenie nie jest jednokierunkowe: dopóki wiersz ma budżet, operator
    // naprawia `market_runtime_config` i sweep sam dowozi maila.
    const harness = repairableHarness("ent_runtime_cfg_fixed")

    for (let run = 0; run < 3; run += 1) {
      await runVoucherDeliveryReconciliationSweep(harness.deps)
    }
    expect(harness.dispatchCalls).toHaveLength(0)

    // Operator uruchamia `gp-config-sync-market-runtime … --apply`.
    harness.repair()
    await runVoucherDeliveryReconciliationSweep(harness.deps)

    expect(harness.dispatchCalls).toHaveLength(1)
    expect(harness.sql.dispatch[0].status).toBe("sent")
  })

  it("naprawa PO wyczerpaniu budżetu NIE odparkowuje sama — wiersz czeka na operatora, ale jest WIDOCZNY", async () => {
    // Jawna granica polityki (R-2.5-H3): jedno automatyczne odzyskanie budżetu
    // na wiersz. Konfiguracja niepoprawiona w oknie ~6 przebiegów (≈90 min)
    // kończy się TRWAŁYM parkowaniem — i to jest cena ograniczenia pętli.
    // Utrata nie jest cicha: wiersz ma licznik operatorski i zostaje w ledgerze
    // z pierwotnym kodem przyczyny.
    const harness = repairableHarness("ent_runtime_cfg_parked")

    for (let run = 0; run < 8; run += 1) {
      await runVoucherDeliveryReconciliationSweep(harness.deps)
    }

    harness.repair()
    const afterRepair = await runVoucherDeliveryReconciliationSweep(harness.deps)

    expect(harness.dispatchCalls).toHaveLength(0)
    expect(afterRepair.scanned).toBe(0)
    expect(afterRepair.parked_total).toBe(1)
    expect(harness.sql.dispatch[0].status).toBe("failed")
    expect(harness.sql.dispatch[0].error_code).toBe(
      MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE,
    )
    expect(Number(harness.sql.dispatch[0].attempt_count)).toBe(
      SWEEP_MAX_ATTEMPT_COUNT,
    )
  })

  it("kody `market_runtime_config` są klasą awarii GLOBALNEJ (odparkowanie bez ręcznego UPDATE)", () => {
    expect(isGlobalFailureErrorCode(MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE)).toBe(
      true,
    )
    expect(
      isGlobalFailureErrorCode("VOUCHER_DELIVERY_MARKET_RUNTIME_CONFIG_UNAVAILABLE"),
    ).toBe(true)
    expect(
      isGlobalFailureErrorCode("VOUCHER_DELIVERY_STOREFRONT_URL_NOT_REACHABLE"),
    ).toBe(true)
    // Realne odrzucenie providera NADAL zużywa budżet — inaczej próg nie
    // znaczyłby nic.
    expect(isGlobalFailureErrorCode("VOUCHER_DELIVERY_DISPATCH_FAILED")).toBe(false)
  })
})

// ── AC5 (b): drugi przebieg → zero nowych maili ────────────────────────────

describe("AC5 (b) / AC2 — idempotencja: powtórny przebieg nie tworzy maila", () => {
  it("drugi sweep na tym samym stanie wysyła ZERO nowych maili", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_idem")],
    })

    await runVoucherDeliveryReconciliationSweep(deps)
    const second = await runVoucherDeliveryReconciliationSweep(deps)

    // Wiersz jest `sent` → skan już go nie zwraca (blokada w SQL-u), a gdyby
    // zwrócił, ledger zwróciłby `blocked` (blokada w API).
    expect(second.scanned).toBe(0)
    expect(second.recovered).toBe(0)
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
  })

  it("trzy przebiegi pod rząd = jeden mail (idempotencja nie jest przypadkiem)", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_idem_3")],
    })

    await runVoucherDeliveryReconciliationSweep(deps)
    await runVoucherDeliveryReconciliationSweep(deps)
    await runVoucherDeliveryReconciliationSweep(deps)

    expect(dispatchCalls).toHaveLength(1)
  })

  it("test-the-test: ledger BEZ dedupe → drugi przebieg wysyła DUPLIKAT", async () => {
    // Dowód, że zieleń powyżej pochodzi z dedupe ledgera, a nie z przypadku:
    // po podmianie ledgera na taki, który zawsze mówi „rezerwuj", ten sam sweep
    // wysyła drugi mail. Gdyby ktoś usunął dedupe z dosyłki, produkcja
    // zachowywałaby się jak ta atrapa.
    const dedupeless: DispatchLedgerPort = {
      async reserveDispatch() {
        return {
          outcome: "reserved",
          dispatch_id: "dispatch-no-dedupe",
          status: "queued",
          attempt_count: 1,
          queued_at: NOW.toISOString(),
        }
      },
      async markSent() {
        return true
      },
      async markFailed() {
        return true
      },
      async findByIdentity() {
        return null
      },
    }

    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_dupe")],
      ledgerOverride: dedupeless,
    })

    await runVoucherDeliveryReconciliationSweep(deps)
    await runVoucherDeliveryReconciliationSweep(deps)

    expect(dispatchCalls).toHaveLength(2)
  })
})

// ── AC5 (c): wyścig sweep × subscriber ─────────────────────────────────────

describe("AC5 (c) / AC2 — wyścig sweep × subscriber daje DOKŁADNIE jeden mail", () => {
  it("event dociera w trakcie przebiegu sweepa → jedna wysyłka, jeden wiersz", async () => {
    const { deps, delivery, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_race")],
    })

    const subscriberEvent = {
      event_type: "gp.entitlements.entitlement_state_changed.v1",
      scope: { market_id: MARKET_ID },
      payload: {
        entitlement_id: "ent_race",
        from_state: "__genesis__",
        to_state: "ISSUED",
      },
    }

    await Promise.all([
      runVoucherDeliveryReconciliationSweep(deps),
      handleVoucherPurchaseDelivery(subscriberEvent, delivery),
    ])

    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0].status).toBe("sent")
  })
})

// ── AC5 (d): entitlement młodszy niż próg ──────────────────────────────────

describe("AC5 (d) / AC1 — grace-window: nie ścigamy się z wysyłką w locie", () => {
  it("entitlement młodszy niż próg wieku jest POMINIĘTY", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_fresh", TOO_FRESH)],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
  })

  it("`queued` MŁODSZE niż próg porzucenia nie jest ruszane (wysyłka realnie w locie)", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_inflight")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-inflight",
          entitlement_id: "ent_inflight",
          status: "queued",
          queued_at: minutesAgo(2),
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(report.reclaimed_queued).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch[0].status).toBe("queued")
  })
})

// ── AC5 (e): stan spoza matrycy + granica H1 ───────────────────────────────

describe("AC5 (e) / AC1 — stan spoza ISSUED/ACTIVE: pominięty bez błędu, ale WIDOCZNY", () => {
  it("entitlement REDEEMED_FULL bez dispatchu nie generuje wysyłki ani błędu", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [
        { id: "ent_redeemed", state: "REDEEMED_FULL", created_at: OLD_ENOUGH },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.status).toBe("completed")
    expect(report.scanned).toBe(0)
    expect(report.errored).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
  })

  it("granica H1 NIE jest cicha: luka poza stanami źródłowymi jest zliczona i zalogowana", async () => {
    const { deps, logger, captured } = makeHarness({
      entitlements: [
        { id: "ent_redeemed", state: "REDEEMED_FULL", created_at: OLD_ENOUGH },
        { id: "ent_expired", state: "EXPIRED", created_at: OLD_ENOUGH },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.gap_beyond_source_states).toBe(2)
    expect(
      logger.entries.some(
        (entry) => entry.level === "warn" && entry.message.includes("granica H1"),
      ),
    ).toBe(true)
    expect(
      captured.find((c) => c.event === METRIC_HEARTBEAT)?.properties,
    ).toMatchObject({ gap_beyond_source_states: 2 })
  })

  it("entitlement poza stanami źródłowymi, ale z wierszem dispatch, NIE jest luką", async () => {
    const { deps } = makeHarness({
      entitlements: [
        { id: "ent_closed", state: "CLOSED", created_at: OLD_ENOUGH },
      ],
      dispatchRows: [
        {
          dispatch_id: "dispatch-closed",
          entitlement_id: "ent_closed",
          status: "sent",
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.gap_beyond_source_states).toBe(0)
  })
})

// ── AC4: no-op bez readiness-green providera ───────────────────────────────

describe("AC4 — brak readiness-green providera: no-op z JEDNYM logiem", () => {
  it("zero wysyłek, zero zapytań (także niemutujących), zero wierszy `failed`", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_no_provider")],
      providerReady: false,
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.status).toBe("skipped_provider_not_ready")
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.statements).toHaveLength(0)
    expect(sql.mutatingStatements).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
    expect(sql.audit).toHaveLength(0)
  })

  it("DOKŁADNIE jeden log na przebieg (nie per wiersz)", async () => {
    const { deps, logger } = makeHarness({
      entitlements: [
        issuedEntitlement("ent_a"),
        issuedEntitlement("ent_b"),
        issuedEntitlement("ent_c"),
      ],
      providerReady: false,
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    expect(logger.entries).toHaveLength(1)
    expect(logger.entries[0].level).toBe("info")
  })

  it("telemetria mówi `skipped_provider_not_ready`, NIE udaje sukcesu „0 luk”", async () => {
    const { deps, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_telemetry")],
      providerReady: false,
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(captured).toEqual([
      {
        event: METRIC_HEARTBEAT,
        properties: {
          schedule_name: SCHEDULE_NAME,
          status: "skipped_provider_not_ready",
        },
      },
    ])
    // Kluczowe: brak metryki `gap` z zerami — inaczej alert milczałby dokładnie
    // wtedy, gdy nic nie działa.
    expect(captured.some((c) => c.event === METRIC_GAP)).toBe(false)
    expect(report.per_market).toEqual([])
  })

  it("gate reużywa ZASTANEGO helpera z 2.2 (domyślka bez wstrzyknięcia)", () => {
    const source = readFileSync(
      join(__dirname, "../../jobs/voucher-delivery-reconciliation-sweep.ts"),
      "utf8",
    )
    expect(source).toContain(
      'from "../lib/vendor-notification-provider-readiness"',
    )
    expect(source).toContain("isNotificationProviderReadyForSweep")
    // NIE powstaje druga definicja gotowości providera w jobie.
    expect(source).not.toMatch(/BREVO_API_KEY/)
  })

  it("R-2.5-M5: sam shim RESEND/SMTP NIE jest gotowością dla sweepa", () => {
    const env = process.env
    try {
      process.env = { ...env }
      delete process.env.BREVO_API_KEY
      delete process.env.GP_VENDOR_NOTIFICATIONS_PROVIDER_READY
      process.env.RESEND_API_KEY = "re_legacy_shim"

      // Ścieżka interaktywna dalej przechodzi (zachowanie zastanych środowisk
      // nietknięte)…
      expect(isNotificationProviderReady()).toBe(true)
      // …ale automat NIE produkuje wierszy `failed`/DLQ co 15 minut na
      // środowisku, na którym dispatch i tak padnie na brak klucza brevo.
      expect(isNotificationProviderReadyForSweep()).toBe(false)

      process.env.BREVO_API_KEY = "brevo_key"
      expect(isNotificationProviderReadyForSweep()).toBe(true)
    } finally {
      process.env = env
    }
  })
})

// ── AC5 (g) / D3: osierocony `queued` ──────────────────────────────────────

describe("AC5 (g) / D3 — porzucona rezerwacja `queued` jest dogoniona wg reguły", () => {
  it("`queued` starsze niż próg: JEDNO przejęcie, JEDEN wiersz, JEDEN mail", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_orphan")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-orphan",
          entitlement_id: "ent_orphan",
          status: "queued",
          queued_at: minutesAgo(60),
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.reclaimed_queued).toBe(1)
    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
    // Nadal JEDEN wiersz — przejęcie rezerwacji, nie drugi INSERT.
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0]).toMatchObject({
      dispatch_id: "dispatch-orphan",
      status: "sent",
      attempt_count: 2,
    })
  })

  it("przejęcie zostawia ślad audytowy queued→failed z kodem porzucenia", async () => {
    const { deps, sql } = makeHarness({
      entitlements: [issuedEntitlement("ent_orphan_audit")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-orphan-audit",
          entitlement_id: "ent_orphan_audit",
          status: "queued",
          queued_at: minutesAgo(60),
        },
      ],
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    expect(sql.audit.map((row) => [row.from_status, row.to_status])).toEqual([
      ["queued", "failed"],
      ["failed", "queued"],
      ["queued", "sent"],
    ])
    expect(sql.audit[0].error_code).toBe(ABANDONED_QUEUED_ERROR_CODE)
  })

  it("mechanizmem jest warunkowe UPDATE z guardem staleness, NIE drugi INSERT", async () => {
    const { deps, sql } = makeHarness({
      entitlements: [issuedEntitlement("ent_orphan_sql")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-orphan-sql",
          entitlement_id: "ent_orphan_sql",
          status: "queued",
          queued_at: minutesAgo(60),
        },
      ],
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    const abandon = sql.statements.find(
      (s) =>
        s.includes(`UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`) &&
        s.includes("SET status = 'failed'") &&
        s.includes("queued_at <"),
    )
    expect(abandon).toBeDefined()
    expect(abandon).toContain("AND status = 'queued'")
  })

  it("wyścig o przejęcie: dwa sweepy dają dokładnie jeden mail", async () => {
    const sql = new FakeSql()
    const first = makeHarness({
      sql,
      entitlements: [issuedEntitlement("ent_orphan_race")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-orphan-race",
          entitlement_id: "ent_orphan_race",
          status: "queued",
          queued_at: minutesAgo(60),
        },
      ],
    })
    const second = makeHarness({ sql })

    await Promise.all([
      runVoucherDeliveryReconciliationSweep(first.deps),
      runVoucherDeliveryReconciliationSweep(second.deps),
    ])

    expect(
      first.dispatchCalls.length + second.dispatchCalls.length,
    ).toBe(1)
    expect(sql.dispatch).toHaveLength(1)
  })
})

// ── AC2: semantyka stanów jest respektowana, nie obchodzona ────────────────

describe("AC2 — semantyka stanów ledgera 2.3 jest respektowana", () => {
  it("`sent` NIE wraca ze skanu i nie dostaje drugiego maila", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_sent")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-sent",
          entitlement_id: "ent_sent",
          status: "sent",
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
  })

  it("`delivered` i `degraded` też blokują (mail poszedł)", async () => {
    for (const status of ["delivered", "degraded"]) {
      const { deps, dispatchCalls } = makeHarness({
        entitlements: [issuedEntitlement(`ent_${status}`)],
        dispatchRows: [
          {
            dispatch_id: `dispatch-${status}`,
            entitlement_id: `ent_${status}`,
            status,
          },
        ],
      })

      const report = await runVoucherDeliveryReconciliationSweep(deps)
      expect(report.scanned).toBe(0)
      expect(dispatchCalls).toHaveLength(0)
    }
  })

  it("`dead_lettered` NIE jest wznawiany automatycznie", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_dlq")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-dlq",
          entitlement_id: "ent_dlq",
          status: "dead_lettered",
          error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch[0].status).toBe("dead_lettered")
  })

  it("`failed` DOPUSZCZA retry — sweep jest jedynym silnikiem retry tej ścieżki", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_failed")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-failed",
          entitlement_id: "ent_failed",
          status: "failed",
          error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
          attempt_count: 1,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0]).toMatchObject({ status: "sent", attempt_count: 2 })
  })

  it("wiersz po `SWEEP_MAX_ATTEMPT_COUNT` próbach: bez wysyłki, ZAPARKOWANY i policzony", async () => {
    const { deps, logger, dispatchCalls, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_exhausted")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-exhausted",
          entitlement_id: "ent_exhausted",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    // R-2.5-H3: zaparkowany wiersz NIE wraca ze skanu (nie zjada batcha),
    // ale NIE znika z obserwowalności — jest liczony osobno.
    expect(report.scanned).toBe(0)
    expect(report.attempted).toBe(0)
    expect(report.parked_total).toBe(1)
    expect(dispatchCalls).toHaveLength(0)
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("wymagana decyzja operatora"),
      ),
    ).toBe(true)
    expect(
      captured.find((c) => c.event === METRIC_HEARTBEAT)?.properties,
    ).toMatchObject({ parked_total: 1 })
  })
})

// ── R-2.5-H3: parkowanie jest ODWRACALNE, a batch nie jest zagłodzony ──────

describe("R-2.5-H3 — awaria GLOBALNA nie zużywa budżetu prób", () => {
  it("odparkuje historyczny wiersz po konfiguracji na podstawie pierwszej przyczyny, potem wysyła", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_historical_brevo")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-historical-brevo",
          entitlement_id: "ent_historical_brevo",
          status: "failed",
          // Mutowalny summary został już nadpisany podczas starego retry.
          error_code: "VOUCHER_DELIVERY_DISPATCH_FAILED",
          first_error_code: "BREVO_SENDER_NOT_CONFIGURED",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
      dispatchImpl: async () => ({ id: "brevo-after-sender-config" }),
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.attempt_budget_released).toBe(1)
    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch[0]).toMatchObject({
      status: "sent",
      attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
      configuration_recovery_count: 1,
    })
  })

  it("nie odparkuje późniejszego realnego błędu providera tylko dlatego, że pierwsza porażka była konfiguracyjna", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_real_failure_after_config")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-real-failure-after-config",
          entitlement_id: "ent_real_failure_after_config",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          first_error_code: "BREVO_SENDER_NOT_CONFIGURED",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.attempt_budget_released).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch[0].attempt_count).toBe(SWEEP_MAX_ATTEMPT_COUNT)
  })

  it("historyczny fallback i aktualny `BREVO_TEMPLATE_NOT_CONFIGURED` nie tworzą pętli między przebiegami", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_bounded_configuration_recovery")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-bounded-configuration-recovery",
          entitlement_id: "ent_bounded_configuration_recovery",
          status: "failed",
          // To jest dokładny kształt z audytu regresji: historyczna pierwsza
          // przyczyna i utracony, generyczny summary przed retry.
          error_code: "VOUCHER_DELIVERY_DISPATCH_FAILED",
          first_error_code: "BREVO_SENDER_NOT_CONFIGURED",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
      dispatchImpl: async () => {
        throw new Error(
          "Failed to send notification [gp_error_code=BREVO_TEMPLATE_NOT_CONFIGURED]",
        )
      },
    })

    const first = await runVoucherDeliveryReconciliationSweep(deps)
    const second = await runVoucherDeliveryReconciliationSweep(deps)

    expect(first.attempt_budget_released).toBe(1)
    expect(second.attempt_budget_released).toBe(0)
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch[0]).toMatchObject({
      status: "failed",
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
      attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
      configuration_recovery_count: 1,
    })
  })

  it("`FLOW_DISABLED` odzyskuje budżet tylko raz, potem wiersz wraca do zwykłego limitu", async () => {
    const { deps, sql, logger } = makeHarness({
      entitlements: [issuedEntitlement("ent_kill_switch")],
      dispatchImpl: async () => {
        throw new Error("flow wyłączony [gp_error_code=FLOW_DISABLED]")
      },
    })

    await runVoucherDeliveryReconciliationSweep(deps)
    const first = Number(sql.dispatch[0].attempt_count)
    const second = await runVoucherDeliveryReconciliationSweep(deps)

    expect(sql.dispatch[0].status).toBe("failed")
    expect(first).toBe(1)
    expect(Number(sql.dispatch[0].attempt_count)).toBe(2)
    expect(Number(sql.dispatch[0].configuration_recovery_count)).toBe(1)
    expect(second.attempt_budget_released).toBe(0)
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true)
  })

  it("po ustąpieniu awarii globalnej mail dochodzi bez ręcznego odparkowania", async () => {
    let flowDisabled = true
    const { deps, sql, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_kill_switch_recovers")],
      dispatchImpl: async () => {
        if (flowDisabled) {
          throw new Error("flow wyłączony [gp_error_code=FLOW_DISABLED]")
        }
        return { id: "brevo-message-after-fix" }
      },
    })

    await runVoucherDeliveryReconciliationSweep(deps)
    flowDisabled = false
    const recovery = await runVoucherDeliveryReconciliationSweep(deps)

    expect(recovery.recovered).toBe(1)
    expect(sql.dispatch[0].status).toBe("sent")
    expect(dispatchCalls.length).toBeGreaterThan(0)
  })

  it("REALNE odrzucenie providera budżetu NIE odzyskuje (próg dalej działa)", async () => {
    const { deps, sql } = makeHarness({
      entitlements: [issuedEntitlement("ent_provider_reject")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-provider-reject",
          entitlement_id: "ent_provider_reject",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: 1,
        },
      ],
      dispatchImpl: async () => {
        throw new Error("provider transport [gp_error_code=BREVO_TRANSPORT_ERROR]")
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.attempt_budget_released).toBe(0)
    expect(Number(sql.dispatch[0].attempt_count)).toBe(2)
  })

  it("klasyfikacja kodów: konfiguracyjne vs realne odrzucenie", () => {
    expect(isGlobalFailureErrorCode("FLOW_DISABLED")).toBe(true)
    expect(isGlobalFailureErrorCode("BREVO_TEMPLATE_NOT_CONFIGURED")).toBe(true)
    expect(isGlobalFailureErrorCode("BREVO_API_KEY_NOT_CONFIGURED")).toBe(true)
    expect(isGlobalFailureErrorCode("BREVO_TRANSPORT_ERROR")).toBe(false)
    expect(isGlobalFailureErrorCode(null)).toBe(false)
  })

  it("BREVO_UNAUTHORIZED (autoryzacja IP) jest awarią GLOBALNĄ, a klucz API nie", () => {
    // Żywy zakup 2026-08-04: 401 `unauthorized` = adres IP hosta poza listą
    // autoryzowanych w Brevo. Ustępuje działaniem operatora, bez udziału
    // wiersza — więc nie wolno mu palić budżetu prób.
    expect(isGlobalFailureErrorCode("BREVO_UNAUTHORIZED")).toBe(true)
    // Granica zakresu: nie klasyfikujemy hurtem całego 401. Nieprawidłowy klucz
    // nie ustępuje sam i nie może odparkowywać wiersza w nieskończoność.
    expect(isGlobalFailureErrorCode("BREVO_INVALID_API_KEY")).toBe(false)
  })

  it("401 z autoryzacji IP ZWRACA próbę do budżetu zamiast ją zużyć", async () => {
    // Kontrast z testem wyżej: ten sam kształt, co REALNE odrzucenie providera,
    // różni się WYŁĄCZNIE kodem błędu — a wynik dla budżetu ma być odwrotny.
    const { deps, sql } = makeHarness({
      entitlements: [issuedEntitlement("ent_ip_401")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-ip-401",
          entitlement_id: "ent_ip_401",
          status: "failed",
          error_code: "BREVO_UNAUTHORIZED",
          attempt_count: 1,
        },
      ],
      dispatchImpl: async () => {
        throw new Error(
          "provider unauthorized [gp_error_code=BREVO_UNAUTHORIZED] [gp_provider_status=401]"
        )
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.attempt_budget_released).toBe(1)
    expect(Number(sql.dispatch[0].attempt_count)).toBe(1)
  })
})

describe("R-2.5-H3/H4 — batch nie jest zagłodzony przez wiersze niedosyłalne", () => {
  it("zaparkowane wiersze NIE zajmują limitu batcha", async () => {
    const sql = new FakeSql()
    const { deps, dispatchCalls } = makeHarness({
      sql,
      batchLimit: 1,
      entitlements: [
        issuedEntitlement("ent_parked_old", minutesAgo(200)),
        issuedEntitlement("ent_fresh_gap", minutesAgo(60)),
      ],
      dispatchRows: [
        {
          dispatch_id: "dispatch-parked-old",
          entitlement_id: "ent_parked_old",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    // Bez wykluczenia zaparkowanych ten (najstarszy) wiersz zająłby cały
    // batch i świeża luka nie zostałaby zobaczona NIGDY.
    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch.some((row) => row.entitlement_id === "ent_fresh_gap")).toBe(
      true,
    )
  })

  it("wiersze z wieloma próbami sortują się ZA świeżymi lukami", async () => {
    const sql = new FakeSql()
    const { deps, dispatchCalls } = makeHarness({
      sql,
      batchLimit: 1,
      entitlements: [
        issuedEntitlement("ent_chronic", minutesAgo(300)),
        issuedEntitlement("ent_new", minutesAgo(60)),
      ],
      dispatchRows: [
        {
          dispatch_id: "dispatch-chronic",
          entitlement_id: "ent_chronic",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT - 1,
        },
      ],
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    expect(dispatchCalls).toHaveLength(1)
    expect(
      String(
        (dispatchCalls[0].data as Record<string, unknown> | undefined)
          ?.entitlement_id ?? "",
      ),
    ).toBe("ent_new")
  })
})

// ── Story 4.4 (FR-9e, AD-23): jednostką ponawiania jest WIERSZ dostawy ─────

describe("FR-9e — zaparkowany wiersz nie wstrzymuje sąsiadów, ale sam nie rusza", () => {
  const HANDOFF_KEY = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK

  /**
   * AC3, kontrola negatywna nr 2 — WĘŻSZA i celująca w defekt.
   *
   * Kontrola z epics.md („drugi voucher z tego samego zakupu") jest słabsza:
   * dwa vouchery to dwa ENTITLEMENTY, a zastany guard działał per entitlement,
   * więc tamten test przechodził już przed tą story. Defekt widać dopiero na
   * DWÓCH SZABLONACH JEDNEGO entitlementu — i dzisiejszy kod ten test oblewał.
   */
  it("zaparkowany buyer-mail NIE wstrzymuje handoffu tego samego entitlementu", async () => {
    const { deps, sql, dispatchCalls, logger } = makeHarness({
      templateKeys: [TEMPLATE_KEY, HANDOFF_KEY],
      entitlements: [issuedEntitlement("ent_two_templates")],
      giftSource: true,
      eligibleGift: true,
      dispatchRows: [
        {
          dispatch_id: "dispatch-parked-buyer",
          entitlement_id: "ent_two_templates",
          template_key: TEMPLATE_KEY,
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    // Dokładnie JEDNA wysyłka i to ta niezaparkowana.
    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0].template).toBe(HANDOFF_KEY)
    expect(report.recovered).toBe(1)

    // AC3, kontrola DODATNIA budżetu: zdjęcie blokady sąsiadowi NIE odparkowuje
    // wiersza zaparkowanego. Bez tej asercji naprawa byłaby nieodróżnialna od
    // usunięcia progu. Mierzymy stan WIERSZA, nie tylko licznik przebiegu.
    expect(
      dispatchCalls.some((call) => call.template === TEMPLATE_KEY),
    ).toBe(false)
    expect(report.parked_total).toBe(1)
    const parked = sql.dispatch.find(
      (row) => row.dispatch_id === "dispatch-parked-buyer",
    )
    expect(parked?.status).toBe("failed")
    expect(Number(parked?.attempt_count ?? 0)).toBe(SWEEP_MAX_ATTEMPT_COUNT)
    expect(logger.entries.length).toBeGreaterThan(0)
  })

  /** AC3, kontrola negatywna nr 1 — dosłownie ta z epics.md (NFR-1). */
  it("zaparkowany wiersz jednego vouchera nie wstrzymuje DRUGIEGO z tego samego zakupu", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [
        issuedEntitlement("ent_voucher_a"),
        issuedEntitlement("ent_voucher_b"),
      ],
      dispatchRows: [
        {
          dispatch_id: "dispatch-parked-a",
          entitlement_id: "ent_voucher_a",
          template_key: TEMPLATE_KEY,
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(dispatchCalls).toHaveLength(1)
    expect(
      String(
        (dispatchCalls[0].data as Record<string, unknown> | undefined)
          ?.entitlement_id ?? "",
      ),
    ).toBe("ent_voucher_b")
    expect(report.recovered).toBe(1)
    expect(report.parked_total).toBe(1)
  })

  /**
   * AC1 — domkniętość kubełków po zmianie jednostki. Rozjazd o JEDEN świeci na
   * czerwono; asercja `>= 0` nie mierzyłaby niczego.
   */
  it("zbiór kubełków pozostaje DOMKNIĘTY, gdy jednostką jest wiersz", async () => {
    const { deps } = makeHarness({
      templateKeys: [TEMPLATE_KEY, HANDOFF_KEY],
      entitlements: [
        issuedEntitlement("ent_closure_parked"),
        issuedEntitlement("ent_closure_plain"),
      ],
      giftSource: true,
      eligibleGift: true,
      dispatchRows: [
        {
          dispatch_id: "dispatch-closure-parked",
          entitlement_id: "ent_closure_parked",
          template_key: TEMPLATE_KEY,
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    for (const row of report.per_market) {
      expect(row.found).toBe(
        row.recovered +
          row.still_failing +
          row.unresolvable +
          row.exhausted +
          row.skipped +
          row.state_mismatch +
          row.errored,
      )
    }

    // Jednostką `found` jest WIERSZ (4.4), a nie entitlement — inaczej ta suma
    // nie miałaby jak się zbilansować przy wykluczeniu per wiersz.
    const found = report.per_market.reduce((sum, row) => sum + row.found, 0)
    expect(found).toBe(report.scanned)
    expect(report.entitlements_scanned).toBe(2)
    expect(found).toBeGreaterThan(report.entitlements_scanned)
  })

  /**
   * Guard `parkedRowKeys` jest defense-in-depth: produkcyjny SQL skanu wyklucza
   * wiersze zaparkowane, więc normalnie nie ma czego wykluczać. Ten test
   * podstawia port, który je zwraca (inna implementacja / rozjazd predykatu),
   * i sprawdza, że guard ODPALA — i że odpala PER WIERSZ.
   */
  it("guard wierszy zaparkowanych odpala, gdy skan je jednak zwróci — i tylko dla nich", async () => {
    const { deps, dispatchCalls, logger } = makeHarness({
      templateKeys: [TEMPLATE_KEY, HANDOFF_KEY],
      entitlements: [issuedEntitlement("ent_guard")],
      giftSource: true,
      eligibleGift: true,
    })

    // Skan „przepuszcza" wiersz zaparkowany buyer-maila, a lista zaparkowanych
    // mówi prawdę. Bez guardu poszłyby DWIE wysyłki.
    deps.scanner = scannerWith(deps.scanner, {
      async listParkedDispatches() {
        return [
          {
            dispatch_id: "dispatch-guard-parked",
            entitlement_id: "ent_guard",
            market_id: MARKET_ID,
            template_key: TEMPLATE_KEY,
            attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
            first_error_code: "BREVO_TRANSPORT_ERROR",
          },
        ]
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.exhausted).toBe(1)
    expect(
      dispatchCalls.filter((call) => call.template === TEMPLATE_KEY),
    ).toHaveLength(0)
    // Sąsiad idzie — to jest dokładnie różnica między 4.4 a stanem sprzed niej.
    expect(
      dispatchCalls.filter((call) => call.template === HANDOFF_KEY),
    ).toHaveLength(1)
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("dosyłka wstrzymana dla TEGO wiersza"),
      ),
    ).toBe(true)
  })

  /**
   * AC2 — celowanie jest WYMUSZONE PRZEZ WYKONANIE, nie przez konwencję.
   * Sterownik zlicza wywołania providera: cel „tylko handoff" ⇒ ZERO wywołań
   * dla `voucher_purchase_confirmation`. Dwa wywołania = RED.
   */
  it("dosyłka celowana w handoff nie dotyka wiersza buyer-maila (ani providera, ani ledgera)", async () => {
    const { deps, sql, dispatchCalls } = makeHarness({
      templateKeys: [TEMPLATE_KEY, HANDOFF_KEY],
      entitlements: [issuedEntitlement("ent_targeted")],
      giftSource: true,
      eligibleGift: true,
      dispatchRows: [
        {
          dispatch_id: "dispatch-targeted-handoff",
          entitlement_id: "ent_targeted",
          template_key: HANDOFF_KEY,
          recipient_email: "obdarowana@example.test",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: 1,
        },
        {
          dispatch_id: "dispatch-targeted-buyer",
          entitlement_id: "ent_targeted",
          template_key: TEMPLATE_KEY,
          status: "sent",
        },
      ],
    })

    const buyerBefore = sql.dispatch.find(
      (row) => row.dispatch_id === "dispatch-targeted-buyer",
    )
    const buyerAttemptsBefore = Number(buyerBefore?.attempt_count ?? 0)

    await runVoucherDeliveryReconciliationSweep(deps)

    expect(
      dispatchCalls.filter((call) => call.template === TEMPLATE_KEY),
    ).toHaveLength(0)
    expect(
      dispatchCalls.filter((call) => call.template === HANDOFF_KEY),
    ).toHaveLength(1)

    const buyerAfter = sql.dispatch.find(
      (row) => row.dispatch_id === "dispatch-targeted-buyer",
    )
    expect(buyerAfter?.status).toBe("sent")
    expect(Number(buyerAfter?.attempt_count ?? 0)).toBe(buyerAttemptsBefore)
  })
})

describe("R-2.5-M8 — handoff w `failed` jest ponawiany, choć buyer-mail jest `sent`", () => {
  it("skan po ledgerze dogania wiersz szablonu, którego nie ma w zbiorze oczekiwanych", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_handoff_stalled")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-buyer-sent",
          entitlement_id: "ent_handoff_stalled",
          template_key: TEMPLATE_KEY,
          status: "sent",
        },
        {
          dispatch_id: "dispatch-handoff-failed",
          entitlement_id: "ent_handoff_stalled",
          template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK,
          recipient_email: "obdarowana@example.test",
          status: "failed",
          error_code: "BREVO_TRANSPORT_ERROR",
          attempt_count: 1,
        },
      ],
      giftSource: true,
      eligibleGift: true,
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    // Bez drugiego skanu entitlement nie wróciłby ZE SKANU nigdy (buyer-mail
    // jest `sent`), więc handoff nie miałby żadnego silnika retry.
    expect(report.scanned).toBe(1)
    expect(report.attempted).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0].template).toBe(
      NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK,
    )
    expect(report.handoff_recovered).toBe(1)
  })
})

// ── AC1/AC2: bounded batch, odporność per-wiersz ───────────────────────────

describe("AC1 — bounded batch: pominięta reszta jest LOGOWANA i dogoniona", () => {
  it("limit batcha obcina przebieg, a `truncated` + `warn` mówią o tym wprost", async () => {
    const sql = new FakeSql()
    const { deps, logger, dispatchCalls } = makeHarness({
      sql,
      batchLimit: 2,
      entitlements: [
        issuedEntitlement("ent_b1", minutesAgo(90)),
        issuedEntitlement("ent_b2", minutesAgo(80)),
        issuedEntitlement("ent_b3", minutesAgo(70)),
      ],
    })

    const first = await runVoucherDeliveryReconciliationSweep(deps)

    expect(first.scanned).toBe(2)
    expect(first.truncated).toBe(true)
    expect(dispatchCalls).toHaveLength(2)
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" && entry.message.includes("limitu batcha"),
      ),
    ).toBe(true)

    // Kolejny przebieg dogania resztę — najstarsze najpierw (deterministyczne
    // sortowanie), więc żaden wiersz nie zostaje zagłodzony.
    const second = await runVoucherDeliveryReconciliationSweep(deps)
    expect(second.scanned).toBe(1)
    expect(second.truncated).toBe(false)
    expect(dispatchCalls).toHaveLength(3)
  })

  it("domyślny limit jest ustawiony (skan nigdy nie jest nieograniczony)", () => {
    expect(SWEEP_BATCH_LIMIT).toBeGreaterThan(0)
    expect(Number.isInteger(SWEEP_BATCH_LIMIT)).toBe(true)
  })

  it("skan bez limitu jest błędem wołającego, nie „skanuj wszystko”", async () => {
    const sql = new FakeSql()
    const ledger = new PgDispatchLedger(sql)
    await expect(
      ledger.scanDeliveryGaps({
        template_keys: [TEMPLATE_KEY],
        source_states: [...SWEEP_SOURCE_STATES],
        entitlement_types: [...SWEEP_SOURCE_ENTITLEMENT_TYPES],
        created_before: OLD_ENOUGH,
        created_after: minutesAgo(10080),
        stale_queued_before: OLD_ENOUGH,
        max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        limit: 0,
      }),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_GAP_SCAN_LIMIT_INVALID",
    })
  })

  it("pusty zbiór szablonów jest błędem, nie skanem po wszystkim", async () => {
    const sql = new FakeSql()
    const ledger = new PgDispatchLedger(sql)
    await expect(
      ledger.scanDeliveryGaps({
        template_keys: [],
        source_states: [...SWEEP_SOURCE_STATES],
        entitlement_types: [...SWEEP_SOURCE_ENTITLEMENT_TYPES],
        created_before: OLD_ENOUGH,
        created_after: minutesAgo(10080),
        stale_queued_before: OLD_ENOUGH,
        max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        limit: 10,
      }),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_GAP_SCAN_TEMPLATE_KEYS_EMPTY",
    })
  })

  it("skan BEZ dolnej granicy okna jest błędem, nie „szerszym skanem” (R-2.5-H1)", async () => {
    const sql = new FakeSql()
    const ledger = new PgDispatchLedger(sql)
    await expect(
      ledger.scanDeliveryGaps({
        template_keys: [TEMPLATE_KEY],
        source_states: [...SWEEP_SOURCE_STATES],
        entitlement_types: [...SWEEP_SOURCE_ENTITLEMENT_TYPES],
        created_before: OLD_ENOUGH,
        created_after: "",
        stale_queued_before: OLD_ENOUGH,
        max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        limit: 10,
      }),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_GAP_SCAN_WINDOW_INVALID",
    })
  })

  it("skan bez filtra typu entitlementu jest błędem (R-2.5-H4)", async () => {
    const sql = new FakeSql()
    const ledger = new PgDispatchLedger(sql)
    await expect(
      ledger.scanDeliveryGaps({
        template_keys: [TEMPLATE_KEY],
        source_states: [...SWEEP_SOURCE_STATES],
        entitlement_types: [],
        created_before: OLD_ENOUGH,
        created_after: minutesAgo(10080),
        stale_queued_before: OLD_ENOUGH,
        max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        limit: 10,
      }),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_GAP_SCAN_ENTITLEMENT_TYPES_EMPTY",
    })
  })

  it("`truncated` NIE zapala się przy zaległości dokładnie równej limitowi (R-2.5-I13)", async () => {
    const { deps } = makeHarness({
      batchLimit: 2,
      entitlements: [
        issuedEntitlement("ent_exact_1", minutesAgo(90)),
        issuedEntitlement("ent_exact_2", minutesAgo(80)),
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.scanned).toBe(2)
    expect(report.truncated).toBe(false)
  })
})

describe("AC2 — awaria pojedynczego wiersza nie przerywa przebiegu, job nie rzuca", () => {
  it("wysyłka jednego wiersza pada → drugi jest dogoniony, job nie rzuca", async () => {
    const failing = new Set(["ent_fail_1"])
    const { deps, sql } = makeHarness({
      entitlements: [
        issuedEntitlement("ent_fail_1", minutesAgo(90)),
        issuedEntitlement("ent_ok_2", minutesAgo(80)),
      ],
      dispatchImpl: async (payload) => {
        const entitlementId = String(
          (payload.data as Record<string, unknown> | undefined)
            ?.entitlement_id ?? "",
        )
        if (failing.has(entitlementId)) {
          throw new Error("provider transport [gp_error_code=BREVO_TRANSPORT_ERROR]")
        }
        return { id: "brevo-message-ok" }
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.still_failing).toBe(1)
    expect(report.recovered).toBe(1)
    const failed = sql.dispatch.find((r) => r.entitlement_id === "ent_fail_1")
    expect(failed).toMatchObject({
      status: "failed",
      error_code: "BREVO_TRANSPORT_ERROR",
    })
  })

  it("awaria SKANU nie udaje sukcesu „0 luk” i nie rzuca", async () => {
    const { deps, logger, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_scan_fail")],
    })
    deps.scanner = scannerWith(deps.scanner, {
      async scanDeliveryGaps() {
        throw new Error("pg down")
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.status).toBe("scan_failed")
    expect(report.scanned).toBe(0)
    expect(logger.entries.some((entry) => entry.level === "error")).toBe(true)
    expect(
      captured.find((c) => c.event === METRIC_HEARTBEAT)?.properties.status,
    ).toBe("scan_failed")
  })

  it("awaria licznika granicy H1 nie unieważnia udanych dosyłek", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_count_fail")],
    })
    deps.scanner = scannerWith(deps.scanner, {
      async countGapsBeyondSourceStates() {
        throw new Error("count failed")
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.status).toBe("completed")
    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
  })
})

// ── AC3: metryka „entitlement bez dispatchu" ───────────────────────────────

describe("AC3 — licznik „entitlement bez dispatchu” jako metryka alertu", () => {
  it("metryka ma wymiar `market_id` i ROZRÓŻNIA found / recovered / still_failing", async () => {
    const sql = new FakeSql()
    sql.seedEntitlement({
      id: "ent_m1",
      state: "ISSUED",
      market_id: "bonbeauty",
      created_at: minutesAgo(90),
    })
    sql.seedEntitlement({
      id: "ent_m2",
      state: "ISSUED",
      market_id: "mercur",
      created_at: minutesAgo(80),
    })

    const { deps, captured } = makeHarness({
      sql,
      dispatchImpl: async (payload) => {
        const marketId = String(
          (payload.data as Record<string, unknown> | undefined)?.market_id ?? "",
        )
        if (marketId === "mercur") {
          throw new Error("brak szablonu [gp_error_code=BREVO_TEMPLATE_NOT_CONFIGURED]")
        }
        return { id: "brevo-message-1" }
      },
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.per_market).toMatchObject([
      { market_id: "bonbeauty", found: 1, recovered: 1, still_failing: 0 },
      { market_id: "mercur", found: 1, recovered: 0, still_failing: 1 },
    ])
    // R-2.5-M7 — zbiór kubełków jest DOMKNIĘTY: bez tego rynek z samymi
    // `skipped`/`exhausted` raportowałby „nic się nie zepsuło".
    for (const row of report.per_market) {
      expect(
        row.recovered +
          row.still_failing +
          row.unresolvable +
          row.exhausted +
          row.skipped +
          row.state_mismatch +
          row.errored,
      ).toBe(row.found)
    }

    const gapMetrics = captured.filter((c) => c.event === METRIC_GAP)
    expect(gapMetrics).toHaveLength(2)
    expect(gapMetrics[0].properties).toMatchObject({
      schedule_name: SCHEDULE_NAME,
      market_id: "bonbeauty",
      entitlements_without_dispatch: 1,
      recovered: 1,
      still_failing: 0,
    })
    expect(gapMetrics[1].properties).toMatchObject({
      market_id: "mercur",
      entitlements_without_dispatch: 1,
      recovered: 0,
      still_failing: 1,
    })
  })

  it("`found` liczy lukę PRZED dosyłką — nie jest licznikiem sukcesów", async () => {
    const { deps, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_found")],
      dispatchImpl: async () => {
        throw new Error("padło [gp_error_code=BREVO_TRANSPORT_ERROR]")
      },
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    expect(
      captured.find((c) => c.event === METRIC_GAP)?.properties,
    ).toMatchObject({
      entitlements_without_dispatch: 1,
      recovered: 0,
      still_failing: 1,
    })
  })

  it("R-2.5-I15: wymiar metryki to rynek ROZSTRZYGNIĘTY, ten sam co w ledgerze", async () => {
    const sql = new FakeSql()
    sql.seedEntitlement({
      id: "ent_no_market",
      state: "ISSUED",
      market_id: null,
      created_at: OLD_ENOUGH,
    })
    const { deps } = makeHarness({ sql })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    // Projekcja skanu nie zna rynku, ale handler go rozstrzygnął i zapisał do
    // wiersza ledgera — metryka musi mówić o TYM SAMYM rynku, inaczej korelacja
    // „alert per rynek" ↔ „wiersze ledgera per rynek" nie ma jak się zgodzić.
    expect(report.per_market.map((row) => row.market_id)).toEqual([MARKET_ID])
    expect(sql.dispatch[0].market_id).toBe(MARKET_ID)
  })

  it("entitlement, którego rynku NIKT nie rozstrzygnął, trafia do `unknown`", async () => {
    const sql = new FakeSql()
    sql.seedEntitlement({
      id: "ent_unknown_market",
      state: "ISSUED",
      market_id: null,
      created_at: OLD_ENOUGH,
    })
    const { deps } = makeHarness({ sql })
    deps.delivery.sourceReader = {
      async findBuyerClaimSource() {
        return null
      },
    }

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.per_market.map((row) => row.market_id)).toEqual(["unknown"])
    expect(report.unresolvable).toBe(1)
  })

  it("ŻADNE PII nie trafia do metryki (D-70)", async () => {
    const { deps, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_pii")],
      giftSource: true,
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    const serialized = JSON.stringify(captured)
    expect(serialized).not.toContain("@")
    expect(serialized.toLowerCase()).not.toContain("kupujaca")
    expect(serialized.toLowerCase()).not.toContain("obdarowana")
    expect(serialized).not.toContain(VOUCHER_CODE)
  })

  it("ŻADNE PII nie trafia do logów sweepa (D-70)", async () => {
    const { deps, logger } = makeHarness({
      entitlements: [issuedEntitlement("ent_pii_log")],
      giftSource: true,
    })

    await runVoucherDeliveryReconciliationSweep(deps)

    const sweepEntries = logger.entries.filter((entry) =>
      entry.message.includes(SCHEDULE_NAME),
    )
    const serialized = JSON.stringify(sweepEntries)
    expect(serialized).not.toContain("@")
    expect(serialized.toLowerCase()).not.toContain("kupujaca")
    expect(serialized).not.toContain(VOUCHER_CODE)
  })

  it("R-2.5-H2: nośnik metryki ISTNIEJE w wiringu — klient z kontenera", () => {
    const captured: Array<{ event: string }> = []
    const container = {
      resolve: (key: string) =>
        key === POSTHOG_CONTAINER_KEY
          ? {
              capture: (args: { event: string }) =>
                captured.push({ event: args.event }),
            }
          : undefined,
    }

    const metrics = resolveSweepMetrics(
      container as never,
      makeLogger(),
    )
    metrics?.capture(METRIC_HEARTBEAT, { status: "completed" })

    expect(metrics).toBeDefined()
    expect(captured).toEqual([{ event: METRIC_HEARTBEAT }])
  })

  it("R-2.5-H2: brak klucza PostHoga = JEDEN `warn` na proces, nie cisza", () => {
    const env = process.env
    try {
      process.env = { ...env }
      delete process.env.POSTHOG_API_KEY
      __resetPosthogMetricsClientForTests(null)

      const logger = makeLogger()
      expect(getPosthogCaptureClient(logger.warn)).toBeNull()
      expect(getPosthogCaptureClient(logger.warn)).toBeNull()

      const warns = logger.entries.filter((entry) => entry.level === "warn")
      expect(warns).toHaveLength(1)
      expect(warns[0].message).toContain("POSTHOG_API_KEY")
    } finally {
      process.env = env
      __resetPosthogMetricsClientForTests(null)
    }
  })

  it("brak PostHoga w kontenerze nie wywraca przebiegu (metryka opcjonalna)", async () => {
    const { deps, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_no_metrics")],
    })
    deps.metrics = undefined

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.recovered).toBe(1)
    expect(dispatchCalls).toHaveLength(1)
  })
})

// ── Granice zakresu ────────────────────────────────────────────────────────

describe("Granice zakresu 2.5 (AD-7, AC2)", () => {
  const rawSource = readFileSync(
    join(__dirname, "../../jobs/voucher-delivery-reconciliation-sweep.ts"),
    "utf8",
  )

  /**
   * Asercje granic mówią o KODZIE, nie o dokumentacji: komentarze tego pliku
   * nazywają zakazy wprost („NIE woła createNotifications", „NIE emituje
   * delivery_state_changed"), więc szukanie literałów w surowym tekście dawałoby
   * fałszywą czerwień.
   */
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

  it("job NIE woła `createNotifications` bezpośrednio — poza cienkim wiringiem kontenera", () => {
    expect(source).toContain("handleVoucherPurchaseDelivery")
    const [core, wrapper] = source.split(
      "export default async function voucherDeliveryReconciliationSweepJob",
    )
    expect(wrapper).toBeDefined()
    // Rdzeń sweepa (czysta funkcja + helpery) nie zna modułu Notification;
    // `createNotifications` żyje WYŁĄCZNIE w cienkim wiringu kontenerowym,
    // który buduje TE SAME porty co subscriber.
    expect(core).not.toContain("createNotifications")
    expect(wrapper).toContain("createNotifications")
  })

  it("job NIE emituje `gp.communication.delivery_state_changed.v1` (enum zapożyczony)", () => {
    // Nie da się emitować eventu bez event busa — a job nie ma do niego
    // ŻADNEJ zależności.
    expect(source).not.toContain("delivery_state_changed")
    expect(source).not.toMatch(/eventBus|event_bus|\.emit\(/)
    expect(source).not.toContain("Modules.EVENT_BUS")
  })

  it("job NIE buduje outboxa ani drugiej tabeli kolejki", () => {
    expect(source).not.toMatch(/CREATE TABLE/i)
    expect(source).not.toMatch(/INSERT INTO/i)
  })

  it("job nie zna gift/handoff — drugi szablon należy do 2.4", () => {
    expect(source).not.toContain("VOUCHER_HANDOFF_LINK")
    expect(source).not.toContain("evaluateGiftHandoff")
  })
})
