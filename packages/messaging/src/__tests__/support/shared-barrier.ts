/**
 * Atrapa TRWAŁEJ bariery dostawy — WSPÓŁDZIELONA między instancjami gatewaya.
 *
 * v1.15.0 Story 4.1 (AC1, AC3, AC4, AC5).
 *
 * ── Co ta atrapa jest, a czym NIE jest ─────────────────────────────────────
 * Odwzorowuje SEMANTYKĘ stwierdzenia, które wykonuje implementacja produkcyjna
 * (`PgDispatchIdempotencyBarrier` w `packages/api`):
 *
 *   `INSERT … ON CONFLICT (barrier_key) DO UPDATE … WHERE
 *      messaging_dispatch_barrier.expires_at IS NOT NULL
 *      AND messaging_dispatch_barrier.expires_at <= $now
 *    RETURNING barrier_key`
 *
 * czyli trzy przypadki: (1) klucza nie ma → zajmujemy; (2) klucz jest, ale
 * WYGASŁ → przejmujemy; (3) klucz jest i żyje (albo jest bezterminowy) →
 * odmowa. NIE JEST Postgresem — sam SQL jest dowiedziony przebiegiem na realnej
 * bazie w `packages/api/src/__tests__/integration/messaging-dispatch-barrier-pg.integration.test.ts`
 * oraz w `evidence/4-1/`.
 *
 * ── Po co JEDEN obiekt dla dwóch gatewayów ─────────────────────────────────
 * Bo to jest cała różnica między starą mapą a barierą: dwie instancje mają
 * osobne procesy, ale JEDNĄ bazę. Dwa gatewaye wskazujące na ten sam obiekt
 * odwzorowują dokładnie tę topologię — w odróżnieniu od dwóch wywołań tego
 * samego gatewaya, które przechodziły także ze starą mapą.
 */
import type {
  BarrierClaim,
  BarrierClaimInput,
  BarrierSettleInput,
  DispatchIdempotencyBarrier,
  NotificationDispatch,
} from "../../index";

interface BarrierRow {
  state: "in_flight" | "settled";
  dispatch: NotificationDispatch | null;
  /** `null` = BEZTERMINOWO (dostawa rozstrzygnięta jako „poszła"). */
  expires_at_ms: number | null;
  /**
   * Token zajęcia — atrapa MUSI go modelować (R-4.1-M3). Gdyby go pomijała,
   * `settle`/`release` przechodziłyby tu na CUDZYM zajęciu, czyli atrapa
   * ukrywałaby dokładnie ten defekt, przed którym chroni kolumna `claim_token`.
   */
  claim_token: string;
}

export class SharedDispatchBarrier implements DispatchIdempotencyBarrier {
  readonly rows = new Map<string, BarrierRow>();
  /** Ile razy KTÓRAKOLWIEK instancja wysłała stwierdzenie zajęcia do „bazy". */
  claims = 0;

  async claim(input: BarrierClaimInput): Promise<BarrierClaim> {
    this.claims += 1;
    const nowMs = input.now.getTime();
    const existing = this.rows.get(input.barrier_key);

    // Predykat okna — DOKŁADNIE ten, który siedzi w `WHERE` na `DO UPDATE`.
    // Wpis bezterminowy (`expires_at_ms === null`) nie jest przejmowalny NIGDY.
    const reclaimable =
      existing === undefined ||
      (existing.expires_at_ms !== null && existing.expires_at_ms <= nowMs);

    if (!reclaimable) {
      return {
        outcome: "blocked",
        // Odczyt PO werdykcie — nie zmienia go, odtwarza tylko wynik poprzedniego
        // przebiegu. `null` przy `in_flight` znaczy „ktoś inny wysyła TERAZ".
        dispatch: existing!.state === "settled" ? existing!.dispatch : null,
      };
    }

    this.rows.set(input.barrier_key, {
      state: "in_flight",
      dispatch: null,
      expires_at_ms: nowMs + input.in_flight_window_ms,
      claim_token: input.claim_token,
    });
    return { outcome: "claimed", dispatch: null };
  }

  /** Domyka WYŁĄCZNIE własne zajęcie — `WHERE … AND claim_token = $token`. */
  async settle(input: BarrierSettleInput): Promise<void> {
    const existing = this.rows.get(input.barrier_key);
    if (existing?.claim_token !== input.claim_token) {
      return;
    }
    this.rows.set(input.barrier_key, {
      state: "settled",
      dispatch: input.dispatch,
      expires_at_ms: input.expires_at ? input.expires_at.getTime() : null,
      claim_token: input.claim_token,
    });
  }

  /** Zwalnia WYŁĄCZNIE własne, NIEDOMKNIĘTE zajęcie (oba warunki, jak w SQL). */
  async release(input: { barrier_key: string; claim_token: string }): Promise<void> {
    const existing = this.rows.get(input.barrier_key);
    if (existing?.state !== "in_flight") {
      return;
    }
    if (existing.claim_token !== input.claim_token) {
      return;
    }
    this.rows.delete(input.barrier_key);
  }
}

/**
 * KONTROLA KONTROLI (AC5): odtwarza topologię STAREJ MAPY — stan PER INSTANCJA.
 *
 * Zwraca DWIE niezależne bariery zamiast jednej współdzielonej, czyli dokładnie
 * to, co miał proces z `idempotencyCache`: każda instancja pamięta wyłącznie
 * własne wysyłki. Test cross-instance, który przechodzi także na tej topologii,
 * NIE mierzy cross-instance i jest do przepisania. Ta funkcja istnieje po to,
 * żeby ta kontrola była WYKONANA, a nie przemyślana.
 */
export function perInstanceBarriers(): [SharedDispatchBarrier, SharedDispatchBarrier] {
  return [new SharedDispatchBarrier(), new SharedDispatchBarrier()];
}
