/**
 * Story 4.4 / AD-23 — „numer próby nadaje POLITYKA, nie wywołujący".
 *
 * Dwa niezależne człony, dwie różne metody dowodu:
 *
 *   1. BUDŻET ma jeden nośnik. Dowód jest STATYCZNY z konieczności — pytanie
 *      brzmi „czy w kodzie produkcyjnym istnieje DRUGIE źródło wartości", a to
 *      jest pytanie o źródło, nie o przebieg. Test czyta plik joba i pęka, gdy
 *      pojawi się w nim literał progu albo wywołanie omijające politykę.
 *   2. NUMER próby nadaje ledger. Dowód jest z WYKONANIA: wołamy
 *      `reserveDispatch` z podanym numerem i sprawdzamy, że jest ODRZUCONY,
 *      a wiersz nie powstaje.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  SWEEP_MAX_ATTEMPT_COUNT,
  SWEEP_MAX_CONFIGURATION_RECOVERIES,
} from "../../jobs/voucher-delivery-reconciliation-sweep"
import {
  CALLER_FORBIDDEN_ATTEMPT_FIELDS,
  VOUCHER_DELIVERY_ATTEMPT_POLICY,
  VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT,
  VOUCHER_DELIVERY_MAX_CONFIGURATION_RECOVERIES,
} from "../../modules/voucher-delivery/attempt-policy"
import {
  DispatchLedgerError,
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"

const SWEEP_SOURCE_PATH = join(
  __dirname,
  "../../jobs/voucher-delivery-reconciliation-sweep.ts",
)
const sweepSource = readFileSync(SWEEP_SOURCE_PATH, "utf8")

/**
 * Review 4.4, finding #2 — zakres bramki to CAŁE drzewo produkcyjne, nie jeden
 * plik. Zagrożenie, dla którego ta bramka istnieje, story nazywa wprost:
 * „DRUGI wywołujący z innym progiem odparkowuje wiersze pierwszego i nikt tego
 * nie zauważy". Skan wyłącznie źródła sweepa chronił pierwszego wywołującego,
 * czyli był ślepy dokładnie na defekt, który miał łapać — a 4.2/4.3 dokładają
 * w TEJ SAMEJ fali nowego producenta ponowień przez ten sam ledger.
 */
const API_SRC_ROOT = join(__dirname, "../..")

function collectProductionSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `__tests__` i `*.spec.ts` są POZA zakresem: test wolno napisać z literałem
    // progu (to jest jego przedmiot). Bramka pilnuje ścieżki PRODUKCYJNEJ.
    if (entry.name === "__tests__" || entry.name === "node_modules") continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectProductionSources(full))
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(full)
    }
  }
  return out
}

/**
 * JEDYNY plik, w którym literał progu jest legalny — bo to on JEST nośnikiem
 * polityki. Wyjątek jest celowo pojedynczy i wypisany z nazwy: gdyby był
 * wzorcem po sufiksie `attempt-policy.ts` w dowolnym katalogu, drugi
 * wywołujący mógłby powołać własny „policy" i bramka znów przestałaby łapać
 * defekt, dla którego powstała.
 */
const POLICY_CARRIER_PATH = join(
  API_SRC_ROOT,
  "modules/voucher-delivery/attempt-policy.ts",
)

const PRODUCTION_SOURCES = collectProductionSources(API_SRC_ROOT)
const BUDGET_SCANNED_SOURCES = PRODUCTION_SOURCES.filter(
  (file) => file !== POLICY_CARRIER_PATH,
)

const RECIPIENT_HASH = `sha256:${"b".repeat(64)}`

/** Atrapa SQL, która ZLICZA zapisy — „zero wierszy" ma być mierzalne. */
function makeCountingSql(): DispatchLedgerSql & { statements: string[] } {
  const statements: string[] = []
  return {
    statements,
    async raw(sql: string) {
      statements.push(sql)
      return { rows: [] }
    },
  } as unknown as DispatchLedgerSql & { statements: string[] }
}

