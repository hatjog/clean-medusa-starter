/**
 * on-order-placed-stripe-retry-providers.unit.spec.ts — odzysk wystawienia po
 * przegranym wyścigu `payment_intent.succeeded` × `completeCart`.
 *
 * ── Czego ten plik NIE mierzył i dlaczego to było groźne ────────────────────
 * Poprzednia wersja czytała ŹRÓDŁO subscribera przez `readFileSync` i asertowała
 * na obecności podciągów. Wszystkie przypadki przechodziły (10 PASS) w chwili,
 * gdy mechanizm był CAŁKOWICIE martwy: asercja `toContain("wep.provider = ANY(")`
 * wymuszała wręcz konstrukcję, która na produkcyjnej gałęzi dostępu do PG (Knex)
 * RZUCA `SqlDialectError` — `lib/knex-positional-sql.ts` odrzuca każdy binding
 * będący tablicą. Test mierzył tekst, więc nie mógł tego zobaczyć.
 *
 * Pomiar cytowany wcześniej w tym nagłówku („zmierzone 2026-08-10 na żywej bazie,
 * `order_01KZP63BAJ12RBRWRY41970F6P`") puszczał SQL BEZPOŚREDNIO na Postgresie,
 * z pominięciem konwertera Knexa. Pokazywał więc, że filtr `provider` zawężony do
 * `'stripe'` nic nie zwraca — i tyle. NIE walidował ścieżki, którą naprawa
 * zmienia, bo tamtędy zapytanie w ogóle nie przechodziło. Zielone stdout z takiego
 * przebiegu nie jest dowodem działania odzysku.
 *
 * ── Co mierzy ta wersja ─────────────────────────────────────────────────────
 *  1. REALNE zapytania (`FIND_DEFERRED_CAPTURES_SQL`, `MARK_DEFERRED_RESOLVED_SQL`)
 *     przepuszczone przez `toKnexPositionalSql` z bindingami z produkcyjnych
 *     builderów — kontrola, która złapałaby wariant `ANY($N)`.
 *  2. Zachowanie subscribera na MOCKOWANYM kliencie: asercje na SQL-u FAKTYCZNIE
 *     WYSŁANYM i na bindingach, nie na tekście pliku.
 * SQL nie jest tu kopiowany — test importuje te same stałe, których używa kod,
 * więc kopia nie ma jak się rozjechać z produkcją.
 */

// Story 11.1 REG-C5-001: Path Y bierze instancję wyłącznie z GP_INSTANCE_ID.
process.env.GP_INSTANCE_ID = "gp-test"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Modules } from "@medusajs/framework/utils"

import { toKnexPositionalSql } from "../../lib/knex-positional-sql"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"

jest.mock("../../workflows/entitlements/issue-entitlement", () => {
  class MissingEntitlementProfileError extends Error {}
  class VoucherIssuanceBlockedError extends Error {
    reason = "test_blocked"
    line_item_id: string | null = null
  }
  return {
    __esModule: true,
    issueEntitlementsForAllLineItems: jest.fn(async () => ({ results: [{}] })),
    MissingEntitlementProfileError,
    VoucherIssuanceBlockedError,
  }
})

jest.mock("../../workflows/entitlements/live-issue-from-payment-intent", () => ({
  __esModule: true,
  liveIssueEntitlementsWithinTx: jest.fn(),
}))

import { liveIssueEntitlementsWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"
import onOrderPlacedStripeRetry, {
  buildFindDeferredCapturesBindings,
  buildMarkDeferredResolvedBindings,
  DEFERRAL_MARKER_PROVIDERS,
  FIND_DEFERRED_CAPTURES_SQL,
  MARK_DEFERRED_RESOLVED_SQL,
} from "../../subscribers/on-order-placed-stripe-retry"

const SOURCE = readFileSync(
  join(__dirname, "../../subscribers/on-order-placed-stripe-retry.ts"),
  "utf8"
)

/**
 * Linie KODU — bez komentarzy. Poprzedni filtr odsiewał `//`, `*` i `/*`, ale
 * komentarze SQL zaczynają się od `--` i przechodziły przez sito, więc asercja
 * „w kodzie nie ma literału" mogła przejść na prozie albo na niej paść.
 */
const CODE_ONLY = SOURCE.split("\n")
  .filter((line) => {
    const t = line.trim()
    return (
      t.length > 0 &&
      !t.startsWith("//") &&
      !t.startsWith("*") &&
      !t.startsWith("/*") &&
      !t.startsWith("--")
    )
  })
  .join("\n")

/**
 * Przepuszcza REALNE zapytanie przez konwerter Knexa. To jest kontrola, której
 * brakowało: `toKnexPositionalSql` rzuca na bindingu tablicowym, na surowym `?`
 * w SQL-u i na placeholderze bez wartości.
 */
function convertOrThrow(sql: string, values: unknown[]) {
  const converted = toKnexPositionalSql(sql, values)
  const placeholders = sql.match(/\$\d+/g) ?? []
  expect(converted.bindings.length).toBe(placeholders.length)
  expect(converted.text).not.toMatch(/\$\d+/)
  expect(converted.text.split("?").length - 1).toBe(placeholders.length)
  return converted
}

describe("odzysk wystawienia — zapytania przechodzą przez konwerter Knexa", () => {
  it("SELECT nie rzuca i ma zgodną liczbę bindingów", () => {
    const values = buildFindDeferredCapturesBindings("order_1")
    // Kontrola dodatnia sedna naprawy: przywrócenie `provider = ANY($2)` z
    // bindingiem tablicowym pęka TUTAJ, na `SqlDialectError`.
    const converted = convertOrThrow(FIND_DEFERRED_CAPTURES_SQL, values)
    // `$1` (order_id) występuje dwukrotnie — raz w `opc.order_id`, raz przy
    // wykluczeniu domknięcia per para. Konwerter rozwija po WYSTĄPIENIACH.
    expect(converted.bindings.filter((b) => b === "order_1")).toHaveLength(2)
    expect(values.some((v) => Array.isArray(v))).toBe(false)
  })

  it("UPDATE nie rzuca i ma zgodną liczbę bindingów", () => {
    const values = buildMarkDeferredResolvedBindings(
      "evt_1",
      "2026-08-10T00:00:00.000Z",
      "order_1"
    )
    convertOrThrow(MARK_DEFERRED_RESOLVED_SQL, values)
    expect(values.some((v) => Array.isArray(v))).toBe(false)
  })

  it("liczba placeholderów providerów wynika z DŁUGOŚCI listy, nie z literału", () => {
    const n = DEFERRAL_MARKER_PROVIDERS.length
    const selectList = DEFERRAL_MARKER_PROVIDERS.map((_p, i) => `$${i + 2}`).join(", ")
    const updateList = DEFERRAL_MARKER_PROVIDERS.map((_p, i) => `$${i + 4}`).join(", ")
    expect(FIND_DEFERRED_CAPTURES_SQL).toContain(`wep.provider IN (${selectList})`)
    expect(MARK_DEFERRED_RESOLVED_SQL).toContain(`provider IN (${updateList})`)
    expect(buildFindDeferredCapturesBindings("o").length).toBe(1 + n)
    expect(buildMarkDeferredResolvedBindings("e", "t", "o").length).toBe(3 + n)
  })
})

describe("odzysk wystawienia — lista providerów", () => {
  it("zna OBA pokolenia mechanizmu", () => {
    // v1.9.0 — `workflows/payment/stripe-payment-audit.ts`
    expect(DEFERRAL_MARKER_PROVIDERS).toContain("stripe")
    // v1.15.0 — route Path Y przy przegranym wyścigu
    expect(DEFERRAL_MARKER_PROVIDERS).toContain(STRIPE_PATH_Y_WEBHOOK_PROVIDER)
    expect(STRIPE_PATH_Y_WEBHOOK_PROVIDER).toBe("stripe_payment_intent_webhook")
  })

  it("SELECT i UPDATE używają TEJ SAMEJ listy, nie literału", () => {
    // Kontrola dodatnia: przywrócenie `provider = 'stripe'` w którejkolwiek
    // klauzuli pęka tutaj, zanim zdąży wyprodukować podwójne wystawianie.
    expect(CODE_ONLY).not.toContain("provider = 'stripe'")
    expect(FIND_DEFERRED_CAPTURES_SQL).not.toContain("'stripe'")
    expect(MARK_DEFERRED_RESOLVED_SQL).not.toContain("'stripe'")
    // Obie klauzule biorą wartości z tego samego źródła — sprawdzone przez
    // bindingi, nie przez liczenie wystąpień identyfikatora w pliku.
    expect(buildFindDeferredCapturesBindings("o").slice(1)).toEqual(
      DEFERRAL_MARKER_PROVIDERS
    )
    expect(buildMarkDeferredResolvedBindings("e", "t", "o").slice(3)).toEqual(
      DEFERRAL_MARKER_PROVIDERS
    )
  })

  it("`DEFERRAL_MARKER_PROVIDERS` leży PRZED zapytaniami (TDZ)", () => {
    // Placeholdery generują się z długości listy w czasie inicjalizacji modułu.
    // Deklaracja poniżej zapytań dałaby `Cannot access before initialization`.
    const decl = CODE_ONLY.indexOf("const DEFERRAL_MARKER_PROVIDERS")
    const select = CODE_ONLY.indexOf("FIND_DEFERRED_CAPTURES_SQL")
    const update = CODE_ONLY.indexOf("MARK_DEFERRED_RESOLVED_SQL")
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(select)
    expect(decl).toBeLessThan(update)
  })
})

describe("odzysk wystawienia — kształt zapytania", () => {
  it("wymaga markera deferral", () => {
    expect(FIND_DEFERRED_CAPTURES_SQL).toContain(
      "jsonb_exists(wep.envelope, 'entitlement_issue_deferred_reason')"
    )
  })

  it("NIE używa jsonb-owego operatora `?` (kolizja z placeholderem Knexa)", () => {
    expect(FIND_DEFERRED_CAPTURES_SQL).not.toContain("?")
    expect(MARK_DEFERRED_RESOLVED_SQL).not.toContain("?")
  })

  it("wyprowadza market_id z zamówienia w kolejności ścieżki głównej", () => {
    // Ślad Path Y niesie `wep.market_id = NULL` (metadata PI mają tylko
    // `session_id`), a konsument jest fail-closed. Kolejność MUSI być ta sama co
    // w `lib/payment/stripe-payment-intent-link.ts`.
    const marketIdx = FIND_DEFERRED_CAPTURES_SQL.indexOf("wep.market_id,")
    const gpIdx = FIND_DEFERRED_CAPTURES_SQL.indexOf("o.metadata->'gp'->>'market_id'")
    const flatIdx = FIND_DEFERRED_CAPTURES_SQL.indexOf("o.metadata->>'market_id'")
    const scIdx = FIND_DEFERRED_CAPTURES_SQL.indexOf("sc.metadata->>'gp_market_id'")
    expect(marketIdx).toBeGreaterThan(-1)
    expect(gpIdx).toBeGreaterThan(marketIdx)
    expect(flatIdx).toBeGreaterThan(gpIdx)
    expect(scIdx).toBeGreaterThan(flatIdx)
    expect(FIND_DEFERRED_CAPTURES_SQL).toContain('LEFT JOIN "order" o')
    expect(FIND_DEFERRED_CAPTURES_SQL).toContain("LEFT JOIN sales_channel sc")
  })
})

// ── testy zachowania: mockowany klient, asercje na WYSŁANYM SQL-u ────────────

type SentQuery = { sql: string; values: unknown[] }

type DeferredRow = {
  event_id: string
  provider: string
  market_id: string | null
  envelope: Record<string, unknown>
  amount: number | null
  currency_code: string | null
  payment_id: string | null
  payment_intent_id: string | null
}

function makeRow(overrides: Partial<DeferredRow> = {}): DeferredRow {
  return {
    event_id: "evt_1#deferred-issuance",
    provider: "stripe",
    market_id: "bonbeauty",
    envelope: { entitlement_issue_deferred_reason: "webhook_before_order" },
    amount: 25000,
    currency_code: "pln",
    payment_id: "pay_1",
    payment_intent_id: "pi_1",
    ...overrides,
  }
}

/** SQL podnoszący ISSUED → ACTIVE po odzysku Path Y (guard w predykacie). */
const ACTIVATION_SQL_MARKER = "SET state = 'ACTIVE'"

/**
 * `activation: "noop"` odwzorowuje wiersz, którego UPDATE NIE dotknął (replay
 * `order.placed` po redempcji) — 0 wierszy w `RETURNING`.
 */
function makeHarness(
  rows: DeferredRow[],
  options: { activation?: "applied" | "noop" } = {}
) {
  const sent: SentQuery[] = []
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      sent.push({ sql, values })
      if (sql === FIND_DEFERRED_CAPTURES_SQL) {
        return { rows, rowCount: rows.length }
      }
      if (sql.includes(ACTIVATION_SQL_MARKER)) {
        const applied = (options.activation ?? "applied") === "applied"
        return applied
          ? { rows: [{ id: values[0] }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: jest.fn(),
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
  const container = {
    logger,
    resolve: (key: string) => {
      if (key === "__pg_pool__") return { connect: async () => client }
      if (key === "logger") return logger
      if (key === Modules.EVENT_BUS) return eventBus
      throw new Error(`unexpected resolve(${key})`)
    },
  }
  return { sent, client, logger, eventBus, container }
}

async function run(container: unknown, data: Record<string, unknown>) {
  await (onOrderPlacedStripeRetry as unknown as (args: unknown) => Promise<void>)({
    event: { data },
    container,
  })
}

describe("odzysk wystawienia — zachowanie na mockowanym kliencie", () => {
  it("SELECT idzie z bindingami skalarnymi: order_id + providerzy", async () => {
    const h = makeHarness([])
    await run(h.container, { id: "order_1" })

    const select = h.sent.find((q) => q.sql === FIND_DEFERRED_CAPTURES_SQL)
    expect(select).toBeDefined()
    expect(select!.values).toEqual(["order_1", ...DEFERRAL_MARKER_PROVIDERS])
    expect(select!.values.some((v) => Array.isArray(v))).toBe(false)
  })

  it("UPDATE niesie predykat deferral — nie stempluje wiersza REZERWACJI", async () => {
    // Rezerwacja transportu Path Y ma TO SAMO `event_id` i tę samą wartość
    // `provider`. Bez predykatu UPDATE trafiał także w nią.
    const h = makeHarness([makeRow()])
    await run(h.container, { id: "order_1" })

    const update = h.sent.find((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)
    expect(update).toBeDefined()
    expect(update!.sql).toContain(
      "jsonb_exists(envelope, 'entitlement_issue_deferred_reason')"
    )
    expect(update!.values[0]).toBe("evt_1#deferred-issuance")
    expect(update!.values.slice(3)).toEqual(DEFERRAL_MARKER_PROVIDERS)
  })

  it("domknięcie jest PER PARA (event_id, order_id) — multi-seller nie gubi wystawienia", async () => {
    // Jeden PaymentIntent → N zamówień (Mercur dzieli checkout per seller,
    // ADR-166), ślad JEDEN. Skalarny stempel zabierał wystawienie drugiemu
    // i każdemu kolejnemu sprzedawcy.
    const h = makeHarness([makeRow()])
    await run(h.container, { order_ids: ["order_a", "order_b"] })

    const updates = h.sent.filter((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)
    expect(updates).toHaveLength(2)
    expect(updates.map((q) => q.values[2])).toEqual(["order_a", "order_b"])
    // Nośnikiem domknięcia jest TABLICA; skalarny stempel zostaje dla zgodności
    // wstecz jako „ostatnie domknięcie".
    expect(updates[0].sql).toContain("'entitlement_issue_resolved_orders'")
    expect(updates[0].sql).toContain("to_jsonb($3::text)")
    expect(updates[0].sql).toContain("'entitlement_issue_resolved_at', $2::text")
    expect(updates[0].sql).toContain("'entitlement_issue_resolved_reason'")
  })

  it("SELECT wyklucza ślad tylko dla BIEŻĄCEGO zamówienia + zgodność wstecz", async () => {
    const h = makeHarness([])
    await run(h.container, { id: "order_1" })
    const select = h.sent.find((q) => q.sql === FIND_DEFERRED_CAPTURES_SQL)!

    // Wykluczenie per para — binding `$1` to order_id, nie globalny stempel.
    const flat = select.sql.replace(/\s+/g, " ")
    expect(flat).toContain(
      "AND NOT jsonb_exists( COALESCE(wep.envelope->'entitlement_issue_resolved_orders', '[]'::jsonb), $1 )"
    )
    // Ślady sprzed tej zmiany: `resolved_at` BEZ `resolved_orders` = domknięte
    // pod starą semantyką, zostają wykluczone.
    expect(select.sql).toContain(
      "jsonb_exists(wep.envelope, 'entitlement_issue_resolved_at')"
    )
    expect(select.sql).toContain(
      "AND NOT jsonb_exists(wep.envelope, 'entitlement_issue_resolved_orders')"
    )
  })

  it("wyklucza płatność ANULOWANĄ i ZWRÓCONĄ — brak kodu bez pokrycia", async () => {
    const h = makeHarness([])
    await run(h.container, { id: "order_1" })
    const select = h.sent.find((q) => q.sql === FIND_DEFERRED_CAPTURES_SQL)!

    expect(select.sql).toContain("p.canceled_at IS NULL")
    expect(select.sql).toContain("FROM refund r")
    expect(select.sql).toContain("r.payment_id = p.id")
    expect(select.sql).toContain("r.deleted_at IS NULL")
    expect(select.sql).toContain("NOT EXISTS")
  })

  it("nie woła UPDATE, gdy nie ma czego odzyskać", async () => {
    const h = makeHarness([])
    await run(h.container, { id: "order_1" })
    expect(h.sent.some((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)).toBe(false)
  })

  it("dla markera Path Y wraca do ISSUED i emituje genezę Path Y, nie captured ACTIVE", async () => {
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockResolvedValueOnce({
      event_processed: true,
      issued: [
        {
          entitlement_id: `ent_${"a".repeat(64)}`,
          entitlement_dedupe_key: "a".repeat(64),
          created: true,
        },
      ],
    })
    const h = makeHarness([
      makeRow({
        provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
        envelope: {
          entitlement_issue_deferred_reason: "webhook_before_order",
          psp_occurred_at: "2026-08-12T12:34:56.000Z",
        },
      }),
    ])

    await run(h.container, { id: "order_1" })

    expect(liveIssue).toHaveBeenCalledWith(
      h.client,
      {
        event_type: "gp.stripe.payment_intent_succeeded.v1",
        payload: {
          payment_intent_id: "pi_1",
          order_id: "order_1",
          currency: "PLN",
          amount_minor: 25000,
          psp_occurred_at: "2026-08-12T12:34:56.000Z",
        },
        scope: { instance_id: "gp-test", market_id: "bonbeauty" },
      },
      expect.any(Date),
    )
    expect(h.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gp.entitlements.entitlement_state_changed.v1",
        data: expect.objectContaining({
          payload: expect.objectContaining({ to_state: "ISSUED" }),
        }),
      }),
    )
  })

  it("odzysk Path Y KOŃCZY w ACTIVE — inaczej voucher jest nie do wykorzystania", async () => {
    // ZMIERZONE na gp_mercur 2026-08-13: 3 entitlementy z zakupów tego dnia
    // stały w ISSUED, `POST /vendor/vouchers/<kod>/redeem` → 422, a dziennik
    // tranzycji po `__genesis__ → ISSUED` nie miał żadnej krawędzi dalej.
    // `redeem-partial-entitlement.ts` przyjmuje wyłącznie
    // `{ACTIVE, REDEEMED_PARTIAL}`, więc gałąź natywna (wiersz od razu ACTIVE)
    // i gałąź Path Y MUSZĄ zbiegać się w tym samym stanie terminalnym.
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce({
      event_processed: true,
      issued: [
        {
          entitlement_id: `ent_${"a".repeat(64)}`,
          entitlement_dedupe_key: "a".repeat(64),
          created: true,
        },
      ],
    })
    const h = makeHarness([
      makeRow({
        provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
        envelope: {
          entitlement_issue_deferred_reason: "webhook_before_order",
          psp_occurred_at: "2026-08-12T12:34:56.000Z",
        },
      }),
    ])

    await run(h.container, { id: "order_1" })

    const activation = h.sent.find((q) => q.sql.includes(ACTIVATION_SQL_MARKER))
    expect(activation).toBeDefined()
    expect(activation!.values).toEqual([`ent_${"a".repeat(64)}`])
    // Guard trzyma idempotencję: replay nie cofa stanu po redempcji.
    expect(activation!.sql).toContain("AND state = 'ISSUED'")

    // Krawędź ISSUED → ACTIVE ląduje w dzienniku i na szynie (AD-7: subscriber
    // dostawy deduplikuje po `template_key` + `recipient_hash`, więc drugi
    // event NIE wysyła drugiego maila).
    expect(h.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gp.entitlements.entitlement_state_changed.v1",
        data: expect.objectContaining({
          payload: expect.objectContaining({
            from_state: "ISSUED",
            to_state: "ACTIVE",
          }),
        }),
      }),
    )
  })

  it("gdy UPDATE nie dotknął wiersza, NIE emituje eventu ACTIVE", async () => {
    // Event bez zmiany stanu byłby fałszywym śladem w dzienniku tranzycji —
    // ta kontrola upada, gdy emit przestanie zależeć od wyniku `RETURNING`.
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce({
      event_processed: true,
      issued: [
        {
          entitlement_id: `ent_${"b".repeat(64)}`,
          entitlement_dedupe_key: "b".repeat(64),
          created: true,
        },
      ],
    })
    const h = makeHarness(
      [
        makeRow({
          provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
          envelope: {
            entitlement_issue_deferred_reason: "webhook_before_order",
            psp_occurred_at: "2026-08-12T12:34:56.000Z",
          },
        }),
      ],
      { activation: "noop" }
    )

    await run(h.container, { id: "order_1" })

    const emitted = h.eventBus.emit.mock.calls.map(
      (call) =>
        (call[0] as { data: { payload: { to_state: string } } }).data.payload
          .to_state
    )
    expect(emitted).toEqual(["ISSUED"])
  })
})

/**
 * F-1 i L-6 (review-fix cyklu 1 story 6.3). Jedyny test nowej gałęzi Path Y
 * pokrywał wyłącznie ścieżkę szczęśliwą. Poniżej brakujące osie: paczka
 * mieszana (to jest test, który łapie F-1), domknięcie markera i replay.
 */
describe("odzysk Path Y — paczka mieszana, domknięcie i replay", () => {
  const pathYRow = (overrides: Partial<DeferredRow> = {}) =>
    makeRow({
      event_id: "evt_pathy#deferred-issuance",
      provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
      envelope: {
        entitlement_issue_deferred_reason: "webhook_before_order",
        psp_occurred_at: "2026-08-12T12:34:56.000Z",
      },
      ...overrides,
    })

  const issuedOnce = () => ({
    event_processed: true,
    issued: [
      {
        entitlement_id: `ent_${"a".repeat(64)}`,
        entitlement_dedupe_key: "a".repeat(64),
        created: true,
      },
    ],
  })

  it("marker legacy BEZ psp_occurred_at nie wywraca poprawnego markera z tej samej paczki", async () => {
    // ZMIERZONE na gp_mercur 2026-08-12: 19 markerów Path Y, tylko 2 niosą
    // `psp_occurred_at`, 4 są nierozwiązane. Przed poprawką goły `Error`
    // uciekał z `withTransaction` i ROLLBACK zabierał CAŁĄ paczkę zamówienia —
    // opłacony zakup kończył się zerem voucherów.
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce(issuedOnce())
    const h = makeHarness([
      pathYRow({
        event_id: "evt_legacy#deferred-issuance",
        envelope: { entitlement_issue_deferred_reason: "webhook_before_order" },
      }),
      pathYRow({ event_id: "evt_ok#deferred-issuance" }),
    ])

    await run(h.container, { id: "order_1" })

    // Poprawny marker ZOSTAŁ wystawiony...
    expect(liveIssue).toHaveBeenCalledTimes(1)
    // ...a domknięty jest WYŁĄCZNIE on. Marker legacy zostaje nierozwiązany
    // celowo — po backfillu kolejny `order.placed` go odzyska.
    const updates = h.sent.filter((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)
    expect(updates).toHaveLength(1)
    expect(updates[0].values[0]).toBe("evt_ok#deferred-issuance")
    // Nazwana odmowa TEGO wiersza, nie awaria paczki.
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("marker Path Y nieodtwarzalny")
    )
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it("wystawienie Path Y domyka marker — inaczej byłby odzyskiwany w kółko", async () => {
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce(issuedOnce())
    const h = makeHarness([pathYRow()])

    await run(h.container, { id: "order_1" })

    const update = h.sent.find((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)
    expect(update).toBeDefined()
    expect(update!.values[0]).toBe("evt_pathy#deferred-issuance")
    expect(update!.values[2]).toBe("order_1")
  })

  it("created:false (replay) NIE re-emituje zdarzenia przejścia", async () => {
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce({
      event_processed: true,
      issued: [
        {
          entitlement_id: `ent_${"b".repeat(64)}`,
          entitlement_dedupe_key: "b".repeat(64),
          created: false,
        },
      ],
    })
    const h = makeHarness([pathYRow()])

    await run(h.container, { id: "order_1" })

    expect(h.eventBus.emit).not.toHaveBeenCalled()
    // Marker mimo to zostaje domknięty: wystawienie JEST faktem, tylko nie nowym.
    expect(h.sent.some((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)).toBe(true)
  })

  it("amount_minor niecałkowite NIE blokuje odzysku (L-1: pole nieczytane przez wystawienie)", async () => {
    // `payment.amount` jest kolumną `numeric`; `Number(r.amount)` potrafi dać
    // ułamek. Wystawienie tej wartości nie czyta — odmowa byłaby ryzykiem
    // bez zysku.
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce(issuedOnce())
    const h = makeHarness([pathYRow({ amount: 25000.5 })])

    await run(h.container, { id: "order_1" })

    expect(liveIssue).toHaveBeenCalledTimes(1)
    expect(liveIssue.mock.calls[0][1].payload.amount_minor).toBe(25000)
  })

  it("C2-L-3: marker BEZ amount_minor jest odmową, nie cichym zerem", async () => {
    // Do review cyklu 2 `null`/`NaN` schodziło tu do `0` w dwóch miejscach
    // naraz (`Number(r.amount ?? 0)` w mapperze i `? 0 :` w walidacji), więc
    // brak kwoty stawał się kwotą — wartością legalną i nieodróżnialną od
    // pomiaru. Bezpieczeństwo tej linii opierało się WYŁĄCZNIE na fakcie
    // zewnętrznym: dziś `live-issue-from-payment-intent.ts` tego pola nie
    // czyta. Kontrola przypina odmowę do tego samego kanału, co pozostałe
    // nieczytelne pola: wiersz zostaje nierozwiązany, paczka żyje.
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce(issuedOnce())
    const h = makeHarness([
      pathYRow({ event_id: "evt_noamount#deferred-issuance", amount: null }),
      pathYRow({ event_id: "evt_ok#deferred-issuance" }),
    ])

    await run(h.container, { id: "order_1" })

    // Poprawny marker paczki wystawiony i domknięty; wadliwy — NIE.
    expect(liveIssue).toHaveBeenCalledTimes(1)
    const updates = h.sent.filter((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)
    expect(updates.map((q) => q.values[0])).toEqual(["evt_ok#deferred-issuance"])
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("marker Path Y nieodtwarzalny")
    )
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it("C2-L-3: amount nieczytelny (NaN po konwersji) też jest odmową", async () => {
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    const h = makeHarness([
      pathYRow({
        event_id: "evt_nan#deferred-issuance",
        amount: "nie-liczba" as unknown as number,
      }),
    ])

    await run(h.container, { id: "order_1" })

    expect(liveIssue).not.toHaveBeenCalled()
    expect(h.sent.some((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)).toBe(false)
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it("marker bez market_id jest pomijany, a nie wywraca paczki", async () => {
    const liveIssue = liveIssueEntitlementsWithinTx as jest.Mock
    liveIssue.mockReset()
    liveIssue.mockResolvedValueOnce(issuedOnce())
    const h = makeHarness([
      pathYRow({ event_id: "evt_nomarket#deferred-issuance", market_id: null }),
      pathYRow({ event_id: "evt_ok#deferred-issuance" }),
    ])

    await run(h.container, { id: "order_1" })

    expect(liveIssue).toHaveBeenCalledTimes(1)
    const updates = h.sent.filter((q) => q.sql === MARK_DEFERRED_RESOLVED_SQL)
    expect(updates.map((q) => q.values[0])).toEqual(["evt_ok#deferred-issuance"])
  })
})
