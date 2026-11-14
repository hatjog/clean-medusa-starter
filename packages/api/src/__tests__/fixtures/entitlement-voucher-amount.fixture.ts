/**
 * Fixture uprawnienia KWOTOWEGO `VOUCHER_AMOUNT` w ŚLEDZONEJ ścieżce
 * (v1.16.0 Story 5.4 AC3, wchłonięta Story 5.6, `DW-15-162`; AD-34 „kontrola
 * ujemna": bez jawnie nazwanego fixture'u o śledzonej siedzibie pomiar gałęzi
 * kwotowej jest `NOT_MEASURED`, bo komplet realnych uprawnień środowiska ma
 * typ `VOUCHER_SERVICE`).
 *
 * Kształt odpowiada wierszowi `entitlement_instance` z saldem: `remaining_amount`
 * równe brutto emisji, brutto w `policy_snapshot.amount_minor`.
 */
export const VOUCHER_AMOUNT_FIXTURE = {
  code: "V-STORY54-AMOUNT",
  entitlementId: "ent_story54_amount",
  type: "VOUCHER_AMOUNT" as const,
  grossMinor: 20000,
  remainingAmount: 20000,
}

/** Uprawnienie usługowe do porównania — realny kształt: brak salda (`NULL`). */
export const VOUCHER_SERVICE_FIXTURE = {
  code: "V-STORY54-SERVICE",
  entitlementId: "ent_story54_service",
  type: "VOUCHER_SERVICE" as const,
  grossMinor: 34000,
  remainingAmount: null,
}
