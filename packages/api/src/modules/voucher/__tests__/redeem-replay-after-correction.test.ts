/**
 * v1.16.0 Story 5.8 (DW-15-359 p.1, ADR-245 `Proposed`) — replay pierwotnej
 * realizacji PO korekcie.
 *
 * Przed 5.8: ponowienie `redeem` z tym samym kluczem idempotencji po korekcie
 * zwracało replay „zrealizowano” (200 na trasie), choć uprawnienie jest w
 * `REDEMPTION_REVERSED`, a kod znów nadaje się do realizacji. Teraz: odmowa
 * NAZWANA stanem uprawnienia (`RedeemEntitlementStateError`,
 * `entitlement_state = REDEMPTION_REVERSED`), bez drugiego skutku; realizacja
 * nowym kluczem przechodzi (D-36).
 */
import { describe, expect, it } from "@jest/globals"
import { EntitlementInstanceState, EntitlementType } from "../models/entitlement"
import {
  InMemoryRedeemPartialStore,
  RedeemEntitlementStateError,
  RedeemPartialEntitlementOperation,
  type RedeemableAmountEntitlement,
} from "../workflows/redeem-partial-entitlement"

const CODE = "GP-SVC-5-8-0001"
const NOW = new Date("2026-11-15T10:00:00.000Z")

function serviceRow(): RedeemableAmountEntitlement {
  return {
    id: "ent_5_8",
    entitlement_type: EntitlementType.VOUCHER_SERVICE,
    state: EntitlementInstanceState.ACTIVE,
    remaining_amount: 1,
    policy_snapshot: { transferability: "bearer", voucher_code: CODE, amount_minor: 15000 },
    vat_classification: "MPV",
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    vendor_id: null,
    location_id: null,
    recipient_customer_id: null,
  }
}

function setup() {
  const store = new InMemoryRedeemPartialStore([serviceRow()])
  const op = new RedeemPartialEntitlementOperation({
    store,
    events: { emit: async () => undefined },
    clock: () => NOW,
  })
  const redeemWith = (key: string) =>
    op.redeem({
      voucher_code: CODE,
      redeem_full: true,
      idempotency_key_header: key,
      redemption_market_id: "bonbeauty",
      actor: "vendor",
    })
  return { store, op, redeemWith }
}

describe("Story 5.8 DW-15-359 p.1 — replay pierwotnej realizacji po korekcie", () => {
  it("przed korektą replay tego samego klucza jest idempotentny (kontrola dodatnia)", async () => {
    const { store, redeemWith } = setup()
    const first = await redeemWith("s58-key-1")
    const again = await redeemWith("s58-key-1")
    expect(again.idempotent).toBe(true)
    expect(again.redemption_id).toBe(first.redemption_id)
    expect(store.listRedemptions()).toHaveLength(1)
  })

  it("po korekcie replay tego samego klucza ⇒ nazwana odmowa REDEMPTION_REVERSED, zero skutku", async () => {
    const { store, op, redeemWith } = setup()
    await redeemWith("s58-key-1")
    const corrected = await op.correct({ voucher_code: CODE, actor: "vendor" })
    expect(corrected.entitlement_state_after).toBe(
      EntitlementInstanceState.REDEMPTION_REVERSED
    )
    const rowsAfterCorrection = store.listRedemptions().length

    const err = await redeemWith("s58-key-1").then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RedeemEntitlementStateError)
    expect((err as RedeemEntitlementStateError).entitlement_state).toBe(
      EntitlementInstanceState.REDEMPTION_REVERSED
    )
    expect(store.get("ent_5_8")!.state).toBe(
      EntitlementInstanceState.REDEMPTION_REVERSED
    )
    expect(store.listRedemptions()).toHaveLength(rowsAfterCorrection)
  })

  it("po korekcie realizacja NOWYM kluczem przechodzi (D-36)", async () => {
    const { store, op, redeemWith } = setup()
    await redeemWith("s58-key-1")
    await op.correct({ voucher_code: CODE, actor: "vendor" })
    const next = await redeemWith("s58-key-2")
    expect(next.idempotent).toBe(false)
    expect(store.get("ent_5_8")!.state).toBe(EntitlementInstanceState.REDEEMED_FULL)
  })
})
