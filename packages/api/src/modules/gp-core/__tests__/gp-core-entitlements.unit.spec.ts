import { describe, it, expect, beforeEach, jest } from "@jest/globals"

import GpCoreService, { NotImplementedError, VendorNotMappedError } from "../service"
import {
  EntitlementStatus,
  type Entitlement,
  type EntitlementCreateDto,
  type Redemption,
  type RedemptionCreateDto,
  type EntitlementAuditEntry,
} from "../models"

// Mock pg module to avoid real DB connections
jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockQuery = (jest.fn() as any).mockResolvedValue({ rows: [{ "?column?": 1 }] })
  const mockPool = jest.fn(() => ({
    query: mockQuery,
    connect: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    end: (jest.fn() as any).mockResolvedValue(undefined),
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

  // v1.15.0 Story 5.8 (AC1): przypadek NIE ZNIKA — zostaje PRZEPISANY na nowy
  // kontrakt. Usunięcie go po cichu zabrałoby jedyny ślad, że ta metoda kiedyś
  // rzucała `NotImplementedError`, a `lib/vendor-auth.ts` zamieniał to na `501`
  // na KAŻDYM uwierzytelnionym żądaniu `/vendor/*`.
  it("resolveVendorId zwraca vendor_id z gp_core.vendor_seller_mappings", async () => {
    const query = jest.fn() as jest.MockedFunction<
      (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
    >
    query.mockResolvedValue({ rows: [{ vendor_id: "vnd-42" }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(service as any).corePool_ = { query }

    await expect(service.resolveVendorId("sel_01ABC")).resolves.toBe("vnd-42")

    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("gp_core.vendor_seller_mappings")
    // Zakres `instance_id` jest CZĘŚCIĄ klucza unikalności
    // `(instance_id, mercur_seller_id)`, a nie ozdobnikiem: bez niego ten sam
    // `seller_id` z innej instancji rozwiązałby się na cudzego vendora.
    expect(sql).toContain("instance_id")
    expect(params).toEqual(["gp-dev", "sel_01ABC"])
  })

  it("resolveVendorId: brak mapowania to ODMOWA, nie NotImplementedError", async () => {
    const query = jest.fn() as jest.MockedFunction<
      (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
    >
    query.mockResolvedValue({ rows: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(service as any).corePool_ = { query }

    await expect(service.resolveVendorId("sel_NIEZNANY")).rejects.toBeInstanceOf(
      VendorNotMappedError
    )
    // `501` znaczyłoby „serwer tego nie umie". Serwer umie — to tożsamość
    // nie istnieje, a to jest stan AUTORYZACYJNY.
    await expect(service.resolveVendorId("sel_NIEZNANY")).rejects.not.toBeInstanceOf(
      NotImplementedError
    )
  })

  it("resolveVendorId nie zgaduje identyfikatora dla pustego seller_id", async () => {
    const query = jest.fn() as jest.MockedFunction<
      (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
    >
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(service as any).corePool_ = { query }

    await expect(service.resolveVendorId("   ")).rejects.toBeInstanceOf(
      VendorNotMappedError
    )
    // Fallback na wartość współdzieloną zniknął w Story 5.4 i nie wraca:
    // pusta tożsamość nie może w ogóle dotknąć bazy.
    expect(query).not.toHaveBeenCalled()
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
    const healthyPool = {
      query: jest.fn(() => Promise.resolve({ rows: [{ "?column?": 1 }] })),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(service as any).corePool_ = healthyPool
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(service as any).mercurPool_ = healthyPool

    const result = await service.healthCheck()
    expect(result).toHaveProperty("core")
    expect(result).toHaveProperty("mercur")
    expect(typeof result.core).toBe("boolean")
    expect(typeof result.mercur).toBe("boolean")
  })

})
