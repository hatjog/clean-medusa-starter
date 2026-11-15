/**
 * v1.16.0 Story 4.3 AC3 (D-33) — kanał alarmu z fallbackiem, wynik obu prób,
 * fail-loud przy braku kanałów; lokalny odbiornik HTTP (atrapa) zamiast
 * realnego Sentry/webhooka (realny kanał = NEEDS-LIVE-RUN do poświadczenia PO).
 * Plus DW-15-316: porażka zapisu DLQ idzie kanałem alarmu.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

import {
  ALERT_CHANNEL_ENV_VARS,
  ALERT_CODE_CHANNEL_ALL_FAILED,
  ALERT_CODE_CHANNEL_DELIVERED,
  ALERT_CODE_CHANNEL_DELIVERED_AFTER_FAILURE,
  ALERT_CODE_CHANNEL_NOT_CONFIGURED,
  deliverAlert,
  parseSentryDsn,
  type FetchLike,
} from "../lib/alert-channel"
import type { StructuredAlertPayload } from "../lib/alert-emit"
import { MARKETS_ENV_VAR } from "../jobs/compensation-failure-recovery-alarm"
import {
  alarmDlqWriteFailures,
  DLQ_WRITE_FAILED_ALERT_CODE,
  DLQ_WRITE_FAILED_CODE,
} from "../subscribers/on-order-placed-stripe-retry"

const ALERT: StructuredAlertPayload = {
  severity: "ERROR",
  code: "RECOVERY_COMPENSATION_FAILURE_OVERDUE",
  message: "test",
  context: { failure_id: "mpcf_1" },
}

type Received = { path: string; headers: Record<string, unknown>; body: unknown }

describe("Story 4.3 AC3 — deliverAlert przez lokalny odbiornik HTTP", () => {
  let server: Server
  let base: string
  const received: Received[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = ""
      req.on("data", (c) => (data += c))
      req.on("end", () => {
        received.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(data || "null") })
        res.statusCode = req.url?.includes("down") ? 503 : 200
        res.end("{}")
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it("podstawowy (sentry) pada ⇒ fallback webhook dostarcza; wynik obu prób zapisany", async () => {
    received.length = 0
    const emitted: StructuredAlertPayload[] = []
    const result = await deliverAlert(ALERT, {
      env: {
        GP_ALERT_CHANNELS: "sentry,webhook",
        GP_ALERT_SENTRY_DSN: `${base.replace("http://", "http://pubkey@")}/down`,
        GP_ALERT_WEBHOOK_URL: `${base}/hook`,
      },
      emit: (p) => emitted.push(p),
    })
    expect(result).toEqual({
      status: "delivered",
      delivered_via: "webhook",
      attempts: [
        { channel: "sentry", ok: false, error: "http_status_503" },
        { channel: "webhook", ok: true },
      ],
    })
    expect(received.map((r) => r.path)).toEqual(["/api/down/store/", "/hook"])
    expect(received[0].headers["x-sentry-auth"]).toMatch(/sentry_key=pubkey/)
    expect(received[1].body).toEqual(expect.objectContaining({ code: ALERT.code, context: ALERT.context }))
    // Fix R1: porażka podstawowego przy sukcesie fallbacku zostawia nazwany ślad WARN (log + ring buffer).
    expect(emitted).toEqual([
      expect.objectContaining({
        severity: "WARN",
        code: ALERT_CODE_CHANNEL_DELIVERED_AFTER_FAILURE,
        context: expect.objectContaining({
          alert_code: ALERT.code,
          delivered_via: "webhook",
          attempts: [
            { channel: "sentry", ok: false, error: "http_status_503" },
            { channel: "webhook", ok: true },
          ],
        }),
      }),
    ])
    // bez sekretów: DSN (klucz, host) nie trafia do śladu
    expect(JSON.stringify(emitted)).not.toMatch(/pubkey|127\.0\.0\.1/)
  })

  it("dostarczenie pierwszą próbą = INFO z delivered_via i attempts", async () => {
    const emitted: StructuredAlertPayload[] = []
    const result = await deliverAlert(ALERT, { env: { GP_ALERT_CHANNELS: "webhook", GP_ALERT_WEBHOOK_URL: `${base}/hook` }, emit: (p) => emitted.push(p) })
    expect(result.status).toBe("delivered")
    expect(emitted).toEqual([
      expect.objectContaining({
        severity: "INFO",
        code: ALERT_CODE_CHANNEL_DELIVERED,
        context: expect.objectContaining({ delivered_via: "webhook", attempts: [{ channel: "webhook", ok: true }] }),
      }),
    ])
  })

  it("błąd próby zawierający URL z sekretem jest zredagowany", async () => {
    const leaky: FetchLike = async (url) => {
      throw new Error(`connect failed ${url}`)
    }
    const result = await deliverAlert(ALERT, {
      env: { GP_ALERT_CHANNELS: "sentry", GP_ALERT_SENTRY_DSN: "https://secretkey@sentry.example/42" },
      fetch: leaky,
      emit: () => undefined,
    })
    expect(result.attempts).toEqual([{ channel: "sentry", ok: false, error: "connect failed <url>" }])
  })

  it("oba kanały padają ⇒ nazwany ERROR ALERT_CHANNEL_ALL_FAILED, nie cisza", async () => {
    const emitted: StructuredAlertPayload[] = []
    const result = await deliverAlert(ALERT, {
      env: { GP_ALERT_CHANNELS: "webhook,sentry", GP_ALERT_WEBHOOK_URL: `${base}/down-hook`, GP_ALERT_SENTRY_DSN: `${base.replace("http://", "http://k@")}/down` },
      emit: (p) => emitted.push(p),
    })
    expect(result).toEqual(expect.objectContaining({ status: "failed", code: ALERT_CODE_CHANNEL_ALL_FAILED }))
    expect(result.attempts.map((a) => a.ok)).toEqual([false, false])
    expect(emitted).toEqual([expect.objectContaining({ severity: "ERROR", code: ALERT_CODE_CHANNEL_ALL_FAILED })])
  })

  it("brak kanałów ⇒ ERROR ALERT_CHANNEL_NOT_CONFIGURED (log nie jest jedynym nośnikiem)", async () => {
    const emitted: StructuredAlertPayload[] = []
    const result = await deliverAlert(ALERT, { env: {}, emit: (p) => emitted.push(p) })
    expect(result).toEqual({ status: "failed", code: ALERT_CODE_CHANNEL_NOT_CONFIGURED, attempts: [] })
    expect(emitted.map((e) => e.code)).toEqual([ALERT_CODE_CHANNEL_NOT_CONFIGURED])
  })

  it("zadeklarowany kanał bez konfiguracji = próba nieudana z nazwą, potem fallback", async () => {
    received.length = 0
    const result = await deliverAlert(ALERT, {
      env: { GP_ALERT_CHANNELS: "sentry,webhook", GP_ALERT_WEBHOOK_URL: `${base}/hook` },
      emit: () => undefined,
    })
    expect(result.status).toBe("delivered")
    expect(result.attempts[0]).toEqual(expect.objectContaining({ channel: "sentry", ok: false }))
  })

  it("wyjątek sieci (fetch rzuca) = próba nieudana, nie wyjątek wywołującego", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED")
    }
    const result = await deliverAlert(ALERT, {
      env: { GP_ALERT_CHANNELS: "webhook", GP_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/x" },
      fetch: boom,
      emit: () => undefined,
    })
    expect(result).toEqual({ status: "failed", code: ALERT_CODE_CHANNEL_ALL_FAILED, attempts: [{ channel: "webhook", ok: false, error: "ECONNREFUSED" }] })
  })

  it("parseSentryDsn odrzuca DSN bez klucza", () => {
    expect(() => parseSentryDsn("https://sentry.example/1")).toThrow(/klucza/)
  })
})

describe("Story 4.3 DW-15-316 — porażka zapisu DLQ idzie kanałem alarmu", () => {
  it("emituje ERROR RECOVERY_DLQ_WRITE_FAILED i dostarcza kanałem", async () => {
    const emitted: StructuredAlertPayload[] = []
    const sent: StructuredAlertPayload[] = []
    const result = await alarmDlqWriteFailures(
      [{ order_id: "order_1", event_id: "evt_1", event_class: "transient" as never, cause: "db_error", message: "x" }],
      {
        emit: (p) => emitted.push(p),
        deliver: async (p) => {
          sent.push(p)
          return { status: "delivered", delivered_via: "webhook", attempts: [{ channel: "webhook", ok: true }] }
        },
      }
    )
    expect(emitted).toEqual([expect.objectContaining({ severity: "ERROR", code: DLQ_WRITE_FAILED_ALERT_CODE, context: expect.objectContaining({ log_code: DLQ_WRITE_FAILED_CODE, count: 1 }) })])
    expect(sent).toHaveLength(1)
    expect(result?.status).toBe("delivered")
  })

  it("zero porażek = brak alarmu", async () => {
    const emitted: StructuredAlertPayload[] = []
    expect(await alarmDlqWriteFailures([], { emit: (p) => emitted.push(p) })).toBeNull()
    expect(emitted).toEqual([])
  })
})

describe("Story 4.3 — `.env.example` deklaruje nowe zmienne (wzorzec R-4.1-H3)", () => {
  const envExample = readFileSync(join(__dirname, "../../../../.env.example"), "utf8")
  const keys = envExample.split(/\r?\n/).map((l) => l.split("=")[0])
  it.each([...ALERT_CHANNEL_ENV_VARS, MARKETS_ENV_VAR])("%s", (name) => {
    expect(keys).toContain(name)
  })
  it("rynki joba alarmu mają niepustą wartość z bonbeauty", () => {
    const line = envExample.split(/\r?\n/).find((l) => l.startsWith(`${MARKETS_ENV_VAR}=`))
    expect(line?.split("=")[1].split(",")).toContain("bonbeauty")
  })
})
