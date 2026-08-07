/**
 * v1.15.0 Story 4.1 — bariera idempotencji wysyłki wykonana przez SAM MODUŁ na
 * REALNYM Postgresie, przez REALNY sterownik (`knex.raw`).
 *
 * ── Po co ten plik istnieje ────────────────────────────────────────────────
 * Bo atrapa bariery nie jest Postgresem. Ścieżka
 * `PgDispatchIdempotencyBarrier.claim` → `toKnexPositionalSql` →
 * `knex.raw(text, bindings)` → KSZTAŁT WYNIKU → `returnedRows` musi zostać
 * WYKONANA, a nie odwzorowana: `returnedRows` zwraca pustą tablicę dla
 * nierozpoznanego kształtu, a pusta tablica znaczy ZABLOKOWANE — czyli przy
 * niespodziance w kształcie wyniku KAŻDA wysyłka byłaby odrzucana, wykrywalnie
 * dopiero na środowisku z bazą.
 *
 * ── DDL nie jest tu przepisany ─────────────────────────────────────────────
 * Tabela powstaje z tej samej klasy migracji, która idzie na środowiska
 * (`Migration1779002000000`), przez przechwycenie jej `addSql`. Kopia DDL
 * w teście byłaby dokładnie tym defektem, który ten plik zamyka.
 *
 * ── Co znaczy tutaj „druga instancja" (AC5) ────────────────────────────────
 * DWIE ODRĘBNE PULE POŁĄCZEŃ i dwa niezależnie zbudowane zestawy obiektów
 * (bariera + gateway + provider), dzielące JEDNĄ bazę. To NIE jest dwukrotne
 * wywołanie tego samego obiektu — i właśnie ta różnica jest przedmiotem
 * pomiaru. Kontrola kontroli jest WYKONANA: ostatni `describe` odtwarza
 * topologię stanu PER INSTANCJA i pokazuje, że przy niej idą DWA maile.
 *
 * ── Uruchomienie ───────────────────────────────────────────────────────────
 *   DATABASE_URL=postgres://… pnpm test:integration:dispatch-barrier-pg
 * Bez `DATABASE_URL` suita jest POMIJANA (`describe.skip`) — nie „zielona".
 * Kieruj wyłącznie na IZOLOWANĄ bazę testową: test tworzy i kasuje tabele.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import {
  DefaultMessagingGateway,
  MessagingProviderError,
  type IMessagingProvider,
  type NotificationIntent,
} from "@gp/messaging"

import {
  BARRIER_AMBIGUOUS_WINDOW_MS,
  BARRIER_IN_FLIGHT_WINDOW_MS,
  MESSAGING_DISPATCH_BARRIER_TABLE,
  PgDispatchIdempotencyBarrier,
} from "../../lib/messaging-dispatch-barrier"
import { Migration1779002000000 } from "../../modules/voucher/migrations/1779002000000_create_messaging_dispatch_barrier"
import { Migration1778933000000 } from "../../modules/voucher/migrations/1778933000000_create_voucher_delivery_dispatch"
import { Migration1778935000000 } from "../../modules/voucher/migrations/1778935000000_preserve_voucher_delivery_first_failure"
import { Migration1778936000000 } from "../../modules/voucher/migrations/1778936000000_limit_voucher_delivery_configuration_recovery"
import { Migration1778937000000 } from "../../modules/voucher/migrations/1778937000000_add_provider_response_to_voucher_delivery_dispatch"
import { Migration1778938000000 } from "../../modules/voucher/migrations/1778938000000_add_correlation_token_to_voucher_delivery_dispatch"
import { Migration1778939000000 } from "../../modules/voucher/migrations/1778939000000_add_voucher_delivery_provider_error_kind"
import {
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const T0 = new Date("2026-08-06T09:00:00.000Z")
const BARRIER_KEY = "bonbeauty|voucher_purchase_delivery|email|entitlement-1"

type MigrationLike = { up(): Promise<void>; down(): Promise<void> }
/**
 * Konstruktor klasy migracji MikroORM wymaga sterownika i konfiguracji, których
 * tu świadomie NIE mamy — instancję tworzymy przez `Object.create(prototype)`,
 * więc interesuje nas wyłącznie prototyp. Ten typ opisuje dokładnie to.
 */
