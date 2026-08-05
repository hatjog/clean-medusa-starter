/**
 * Atrapa nośnika bariery anty-replay dla suit, które przechodzą przez
 * `withVendorAuth` / `vendorAuthMiddleware`, ale NIE mierzą samej bariery.
 *
 * v1.15.0 Story 5.3: od tej story uwierzytelnienie `/vendor/*` konsultuje
 * współdzieloną barierę i FAIL-CLOSED-uje 503, gdy nie może jej dosięgnąć.
 * Suity trasy muszą więc wystawić `PG_CONNECTION` w swoim kontenerze — inaczej
 * mierzą 503 zamiast tego, po co powstały.
 *
 * Ta atrapa jest CELOWO minimalna i CELOWO nie jest przedmiotem asercji w tych
 * suitach. Semantyka bariery jest mierzona tam, gdzie należy:
 *   - `__tests__/lib/vendor-replay-guard.unit.spec.ts`
 *   - `__tests__/api/vendor-auth-replay-cross-instance.unit.spec.ts`
 *   - `evidence/5-3/replay-guard-postgres-proof.{sql,out}` (realny Postgres)
 */

export type ReplayGuardTestDb = {
  raw: (sql: string, bindings?: readonly unknown[]) => Promise<unknown>
  /** Podgląd zajętych kluczy — dla suit, które chcą coś o nich stwierdzić. */
  readonly rows: Map<string, string>
}

/**
 * Buduje magazyn bariery odwzorowujący `INSERT … ON CONFLICT (guard_key)
 * DO UPDATE … WHERE expires_at <= $now RETURNING guard_key`:
 * brak klucza → wiersz, klucz wygasły → wiersz, klucz żywy → brak wiersza.
 */
export function createReplayGuardTestDb(): ReplayGuardTestDb {
  const rows = new Map<string, string>()

  return {
    rows,
    raw: async (sql: string, bindings: readonly unknown[] = []) => {
      if (sql.trim().toUpperCase().startsWith("DELETE")) {
        return { rows: [] }
      }

      const [guardKey, , expiresIso, , nowIso] = bindings as string[]
      const existing = rows.get(guardKey)

      if (existing !== undefined && !(existing <= nowIso)) {
        return { rows: [] }
      }

      rows.set(guardKey, expiresIso)
      return { rows: [{ guard_key: guardKey }] }
    },
  }
}
