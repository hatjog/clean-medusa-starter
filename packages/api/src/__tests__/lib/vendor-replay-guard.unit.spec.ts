/**
 * v1.15.0 Story 5.3 — `lib/vendor-replay-guard` (FR-11, AD-20, AD-23, ADR-185).
 *
 * ZAKRES TEJ SUITY, I CZEGO ONA NIE DOWODZI:
 * Tu mierzymy to, co da się zmierzyć bez bazy: liczbę wysyłek do sterownika,
 * kształt wysłanego stwierdzenia, oraz własności klucza i skrótu treści.
 *
 * SEMANTYKA SAMEGO SQL-a (który wpis blokuje, a który wygasł) NIE jest tu
 * asertowana na podstawie stringów — to byłby test świecący na zielono nad
 * zepsutym kodem. Jest dowiedziona:
 *   - przebiegiem SAMEGO MODUŁU na REALNYM Postgresie (sterownik `pg`, oba
 *     brzegi okna, oba klucze) —
 *     `__tests__/integration/vendor-replay-guard-pg.integration.test.ts`,
 *     `pnpm test:integration:replay-guard-pg` (wymaga `DATABASE_URL`);
 *   - `evidence/5-3/replay-guard-postgres-proof.{sql,out}` — 3 werdykty + oba brzegi okna,
 *     `evidence/5-3/replay-guard-concurrency-proof.sh` — wyścig dwóch połączeń.
 *
 * Tutaj brzegi okna są dodatkowo mierzone WYKONANIEM przeciw `FakeGuardTable`,
 * która odtwarza predykat `expires_at <= $now` na bindingach wysłanych przez
 * moduł. To nie jest Postgres — ale jest wykonaniem KODU MODUŁU, a nie asercją
 * na podciągu SQL-a.
 */
import { describe, it, expect } from "@jest/globals"

import { marketContextStorage } from "../../lib/market-context"
import {
  buildNonceScopeKey,
  buildReplayGuardKey,
  claimReplayGuardKey,
  computeBodyDigest,
  deriveReplayGuardWindowSec,
  EMPTY_BODY_DIGEST,
  REPLAY_GUARD_CLOCK_SKEW_MARGIN_SEC,
  purgeExpiredReplayGuardRows,
  type ReplayGuardDb,
} from "../../lib/vendor-replay-guard"

/** Sterownik ZLICZAJĄCY — jedyny sposób, żeby „jedna operacja" była pomiarem, nie deklaracją. */
function countingDb(returnRows: number): ReplayGuardDb & {
  calls: Array<{ sql: string; bindings: readonly unknown[] }>
} {
  const calls: Array<{ sql: string; bindings: readonly unknown[] }> = []
  return {
    calls,
    raw: async (sql: string, bindings: readonly unknown[] = []) => {
      calls.push({ sql, bindings })
      return { rows: Array.from({ length: returnRows }, () => ({ guard_key: "k" })) }
    },
  }
}

/**
 * Tabela odtwarzająca predykat okna NA BINDINGACH, które wysłał moduł.
 *
 * Świadomie NIE parsuje SQL-a: czyta bindingi z układu, w jakim stawia je moduł
 * (grupy po cztery — `guard_key, seller_id, expires_at, created_at` — a na końcu
 * próg predykatu), i stosuje regułę „wpis blokuje, dopóki `expires_at > now`".
 * Dzięki temu test brzegów okna jest WYKONANIEM ścieżki `claimReplayGuardKey`
 * (wyliczenie `expiresIso`, ułożenie bindingów, zliczenie wierszy), a nie
 * inspekcją stringa.
 */
class FakeGuardTable implements ReplayGuardDb {
  readonly rows = new Map<string, string>()
  statements = 0

