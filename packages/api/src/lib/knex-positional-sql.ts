/**
 * knex-positional-sql.ts — konwersja placeholderów `$1..$N` (dialekt sterownika
 * `pg`) na `?` (dialekt Knexa), wraz z twardymi guardami na kształty, które Knex
 * cicho przekłamuje.
 *
 * ── Po co to istnieje ───────────────────────────────────────────────────────
 * `ContainerRegistrationKeys.PG_CONNECTION` z kontenera Medusy to **instancja
 * Knexa**, a nie klient `pg` (repo casuje ten klucz `as Knex` w kilkunastu
 * miejscach, m.in. `api/store/wishlist/route.ts`). Formatter Knexa liczy
 * WYŁĄCZNIE `?`/`??` i przy `$N` rzuca `Expected N bindings, saw 0` — czyli
 * zapytanie nie dochodzi nawet do bazy.
 *
 * Rozróżnienie `__pg_pool__` (składnia `$N`) vs `PG_CONNECTION` (składnia `?`)
 * jest w repo zastane i udokumentowane — patrz `withClaimTransaction`
 * (`api/store/vouchers/[code]/claim/helpers.ts`), które robi dokładnie tę samą
 * konwersję inline. Ten moduł jest jej wyciągnięciem do jednego miejsca, żeby
 * kolejny konsument nie musiał jej odkrywać (albo pominąć) po raz trzeci.
 *
 * ── Guardy (dlaczego rzucamy, zamiast „naprawiać") ──────────────────────────
 *  1. **Tablica w bindingach** — Knex `parameterize()` rozwija tablicę w listę
 *     `?, ?, ?`, więc `ANY(?)` z tablicą daje niepoprawny SQL, a licznik
 *     bindingów przestaje się zgadzać. Wołający MUSI rozwinąć listę na jawne
 *     placeholdery (`IN ($6, $7)`). Cichy przekład byłby gorszy niż błąd.
 *  2. **Surowe `?` w SQL-u wejściowym** — mieszanie obu dialektów przesuwa
 *     numerację; nie zgadujemy intencji.
 *  3. **Indeks spoza zakresu `values`** — literówka w `$7` przy 6 wartościach
 *     musi być błędem programisty, nie `undefined` wstawionym do bazy.
 */

export class SqlDialectError extends Error {
  readonly error_code: string

  constructor(message: string) {
    super(message)
    this.name = "SqlDialectError"
    this.error_code = "SQL_DIALECT_INVALID_BINDINGS"
  }
}

export interface KnexPositionalSql {
  /** SQL z placeholderami `?` — gotowy dla `knex.raw`. */
  text: string
  /** Wartości w kolejności wystąpień `?` (powtórzone `$N` = powtórzona wartość). */
  bindings: unknown[]
}

/**
 * Zamienia `$N` na `?` i buduje listę bindingów w kolejności WYSTĄPIEŃ, a nie
 * w kolejności numerów — dzięki temu `VALUES ($8, $8, $8)` (ten sam znacznik
 * czasu w trzech kolumnach) jest poprawnie rozwinięty na trzy `?`.
 */
export function toKnexPositionalSql(
  sql: string,
  values: readonly unknown[] = [],
): KnexPositionalSql {
  if (sql.includes("?")) {
    throw new SqlDialectError(
      "SQL łączy dialekty: zawiera już `?`, a jest konwertowany z `$N`. " +
        "Zapytania w tym module pisze się WYŁĄCZNIE w składni `$N`.",
    )
  }

  const bindings: unknown[] = []
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index)
    if (!Number.isInteger(position) || position < 1 || position > values.length) {
      throw new SqlDialectError(
        `Placeholder $${index} nie ma odpowiadającej wartości ` +
          `(przekazano ${values.length} wartości).`,
      )
    }
    const value = values[position - 1]
    if (Array.isArray(value)) {
      throw new SqlDialectError(
        `Binding $${index} jest tablicą — Knex rozwija tablicę w listę \`?, ?\`, ` +
          "co psuje zarówno SQL, jak i licznik bindingów. Rozwiń listę na jawne " +
          "placeholdery po stronie wołającego.",
      )
    }
    bindings.push(value)
    return "?"
  })

  return { text, bindings }
}
