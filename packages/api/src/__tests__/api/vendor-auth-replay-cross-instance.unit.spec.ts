/**
 * v1.15.0 Story 5.3 — replay-guard CROSS-INSTANCE na REALNEJ TRASIE `/vendor/*`
 * (FR-11, AD-20, AD-23, NFR-1, NFR-2, ADR-185).
 *
 * ── Dlaczego przez trasę, a nie przez `verifyVendorSignature` ──────────────
 * Dowód z funkcji czystej nie jest dowodem o trasie (NFR-1). Każdy przypadek
 * niżej biegnie przez `withVendorAuth` ALBO `vendorAuthMiddleware` — dwa
 * wejścia realnie używane w produkcji (`vouchers/[code]/{redeem,lookup}`,
 * `training-cert/upload`, `middlewares/with-operator-auth.ts`).
 *
 * ── Co znaczy tutaj „druga instancja" ──────────────────────────────────────
 * DWA ODRĘBNE KONTENERY ZALEŻNOŚCI (dwa niezależnie zbudowane `req.scope`),
 * dzielące JEDNĄ bazę. To NIE jest dwukrotne wywołanie tego samego singletonu —
 * i właśnie ta różnica jest przedmiotem pomiaru. Kontrola kontroli („czy ten
 * test w ogóle mierzy cross-instance") jest WYKONANA, nie przemyślana: ostatni
 * describe odtwarza topologię starej `NonceLru` (stan PER INSTANCJA) i pokazuje,
 * że przy niej powtórzenie NIE jest wykrywane.
 *
 * ── Czego ta suita nie zastępuje ──────────────────────────────────────────
 * `SharedGuardTable` niżej odwzorowuje semantykę `INSERT … ON CONFLICT … WHERE`,
 * ale nie JEST Postgresem. Sam SQL jest dowiedziony przebiegiem na realnej
 * bazie: `evidence/5-3/replay-guard-postgres-proof.{sql,out}` (trzy werdykty,
 * oba brzegi okna, `up`/`down` migracji) oraz
 * `evidence/5-3/replay-guard-concurrency-proof.sh` (wyścig dwóch połączeń).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { buildVendorSignatureHeader } from "../../lib/vendor-hmac"
import {
  withVendorAuth,
  vendorAuthMiddleware,
  VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE,
} from "../../lib/vendor-auth"
import { VENDOR_AUTH_REPLAY_DETECTED } from "../../lib/vendor-hmac"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
} from "../../lib/vendor-secret/crypto-core"

const SELLER_A = "seller-A-uuid"
const SECRET_A = "per-vendor-secret-for-A-0123456789"
const SECRET_A_ROTATED = "per-vendor-secret-for-A-ROTATED-42"
const SHARED_SECRET = "shared-legacy-vendor-hmac-secret"

function secretSet(secretForA: string): string {
  return JSON.stringify({
    version: 1,
    entries: [
      {
        seller_id: SELLER_A,
        config_ref: "sops://infra/gp-dev/secrets/vendor-hmac.enc.yaml#seller-A",
        secret_b64: Buffer.from(secretForA, "utf8").toString("base64"),
    },
    ],
  })
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * WSPÓLNA tabela bariery — jeden obiekt, do którego sięgają OBIE instancje.
 *
 * Odwzorowuje dokładnie te trzy przypadki, które rozstrzyga stwierdzenie
 * `INSERT … ON CONFLICT (guard_key) DO UPDATE … WHERE expires_at <= $now`:
 * brak klucza → wiersz; klucz wygasły → wiersz; klucz żywy → brak wiersza.
 */
class SharedGuardTable {
  readonly rows = new Map<string, string>()
  /** Ile razy KTÓRAKOLWIEK instancja wysłała stwierdzenie do „bazy". */
  statements = 0

  raw = async (sql: string, bindings: readonly unknown[] = []): Promise<unknown> => {
    this.statements += 1

    if (sql.trim().toUpperCase().startsWith("DELETE")) {
      return { rows: [] }
    }

    const [guardKey, , expiresIso, , nowIso] = bindings as string[]
    const existing = this.rows.get(guardKey)

    // Predykat okna: wpis blokuje TYLKO dopóki nie wygasł.
    if (existing !== undefined && !(existing <= nowIso)) {
      return { rows: [] } // powtórzenie
    }

    this.rows.set(guardKey, expiresIso)
    return { rows: [{ guard_key: guardKey }] }
  }
}

type Logged = { level: string; message: string }

/**
 * Buduje ODRĘBNĄ instancję: własny kontener zależności, własny logger,
 * ale WSKAZANA baza jest współdzielona (albo nie — patrz kontrola kontroli).
 */
