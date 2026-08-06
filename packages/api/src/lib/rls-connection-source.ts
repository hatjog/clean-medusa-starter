/**
 * rls-connection-source — źródło połączeń dla modułów używających surowego SQL
 * (v1.15.0 Story 2.6, AC1; FR-14e, AD-21 §4, AD-22, ADR-192).
 *
 * ── Problem, który ten moduł likwiduje ──────────────────────────────────────
 * `modules/voucher/service.ts` trzymał WŁASNĄ pulę `pg.Pool` ze
 * `connectionString` z `DATABASE_URL`. Hook RLS (`rls-pool-hook.ts`) łata pulę
 * KNEXA Medusy (`ContainerRegistrationKeys.PG_CONNECTION`), więc żadne
 * zapytanie modułu nigdy nie przeszło przez `SET ROLE medusa_store` ani przez
 * `set_config('app.gp_market_id', …)` — także te dotykające tabel, które
 * politykę RLS mają od dawna (`customer`, migracje 005/010). Izolacja nie była
 * słaba; nie było jej KOMU WŁĄCZYĆ na tym połączeniu.
 *
 * ── Kontrakt (AD-21 §4: „nośnik jest JEDEN") ────────────────────────────────
 * Ten plik NIE jest drugim nośnikiem kontekstu. Nie wykonuje `SET ROLE`, nie
 * woła `set_config` i nie zna `market_id`. Jedyne, co robi, to podaje moduł
 * przez TĘ SAMĄ pulę, którą łata `installRlsPoolHook`, zachowując kształt API
 * `pg.Pool` (`query` / `connect`), żeby powierzchnia zmiany w serwisie została
 * przy jednej metodzie zamiast trzynastu wywołań.
 *
 * ── Dlaczego `connect()` trzyma JEDNO połączenie ────────────────────────────
 * Hook ustawia kontekst na `acquireConnection` i RESETUJE go na
 * `releaseConnection`. Ścieżki transakcyjne serwisu (`BEGIN` … `COMMIT`)
 * muszą więc dostać połączenie wzięte RAZ i trzymane do końca transakcji —
 * branie połączenia z puli na każde zapytanie transakcji rozsypałoby
 * transakcję (`BEGIN` na jednym połączeniu, `UPDATE` na innym).
 *
 * @module lib/rls-connection-source
 */

import type { QueryResult, QueryResultRow } from "pg"

/** Surowe połączenie `pg` wydane przez klienta Knexa (już po łatce hooka). */
type RawConnection = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

type KnexClientLike = {
  acquireConnection: () => Promise<RawConnection>
  releaseConnection: (connection: RawConnection) => Promise<void>
  /**
   * Knex wystawia to, gdy połączenie ma zostać ZNISZCZONE, a nie oddane do puli.
   * Opcjonalne, bo `rls-pool-hook.ts` sam sobie z jego brakiem radzi.
   */
  destroyRawConnection?: (connection: RawConnection) => Promise<void>
}

/** Kształt `ContainerRegistrationKeys.PG_CONNECTION` (instancja Knexa). */
export type PgConnectionLike = {
  client?: KnexClientLike | null
}

/**
 * Odpowiednik `pg.PoolClient` w zakresie, którego używa serwis. `release()`
 * jest SYNCHRONICZNE — tak samo jak w `pg` — bo serwis woła je w blokach
 * `finally` bez `await`.
 */
export interface RlsPoolClient {
  query<R extends QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>
  release(err?: unknown): void
}

/** Odpowiednik `pg.Pool` w zakresie, którego używa serwis. */
export interface RlsConnectionSource {
  query<R extends QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>
  connect(): Promise<RlsPoolClient>
}

