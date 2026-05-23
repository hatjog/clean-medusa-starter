import { describe, it, expect, beforeEach, jest } from "@jest/globals"

import GpCoreService, { NotImplementedError, type Queryable } from "../service"
import {
  EntitlementStatus,
  type Entitlement,
  type EntitlementCreateDto,
  type Redemption,
  type RedemptionCreateDto,
  type EntitlementAuditEntry,
} from "../models"

// Unit tests inject Queryable clients directly via
// `service.createEntitlement(dto, { coreClient, mercurClient })`. This avoids
// the brittle `jest.mock("pg")` path — `@swc/jest` does not hoist
// `jest.mock(...)` factories, so previously the mock factory ran AFTER the
// `import "pg"` resolution and the real Pool was used instead. Direct
// dependency injection via the service's documented `options` parameter is
// the contract-aligned alternative.
//
// `buildFakeClient(responder)` returns a Queryable-shaped object whose
// `query(sql, params)` dispatches to a per-test responder. Tests inspect
// `responder.mock.calls` to assert SQL contents + parameter shapes.

type FakeResponse = { rows: Array<Record<string, unknown>>; rowCount?: number }

type FakeQueryable = {
  query: jest.Mock<(sql: string, params?: unknown[]) => Promise<FakeResponse>>
}

function buildFakeClient(
  responder: (sql: string, params: unknown[]) => FakeResponse
): FakeQueryable {
  const query = jest.fn(async (sql: string, params: unknown[] = []) =>
    responder(sql, params)
  ) as unknown as jest.Mock<
    (sql: string, params?: unknown[]) => Promise<FakeResponse>
  >
  return { query }
}

