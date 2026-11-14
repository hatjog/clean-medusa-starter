/**
 * voucher-purchase-delivery-instance-guard.unit.spec.ts — v1.16.0 Story 11.2 AC2
 * (NFR-3, AD-49, DW-15-183).
 *
 * Strażnik konsumenta `voucher-purchase-delivery` porównuje `scope.instance_id`
 * koperty z WŁASNĄ instancją runtime (GP_INSTANCE_ID):
 *   - zgodna koperta przechodzi dalej,
 *   - podmienione instance_id jest ODRZUCONE z kodem `GP_RUNTIME_INSTANCE_MISMATCH`
 *     PRZED jakimkolwiek zapisem ledgera i wysyłką,
 *   - dwie instancje tego samego `market_id` są rozróżnialne,
 *   - restart (nowy kontekst z tym samym env) zachowuje tożsamość,
 *   - koperta zastana (entitlement id w `instance_id`, sprzed 11.2) i trigger bez
 *     scope (sweep) przechodzą wg zasady kompatybilności ze schematu.
 *
 * Kontrola mutantem: zdjęcie warunku `instanceVerdict === "mismatch"` w
 * `handleVoucherPurchaseDelivery` czerwieni przypadek „podmienione instance_id".
 */

import {
  handleVoucherPurchaseDelivery,
  type PurchaseDeliveryDeps,
} from "../../subscribers/voucher-purchase-delivery"
import {
  buildGenesisIssuedTransition,
  buildTransitionEnvelopes,
} from "../../modules/voucher/entitlement-transition-wiring"
import {
  LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT,
  RUNTIME_INSTANCE_MISMATCH_ERROR_CODE,
  classifyEnvelopeInstance,
  isWithinLegacyCompatibilityWindow,
  requireRuntimeInstanceId,
} from "../../lib/runtime-instance-identity"

const MARKET = "bonbeauty"
const ENT = "ent_guard_1"

/** Producent: koperta zbudowana tak, jak buduje ją runtime instancji `env`. */
function envelopeFrom(env: NodeJS.ProcessEnv, entitlementId = ENT) {
  return buildTransitionEnvelopes(
    buildGenesisIssuedTransition({
      entitlement_id: entitlementId,
      scope: {
        instance_id: requireRuntimeInstanceId("test-producer", env.GP_INSTANCE_ID),
        market_id: MARKET,
      },
      transition_seq: "seq-1",
    }),
    new Date("2026-11-14T10:00:00.000Z")
  ).event
}

/**
 * Konsument z minimalnymi zależnościami. Źródło celowo NIE ma kodu vouchera:
 * koperta, która przejdzie strażnika, kończy na `skipped_missing_voucher_code`
 * (bez I/O ledgera), a odrzucona — na `failed` z kodem niezgodności.
 */
function makeDeps(env: NodeJS.ProcessEnv) {
  const reserveDispatch = jest.fn()
  const dispatch = jest.fn()
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const deps = {
    sourceReader: {
      findBuyerClaimSource: jest.fn(async () => ({
        buyer_email: "buyer@test.local",
        voucher_code: null,
        market_id: MARKET,
      })),
    },
    ledger: { reserveDispatch } as unknown as PurchaseDeliveryDeps["ledger"],
    dispatcher: { dispatch } as unknown as PurchaseDeliveryDeps["dispatcher"],
    marketLocales: {} as unknown as PurchaseDeliveryDeps["marketLocales"],
    logger,
    env,
  } as PurchaseDeliveryDeps
  return { deps, reserveDispatch, dispatch, logger }
}

const INSTANCE_A = { GP_INSTANCE_ID: "gp-bonbeauty-a", GP_ENV: "test" }
const INSTANCE_B = { GP_INSTANCE_ID: "gp-bonbeauty-b", GP_ENV: "test" }

