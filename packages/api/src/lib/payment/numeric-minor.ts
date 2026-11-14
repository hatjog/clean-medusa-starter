/**
 * v1.16.0 Story 3.5 (FR-13, ADR-166, NFR-2, DW-15-134) — kwoty minor z kolumn
 * NUMERIC bez pośredniego `float`.
 *
 * node-pg zwraca NUMERIC jako STRING (np. `"25000.00"`). Wcześniejsza
 * konwersja `Number(r.amount)` przepuszczała wartość przez double — dla
 * wartości powyżej `Number.MAX_SAFE_INTEGER` (`"9007199254740993"`) dawała
 * CICHO inną liczbę. Tutaj wartość zostaje łańcuchem aż do granicy, na której
 * kontrakt wymaga liczby (koperta `envelope.v1`, snapshot polityki), a
 * zamiana na liczbę jest dokładna (BigInt) albo jest odmową (`null`).
 *
 * Jednostka: GP przechowuje kwoty w jednostkach MINOR (grosze) —
 * `modules/payment-stripe-multi-market/amount-normalization.ts`,
 * `specs/domains/commerce/README.md`. Żadnego mnożnika tu nie ma.
 */

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/

/**
 * Normalizuje wartość kolumny NUMERIC (string z node-pg albo liczba z mocka)
 * do łańcucha dziesiętnego. Nieczytelna wartość ⇒ `null` (fail-closed
 * u wołającego, C2-L-3), nigdy `0`.
 */
export function readNumericMinorString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return NUMERIC_STRING.test(trimmed) ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null
    const text = String(value)
    return NUMERIC_STRING.test(text) ? text : null
  }
  return null
}

/**
 * Dokładna zamiana łańcucha NUMERIC na całkowitą kwotę minor. Część ułamkowa
 * jest obcinana w dół do grosza (jednostka minor nie niesie mniejszej
 * precyzji) operacją na łańcuchu, nie na float. Wartość spoza
 * bezpiecznego zakresu liczb całkowitych ⇒ `null` — taka kwota nie
 * przeżyłaby zapisu jako `number` bez utraty cyfr.
 */
export function numericMinorStringToSafeInteger(
  value: string | null | undefined
): number | null {
  if (typeof value !== "string" || !NUMERIC_STRING.test(value)) return null
  const integerPart = value.split(".")[0]
  const big = BigInt(integerPart)
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (big > max || big < -max) return null
  const result = Number(big)
  return Object.is(result, -0) ? 0 : result
}

/** Skrót: wartość z bazy (NUMERIC) → całkowita kwota minor albo `null`. */
export function readDatabaseMinorInteger(value: unknown): number | null {
  return numericMinorStringToSafeInteger(readNumericMinorString(value))
}

/**
 * Wariant ŚCISŁY: część ułamkowa musi być zerowa (`"12345.00"` → 12345,
 * `"123.45"` → `null`). Dla cen linii, gdzie ułamek grosza jest anomalią
 * danych, a nie zaokrągleniem.
 */
export function readDatabaseMinorIntegerStrict(value: unknown): number | null {
  const text = readNumericMinorString(value)
  if (text === null) return null
  const fraction = text.split(".")[1]
  if (fraction !== undefined && /[^0]/.test(fraction)) return null
  return numericMinorStringToSafeInteger(text)
}
