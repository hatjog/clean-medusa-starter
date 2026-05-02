import { describe, expect, it } from "@jest/globals"

import {
  StubVoucherTemplateResolver,
  StubVoucherTemplateValidator,
  type IVoucherTemplateResolver,
  type IVoucherTemplateValidator,
} from "../voucher-template/ports"
import {
  StubVoucherDeliveryAuditTrail,
  StubVoucherDispatcher,
  type IVoucherDeliveryAuditTrail,
  type IVoucherDispatcher,
} from "../voucher-delivery/ports"

describe("Voucher BC ports — import + stub-throws contract (D-52, D-53)", () => {
  it("voucher-template stubs throw not-implemented v1.4.0", async () => {
    const resolver: IVoucherTemplateResolver = new StubVoucherTemplateResolver()
    const validator: IVoucherTemplateValidator = new StubVoucherTemplateValidator()

    await expect(
      resolver.resolveEffectiveTemplate({
        market_id: "bonbeauty",
        type: "PDF",
        locale: "pl",
      })
    ).rejects.toThrow(/not implemented v1\.4\.0/)

    await expect(
      validator.validateTemplate({
        market_id: "bonbeauty",
        type: "PDF",
      })
    ).rejects.toThrow(/not implemented v1\.4\.0/)
  })

  it("voucher-delivery stubs throw not-implemented v1.4.0", async () => {
    const dispatcher: IVoucherDispatcher = new StubVoucherDispatcher()
    const audit: IVoucherDeliveryAuditTrail = new StubVoucherDeliveryAuditTrail()

    await expect(
      dispatcher.dispatch({
        voucher_id: "v1",
        personalization_id: "p1",
        channel: "PDF",
        recipient_contact: "buyer@example.com",
        locale: "pl",
      })
    ).rejects.toThrow(/not implemented v1\.4\.0/)

    await expect(
      audit.recordAttempt({
        id: "a1",
        voucher_id: "v1",
        channel: "PDF",
        status: "QUEUED",
        scheduled_at: "2026-04-26T00:00:00Z",
        attempts_count: 0,
      })
    ).rejects.toThrow(/not implemented v1\.4\.0/)

    await expect(audit.listAttempts("v1")).rejects.toThrow(/not implemented v1\.4\.0/)
  })
})