  raw = async (sql: string, bindings: readonly unknown[] = []): Promise<unknown> => {
    this.statements += 1

    if (sql.trim().toUpperCase().startsWith("DELETE")) {
      const cutoff = bindings[0] as string
      let deleted = 0
      for (const [key, expires] of [...this.rows]) {
        if (expires <= cutoff) {
          this.rows.delete(key)
          deleted += 1
        }
      }
      return { rowCount: deleted }
    }

    const values = bindings.slice(0, -1) as string[]
    const nowIso = bindings[bindings.length - 1] as string

    const returned: Array<{ guard_key: string }> = []
    for (let i = 0; i < values.length; i += 4) {
      const key = values[i]
      const expiresIso = values[i + 2]
      const existing = this.rows.get(key)
      if (existing !== undefined && !(existing <= nowIso)) {
        continue // wpis żyje → nie jest zwracany → powtórzenie
      }
      this.rows.set(key, expiresIso)
      returned.push({ guard_key: key })
    }
    return { rows: returned }
  }
}

describe("claimReplayGuardKey — JEDNA operacja atomowa (AD-23, AC1)", () => {
  it("wysyła do bazy DOKŁADNIE JEDNO stwierdzenie na żądanie — także dla DWÓCH kluczy", async () => {
    const db = countingDb(2)

    await claimReplayGuardKey(db, {
      guardKeys: ["k-body", "k-nonce"],
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })

    // Dwa klucze, ale nadal JEDNA wysyłka: dwa wiersze w tym samym `VALUES`.
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1)
  })

  it("w ścieżce bariery NIE MA odczytu poprzedzającego zapis dla tego samego klucza", async () => {
    const db = countingDb(1)

    await claimReplayGuardKey(db, {
      guardKeys: ["k1"],
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })

    const sql = db.calls[0].sql
    // Jedno stwierdzenie, i to stwierdzenie jest INSERT-em — nie SELECT-em.
    expect(sql.trim().toUpperCase().startsWith("INSERT")).toBe(true)
    expect(sql.toUpperCase()).not.toContain("SELECT")
    expect(sql.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1)
  })

  it("okno ważności jest CZĘŚCIĄ PREDYKATU tego samego stwierdzenia, nie filtrem po odczycie", async () => {
    const db = countingDb(1)

    await claimReplayGuardKey(db, {
      guardKeys: ["k1"],
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })

    const sql = db.calls[0].sql.toUpperCase()
    expect(sql).toContain("ON CONFLICT")
    expect(sql).toContain("DO UPDATE")
    // Predykat okna siedzi w stwierdzeniu — nie w kodzie po stronie Node.
    // UWAGA: to jest asercja na KSZTAŁCIE, nie na zachowaniu. Zachowanie obu
    // brzegów okna jest mierzone niżej (`FakeGuardTable`) i na realnym
    // Postgresie (`vendor-replay-guard-pg.integration.test.ts`).
    expect(sql).toContain("EXPIRES_AT <= ?")
    expect(sql).toContain("RETURNING")
  })

  it("werdykt to WSZYSTKIE ALBO NIC: brakujący wiersz = któryś klucz żyje = powtórzenie", async () => {
    const params = {
      guardKeys: ["k-body", "k-nonce"],
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    }

    await expect(claimReplayGuardKey(countingDb(2), params)).resolves.toBe(true)
    // JEDEN wiersz przy DWÓCH kluczach = drugi klucz jest zajęty i wciąż żyje.
    // Gdyby to było `> 0`, przechwycony nagłówek z NOWYM ciałem przechodziłby.
    await expect(claimReplayGuardKey(countingDb(1), params)).resolves.toBe(false)
    await expect(claimReplayGuardKey(countingDb(0), params)).resolves.toBe(false)
  })

  it("czyta werdykt także z „gołej” tablicy Knexa, nie tylko z kształtu `{ rows }`", async () => {
    const arrayDb: ReplayGuardDb = { raw: async () => [{ guard_key: "k" }] }
    const emptyArrayDb: ReplayGuardDb = { raw: async () => [] }

    const params = { guardKeys: ["k1"], sellerId: "s", nowSec: 1_800_000_000, windowSec: 660 }
    await expect(claimReplayGuardKey(arrayDb, params)).resolves.toBe(true)
    await expect(claimReplayGuardKey(emptyArrayDb, params)).resolves.toBe(false)
  })

  it("deduplikuje klucze — jeden wiersz dwa razy wywróciłby `ON CONFLICT DO UPDATE` w Postgresie", async () => {
    const db = countingDb(1)

    await expect(
      claimReplayGuardKey(db, {
        guardKeys: ["k1", "k1"],
        sellerId: "s",
        nowSec: 1_800_000_000,
        windowSec: 660,
      })
    ).resolves.toBe(true)

    // Jeden placeholder-wiersz w `VALUES`, jeden klucz w bindingach.
    expect(db.calls[0].sql.match(/\(\?, \?, \?, \?\)/g)).toHaveLength(1)
    expect(db.calls[0].bindings.filter((b) => b === "k1")).toHaveLength(1)
  })

  it("pusty zbiór kluczy jest BŁĘDEM, nie cichym „świeże”", async () => {
    await expect(
      claimReplayGuardKey(countingDb(0), {
        guardKeys: [],
        sellerId: "s",
        nowSec: 1_800_000_000,
        windowSec: 660,
      })
    ).rejects.toThrow(/pusty zbiór kluczy/)
  })

  it("`expires_at` jest liczone z czasu WOŁAJĄCEGO, więc okno da się sterować bez zegara ściennego", async () => {
    const db = countingDb(1)
    const nowSec = 1_800_000_000

    await claimReplayGuardKey(db, { guardKeys: ["k1"], sellerId: "s", nowSec, windowSec: 660 })

    // Układ bindingów: (guard_key, seller_id, expires_at, created_at), a na
    // końcu próg predykatu okna.
    const bindings = db.calls[0].bindings
    expect(bindings[0]).toBe("k1")
    expect(bindings[1]).toBe("s")
    expect(bindings[2]).toBe(new Date((nowSec + 660) * 1000).toISOString())
    expect(bindings[3]).toBe(new Date(nowSec * 1000).toISOString())
    expect(bindings[bindings.length - 1]).toBe(new Date(nowSec * 1000).toISOString())
  })
})

