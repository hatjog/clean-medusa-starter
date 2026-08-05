/**
 * v1.15.0 Story 5.3 — retencja tabeli `vendor_replay_guard` ma NOŚNIK
 * (review cyklu 1, MEDIUM-3), a ten nośnik KONSUMUJE nośnik kontekstu rynku
 * (review cyklu 2, bramka `validate_system_market_context_adoption.py`;
 * AD-21, ADR-177, FR-14d).
 *
 * Ta suita pilnuje — w tej kolejności ważności:
 *  1. KONTROLA DODATNIA: z zadeklarowanym rynkiem `DELETE` REALNIE leci, raz na
 *     każdy zadeklarowany rynek, i jest ZAWĘŻONY do tego rynku,
 *  2. KONTROLA NEGATYWNA: bez deklaracji rynku nie leci ŻADNA wysyłka do bazy,
 *     a odmowa jest GŁOŚNA (wyjątek nośnika + log + metryka, NFR-2),
 *  3. KONTROLA KONTROLI: obejście joba (wywołanie samej funkcji zapisu poza
 *     kontekstem) też jest odmową — gdyby ktoś zdjął `requireMarketContext`
 *     z `purgeExpiredReplayGuardRows`, ten test PĘKA,
 *  4. job jest ODKRYWALNY dla Medusy (`src/jobs/`, `config.name`/`schedule`),
 *  5. awaria sprzątania NIE wywraca schedulera — bo to higiena, nie poprawność.
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, it, expect } from "@jest/globals"

import { marketContextStorage } from "../../lib/market-context"
import {
  getSystemMarketContextDenials,
  SystemMarketContextError,
  SYSTEM_MARKET_CONTEXT_DENIED_METRIC,
  _resetSystemMarketContextMetrics,
} from "../../lib/system-market-context"
import {
  purgeExpiredReplayGuardRows,
  REPLAY_GUARD_SELLER_MARKET_EXPR,
  VENDOR_REPLAY_GUARD_TABLE,
} from "../../lib/vendor-replay-guard"
import vendorReplayGuardPurge, {
  MARKETS_ENV_VAR,
  readDeclaredMarkets,
  SCHEDULE_CRON,
  SCHEDULE_NAME,
  config,
} from "../../jobs/vendor-replay-guard-purge"

type Call = { sql: string; bindings: readonly unknown[] }

function containerWith(raw: (sql: string, bindings?: readonly unknown[]) => Promise<unknown>) {
  const logged: string[] = []
  return {
    logged,
    container: {
      resolve: (key: string) => {
        if (key === "__pg_connection__") {
          return { raw }
        }
        if (key === "logger") {
          return {
            info: (m: string) => logged.push(`info ${m}`),
            warn: (m: string) => logged.push(`warn ${m}`),
            error: (m: string) => logged.push(`error ${m}`),
          }
        }
        return null
      },
    } as never,
  }
}

function recordingContainer(rowCount = 3) {
  const calls: Call[] = []
  const { container, logged } = containerWith(async (sql, bindings = []) => {
    calls.push({ sql, bindings })
    return { rowCount }
  })
  return { calls, container, logged }
}

describe("vendor-replay-guard-purge — nośnik zobowiązania retencyjnego (AC3)", () => {
  const envBackup = process.env[MARKETS_ENV_VAR]

  beforeEach(() => {
    _resetSystemMarketContextMetrics()
    delete process.env[MARKETS_ENV_VAR]
  })

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env[MARKETS_ENV_VAR]
    } else {
      process.env[MARKETS_ENV_VAR] = envBackup
    }
  })

  describe("KONTROLA DODATNIA — zapis z zadeklarowanym rynkiem PRZECHODZI (AD-21)", () => {
    it("REALNIE wysyła DELETE na tabelę bariery, RAZ NA KAŻDY zadeklarowany rynek", async () => {
      process.env[MARKETS_ENV_VAR] = "bonbeauty, testmarketb"
      const { calls, container, logged } = recordingContainer(3)

      await vendorReplayGuardPurge(container)

      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.sql.trim().toUpperCase().startsWith("DELETE")).toBe(true)
        expect(call.sql).toContain(VENDOR_REPLAY_GUARD_TABLE)
      }
      // Rynek jest BINDINGIEM stwierdzenia, a nie tylko wpisem w logu —
      // inaczej „deklaracja" nie zawężałaby niczego.
      expect(calls[0].bindings[1]).toBe("bonbeauty")
      expect(calls[1].bindings[1]).toBe("testmarketb")
      expect(logged).toContain("info market=bonbeauty deleted_expired_rows=3")
      expect(logged).toContain("info market=testmarketb deleted_expired_rows=3")
      expect(getSystemMarketContextDenials()).toBe(0)
    })

    it("stwierdzenie jest ZAWĘŻONE do rynku — atrybucja idzie po sprzedawcy", async () => {
      process.env[MARKETS_ENV_VAR] = "bonbeauty"
      const { calls, container } = recordingContainer(0)

      await vendorReplayGuardPurge(container)

      // Bez tego członu `DELETE` skasowałby wiersze WSZYSTKICH rynków, mimo że
      // wykonanie deklaruje jeden — czyli deklaracja byłaby ozdobą.
      expect(calls[0].sql).toContain("seller_id IN")
      expect(calls[0].sql).toContain(REPLAY_GUARD_SELLER_MARKET_EXPR)
      // Semantyka tego zawężenia (który wiersz ginie, a który zostaje) jest
      // mierzona na REALNYM Postgresie:
      // `__tests__/integration/vendor-replay-guard-pg.integration.test.ts`.
    })
  })

  describe("KONTROLA NEGATYWNA — zapis bez kontekstu jest ODMOWĄ (AD-21, NFR-2)", () => {
    it("brak zmiennej: ZERO wysyłek do bazy, metryka `markets_not_declared`, log z kodem", async () => {
      const { calls, container, logged } = recordingContainer()

      await expect(vendorReplayGuardPurge(container)).resolves.toBeUndefined()

      // Najważniejsza asercja tej suity: nic nie zostało skasowane.
      expect(calls).toHaveLength(0)
      expect(
        getSystemMarketContextDenials({ reason: "markets_not_declared", surface: "job" })
      ).toBe(1)
      expect(logged.some((l) => l.includes("GP_SYSTEM_MARKET_CONTEXT_DENIED"))).toBe(true)
      expect(logged.some((l) => l.includes(SYSTEM_MARKET_CONTEXT_DENIED_METRIC))).toBe(true)
      expect(logged.some((l) => l.startsWith("error") && l.includes(MARKETS_ENV_VAR))).toBe(
        true
      )
    })

    it("zmienna ustawiona, ale pusta: odmowa `markets_empty` — „nic” nie jest deklaracją", async () => {
      process.env[MARKETS_ENV_VAR] = " , ,"
      const { calls, container, logged } = recordingContainer()

      await expect(vendorReplayGuardPurge(container)).resolves.toBeUndefined()

      expect(calls).toHaveLength(0)
      expect(
        getSystemMarketContextDenials({ reason: "markets_empty", surface: "job" })
      ).toBe(1)
      expect(logged.some((l) => l.startsWith("error"))).toBe(true)
    })

    it("identyfikator rynku spoza kształtu hooka RLS: odmowa, nie cichy zapis", async () => {
      // Hook RLS zignorowałby taką wartość, więc „zadeklarowany rynek" byłby
      // fikcją, a `DELETE` poleciałby bez izolacji.
      process.env[MARKETS_ENV_VAR] = "bon beauty'; DROP"
      const { calls, container } = recordingContainer()

      await expect(vendorReplayGuardPurge(container)).resolves.toBeUndefined()

      expect(calls).toHaveLength(0)
      expect(
        getSystemMarketContextDenials({ reason: "market_id_invalid", surface: "job" })
      ).toBe(1)
    })

    it("odmowa nie jest jednorazowa: drugi przebieg podnosi metrykę PONOWNIE", async () => {
      const { container } = recordingContainer()

      await vendorReplayGuardPurge(container)
      await vendorReplayGuardPurge(container)

      // Licznik, który nie rośnie, nie jest pomiarem cichej degradacji.
      expect(getSystemMarketContextDenials({ surface: "job" })).toBe(2)
    })

    it("`readDeclaredMarkets` ODRÓŻNIA brak zmiennej od pustej deklaracji", () => {
      expect(readDeclaredMarkets({})).toBeUndefined()
      expect(readDeclaredMarkets({ [MARKETS_ENV_VAR]: "" })).toEqual([])
      expect(readDeclaredMarkets({ [MARKETS_ENV_VAR]: "a, b ,, c" })).toEqual(["a", "b", "c"])
    })
  })

  describe("KONTROLA KONTROLI — obejście joba też jest odmową", () => {
    it("`purgeExpiredReplayGuardRows` POZA kontekstem: rzuca PRZED wysyłką do bazy", async () => {
      const calls: Call[] = []
      const db = {
        raw: async (sql: string, bindings: readonly unknown[] = []) => {
          calls.push({ sql, bindings })
          return { rowCount: 0 }
        },
      }

      // Ten test PĘKA, gdy ktoś zdejmie `requireMarketContext` z funkcji zapisu:
      // wtedy `DELETE` poleci bez rynku i skasuje wiersze wszystkich rynków.
      await expect(purgeExpiredReplayGuardRows(db, 1_800_000_000)).rejects.toBeInstanceOf(
        SystemMarketContextError
      )
      expect(calls).toHaveLength(0)
      expect(getSystemMarketContextDenials({ reason: "context_missing" })).toBe(1)
    })

    it("ta sama funkcja W kontekście: przechodzi i niesie rynek z kontekstu", async () => {
      const calls: Call[] = []
      const db = {
        raw: async (sql: string, bindings: readonly unknown[] = []) => {
          calls.push({ sql, bindings })
          return { rowCount: 5 }
        },
      }

      const deleted = await marketContextStorage.run(
        { market_id: "bonbeauty", system: { surface: "job", name: SCHEDULE_NAME } },
        () => purgeExpiredReplayGuardRows(db, 1_800_000_000)
      )

      expect(deleted).toBe(5)
      expect(calls).toHaveLength(1)
      expect(calls[0].bindings[1]).toBe("bonbeauty")
      expect(getSystemMarketContextDenials()).toBe(0)
    })
  })

  it("jest ODKRYWALNY dla Medusy: leży w `src/jobs/` i deklaruje nazwę oraz harmonogram", () => {
    // Medusa skanuje `src/jobs/`; w tym repo to dowiązanie do
    // `packages/api/src/jobs/`. Gdyby plik wylądował gdzie indziej, job by nie
    // istniał dla runtime'u — i to jest dokładnie ten defekt, który zamykamy.
    const jobsDir = join(__dirname, "../../jobs")
    expect(existsSync(join(jobsDir, "vendor-replay-guard-purge.ts"))).toBe(true)
    expect(readdirSync(jobsDir)).toContain("vendor-replay-guard-purge.ts")

    expect(config.name).toBe(SCHEDULE_NAME)
    expect(config.schedule).toBe(SCHEDULE_CRON)
    // Harmonogram gęstszy niż okno wpisu (660 s) — zaległość nie rośnie.
    expect(SCHEDULE_CRON).toBe("*/15 * * * *")
  })

  it("brak PG_CONNECTION: loguje i kończy, NIE rzuca (higiena, nie poprawność)", async () => {
    process.env[MARKETS_ENV_VAR] = "bonbeauty"
    const logged: string[] = []
    const container = {
      resolve: (key: string) =>
        key === "logger"
          ? {
              info: (m: string) => logged.push(`info ${m}`),
              warn: (m: string) => logged.push(`warn ${m}`),
              error: (m: string) => logged.push(`error ${m}`),
            }
          : null,
    } as never

    await expect(vendorReplayGuardPurge(container)).resolves.toBeUndefined()
    expect(logged.some((l) => l.startsWith("warn"))).toBe(true)
  })

  it("błąd DELETE: loguje błąd i NIE wywraca schedulera", async () => {
    process.env[MARKETS_ENV_VAR] = "bonbeauty"
    const { container, logged } = containerWith(async () => {
      throw new Error('relation "vendor_replay_guard" does not exist')
    })

    await expect(vendorReplayGuardPurge(container)).resolves.toBeUndefined()
    expect(logged.some((l) => l.startsWith("error"))).toBe(true)
  })
})
