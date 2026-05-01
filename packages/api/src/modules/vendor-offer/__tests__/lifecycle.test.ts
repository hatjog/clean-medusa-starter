import { describe, expect, it } from "@jest/globals"

import {
  allowedNextStates,
  assertCanTransition,
  canTransition,
  isTerminal,
} from "../lifecycle"
import type {
  VendorOfferLifecycleState,
  VendorOfferRepositoryPort,
} from "../index"
import { VendorOfferError, VendorOfferService } from "../index"

/**
 * STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA — 8 ACs verbatim mapped.
 *
 * AC-MVF-4.1-01: vendor_offer table created with required columns.
 *                  → Verified by SQL migration; lifecycle test asserts the
 *                    types compile + service can build a valid draft row.
 * AC-MVF-4.1-02: lifecycle state machine — valid + invalid transitions.
 * AC-MVF-4.1-03: archived is terminal.
 * AC-MVF-4.1-04: cart_item.selected_vendor_offer_id is NULLABLE.
 *                  → Verified by SQL migration body + Python validator
 *                    (`_grow/tools/validate_vendor_offer_schema_only.py`).
 * AC-MVF-4.1-05: optimistic locking via version column.
 * AC-MVF-4.1-06: FK integrity (vendor_offer.id ← cart_item.selected_vendor_offer_id).
 *                  → Verified by SQL migration + Python validator.
 * AC-MVF-4.1-07: D-78 gate — `validate_mor_per_offer_capability.py` exit 0
 *                  WARN before merge (CI step external; smoke run here).
 * AC-MVF-4.1-08: MIG-C3 SAME-story activation — daily WARN run + zero
 *                  violations across stabilization window.
 *
 * Schema-only enforcement: VendorOfferService throws `RUNTIME_DISABLED`
 * when `multi_vendor_pricing_enabled=true`.
 */

/** In-memory test repository implementing the port — used by service tests. */
class InMemoryVendorOfferRepository implements VendorOfferRepositoryPort {
  private store = new Map<string, ReturnType<InMemoryVendorOfferRepository["snapshot"]>>()

  private snapshot(row: Record<string, unknown>) {
    return JSON.parse(JSON.stringify(row)) as Record<string, unknown> & {
      id: string
      version: number
      status: VendorOfferLifecycleState
    }
  }

  async findById(id: string) {
    const row = this.store.get(id)
    return row ? (row as unknown as Awaited<ReturnType<VendorOfferRepositoryPort["findById"]>>) : null
  }

  async findByProduct(productId: string) {
    return Array.from(this.store.values()).filter(
      (r) => (r as { product_id: string }).product_id === productId
    ) as unknown as Awaited<ReturnType<VendorOfferRepositoryPort["findByProduct"]>>
  }

  async insert(draft: Parameters<VendorOfferRepositoryPort["insert"]>[0]) {
    this.store.set(draft.id, this.snapshot(draft as Record<string, unknown>))
    return draft
  }

  async conditionalUpdate(
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>
  ) {
    const row = this.store.get(id)
    if (!row) return null
    if (row.version !== expectedVersion) return null
    const merged = { ...row, ...patch } as typeof row
    this.store.set(id, merged)
    return merged as unknown as Awaited<ReturnType<VendorOfferRepositoryPort["conditionalUpdate"]>>
  }
}

describe("vendor-offer lifecycle (AC-MVF-4.1-02 + AC-MVF-4.1-03)", () => {
  it("AC-MVF-4.1-02 (valid): active → suspended is allowed", () => {
    expect(canTransition("active", "suspended")).toBe(true)
    expect(() => assertCanTransition("active", "suspended")).not.toThrow()
  })

  it("AC-MVF-4.1-02 (valid): active → archived is allowed", () => {
    expect(canTransition("active", "archived")).toBe(true)
    expect(() => assertCanTransition("active", "archived")).not.toThrow()
  })

  it("AC-MVF-4.1-02 (valid): suspended → active is allowed (opt-back-in)", () => {
    expect(canTransition("suspended", "active")).toBe(true)
  })

  it("AC-MVF-4.1-02 (valid): suspended → archived is allowed", () => {
    expect(canTransition("suspended", "archived")).toBe(true)
  })

  it("AC-MVF-4.1-03 (terminal): archived → * is forbidden", () => {
    expect(canTransition("archived", "active")).toBe(false)
    expect(canTransition("archived", "suspended")).toBe(false)
    expect(isTerminal("archived")).toBe(true)
    expect(isTerminal("active")).toBe(false)
    expect(isTerminal("suspended")).toBe(false)
  })

  it("AC-MVF-4.1-02 (no-op): same-state transitions are not lifecycle transitions", () => {
    expect(canTransition("active", "active")).toBe(false)
    expect(canTransition("suspended", "suspended")).toBe(false)
  })

  it("assertCanTransition throws VendorOfferError(INVALID_TRANSITION) on archived", () => {
    expect(() => assertCanTransition("archived", "active")).toThrow(VendorOfferError)
    try {
      assertCanTransition("archived", "active")
    } catch (err) {
      expect((err as VendorOfferError).code).toBe("INVALID_TRANSITION")
    }
  })

  it("allowedNextStates returns sorted next states", () => {
    expect(allowedNextStates("active")).toEqual(["archived", "suspended"])
    expect(allowedNextStates("suspended")).toEqual(["active", "archived"])
    expect(allowedNextStates("archived")).toEqual([])
  })
})

