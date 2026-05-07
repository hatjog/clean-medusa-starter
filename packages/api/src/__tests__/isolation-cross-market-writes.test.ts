/**
 * isolation-cross-market-writes.test — story v160-cleanup-61 DPIA R-12 cross-market WRITE isolation.
 *
 * AC5: Integration tests asserting that writing to vendor A's resource via vendor B context
 *   (or market-A resource via market-B context) returns 403/404 BEFORE any DB tx commits.
 *   No row mutation, no audit write, no notification dispatched on cross-market probe.
 *
 * AC6: Each newly-guarded write handler has at least one AR45-boundary test (positive + negative).
 *
 * Coverage:
 *   - store/ surface: `store/vouchers/[code]/claim` POST (cleanup-27 guard + cleanup-61 helper adoption)
 *   - admin/ surface: `assertResourceMarket` helper cross-market admin FP-suppressed (intentional)
 *   - vendor/ surface: `vendor/training-cert/upload` (vendor-JWT scoped, FP-suppressed)
 *
 * NOTE — review fix M3 (2026-05-07): These tests are unit-level using in-memory stubs.
 * Side-effect ordering ("AR45 fires BEFORE audit/notification/DB") is verified at the
 * helper level only; a real-route integration test against a docker-compose stack is
 * deferred to a follow-up story (`cleanup-61b` integration evidence) per AC5 STAGING-FREE
 * constraint (UX-DR108 / ADR-066). The hand-written `simulateClaimRoute` helper mirrors
 * but does NOT invoke `claim/route.ts` POST handler. Until the integration smoke harness
 * lands, regressions in ordering inside the real handler are NOT caught by this file.
 *
 * DPIA R-12 write-side mitigation evidence: test names + commit SHA in completion notes.
 */

import { describe, expect, it } from "@jest/globals"

import { assertResourceMarket } from "../lib/assert-resource-market"
import type { VoucherWithEvents } from "../modules/voucher"

// ---------------------------------------------------------------------------
// Helper: simulate the claim route's AR45 write-path guard
// (mirrors the logic in store/vouchers/[code]/claim/route.ts)
// ---------------------------------------------------------------------------

interface ClaimRouteSimulation {
  status: number
  body: Record<string, unknown>
  dbMutationAttempted: boolean
  auditWritten: boolean
  notificationDispatched: boolean
}

/**
 * Simulate the write-path AR45 guard in claim/route.ts.
 *
 * Mirrors the real route's behaviour after the cleanup-61 helper adoption:
 *   1. Null voucher → constant-time path returns 404 without invoking helper
 *      (helper would not block on null voucher anyway with default options).
 *   2. Non-null voucher → assertResourceMarket(..., { allowMissingAls: true }):
 *      a. cross-market mismatch → blocked, 404, no side-effects.
 *      b. same-market or no ALS context → not blocked, mutation proceeds.
 */
function simulateClaimRoute(
  voucherOrNull: VoucherWithEvents | null,
  alsMarketId: string | null
): ClaimRouteSimulation {
  // Null voucher follows the constant-time anti-enumeration path; the AR45
  // helper is NOT invoked for it (matches real claim/route.ts behaviour).
  if (voucherOrNull === null) {
    return {
      status: 404,
      body: { type: "not_found", message: "Voucher not found" },
      dbMutationAttempted: false,
      auditWritten: false,
      notificationDispatched: false,
    }
  }

  // AR45 pre-mutation assertion — public store endpoint passes
  // `allowMissingAls: true` so callers without ALS injection still resolve.
  const guard = assertResourceMarket(voucherOrNull, alsMarketId, "Voucher", {
    allowMissingAls: true,
  })

  if (guard.blocked) {
    // Fail-closed: return 404 WITHOUT any DB mutation, audit, or notification
    return {
      status: 404,
      body: guard.body as Record<string, unknown>,
      dbMutationAttempted: false,
      auditWritten: false,
      notificationDispatched: false,
    }
  }

  // Only reach here on same-market (or allowMissingAls + no ALS) — proceed with mutation
  return {
    status: 200,
    body: { state: "claimed", seller_handle: voucherOrNull.seller_handle ?? null },
    dbMutationAttempted: true,
    auditWritten: true,
    notificationDispatched: true,
  }
}

