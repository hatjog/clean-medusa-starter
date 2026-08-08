/**
 * Atrapa TRWAŁEJ bariery dostawy dla testów `packages/api` — WSPÓŁDZIELONA
 * między instancjami gatewaya (v1.15.0 Story 4.1).
 *
 * Odwzorowuje semantykę stwierdzenia wykonywanego przez
 * `PgDispatchIdempotencyBarrier`: klucza nie ma → zajmujemy; klucz WYGASŁ →
 * przejmujemy; klucz żyje albo jest BEZTERMINOWY → odmowa.
 *
 * NIE JEST Postgresem. Sam SQL jest dowiedziony przebiegiem na realnej bazie:
 * `src/__tests__/integration/messaging-dispatch-barrier-pg.integration.test.ts`
 * (`pnpm test:integration:dispatch-barrier-pg`).
 *
 * Bliźniak po stronie `@gp/messaging`
 * (`packages/messaging/src/__tests__/support/shared-barrier.ts`) istnieje
 * osobno, bo pakiety nie importują nawzajem swoich katalogów testowych.
 * Rozjazd obu atrap względem prawdziwego SQL-a wychodzi w suicie na realnym
 * Postgresie, a nie w żadnej z nich.
 */
import type {
  BarrierClaim,
  BarrierClaimInput,
  BarrierSettleInput,
  DispatchIdempotencyBarrier,
  NotificationDispatch,
} from "@gp/messaging"

interface BarrierRow {
  state: "in_flight" | "settled"
  dispatch: NotificationDispatch | null
  /** `null` = BEZTERMINOWO (dostawa rozstrzygnięta jako „poszła"). */
  expires_at_ms: number | null
  /**
   * Token zajęcia — atrapa MUSI go modelować (R-4.1-M3). Gdyby go pomijała,
   * `settle`/`release` przechodziłyby tu na CUDZYM zajęciu, czyli atrapa
   * ukrywałaby dokładnie ten defekt, przed którym chroni kolumna `claim_token`.
   */
  claim_token: string
  /** Story 4.5: „który to raz TEN klucz został zajęty" — `> 1` = zajęcie PRZEJĘTE. */
  claim_count: number
}

export class SharedDispatchBarrier implements DispatchIdempotencyBarrier {
  readonly rows = new Map<string, BarrierRow>()
  /** Ile razy KTÓRAKOLWIEK instancja wysłała stwierdzenie zajęcia. */
  claims = 0

  async claim(input: BarrierClaimInput): Promise<BarrierClaim> {
    this.claims += 1
    const nowMs = input.now.getTime()
    const existing = this.rows.get(input.barrier_key)

    const reclaimable =
      existing === undefined ||
      (existing.expires_at_ms !== null && existing.expires_at_ms <= nowMs)

    if (!reclaimable) {
      return {
        outcome: "blocked",
        dispatch: existing!.state === "settled" ? existing!.dispatch : null,
        // Story 4.5 dołożyła `claim_count` do kontraktu; atrapa MUSI go
        // modelować, inaczej rozjeżdża się z portem po cichu (R-4.5-M3:
        // `tsc` był jedynym miejscem, gdzie ten rozjazd było widać).
        // `0` przy `blocked` — nic nie zajęliśmy, więc nie ma czego liczyć.
        claim_count: 0,
      }
    }

    const claimCount = (existing?.claim_count ?? 0) + 1
    this.rows.set(input.barrier_key, {
      state: "in_flight",
      dispatch: null,
      expires_at_ms: nowMs + input.in_flight_window_ms,
      claim_token: input.claim_token,
      claim_count: claimCount,
    })
    return { outcome: "claimed", dispatch: null, claim_count: claimCount }
  }

  /** Domyka WYŁĄCZNIE własne zajęcie — `WHERE … AND claim_token = $token`. */
  async settle(input: BarrierSettleInput): Promise<void> {
    const existing = this.rows.get(input.barrier_key)
    if (existing?.claim_token !== input.claim_token) {
      return
    }
    this.rows.set(input.barrier_key, {
      state: "settled",
      dispatch: input.dispatch,
      expires_at_ms: input.expires_at ? input.expires_at.getTime() : null,
      claim_token: input.claim_token,
      // `settle` NIE rusza `claim_count` — tak samo jak `UPDATE` w SQL. To jest
      // własność, na której stoi R-4.5-H1: domknięcie po odmowie zachowuje
      // sygnał „ten klucz mógł już dotknąć dostawcy".
      claim_count: existing.claim_count,
    })
  }

  /** Zwalnia WYŁĄCZNIE własne, NIEDOMKNIĘTE zajęcie (oba warunki, jak w SQL). */
  async release(input: { barrier_key: string; claim_token: string }): Promise<void> {
    const existing = this.rows.get(input.barrier_key)
    if (existing?.state !== "in_flight") {
      return
    }
    if (existing.claim_token !== input.claim_token) {
      return
    }
    this.rows.delete(input.barrier_key)
  }
}
