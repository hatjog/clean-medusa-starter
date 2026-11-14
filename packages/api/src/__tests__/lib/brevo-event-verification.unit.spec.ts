/**
 * Story 6.6 (ADR-213 wariant C) — weryfikacja zwrotna zdarzenia przez API Brevo.
 *
 * Odpowiedzi API w ksztalcie z dokumentacji Brevo v3 (`GET
 * /v3/smtp/statistics/events`, `getEmailEventReport`). Zadnego ruchu sieciowego:
 * `fetch` jest wstrzykniety.
 */
import brevoDeliveryTracker from "../../subscribers/brevo-delivery-tracker"
import {
  BREVO_STATISTICS_EVENT_BY_TYPE,
  createBrevoDeliveryEventVerifier,
  DELIVERY_EVENT_PROVIDER_UNCONFIRMED_CODE,
  DELIVERY_EVENT_VERIFICATION_FAILED_CODE,
} from "../../lib/brevo-event-verification"

const MESSAGE_ID = "<202611140800.12345678901@smtp-relay.mailin.fr>"
const API_KEY = "xkeysib-test-only-never-real"

function fetchReturning(status: number, body: unknown) {
  return jest.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({
    status,
    json: async () => body,
  }))
}

describe("ADR-213 C — createBrevoDeliveryEventVerifier", () => {
  it("potwierdza trwale odbicie, gdy API zwraca wiersz `hardBounces` dla message-id (enum z dokumentacji)", async () => {
    const fetch = fetchReturning(200, {
      events: [
        {
          email: "example@domain.com",
          date: "2026-11-14T08:00:05.000+01:00",
          messageId: MESSAGE_ID,
          event: "hardBounces",
          reason: "550 5.1.1 user unknown",
          tag: "voucher_purchase_confirmation",
          from: "noreply@example.test",
        },
      ],
    })
    const verifier = createBrevoDeliveryEventVerifier({ apiKey: API_KEY, fetch })

    await expect(
      verifier.verify({ provider_message_id: MESSAGE_ID, event_type: "bounced_permanent" }),
    ).resolves.toEqual({ outcome: "confirmed", statistics_event: "hardBounces" })

    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v3/smtp/statistics/events?")
    expect(new URL(url).searchParams.get("messageId")).toBe(MESSAGE_ID)
    expect(new URL(url).searchParams.get("event")).toBe("hardBounces")
    expect(init.headers["api-key"]).toBe(API_KEY)
    // Klucz idzie WYLACZNIE w naglowku, nigdy w URL.
    expect(url).not.toContain(API_KEY)
  })

  it("zdarzenie innej klasy dla tego samego message-id NIE potwierdza (spam != bounce != accepted)", async () => {
    const fetch = fetchReturning(200, {
      events: [{ messageId: MESSAGE_ID, event: "delivered" }],
    })
    const verifier = createBrevoDeliveryEventVerifier({ apiKey: API_KEY, fetch })

    await expect(
      verifier.verify({ provider_message_id: MESSAGE_ID, event_type: "complaint" }),
    ).resolves.toEqual({
      outcome: "unconfirmed",
      statistics_event: "spam",
      error_code: DELIVERY_EVENT_PROVIDER_UNCONFIRMED_CODE,
    })
  })

  it("odpowiedz != 200 i blad sieci to `verification_failed`, rozlaczne z `unconfirmed`", async () => {
    const unauthorized = createBrevoDeliveryEventVerifier({
      apiKey: API_KEY,
      fetch: fetchReturning(401, { code: "unauthorized", message: "Key not found" }),
    })
    const offline = createBrevoDeliveryEventVerifier({
      apiKey: API_KEY,
      fetch: jest.fn(async () => {
        throw new Error(`getaddrinfo ENOTFOUND api.brevo.com ${API_KEY}`)
      }),
    })

    const a = await unauthorized.verify({ provider_message_id: MESSAGE_ID, event_type: "delivered" })
    const b = await offline.verify({ provider_message_id: MESSAGE_ID, event_type: "delivered" })
    expect(a).toEqual({
      outcome: "verification_failed",
      statistics_event: "delivered",
      error_code: DELIVERY_EVENT_VERIFICATION_FAILED_CODE,
      http_status: 401,
    })
    expect(b.outcome).toBe("verification_failed")
    expect(JSON.stringify([a, b])).not.toContain(API_KEY)
  })

  // R-1: enum `events[].event` z dokumentacji Brevo getEmailEventReport — ten
  // sam co enum filtra. Zadnych wymyslonych wartosci w liczbie pojedynczej.
  const BREVO_EVENT_REPORT_ENUM = [
    "bounces",
    "hardBounces",
    "softBounces",
    "delivered",
    "spam",
    "requests",
    "opened",
    "clicks",
    "invalid",
    "deferred",
    "blocked",
    "unsubscribed",
    "error",
    "loadedByProxy",
  ] as const

  it("R-1: kazda klasa potwierdza sie wierszem z enumem raportu (liczba mnoga) — mutant liczby pojedynczej = FAIL", async () => {
    for (const [eventType, filter] of Object.entries(BREVO_STATISTICS_EVENT_BY_TYPE)) {
      expect(BREVO_EVENT_REPORT_ENUM).toContain(filter)
      const verifier = createBrevoDeliveryEventVerifier({
        apiKey: API_KEY,
        fetch: fetchReturning(200, { events: [{ messageId: MESSAGE_ID, event: filter }] }),
      })
      await expect(
        verifier.verify({ provider_message_id: MESSAGE_ID, event_type: eventType as never }),
      ).resolves.toEqual({ outcome: "confirmed", statistics_event: filter })
    }
  })

  it("R-1: wartosc spoza enumu (`hardBounce`) NIE potwierdza trwalego odbicia", async () => {
    const verifier = createBrevoDeliveryEventVerifier({
      apiKey: API_KEY,
      fetch: fetchReturning(200, { events: [{ messageId: MESSAGE_ID, event: "hardBounce" }] }),
    })
    await expect(
      verifier.verify({ provider_message_id: MESSAGE_ID, event_type: "bounced_permanent" }),
    ).resolves.toMatchObject({ outcome: "unconfirmed" })
  })

  it("slownik filtra pokrywa kazda klase i rozdziela accepted/bounced/spam", () => {
    expect(BREVO_STATISTICS_EVENT_BY_TYPE.delivered).toBe("delivered")
    expect(BREVO_STATISTICS_EVENT_BY_TYPE.bounced_permanent).toBe("hardBounces")
    expect(BREVO_STATISTICS_EVENT_BY_TYPE.complaint).toBe("spam")
    expect(new Set(Object.values(BREVO_STATISTICS_EVENT_BY_TYPE)).size).toBe(
      Object.keys(BREVO_STATISTICS_EVENT_BY_TYPE).length,
    )
  })
})

