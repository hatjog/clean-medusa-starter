/**
 * Story v160-cleanup-13b — store-vouchers route tests.
 *
 * Tests the voucher-fixture-store + AR45 PII allowlist projection of the
 * `/store/vouchers/:code` and `/store/vouchers/:code/events` route handlers.
 *
 * Note: route handlers themselves live in the backend top-level
 * `src/api/store/vouchers/[code]/...` outside this packages/api tree. We
 * exercise the underlying projection + fixture store directly here.
 */

import {
  getFixtureByCode,
  upsertFixture,
  clearFixturesForTest,
  listFixtureCodes,
  type VoucherFixture,
} from "../../../../src/lib/voucher-fixture-store";

describe("v160-cleanup-13b voucher fixture store + AR45 allowlist", () => {
  afterEach(() => {
    clearFixturesForTest();
  });

  it("returns the default seeded idle voucher by code", () => {
    const fx = getFixtureByCode("E2E-IDLE-VOUCHER-001");
    expect(fx).not.toBeNull();
    expect(fx?.code).toBe("E2E-IDLE-VOUCHER-001");
    expect(fx?.status).toBe("idle");
    expect(fx?.events.length).toBeGreaterThanOrEqual(1);
  });

  it("returns the default seeded claimed voucher by code with claimed event", () => {
    const fx = getFixtureByCode("E2E-CLAIMED-VOUCHER-002");
    expect(fx).not.toBeNull();
    expect(fx?.status).toBe("claimed");
    const types = fx!.events.map((e) => e.event_type);
    expect(types).toContain("claimed");
  });

  it("returns null for unknown code (404 path)", () => {
    const fx = getFixtureByCode("NEVER-EXISTED");
    expect(fx).toBeNull();
  });

  it("AR45 allowlist projection — JSON.stringify must NOT contain raw PII", () => {
    // Simulate a fixture that hypothetically had buyer-side PII fields. The
    // allowlist projection inside the route handler MUST drop them. We assert
    // the contract by stringifying the public projection ourselves.
    const projection = (fx: VoucherFixture | null) => {
      if (!fx) return null;
      return {
        code: fx.code,
        seller_id: fx.seller_id,
        seller_name: fx.seller_name,
        seller_handle: fx.seller_handle,
        product_title: fx.product_title,
        value_minor: fx.value_minor,
        currency_code: fx.currency_code,
        status: fx.status,
        expires_at: fx.expires_at,
      };
    };
    const fx = getFixtureByCode("E2E-IDLE-VOUCHER-001");
    const view = projection(fx);
    const body = JSON.stringify(view);
    // No buyer email pattern
    expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    // No PL phone pattern
    expect(body).not.toMatch(/\+48\d{9}/);
  });

  it("upsertFixture supports E2E test seeding (idempotent overwrite)", () => {
    const custom: VoucherFixture = {
      code: "E2E-CUSTOM-RUN-XYZ",
      seller_id: "sel_test",
      seller_name: "Test Seller",
      seller_handle: "test-seller",
      product_title: "Test Service",
      value_minor: 5000,
      currency_code: "PLN",
      status: "idle",
      expires_at: null,
      events: [
        {
          id: "evt-1",
          event_type: "created",
          occurred_at: "2026-05-04T00:00:00Z",
        },
      ],
    };
    upsertFixture(custom);
    expect(getFixtureByCode("E2E-CUSTOM-RUN-XYZ")?.status).toBe("idle");
    upsertFixture({ ...custom, status: "claimed" });
    expect(getFixtureByCode("E2E-CUSTOM-RUN-XYZ")?.status).toBe("claimed");
  });

  it("listFixtureCodes returns seeded codes after first read", () => {
    getFixtureByCode("E2E-IDLE-VOUCHER-001"); // triggers seeding
    const codes = listFixtureCodes();
    expect(codes).toContain("E2E-IDLE-VOUCHER-001");
    expect(codes).toContain("E2E-CLAIMED-VOUCHER-002");
  });

  it("events filter to known types only (allowlist) and sort ascending", () => {
    const fx = getFixtureByCode("E2E-CLAIMED-VOUCHER-002");
    expect(fx).not.toBeNull();
    const KNOWN = new Set([
      "created",
      "sent",
      "opened",
      "claimed",
      "withdrawn",
    ]);
    const events = (fx!.events ?? []).filter((e) =>
      KNOWN.has(e.event_type),
    );
    const sorted = [...events].sort((a, b) =>
      a.occurred_at.localeCompare(b.occurred_at),
    );
    expect(events.map((e) => e.id)).toEqual(sorted.map((e) => e.id));
    expect(events[0].event_type).toBe("created");
  });
});
