/**
 * voucher-delivery-state-contract-parity.unit.spec.ts — Story 2.3 (AC1).
 *
 * DRIFT-TEST: enum stanów ledgera JEST zapożyczony z kontraktu
 * `gp.communication.delivery_state_changed.v1` (`properties.state.enum`) i nie
 * wolno mu się od niego rozjechać. Runtime nie może czytać `specs/` (backend
 * deployuje się bez super-repo), więc parity pilnuje ten test — dokładnie ten
 * sam wzorzec, co drift-test projekcji rejestru szablonów z 2.2.
 *
 * Gdy super-repo nie jest dostępne (samodzielny checkout submodułu), test
 * degraduje do jawnego SKIP-u zamiast fałszywego PASS-a.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  DELIVERY_DISPATCH_STATES,
  DELIVERY_STATE_CONTRACT_ID,
  isDeliveryDispatchState,
} from "../../modules/voucher-delivery/delivery-state"
import { RECIPIENT_HASH_PATTERN } from "../../modules/voucher-delivery/recipient-hash"

// packages/api/src/__tests__/modules → siedem poziomów w górę = korzeń
// super-repo (modules → __tests__ → src → api → packages → GP/backend → GP → root).
const REPO_ROOT = resolve(__dirname, "../../../../../../..")
const CONTRACT_PATH = resolve(
  REPO_ROOT,
  "specs/contracts/events/schemas/payloads",
  `${DELIVERY_STATE_CONTRACT_ID}.schema.json`,
)

type ContractSchema = {
  properties?: {
    state?: { enum?: unknown }
    recipient_contact_hash?: { pattern?: unknown }
  }
}

function loadContract(): ContractSchema | null {
  if (!existsSync(CONTRACT_PATH)) return null
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as ContractSchema
}

describe(`ledger delivery state ↔ kontrakt ${DELIVERY_STATE_CONTRACT_ID}`, () => {
  const contract = loadContract()

  if (!contract) {
    it.skip(
      `SKIP: brak ${CONTRACT_PATH} (samodzielny checkout submodułu) — parity ` +
        "nieweryfikowalna; uruchom z kontekstu monorepo GP",
      () => undefined,
    )
    return
  }

  it("zbiór stanów ledgera == `properties.state.enum` kontraktu", () => {
    const contractStates = contract.properties?.state?.enum
    expect(Array.isArray(contractStates)).toBe(true)
    expect([...DELIVERY_DISPATCH_STATES].sort()).toEqual(
      [...(contractStates as string[])].sort(),
    )
  })

  it("każdy stan kontraktu przechodzi runtime'owy type-guard", () => {
    for (const state of contract.properties?.state?.enum as string[]) {
      expect(isDeliveryDispatchState(state)).toBe(true)
    }
  })

  it("stan spoza kontraktu jest odrzucany (test-the-test)", () => {
    expect(isDeliveryDispatchState("wyslane")).toBe(false)
    expect(isDeliveryDispatchState("QUEUED")).toBe(false)
    expect(isDeliveryDispatchState(undefined)).toBe(false)
  })

  it("wzorzec `recipient_hash` ledgera == `recipient_contact_hash` kontraktu", () => {
    const contractPattern = contract.properties?.recipient_contact_hash?.pattern
    expect(typeof contractPattern).toBe("string")
    // Ledger celowo używa TEGO SAMEGO kształtu, żeby hash nie wymagał konwersji,
    // gdyby event kiedyś zaczął być emitowany (NIE w v1.14.0 — AD-7).
    expect(RECIPIENT_HASH_PATTERN.source).toBe(contractPattern)
  })
})