// ---------------------------------------------------------------------------
// AC3 — OBA BRZEGI OKNA, mierzone WYKONANIEM (nie asercją na stringu SQL)
// ---------------------------------------------------------------------------

describe("claimReplayGuardKey — oba brzegi okna, sterowane czasem (AD-23, AC3)", () => {
  const T0 = 1_800_000_000
  const WINDOW = 660
  const params = (nowSec: number) => ({
    guardKeys: ["k-window"],
    sellerId: "seller-A",
    nowSec,
    windowSec: WINDOW,
  })

  it("BRZEG WEWNĘTRZNY: ten sam klucz o `T + okno − 1` jest POWTÓRZENIEM", async () => {
    const table = new FakeGuardTable()

    await expect(claimReplayGuardKey(table, params(T0))).resolves.toBe(true)
    await expect(claimReplayGuardKey(table, params(T0 + WINDOW - 1))).resolves.toBe(false)
  })

  it("BRZEG ZEWNĘTRZNY: ten sam klucz o `T + okno` PRZECHODZI — bez udziału sprzątacza", async () => {
    const table = new FakeGuardTable()

    await expect(claimReplayGuardKey(table, params(T0))).resolves.toBe(true)
    await expect(claimReplayGuardKey(table, params(T0 + WINDOW))).resolves.toBe(true)
    // Nic nie skasowało wiersza — wygaszenie zrobił PREDYKAT (AD-23).
    expect(table.rows.size).toBe(1)
    expect(table.statements).toBe(2) // dwa `claim`, ZERO `DELETE`
  })

  it("odnowiony wpis liczy okno OD NOWA, a nie od pierwszego zajęcia", async () => {
    const table = new FakeGuardTable()

    await claimReplayGuardKey(table, params(T0))
    await claimReplayGuardKey(table, params(T0 + WINDOW)) // odnowienie
    // Gdyby `DO UPDATE` nie odnawiało `expires_at`, to by przeszło.
    await expect(claimReplayGuardKey(table, params(T0 + WINDOW + 1))).resolves.toBe(false)
  })

  it("KONTROLA KONTROLI brzegów: sam predykat jest tym, co odróżnia 401 od 200", async () => {
    // Ten sam scenariusz, ale klucz INNY — jeżeli test wyżej przechodziłby też
    // tutaj, nie mierzyłby okna, tylko cokolwiek innego.
    const table = new FakeGuardTable()
    await claimReplayGuardKey(table, params(T0))
    await expect(
      claimReplayGuardKey(table, { ...params(T0), guardKeys: ["k-other"] })
    ).resolves.toBe(true)
  })
})