describe("Story 11.2 AC2 — strażnik tożsamości instancji konsumenta", () => {
  it("zgodna koperta przechodzi strażnika", async () => {
    const { deps, reserveDispatch } = makeDeps(INSTANCE_A)
    const result = await handleVoucherPurchaseDelivery(envelopeFrom(INSTANCE_A), deps)
    expect(result.error_code).not.toBe(RUNTIME_INSTANCE_MISMATCH_ERROR_CODE)
    expect(result.outcome).toBe("skipped_missing_voucher_code")
    expect(reserveDispatch).not.toHaveBeenCalled()
  })

  it("podmienione instance_id jest odrzucone z kodem błędu, przed ledgerem i wysyłką", async () => {
    const { deps, reserveDispatch, dispatch, logger } = makeDeps(INSTANCE_A)
    const forged = envelopeFrom(INSTANCE_A)
    forged.scope = { ...forged.scope, instance_id: "gp-forged" }

    const result = await handleVoucherPurchaseDelivery(forged, deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe(RUNTIME_INSTANCE_MISMATCH_ERROR_CODE)
    expect(reserveDispatch).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("obcej instancji"),
      expect.objectContaining({
        error_code: RUNTIME_INSTANCE_MISMATCH_ERROR_CODE,
        envelope_instance_id: "gp-forged",
        runtime_instance_id: "gp-bonbeauty-a",
      })
    )
  })

  it("dwie instancje tego samego market_id dają różne instance_id i są rozróżnialne", async () => {
    const fromA = envelopeFrom(INSTANCE_A)
    const fromB = envelopeFrom(INSTANCE_B)
    expect(fromA.scope.market_id).toBe(fromB.scope.market_id)
    expect(fromA.scope.instance_id).not.toBe(fromB.scope.instance_id)

    const consumerA = makeDeps(INSTANCE_A)
    const consumerB = makeDeps(INSTANCE_B)
    expect((await handleVoucherPurchaseDelivery(fromB, consumerA.deps)).error_code).toBe(
      RUNTIME_INSTANCE_MISMATCH_ERROR_CODE
    )
    expect((await handleVoucherPurchaseDelivery(fromA, consumerB.deps)).error_code).toBe(
      RUNTIME_INSTANCE_MISMATCH_ERROR_CODE
    )
    expect((await handleVoucherPurchaseDelivery(fromA, consumerA.deps)).outcome).toBe(
      "skipped_missing_voucher_code"
    )
  })

  it("restart instancji (nowy kontekst, ten sam env) zachowuje tożsamość", async () => {
    const beforeRestart = envelopeFrom({ ...INSTANCE_A })
    const afterRestart = envelopeFrom({ ...INSTANCE_A })
    expect(afterRestart.scope.instance_id).toBe(beforeRestart.scope.instance_id)

    // Konsument po restarcie (świeże zależności) przyjmuje kopertę sprzed restartu.
    const restarted = makeDeps({ ...INSTANCE_A })
    const result = await handleVoucherPurchaseDelivery(beforeRestart, restarted.deps)
    expect(result.error_code).not.toBe(RUNTIME_INSTANCE_MISMATCH_ERROR_CODE)
    expect(result.outcome).toBe("skipped_missing_voucher_code")
  })

  it("koperta zastana (entitlement id w scope.instance_id) przechodzi z ostrzeżeniem", async () => {
    const { deps, logger } = makeDeps(INSTANCE_A)
    const legacy = envelopeFrom(INSTANCE_A)
    legacy.scope = { ...legacy.scope, instance_id: ENT }

    const result = await handleVoucherPurchaseDelivery(legacy, deps)

    expect(result.outcome).toBe("skipped_missing_voucher_code")
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("koperta zastana"),
      expect.objectContaining({ entitlement_id: ENT })
    )
  })

  it("koperta w kształcie zastanym PO punkcie odcięcia = odmowa (review R-3/R-4)", async () => {
    const { deps, reserveDispatch, dispatch, logger } = makeDeps(INSTANCE_A)
    const late = envelopeFrom(INSTANCE_A)
    late.scope = { ...late.scope, instance_id: ENT }
    late.occurred_at = LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT

    const result = await handleVoucherPurchaseDelivery(late, deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe(RUNTIME_INSTANCE_MISMATCH_ERROR_CODE)
    expect(reserveDispatch).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("koperta zastana"),
      expect.anything()
    )
  })

  it("koperta w kształcie zastanym bez occurred_at = odmowa (wyjątek nie zależy od brakującego pola)", async () => {
    const { deps } = makeDeps(INSTANCE_A)
    const result = await handleVoucherPurchaseDelivery(
      {
        scope: { instance_id: ENT, market_id: MARKET },
        payload: { entitlement_id: ENT, to_state: "ISSUED" },
      },
      deps
    )
    expect(result.error_code).toBe(RUNTIME_INSTANCE_MISMATCH_ERROR_CODE)
  })

  it("trigger bez scope (sweep / płaski payload) nie deklaruje obcej tożsamości i przechodzi", async () => {
    const { deps } = makeDeps(INSTANCE_A)
    const result = await handleVoucherPurchaseDelivery(
      { scope: { market_id: MARKET }, payload: { entitlement_id: ENT, to_state: "ISSUED" } },
      deps
    )
    expect(result.outcome).toBe("skipped_missing_voucher_code")
  })
})

describe("Story 11.2 AC2 — classifyEnvelopeInstance (reguła kompatybilności)", () => {
  const BEFORE = "2026-11-14T10:00:00.000Z"
  const AFTER = "2026-11-15T00:00:00.001Z"
  it.each([
    ["gp-a", ENT, BEFORE, "match"],
    ["gp-a", ENT, AFTER, "match"],
    [null, ENT, AFTER, "absent"],
    ["  ", ENT, AFTER, "absent"],
    [ENT, ENT, BEFORE, "legacy_entitlement_scoped"],
    [ENT, ENT, LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT, "mismatch"],
    [ENT, ENT, AFTER, "mismatch"],
    [ENT, ENT, null, "mismatch"],
    [ENT, ENT, "nie-data", "mismatch"],
    ["gp-b", ENT, BEFORE, "mismatch"],
    ["gp-b", null, BEFORE, "mismatch"],
  ])("instance_id=%p entitlement_id=%p occurred_at=%p → %s", (claimed, entitlementId, occurredAt, verdict) => {
    expect(
      classifyEnvelopeInstance({
        envelope_instance_id: claimed as string | null,
        entitlement_id: entitlementId as string | null,
        runtime_instance_id: "gp-a",
        occurred_at: occurredAt as string | null,
      })
    ).toBe(verdict)
  })

  it("punkt odcięcia jest nazwaną stałą i odpowiada zapisowi kontraktu envelope.v1", () => {
    expect(LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT).toBe("2026-11-15T00:00:00.000Z")
    expect(isWithinLegacyCompatibilityWindow(BEFORE)).toBe(true)
    expect(isWithinLegacyCompatibilityWindow(LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT)).toBe(false)
  })
})
