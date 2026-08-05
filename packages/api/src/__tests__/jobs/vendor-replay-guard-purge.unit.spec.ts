/**
 * v1.15.0 Story 5.3 (review cyklu 1, MEDIUM-3) — retencja tabeli
 * `vendor_replay_guard` ma NOŚNIK, a nie tylko zdanie w ADR.
 *
 * Ta suita pilnuje trzech rzeczy, w tej kolejności ważności:
 *  1. job REALNIE wysyła `DELETE` (mechanizm, który się nie odpala, jest
 *     nieodróżnialny od braku mechanizmu),
 *  2. job jest ODKRYWALNY dla Medusy — plik leży w `src/jobs/` (dowiązanie do
 *     `packages/api/src/jobs/`) i eksportuje `config.name` + `config.schedule`,
 *  3. awaria sprzątania NIE wywraca schedulera — bo to higiena, nie poprawność;
 *     odwrotna decyzja (fail-loud) obowiązuje w samej barierze.
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, it, expect } from "@jest/globals"

import vendorReplayGuardPurge, {
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

describe("vendor-replay-guard-purge — nośnik zobowiązania retencyjnego (AC3)", () => {
  it("REALNIE wysyła DELETE na tabelę bariery", async () => {
    const calls: Call[] = []
    const { container, logged } = containerWith(async (sql, bindings = []) => {
      calls.push({ sql, bindings })
      return { rowCount: 3 }
    })

    await vendorReplayGuardPurge(container)

    expect(calls).toHaveLength(1)
    expect(calls[0].sql.trim().toUpperCase().startsWith("DELETE")).toBe(true)
    expect(calls[0].sql).toContain("vendor_replay_guard")
    expect(logged.some((l) => l.includes("deleted_expired_rows=3"))).toBe(true)
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
    const { container, logged } = containerWith(async () => {
      throw new Error('relation "vendor_replay_guard" does not exist')
    })

    await expect(vendorReplayGuardPurge(container)).resolves.toBeUndefined()
    expect(logged.some((l) => l.startsWith("error"))).toBe(true)
  })
})