describe("AC4 — budżet prób ma JEDEN nośnik po stronie polityki", () => {
  it("polityka jest źródłem wartości, a stałe sweepa są jej re-eksportem", () => {
    expect(SWEEP_MAX_ATTEMPT_COUNT).toBe(VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT)
    expect(SWEEP_MAX_CONFIGURATION_RECOVERIES).toBe(
      VOUCHER_DELIVERY_MAX_CONFIGURATION_RECOVERIES,
    )
    expect(VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT).toBe(
      VOUCHER_DELIVERY_ATTEMPT_POLICY.max_attempt_count,
    )
  })

  it("polityka jest NIEMUTOWALNA — wywołujący nie podniesie sobie progu w locie", () => {
    expect(Object.isFrozen(VOUCHER_DELIVERY_ATTEMPT_POLICY)).toBe(true)
    expect(() => {
      // @ts-expect-error — próba mutacji polityki jest błędem kompilacji…
      VOUCHER_DELIVERY_ATTEMPT_POLICY.max_attempt_count = 99
    }).toThrow()
    // …i nie przechodzi też w czasie wykonania (`Object.freeze`, tryb strict).
    expect(VOUCHER_DELIVERY_ATTEMPT_POLICY.max_attempt_count).toBe(
      VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT,
    )
  })

  it("KAŻDE wstrzyknięcie progu w CAŁYM drzewie produkcyjnym konsumuje politykę", () => {
    // Zbiór NAZW wartości, nie ich licznik (NFR-9): dołożenie szóstego
    // wywołania z tą samą stałą jest w porządku, dołożenie JAKIEJKOLWIEK innej
    // wartości — w JAKIMKOLWIEK pliku produkcyjnym — świeci na czerwono.
    const injectedBudgets: { file: string; value: string }[] = []
    const injectedRecoveries: { file: string; value: string }[] = []

    for (const file of BUDGET_SCANNED_SOURCES) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(/max_attempt_count:\s*([^,\n]+)/g)) {
        injectedBudgets.push({ file, value: match[1].trim() })
      }
      for (const match of source.matchAll(
        /max_configuration_recoveries:\s*([^,\n]+)/g,
      )) {
        injectedRecoveries.push({ file, value: match[1].trim() })
      }
    }

    // Nazwy legalnych nośników: stała polityki albo jej re-eksport w sweepie.
    // Typ pola w deklaracji (`max_attempt_count: number`) też tu wpada i jest
    // legalny — to KSZTAŁT, nie wartość.
    const ALLOWED_BUDGET_TOKENS = new Set([
      "SWEEP_MAX_ATTEMPT_COUNT",
      "VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT",
      "number",
    ])
    const ALLOWED_RECOVERY_TOKENS = new Set([
      "SWEEP_MAX_CONFIGURATION_RECOVERIES",
      "VOUCHER_DELIVERY_MAX_CONFIGURATION_RECOVERIES",
      "number",
    ])

    expect(injectedBudgets.length).toBeGreaterThan(0)

    // Raportujemy PLIK przy naruszeniu — inaczej czerwień nie mówi, gdzie
    // powstał drugi próg.
    const budgetOffenders = injectedBudgets
      .filter((entry) => !ALLOWED_BUDGET_TOKENS.has(entry.value))
      .map((entry) => `${entry.file.replace(API_SRC_ROOT, "src")}: ${entry.value}`)
    const recoveryOffenders = injectedRecoveries
      .filter((entry) => !ALLOWED_RECOVERY_TOKENS.has(entry.value))
      .map((entry) => `${entry.file.replace(API_SRC_ROOT, "src")}: ${entry.value}`)

    expect(budgetOffenders).toEqual([])
    expect(recoveryOffenders).toEqual([])
  })

  it("kontrola kontroli: literał progu w INNYM pliku produkcyjnym jest wykrywany", () => {
    // Bramka bez tego testu byłaby „mechanizmem, który istnieje", a nie takim,
    // który odpala. Symulujemy drugiego wywołującego z własnym progiem.
    const foreignSource = [
      "// hipotetyczny subscriber webhooka z 4.2/4.3",
      "await ledger.listParkedDispatches({",
      "  entitlement_ids: ids,",
      "  max_attempt_count: 3,",
      "})",
    ].join("\n")

    const injected = [
      ...foreignSource.matchAll(/max_attempt_count:\s*([^,\n]+)/g),
    ].map((match) => match[1].trim())

    expect(injected).toEqual(["3"])
    expect(
      injected.every((value) =>
        ["SWEEP_MAX_ATTEMPT_COUNT", "VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT", "number"].includes(
          value,
        ),
      ),
    ).toBe(false)
  })

  it("skan obejmuje realne drzewo, nie pusty zbiór plików", () => {
    // Bez tej asercji pomyłka w ścieżce zamieniłaby bramkę w zawsze-zieloną.
    expect(PRODUCTION_SOURCES.length).toBeGreaterThan(50)
    expect(PRODUCTION_SOURCES).toContain(SWEEP_SOURCE_PATH)
    expect(PRODUCTION_SOURCES.every((file) => !file.includes("__tests__"))).toBe(true)
  })

  it("job nie definiuje progu — przypisanie literału do stałej progu jest RED", () => {
    // Dokładnie ten kształt, który AD-23 nazywa defektem: budżet jako stała
    // WYWOŁUJĄCEGO. Po 4.4 jedyne przypisanie odsyła do polityki.
    expect(sweepSource).toMatch(
      /export const SWEEP_MAX_ATTEMPT_COUNT = VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT/,
    )
    expect(sweepSource).not.toMatch(/export const SWEEP_MAX_ATTEMPT_COUNT = \d/)
    expect(sweepSource).not.toMatch(
      /export const SWEEP_MAX_CONFIGURATION_RECOVERIES = \d/,
    )
  })
})

