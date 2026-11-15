/**
 * Story 3.4 (DW-15-318) — wspólna obsługa SQL wspólnej bariery skutku dla
 * fałszywych klientów PG testów `stripe-payment-audit*`. Trasa natywna
 * (`payment.captured`) rezerwuje jednostkę `payment_intent_id:order_id` w
 * `owed_unit_effect_barrier` w savepoincie obejmującym skutek; fałszywka
 * odtwarza semantykę `ON CONFLICT DO NOTHING` i `ROLLBACK TO SAVEPOINT`.
 */
type BarrierState = { claimed: Set<string>; pending: string[] }

const states = new WeakMap<object, BarrierState>()

function stateFor(owner: object): BarrierState {
  let state = states.get(owner)
  if (!state) {
    state = { claimed: new Set(), pending: [] }
    states.set(owner, state)
  }
  return state
}

/** Jednostki zarezerwowane w barierze przez dany fałszywy klient. */
export function owedUnitClaims(owner: object): string[] {
  return [...stateFor(owner).claimed].sort()
}

/**
 * Zwraca wynik dla SQL bariery / savepointów albo `null`, gdy zapytanie
 * nie dotyczy bariery (fałszywka obsługuje je dalej po swojemu).
 */
export function handleOwedUnitBarrierSql(
  owner: object,
  sql: string,
  params: ReadonlyArray<unknown>
): { rows: never[]; rowCount: number } | null {
  const text = sql.trim()
  const state = stateFor(owner)
  if (text.includes("INSERT INTO owed_unit_effect_barrier")) {
    const unitKey = String(params[0])
    if (state.claimed.has(unitKey)) return { rows: [], rowCount: 0 }
    state.claimed.add(unitKey)
    state.pending.push(unitKey)
    return { rows: [], rowCount: 1 }
  }
  if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT")) {
    state.pending = []
    return { rows: [], rowCount: 0 }
  }
  if (text.startsWith("ROLLBACK TO SAVEPOINT")) {
    for (const unitKey of state.pending) state.claimed.delete(unitKey)
    state.pending = []
    return { rows: [], rowCount: 0 }
  }
  return null
}
