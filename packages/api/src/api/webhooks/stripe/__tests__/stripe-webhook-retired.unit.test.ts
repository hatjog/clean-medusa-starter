import { POST } from "../route"
import { STRIPE_WEBHOOK_RETIRED_MESSAGE } from "../helpers"

describe("retired Stripe webhook route", () => {
  it("returns 410 without signature verification or mutation", async () => {
    const status = jest.fn().mockReturnThis()
    const json = jest.fn()

    await POST({} as never, { status, json } as never)

    expect(status).toHaveBeenCalledWith(410)
    expect(json).toHaveBeenCalledWith({
      type: "gone",
      message: STRIPE_WEBHOOK_RETIRED_MESSAGE,
    })
  })
})