// ---------------------------------------------------------------------------
// In-memory voucher factory
// ---------------------------------------------------------------------------

function makeVoucher(
  code: string,
  market_id: string | null,
  status: "idle" | "claimed" | "expired" = "idle"
): VoucherWithEvents {
  return {
    code,
    market_id,
    seller_id: "sel_test",
    seller_name: "Test Seller",
    seller_handle: "test-seller",
    product_title: "Test Product",
    value_minor: 10000,
    currency_code: "PLN",
    status,
    expires_at: new Date("2027-12-31T23:59:59Z"),
    created_at: new Date(),
    updated_at: new Date(),
    events: [],
  }
}

// ---------------------------------------------------------------------------
// AC6 — assertResourceMarket helper unit tests (AR45 write-path logic)
// ---------------------------------------------------------------------------

describe("v160-cleanup-61 AC6: assertResourceMarket helper — AR45 boundary tests", () => {
  it("same-market write: resource.market_id === alsMarketId → NOT blocked", () => {
    const resource = { market_id: "market-bonbeauty" }
    const result = assertResourceMarket(resource, "market-bonbeauty", "voucher")
    expect(result.blocked).toBe(false)
  })

  it("cross-market write: resource.market_id !== alsMarketId → BLOCKED (404 fail-closed)", () => {
    const resource = { market_id: "market-bonbeauty" }
    const result = assertResourceMarket(resource, "market-kremidotyk", "voucher")
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.body.type).toBe("not_found")
      // 404 not 403 — existence must not leak across markets
      expect(result.body.message).toMatch(/not found/)
    }
  })

  // Review fix M2 — default is now fail-closed for missing ALS;
  // null-resource is no longer auto-blocked (caller handles it).
  it("[default fail-closed] resource not found (null) → NOT blocked (caller handles null-resource)", () => {
    const result = assertResourceMarket(null, "market-bonbeauty", "voucher")
    expect(result.blocked).toBe(false)
  })

  it("resource not found (null) with blockOnMissingResource:true → BLOCKED 404", () => {
    const result = assertResourceMarket(null, "market-bonbeauty", "voucher", {
      blockOnMissingResource: true,
    })
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.body.type).toBe("not_found")
    }
  })

  it("[default fail-closed] no ALS context (alsMarketId=null) → BLOCKED (middleware bug must NOT grant write access)", () => {
    const resource = { market_id: "market-bonbeauty" }
    const result = assertResourceMarket(resource, null, "voucher")
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.body.type).toBe("not_found")
    }
  })

  it("no ALS context (alsMarketId=null) with allowMissingAls:true → NOT blocked (admin / system-level opt-in)", () => {
    const resource = { market_id: "market-bonbeauty" }
    const result = assertResourceMarket(resource, null, "voucher", {
      allowMissingAls: true,
    })
    expect(result.blocked).toBe(false)
  })

  it("[default fail-closed] empty alsMarketId string → BLOCKED", () => {
    const resource = { market_id: "market-bonbeauty" }
    const result = assertResourceMarket(resource, "", "voucher")
    expect(result.blocked).toBe(true)
  })

  it("empty alsMarketId with allowMissingAls:true → NOT blocked", () => {
    const resource = { market_id: "market-bonbeauty" }
    const result = assertResourceMarket(resource, "", "voucher", {
      allowMissingAls: true,
    })
    expect(result.blocked).toBe(false)
  })

  it("resource has null market_id (unscoped/global) → NOT blocked", () => {
    const resource = { market_id: null as string | null }
    const result = assertResourceMarket(resource, "market-bonbeauty", "voucher")
    expect(result.blocked).toBe(false)
  })

  // Review fix L1 — empty-string market_id is a data-integrity bug, not "unscoped".
  it("[review fix L1] resource has empty-string market_id → BLOCKED (data-integrity bug, not silently allowed)", () => {
    const resource = { market_id: "" }
    const result = assertResourceMarket(resource, "market-bonbeauty", "voucher")
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.body.type).toBe("not_found")
    }
  })
})

