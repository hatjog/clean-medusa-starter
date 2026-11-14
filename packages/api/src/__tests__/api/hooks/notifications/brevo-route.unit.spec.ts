import { EventEmitter } from "node:events"

import { AUTHENTICATE, POST } from "../../../../api/hooks/notifications/brevo/route"
import * as tokenRoute from "../../../../api/hooks/notifications/brevo/[token]/route"
import {
  BREVO_WEBHOOK_INGRESS_METRIC,
  BREVO_WEBHOOK_UNRECOGNIZED_EVENT_CODE,
} from "../../../../api/hooks/notifications/brevo/helpers"

class FakeResponse extends EventEmitter {
  statusCode = 200
  payload: unknown

  status(code: number): this {
    this.statusCode = code
    return this
  }

  json(payload: unknown): this {
    this.payload = payload
    return this
  }
}

function request(body: Record<string, unknown>, eventBus: { emit: jest.Mock }, logger: { error: jest.Mock }) {
  return {
    body,
    scope: {
      resolve: (key: string) => {
        if (key === "event_bus") return eventBus
        if (key === "logger") return logger
        throw new Error(`unknown dependency: ${key}`)
      },
    },
  }
}

describe("POST /hooks/notifications/brevo", () => {
  it("opts out of Medusa auth", () => {
    expect(AUTHENTICATE).toBe(false)
  })

  it("emits the exact notification event consumed by the subscriber", async () => {
    const eventBus = { emit: jest.fn(async () => undefined) }
    const logger = { error: jest.fn() }
    const res = new FakeResponse()

    await POST(
      request(
        {
          event: "hard_bounce",
          "message-id": "brevo-message-1",
          email: "buyer@example.test",
          date: "2026-08-12T12:00:00.000Z",
        },
        eventBus,
        logger,
      ) as never,
      res as never,
    )

    expect(eventBus.emit).toHaveBeenCalledWith({
      name: "notification.hard_bounce",
      data: expect.objectContaining({
        provider_id: "brevo",
        provider_event_id: "brevo-message-1",
        event_type: "hard_bounce",
      }),
    })
    expect(res.statusCode).toBe(202)
    expect(res.payload).toEqual(
      expect.objectContaining({ type: "emitted", event_name: "notification.hard_bounce" }),
    )
  })

  it("odmawia głośno na typ spoza dziedziny", async () => {
    const eventBus = { emit: jest.fn(async () => undefined) }
    const logger = { error: jest.fn() }
    const res = new FakeResponse()

    await POST(
      request(
        { event: "not_a_brevo_event", "message-id": "brevo-message-2" },
        eventBus,
        logger,
      ) as never,
      res as never,
    )

    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(422)
    expect(res.payload).toMatchObject({
      error_code: BREVO_WEBHOOK_UNRECOGNIZED_EVENT_CODE,
      metric: BREVO_WEBHOOK_INGRESS_METRIC,
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(BREVO_WEBHOOK_UNRECOGNIZED_EVENT_CODE),
    )
  })
})

describe("Story 6.6 — POST /hooks/notifications/brevo/:token (ADR-213 wariant A)", () => {
  it("trasa z tokenem w sciezce uzywa TEGO SAMEGO handlera i rowniez wylacza auth Medusy", () => {
    expect(tokenRoute.POST).toBe(POST)
    expect(tokenRoute.AUTHENTICATE).toBe(false)
  })

  it("realistyczna koperta Brevo (hard_bounce, message-id w <>) jest emitowana z provider_id i event_type", async () => {
    const eventBus = { emit: jest.fn(async () => undefined) }
    const logger = { error: jest.fn() }
    const res = new FakeResponse()
    const messageId = "<202611140800.12345678901@smtp-relay.mailin.fr>"

    await POST(
      request(
        {
          event: "hard_bounce",
          email: "example@domain.com",
          id: 123456,
          date: "2026-11-14 08:00:00",
          ts: 1794643200,
          "message-id": messageId,
          ts_event: 1794643205,
          subject: "Twoj voucher",
          tags: ["voucher_purchase_confirmation"],
          reason: "550 5.1.1 user unknown",
        },
        eventBus,
        logger,
      ) as never,
      res as never,
    )

    expect(res.statusCode).toBe(202)
    expect(eventBus.emit).toHaveBeenCalledWith({
      name: "notification.hard_bounce",
      data: expect.objectContaining({
        provider_id: "brevo",
        provider_event_id: messageId,
        event_type: "hard_bounce",
      }),
    })
  })
})