// FakeQueryable structurally matches the `Queryable` injection point that
// service.createEntitlement accepts (`Pick<Pool|PoolClient, "query">`), but
// the jest.Mock overload signature does not satisfy pg's full Query overload
// surface under strict TS. Use this helper at call sites to bridge the gap
// without weakening service.ts typing.
const asQueryable = <T>(c: FakeQueryable): T => c as unknown as T

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

  it("createEntitlement creates ACTIVE entitlement with audit envelope (Story 1.10)", async () => {
    const dto: EntitlementCreateDto = {
      order_id: "ord-1",
      line_item_id: "li-1",
      vendor_id: "vnd-1",
      market_id: "00000000-0000-5000-8000-000000000001",
      instance_id: "inst-1",
      product_id: "prod-1",
      face_value_minor: 5000,
      currency: "PLN",
      buyer_email: "test@example.com",
      buyer_is_recipient: false,
      customer_id: null,
      idempotency_key: "ord-1::li-1",
    }

    const coreClient = buildFakeClient((sql, params) => {
      if (sql.includes("INSERT INTO gp_core.entitlements")) {
        return {
          rows: [
            {
              entitlement_id: "ent-aaa",
              market_id: dto.market_id as string,
              order_id: dto.order_id,
              line_item_id: dto.line_item_id as string,
              product_id: dto.product_id,
              vendor_id: dto.vendor_id as string,
              face_value_minor: dto.face_value_minor as number,
              remaining_minor: dto.face_value_minor as number,
              currency: "PLN",
              status: "ACTIVE",
              claim_token: "claim-xyz",
              voucher_code_normalized: null,
              buyer_email: dto.buyer_email,
              buyer_is_recipient: dto.buyer_is_recipient,
              customer_id: dto.customer_id,
              expires_at: null,
              created_at: new Date("2026-05-23T00:00:00Z"),
              updated_at: new Date("2026-05-23T00:00:00Z"),
              was_insert: true,
            },
          ],
        }
      }
      if (sql.includes("INSERT INTO gp_core.entitlement_audit_log")) {
        return { rows: [] }
      }
      return { rows: [] }
    })

    // Mercur lookup MUST be called only when the dto omits the relevant fields;
    // here the dto is fully populated so deriveEntitlementFieldsFromOrder still
    // runs but should not crash if the mercur responder returns empty.
    const mercurClient = buildFakeClient(() => ({ rows: [] }))

    const result = await service.createEntitlement(dto, {
      coreClient: coreClient as unknown as Queryable,
      mercurClient: mercurClient as unknown as Queryable,
    })
    expect(result.status).toBe(EntitlementStatus.ACTIVE)
    expect(result.id).toBe("ent-aaa")
    expect(result.order_id).toBe(dto.order_id)
    expect(result.face_value_minor).toBe(5000)
    expect(result.remaining_minor).toBe(5000)

    const auditCalls = coreClient.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO gp_core.entitlement_audit_log")
    )
    expect(auditCalls).toHaveLength(1)
    const auditParams = auditCalls[0][1] as unknown[]
    expect(auditParams[1]).toBe("ISSUED") // action
    expect(auditParams[2]).toBe("system") // actor_type
    expect(auditParams[3]).toBe("order_placed_subscriber") // actor_id
    expect(auditParams[5]).toBe("ACTIVE") // new_status
    const metadata = JSON.parse(auditParams[6] as string)
    expect(metadata.source).toBe("order_placed_subscriber")
    expect(metadata.idempotency_key).toBe("ord-1::li-1")
  })

  it("createEntitlement derives missing fields from Mercur order lookup (subscriber payload)", async () => {
    const subscriberDto: EntitlementCreateDto = {
      order_id: "order_derived",
      recipient_locale: "pl-PL",
      message_locale: "pl-PL",
      is_gift: true,
      voucher_kind: "MPV",
    }

    const coreClient = buildFakeClient((sql, params) => {
      if (sql.includes("FROM gp_core.markets") && sql.includes("sales_channel_id = $1")) {
        return {
          rows: [
            {
              id: "00000000-0000-5000-8000-000000000002",
              instance_id: "gp-dev",
            },
          ],
        }
      }
      if (sql.includes("INSERT INTO gp_core.entitlements")) {
        return {
          rows: [
            {
              entitlement_id: "ent-derived",
              market_id: params[1],
              order_id: subscriberDto.order_id,
              line_item_id: params[4],
              product_id: params[5],
              vendor_id: params[2],
              face_value_minor: params[6],
              remaining_minor: params[7],
              currency: params[8],
              status: "ACTIVE",
              claim_token: null,
              voucher_code_normalized: null,
              buyer_email: params[10],
              buyer_is_recipient: params[11],
              customer_id: params[12],
              expires_at: null,
              created_at: new Date(),
              updated_at: new Date(),
              was_insert: true,
            },
          ],
        }
      }
      if (sql.includes("INSERT INTO gp_core.entitlement_audit_log")) {
        return { rows: [] }
      }
      return { rows: [] }
    })

    const mercurClient = buildFakeClient((sql) => {
      if (sql.includes('FROM "order"')) {
        return {
          rows: [
            {
              sales_channel_id: "sc_test",
              currency_code: "pln",
              email: "buyer@example.com",
              customer_id: "cust_1",
            },
          ],
        }
      }
      if (sql.includes("FROM order_item")) {
        return {
          rows: [
            {
              line_item_id: "li_derived",
              product_id: "prod_derived",
              unit_price: "18000",
              quantity: "1",
              seller_id: "seller_derived",
            },
          ],
        }
      }
      return { rows: [] }
    })

    const result = await service.createEntitlement(subscriberDto, {
      coreClient: coreClient as unknown as Queryable,
      mercurClient: mercurClient as unknown as Queryable,
    })
    expect(result.id).toBe("ent-derived")
    expect(result.line_item_id).toBe("li_derived")
    expect(result.vendor_id).toBe("seller_derived")
    expect(result.currency).toBe("PLN")
    expect(result.face_value_minor).toBe(18000)

    const upsertCalls = coreClient.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO gp_core.entitlements")
    )
    expect(upsertCalls).toHaveLength(1)
    const upsertParams = upsertCalls[0][1] as unknown[]
    expect(upsertParams[1]).toBe("00000000-0000-5000-8000-000000000002")
  })

  it("createEntitlement is idempotent on ON CONFLICT (logs RE_ISSUED audit action)", async () => {
    const dto: EntitlementCreateDto = {
      order_id: "ord-dup",
      line_item_id: "li-dup",
      vendor_id: "vnd-1",
      market_id: "00000000-0000-5000-8000-000000000003",
      instance_id: "gp-dev",
      product_id: "prod-1",
      face_value_minor: 10000,
      currency: "PLN",
      buyer_email: "dup@example.com",
      buyer_is_recipient: false,
      customer_id: null,
    }

    let auditAction: string | null = null
    const coreClient = buildFakeClient((sql, params) => {
      if (sql.includes("INSERT INTO gp_core.entitlements")) {
        return {
          rows: [
            {
              entitlement_id: "ent-existing",
              market_id: dto.market_id as string,
              order_id: dto.order_id,
              line_item_id: dto.line_item_id as string,
              product_id: dto.product_id,
              vendor_id: dto.vendor_id as string,
              face_value_minor: dto.face_value_minor as number,
              remaining_minor: dto.face_value_minor as number,
              currency: "PLN",
              status: "ACTIVE",
              claim_token: null,
              voucher_code_normalized: "VOUCHER-X",
              buyer_email: dto.buyer_email,
              buyer_is_recipient: false,
              customer_id: null,
              expires_at: null,
              created_at: new Date("2026-05-22T10:00:00Z"),
              updated_at: new Date("2026-05-23T10:00:00Z"),
              was_insert: false, // ON CONFLICT branch
            },
          ],
        }
      }
      if (sql.includes("INSERT INTO gp_core.entitlement_audit_log")) {
        auditAction = params[1] as string
        return { rows: [] }
      }
      return { rows: [] }
    })
    const mercurClient = buildFakeClient(() => ({ rows: [] }))

    // FakeQueryable structurally matches the runtime Queryable contract but the
    // jest.Mock overload surface does not match pg's strict query() overloads.
    // Casting through unknown is the established Jest+pg test pattern; runtime
    // behavior is fully exercised by the 30/30 unit test pass.
    const result = await service.createEntitlement(dto, {
      coreClient: coreClient as unknown as Queryable,
      mercurClient: mercurClient as unknown as Queryable,
    })
    expect(result.id).toBe("ent-existing")
    expect(result.status).toBe(EntitlementStatus.ACTIVE)
    expect(auditAction).toBe("RE_ISSUED")
  })

  it("createEntitlement throws when order_id is missing", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.createEntitlement({} as any)
    ).rejects.toThrow(/order_id is required/)
  })

  it("createEntitlement throws when face_value_minor cannot be derived", async () => {
    const coreClient = buildFakeClient((sql) => {
      if (sql.includes("FROM gp_core.markets") && sql.includes("sales_channel_id = $1")) {
        return {
          rows: [
            {
              id: "00000000-0000-5000-8000-000000000004",
              instance_id: "gp-dev",
            },
          ],
        }
      }
      return { rows: [] }
    })
    const mercurClient = buildFakeClient((sql) => {
      if (sql.includes('FROM "order"')) {
        return {
          rows: [
            {
              sales_channel_id: "sc_test",
              currency_code: "PLN",
              email: "x@x",
              customer_id: null,
            },
          ],
        }
      }
      return { rows: [] }
    })
    await expect(
      service.createEntitlement(
        { order_id: "ord-noprice" },
        {
          coreClient: coreClient as unknown as Queryable,
          mercurClient: mercurClient as unknown as Queryable,
        }
      )
    ).rejects.toThrow(/face_value_minor must be > 0/)
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