// ---------------------------------------------------------------------------
// AC5 — DPIA R-12 cross-market WRITE integration tests
// store/ surface: voucher claim write path
// ---------------------------------------------------------------------------

describe("v160-cleanup-61 AC5: DPIA R-12 cross-market WRITE isolation — store/ surface (voucher claim)", () => {
  const MARKET_A = "market-bonbeauty"
  const MARKET_B = "market-kremidotyk"

  it("[POSITIVE] same-market voucher claim write succeeds — DB mutation, audit, notification all proceed", () => {
    const voucherA = makeVoucher("VOUCHER-WRITE-MKTPA-001", MARKET_A)

    const result = simulateClaimRoute(voucherA, MARKET_A)

    expect(result.status).toBe(200)
    expect(result.dbMutationAttempted).toBe(true)
    expect(result.auditWritten).toBe(true)
    expect(result.notificationDispatched).toBe(true)
    expect(result.body.state).toBe("claimed")
  })

  it("[NEGATIVE] cross-market voucher claim: vendor B context cannot claim market A voucher → 404, NO DB mutation, NO audit, NO notification", () => {
    // Market A voucher; ALS context = market B (cross-market probe)
    const voucherA = makeVoucher("VOUCHER-WRITE-DPIA-R12-001", MARKET_A)

    // AR45 assertion fires BEFORE DB tx — mutation never begins
    const result = simulateClaimRoute(voucherA, MARKET_B)

    // AC5 contract: fail-closed BEFORE any DB tx commits
    expect(result.status).toBe(404)
    expect(result.dbMutationAttempted).toBe(false)
    expect(result.auditWritten).toBe(false)
    expect(result.notificationDispatched).toBe(false)
    // 404 not 403 — existence must NOT leak across markets (cleanup-27 AC6 protocol)
    expect(result.body.type).toBe("not_found")
  })

  it("[NEGATIVE] cross-market probe: market B context hits market A voucher URL — existence does NOT leak (404 not 403)", () => {
    const voucherA = makeVoucher("VOUCHER-EXISTENCE-LEAK-CHECK", MARKET_A)

    const result = simulateClaimRoute(voucherA, MARKET_B)

    // Existence must not leak: response must be 404 (same as "not found"),
    // never 403 ("forbidden" implies existence is known)
    expect(result.status).toBe(404)
    expect(result.body.type).toBe("not_found")
    expect(result.dbMutationAttempted).toBe(false)
  })

  it("[backward-compat] null ALS market_id with public-store allowMissingAls:true → mutation allowed", () => {
    // The real claim route uses { allowMissingAls: true } so pre-middleware
    // clients (no ALS injection) can still reach the endpoint.
    const voucherA = makeVoucher("VOUCHER-NO-ALS-CONTEXT", MARKET_A)

    const result = simulateClaimRoute(voucherA, null)

    expect(result.status).toBe(200)
    expect(result.dbMutationAttempted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC5 — DPIA R-12 cross-market WRITE isolation — admin/ surface
// Admin routes are cross_market_admin per AR44 §admin-exclusion. They MUST
// pass `allowMissingAls: true` (or have ALS injected explicitly) — the helper's
// new fail-closed default protects against silent middleware regressions.
// ---------------------------------------------------------------------------

describe("v160-cleanup-61 AC5: DPIA R-12 cross-market WRITE isolation — admin/ surface (cross_market_admin exclusion)", () => {
  it("[admin-exclusion] admin caller with allowMissingAls:true may mutate any-market resource — AR44 §admin-exclusion", () => {
    // Admin routes use no ALS market injection — market context is null.
    // They MUST opt into permissive behaviour explicitly via allowMissingAls.
    const sellerRow = { market_id: "market-bonbeauty" }

    const result = assertResourceMarket(sellerRow, null, "seller", {
      allowMissingAls: true,
    })
    expect(result.blocked).toBe(false)
  })

  it("[admin-exclusion] admin caller without allowMissingAls → BLOCKED by default (regression-protection)", () => {
    // If an admin route forgets to pass allowMissingAls, the helper fails closed.
    // This regression test guards against silent re-introduction of the original
    // fail-OPEN default (review fix M2).
    const sellerRow = { market_id: "market-bonbeauty" }

    const result = assertResourceMarket(sellerRow, null, "seller")
    expect(result.blocked).toBe(true)
  })

  it("[admin-exclusion] admin seller-pause correctly resolves market from seller row — AC3 annotated handler", () => {
    // AR45 admin-cross-market: admin/sellers/[id]/pause uses seller.market_id from DB row
    // (effectiveMarketId), not ALS context. Correct by design per AR44 §admin-exclusion.
    const sellerA = { market_id: "market-bonbeauty" }
    const sellerB = { market_id: "market-kremidotyk" }

    expect(assertResourceMarket(sellerA, null, "seller", { allowMissingAls: true }).blocked).toBe(false)
    expect(assertResourceMarket(sellerB, null, "seller", { allowMissingAls: true }).blocked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC5 — DPIA R-12 cross-market WRITE isolation — vendor/ surface
// Vendor routes use JWT vendor_id scope, not market_id ALS (OQ#5 confirmed).
// They opt into `allowMissingAls: true` explicitly.
// ---------------------------------------------------------------------------

describe("v160-cleanup-61 AC5: DPIA R-12 cross-market WRITE isolation — vendor/ surface (JWT-vendor-scoped)", () => {
  it("[vendor-jwt-exclusion] vendor training-cert upload: no ALS market_id with allowMissingAls:true → NOT blocked", () => {
    // Vendor routes inject JWT vendor_id, not ALS market_id.
    const vendorResource = { market_id: "market-bonbeauty", vendor_id: "vendor-abc" }

    const result = assertResourceMarket(vendorResource, null, "vendor-resource", {
      allowMissingAls: true,
    })
    expect(result.blocked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC5 — ALS context: cross-market write fails-closed BEFORE side-effects
// Verifies ordering invariant: AR45 assertion fires before audit, event, notification.
// NOTE (review fix M3): ordering is verified at helper-call level only; the
// real claim/route.ts handler is not invoked here. See file header.
// ---------------------------------------------------------------------------

describe("v160-cleanup-61 AC5: AR45 side-effect ordering — assertion fires BEFORE audit/notification/DB", () => {
  it("cross-market write: audit write is NOT reached on blocked path", () => {
    const auditCalls: string[] = []
    const voucherA = makeVoucher("VOUCHER-ORDER-CHECK", "market-bonbeauty")

    // Simulate route handler with side-effect tracking
    const als_market_id = "market-kremidotyk" // cross-market
    const guard = assertResourceMarket(voucherA, als_market_id, "voucher")

    if (guard.blocked) {
      // return 404 — audit NOT reached
      // (auditCalls intentionally not populated)
    } else {
      // mutation path — would log to audit
      auditCalls.push("audit-write")
    }

    expect(guard.blocked).toBe(true)
    expect(auditCalls).toHaveLength(0)
  })

  it("same-market write: audit write IS reached on non-blocked path", () => {
    const auditCalls: string[] = []
    const voucherA = makeVoucher("VOUCHER-ORDER-CHECK-OK", "market-bonbeauty")

    const als_market_id = "market-bonbeauty" // same market
    const guard = assertResourceMarket(voucherA, als_market_id, "voucher")

    if (guard.blocked) {
      // blocked — no audit
    } else {
      auditCalls.push("audit-write")
    }

    expect(guard.blocked).toBe(false)
    expect(auditCalls).toHaveLength(1)
  })
})
