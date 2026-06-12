import { EventEmitter } from "node:events"

import {
  AUTHENTICATE,
  POST,
} from "../../../../api/hooks/notifications/brevo/route"
import { BREVO_PROVIDER_PLUGIN_PENDING_MESSAGE } from "../../../../api/hooks/notifications/brevo/helpers"

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

describe("POST /hooks/notifications/brevo (stub route, F-09)", () => {
  it("opts out of Medusa auth", () => {
    expect(AUTHENTICATE).toBe(false)
  })

  it("responds 202 with accepted-noop payload until provider plugin lands", async () => {
    const res = new FakeResponse()
    await POST({} as never, res as never)

    expect(res.statusCode).toBe(202)
    expect(res.payload).toEqual({
      type: "accepted_noop",
      message: BREVO_PROVIDER_PLUGIN_PENDING_MESSAGE,
    })
  })
})
