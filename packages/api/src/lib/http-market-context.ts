/**
 * http-market-context — kontekst rynku dla tras HTTP POZA `/store/*`
 * (v1.15.0 Story 2.6 cykl 1, findings HIGH #1 i HIGH #2; FR-14e, AD-21 §4, AD-22).
 *
 * ── Luka, którą ten moduł zamyka ────────────────────────────────────────────
 * Enumeracja powierzchni wykonania dzieliła świat na DWIE kategorie: `/store/*`
 * (łańcuch `marketContextMiddleware`) i „poza HTTP" (`system-market-context.ts`
 * — subscriber / workflow / job). Między te dwie kategorie wpadły trasy HTTP
 * poza `/store/*`: `/vendor/*` i `/v1/admin/*`. To NIE jest teoretyczna dziura —
 * realizacja vouchera (`POST /vendor/vouchers/:code/redeem`) i wyszukiwanie
 * uprawnień (`GET /v1/admin/entitlements`) chodzą właśnie tamtędy. Po włączeniu
 * `FORCE ROW LEVEL SECURITY` na tabelach modułu voucher połączenie bez
 * `app.gp_market_id` widzi ZERO wierszy, więc obie trasy przestałyby działać.
 *
 * ── Kontrakt (AD-21 §4: „nośnik jest JEDEN") ────────────────────────────────
 * Ten plik NIE jest drugim nośnikiem. Używa TEJ SAMEJ `marketContextStorage`,
 * tego samego kształtu kontekstu i tego samego hooka RLS co `/store/*`.
 * Dokłada wyłącznie dwie rzeczy, których tamten łańcuch nie ma:
 *   1. rozwiązanie rynku ze ŹRÓDŁA właściwego dla trasy nie-store (rynek
 *      sprzedawcy dla `/vendor/*`, roster rynków dla cross-market admina),
 *   2. ODMOWĘ, gdy rynku nie da się rozwiązać — bo wykonanie bez kontekstu
 *      pod FORCE RLS jest ciszą („brak wyników"), a nie błędem.
 *
 * ── Dlaczego cross-market jest ROZWIJANY per rynek ──────────────────────────
 * Zmienna sesji niesie DOKŁADNIE JEDEN rynek — tak działa hook i tak wyglądają
 * polityki; „wszystkie rynki naraz" wymagałoby rozluźnienia RLS do listy.
 * Udokumentowana funkcja super-admina z v1.11.0 („znajdź ten voucher we
 * wszystkich rynkach") jest więc realizowana jako N przebiegów po WYLICZONYM
 * rosterze, a nie jako jeden przebieg bez izolacji.
 *
 * @module lib/http-market-context
 */

import type { Knex } from "knex"

import { marketContextStorage, type MarketContext } from "./market-context"

/** Ten sam kształt identyfikatora, który przyjmuje hook RLS. */
const SAFE_MARKET_ID_RE = /^[a-zA-Z0-9_-]+$/

/** Kod błędu odmowy — wypisany W KODZIE, nie w prozie. */
export const HTTP_MARKET_CONTEXT_DENIED = "GP_HTTP_MARKET_CONTEXT_DENIED"

export class HttpMarketContextError extends Error {
  readonly error_code = HTTP_MARKET_CONTEXT_DENIED

  constructor(message: string) {
    super(message)
    this.name = "HttpMarketContextError"
  }
}

/**
 * Uruchom pracę trasy HTTP w kontekście JEDNEGO rynku. Identyfikator, którego
 * hook RLS by nie przyjął, jest ODMOWĄ — nie cichym pominięciem `set_config`.
 */
export async function runInHttpMarketContext<T>(
  marketId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (typeof marketId !== "string" || !SAFE_MARKET_ID_RE.test(marketId)) {
    throw new HttpMarketContextError(
      `identyfikator rynku '${String(marketId)}' nie ma kształtu, który ` +
        "przyjmuje hook RLS — kontekst zostałby po cichu zignorowany, " +
        "a zapytanie poszłoby połączeniem bez izolacji (AD-21 §4)",
    )
  }

  const context: MarketContext = { market_id: marketId }
  return marketContextStorage.run(context, work)
}

/**
 * Rynek sprzedawcy uwierzytelnionego na trasie `/vendor/*`.
 *
 * Źródłem jest `seller.metadata->'gp'->>'market_id'` — ta sama droga, którą
 * czyta `review-market-scope.ts`. Brak wartości jest ODMOWĄ: sprzedawca bez
 * rynku pod FORCE RLS i tak nie zobaczyłby żadnego wiersza, a cicha pustka
 * wygląda w panelu jak „voucher nie istnieje".
 */
export async function resolveSellerMarketId(
  db: Knex,
  sellerId: string,
): Promise<string> {
  const row = await db("seller")
    .select(db.raw("metadata->'gp'->>'market_id' as market_id"))
    .where("id", sellerId)
    .first<{ market_id?: string | null } | undefined>()

  const marketId = row?.market_id ?? null
  if (!marketId) {
    throw new HttpMarketContextError(
      `sprzedawca '${sellerId}' nie ma zadeklarowanego rynku ` +
        "(`seller.metadata->'gp'->>'market_id'`) — bez rynku trasa vendora " +
        "wykonałaby się poza izolacją albo po cichu nie zobaczyła nic",
    )
  }
  return marketId
}

/**
 * Wyliczony roster rynków — źródło dla cross-market czytania super-admina.
 *
 * `market_runtime_config` jest instancją konfiguracji rynków w bazie
 * (`gp-config-sync-market-runtime`). Rozwinięcie po tym rosterze NIE jest
 * dorozumianiem zakresu w rozumieniu AD-21 §2: tam chodzi o wykonanie
 * ASYNCHRONICZNE, które samo dobiera sobie zakres. Tutaj zakres wybiera
 * uwierzytelniony super-admin jawnym `allow_cross_market`, a lista jest
 * WYLICZONA i zwrócona wywołującemu, więc da się po fakcie orzec, co objęła.
 * Pusty roster jest ODMOWĄ, nie „wszystkimi rynkami".
 */
export async function listConfiguredMarketIds(db: Knex): Promise<string[]> {
  const rows = await db("market_runtime_config")
    .distinct<Array<{ market_id: string }>>("market_id")
    .orderBy("market_id", "asc")

  const marketIds = rows
    .map((row) => row.market_id)
    .filter((id): id is string => typeof id === "string" && SAFE_MARKET_ID_RE.test(id))

  if (marketIds.length === 0) {
    throw new HttpMarketContextError(
      "roster rynków (`market_runtime_config`) jest pusty — pusta lista nie " +
        "jest deklaracją zakresu, jest odmową (AD-21 §2)",
    )
  }
  return marketIds
}