export type ConnectionSourceLogger = {
  error?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Kod błędu wystawiany, gdy w kontenerze nie ma puli Medusy. Wypisany
 * W KODZIE, nie w prozie: bez własnej puli jedyną alternatywą dla tego błędu
 * byłoby ciche wykonanie poza izolacją, czyli dokładnie to, co ta story usuwa.
 */
export const RLS_CONNECTION_SOURCE_UNAVAILABLE =
  "GP_RLS_CONNECTION_SOURCE_UNAVAILABLE"

export class RlsConnectionSourceError extends Error {
  readonly error_code = RLS_CONNECTION_SOURCE_UNAVAILABLE

  constructor(message: string) {
    super(message)
    this.name = "RlsConnectionSourceError"
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertKnexClient(pgConnection: unknown): KnexClientLike {
  const client = (pgConnection as PgConnectionLike | null | undefined)?.client
  if (
    !client ||
    typeof client.acquireConnection !== "function" ||
    typeof client.releaseConnection !== "function"
  ) {
    throw new RlsConnectionSourceError(
      "PG_CONNECTION nie potrafi wydać surowego połączenia PostgreSQL — " +
        "moduł nie ma nośnika, przez który hook RLS ustawia kontekst rynku " +
        "(AD-21 §4). Własna pula połączeń NIE jest tu dopuszczalnym " +
        "zamiennikiem: dawałaby wykonanie poza izolacją.",
    )
  }
  return client
}

/**
 * Zbuduj źródło połączeń nad instancją Knexa Medusy — tą samą, którą łata
 * `installRlsPoolHook`.
 */
export function createRlsConnectionSource(
  pgConnection: PgConnectionLike,
  logger?: ConnectionSourceLogger,
): RlsConnectionSource {
  const client = assertKnexClient(pgConnection)

  const wrap = (connection: RawConnection): RlsPoolClient => {
    let released = false
    return {
      async query<R extends QueryResultRow = any>(
        sql: string,
        params?: unknown[],
      ): Promise<QueryResult<R>> {
        return (await connection.query(sql, params)) as QueryResult<R>
      },
      release(err?: unknown): void {
        if (released) return
        released = true
        // Knex zwalnia asynchronicznie, `pg.PoolClient.release()` jest
        // synchroniczne. Zwolnienie jest ODPALONE tutaj, a hook sam niszczy
        // połączenie, jeśli RESET się nie powiedzie — więc brak `await`
        // nie zostawia brudnego połączenia w puli.
        //
        // v1.15.0 Story 2.6 cykl 1 (MEDIUM): argument `err` NIE jest ignorowany.
        // W `pg` `release(err)` znaczy „zniszcz to połączenie, nie oddawaj go do
        // puli" — serwis woła tak po nieudanym `ROLLBACK`. Zignorowanie argumentu
        // oddawałoby do puli połączenie w OTWARTEJ transakcji, a następny
        // wołający dostałby je z cudzym `BEGIN`.
        const finish =
          err !== undefined && typeof client.destroyRawConnection === "function"
            ? client.destroyRawConnection(connection)
            : client.releaseConnection(connection)

        void Promise.resolve(finish).catch((error: unknown) => {
          logger?.error?.("rls connection source release failed", {
            error_code: RLS_CONNECTION_SOURCE_UNAVAILABLE,
            destroyed: err !== undefined,
            error: describeError(error),
          })
        })
      },
    }
  }

  return {
    async query<R extends QueryResultRow = any>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<R>> {
      const connection = await client.acquireConnection()
      try {
        return (await connection.query(sql, params)) as QueryResult<R>
      } finally {
        await client.releaseConnection(connection)
      }
    },

    async connect(): Promise<RlsPoolClient> {
      // JEDNO połączenie na całą transakcję — patrz nagłówek modułu.
      return wrap(await client.acquireConnection())
    },
  }
}

/**
 * Rozwiąż źródło połączeń z kontenera modułu. Rzuca głośno, gdy kontener nie
 * niesie puli Medusy — cicha degradacja do własnej puli jest tu zabroniona.
 */
export function resolveRlsConnectionSource(
  container: Record<string, any> | null | undefined,
  pgConnectionKey: string,
  logger?: ConnectionSourceLogger,
): RlsConnectionSource {
  const direct = container?.[pgConnectionKey]
  if (direct) return createRlsConnectionSource(direct, logger)

  if (typeof container?.resolve === "function") {
    try {
      const resolved = container.resolve(pgConnectionKey)
      if (resolved) return createRlsConnectionSource(resolved, logger)
    } catch (error) {
      throw new RlsConnectionSourceError(
        `kontener nie potrafi rozwiązać '${pgConnectionKey}': ` +
          describeError(error),
      )
    }
  }

  throw new RlsConnectionSourceError(
    `kontener modułu nie niesie '${pgConnectionKey}' — bez puli Medusy nie ma ` +
      "połączenia, na którym hook RLS ustawi kontekst rynku (AD-21 §4)",
  )
}
