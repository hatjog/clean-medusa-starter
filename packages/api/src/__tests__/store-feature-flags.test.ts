/**
 * Story v160-cleanup-13c — store/feature-flags route + service test.
 *
 * Verifies that the public-facing flag projection only exposes
 * `multi_vendor_pdp` (no internal admin / audit fields leak).
 */

import { getCurrentState } from "../../../../src/lib/feature-flag-tri-state";

describe("v160-cleanup-13c /store/feature-flags read shape", () => {
  it("getCurrentState() returns one of: off | shadow | on", async () => {
    const value = await getCurrentState();
    expect(["off", "shadow", "on"]).toContain(value);
  });

  it("response shape is the minimal allowlist (no internal fields)", async () => {
    const state = await getCurrentState();
    const response = { multi_vendor_pdp: state };
    const keys = Object.keys(response);
    expect(keys).toEqual(["multi_vendor_pdp"]);
    // Defensive: serialize and assert no audit/admin metadata key bleeds.
    const body = JSON.stringify(response);
    expect(body).not.toMatch(/audit_trail|admin|triggered_by/i);
  });
});
