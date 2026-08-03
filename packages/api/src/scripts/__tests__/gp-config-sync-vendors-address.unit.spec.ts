/**
 * Adres salonu w syncu vendorów — F-1 / F-2 / F-5 z review story 5.7.
 *
 * Dlaczego te testy istnieją, mimo że sync był weryfikowany żywym przebiegiem:
 * żywy run dowiódł WYŁĄCZNIE ścieżki szczęśliwej. Każdy vendor we wszystkich
 * pięciu rynkach ma dziś adres w gp-config, więc gałąź „seller bez adresu"
 * (sygnał F-5) nie ma jak się wykonać na realnych danych — a to ona decyduje,
 * czy operator dowie się o braku PRZED zakupem klientki, czy dopiero z `failed`
 * w ledgerze po opłaceniu vouchera.
 */

import {
  selectPrimaryVendorLocation,
  upsertSellerAddressViaDb,
} from "../gp-config-sync-vendors"

// ── Atrapa knexa: tylko to, czego dotyka `upsertSellerAddressViaDb` ─────────

type Row = Record<string, unknown>

function makeDb(rows: Row[] = [], opts: { failOn?: "select" | "insert" | "update" } = {}) {
  const state = { rows: [...rows], inserted: [] as Row[], updated: [] as Row[], orderedBy: [] as unknown[] }

  const db = (table: string) => {
    if (table !== "seller_address") throw new Error(`nieoczekiwana tabela: ${table}`)
    const q: Record<string, unknown> = {}
    let filtered = state.rows

    const api = {
      where(criteria: Row) {
        filtered = filtered.filter((r) =>
          Object.entries(criteria).every(([k, v]) => r[k] === v),
        )
        Object.assign(q, criteria)
        return api
      },
      whereNull(column: string) {
        filtered = filtered.filter((r) => r[column] == null)
        return api
      },
      orderBy(spec: unknown) {
        state.orderedBy.push(spec)
        // Odwzorowanie realnego `ORDER BY created_at ASC, id ASC`.
        filtered = [...filtered].sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)) ||
          String(a.id).localeCompare(String(b.id)),
        )
        return api
      },
      async first() {
        if (opts.failOn === "select") throw new Error("pg: connection reset")
        return filtered[0]
      },
      async insert(row: Row) {
        if (opts.failOn === "insert") throw new Error("pg: duplicate key")
        state.inserted.push(row)
        state.rows.push(row)
      },
      async update(patch: Row) {
        if (opts.failOn === "update") throw new Error("pg: deadlock detected")
        state.updated.push({ ...q, ...patch })
      },
    }
    return api
  }

  return Object.assign(db, { state })
}

const LOCATION = {
  city: "Warszawa",
  address: "ul. Przykładowa 1",
  postal_code: "00-001",
  country_code: "PL",
  region: "mazowieckie",
}

describe("F-5 — selectPrimaryVendorLocation decyduje, czy seller dostanie mail", () => {
  it("zwraca pierwszą lokalizację, gdy ma niepusty adres", () => {
    expect(selectPrimaryVendorLocation({ locations: [LOCATION] })).toEqual(LOCATION)
  })

  it("brak `locations` ⇒ null (ten seller trafia na listę bez adresu)", () => {
    expect(selectPrimaryVendorLocation({})).toBeNull()
    expect(selectPrimaryVendorLocation({ locations: [] })).toBeNull()
  })

  it("adres pusty albo sam whitespace ⇒ null, NIE 'adres'", () => {
    // W mailu „   " wygląda identycznie jak pole puste — traktujemy jak brak,
    // inaczej bramka kontraktu przepuściłaby wizualnie pusty adres salonu.
    expect(selectPrimaryVendorLocation({ locations: [{ ...LOCATION, address: "" }] })).toBeNull()
    expect(selectPrimaryVendorLocation({ locations: [{ ...LOCATION, address: "   " }] })).toBeNull()
  })

  it("bierze WYŁĄCZNIE pierwszą lokalizację, nie szuka dalej", () => {
    // `seller_address` trzyma jeden adres na sellera; przeszukiwanie kolejnych
    // byłoby zgadywaniem, który salon jest „ten właściwy".
    const vendor = { locations: [{ ...LOCATION, address: "  " }, LOCATION] }
    expect(selectPrimaryVendorLocation(vendor)).toBeNull()
  })
})

describe("F-2 — zapis wybiera ten sam wiersz co odczyt projekcji maila", () => {
  it("przy wielu wierszach aktualizuje NAJSTARSZY (created_at ASC, id ASC)", async () => {
    const db = makeDb([
      { id: "saddr_b", seller_id: "sel_1", created_at: "2026-05-02T00:00:00Z", deleted_at: null },
      { id: "saddr_a", seller_id: "sel_1", created_at: "2026-05-01T00:00:00Z", deleted_at: null },
    ])

    const outcome = await upsertSellerAddressViaDb(db as never, "sel_1", "Studio Nova", LOCATION)

    expect(outcome).toBe("updated")
    expect(db.state.orderedBy).toHaveLength(1)
    // Mail czyta najstarszy wiersz — sync MUSI aktualizować dokładnie ten sam.
    expect(db.state.updated[0]).toMatchObject({ id: "saddr_a" })
  })

  it("pomija wiersze `deleted_at` — usunięty adres nie jest adresem", async () => {
    const db = makeDb([
      { id: "saddr_x", seller_id: "sel_1", created_at: "2026-04-01T00:00:00Z", deleted_at: "2026-06-01T00:00:00Z" },
    ])

    const outcome = await upsertSellerAddressViaDb(db as never, "sel_1", "Studio Nova", LOCATION)

    expect(outcome).toBe("created")
  })

  it("brak wiersza ⇒ INSERT z danymi z configu", async () => {
    const db = makeDb()

    const outcome = await upsertSellerAddressViaDb(db as never, "sel_1", "Studio Nova", LOCATION)

    expect(outcome).toBe("created")
    expect(db.state.inserted[0]).toMatchObject({
      seller_id: "sel_1",
      company: "Studio Nova",
      address_1: "ul. Przykładowa 1",
      postal_code: "00-001",
      city: "Warszawa",
      country_code: "pl",
    })
  })

  it("adres pusty ⇒ `skipped`, ZERO zapisów", async () => {
    const db = makeDb()

    const outcome = await upsertSellerAddressViaDb(db as never, "sel_1", "Studio Nova", {
      ...LOCATION,
      address: "  ",
    })

    expect(outcome).toBe("skipped")
    expect(db.state.inserted).toHaveLength(0)
    expect(db.state.updated).toHaveLength(0)
  })
})

describe("F-1 — awaria zapisu jest RZUCANA, żeby wołający mógł ją policzyć", () => {
  it.each(["select", "insert", "update"] as const)(
    "błąd na etapie %s nie jest połykany",
    async (stage) => {
      // Gdyby helper połykał błąd i zwracał `skipped`, licznik awarii w syncu
      // byłby zawsze zerowy, a run wyglądałby na zdrowy mimo braku adresu.
      const rows =
        stage === "update"
          ? [{ id: "saddr_a", seller_id: "sel_1", created_at: "2026-05-01T00:00:00Z", deleted_at: null }]
          : []
      const db = makeDb(rows, { failOn: stage })

      await expect(
        upsertSellerAddressViaDb(db as never, "sel_1", "Studio Nova", LOCATION),
      ).rejects.toThrow(/pg:/)
    },
  )
})
