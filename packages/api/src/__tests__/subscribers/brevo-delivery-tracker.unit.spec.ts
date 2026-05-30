import { createHash } from "node:crypto"

import brevoDeliveryTracker, {
  __resetBrevoDeliveryTrackerForTests,
  BREVO_NOTIFICATION_EVENTS,
  config,
} from "../../subscribers/brevo-delivery-tracker"

type AuditEvent = Record<string, unknown>

function makeContainer(options: {
  auditEvents?: AuditEvent[]
  dispatch?: Record<string, unknown> | null
} = {}) {
  const auditEvents = options.auditEvents ?? []
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  const dispatches = {
    findByProviderMessageId: jest.fn(async () => options.dispatch ?? null),
  }
  const sink = {
    record: jest.fn(async (auditEvent: AuditEvent) => {
      auditEvents.push(auditEvent)
    }),
  }
  const resolve = jest.fn((key: string) => {
    if (key === "logger") return logger
    if (key === "notification_dispatches") return dispatches
    if (key === "notification_delivery_audit_sink") return sink
    throw new Error(`Unknown container key: ${key}`)
  })

  return {
    auditEvents,
    dispatches,
    logger,
    resolve,
    sink,
    container: { resolve },
  }
}

async function handleDelivery(
  data: Record<string, unknown>,
  container: unknown,
  eventName = "notification.delivered",
) {
  await brevoDeliveryTracker({
    event: {
      name: eventName,
      data,
    },
    container,
  } as never)
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex")
}

