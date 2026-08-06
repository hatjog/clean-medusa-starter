/**
 * compensation-failure-registry.test.ts — v1.15.0 Story 3.5 (FR-6c, NFR-3, AD-22).
 *
 * Dowód jest Z WYKONANIA, nie z obecności: każdy przypadek WSTRZYKUJE awarię
 * (klient PG rzucający na `DELETE`, a w drugim przypadku rzucający także na
 * `INSERT` do rejestru) i sprawdza TREŚĆ tego, co powstało — nie `rowCount > 0`
 * ani obecność stringa w logu.
 *
 * Kontrola negatywna (AC3): usunięcie `reportCompensationFailure` z `route.ts`
 * MUSI wywalić ten plik na czerwono. Zbiór nazw testów, które padły po mutacji,
 * jest w `evidence/3-5/cisza-kontrola-negatywna.md` — nie licznik.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals"
import { createHmac } from "node:crypto"

jest.mock("../../../../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { POST } from "../route"
import { STRIPE_SIGNATURE_HEADER } from "../helpers"
import { Modules } from "@medusajs/framework/utils"
import { getRingBuffer, _resetRingBuffer } from "../../../../../lib/alert-emit"
import {
  buildCompensationFailureId,
  buildPurchaseCorrelationKey,
  COMPENSATION_FAILURE_ALERT_CODE,
  COMPENSATION_FAILURE_STDERR_PREFIX,
} from "../../../../../lib/payment/money-path-compensation-registry"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../../../../lib/payment/stripe-payment-intent-transport"

const SECRET = "whsec_test_3_5"
const PI_ID = "pi_3Tzcompensation000001"
const EVT_ID = "evt_compensation_3_5"

function signedHeader(rawBody: string, secret = SECRET): string {
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac("sha256", secret)
    .update(Buffer.from(`${ts}.${rawBody}`))
    .digest("hex")
  return `t=${ts},v1=${sig}`
}

function stripePiEvent() {
  return {
    id: EVT_ID,
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: PI_ID,
        amount: 24900,
        currency: "pln",
        created: Math.floor(Date.now() / 1000),
        metadata: {
          order_id: "order_3_5_a",
          market_id: "bonbeauty",
          instance_id: "gp-dev",
        },
      },
    },
  }
}

type FakeRes = {
  statusCode: number
  body: Record<string, unknown> | undefined
  status: (c: number) => FakeRes
  json: (b: unknown) => void
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b as Record<string, unknown>
    },
  }
  return res
}

type RegistryRow = {
  failure_id: string
  market_id: string
  compensation_kind: string
  delivery_path: string
  stripe_event_id: string
  payment_intent_id: string
  order_id: string | null
  purchase_correlation_key: string
  failure_code: string
  failure_detail: string
  attempt_count: number
  resolution_state: string
}

/**
 * Klient PG w pamięci z WSTRZYKNIĘTYMI awariami.
 *
 * `failRelease` — `DELETE` z `webhook_event_processed` rzuca (kompensacja pada).
 * `failRegistry` — `INSERT` do `money_path_compensation_failure` rzuca
 * (podwójna awaria: pada dokładnie ten zasób, do którego AC1 każe zapisać).
 *
 * `registry` jest tabelą: `ON CONFLICT (failure_id) DO UPDATE` jest tu
 * ODWZOROWANE, żeby test idempotencji mierzył zachowanie, a nie mock.
 */
