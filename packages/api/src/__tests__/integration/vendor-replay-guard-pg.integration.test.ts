/**
 * v1.15.0 Story 5.3 — bariera anty-replay wykonana przez SAM MODUŁ na REALNYM
 * Postgresie, przez REALNY sterownik (`knex.raw`).
 *
 * ── Po co ten plik istnieje (review cyklu 1, MEDIUM-2) ─────────────────────
 * Dowód na Postgresie z `evidence/5-3/replay-guard-postgres-proof.sql` był
 * SQL-em PRZEPISANYM 1:1 z kodu, nie przebiegiem kodu. Ścieżka
 * `claimReplayGuardKey` → `toKnexPositionalSql` → `knex.raw(text, bindings)` →
 * KSZTAŁT WYNIKU → `countReturnedRows` nie została nigdy wykonana. To ma
 * konsekwencję fail-closed, ale twardą: `countReturnedRows` zwraca 0 dla
 * nierozpoznanego kształtu, a 0 znaczy POWTÓRZENIE — czyli przy niespodziance
 * w kształcie wyniku KAŻDE żądanie `/vendor/*` dostawałoby 401 przy pierwszym
 * podejściu, wykrywalne dopiero na środowisku z bazą.
 *
 * ── Po co jeszcze (review cyklu 1, MEDIUM-1) ───────────────────────────────
 * AC3 wymaga dowodu WYKONANIEM na obu brzegach okna. Tu sterujemy `nowSec`
 * (baza czasu jest po stronie wołającego — patrz docstring modułu), więc oba
 * brzegi da się pokazać bez czekania zegarem ściennym, na prawdziwym predykacie
 * `WHERE expires_at <= $now` w prawdziwym Postgresie.
 *
 * ── DDL nie jest tu przepisany ─────────────────────────────────────────────
 * Tabela powstaje z tej samej klasy migracji, która idzie na środowiska
 * (`Migration20260816090000VendorReplayGuardTable`), przez przechwycenie jej
 * `addSql`. Kopia DDL w teście byłaby dokładnie tym defektem, który ten plik
 * zamyka.
 *
 * ── Uruchomienie ───────────────────────────────────────────────────────────
 *   DATABASE_URL=postgres://… pnpm test:integration:replay-guard-pg
 * Bez `DATABASE_URL` suita jest POMIJANA (`describe.skip`) — nie „zielona".
 * Kieruj wyłącznie na IZOLOWANĄ bazę testową: test tworzy i kasuje tabelę.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import { Migration20260816090000VendorReplayGuardTable } from "../../migrations/Migration20260816090000VendorReplayGuardTable"
import {
  buildNonceScopeKey,
  buildReplayGuardKey,
  claimReplayGuardKey,
  computeBodyDigest,
  deriveReplayGuardWindowSec,
  purgeExpiredReplayGuardRows,
  VENDOR_REPLAY_GUARD_TABLE,
} from "../../lib/vendor-replay-guard"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const T0 = 1_800_000_000
const WINDOW = deriveReplayGuardWindowSec(300) // 660 s, wartość produkcyjna
const SELLER = "seller-A-uuid"

/** Zbiera SQL migracji bez uruchamiania silnika migracji MikroORM. */
function migrationSql(direction: "up" | "down"): Promise<string[]> {
  const collected: string[] = []
  const instance = Object.create(
    Migration20260816090000VendorReplayGuardTable.prototype
  ) as Migration20260816090000VendorReplayGuardTable & {
    addSql: (sql: string) => void
  }
  instance.addSql = (sql: string) => {
    collected.push(sql)
  }
  return Promise.resolve(instance[direction]()).then(() => collected)
}

