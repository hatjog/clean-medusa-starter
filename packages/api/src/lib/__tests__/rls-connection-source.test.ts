/**
 * rls-connection-source — ścieżka TRANSAKCYJNA (`connect()`).
 *
 * v1.15.0 Story 2.6 cykl 1, finding MEDIUM: suita integracyjna używała wyłącznie
 * `source.query()`, więc `connect()` — czyli droga, którą chodzi `claim()`, czyli
 * REALIZACJA vouchera — nie była pokryta żadnym testem. Argumentacja w komentarzu
 * nie jest pomiarem; te testy PĘKAJĄ po zepsuciu każdego z trzech zachowań:
 *
 *   1. całą transakcję obsługuje JEDNO połączenie wzięte raz (`BEGIN` i `COMMIT`
 *      na dwóch różnych połączeniach rozsypałyby transakcję),
 *   2. `release()` oddaje połączenie do puli i jest IDEMPOTENTNE,
 *   3. `release(err)` NISZCZY połączenie zamiast oddać je do puli.
 */
import {
  createRlsConnectionSource,
  RlsConnectionSourceError,
  resolveRlsConnectionSource,
} from "../rls-connection-source"

type FakeConnection = {
  id: number
  statements: string[]
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

function makeFakeKnex(opts: { withDestroy?: boolean } = {}) {
  let nextId = 1
  const acquired: FakeConnection[] = []
  const released: FakeConnection[] = []
  const destroyed: FakeConnection[] = []

  const client: Record<string, unknown> = {
    acquireConnection: async (): Promise<FakeConnection> => {
      const connection: FakeConnection = {
        id: nextId++,
        statements: [],
        query: async (sql: string) => {
          connection.statements.push(sql)
          return { rows: [], rowCount: 0 }
        },
      }
      acquired.push(connection)
      return connection
    },
    releaseConnection: async (connection: FakeConnection): Promise<void> => {
      released.push(connection)
    },
  }
  if (opts.withDestroy !== false) {
    client.destroyRawConnection = async (connection: FakeConnection): Promise<void> => {
      destroyed.push(connection)
    }
  }

  return { pgConnection: { client } as never, acquired, released, destroyed }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("rls-connection-source — ścieżka transakcyjna", () => {
  it("trzyma JEDNO połączenie przez BEGIN…COMMIT", async () => {
    const knex = makeFakeKnex()
    const source = createRlsConnectionSource(knex.pgConnection)

    const client = await source.connect()
    await client.query("BEGIN")
    await client.query("UPDATE voucher SET status = 'claimed'")
    await client.query("COMMIT")
    client.release()
    await flush()

    expect(knex.acquired).toHaveLength(1)
    expect(knex.acquired[0].statements).toEqual([
      "BEGIN",
      "UPDATE voucher SET status = 'claimed'",
      "COMMIT",
    ])
    expect(knex.released).toEqual([knex.acquired[0]])
  })

  it("release() jest idempotentne — drugie wywołanie nic nie oddaje", async () => {
    const knex = makeFakeKnex()
    const source = createRlsConnectionSource(knex.pgConnection)

    const client = await source.connect()
    client.release()
    client.release()
    await flush()

    expect(knex.released).toHaveLength(1)
  })

  it("release(err) NISZCZY połączenie zamiast oddać je do puli", async () => {
    const knex = makeFakeKnex()
    const source = createRlsConnectionSource(knex.pgConnection)

    const client = await source.connect()
    await client.query("BEGIN")
    client.release(new Error("ROLLBACK nie przeszedł"))
    await flush()

    expect(knex.destroyed).toEqual([knex.acquired[0]])
    expect(knex.released).toHaveLength(0)
  })

  it("bez destroyRawConnection release(err) degraduje do zwykłego zwolnienia", async () => {
    const knex = makeFakeKnex({ withDestroy: false })
    const source = createRlsConnectionSource(knex.pgConnection)

    const client = await source.connect()
    client.release(new Error("boom"))
    await flush()

    expect(knex.released).toEqual([knex.acquired[0]])
  })

  it("query() bierze i ODDAJE połączenie przy każdym wywołaniu", async () => {
    const knex = makeFakeKnex()
    const source = createRlsConnectionSource(knex.pgConnection)

    await source.query("SELECT 1")
    await source.query("SELECT 2")

    expect(knex.acquired).toHaveLength(2)
    expect(knex.released).toHaveLength(2)
  })

  it("kontener bez PG_CONNECTION jest ODMOWĄ, nie cichą degradacją", () => {
    expect(() => resolveRlsConnectionSource({}, "__pg_connection__")).toThrow(
      RlsConnectionSourceError,
    )
  })
})