describe("VendorOfferService — schema-only enforcement (ADR-070)", () => {
  it("throws RUNTIME_DISABLED on create when flag is on", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: true },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.create({
        vendor_id: "v1",
        product_id: "p1",
        price: 10,
        seat_capacity: 5,
        signature: "sig",
      })
    ).rejects.toMatchObject({ code: "RUNTIME_DISABLED" })
  })

  it("throws RUNTIME_DISABLED on update when flag is on", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: true },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.update({
        id: "id",
        expected_version: 0,
        patch: { price: 99 },
      })
    ).rejects.toMatchObject({ code: "RUNTIME_DISABLED" })
  })

  it("throws RUNTIME_DISABLED on transitionStatus when flag is on", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: true },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.transitionStatus({ id: "id", expected_version: 0, to: "archived" })
    ).rejects.toMatchObject({ code: "RUNTIME_DISABLED" })
  })

  it("READ side is NOT guarded (diagnostic queries always allowed)", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: true },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(service.getById("missing")).resolves.toBeNull()
    await expect(service.findByProduct("p1")).resolves.toEqual([])
  })

  it("flag-off: write path executes (would throw NOT_FOUND only on missing rows)", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    const created = await service.create({
      vendor_id: "v1",
      product_id: "p1",
      price: 10,
      seat_capacity: 5,
      signature: "sig-1",
    })
    expect(created.status).toBe("active")
    expect(created.version).toBe(0)
    expect(created.incumbent_marker).toBe(false)
  })
})

describe("VendorOfferService — optimistic locking (AC-MVF-4.1-05)", () => {
  it("update bumps version and rejects stale expected_version", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    const created = await service.create({
      vendor_id: "v1",
      product_id: "p1",
      price: 10,
      seat_capacity: 5,
      signature: "sig-1",
    })
    const updated = await service.update({
      id: created.id,
      expected_version: 0,
      patch: { price: 20 },
    })
    expect(updated.version).toBe(1)
    expect(updated.price).toBe(20)

    await expect(
      service.update({
        id: created.id,
        expected_version: 0, // stale
        patch: { price: 30 },
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" })
  })

  it("update rejects unknown id with NOT_FOUND", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.update({
        id: "ghost",
        expected_version: 0,
        patch: { price: 1 },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("transitionStatus enforces lifecycle + version guard", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    const created = await service.create({
      vendor_id: "v1",
      product_id: "p1",
      price: 10,
      seat_capacity: 5,
      signature: "sig-1",
    })
    const archived = await service.transitionStatus({
      id: created.id,
      expected_version: 0,
      to: "archived",
    })
    expect(archived.status).toBe("archived")
    expect(archived.archived_at).not.toBeNull()
    expect(archived.version).toBe(1)

    // archived → * is forbidden by lifecycle
    await expect(
      service.transitionStatus({
        id: created.id,
        expected_version: 1,
        to: "active",
      })
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  })
})

describe("VendorOfferService — draft validation", () => {
  it("rejects negative price", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.create({
        vendor_id: "v1",
        product_id: "p1",
        price: -1,
        seat_capacity: 5,
        signature: "sig",
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" })
  })

  it("rejects negative seat_capacity", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.create({
        vendor_id: "v1",
        product_id: "p1",
        price: 10,
        seat_capacity: -1,
        signature: "sig",
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" })
  })

  it("rejects empty vendor_id / product_id", async () => {
    const service = new VendorOfferService({
      flags: { multi_vendor_pricing_enabled: false },
      repo: new InMemoryVendorOfferRepository(),
    })
    await expect(
      service.create({
        vendor_id: "",
        product_id: "p1",
        price: 10,
        seat_capacity: 5,
        signature: "sig",
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" })
  })
})
