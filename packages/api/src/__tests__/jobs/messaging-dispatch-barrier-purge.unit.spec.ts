/**
 * v1.15.0 Story 4.1, runda fixów — NOŚNIK retencji tabeli
 * `messaging_dispatch_barrier` (R-4.1-H3).
 *
 * ── Co ta suita zamyka ─────────────────────────────────────────────────────
 * Job wchodził na falę MARTWY i nikt tego nie mierzył. Zmierzony stan przed
 * fixem: cała praca joba zależy od `MESSAGING_DISPATCH_BARRIER_PURGE_MARKETS`,
 * a ta zmienna nie istniała NIGDZIE poza własnym plikiem — ani w `.env.example`,
 * ani w `.env.template`, ani w gp-ops. Na każdym środowisku, na którym nikt jej
 * nie ustawił ręcznie, cron odpalał się codziennie o 3:17 i kasował ZERO
 * wierszy, logując odmowę. Bariera wstawia wiersz na KAŻDĄ wysyłkę, więc
 * tabela rosła liniowo i nigdy nie malała.
 *
 * Job nie miał przy tym ANI JEDNEGO testu: testowana była wyłącznie funkcja
 * biblioteczna `purgeExpiredDispatchBarrierRows`, a nie odczyt zmiennej,
 * ścieżka odmowy joba ani jego wpięcie.
 *
 * Kontrole są ułożone tak, żeby PĘKAŁY po zepsuciu mechanizmu:
 *  1. KONTROLA DODATNIA — przy poprawnej deklaracji `DELETE` REALNIE leci, raz
 *     na każdy rynek, zawężony do tego rynku;
 *  2. KONTROLA NEGATYWNA — bez deklaracji nie leci ŻADNA wysyłka do bazy,
 *     a odmowa jest głośna;
 *  3. DEKLARACJA ISTNIEJE POZA KODEM — `.env.example` niesie zmienną. Ta
 *     kontrola pęka dokładnie w tym stanie, w którym job wchodził na falę.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, it, expect } from "@jest/globals"

import { MESSAGING_DISPATCH_BARRIER_TABLE } from "@gp/messaging"

import messagingDispatchBarrierPurge, {
  MARKETS_ENV_VAR,
  readDeclaredMarkets,
  SCHEDULE_CRON,
  SCHEDULE_NAME,
  config,
} from "../../jobs/messaging-dispatch-barrier-purge"
import { marketContextStorage } from "../../lib/market-context"
import { purgeExpiredDispatchBarrierRows } from "../../lib/messaging-dispatch-barrier"
import {
  getSystemMarketContextDenials,
  SystemMarketContextError,
  _resetSystemMarketContextMetrics,
} from "../../lib/system-market-context"

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

function recordingContainer(rowCount = 4) {
  const calls: Call[] = []
  const { container, logged } = containerWith(async (sql, bindings = []) => {
    calls.push({ sql, bindings })
    return { rowCount }
  })
  return { calls, container, logged }
}

describe("messaging-dispatch-barrier-purge — nośnik retencji bariery (R-4.1-H3)", () => {
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

  describe("KONTROLA DODATNIA — przy poprawnej deklaracji job REALNIE kasuje", () => {
    it("wysyła DELETE na tabelę bariery, RAZ NA KAŻDY zadeklarowany rynek", async () => {
      process.env[MARKETS_ENV_VAR] = "bonbeauty, testmarketb"
      const { calls, container, logged } = recordingContainer(4)

      await messagingDispatchBarrierPurge(container)

      // Ta asercja PĘKA, gdy job przestaje kasować mimo poprawnej deklaracji —
      // czyli w dokładnie tym stanie, w którym wchodził na falę.
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.sql.trim().toUpperCase().startsWith("DELETE")).toBe(true)
        expect(call.sql).toContain(MESSAGING_DISPATCH_BARRIER_TABLE)
      }
      expect(logged).toContain("info market=bonbeauty deleted_expired_rows=4")
      expect(logged).toContain("info market=testmarketb deleted_expired_rows=4")
      expect(getSystemMarketContextDenials()).toBe(0)
    })

    it("stwierdzenie jest ZAWĘŻONE do rynku i NIE rusza wierszy bezterminowych", async () => {
      process.env[MARKETS_ENV_VAR] = "bonbeauty"
      const { calls, container } = recordingContainer(0)

      await messagingDispatchBarrierPurge(container)

      // Rynek jest BINDINGIEM, nie tylko wpisem w logu — inaczej deklaracja
      // nie zawężałaby niczego i `DELETE` kasowałby cudze wiersze.
      expect(calls[0].bindings[1]).toBe("bonbeauty")
      expect(calls[0].sql).toContain("split_part(barrier_key, '|', 1)")
      // Wiersze BEZTERMINOWE (`expires_at IS NULL`) to dostawy, które POSZŁY.
      // Ich skasowanie zamieniłoby „mail poszedł" w „mail nigdy nie poszedł".
      expect(calls[0].sql).toContain("expires_at IS NOT NULL")
    })
  })

  describe("KONTROLA NEGATYWNA — bez deklaracji job ODMAWIA, nie kasuje wszystkiego", () => {
    it("brak zmiennej: ZERO wysyłek do bazy, metryka `markets_not_declared`, log z nazwą zmiennej", async () => {
      const { calls, container, logged } = recordingContainer()

      await expect(messagingDispatchBarrierPurge(container)).resolves.toBeUndefined()

      // Najważniejsza asercja tej suity: nic nie zostało skasowane.
      expect(calls).toHaveLength(0)
      expect(
        getSystemMarketContextDenials({ reason: "markets_not_declared", surface: "job" }),
      ).toBe(1)
      // Log MUSI nieść nazwę zmiennej — operator ma wiedzieć, czego brakuje.
      expect(logged.some((l) => l.startsWith("error") && l.includes(MARKETS_ENV_VAR))).toBe(
        true,
      )
    })

    it("zmienna ustawiona, ale pusta: odmowa `markets_empty` — „nic” nie jest deklaracją", async () => {
      process.env[MARKETS_ENV_VAR] = " , ,"
      const { calls, container } = recordingContainer()

      await expect(messagingDispatchBarrierPurge(container)).resolves.toBeUndefined()

      expect(calls).toHaveLength(0)
      expect(getSystemMarketContextDenials({ reason: "markets_empty", surface: "job" })).toBe(1)
    })

    it("`readDeclaredMarkets` ODRÓŻNIA brak zmiennej od pustej deklaracji", () => {
      expect(readDeclaredMarkets({})).toBeUndefined()
      expect(readDeclaredMarkets({ [MARKETS_ENV_VAR]: "" })).toEqual([])
      expect(readDeclaredMarkets({ [MARKETS_ENV_VAR]: "a, b ,, c" })).toEqual(["a", "b", "c"])
    })
  })

  describe("KONTROLA KONTROLI — obejście joba też jest odmową", () => {
    it("`purgeExpiredDispatchBarrierRows` POZA kontekstem: rzuca PRZED wysyłką do bazy", async () => {
      const calls: Call[] = []
      const db = {
        raw: async (sql: string, bindings: readonly unknown[] = []) => {
          calls.push({ sql, bindings })
          return { rowCount: 0 }
        },
      }

      await expect(
        purgeExpiredDispatchBarrierRows(db, new Date("2026-08-06T03:17:00.000Z")),
      ).rejects.toBeInstanceOf(SystemMarketContextError)
      expect(calls).toHaveLength(0)
    })

    it("ta sama funkcja W kontekście: przechodzi i niesie rynek z kontekstu", async () => {
      const calls: Call[] = []
      const db = {
        raw: async (sql: string, bindings: readonly unknown[] = []) => {
          calls.push({ sql, bindings })
          return { rowCount: 7 }
        },
      }

      const deleted = await marketContextStorage.run(
        { market_id: "bonbeauty", system: { surface: "job", name: SCHEDULE_NAME } },
        () => purgeExpiredDispatchBarrierRows(db, new Date("2026-08-06T03:17:00.000Z")),
      )

      expect(deleted).toBe(7)
      expect(calls[0].bindings[1]).toBe("bonbeauty")
    })
  })

  describe("DEKLARACJA ISTNIEJE POZA KODEM (R-4.1-H3)", () => {
    it("`.env.example` niesie zmienną, od której zależy CAŁA praca joba", () => {
      // TO JEST kontrola, której brak przepuścił martwy job. Dopóki zmienna
      // żyła wyłącznie we własnym pliku, „nośnik retencji" był deklaracją:
      // na każdym środowisku bez ręcznego ustawienia job kasował zero wierszy.
      const envExample = readFileSync(
        join(__dirname, "../../../../../.env.example"),
        "utf8",
      )
      expect(envExample).toContain(MARKETS_ENV_VAR)
      // Nie sam string w komentarzu — REALNA linia przypisania.
      expect(envExample).toMatch(
        new RegExp(`^${MARKETS_ENV_VAR}=`, "m"),
      )
    })
  })

  it("jest ODKRYWALNY dla Medusy: leży w `src/jobs/` i deklaruje nazwę oraz harmonogram", () => {
    const jobsDir = join(__dirname, "../../jobs")
    expect(existsSync(join(jobsDir, "messaging-dispatch-barrier-purge.ts"))).toBe(true)
    expect(readdirSync(jobsDir)).toContain("messaging-dispatch-barrier-purge.ts")

    expect(config.name).toBe(SCHEDULE_NAME)
    expect(config.schedule).toBe(SCHEDULE_CRON)
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

    await expect(messagingDispatchBarrierPurge(container)).resolves.toBeUndefined()
    expect(logged.some((l) => l.startsWith("warn"))).toBe(true)
  })

  it("błąd DELETE: loguje błąd i NIE wywraca schedulera", async () => {
    process.env[MARKETS_ENV_VAR] = "bonbeauty"
    const { container, logged } = containerWith(async () => {
      throw new Error('relation "messaging_dispatch_barrier" does not exist')
    })

    await expect(messagingDispatchBarrierPurge(container)).resolves.toBeUndefined()
    expect(logged.some((l) => l.startsWith("error"))).toBe(true)
  })
})