describe("ADR-213 C — tracker odmawia zapisu bez potwierdzenia dostawcy", () => {
  const originalKey = process.env.BREVO_API_KEY
  const originalInstance = process.env.GP_INSTANCE_ID

  beforeEach(() => {
    delete process.env.BREVO_API_KEY
    process.env.GP_INSTANCE_ID = "gp-test"
  })
  afterAll(() => {
    if (originalKey === undefined) delete process.env.BREVO_API_KEY
    else process.env.BREVO_API_KEY = originalKey
    if (originalInstance === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = originalInstance
  })

  function container(verifier?: unknown) {
    const ledger = { applyProviderDeliveryState: jest.fn() }
    const sink = { record: jest.fn() }
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const db = {
      raw: jest.fn(async () => ({
        rows: [{ money_path_brakes: { fr_9_delivery_idempotency: "released" } }],
      })),
    }
    return {
      ledger,
      sink,
      logger,
      container: {
        resolve: (key: string) => {
          if (key === "logger") return logger
          if (key === "voucher_delivery_dispatch_ledger") return ledger
          if (key === "notification_delivery_audit_sink") return sink
          if (key === "__pg_connection__") return db
          if (key === "notification_dispatches") return { findByProviderMessageId: async () => null }
          if (key === "brevo_delivery_event_verifier" && verifier) return verifier
          throw new Error(`Unknown container key: ${key}`)
        },
      },
    }
  }

  const event = {
    name: "notification.hard_bounce",
    data: {
      provider_id: "brevo",
      provider_event_id: MESSAGE_ID,
      market_id: "bonbeauty",
      event_type: "hard_bounce",
    },
  }

  it("brak weryfikatora i klucza: DELIVERY_EVENT_VERIFICATION_UNAVAILABLE, nic nie zapisane", async () => {
    const ctx = container()
    await expect(
      brevoDeliveryTracker({ event, container: ctx.container } as never),
    ).rejects.toThrow(/DELIVERY_EVENT_VERIFICATION_UNAVAILABLE/)
    expect(ctx.ledger.applyProviderDeliveryState).not.toHaveBeenCalled()
    expect(ctx.sink.record).not.toHaveBeenCalled()
  })

  it("dostawca nie potwierdza: DELIVERY_EVENT_PROVIDER_UNCONFIRMED w logu, nic nie zapisane", async () => {
    const ctx = container({
      verify: async () => ({
        outcome: "unconfirmed",
        statistics_event: "hardBounces",
        error_code: DELIVERY_EVENT_PROVIDER_UNCONFIRMED_CODE,
      }),
    })
    await expect(
      brevoDeliveryTracker({ event, container: ctx.container } as never),
    ).rejects.toThrow(/DELIVERY_EVENT_PROVIDER_UNCONFIRMED/)
    expect(ctx.ledger.applyProviderDeliveryState).not.toHaveBeenCalled()
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("error_code=DELIVERY_EVENT_PROVIDER_UNCONFIRMED"),
    )
  })

  it("kontrola DODATNIA: potwierdzone zdarzenie trafia do ledgera", async () => {
    const ctx = container({
      verify: async () => ({ outcome: "confirmed", statistics_event: "hardBounces" }),
    })
    ctx.ledger.applyProviderDeliveryState.mockResolvedValue({
      outcome: "orphan",
      dispatch_id: null,
      previous_status: null,
      status: null,
    })
    await brevoDeliveryTracker({ event, container: ctx.container } as never)
    expect(ctx.ledger.applyProviderDeliveryState).toHaveBeenCalledTimes(1)
  })
})

