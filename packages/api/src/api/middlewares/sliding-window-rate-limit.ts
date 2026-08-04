/**
 * sliding-window-rate-limit.ts — JEDEN mechanizm okna licznika dla wszystkich
 * bramek rate-limitu w tym repo.
 *
 * ── Dlaczego wspólny moduł, a nie druga kopia ───────────────────────────────
 * Rate-limiting żył dotąd wyłącznie w `brevo-hmac-validator.ts`, wpleciony w
 * logikę HMAC, audytu i circuit-breakera Brevo. Decyzja PO (2026-08-01) przy
 * limicie dla `payment-status` brzmi wprost: „reuse istniejącego wzorca; NIE
 * tworzymy nowej warstwy ani drugiego mechanizmu".
 *
 * Skopiowanie pętli okna do drugiego pliku spełniałoby literę („ta sama
 * warstwa"), ale nie treść: dwie kopie rozjeżdżają się przy pierwszej korekcie
 * i tylko jedna dostaje test. Dlatego MECHANIZM (okno, licznik, prune, zegar
 * testowy) mieszka tutaj, a POLITYKA (pojemności, klucze, kształt odmowy)
 * zostaje przy każdej bramce.
 *
 * ── Świadome ograniczenie: pamięć procesu ───────────────────────────────────
 * Licznik jest procesowy, tak samo jak w bramce Brevo. Przy wielu instancjach
 * backendu efektywna pojemność mnoży się przez liczbę procesów. Dla trasy
 * odczytowej z identyfikatorem ULID to akceptowalne — celem jest zdławienie
 * zgadywania, nie precyzyjna kwota. Licznik współdzielony (Redis) byłby osobną
 * decyzją architektoniczną, nie efektem ubocznym tej bramki.
 */

export type RateLimitWindow = {
  windowStartMs: number
  count: number
}

export type RateLimitBucket = {
  /** Klucz licznika — już zhashowany/znormalizowany przez wołającego. */
  key: string
  /** Ile żądań mieści się w oknie. */
  capacity: number
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; exceededKey: string; retryAfterSeconds: number }

/**
 * Rejestr okien jednej bramki. Osobna instancja per bramka, żeby klucze dwóch
 * różnych polityk nigdy nie mogły na siebie wpłynąć.
 */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>()
  private clock: () => number = () => Date.now()

  constructor(
    private readonly windowMs: number,
    /** Powyżej tylu wpisów przycinamy wygasłe okna — ochrona przed wzrostem mapy. */
    private readonly pruneMaxEntries = 1_000,
  ) {}

  /**
   * Sprawdza WSZYSTKIE koszyki i inkrementuje je TYLKO wtedy, gdy każdy się
   * mieści. Częściowa inkrementacja przy odrzuceniu paliłaby budżet koszyka,
   * który limitu nie przekroczył.
   *
   * Kolejność sprawdzania jest zachowana, więc `exceededKey` mówi, KTÓRY limit
   * zadziałał — bez tego odmowa jest nieodróżnialna od drugiej odmowy i nie da
   * się jej zdiagnozować z logu.
   */
  consume(buckets: readonly RateLimitBucket[]): RateLimitDecision {
    const now = this.clock()

    for (const bucket of buckets) {
      const window = this.takeWindow(bucket.key, now)
      if (window.count >= bucket.capacity) {
        const elapsed = now - window.windowStartMs
        const remainingMs = Math.max(0, this.windowMs - elapsed)
        return {
          allowed: false,
          exceededKey: bucket.key,
          retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        }
      }
    }

    for (const bucket of buckets) {
      const window = this.takeWindow(bucket.key, now)
      window.count += 1
      this.windows.set(bucket.key, window)
    }

    this.prune(now)
    return { allowed: true }
  }

  /** Test-only: zegar wstrzykiwany, żeby okno dało się przewinąć bez `sleep`. */
  setClockForTests(nextClock: () => number): void {
    this.assertTestEnvironment("setClockForTests")
    this.clock = nextClock
  }

  /** Test-only: czyści stan między przypadkami. */
  resetForTests(): void {
    this.assertTestEnvironment("resetForTests")
    this.windows.clear()
    this.clock = () => Date.now()
  }

  private assertTestEnvironment(name: string): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error(
        `[sliding-window-rate-limit] ${name} is test-only; refusing to run outside NODE_ENV=test`,
      )
    }
  }

  private takeWindow(key: string, now: number): RateLimitWindow {
    const existing = this.windows.get(key)
    if (!existing || now - existing.windowStartMs >= this.windowMs) {
      const fresh: RateLimitWindow = { windowStartMs: now, count: 0 }
      this.windows.set(key, fresh)
      return fresh
    }
    return existing
  }

  private prune(now: number): void {
    if (this.windows.size <= this.pruneMaxEntries) return
    for (const [key, window] of this.windows) {
      if (now - window.windowStartMs >= this.windowMs) {
        this.windows.delete(key)
      }
    }
  }
}