describe("brevoDeliveryTracker", () => {
  beforeEach(() => {
    __resetBrevoDeliveryTrackerForTests()
  })

  it("subskrybuje natywne eventy notification.* bez custom route", () => {
    expect(config.event).toEqual([...BREVO_NOTIFICATION_EVENTS])
    expect(BREVO_NOTIFICATION_EVENTS).toEqual([
      "notification.delivered",
      "notification.opened",
      "notification.clicked",
      "notification.bounced",
      "notification.complaint",
      "notification.unsubscribed",
    ])
  })

  it("notification.delivered generuje audit envelope z matched correlation", async () => {
    const ctx = makeContainer()

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "brevo-message-1",
        dispatch_id: "dispatch-1",
        event_type: "delivered",
        occurred_at: "2026-05-27T08:00:00.000Z",
        recipient_hash: "recipient-hash-1",
        flow_id: "voucher_delivery",
        market_id: "pl",
      },
      ctx.container,
    )

    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0]).toMatchObject({
      event_type: "notification.delivery",
      provider: "brevo",
      provider_event_id: "brevo-message-1",
      dispatch_id: "dispatch-1",
      correlation_id: "dispatch-1",
      correlation_state: "matched",
      outcome: "delivered",
      recipient_hash: "recipient-hash-1",
      flow_id: "voucher_delivery",
      market_id: "pl",
    })
  })

  it("notification.bounced hard bounce mapuje outcome failed i HARD_BOUNCE", async () => {
    const ctx = makeContainer()

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "brevo-message-2",
        dispatch_id: "dispatch-2",
        event_type: "bounced",
        bounce_type: "hard",
        occurred_at: "2026-05-27T08:01:00.000Z",
        recipient_hash: "recipient-hash-2",
      },
      ctx.container,
      "notification.bounced",
    )

    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0]).toMatchObject({
      provider_event_id: "brevo-message-2",
      outcome: "failed",
      error_code: "HARD_BOUNCE",
      correlation_state: "matched",
    })
  })

  it("notification.complaint mapuje outcome flagged i SPAM_COMPLAINT", async () => {
    const ctx = makeContainer()

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "brevo-message-3",
        dispatch_id: "dispatch-3",
        event_type: "complaint",
        occurred_at: "2026-05-27T08:02:00.000Z",
        recipient_hash: "recipient-hash-3",
      },
      ctx.container,
      "notification.complaint",
    )

    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0]).toMatchObject({
      provider_event_id: "brevo-message-3",
      outcome: "flagged",
      error_code: "SPAM_COMPLAINT",
    })
  })

  it("koreluje provider_event_id przez notification_dispatches lookup", async () => {
    const ctx = makeContainer({
      dispatch: {
        dispatch_id: "dispatch-from-table",
        flow_id: "flow-from-table",
        market_id: "market-from-table",
        template_key: "template-from-table",
        locale: "en-US",
        consent_basis: "transactional_critical",
        idempotency_key: "idem-from-table",
      },
    })

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "provider-message-correlated",
        event_type: "opened",
        occurred_at: "2026-05-27T08:02:30.000Z",
        recipient_hash: "recipient-hash-correlated",
      },
      ctx.container,
      "notification.opened",
    )

    expect(ctx.dispatches.findByProviderMessageId).toHaveBeenCalledWith(
      "provider-message-correlated",
    )
    expect(ctx.auditEvents[0]).toMatchObject({
      dispatch_id: "dispatch-from-table",
      correlation_id: "dispatch-from-table",
      correlation_state: "matched",
      flow_id: "flow-from-table",
      market_id: "market-from-table",
      template_key: "template-from-table",
      locale: "en-US",
      consent_basis: "transactional_critical",
      idempotency_key: "idem-from-table",
    })
  })

  it("orphan event generuje audit envelope bez wyjątku", async () => {
    const ctx = makeContainer({ dispatch: null })

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "orphan-message",
        event_type: "opened",
        occurred_at: "2026-05-27T08:03:00.000Z",
        recipient_hash: "recipient-hash-4",
      },
      ctx.container,
      "notification.opened",
    )

    expect(ctx.dispatches.findByProviderMessageId).toHaveBeenCalledWith("orphan-message")
    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0]).toMatchObject({
      provider_event_id: "orphan-message",
      correlation_id: "orphan-message",
      correlation_state: "orphan",
      outcome: "opened",
    })
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("orphan delivery event"),
    )
  })

  it("deduplikuje powtórzony provider_event_id bez drugiego audit entry", async () => {
    const ctx = makeContainer()
    const payload = {
      provider_id: "brevo",
      provider_event_id: "duplicate-message",
      dispatch_id: "dispatch-duplicate",
      event_type: "delivered",
      occurred_at: "2026-05-27T08:04:00.000Z",
      recipient_hash: "recipient-hash-5",
    }

    await handleDelivery(payload, ctx.container)
    await handleDelivery(payload, ctx.container)

    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("duplicate delivery event skipped"),
    )
  })

  it("haszuje raw email i nie przenosi go do audit envelope", async () => {
    const ctx = makeContainer()
    const rawEmail = "Buyer@Example.COM"

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "brevo-message-pii",
        dispatch_id: "dispatch-pii",
        event_type: "clicked",
        occurred_at: "2026-05-27T08:05:00.000Z",
        recipient_email: rawEmail,
        raw_provider_payload: {
          email: rawEmail,
          subject: "Voucher code",
        },
      },
      ctx.container,
      "notification.clicked",
    )

    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0]).toMatchObject({
      outcome: "engaged",
      recipient_hash: hashEmail(rawEmail),
      hashed_recipient: hashEmail(rawEmail),
    })
    expect(JSON.stringify(ctx.auditEvents[0])).not.toContain(rawEmail)
    expect(JSON.stringify(ctx.auditEvents[0])).not.toContain("Voucher code")
  })

  it("obsługuje Brevo soft_bounce legacy fields i append sink", async () => {
    const auditEvents: AuditEvent[] = []
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const append = jest.fn(async (auditEvent: AuditEvent) => {
      auditEvents.push(auditEvent)
    })
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "notification_delivery_audit_sink") return { append }
      throw new Error(`Unknown container key: ${key}`)
    })

    await handleDelivery(
      {
        provider_id: "brevo",
        "message-id": "legacy-soft-bounce",
        event: "soft_bounce",
        date: "2026-05-27T08:06:00.000Z",
        email: "bounce@example.com",
      },
      { resolve },
      "notification.bounced",
    )

    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({
      provider_event_id: "legacy-soft-bounce",
      outcome: "failed",
      error_code: "SOFT_BOUNCE",
      occurred_at: "2026-05-27T08:06:00.000Z",
      recipient_hash: hashEmail("bounce@example.com"),
    })
  })

  it("obsługuje failed event z funkcyjnym audit sinkiem", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const sink = jest.fn()
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "notification_delivery_audit_sink") return sink
      throw new Error(`Unknown container key: ${key}`)
    })

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "failed-message",
        dispatch_id: "dispatch-failed",
        event_type: "failed",
        error_code: "BREVO_TIMEOUT",
        error_message: "timeout",
        ts: 1780000000,
      },
      { resolve },
      "notification.failed",
    )

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_event_id: "failed-message",
        outcome: "failed",
        status: "failed",
        error_code: "BREVO_TIMEOUT",
        error_message: "timeout",
      }),
    )
  })

  it("loguje audit fallback, gdy sink nie jest zarejestrowany", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "unsubscribe-message",
        event_type: "unsubscribed",
        ts: "1780000000000",
      },
      { logger } as never,
      "notification.unsubscribed",
    )

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("\"outcome\":\"opted_out\""),
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("\"recipient_hash\":\"__no_recipient__\""),
    )
  })

  it("propaguje błąd audit sinka, żeby Medusa mogła wykonać retry", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "notification_delivery_audit_sink") {
        return {
          write: jest.fn(async () => {
            throw new Error("sink down")
          }),
        }
      }
      throw new Error(`Unknown container key: ${key}`)
    })

    await expect(
      handleDelivery(
        {
          provider_id: "brevo",
          provider_event_id: "sink-failure-message",
          dispatch_id: "dispatch-sink-failure",
          event_type: "delivered",
        },
        { resolve },
      ),
    ).rejects.toThrow("sink down")
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("audit sink failed"))
  })

  it("zrzuca malformed event bez audit entry", async () => {
    const ctx = makeContainer()

    await handleDelivery(
      {
        provider_id: "brevo",
        event_type: "unknown",
      },
      ctx.container,
    )

    expect(ctx.auditEvents).toHaveLength(0)
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "[brevo-delivery-tracker] dropped malformed delivery event",
    )
  })

  it("deduplikuje concurrent handle() calls przez mark-before-emit ordering (F-03 race)", async () => {
    const ctx = makeContainer()
    const payload = {
      provider_id: "brevo",
      provider_event_id: "race-message",
      dispatch_id: "dispatch-race",
      event_type: "delivered",
      occurred_at: "2026-05-27T08:10:00.000Z",
      recipient_hash: "recipient-hash-race",
    }

    await Promise.all([
      handleDelivery(payload, ctx.container),
      handleDelivery(payload, ctx.container),
    ])

    expect(ctx.auditEvents).toHaveLength(1)
  })

  it("przywraca dedupe entry gdy sink rzuca — Medusa retry przejdzie jak fresh (F-07 rollback)", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    let attempt = 0
    const sink = {
      record: jest.fn(async (auditEvent: AuditEvent) => {
        attempt += 1
        if (attempt === 1) {
          throw new Error("sink down")
        }
        attempts.push(auditEvent)
      }),
    }
    const attempts: AuditEvent[] = []
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "notification_delivery_audit_sink") return sink
      throw new Error(`Unknown container key: ${key}`)
    })

    const payload = {
      provider_id: "brevo",
      provider_event_id: "retry-message",
      dispatch_id: "dispatch-retry",
      event_type: "delivered",
    }

    await expect(handleDelivery(payload, { resolve })).rejects.toThrow("sink down")
    await handleDelivery(payload, { resolve })

    expect(attempts).toHaveLength(1)
    expect(sink.record).toHaveBeenCalledTimes(2)
  })

  it("audit_id jest deterministyczny per (provider_event_id, event_type) — F-08", async () => {
    const ctx1 = makeContainer()
    const ctx2 = makeContainer()
    const payload = {
      provider_id: "brevo",
      provider_event_id: "deterministic-id-message",
      dispatch_id: "dispatch-det",
      event_type: "delivered",
      occurred_at: "2026-05-27T08:11:00.000Z",
      recipient_hash: "recipient-hash-det",
    }

    await handleDelivery(payload, ctx1.container)
    __resetBrevoDeliveryTrackerForTests()
    await handleDelivery(payload, ctx2.container)

    expect(ctx1.auditEvents[0].audit_id).toBe(ctx2.auditEvents[0].audit_id)
    expect(ctx1.auditEvents[0].audit_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it("DB outage propaguje DISPATCH_LOOKUP_FAILED w audit envelope — F-06", async () => {
    const auditEvents: AuditEvent[] = []
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "__pg_connection__") {
        return {
          raw: jest.fn(async () => {
            const err = new Error("connection refused") as Error & { code?: string }
            err.code = "ECONNREFUSED"
            throw err
          }),
        }
      }
      if (key === "notification_delivery_audit_sink") {
        return {
          record: jest.fn(async (auditEvent: AuditEvent) => {
            auditEvents.push(auditEvent)
          }),
        }
      }
      throw new Error(`Unknown container key: ${key}`)
    })

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "db-outage-message",
        event_type: "clicked",
      },
      { resolve },
      "notification.clicked",
    )

    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({
      provider_event_id: "db-outage-message",
      correlation_state: "orphan",
      error_code: "DISPATCH_LOOKUP_FAILED",
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("notification_dispatches lookup failed"),
    )
  })

  it("missing relation (42P01) traktowane jako clean orphan bez error_code — F-06", async () => {
    const auditEvents: AuditEvent[] = []
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "__pg_connection__") {
        return {
          raw: jest.fn(async () => {
            const err = new Error('relation "notification_dispatches" does not exist') as Error & { code?: string }
            err.code = "42P01"
            throw err
          }),
        }
      }
      if (key === "notification_delivery_audit_sink") {
        return {
          record: jest.fn(async (auditEvent: AuditEvent) => {
            auditEvents.push(auditEvent)
          }),
        }
      }
      throw new Error(`Unknown container key: ${key}`)
    })

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "missing-relation-message",
        event_type: "clicked",
      },
      { resolve },
      "notification.clicked",
    )

    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({
      provider_event_id: "missing-relation-message",
      correlation_state: "orphan",
    })
    expect(auditEvents[0].error_code).toBeUndefined()
  })

  it("nie blokuje eventu, gdy lookup SQL jest niedostępny", async () => {
    const auditEvents: AuditEvent[] = []
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "__pg_connection__") {
        return {
          raw: jest.fn(async () => {
            const err = new Error('relation "notification_dispatches" does not exist') as Error & { code?: string }
            err.code = "42P01"
            throw err
          }),
        }
      }
      if (key === "notificationDeliveryAuditSink") {
        return {
          record: jest.fn(async (auditEvent: AuditEvent) => {
            auditEvents.push(auditEvent)
          }),
        }
      }
      throw new Error(`Unknown container key: ${key}`)
    })

    await handleDelivery(
      {
        provider_id: "brevo",
        provider_event_id: "pg-orphan-message",
        event_type: "clicked",
      },
      { resolve },
      "notification.clicked",
    )

    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({
      provider_event_id: "pg-orphan-message",
      correlation_state: "orphan",
      outcome: "engaged",
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("notification_dispatches lookup unavailable"),
    )
  })
})
