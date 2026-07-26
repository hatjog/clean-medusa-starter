/**
 * delivery-state.ts — stany rekordu ledgera dostarczeń (Story 2.3, AC1).
 *
 * Enum jest **ZAPOŻYCZONY** z kontraktu
 * `specs/contracts/events/schemas/payloads/gp.communication.delivery_state_changed.v1.schema.json`
 * (`properties.state.enum`), ale event `gp.communication.delivery_state_changed.v1`
 * **NIE JEST emitowany** w v1.14.0 (AD-7). Pożyczamy wyłącznie słownik stanów,
 * żeby ledger nie wprowadzał drugiego, rozjeżdżalnego słownika.
 *
 * Dlaczego nie import z pliku kontraktu w runtime: backend jest deployowany bez
 * super-repo (`specs/` nie jest częścią artefaktu), więc runtime nie może czytać
 * schemy z dysku. Ten plik jest JEDYNĄ runtime'ową projekcją enumu, a parity
 * z kontraktem pilnuje drift-test
 * `__tests__/modules/voucher-delivery-state-contract-parity.unit.spec.ts`
 * (ten sam wzorzec, co codegen + drift-test rejestru szablonów z 2.2:
 * jedno źródło runtime + test na rozjazd, nigdy dwa literały bez gate'a).
 *
 * Kolejność wpisów jest kolejnością z kontraktu — drift-test porównuje listy
 * jako zbiory ORAZ sygnalizuje różnicę kolejności jako informację, nie błąd.
 */

/** `properties.state.enum` z `gp.communication.delivery_state_changed.v1`. */
export const DELIVERY_DISPATCH_STATES = [
  "queued",
  "sent",
  "delivered",
  "failed",
  "retrying",
  "dead_lettered",
  "degraded",
] as const

export type DeliveryDispatchState = (typeof DELIVERY_DISPATCH_STATES)[number]

/**
 * Nazwa kontraktu, z którego enum jest zapożyczony. Trzymana jako stała, żeby
 * drift-test i komentarze migracji odwoływały się do jednego literału.
 */
export const DELIVERY_STATE_CONTRACT_ID =
  "gp.communication.delivery_state_changed.v1" as const

/**
 * Stany TERMINALNE dla wysyłki: rekord w tym stanie **bezwarunkowo blokuje**
 * ponowną wysyłkę tego samego `(entitlement_id, template_key, recipient_hash)`.
 * Mail jest nieodwracalny — kompensacji nie ma, więc `sent`/`delivered` są
 * absorbujące (AC5).
 */
export const DISPATCH_STATES_BLOCKING_RESEND: readonly DeliveryDispatchState[] = [
  "sent",
  "delivered",
]

/**
 * Stany, z których legalny retry JEST dozwolony (AC5): `failed` (wysyłka
 * odrzucona przez providera) oraz `retrying`. `queued` NIE jest tu wymieniony
 * świadomie — to wysyłka w locie (inny worker trzyma rezerwację); dogonienie
 * porzuconych `queued` należy do reconciliation sweepa (Story 2.5), nie do
 * równoległego drugiego wysłania.
 */
export const DISPATCH_STATES_ALLOWING_RETRY: readonly DeliveryDispatchState[] = [
  "failed",
  "retrying",
]

export function isDeliveryDispatchState(
  value: unknown,
): value is DeliveryDispatchState {
  return (
    typeof value === "string" &&
    (DELIVERY_DISPATCH_STATES as readonly string[]).includes(value)
  )
}
