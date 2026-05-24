/**
 * cc-4 F-02 regression tests for extractActorIdOrThrow.
 *
 * The helper now refuses any auth_context whose actor_type is not "user".
 * These tests prove customer/vendor/seller JWTs that happen to carry a
 * populated actor_id are rejected at the extraction step before any
 * downstream handler logic runs.
 */
import type { MedusaRequest } from "@medusajs/framework/http"
import { extractActorIdOrThrow } from "../../lib/capability-check"

function makeReq(
  authContext: { actor_id?: string; actor_type?: string } | undefined,
): MedusaRequest {
  return { auth_context: authContext } as unknown as MedusaRequest
}

describe("cc-4 F-02 extractActorIdOrThrow actor_type guard", () => {
  it("returns actor_id for actor_type=user", () => {
    expect(
      extractActorIdOrThrow(
        makeReq({ actor_id: "usr_admin_01", actor_type: "user" }),
      ),
    ).toBe("usr_admin_01")
  })

  it("returns actor_id when actor_type is omitted (back-compat with legacy fixtures)", () => {
    // Some routes still pass auth_context without actor_type in tests.
    // The guard only fires when actor_type is present AND not "user" so
    // existing fixtures keep working.
    expect(
      extractActorIdOrThrow(makeReq({ actor_id: "usr_admin_02" })),
    ).toBe("usr_admin_02")
  })

  it("throws when auth_context is missing", () => {
    expect(() => extractActorIdOrThrow(makeReq(undefined))).toThrow(
      /actor_id missing from auth_context/,
    )
  })

  it("throws when actor_id is empty", () => {
    expect(() => extractActorIdOrThrow(makeReq({ actor_id: "" }))).toThrow(
      /actor_id missing from auth_context/,
    )
  })

  it("throws when actor_type is customer", () => {
    expect(() =>
      extractActorIdOrThrow(
        makeReq({ actor_id: "cust_1", actor_type: "customer" }),
      ),
    ).toThrow(/non-admin actor_type rejected/)
  })

  it("throws when actor_type is seller", () => {
    expect(() =>
      extractActorIdOrThrow(
        makeReq({ actor_id: "seller_1", actor_type: "seller" }),
      ),
    ).toThrow(/non-admin actor_type rejected/)
  })

  it("throws when actor_type is vendor", () => {
    expect(() =>
      extractActorIdOrThrow(
        makeReq({ actor_id: "vendor_1", actor_type: "vendor" }),
      ),
    ).toThrow(/non-admin actor_type rejected/)
  })

  it("throws when actor_type is an unrecognised future namespace", () => {
    expect(() =>
      extractActorIdOrThrow(
        makeReq({ actor_id: "agent_1", actor_type: "ai_agent" }),
      ),
    ).toThrow(/non-admin actor_type rejected/)
  })
})