describe("R-1/R-4/R-5 — tracker z PRAWDZIWYM weryfikatorem nad stubem HTTP", () => {
  const originalKey = process.env.BREVO_API_KEY
  const originalInstance = process.env.GP_INSTANCE_ID
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env.BREVO_API_KEY = API_KEY
    process.env.GP_INSTANCE_ID = "gp-test"
  })
  afterEach(() => {
    global.fetch = originalFetch
  })
  afterAll(() => {
    if (originalKey === undefined) delete process.env.BREVO_API_KEY
    else process.env.BREVO_API_KEY = originalKey
    if (originalInstance === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = originalInstance
  })

  /** Stub HTTP API Brevo: odpowiedz w ksztalcie getEmailEventReport. */
  function stubBrevoHttp(events: Array<Record<string, unknown>>, status = 200) {
    const calls: string[] = []
    global.fetch = jest.fn(async (url: unknown) => {
      calls.push(String(url))
      return {
        status,
        json: async () => ({ events }),
      }
    }) as unknown as typeof fetch
    return calls
  }

  function trackerContainer(ledgerOutcomes: string[], sinkFailures = 0) {
    const ledger = {
      applyProviderDeliveryState: jest.fn(async () => ({
        outcome: ledgerOutcomes.shift() ?? "duplicate",
        dispatch_id: "dispatch-http",
        previous_status: null,
        status: "failed",
      })),
    }
    const delivered: Array<Record<string, unknown>> = []
    let failuresLeft = sinkFailures
    const sink = {
      record: jest.fn(async (envelope: Record<string, unknown>) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1
          throw new Error("sink down")
        }
        delivered.push(envelope)
      }),
    }
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const db = {
      raw: jest.fn(async () => ({
        rows: [{ money_path_brakes: { fr_9_delivery_idempotency: "released" } }],
      })),
    }
    return {
      ledger,
      delivered,
      sink,
      logger,
      container: {
        resolve: (key: string) => {
          if (key === "logger") return logger
          if (key === "voucher_delivery_dispatch_ledger") return ledger
          if (key === "notification_delivery_audit_sink") return sink
          if (key === "__pg_connection__") return db
          if (key === "notification_dispatches") return { findByProviderMessageId: async () => null }
          throw new Error(`Unknown container key: ${key}`)
        },
      },
    }
  }

  const hardBounce = {
    name: "notification.hard_bounce",
    data: {
      provider_id: "brevo",
      provider_event_id: MESSAGE_ID,
      market_id: "bonbeauty",
      event_type: "hard_bounce",
    },
  }

  it("R-1: prawdziwy hard bounce (`hardBounces` w odpowiedzi) trafia do ledgera z domknieciem budzetu", async () => {
    const calls = stubBrevoHttp([{ messageId: MESSAGE_ID, event: "hardBounces" }])
    const ctx = trackerContainer(["updated"])
    await brevoDeliveryTracker({ event: hardBounce, container: ctx.container } as never)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]).searchParams.get("event")).toBe("hardBounces")
    expect(ctx.ledger.applyProviderDeliveryState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", exhaust_recipient_budget: { max_attempt_count: 5 } }),
    )
    expect(ctx.delivered).toHaveLength(1)
  })

  it("R-4: odpowiedz bez wiersza (opozniona statystyka) rzuca — szyna ponawia, a ponowienie z wierszem zapisuje", async () => {
    stubBrevoHttp([])
    const ctx = trackerContainer(["updated"])
    await expect(
      brevoDeliveryTracker({ event: hardBounce, container: ctx.container } as never),
    ).rejects.toThrow(/DELIVERY_EVENT_PROVIDER_UNCONFIRMED/)
    expect(ctx.ledger.applyProviderDeliveryState).not.toHaveBeenCalled()

    stubBrevoHttp([{ messageId: MESSAGE_ID, event: "hardBounces" }])
    await brevoDeliveryTracker({ event: hardBounce, container: ctx.container } as never)
    expect(ctx.ledger.applyProviderDeliveryState).toHaveBeenCalledTimes(1)
    expect(ctx.delivered).toHaveLength(1)
  })

  it("R-5: awaria sinka po zapisie ledgera — ponowienie (ledger `duplicate`) DOSTARCZA koperte z tym samym audit_id", async () => {
    stubBrevoHttp([{ messageId: MESSAGE_ID, event: "hardBounces" }])
    const ctx = trackerContainer(["updated", "duplicate"], 1)
    await expect(
      brevoDeliveryTracker({ event: hardBounce, container: ctx.container } as never),
    ).rejects.toThrow("sink down")
    await brevoDeliveryTracker({ event: hardBounce, container: ctx.container } as never)

    expect(ctx.ledger.applyProviderDeliveryState).toHaveBeenCalledTimes(2)
    expect(ctx.sink.record).toHaveBeenCalledTimes(2)
    expect(ctx.delivered).toHaveLength(1)
    expect(ctx.delivered[0]).toMatchObject({
      provider_event_id: MESSAGE_ID,
      delivery_reaction: expect.objectContaining({ escalate: true }),
    })
    const firstAttempt = ctx.sink.record.mock.calls[0][0] as { audit_id: string }
    expect(ctx.delivered[0].audit_id).toBe(firstAttempt.audit_id)
  })
})
