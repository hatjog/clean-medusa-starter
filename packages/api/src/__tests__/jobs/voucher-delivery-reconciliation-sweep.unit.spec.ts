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
  SWEEP_MAX_ATTEMPT_COUNT,
  SWEEP_SOURCE_STATES,
  SWEEP_STALE_QUEUED_MS,
  type SweepDeps,
  type SweepMetricsPort,
} from "../../jobs/voucher-delivery-reconciliation-sweep"
import {
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
  type DispatchLedgerPort,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { DISPATCH_STATES_ALLOWING_RETRY } from "../../modules/voucher-delivery/delivery-state"
import {
  handleVoucherPurchaseDelivery,
  STALE_QUEUED_THRESHOLD_MS,
  type PurchaseDeliveryDeps,
} from "../../subscribers/voucher-purchase-delivery"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"
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
        attempt_count: 1,
        queued_at: now,
        sent_at: null,
        failed_at: null,
      }
      this.dispatch.push(row)
      return { rows: [{ ...row }] }
    }

    if (q.includes("COUNT(*)::int")) {
      return { rows: [{ gap_count: this.countBeyondStates(bindings) }] }
    }

    if (q.includes("CROSS JOIN (VALUES")) {
      return { rows: this.scanGaps(bindings) }
    }

    if (q.startsWith("SELECT")) {
      const [e, t, h] = bindings as string[]
      const row = this.find(e, t, h)
      return { rows: row ? [{ ...row }] : [] }
    }

    if (q.includes(`UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)) {
      if (q.includes("SET status = 'sent'")) {
        const [provider, messageId, now, , id] = bindings as string[]
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "sent",
          provider,
          provider_message_id: messageId,
          error_code: null,
          sent_at: now,
        })
        return { rows: [{ ...row }] }
      }

      if (q.includes("provider = COALESCE")) {
        // markFailed (2.3): guard `status='queued'`.
        const [provider, errorCode, now, , id] = bindings as string[]
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "failed",
          provider: provider ?? row.provider,
          error_code: errorCode,
          failed_at: now,
        })
        return { rows: [{ ...row }] }
      }

      if (q.includes("SET status = 'failed'")) {
        // abandonStaleQueued (2.5, D3): guard `status='queued' AND queued_at < próg`.
        const [errorCode, now, , id, staleBefore] = bindings as string[]
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        if (!(String(row.queued_at) < staleBefore)) return { rows: [] }
        Object.assign(row, {
          status: "failed",
          error_code: errorCode,
          failed_at: now,
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

  private scanGaps(bindings: readonly unknown[]): Row[] {
    const b = bindings as (string | number)[]
    const L = b.length
    expect(SWEEP_SOURCE_STATES).toHaveLength(2)
    expect(DISPATCH_STATES_ALLOWING_RETRY).toHaveLength(2)
    const limit = Number(b[L - 1])
    const retryStates = b.slice(L - 3, L - 1).map(String)
    const staleBefore = String(b[L - 4])
    const createdBefore = String(b[L - 5])
    const states = b.slice(L - 7, L - 5).map(String)
    const templates = b.slice(0, L - 7).map(String)

    const rows: Row[] = []
    const ordered = [...this.entitlements].sort((a, z) =>
      String(a.created_at) === String(z.created_at)
        ? String(a.id).localeCompare(String(z.id))
        : String(a.created_at).localeCompare(String(z.created_at)),
    )

    for (const entitlement of ordered) {
      if (!states.includes(String(entitlement.state))) continue
      if (!(String(entitlement.created_at) < createdBefore)) continue

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

        rows.push({
          entitlement_id: entitlement.id,
          market_id: entitlement.market_id,
          entitlement_state: entitlement.state,
          template_key: templateKey,
          dispatch_id: row?.dispatch_id ?? null,
          dispatch_status: row?.status ?? null,
          queued_at: row?.queued_at ?? null,
          attempt_count: row?.attempt_count ?? 0,
        })
        if (rows.length >= limit) return rows
      }
    }

    return rows
  }

  private countBeyondStates(bindings: readonly unknown[]): number {
    const b = bindings.map(String)
    const states = b.slice(0, 2)
    const createdBefore = b[2]
    const createdAfter = b[3]
    const templates = b.slice(4)

    return this.entitlements.filter((entitlement) => {
      if (states.includes(String(entitlement.state))) return false
      const createdAt = String(entitlement.created_at)
      if (!(createdAt < createdBefore)) return false
      if (!(createdAt >= createdAfter)) return false
      return !this.dispatch.some(
        (d) =>
          d.entitlement_id === entitlement.id &&
          templates.includes(String(d.template_key)),
      )
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
          ...(options.giftSource
            ? {
                purchase_mode: "gift",
                gift_recipient_email: "obdarowana@example.test",
                gift_recipient_send_timing: "immediate",
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
    },
    logger,
    env: { STOREFRONT_URL: "https://dev.bonbeauty.test" },
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
  }

  return { deps, delivery, sql, logger, metrics, captured, dispatchCalls }
}

function issuedEntitlement(id: string, createdAt = OLD_ENOUGH): EntitlementSeed {
  return { id, state: "ISSUED", created_at: createdAt }
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
    expect(source).toContain("isNotificationProviderReady")
    // NIE powstaje druga definicja gotowości providera w jobie.
    expect(source).not.toMatch(/BREVO_API_KEY/)
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

  it("wiersz po `SWEEP_MAX_ATTEMPT_COUNT` próbach: `exhausted`, bez wysyłki, z `warn`", async () => {
    const { deps, logger, dispatchCalls } = makeHarness({
      entitlements: [issuedEntitlement("ent_exhausted")],
      dispatchRows: [
        {
          dispatch_id: "dispatch-exhausted",
          entitlement_id: "ent_exhausted",
          status: "failed",
          error_code: "FLOW_DISABLED",
          attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      ],
    })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.exhausted).toBe(1)
    expect(report.attempted).toBe(0)
    expect(dispatchCalls).toHaveLength(0)
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" && entry.message.includes("wyczerpał próg prób"),
      ),
    ).toBe(true)
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
        created_before: OLD_ENOUGH,
        stale_queued_before: OLD_ENOUGH,
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
        created_before: OLD_ENOUGH,
        stale_queued_before: OLD_ENOUGH,
        limit: 10,
      }),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_GAP_SCAN_TEMPLATE_KEYS_EMPTY",
    })
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
          throw new Error("provider 500 [gp_error_code=BREVO_SEND_FAILED]")
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
      error_code: "BREVO_SEND_FAILED",
    })
  })

  it("awaria SKANU nie udaje sukcesu „0 luk” i nie rzuca", async () => {
    const { deps, logger, captured } = makeHarness({
      entitlements: [issuedEntitlement("ent_scan_fail")],
    })
    deps.scanner = {
      async scanDeliveryGaps() {
        throw new Error("pg down")
      },
      async countGapsBeyondSourceStates() {
        return 0
      },
      async abandonStaleQueued() {
        return false
      },
    }

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
    const scanner = deps.scanner
    deps.scanner = {
      scanDeliveryGaps: scanner.scanDeliveryGaps.bind(scanner),
      abandonStaleQueued: scanner.abandonStaleQueued.bind(scanner),
      async countGapsBeyondSourceStates() {
        throw new Error("count failed")
      },
    }

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

    expect(report.per_market).toEqual([
      { market_id: "bonbeauty", found: 1, recovered: 1, still_failing: 0 },
      { market_id: "mercur", found: 1, recovered: 0, still_failing: 1 },
    ])

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
        throw new Error("padło [gp_error_code=BREVO_SEND_FAILED]")
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

  it("entitlement bez `market_id` nie gubi się — trafia do wymiaru `unknown`", async () => {
    const sql = new FakeSql()
    sql.seedEntitlement({
      id: "ent_no_market",
      state: "ISSUED",
      market_id: null,
      created_at: OLD_ENOUGH,
    })
    const { deps } = makeHarness({ sql })

    const report = await runVoucherDeliveryReconciliationSweep(deps)

    expect(report.per_market.map((row) => row.market_id)).toEqual(["unknown"])
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
