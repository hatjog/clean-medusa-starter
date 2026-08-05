/**
 * v1.15.0 Story 5.3 — `lib/vendor-replay-guard` (FR-11, AD-20, AD-23, ADR-185).
 *
 * ZAKRES TEJ SUITY, I CZEGO ONA NIE DOWODZI:
 * Tu mierzymy to, co da się zmierzyć bez bazy: liczbę wysyłek do sterownika,
 * kształt wysłanego stwierdzenia, oraz własności klucza i skrótu treści.
 *
 * SEMANTYKA SAMEGO SQL-a (który wpis blokuje, a który wygasł) NIE jest tu
 * asertowana na podstawie stringów — to byłby test świecący na zielono nad
 * zepsutym kodem. Jest dowiedziona przebiegiem na REALNYM Postgresie:
 *   evidence/5-3/replay-guard-postgres-proof.{sql,out}   — 3 werdykty + oba brzegi okna
 *   evidence/5-3/replay-guard-concurrency-proof.sh       — wyścig dwóch połączeń
 */
import { describe, it, expect } from "@jest/globals"

import {
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

describe("claimReplayGuardKey — JEDNA operacja atomowa (AD-23, AC1)", () => {
  it("wysyła do bazy DOKŁADNIE JEDNO stwierdzenie na żądanie (dwie wysyłki = RED)", async () => {
    const db = countingDb(1)

    await claimReplayGuardKey(db, {
      guardKey: "k1",
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })

    expect(db.calls).toHaveLength(1)
  })

  it("w ścieżce bariery NIE MA odczytu poprzedzającego zapis dla tego samego klucza", async () => {
    const db = countingDb(1)

    await claimReplayGuardKey(db, {
      guardKey: "k1",
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
      guardKey: "k1",
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })

    const sql = db.calls[0].sql.toUpperCase()
    expect(sql).toContain("ON CONFLICT")
    expect(sql).toContain("DO UPDATE")
    // Predykat okna siedzi w stwierdzeniu — nie w kodzie po stronie Node.
    expect(sql).toContain("EXPIRES_AT <= ?")
    expect(sql).toContain("RETURNING")
  })

  it("werdykt pochodzi z LICZBY ZWRÓCONYCH WIERSZY: 1 wiersz = świeże, 0 wierszy = powtórzenie", async () => {
    const params = {
      guardKey: "k1",
      sellerId: "seller-A",
      nowSec: 1_800_000_000,
      windowSec: 660,
    }

    await expect(claimReplayGuardKey(countingDb(1), params)).resolves.toBe(true)
    await expect(claimReplayGuardKey(countingDb(0), params)).resolves.toBe(false)
  })

  it("czyta werdykt także z „gołej” tablicy Knexa, nie tylko z kształtu `{ rows }`", async () => {
    const arrayDb: ReplayGuardDb = { raw: async () => [{ guard_key: "k" }] }
    const emptyArrayDb: ReplayGuardDb = { raw: async () => [] }

    const params = { guardKey: "k1", sellerId: "s", nowSec: 1_800_000_000, windowSec: 660 }
    await expect(claimReplayGuardKey(arrayDb, params)).resolves.toBe(true)
    await expect(claimReplayGuardKey(emptyArrayDb, params)).resolves.toBe(false)
  })

  it("`expires_at` jest liczone z czasu WOŁAJĄCEGO, więc okno da się sterować bez zegara ściennego", async () => {
    const db = countingDb(1)
    const nowSec = 1_800_000_000

    await claimReplayGuardKey(db, { guardKey: "k1", sellerId: "s", nowSec, windowSec: 660 })

    const bindings = db.calls[0].bindings
    expect(bindings[2]).toBe(new Date((nowSec + 660) * 1000).toISOString())
    expect(bindings[3]).toBe(new Date(nowSec * 1000).toISOString())
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

describe("computeBodyDigest — skrót treści liczony PO STRONIE SERWERA (AC2)", () => {
  it("żądanie BEZ ciała (GET) ma ZDEFINIOWANY skrót — nie `undefined`, nie pusty człon", () => {
    expect(computeBodyDigest({})).toBe(EMPTY_BODY_DIGEST)
    expect(computeBodyDigest({ body: undefined })).toBe(EMPTY_BODY_DIGEST)
    expect(EMPTY_BODY_DIGEST).toMatch(/^[0-9a-f]{64}$/)
  })

  it("POST z ciałem `{}` jest ODRÓŻNIALNY od żądania bez ciała", () => {
    expect(computeBodyDigest({ body: {} })).not.toBe(EMPTY_BODY_DIGEST)
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

describe("purgeExpiredReplayGuardRows — HIGIENA, nie poprawność (AC3)", () => {
  it("jest osobną operacją: bariera nie woła jej i nie zależy od jej wykonania", async () => {
    // Dowód „niezależności werdyktu od sprzątacza" w wersji wykonanej leży w
    // evidence/5-3/replay-guard-postgres-proof.out krok [5]: wpis PO wygaśnięciu
    // przepuszcza, choć NIC go nie skasowało. Tutaj tylko potwierdzamy, że
    // sprzątanie jest oddzielnym stwierdzeniem DELETE, a nie częścią bariery.
    const db = countingDb(0)
    await purgeExpiredReplayGuardRows(db, 1_800_000_000)

    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql.trim().toUpperCase().startsWith("DELETE")).toBe(true)
  })

  it("bariera NIE wywołuje sprzątania po drodze", async () => {
    const db = countingDb(1)
    await claimReplayGuardKey(db, {
      guardKey: "k1",
      sellerId: "s",
      nowSec: 1_800_000_000,
      windowSec: 660,
    })
    expect(db.calls.every((c) => !c.sql.toUpperCase().includes("DELETE"))).toBe(true)
  })
})