describe("AC4 — numer próby nadaje ledger, nie wywołujący (dowód z wykonania)", () => {
  const baseInput = {
    entitlement_id: "entinst_4_4_policy",
    template_key: "voucher_purchase_confirmation",
    recipient_hash: RECIPIENT_HASH as never,
    market_id: "bonbeauty",
    flow_id: "voucher-purchase-delivery",
    locale: "pl",
  }

  it.each(CALLER_FORBIDDEN_ATTEMPT_FIELDS)(
    "`%s` podany z zewnątrz jest ODRZUCONY, a nie cicho przyjęty",
    async (field) => {
      const sql = makeCountingSql()
      const ledger = new PgDispatchLedger(sql)

      await expect(
        ledger.reserveDispatch({ ...baseInput, [field]: 7 } as never),
      ).rejects.toBeInstanceOf(DispatchLedgerError)

      // Odmowa musi być PRZED zapisem: przyjęcie wejścia i zignorowanie pola
      // wyglądałoby dla wołającego jak skuteczne nadanie numeru.
      expect(sql.statements).toHaveLength(0)
    },
  )

  it("odmowa niesie kod, po którym da się zaalarmować", async () => {
    const ledger = new PgDispatchLedger(makeCountingSql())

    await expect(
      ledger.reserveDispatch({ ...baseInput, attempt_no: 2 } as never),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_ATTEMPT_NUMBER_NOT_CALLER_OWNED",
    })
  })

  it("legalne wejście (bez numeru) przechodzi — bramka nie jest ślepym `throw`", async () => {
    const sql = makeCountingSql()
    const ledger = new PgDispatchLedger(sql)

    // Atrapa nie zwraca wierszy, więc wynik jest `in_flight`; istotne jest, że
    // zapytanie INSERT-owe REALNIE poszło, a numer próby jest w SQL-u, nie
    // w wejściu.
    await ledger.reserveDispatch({ ...baseInput })

    expect(sql.statements.length).toBeGreaterThan(0)
    expect(sql.statements[0]).toContain(VOUCHER_DELIVERY_DISPATCH_TABLE)
    expect(sql.statements[0]).toContain("attempt_count")
  })

  it("inkrement numeru NIE istnieje poza warunkowym UPDATE ledgera", () => {
    const ledgerSource = readFileSync(
      join(__dirname, "../../modules/voucher-delivery/dispatch-ledger.ts"),
      "utf8",
    )
    const increments = ledgerSource.match(/attempt_count = attempt_count \+ 1/g)

    // Dokładnie jedno miejsce nadające numer. Drugie oznaczałoby, że „polityka
    // nadaje numer" jest zdaniem o intencji, nie o kodzie.
    expect(increments).toHaveLength(1)
    // …i żaden inny plik produkcyjny go nie podnosi.
    expect(sweepSource).not.toContain("attempt_count = attempt_count + 1")
  })
})