describe("deriveReplayGuardWindowSec — okno wywiedzione z horyzontu ponowień (AD-23, AC3)", () => {
  it("jest NIE KRÓTSZE niż 2 × dryf — poniżej tego powtórzenie trafia na wygasły wpis", () => {
    for (const drift of [30, 60, 300, 900]) {
      expect(deriveReplayGuardWindowSec(drift)).toBeGreaterThanOrEqual(drift * 2)
    }
  })

  it("dokłada jawny margines na rozjazd zegarów MIĘDZY instancjami", () => {
    expect(deriveReplayGuardWindowSec(300)).toBe(300 * 2 + REPLAY_GUARD_CLOCK_SKEW_MARGIN_SEC)
    expect(REPLAY_GUARD_CLOCK_SKEW_MARGIN_SEC).toBeGreaterThan(0)
  })
})

describe("buildReplayGuardKey — klucz NIEZALEŻNY OD SEKRETU (AD-20, AC2)", () => {
  const base = {
    sellerId: "seller-A",
    ts: "1800000000",
    nonce: "nonce-1",
    bodyDigest: EMPTY_BODY_DIGEST,
  }

  it("obejmuje sprzedawcę, znacznik czasu, nonce I skrót treści — zmiana KAŻDEGO członu zmienia klucz", () => {
    const key = buildReplayGuardKey(base)

    expect(buildReplayGuardKey({ ...base, sellerId: "seller-B" })).not.toBe(key)
    expect(buildReplayGuardKey({ ...base, ts: "1800000001" })).not.toBe(key)
    expect(buildReplayGuardKey({ ...base, nonce: "nonce-2" })).not.toBe(key)
    expect(buildReplayGuardKey({ ...base, bodyDigest: "deadbeef" })).not.toBe(key)
  })

  it("jest deterministyczny i nie przyjmuje ŻADNEGO materiału wywiedzionego z sekretu", () => {
    // Kontrakt funkcji: cztery człony jawne. Nie ma parametru na `sig` ani na
    // sekret, więc rotacja sekretu nie ma czym zmienić klucza. Kontrola
    // WYKONANIEM (rotacja → nadal odmowa) siedzi w suicie trasy.
    expect(buildReplayGuardKey(base)).toBe(buildReplayGuardKey({ ...base }))
    expect(Object.keys(base).sort()).toEqual(["bodyDigest", "nonce", "sellerId", "ts"])
  })

  it("jest odporny na SKLEJENIE członów: ('a','bc') i ('ab','c') dają RÓŻNE klucze", () => {
    const k1 = buildReplayGuardKey({ ...base, sellerId: "a", nonce: "bc" })
    const k2 = buildReplayGuardKey({ ...base, sellerId: "ab", nonce: "c" })
    expect(k1).not.toBe(k2)
  })

  it("ma stałą szerokość (64 znaki hex) niezależnie od długości nonce", () => {
    const short = buildReplayGuardKey({ ...base, nonce: "n" })
    const long = buildReplayGuardKey({ ...base, nonce: "n".repeat(5000) })
    expect(short).toMatch(/^[0-9a-f]{64}$/)
    expect(long).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("buildNonceScopeKey — nonce JEDNORAZOWY niezależnie od ciała (ADR-185 D8)", () => {
  const base = { sellerId: "seller-A", ts: "1800000000", nonce: "nonce-1" }

  it("NIE zależy od ciała: ten sam nagłówek z dwoma różnymi ciałami daje TEN SAM klucz", () => {
    // To jest cała istota tej poprawki. Klucz z AD-20 (z ciałem) różnicuje się
    // przy każdym ciele, więc SAM w sobie przepuszczałby dowolnie wiele żądań
    // pod jednym przechwyconym nagłówkiem.
    const bodyKeyA = buildReplayGuardKey({ ...base, bodyDigest: "aaaa" })
    const bodyKeyB = buildReplayGuardKey({ ...base, bodyDigest: "bbbb" })
    expect(bodyKeyA).not.toBe(bodyKeyB)

    expect(buildNonceScopeKey(base)).toBe(buildNonceScopeKey({ ...base }))
  })

  it("nadal różnicuje sprzedawcę, znacznik czasu i nonce", () => {
    const key = buildNonceScopeKey(base)
    expect(buildNonceScopeKey({ ...base, sellerId: "seller-B" })).not.toBe(key)
    expect(buildNonceScopeKey({ ...base, ts: "1800000001" })).not.toBe(key)
    expect(buildNonceScopeKey({ ...base, nonce: "nonce-2" })).not.toBe(key)
  })

  it("nie może zejść się z kluczem AD-20 (osobny znacznik dziedziny)", () => {
    // Gdyby oba klucze dały tę samą wartość, jedno stwierdzenie trafiłoby dwa
    // razy w ten sam wiersz i Postgres by je wywrócił.
    expect(buildNonceScopeKey(base)).not.toBe(
      buildReplayGuardKey({ ...base, bodyDigest: "" })
    )
    expect(buildNonceScopeKey(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("jest odporny na SKLEJENIE członów", () => {
    expect(buildNonceScopeKey({ ...base, sellerId: "a", nonce: "bc" })).not.toBe(
      buildNonceScopeKey({ ...base, sellerId: "ab", nonce: "c" })
    )
  })
})

describe("computeBodyDigest — skrót treści liczony PO STRONIE SERWERA (AC2)", () => {
  it("żądanie BEZ ciała (GET) ma ZDEFINIOWANY skrót — nie `undefined`, nie pusty człon", () => {
    expect(computeBodyDigest({})).toBe(EMPTY_BODY_DIGEST)
    expect(computeBodyDigest({ body: undefined })).toBe(EMPTY_BODY_DIGEST)
    expect(EMPTY_BODY_DIGEST).toMatch(/^[0-9a-f]{64}$/)
  })

  it("POST z ciałem `{}` jest ODRÓŻNIALNY od żądania bez ciała — NA POZIOMIE FUNKCJI", () => {
    expect(computeBodyDigest({ body: {} })).not.toBe(EMPTY_BODY_DIGEST)
  })

  it("NA REALNEJ TRASIE `/vendor/*` gałąź EMPTY_BODY_DIGEST się NIE ZAPALA — i to jest w porządku", () => {
    // Trasy `/vendor/*` nie mają `preserveRawBody`, a body-parser Medusy stawia
    // `req.body = {}` również dla żądania bez ciała. Realny `GET /vendor/...`
    // wchodzi więc gałęzią `{}`, nie gałęzią zera bajtów. Rozróżnialność z
    // ADR-185 §D3 jest prawdziwa O FUNKCJI, nie o trasie — i to twierdzenie tu
    // pilnujemy, żeby czytelnik nie brał go za własność trasy.
    //
    // Poprawności bariery to nie zmienia: obie gałęzie dają klucz
    // DETERMINISTYCZNY, a jednorazowość nonce trzyma `buildNonceScopeKey`.
    const asRouteSeesGet = computeBodyDigest({ body: {} })
    expect(asRouteSeesGet).not.toBe(EMPTY_BODY_DIGEST)
    expect(asRouteSeesGet).toBe(computeBodyDigest({ body: {} })) // stabilny
    // Gałąź zera bajtów zostaje w kodzie jako obrona przed trasą, która
    // kiedyś włączy `preserveRawBody` albo pominie parser.
    expect(computeBodyDigest({ body: null })).toBe(EMPTY_BODY_DIGEST)
  })

  it("dwa RÓŻNE ciała dają różne skróty — czyli nie sklejają się w jeden klucz bariery", () => {
    expect(computeBodyDigest({ body: { amount: 100 } })).not.toBe(
      computeBodyDigest({ body: { amount: 200 } })
    )
  })

  it("jest deterministyczny wobec KOLEJNOŚCI KLUCZY w ciele (serializacja kanoniczna)", () => {
    const a = computeBodyDigest({ body: { b: 1, a: { d: 4, c: 3 } } })
    const b = computeBodyDigest({ body: { a: { c: 3, d: 4 }, b: 1 } })
    expect(a).toBe(b)
  })

  it("zachowuje ZNACZĄCĄ kolejność w tablicach", () => {
    expect(computeBodyDigest({ body: { xs: [1, 2] } })).not.toBe(
      computeBodyDigest({ body: { xs: [2, 1] } })
    )
  })

  it("preferuje `rawBody` (bajt w bajt), gdy trasa je zachowuje", () => {
    const raw = Buffer.from('{"a":1}', "utf8")
    expect(computeBodyDigest({ rawBody: raw, body: { a: 999 } })).toBe(
      computeBodyDigest({ rawBody: '{"a":1}' })
    )
  })
})

/**
 * Sprzątanie jest ZAPISEM POZA ŻĄDANIEM HTTP, więc od review cyklu 2 wymaga
 * zadeklarowanego rynku (AD-21). Testy higieny muszą więc biec w kontekście —
 * a to, że BEZ kontekstu jest odmowa (i zero wysyłek do bazy), jest mierzone
 * w `__tests__/jobs/vendor-replay-guard-purge.unit.spec.ts`.
 */
const inMarket = <T>(work: () => Promise<T>): Promise<T> =>
  marketContextStorage.run(
    { market_id: "bonbeauty", system: { surface: "job", name: "vendor-replay-guard-purge" } },
    work
  )

describe("purgeExpiredReplayGuardRows — HIGIENA, nie poprawność (AC3)", () => {
  it("kasuje WYŁĄCZNIE wygasłe wiersze — mierzone wykonaniem, nie kształtem SQL", async () => {
    const table = new FakeGuardTable()
    const T0 = 1_800_000_000

    await claimReplayGuardKey(table, {
      guardKeys: ["k-old"],
      sellerId: "s",
      nowSec: T0,
      windowSec: 660,
    })
    await claimReplayGuardKey(table, {
      guardKeys: ["k-fresh"],
      sellerId: "s",
      nowSec: T0 + 600,
      windowSec: 660,
    })

    await inMarket(() => purgeExpiredReplayGuardRows(table, T0 + 700))

    expect([...table.rows.keys()]).toEqual(["k-fresh"])
  })

  it("zwraca licznik skasowanych wierszy, gdy sterownik go poda (do logu joba)", async () => {
    const withCount: ReplayGuardDb = { raw: async () => ({ rowCount: 7 }) }
    const withoutCount: ReplayGuardDb = { raw: async () => [] }

    await expect(inMarket(() => purgeExpiredReplayGuardRows(withCount, 1_800_000_000))).resolves.toBe(7)
    // Brak licznika NIE jest błędem — sprzątanie nie decyduje o poprawności.
    await expect(
      inMarket(() => purgeExpiredReplayGuardRows(withoutCount, 1_800_000_000))
    ).resolves.toBeNull()
  })

  it("jest osobną operacją: bariera nie woła jej i nie zależy od jej wykonania", async () => {
    // Dowód „niezależności werdyktu od sprzątacza" w wersji wykonanej leży w
    // evidence/5-3/replay-guard-postgres-proof.out krok [5]: wpis PO wygaśnięciu
    // przepuszcza, choć NIC go nie skasowało. Tutaj tylko potwierdzamy, że
    // sprzątanie jest oddzielnym stwierdzeniem DELETE, a nie częścią bariery.
    const db = countingDb(0)
    await inMarket(() => purgeExpiredReplayGuardRows(db, 1_800_000_000))

    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql.trim().toUpperCase().startsWith("DELETE")).toBe(true)
  })

  it("bariera NIE wywołuje sprzątania po drodze", async () => {
    const db = countingDb(1)
    await claimReplayGuardKey(db, {
      guardKeys: ["k1"],
      sellerId: "s",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })
    expect(db.calls.every((c) => !c.sql.toUpperCase().includes("DELETE"))).toBe(true)
  })
})