function makeHarness(options: { failRelease: boolean; failRegistry: boolean }) {
  const registry = new Map<string, RegistryRow>()
  const deliveries = new Set<string>()
  const sqlSeen: string[] = []
  const emitAttempts: number[] = []
  const connects: string[] = []

  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      sqlSeen.push(sql)

      if (/INSERT INTO webhook_event_processed/i.test(sql)) {
        deliveries.add(`${values[0]}|${values[1]}`)
        return { rows: [], rowCount: 1 }
      }

      if (/DELETE FROM webhook_event_processed/i.test(sql)) {
        if (options.failRelease) {
          throw new Error("PG: connection terminated during DELETE")
        }
        deliveries.delete(`${values[0]}|${values[1]}`)
        return { rows: [], rowCount: 1 }
      }

      if (/INSERT INTO money_path_compensation_failure/i.test(sql)) {
        if (options.failRegistry) {
          throw new Error("PG: relation money_path_compensation_failure unavailable")
        }
        const failureId = values[0] as string
        const existing = registry.get(failureId)
        const row: RegistryRow = existing
          ? {
              ...existing,
              attempt_count: existing.attempt_count + 1,
              failure_detail: values[9] as string,
            }
          : {
              failure_id: failureId,
              market_id: values[1] as string,
              compensation_kind: values[2] as string,
              delivery_path: values[3] as string,
              stripe_event_id: values[4] as string,
              payment_intent_id: values[5] as string,
              order_id: (values[6] as string | null) ?? null,
              purchase_correlation_key: values[7] as string,
              failure_code: values[8] as string,
              failure_detail: values[9] as string,
              attempt_count: 1,
              resolution_state: "open",
            }
        registry.set(failureId, row)
        return { rows: [row], rowCount: 1 }
      }

      // Kontekst rynkowy zamówienia (ten sam fixture, co route-thin.test.ts).
      if (/AS order_id/i.test(sql) && /sales_channel/i.test(sql)) {
        return {
          rows: [
            {
              order_id: "order_3_5_a",
              order_metadata: { gp: { market_id: "bonbeauty" } },
              sales_channel_id: "sc_bonbeauty",
              sales_channel_market_id: "bonbeauty",
            },
          ],
          rowCount: 1,
        }
      }

      return { rows: [], rowCount: 0 }
    },
    release: () => {},
  }

  const req = {
    rawBody: Buffer.from(""),
    headers: {} as Record<string, string>,
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "__pg_pool__") {
          return {
            connect: async () => {
              connects.push("__pg_pool__")
              return client
            },
          }
        }
        if (key === Modules.EVENT_BUS) {
          return {
            emit: async () => {
              emitAttempts.push(1)
              throw new Error("event bus refused")
            },
          }
        }
        throw new Error(`unresolved ${key}`)
      },
    },
  }

  function withBody(rawBody: string) {
    req.rawBody = Buffer.from(rawBody, "utf8")
    req.headers = { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) }
    return req
  }

  return { withBody, registry, deliveries, sqlSeen, emitAttempts, connects }
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk))
    return original(chunk, ...(rest as []))
  }
  return { lines, restore: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = original
  } }
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  _resetRingBuffer()
})

