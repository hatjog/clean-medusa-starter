/**
 * money-path-brakes — testy JEDNEGO helpera odczytu hamulca
 * (v1.15.0 Story 2.1, AC4; NFR-8, AD-25, ADR-177).
 *
 * Sedno: brak konfiguracji NIE MOŻE być nieodróżnialny od konfiguracji.
 * Każda degradacja do wartości bezpiecznej jest raportowana (`degraded: true`
 * + `reason` + `warn`), bo cicha degradacja jest dokładnie tym defektem,
 * którym „hamulec istnieje, ale nie działa" wygląda z zewnątrz jak sukces.
 */

import {
  MONEY_PATH_BRAKE_SAFE_STATE,
  MONEY_PATH_BRAKE_SWITCHES,
  createMoneyPathBrakeReader,
  type MoneyPathBrakesSql,
} from "../../lib/money-path-brakes"

function sqlReturning(rows: unknown[]): MoneyPathBrakesSql {
  return { raw: async () => ({ rows }) }
}

function makeLogger() {
  const warnings: Array<Record<string, unknown> | undefined> = []
  return {
    warnings,
    warn: (_message: string, meta?: Record<string, unknown>) => warnings.push(meta),
  }
}

describe("kontrakt pięciu przełączników", () => {
  it("nazwy są zamrożone w ADR-177", () => {
    expect([...MONEY_PATH_BRAKE_SWITCHES]).toEqual([
      "fr_6_7_multi_seller_purchase_return",
      "fr_9_delivery_idempotency",
      "fr_10_panel_redemption",
      "fr_12_redemption_ledger",
      "fr_14_market_isolation",
    ])
  })

  it("wartością bezpieczną jest `engaged` (fail-closed)", () => {
    expect(MONEY_PATH_BRAKE_SAFE_STATE).toBe("engaged")
  })
})

describe("odczyt z konfiguracji rynku", () => {
  it("zwraca `released`, gdy rynek zwolnił hamulec", async () => {
    const reader = createMoneyPathBrakeReader(
      sqlReturning([{ money_path_brakes: { fr_9_delivery_idempotency: "released" } }]),
    )
    const read = await reader.read("bonbeauty", "fr_9_delivery_idempotency")
    expect(read).toEqual({ state: "released", degraded: false, reason: null })
    expect(await reader.isReleased("bonbeauty", "fr_9_delivery_idempotency")).toBe(true)
  })

  it("czyta również blok zapisany jako tekst JSON (sterownik zwraca string)", async () => {
    const reader = createMoneyPathBrakeReader(
      sqlReturning([
        { money_path_brakes: JSON.stringify({ fr_10_panel_redemption: "released" }) },
      ]),
    )
    expect(await reader.isReleased("bonbeauty", "fr_10_panel_redemption")).toBe(true)
  })
})

describe("fail-closed — każda luka daje wartość bezpieczną I raport", () => {
  const cases: Array<[string, MoneyPathBrakesSql]> = [
    ["brak wiersza rynku", sqlReturning([])],
    ["brak bloku hamulców", sqlReturning([{ money_path_brakes: null }])],
    ["brak przełącznika w bloku", sqlReturning([{ money_path_brakes: {} }])],
    [
      "wartość spoza enumu",
      sqlReturning([{ money_path_brakes: { fr_9_delivery_idempotency: "relesed" } }]),
    ],
    [
      "błąd odczytu bazy",
      {
        raw: async () => {
          throw new Error("relation market_runtime_config does not exist")
        },
      },
    ],
  ]

  it.each(cases)("%s => engaged + degraded + warn", async (_label, sql) => {
    const logger = makeLogger()
    const reader = createMoneyPathBrakeReader(sql, logger)

    const read = await reader.read("bonbeauty", "fr_9_delivery_idempotency")

    expect(read.state).toBe("engaged")
    expect(read.degraded).toBe(true)
    expect(read.reason).toBeTruthy()
    // Degradacja jest RAPORTOWANA — inaczej „hamulec nie działa, bo nikt nie
    // zsynchronizował konfiguracji" przechodzi niezauważone.
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]?.brake).toBe("fr_9_delivery_idempotency")
  })

  it("`isReleased` nigdy nie zwraca true przy degradacji", async () => {
    const reader = createMoneyPathBrakeReader(sqlReturning([]))
    for (const brake of MONEY_PATH_BRAKE_SWITCHES) {
      expect(await reader.isReleased("bonbeauty", brake)).toBe(false)
    }
  })

  it("pusty market_id jest odmową odczytu, nie zapytaniem do bazy", async () => {
    const raw = jest.fn()
    const reader = createMoneyPathBrakeReader({ raw } as never)
    const read = await reader.read("", "fr_14_market_isolation")
    expect(read.state).toBe("engaged")
    expect(raw).not.toHaveBeenCalled()
  })
})