runOrSkip("Story 5.3 — replay-guard na REALNYM Postgresie (knex.raw)", () => {
  let db: Knex

  beforeAll(async () => {
    db = knexFactory({ client: "pg", connection: DATABASE_URL as string, pool: { min: 0, max: 2 } })
    for (const sql of await migrationSql("up")) {
      await db.raw(sql)
    }
  })

  afterAll(async () => {
    if (!db) {
      return
    }
    for (const sql of await migrationSql("down")) {
      await db.raw(sql)
    }
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw(`DELETE FROM ${VENDOR_REPLAY_GUARD_TABLE}`)
  })

  const claim = (guardKeys: string[], nowSec: number) =>
    claimReplayGuardKey(db as unknown as { raw: Knex["raw"] }, {
      guardKeys,
      sellerId: SELLER,
      nowSec,
      windowSec: WINDOW,
    })

  const keysFor = (nonce: string, body: unknown) => [
    buildReplayGuardKey({
      sellerId: SELLER,
      ts: String(T0),
      nonce,
      bodyDigest: computeBodyDigest({ body }),
    }),
    buildNonceScopeKey({ sellerId: SELLER, ts: String(T0), nonce }),
  ]

  it("MEDIUM-2: werdykt czytany z REALNEGO kształtu wyniku knex.raw — świeże vs powtórzenie", async () => {
    const keys = keysFor("nonce-1", { amount: 100 })

    // Gdyby `countReturnedRows` nie rozumiało kształtu, jaki oddaje ten
    // sterownik, PIERWSZE żądanie dostałoby `false` — czyli 401 na starcie.
    await expect(claim(keys, T0)).resolves.toBe(true)
    await expect(claim(keys, T0)).resolves.toBe(false)
  })

  it("MEDIUM-1 / AC3, BRZEG WEWNĘTRZNY: `T + okno − 1` to nadal POWTÓRZENIE", async () => {
    const keys = keysFor("nonce-window", {})

    await expect(claim(keys, T0)).resolves.toBe(true)
    await expect(claim(keys, T0 + WINDOW - 1)).resolves.toBe(false)
  })

  it("MEDIUM-1 / AC3, BRZEG ZEWNĘTRZNY: `T + okno` PRZECHODZI, i to BEZ sprzątacza", async () => {
    const keys = keysFor("nonce-window", {})

    await expect(claim(keys, T0)).resolves.toBe(true)
    await expect(claim(keys, T0 + WINDOW)).resolves.toBe(true)

    // Nikt niczego nie skasował — wygaszenie zrobił PREDYKAT (AD-23).
    const { rows } = await db.raw(`SELECT count(*)::int AS n FROM ${VENDOR_REPLAY_GUARD_TABLE}`)
    expect(rows[0].n).toBe(2)
  })

  it("HIGH-1: przechwycony nagłówek z INNYM ciałem jest odrzucany (nonce jednorazowy)", async () => {
    await expect(claim(keysFor("nonce-x", { amount: 100 }), T0)).resolves.toBe(true)
    // Inne ciało → inny `bodyKey`, ale TEN SAM `nonceKey` → 1 z 2 wierszy → odmowa.
    await expect(claim(keysFor("nonce-x", { amount: 200 }), T0)).resolves.toBe(false)
    // Kontrola dodatnia: świeży nonce z tym samym ciałem przechodzi.
    await expect(claim(keysFor("nonce-y", { amount: 200 }), T0)).resolves.toBe(true)
  })

  it("AD-23: to jest JEDNO stwierdzenie — dwa klucze w jednym `INSERT`, nie dwa `INSERT`-y", async () => {
    const keys = keysFor("nonce-atomic", { a: 1 })
    await claim(keys, T0)

    const { rows } = await db.raw(
      `SELECT guard_key FROM ${VENDOR_REPLAY_GUARD_TABLE} ORDER BY guard_key`
    )
    expect(rows.map((r: { guard_key: string }) => r.guard_key).sort()).toEqual([...keys].sort())
  })

  it("D5/AC5: `seller_id` i `created_at` trafiają do tabeli, a `expires_at` wyprowadza się z okna", async () => {
    await claim(keysFor("nonce-cols", {}), T0)

    const { rows } = await db.raw(
      `SELECT seller_id, expires_at FROM ${VENDOR_REPLAY_GUARD_TABLE} LIMIT 1`
    )
    expect(rows[0].seller_id).toBe(SELLER)
    expect(new Date(rows[0].expires_at).toISOString()).toBe(
      new Date((T0 + WINDOW) * 1000).toISOString()
    )
  })

  it("purge kasuje WYŁĄCZNIE wygasłe wiersze i zwraca ich liczbę", async () => {
    await claim(keysFor("nonce-old", {}), T0)
    await claim(keysFor("nonce-new", {}), T0 + WINDOW)

    const deleted = await purgeExpiredReplayGuardRows(
      db as unknown as { raw: Knex["raw"] },
      T0 + WINDOW + 1
    )
    expect(deleted).toBe(2) // dwa klucze pierwszego żądania

    const { rows } = await db.raw(`SELECT count(*)::int AS n FROM ${VENDOR_REPLAY_GUARD_TABLE}`)
    expect(rows[0].n).toBe(2) // dwa klucze drugiego żądania zostają
  })
})