function buildInstance(db: { raw: SharedGuardTable["raw"] }) {
  const logged: Logged[] = []

  const buildReq = (header: string | undefined, body?: unknown) =>
    ({
      headers: header === undefined ? {} : { "x-vendor-signature": header },
      body,
      scope: {
        resolve: (key: string) => {
          if (key === "logger") {
            return {
              info: (m: string) => logged.push({ level: "info", message: m }),
              warn: (m: string) => logged.push({ level: "warn", message: m }),
              error: (m: string) => logged.push({ level: "error", message: m }),
            }
          }
          if (key === "gp_core") {
            return { resolveVendorId: (id: string) => Promise.resolve(`vendor-of-${id}`) }
          }
          // Prawdziwa stała z kontenera Medusy (`__pg_connection__`), a nie
          // wpisany z ręki string: literówka w kluczu dawałaby 503 fail-closed,
          // czyli test „przechodziłby" na nieodpalonej barierze.
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return db
          }
          return null
        },
      },
    }) as any

  const buildRes = () => {
    const captured: { status: number | null; body: any } = { status: null, body: null }
    const res: any = {
      status: (code: number) => {
        captured.status = code
        return res
      },
      json: (payload: any) => {
        captured.body = payload
        return res
      },
    }
    return { res, captured }
  }

  /** Wejście 1 na trasę: HOF `withVendorAuth`. */
  async function callViaHof(header: string | undefined, body?: unknown) {
    const { res, captured } = buildRes()
    const seen: { sellerId?: string } = {}
    const handler = jest.fn(async (req: any) => {
      seen.sellerId = req.vendorAuth?.seller_id
      res.status(200).json({ ok: true })
    })
    await withVendorAuth(handler as any)(buildReq(header, body), res, (() => {}) as any)
    return { status: captured.status, body: captured.body, logged, seen, handler }
  }

  /** Wejście 2 na trasę: standalone `vendorAuthMiddleware`. */
  async function callViaMiddleware(header: string | undefined, body?: unknown) {
    const { res, captured } = buildRes()
    const seen: { sellerId?: string } = {}
    const req = buildReq(header, body)
    const next = jest.fn(() => {
      seen.sellerId = req.vendorAuth?.seller_id
      res.status(200).json({ ok: true })
    })
    await vendorAuthMiddleware(req, res, next as any)
    return { status: captured.status, body: captured.body, logged, seen, next }
  }

  return { callViaHof, callViaMiddleware, logged }
}