describe("Story 3.5 AC1 — nieudana kompensacja kończy się WPISEM W BAZIE i ALARMEM", () => {
  it("wstrzyknięta awaria `releaseWebhookDelivery` ⇒ DOKŁADNIE JEDEN wiersz rejestru o oczekiwanej TREŚCI", async () => {
    const h = makeHarness({ failRelease: true, failRegistry: false })
    const raw = JSON.stringify(stripePiEvent())
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(h.withBody(raw) as any, res as any)

    // Kompensacja faktycznie padła — inaczej test mierzyłby szczęśliwą ścieżkę.
    expect(h.sqlSeen.some((s) => /DELETE FROM webhook_event_processed/i.test(s))).toBe(true)

    const rows = Array.from(h.registry.values())
    expect(rows).toHaveLength(1)

    // Asercja na TREŚCI wiersza, nie na `rowCount > 0`.
    const row = rows[0]
    expect(row.compensation_kind).toBe("webhook_delivery_release")
    expect(row.delivery_path).toBe(STRIPE_PATH_Y_WEBHOOK_PROVIDER)
    expect(row.stripe_event_id).toBe(EVT_ID)
    expect(row.payment_intent_id).toBe(PI_ID)
    expect(row.order_id).toBe("order_3_5_a")
    expect(row.market_id).toBe("bonbeauty")
    expect(row.purchase_correlation_key).toBe(buildPurchaseCorrelationKey(PI_ID))
    expect(row.failure_code).toBe("delivery_release_failed")
    expect(row.failure_detail).toContain("connection terminated")
    expect(row.resolution_state).toBe("open")
    expect(row.attempt_count).toBe(1)
    expect(row.failure_id).toBe(
      buildCompensationFailureId({
        delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
        stripe_event_id: EVT_ID,
        compensation_kind: "webhook_delivery_release",
        failure_code: "delivery_release_failed",
        order_id: "order_3_5_a",
      })
    )
  })

  it("RÓWNOLEGLE powstaje alarm — drugi nośnik obok wpisu, nie jego zamiennik", async () => {
    const h = makeHarness({ failRelease: true, failRegistry: false })
    const raw = JSON.stringify(stripePiEvent())
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(h.withBody(raw) as any, res as any)

    const alerts = getRingBuffer().filter(
      (entry) => entry.code === COMPENSATION_FAILURE_ALERT_CODE
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe("ERROR")
    expect(alerts[0].context?.registry_persisted).toBe(true)
    expect(alerts[0].context?.order_id).toBe("order_3_5_a")
    expect(alerts[0].context?.market_id).toBe("bonbeauty")

    // I JEDNOCZEŚNIE wpis w bazie — alarm sam w sobie NIE spełnia AC.
    expect(Array.from(h.registry.values())).toHaveLength(1)
  })

  it("zapis rejestru idzie ŚWIEŻYM połączeniem, nie tym właśnie padniętym uchwytem", async () => {
    const h = makeHarness({ failRelease: true, failRegistry: false })
    const raw = JSON.stringify(stripePiEvent())
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(h.withBody(raw) as any, res as any)

    // Dwa `connect()`: jeden dla obsługi żądania, drugi dla zapisu rejestru.
    expect(h.connects.length).toBeGreaterThanOrEqual(2)
    const alerts = getRingBuffer().filter(
      (entry) => entry.code === COMPENSATION_FAILURE_ALERT_CODE
    )
    expect(alerts[0].context?.registry_writer_origin).toBe("fresh")
  })

  it("ponowna dostawa TEGO SAMEGO `evt_…` NIE mnoży wierszy i NIE gubi kolejnej próby", async () => {
    const h = makeHarness({ failRelease: true, failRegistry: false })
    const raw = JSON.stringify(stripePiEvent())

    for (const _ of [1, 2, 3]) {
      const res = makeRes()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await POST(h.withBody(raw) as any, res as any)
    }

    const rows = Array.from(h.registry.values())
    expect(rows).toHaveLength(1)
    expect(rows[0].attempt_count).toBe(3)
  })
})

describe("Story 3.5 AC3 — cisza jest niemożliwa TAKŻE gdy padnie sam zapis do rejestru", () => {
  it("podwójna awaria (kompensacja I rejestr) ⇒ kod zachowujący ponowienie, NIE 200 { received: true }", async () => {
    const h = makeHarness({ failRelease: true, failRegistry: true })
    const raw = JSON.stringify(stripePiEvent())
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(h.withBody(raw) as any, res as any)

    expect(res.statusCode).toBe(500)
    expect(res.body?.type).toBe("compensation_failed")
    expect(res.body?.registry_persisted).toBe(false)
    expect(res.body?.registry_error).toEqual(expect.stringContaining("unavailable"))

    // Brak zakończenia sukcesem — asercja jawna, nie „500 więc chyba nie 200".
    expect(res.body?.received).toBeUndefined()
    expect(Array.from(h.registry.values())).toHaveLength(0)
  })

  it("przy podwójnej awarii alarm jest CRITICAL i wychodzi na nośnik POZA BAZĄ (stderr)", async () => {
    const captured = captureStderr()
    try {
      const h = makeHarness({ failRelease: true, failRegistry: true })
      const raw = JSON.stringify(stripePiEvent())
      const res = makeRes()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await POST(h.withBody(raw) as any, res as any)

      const alerts = getRingBuffer().filter(
        (entry) => entry.code === COMPENSATION_FAILURE_ALERT_CODE
      )
      expect(alerts).toHaveLength(1)
      expect(alerts[0].severity).toBe("CRITICAL")
      expect(alerts[0].context?.registry_persisted).toBe(false)

      const oob = captured.lines.filter((line) =>
        line.startsWith(COMPENSATION_FAILURE_STDERR_PREFIX)
      )
      expect(oob).toHaveLength(1)
      const payload = JSON.parse(
        oob[0].slice(COMPENSATION_FAILURE_STDERR_PREFIX.length + 1)
      ) as Record<string, unknown>
      expect(payload.stripe_event_id).toBe(EVT_ID)
      expect(payload.payment_intent_id).toBe(PI_ID)
      expect(payload.registry_persisted).toBe(false)
    } finally {
      captured.restore()
    }
  })

  it("ŻADNA ścieżka wyjścia z gałęzi kompensacji nie odpowiada 200", async () => {
    for (const failRegistry of [false, true]) {
      const h = makeHarness({ failRelease: true, failRegistry })
      const raw = JSON.stringify(stripePiEvent())
      const res = makeRes()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await POST(h.withBody(raw) as any, res as any)
      expect(res.statusCode).toBe(500)
      expect(res.body?.type).toBe("compensation_failed")
      expect(res.body?.received).toBeUndefined()
    }
  })

  it("UDANA kompensacja NIE zapisuje wiersza — bramka nie świeci na zdrowej ścieżce", async () => {
    const h = makeHarness({ failRelease: false, failRegistry: false })
    const raw = JSON.stringify(stripePiEvent())
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(h.withBody(raw) as any, res as any)

    expect(res.statusCode).toBe(500)
    expect(res.body?.type).toBe("emit_failed")
    expect(Array.from(h.registry.values())).toHaveLength(0)
    expect(
      getRingBuffer().filter((e) => e.code === COMPENSATION_FAILURE_ALERT_CODE)
    ).toHaveLength(0)
  })
})
