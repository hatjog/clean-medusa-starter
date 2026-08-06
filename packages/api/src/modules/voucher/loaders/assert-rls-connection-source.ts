/**
 * voucher/loaders/assert-rls-connection-source.ts
 *
 * v1.15.0 Story 2.6 cykl 1, finding MEDIUM: „założenie, że kontener modułu Medusy
 * niesie `PG_CONNECTION`, nie zostało zweryfikowane niczym poza kontenerem
 * zbudowanym ręcznie w teście".
 *
 * Suita integracyjna buduje kontener sama (`{ [PG_CONNECTION]: db }`), więc nie
 * mierzy tego, co jest tu naprawdę ryzykowne: czy kontener modułu `voucher`
 * w REALNYM boocie Medusy 2 w ogóle niesie `__pg_connection__`. Bez tego loadera
 * odpowiedź na to pytanie padała dopiero przy PIERWSZYM wywołaniu modułu — czyli
 * w środku ścieżki pieniądza, na żądaniu klienta.
 *
 * Ten loader przenosi ten sam werdykt na BOOT: rozwiązuje źródło połączeń tą samą
 * funkcją, której używa serwis, i rzuca, jeśli kontener go nie niesie. Bramka,
 * która sprawdza obecność pliku, nie mierzy nic — ta PĘKA dokładnie wtedy, gdy
 * mechanizm przestaje działać, i to zanim wpuścimy na niego ruch.
 *
 * Świadomie NIE wykonuje zapytania: `up` bazy jest domeną migracji i healthchecka,
 * a boot nie ma prawa zależeć od stanu danych.
 */

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { resolveRlsConnectionSource } from "../../../lib/rls-connection-source"

type LoaderArgs = {
  container?: Record<string, unknown>
}

export default async function assertRlsConnectionSourceLoader(
  args?: LoaderArgs | Record<string, unknown>,
): Promise<void> {
  // Medusa 2 podaje loaderom `{ container, options, … }`; przyjmujemy luźno,
  // bo część ścieżek testowych woła loader z samym kontenerem.
  const container =
    (args as LoaderArgs | undefined)?.container ??
    (args as Record<string, unknown> | undefined)

  if (!container) {
    throw new Error(
      "[voucher/assert-rls-connection-source] loader nie dostał kontenera — " +
        "nie da się orzec, czy moduł ma połączenie, na którym hook RLS ustawi " +
        "kontekst rynku (v1.15.0 Story 2.6, AD-21 §4)",
    )
  }

  // Rzuca `RlsConnectionSourceError` z nazwanym kodem, gdy kontener nie niesie
  // puli Medusy. Fail-loud na boocie zamiast ciszy na pierwszym `redeem`.
  resolveRlsConnectionSource(container, ContainerRegistrationKeys.PG_CONNECTION)
}