describe("Story 5.3 — replay-guard cross-instance na trasie /vendor/*", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.VENDOR_HMAC_SECRET = SHARED_SECRET
    process.env.VENDOR_HMAC_ENFORCED = "true"
    process.env.VENDOR_HMAC_DRIFT_SECONDS = "300"
    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/vendor-secret-set.enc.json",
      decryptor: () => secretSet(SECRET_A),
    })
  })

  afterEach(() => {
    resetVendorSecretCryptoCore()
    process.env = { ...envBackup }
  })

  // -------------------------------------------------------------------------
  // AC4 — kontrola NEGATYWNA i DODATNIA, cross-instance, przez OBA wejścia
  // -------------------------------------------------------------------------

  it("KONTROLA NEGATYWNA: powtórzenie skierowane do DRUGIEJ instancji jest odrzucane (withVendorAuth)", async () => {
    const shared = new SharedGuardTable()
    const instance1 = buildInstance(shared)
    const instance2 = buildInstance(shared)

    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    const first = await instance1.callViaHof(header)
    expect(first.status).toBe(200)

    // To samo żądanie, INNA instancja (inny kontener zależności), ta sama baza.
    const replay = await instance2.callViaHof(header)
    expect(replay.status).toBe(401)
    expect(replay.body.code).toBe(VENDOR_AUTH_REPLAY_DETECTED)
  })

  it("KONTROLA NEGATYWNA: to samo przez drugie wejście (vendorAuthMiddleware)", async () => {
    const shared = new SharedGuardTable()
    const instance1 = buildInstance(shared)
    const instance2 = buildInstance(shared)

    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    expect((await instance1.callViaMiddleware(header)).status).toBe(200)

    const replay = await instance2.callViaMiddleware(header)
    expect(replay.status).toBe(401)
    expect(replay.body.code).toBe(VENDOR_AUTH_REPLAY_DETECTED)
  })

  it("KONTROLA NEGATYWNA: bariera działa też MIĘDZY wejściami (HOF → middleware)", async () => {
    const shared = new SharedGuardTable()
    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    expect((await buildInstance(shared).callViaHof(header)).status).toBe(200)

    const replay = await buildInstance(shared).callViaMiddleware(header)
    expect(replay.status).toBe(401)
    expect(replay.body.code).toBe(VENDOR_AUTH_REPLAY_DETECTED)
  })

  it("KONTROLA DODATNIA: świeży nonce przechodzi na OBU instancjach i ustawia req.vendorAuth.seller_id", async () => {
    const shared = new SharedGuardTable()
    const instance1 = buildInstance(shared)
    const instance2 = buildInstance(shared)

    const r1 = await instance1.callViaHof(buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec()))
    const r2 = await instance2.callViaHof(buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec()))

    expect(r1.status).toBe(200)
    expect(r1.seen.sellerId).toBe(SELLER_A)
    expect(r2.status).toBe(200)
    expect(r2.seen.sellerId).toBe(SELLER_A)
  })

  it("KONTROLA DODATNIA przez middleware: świeży nonce woła next() i ustawia kontekst", async () => {
    const shared = new SharedGuardTable()
    const r = await buildInstance(shared).callViaMiddleware(
      buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())
    )
    expect(r.status).toBe(200)
    expect(r.seen.sellerId).toBe(SELLER_A)
    expect(r.next).toHaveBeenCalled()
  })

  it("NFR-2: odmowa jest GŁOŚNA (log z kodem), a ciało NIE ujawnia więcej niż dziś", async () => {
    const shared = new SharedGuardTable()
    const instance1 = buildInstance(shared)
    const instance2 = buildInstance(shared)
    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    await instance1.callViaHof(header)
    const replay = await instance2.callViaHof(header)

    expect(
      instance2.logged.some(
        (l) => l.level === "warn" && l.message.includes(VENDOR_AUTH_REPLAY_DETECTED)
      )
    ).toBe(true)
    // Ciało: dokładnie te dwa pola, ta sama treść co przed zmianą nośnika.
    expect(Object.keys(replay.body).sort()).toEqual(["code", "message"])
    expect(replay.body.message).toBe("Vendor signature replay detected")
  })

  // -------------------------------------------------------------------------
  // AC2 — rotacja sekretu NIE otwiera okna powtórzenia (kontrola WYKONANIEM)
  // -------------------------------------------------------------------------

  it("AC2: po ROTACJI sekretu to samo żądanie nadal jest odrzucane jako powtórzenie", async () => {
    const shared = new SharedGuardTable()
    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    // 1. podpisz → wyślij → 200
    expect((await buildInstance(shared).callViaHof(header)).status).toBe(200)

    // 2. zrotuj sekret sprzedawcy w crypto-core (nowy materiał, ten sam seller)
    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/vendor-secret-set.enc.json",
      decryptor: () => secretSet(SECRET_A_ROTATED),
    })

    // 3. to samo żądanie po rotacji: podpis nie pasuje już do nowego sekretu,
    //    więc trasa odmawia — ale NIE dlatego, że klucz bariery się zmienił.
    const afterRotation = await buildInstance(shared).callViaHof(header)
    expect(afterRotation.status).toBe(401)

    // 4. Sedno AC2: klucz bariery jest NIEZALEŻNY od sekretu, więc wpis
    //    postawiony PRZED rotacją nadal blokuje po rotacji. Gdyby klucz
    //    zawierał `sig` (funkcję sekretu), rotacja dałaby NOWY klucz i tabela
    //    urosłaby o drugi wpis — czyli okno powtórzenia byłoby otwarte.
    expect(shared.rows.size).toBe(1)

    // 5. Kontrola wprost: żądanie podpisane ZROTOWANYM sekretem, o tym samym
    //    `ts` i `nonce`, ma TEN SAM klucz bariery → nadal powtórzenie, mimo że
    //    `sig` jest inny.
    const parts = header.split(":")
    const rotatedHeader = buildVendorSignatureHeader(
      SELLER_A,
      SECRET_A_ROTATED,
      Number(parts[1]),
      parts[2]
    )
    expect(rotatedHeader).not.toBe(header) // inny podpis…
    const replayWithRotatedSig = await buildInstance(shared).callViaHof(rotatedHeader)
    expect(replayWithRotatedSig.status).toBe(401)
    expect(replayWithRotatedSig.body.code).toBe(VENDOR_AUTH_REPLAY_DETECTED) // …ten sam klucz
    expect(shared.rows.size).toBe(1)
  })

  it("AC2: różne CIAŁA pod tym samym nonce nie sklejają się w jeden klucz bariery", async () => {
    const shared = new SharedGuardTable()
    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    expect((await buildInstance(shared).callViaHof(header, { amount: 100 })).status).toBe(200)
    // Inne ciało → inny skrót treści → inny klucz → przechodzi.
    expect((await buildInstance(shared).callViaHof(header, { amount: 200 })).status).toBe(200)
    // To samo ciało → ten sam klucz → powtórzenie.
    const repeat = await buildInstance(shared).callViaHof(header, { amount: 100 })
    expect(repeat.status).toBe(401)
    expect(repeat.body.code).toBe(VENDOR_AUTH_REPLAY_DETECTED)
  })

  it("AC2: GET bez ciała ma zdefiniowany, STABILNY klucz (dwa GET-y to powtórzenie, nie sklejenie)", async () => {
    const shared = new SharedGuardTable()
    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    expect((await buildInstance(shared).callViaHof(header)).status).toBe(200)
    const repeat = await buildInstance(shared).callViaHof(header)
    expect(repeat.status).toBe(401)
    expect(repeat.body.code).toBe(VENDOR_AUTH_REPLAY_DETECTED)
    expect(shared.rows.size).toBe(1)
  })

  // -------------------------------------------------------------------------
  // AC5 — kolejność: bariera DOPIERO PO weryfikacji podpisu
  // -------------------------------------------------------------------------

  it("AC5: żądanie ze ZŁYM podpisem zostawia liczbę wierszy tabeli BEZ ZMIAN", async () => {
    const shared = new SharedGuardTable()
    const goodHeader = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())
    const parts = goodHeader.split(":")
    const forgedHeader = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from("forged").toString("base64")}`

    const r = await buildInstance(shared).callViaHof(forgedHeader)

    expect(r.status).toBe(401)
    expect(shared.rows.size).toBe(0)
    // I nic nie poszło nawet do bazy — niezweryfikowany nadawca nie dotyka tabeli.
    expect(shared.statements).toBe(0)
  })

  it("AC5: żądanie z wygasłym znacznikiem czasu też nie zapisuje nic", async () => {
    const shared = new SharedGuardTable()
    const staleHeader = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec() - 10_000)

    expect((await buildInstance(shared).callViaHof(staleHeader)).status).toBe(401)
    expect(shared.statements).toBe(0)
  })

  it("AC1: na jedno UWIERZYTELNIONE żądanie przypada DOKŁADNIE JEDNA wysyłka do bazy", async () => {
    const shared = new SharedGuardTable()
    await buildInstance(shared).callViaHof(buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec()))
    expect(shared.statements).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Bariera niedostępna → FAIL-CLOSED (nie „przepuść i zaloguj")
  // -------------------------------------------------------------------------

  it("brak PG_CONNECTION w kontenerze → 503, NIE ciche przepuszczenie", async () => {
    const noDb = buildInstance(undefined as any)
    const r = await noDb.callViaHof(buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec()))

    expect(r.status).toBe(503)
    expect(r.body.code).toBe(VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE)
  })

  it("błąd stwierdzenia bariery → 503, NIE ciche przepuszczenie", async () => {
    const brokenDb = {
      raw: async () => {
        throw new Error("relation \"vendor_replay_guard\" does not exist")
      },
    }
    const r = await buildInstance(brokenDb as any).callViaHof(
      buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())
    )

    expect(r.status).toBe(503)
    expect(r.body.code).toBe(VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE)
  })
})

// ---------------------------------------------------------------------------
// KONTROLA KONTROLI (AC4) — czy te testy w ogóle mierzą cross-instance?
// ---------------------------------------------------------------------------

describe("Story 5.3 — kontrola kontroli: topologia in-process NIE przechodzi", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.VENDOR_HMAC_SECRET = SHARED_SECRET
    process.env.VENDOR_HMAC_ENFORCED = "true"
    process.env.VENDOR_HMAC_DRIFT_SECONDS = "300"
    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/vendor-secret-set.enc.json",
      decryptor: () => secretSet(SECRET_A),
    })
  })

  afterEach(() => {
    resetVendorSecretCryptoCore()
    process.env = { ...envBackup }
  })

  it("przy stanie PER INSTANCJA (topologia starej NonceLru) powtórzenie NIE jest wykrywane", async () => {
    // Dokładnie ta sama sekwencja co w kontroli negatywnej, ale KAŻDA instancja
    // dostaje WŁASNY magazyn — czyli to, czym była mapa w pamięci procesu.
    const instance1 = buildInstance(new SharedGuardTable())
    const instance2 = buildInstance(new SharedGuardTable())

    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())

    expect((await instance1.callViaHof(header)).status).toBe(200)

    // 200, nie 401. Gdyby kontrola negatywna wyżej przechodziła RÓWNIEŻ w tej
    // topologii, nie mierzyłaby cross-instance i byłaby do przepisania.
    // Ten test jest jej licznikiem kontrolnym: różnica między 401 a 200 bierze
    // się WYŁĄCZNIE ze współdzielenia magazynu.
    expect((await instance2.callViaHof(header)).status).toBe(200)
  })
})
