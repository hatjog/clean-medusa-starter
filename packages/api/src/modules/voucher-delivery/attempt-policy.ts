/**
 * attempt-policy.ts — POLITYKA prób dostawy vouchera (Story 4.4, FR-9e, AD-23).
 *
 * AD-23 mówi: „numer próby nadaje polityka, nie wywołujący". Do Story 4.4 to
 * zdanie było prawdziwe tylko w połowie:
 *
 *   - NUMER próby był (i zostaje) własnością ledgera: inkrement dzieje się
 *     wyłącznie w warunkowym `UPDATE … SET attempt_count = attempt_count + 1
 *     WHERE status IN (…)` w `dispatch-ledger.ts`. Wywołujący nie podaje go
 *     i — od 4.4 — nie może podać nawet przez pomyłkę (`assertNoCallerAttemptNumber`).
 *   - BUDŻET prób był stałą WYWOŁUJĄCEGO (`SWEEP_MAX_ATTEMPT_COUNT` w pliku
 *     joba) wstrzykiwaną do ledgera w sześciu miejscach. Drugi wywołujący
 *     z innym progiem odparkowywał wiersze pierwszego i nikt tego nie widział:
 *     `assertMaxAttemptCount` waliduje KSZTAŁT liczby, nie jej prawo do bycia
 *     polityką.
 *
 * Ten moduł jest JEDYNYM nośnikiem budżetu na ścieżce produkcyjnej. Parametr
 * `max_attempt_count` zostaje w sygnaturach portu ledgera (testy muszą móc
 * ustawić próg 1 albo 2 bez pięciu przebiegów), ale kod produkcyjny nie ma
 * drugiego źródła wartości — pilnuje tego test wiążący
 * `voucher-delivery-attempt-policy.unit.spec.ts`, który czyta ŹRÓDŁO joba
 * i pęka, gdy pojawi się w nim drugi próg.
 *
 * Dlaczego moduł `voucher-delivery`, a nie nośnik konfiguracyjny: budżet
 * egzekwuje ledger (predykat `listParkedDispatches`, guard skanu), a ledger
 * mieszka tutaj. Próg per rynek nie jest dziś potrzebny i wprowadzałby stan,
 * w którym „wyczerpanie polityki" (FR-9g / Story 4.6) nie ma jednego znaczenia.
 */

/** Budżet prób dostawy — JEDEN nośnik dla całej domeny (AD-23). */
export const VOUCHER_DELIVERY_ATTEMPT_POLICY = Object.freeze({
  /**
   * Ile prób wysyłki przysługuje JEDNEMU WIERSZOWI dostawy (nie entitlementowi
   * — od Story 4.4 jednostką ponawiania jest wiersz, FR-9e). Po wyczerpaniu
   * wiersz jest ZAPARKOWANY: nie wraca ze skanu i wymaga decyzji operatora.
   */
  max_attempt_count: 5,
  /**
   * Ile razy automat może zwrócić budżet po awarii GLOBALNEJ (kill-switch,
   * brak szablonu locale, brak klucza providera). Trwała granica: konfiguracja,
   * której operator nie naprawi, nie uruchamia tego samego wiersza bez końca.
   * Wartość przeniesiona 1:1 ze `SWEEP_MAX_CONFIGURATION_RECOVERIES` — 4.4
   * przenosi NOŚNIK, nie zmienia progu.
   */
  max_configuration_recoveries: 1,
} as const)

/** Skrót na najczęściej czytane pole polityki. */
export const VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT =
  VOUCHER_DELIVERY_ATTEMPT_POLICY.max_attempt_count

/** Skrót na trwałą granicę zwrotów budżetu po awarii konfiguracji. */
export const VOUCHER_DELIVERY_MAX_CONFIGURATION_RECOVERIES =
  VOUCHER_DELIVERY_ATTEMPT_POLICY.max_configuration_recoveries

/**
 * Pola, których wywołujący NIE MOŻE podać przy rezerwacji wysyłki (AD-23).
 *
 * TypeScript odrzuca je już przy kompilacji (`ReserveDispatchInput` ich nie ma),
 * ale wejście bywa budowane dynamicznie — z payloadu webhooka (4.2/4.3), z mapy
 * albo przez `as`. Cicho zignorowany `attempt_no` w takim wejściu jest gorszy
 * niż błąd: wygląda jak skuteczne nadanie numeru przez wywołującego.
 */
export const CALLER_FORBIDDEN_ATTEMPT_FIELDS = Object.freeze([
  "attempt_count",
  "attempt_no",
] as const)
