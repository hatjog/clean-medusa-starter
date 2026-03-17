import { describe, it, expect, beforeEach, vi } from "vitest"

import GpCoreService, { NotImplementedError } from "../service"
import {
  EntitlementStatus,
  type Entitlement,
  type EntitlementCreateDto,
  type Redemption,
  type RedemptionCreateDto,
  type EntitlementAuditEntry,
} from "../models"

// Mock pg module to avoid real DB connections
vi.mock("pg", () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] })
  const mockPool = vi.fn(() => ({
    query: mockQuery,
    connect: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  }))
  return { Pool: mockPool }
})

describe("Entitlement Domain Types", () => {
  it("EntitlementStatus enum has 7 values", () => {
    const values = Object.values(EntitlementStatus)
    expect(values).toHaveLength(7)
    expect(values).toContain("ISSUED")
    expect(values).toContain("ACTIVE")
    expect(values).toContain("PARTIALLY_REDEEMED")
    expect(values).toContain("REDEEMED")
    expect(values).toContain("VOIDED")
    expect(values).toContain("REFUNDED")
    expect(values).toContain("EXPIRED")
  })

  it("Entitlement type is structurally valid", () => {
    const entitlement: Entitlement = {
      id: "ent-1",
      market_id: "mkt-1",
      order_id: "ord-1",
      line_item_id: "li-1",
      product_id: "prod-1",
      vendor_id: "vnd-1",
      face_value_minor: 10000,
      remaining_minor: 10000,
      currency: "PLN",
      status: EntitlementStatus.ISSUED,
      claim_token: null,
      voucher_code: null,
      buyer_email: "test@example.com",
      buyer_is_recipient: false,
      customer_id: null,
      expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    expect(entitlement.status).toBe("ISSUED")
    expect(entitlement.face_value_minor).toBe(10000)
  })

  it("EntitlementCreateDto matches adapter contract", () => {
    const dto: EntitlementCreateDto = {
      order_id: "ord-1",
      line_item_id: "li-1",
      vendor_id: "vnd-1",
      market_id: "mkt-1",
      instance_id: "inst-1",
      product_id: "prod-1",
      face_value_minor: 5000,
      currency: "PLN",
      buyer_email: "buyer@example.com",
      buyer_is_recipient: true,
      customer_id: "cust-1",
      idempotency_key: "ord-1::li-1",
    }
    expect(dto.idempotency_key).toBe("ord-1::li-1")
  })

  it("Redemption type is structurally valid", () => {
    const redemption: Redemption = {
      id: "rdm-1",
      entitlement_id: "ent-1",
      amount_minor: 3000,
      vendor_id: "vnd-1",
      idempotency_key: "rdm-key-1",
      created_at: new Date(),
    }
    expect(redemption.amount_minor).toBe(3000)
  })

  it("RedemptionCreateDto type is structurally valid", () => {
    const dto: RedemptionCreateDto = {
      entitlement_id: "ent-1",
      amount_minor: 2000,
      vendor_id: "vnd-1",
      idempotency_key: "rdm-key-2",
    }
    expect(dto.entitlement_id).toBe("ent-1")
  })

  it("EntitlementAuditEntry type is structurally valid", () => {
    const entry: EntitlementAuditEntry = {
      id: "audit-1",
      entitlement_id: "ent-1",
      action: "CLAIM",
      actor: "customer:cust-1",
      details: { source: "claim-page" },
      created_at: new Date(),
    }
    expect(entry.action).toBe("CLAIM")
  })
})

describe("GpCoreService — Entitlement Stubs", () => {
  let service: GpCoreService

  beforeEach(() => {
    service = new GpCoreService({}, {})
  })

  it("NotImplementedError has correct name and message", () => {
    const error = new NotImplementedError("Story 1.3")
    expect(error.name).toBe("NotImplementedError")
    expect(error.message).toContain("Story 1.3")
  })

  it("createEntitlement throws NotImplementedError", async () => {
    const dto: EntitlementCreateDto = {
      order_id: "ord-1",
      line_item_id: "li-1",
      vendor_id: "vnd-1",
      market_id: "mkt-1",
      instance_id: "inst-1",
      product_id: "prod-1",
      face_value_minor: 5000,
      currency: "PLN",
      buyer_email: "test@example.com",
      buyer_is_recipient: false,
      customer_id: null,
      idempotency_key: "ord-1::li-1",
    }
    await expect(service.createEntitlement(dto)).rejects.toThrow(NotImplementedError)
  })

  it("claimVoucher throws NotImplementedError", async () => {
    await expect(service.claimVoucher("token", "cust-1")).rejects.toThrow(NotImplementedError)
  })

  it("verifyVoucher throws NotImplementedError", async () => {
    await expect(service.verifyVoucher("VOUCHER-CODE")).rejects.toThrow(NotImplementedError)
  })

  it("redeemVoucher throws NotImplementedError", async () => {
    const dto: RedemptionCreateDto = {
      entitlement_id: "ent-1",
      amount_minor: 1000,
      vendor_id: "vnd-1",
      idempotency_key: "key-1",
    }
    await expect(service.redeemVoucher(dto)).rejects.toThrow(NotImplementedError)
  })

  it("resolveVendorId throws NotImplementedError", async () => {
    await expect(service.resolveVendorId("seller-123")).rejects.toThrow(NotImplementedError)
  })

  it("searchVouchers throws NotImplementedError", async () => {
    await expect(service.searchVouchers({ market_id: "mkt-1" })).rejects.toThrow(NotImplementedError)
  })

  it("voidEntitlement throws NotImplementedError", async () => {
    await expect(service.voidEntitlement("ent-1", "fraud")).rejects.toThrow(NotImplementedError)
  })

  it("refundEntitlement throws NotImplementedError", async () => {
    await expect(service.refundEntitlement("ent-1", "customer request")).rejects.toThrow(NotImplementedError)
  })

  it("healthCheck returns status for both pools", async () => {
    const result = await service.healthCheck()
    expect(result).toHaveProperty("core")
    expect(result).toHaveProperty("mercur")
    expect(typeof result.core).toBe("boolean")
    expect(typeof result.mercur).toBe("boolean")
  })
})
