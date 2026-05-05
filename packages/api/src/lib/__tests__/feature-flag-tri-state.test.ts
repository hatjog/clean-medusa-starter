import { describe, expect, it } from "@jest/globals"

import {
  getAuditTrail,
  getCurrentState,
  getFlagState,
  setState,
  validateTransition,
} from "../feature-flag-tri-state"

async function forceOff(): Promise<void> {
  const current = await getCurrentState()
  if (current === "off") {
    return
  }

  await setState("off", {
    triggered_by: "test-reset",
    admin_note: "reset to off",
    bypass_smoke_gate: true,
  })
}

describe("feature-flag-tri-state", () => {
  it("rejects direct OFF -> ON transitions and same-state requests", () => {
    expect(validateTransition("off", "on")).toMatchObject({
      valid: false,
      reason: expect.stringContaining("off->on"),
    })
    expect(validateTransition("shadow", "shadow")).toMatchObject({
      valid: false,
      reason: "same_state",
    })
  })

  it("allows bypassed OFF -> SHADOW transitions and records cache invalidation in the audit trail", async () => {
    await forceOff()

    const result = await setState("shadow", {
      triggered_by: "admin_test",
      admin_note: "shadow probe",
      bypass_smoke_gate: true,
    })

    expect(result).toMatchObject({
      from: "off",
      to: "shadow",
      cache_invalidate_outcome: {
        isr_tags_revalidated: 3,
        redis_keys_busted: 0,
      },
    })
    expect(await getCurrentState()).toBe("shadow")
    expect(getAuditTrail(1)[0]).toMatchObject({
      from: "off",
      to: "shadow",
      triggered_by: "admin_test",
      admin_note: "shadow probe",
    })

    await forceOff()
  })

  it("blocks SHADOW -> ON when the smoke gate is not ratified PASS", async () => {
    await forceOff()
    await setState("shadow", {
      triggered_by: "admin_test",
      admin_note: "prepare blocked transition",
      bypass_smoke_gate: true,
    })

    await expect(
      setState("on", {
        triggered_by: "admin_test",
        admin_note: "should fail",
      })
    ).rejects.toThrow(/SmokeGateBlocked/)

    await forceOff()
  })

  it("maps SHADOW to the single backend flag oracle as on", async () => {
    await forceOff()
    await setState("shadow", {
      triggered_by: "admin_test",
      admin_note: "oracle probe",
      bypass_smoke_gate: true,
    })

    await expect(getFlagState("multi_vendor_pdp")).resolves.toBe("on")

    await forceOff()
  })
})