type MigrationCtor = { prototype: MigrationLike }

/** Zbiera SQL migracji bez uruchamiania silnika migracji MikroORM. */
async function migrationSql(
  ctor: MigrationCtor,
  direction: "up" | "down",
): Promise<string[]> {
  const collected: string[] = []
  const instance = Object.create(ctor.prototype) as MigrationLike & {
    addSql: (sql: string) => void
  }
  instance.addSql = (sql: string) => {
    collected.push(sql)
  }
  await instance[direction]()
  return collected
}

function makeIntent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    flow_id: "voucher_purchase_delivery",
    channel: "email",
    template_key: "voucher_purchase_confirmation",
    recipient: { email: "marta@example.com", market_id: "bonbeauty" },
    variables: {},
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "entitlement-1",
    ...overrides,
  }
}

function countingProvider(): IMessagingProvider & { calls: () => number } {
  let calls = 0
  return {
    key: "brevo",
    calls: () => calls,
    send: async () => {
      calls += 1
      return { dispatch_id: `dispatch-${calls}`, status: "sent" as const }
    },
  }
}

runOrSkip("Story 4.1 — bariera dostawy na REALNYM Postgresie (knex.raw)", () => {
  let db: Knex

  beforeAll(async () => {
    db = knexFactory({
      client: "pg",
      connection: DATABASE_URL as string,
      pool: { min: 0, max: 4 },
    })
    for (const sql of await migrationSql(Migration1779002000000, "up")) {
      await db.raw(sql)
    }
    // Ledger wiersza skutku jest potrzebny do kontroli AC2 (wariant (a)) —
    // zakładany CAŁYM łańcuchem swoich migracji, w kolejności stempli, a nie
    // przepisanym DDL-em. Kolumny dokładane później (`first_error_code`,
    // `provider_status_code`, …) są odczytywane przez `SELECT_COLUMNS` ledgera,
    // więc pominięcie któregokolwiek kroku wywraca `reserveDispatch`.
    for (const migration of [
      Migration1778933000000,
      Migration1778935000000,
      Migration1778936000000,
      Migration1778937000000,
      Migration1778938000000,
      Migration1778939000000,
    ]) {
      for (const sql of await migrationSql(migration, "up")) {
        await db.raw(sql)
      }
    }
  })

  afterAll(async () => {
    if (!db) return
    await db.raw(`DROP TABLE IF EXISTS ${VOUCHER_DELIVERY_DISPATCH_TABLE}_audit`)
    await db.raw(`DROP TABLE IF EXISTS ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)
    for (const sql of await migrationSql(Migration1779002000000, "down")) {
      await db.raw(sql)
    }
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw(`TRUNCATE ${MESSAGING_DISPATCH_BARRIER_TABLE}`)
    await db.raw(`TRUNCATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}_audit`)
    await db.raw(`TRUNCATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)
  })

  describe("AC5 — migracja jest URUCHOMIONA, nie tylko napisana", () => {
    it("up() zakłada ograniczenie unikalności, na którym stoi bariera", async () => {
      const { rows } = await db.raw(
        `SELECT conname, contype FROM pg_constraint
          WHERE conrelid = '${MESSAGING_DISPATCH_BARRIER_TABLE}'::regclass AND contype = 'p'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].conname).toBe(`${MESSAGING_DISPATCH_BARRIER_TABLE}_pkey`)
    })

    it("down() zdejmuje dokładnie to, co założył up() — i up() wraca", async () => {
      for (const sql of await migrationSql(Migration1779002000000, "down")) {
        await db.raw(sql)
      }
      const { rows: gone } = await db.raw(
        `SELECT to_regclass('public.${MESSAGING_DISPATCH_BARRIER_TABLE}') AS reg`,
      )
      expect(gone[0].reg).toBeNull()

      for (const sql of await migrationSql(Migration1779002000000, "up")) {
        await db.raw(sql)
      }
      const { rows: back } = await db.raw(
        `SELECT to_regclass('public.${MESSAGING_DISPATCH_BARRIER_TABLE}') AS reg`,
      )
      expect(back[0].reg).not.toBeNull()
    })
  })

  describe("AC1 — trzy werdykty rozstrzyga SAMA BAZA", () => {
    it("wolny → ZAJĘTE; żywy → ZABLOKOWANE; wygasły → ZAJĘTE", async () => {
      const barrier = new PgDispatchIdempotencyBarrier(db)
      const windowMs = 60_000

      const first = await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: T0,
        in_flight_window_ms: windowMs,
        claim_token: "tok-1",
      })
      expect(first.outcome).toBe("claimed")

      const inside = await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: new Date(T0.getTime() + windowMs - 1),
        in_flight_window_ms: windowMs,
        claim_token: "tok-1",
      })
      expect(inside.outcome).toBe("blocked")

      const after = await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: new Date(T0.getTime() + windowMs),
        in_flight_window_ms: windowMs,
        claim_token: "tok-1",
      })
      expect(after.outcome).toBe("claimed")

      // Żaden proces sprzątający nie odpalił się w międzyczasie — wygasanie
      // zrobił WYŁĄCZNIE predykat `WHERE` (AC4).
      const { rows } = await db.raw(
        `SELECT count(*)::int AS n FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}`,
      )
      expect(rows[0].n).toBe(1)
    })

    it("rozstrzygnięcie BEZTERMINOWE nie wygasa NIGDY", async () => {
      const barrier = new PgDispatchIdempotencyBarrier(db)
      await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: T0,
        in_flight_window_ms: 1_000,
        claim_token: "tok-1",
      })
      await barrier.settle({
        barrier_key: BARRIER_KEY,
        claim_token: "tok-1",
        dispatch: { dispatch_id: "d-1", provider: "brevo", status: "sent" } as never,
        expires_at: null,
      })

      const muchLater = await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: new Date(T0.getTime() + 100 * BARRIER_AMBIGUOUS_WINDOW_MS),
        in_flight_window_ms: 1_000,
        claim_token: "tok-1",
      })

      expect(muchLater.outcome).toBe("blocked")
      // Wynik poprzedniego przebiegu wraca — ponowienie dostaje tę samą
      // odpowiedź, a nie błąd.
      expect(muchLater.dispatch).toMatchObject({ dispatch_id: "d-1", status: "sent" })
    })

    it("zwolnienie po porażce PRE-FLIGHT otwiera drogę ponowieniu", async () => {
      const barrier = new PgDispatchIdempotencyBarrier(db)
      await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: T0,
        in_flight_window_ms: 600_000,
        claim_token: "tok-1",
      })
      await barrier.release({ barrier_key: BARRIER_KEY, claim_token: "tok-1" })

      const retry = await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: new Date(T0.getTime() + 1_000),
        in_flight_window_ms: 600_000,
        claim_token: "tok-1",
      })
      expect(retry.outcome).toBe("claimed")
    })

    it("zwolnienie NIE rusza zajęcia ROZSTRZYGNIĘTEGO", async () => {
      const barrier = new PgDispatchIdempotencyBarrier(db)
      await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: T0,
        in_flight_window_ms: 600_000,
        claim_token: "tok-1",
      })
      await barrier.settle({
        barrier_key: BARRIER_KEY,
        claim_token: "tok-1",
        dispatch: { dispatch_id: "d-1", provider: "brevo", status: "sent" } as never,
        expires_at: null,
      })
      await barrier.release({ barrier_key: BARRIER_KEY, claim_token: "tok-1" })

      const { rows } = await db.raw(
        `SELECT count(*)::int AS n FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}`,
      )
      expect(rows[0].n).toBe(1)
    })
  })

  describe("R-4.1-M3 — PRZEJĘCIE zajęcia: spóźniony proces nie rusza cudzego wiersza", () => {
    it("spóźniony `release` procesu A NIE kasuje zajęcia przejętego przez B", async () => {
      // Scenariusz duplikatu bez tokenu: A zajmuje klucz i wisi dłużej niż okno;
      // B przejmuje zajęcie i woła providera; spóźniony `release` procesu A
      // widzi wiersz w stanie `in_flight` (to zajęcie B!), kasuje go, a trzeci
      // przebieg zajmuje wolny klucz i wysyła DRUGI MAIL.
      const barrier = new PgDispatchIdempotencyBarrier(db)

      await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: T0,
        in_flight_window_ms: 60_000,
        claim_token: "tok-A",
      })

      // Po wygaśnięciu okna B PRZEJMUJE zajęcie — wiersz jest znowu `in_flight`.
      const takeover = await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: new Date(T0.getTime() + 61_000),
        in_flight_window_ms: 60_000,
        claim_token: "tok-B",
      })
      expect(takeover.outcome).toBe("claimed")

      // Spóźniony `release` procesu A.
      await barrier.release({ barrier_key: BARRIER_KEY, claim_token: "tok-A" })

      // Zajęcie B MUSI przeżyć — inaczej kolejny przebieg wysłałby drugi mail
      // w czasie, gdy B jest wciąż w locie.
      const { rows } = await db.raw(
        `SELECT claim_token, state FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}
          WHERE barrier_key = ?`,
        [BARRIER_KEY],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].claim_token).toBe("tok-B")
      expect(rows[0].state).toBe("in_flight")
    })

    it("spóźniony `settle` procesu A NIE nadpisuje rozstrzygnięcia B", async () => {
      // Bez warunku na token spóźnione domknięcie A zamieniało barierę
      // BEZTERMINOWĄ (mail B poszedł) na okno 8 dni — czyli po tym oknie
      // ponowienie wysyłałoby drugi mail.
      const barrier = new PgDispatchIdempotencyBarrier(db)

      await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: T0,
        in_flight_window_ms: 60_000,
        claim_token: "tok-A",
      })
      await barrier.claim({
        barrier_key: BARRIER_KEY,
        now: new Date(T0.getTime() + 61_000),
        in_flight_window_ms: 60_000,
        claim_token: "tok-B",
      })

      // B kończy sukcesem: bariera BEZTERMINOWA.
      await barrier.settle({
        barrier_key: BARRIER_KEY,
        claim_token: "tok-B",
        dispatch: { dispatch_id: "d-B", provider: "brevo", status: "sent" } as never,
        expires_at: null,
      })

      // Spóźnione domknięcie A — porażka niejednoznaczna, okno 8 dni.
      await barrier.settle({
        barrier_key: BARRIER_KEY,
        claim_token: "tok-A",
        dispatch: { dispatch_id: "d-A", provider: "brevo", status: "failed" } as never,
        expires_at: new Date(T0.getTime() + 8 * 24 * 60 * 60 * 1000),
      })

      const { rows } = await db.raw(
        `SELECT dispatch, expires_at FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}
          WHERE barrier_key = ?`,
        [BARRIER_KEY],
      )
      // Rozstrzygnięcie B stoi, a bariera pozostaje BEZTERMINOWA.
      expect(rows[0].dispatch.dispatch_id).toBe("d-B")
      expect(rows[0].expires_at).toBeNull()
    })
  })

  describe("AC5 — DWIE INSTANCJE, jedna baza", () => {
    it("kontrola NEGATYWNA: to samo zdarzenie → JEDNO wywołanie providera", async () => {
      // Dwie ODRĘBNE pule połączeń = dwa procesy z punktu widzenia bazy.
      const dbA = knexFactory({
        client: "pg",
        connection: DATABASE_URL as string,
        pool: { min: 0, max: 2 },
      })
      const dbB = knexFactory({
        client: "pg",
        connection: DATABASE_URL as string,
        pool: { min: 0, max: 2 },
      })
      try {
        const providerA = countingProvider()
        const providerB = countingProvider()
        const instanceA = new DefaultMessagingGateway({ brevo: providerA }, "brevo", {
          barrier: new PgDispatchIdempotencyBarrier(dbA),
          clock: () => T0,
          barrierInFlightWindowMs: BARRIER_IN_FLIGHT_WINDOW_MS,
        })
        const instanceB = new DefaultMessagingGateway({ brevo: providerB }, "brevo", {
          barrier: new PgDispatchIdempotencyBarrier(dbB),
          clock: () => T0,
          barrierInFlightWindowMs: BARRIER_IN_FLIGHT_WINDOW_MS,
        })

        await instanceA.send(makeIntent())
        await instanceB.send(makeIntent())

        expect(providerA.calls() + providerB.calls()).toBe(1)
      } finally {
        await dbA.destroy()
        await dbB.destroy()
      }
    })

    it("KONTROLA KONTROLI: przy stanie PER INSTANCJA idą DWA maile", async () => {
      // Gdyby ten przypadek nie failował na starej topologii, poprzedni nie
      // mierzyłby cross-instance. Odtwarzamy mapę w pamięci procesu.
      const perInstanceState = () => {
        const rows = new Map<string, number | null>()
        return {
          claim: async (input: {
            barrier_key: string
            now: Date
            in_flight_window_ms: number
          }) => {
            const existing = rows.get(input.barrier_key)
            const free =
              existing === undefined ||
              (existing !== null && existing <= input.now.getTime())
            rows.set(input.barrier_key, input.now.getTime() + input.in_flight_window_ms)
            return free
              ? ({ outcome: "claimed", dispatch: null } as const)
              : ({ outcome: "blocked", dispatch: null } as const)
          },
          settle: async () => {},
          release: async () => {},
        }
      }
      const providerA = countingProvider()
      const providerB = countingProvider()
      const instanceA = new DefaultMessagingGateway({ brevo: providerA }, "brevo", {
        barrier: perInstanceState(),
        clock: () => T0,
      })
      const instanceB = new DefaultMessagingGateway({ brevo: providerB }, "brevo", {
        barrier: perInstanceState(),
        clock: () => T0,
      })

      await instanceA.send(makeIntent())
      await instanceB.send(makeIntent())

      expect(providerA.calls() + providerB.calls()).toBe(2)
    })

    it("kontrola DODATNIA: RÓŻNE zdarzenia przechodzą na obu instancjach", async () => {
      const providerA = countingProvider()
      const providerB = countingProvider()
      const instanceA = new DefaultMessagingGateway({ brevo: providerA }, "brevo", {
        barrier: new PgDispatchIdempotencyBarrier(db),
        clock: () => T0,
      })
      const instanceB = new DefaultMessagingGateway({ brevo: providerB }, "brevo", {
        barrier: new PgDispatchIdempotencyBarrier(db),
        clock: () => T0,
      })

      await instanceA.send(makeIntent({ idempotency_key: "entitlement-1" }))
      await instanceB.send(makeIntent({ idempotency_key: "entitlement-2" }))
      await instanceB.send(
        makeIntent({
          idempotency_key: "entitlement-1",
          template_key: "voucher_appointment_confirmation",
          flow_id: "voucher_appointment",
        }),
      )

      // Bariera nie tylko odmawia — przepuszcza legalnie różne wysyłki.
      expect(providerA.calls()).toBe(1)
      expect(providerB.calls()).toBe(2)
    })

    it("WYŚCIG: N równoległych zajęć tego samego klucza daje DOKŁADNIE JEDNO", async () => {
      const barrier = new PgDispatchIdempotencyBarrier(db)
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          barrier.claim({
            barrier_key: BARRIER_KEY,
            now: T0,
            in_flight_window_ms: 600_000,
            claim_token: "tok-1",
          }),
        ),
      )
      expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1)
    })
  })

  describe("AC3 — klasyfikacja porażek przeżywa przeniesienie na warstwę trwałą", () => {
    async function sendFailing(errorCode: string, preflight: boolean): Promise<number> {
      let calls = 0
      const provider: IMessagingProvider = {
        key: "brevo",
        send: async () => {
          calls += 1
          throw new MessagingProviderError(errorCode, { error_code: errorCode, preflight })
        },
      }
      const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
        barrier: new PgDispatchIdempotencyBarrier(db),
        clock: () => T0,
        barrierAmbiguousWindowMs: BARRIER_AMBIGUOUS_WINDOW_MS,
      })
      await gateway.send(makeIntent())
      await gateway.send(makeIntent())
      return calls
    }

    it("SUKCES → ponowienie NIE woła providera", async () => {
      const provider = countingProvider()
      const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
        barrier: new PgDispatchIdempotencyBarrier(db),
        clock: () => T0,
      })
      await gateway.send(makeIntent())
      await gateway.send(makeIntent())
      expect(provider.calls()).toBe(1)
    })

    it("TIMEOUT-AFTER-SEND (niejednoznaczny) → ponowienie NIE woła providera", async () => {
      expect(await sendFailing("BREVO_TIMEOUT", false)).toBe(1)
    })

    it("FAIL PRE-FLIGHT → ponowienie WOŁA providera", async () => {
      expect(await sendFailing("BREVO_TEMPLATE_NOT_CONFIGURED", true)).toBe(2)
    })

    it("KOD NIEZNANY → zachowanie ZDEFINIOWANE: jak niejednoznaczny", async () => {
      // `preflight` domyślnie `false` (errors.ts), więc nierozpoznany kod
      // trafia tu z definicji, a nie przez `undefined`.
      const provider: IMessagingProvider = {
        key: "brevo",
        send: async () => {
          throw new MessagingProviderError("nowy kod", {
            error_code: "BREVO_SOMETHING_ENTIRELY_NEW",
          })
        },
      }
      const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
        barrier: new PgDispatchIdempotencyBarrier(db),
        clock: () => T0,
      })
      await gateway.send(makeIntent())

      const { rows } = await db.raw(
        `SELECT state, expires_at FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}
          WHERE barrier_key = ?`,
        [BARRIER_KEY],
      )
      expect(rows[0].state).toBe("settled")
      // Zamknięta na OKNO, nie bezterminowo: to była porażka, nie dostawa.
      expect(rows[0].expires_at).not.toBeNull()
    })
  })

  describe("AC2 — wariant (a): dwa przebiegi zdarzenia = jedna wysyłka i JEDEN wiersz skutku", () => {
    it("ledger rezerwuje raz, a bariera kanału przepuszcza raz", async () => {
      const ledger = new PgDispatchLedger(db, { now: () => T0 })
      const identity = {
        entitlement_id: "entitlement-1",
        template_key: "voucher_purchase_confirmation",
        recipient_hash: hashRecipientEmail("marta@example.com"),
        market_id: "bonbeauty",
        flow_id: "voucher_purchase_delivery",
        locale: "pl-PL",
      }
      const provider = countingProvider()
      const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
        barrier: new PgDispatchIdempotencyBarrier(db),
        clock: () => T0,
      })

      // Przebieg 1 i 2 TEGO SAMEGO zdarzenia — dokładnie tak, jak robi to
      // subscriber: rezerwacja wiersza skutku PRZED wysyłką, potem wysyłka.
      const outcomes: string[] = []
      for (let run = 0; run < 2; run += 1) {
        const reservation = await ledger.reserveDispatch(identity)
        outcomes.push(reservation.outcome)
        if (reservation.outcome === "reserved" || reservation.outcome === "retry_reserved") {
          await gateway.send(
            makeIntent({
              idempotency_key: `voucher-delivery:${reservation.dispatch_id}`,
            }),
          )
        }
      }

      expect(outcomes).toEqual(["reserved", "in_flight"])
      expect(provider.calls()).toBe(1)

      const { rows } = await db.raw(
        `SELECT count(*)::int AS n FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
      )
      expect(rows[0].n).toBe(1)
    })
  })
})
