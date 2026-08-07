/**
 * voucher-delivery-dispatch-ledger.unit.spec.ts — Story 2.3 (AC1 / AC5).
 *
 * Testuje ledger `voucher_delivery_dispatch` na atrapie SQL, która EMULUJE
 * realne zachowania Postgresa istotne dla idempotencji:
 *   - `UNIQUE (entitlement_id, template_key, recipient_hash)` z `ON CONFLICT
 *     DO NOTHING` (drugi INSERT tych samych kluczy → 0 wierszy),
 *   - warunkowy `UPDATE ... WHERE status = ...` (0 wierszy, gdy guard nie pasuje).
 * Atrapa nie udaje pełnego SQL-a — udaje dokładnie te dwa niezmienniki, na
 * których stoi AC5.
 */

import {
  extractRows,
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"
import {
  hashRecipientEmail,
  normalizeRecipientEmail,
  RECIPIENT_HASH_PATTERN,
  RecipientHashError,
} from "../../modules/voucher-delivery/recipient-hash"
import {
  DELIVERY_DISPATCH_STATES,
  DISPATCH_STATES_ALLOWING_RETRY,
  DISPATCH_STATES_BLOCKING_RESEND,
} from "../../modules/voucher-delivery/delivery-state"

type Row = Record<string, unknown>

/**
 * Guard dialektu (R-2.3-H1). Wcześniej atrapa mapowała bindingi POZYCYJNIE
 * i w ogóle nie interpretowała składni placeholderów, więc zieleniła się także
 * dla SQL-a niewykonywalnego przez realny sterownik (`$N` na Kneksie →
 * `Expected N bindings, saw 0`). Ten guard odtwarza regułę formattera Knexa:
 *   - żadnego `$N` (dialekt `pg`) — do `raw` trafia wyłącznie `?`,
 *   - liczba `?` MUSI się zgadzać z liczbą bindingów,
 *   - żaden binding nie jest tablicą (Knex rozwija tablicę w listę `?, ?`).
 * Komplementarnie `voucher-delivery-sql-dialect.unit.spec.ts` przepuszcza ten
 * sam SQL przez REALNY formatter Knexa.
 */
function assertKnexDialect(sql: string, bindings: readonly unknown[]): void {
  const pgPlaceholders = sql.match(/\$\d+/g)
  if (pgPlaceholders) {
    throw new Error(
      `SQL trafił do sterownika z placeholderami dialektu pg (${pgPlaceholders.join(", ")}) — ` +
        "Knex ich nie rozumie",
    )
  }

  const expected = (sql.match(/\?/g) ?? []).length
  if (expected !== bindings.length) {
    throw new Error(`Expected ${expected} bindings, saw ${bindings.length}`)
  }

  const arrayBinding = bindings.findIndex((value) => Array.isArray(value))
  if (arrayBinding >= 0) {
    throw new Error(
      `Binding #${arrayBinding + 1} jest tablicą — Knex rozwinąłby ją w listę \`?, ?\``,
    )
  }
}

/**
 * Minimalny, ale UCZCIWY fake: rozpoznaje 6 zapytań ledgera i egzekwuje
 * unikalność klucza oraz guardy `WHERE status`.
 */
class FakeDispatchSql implements DispatchLedgerSql {
  readonly dispatch: Row[] = []
  readonly audit: Row[] = []
  readonly statements: string[] = []

  async raw(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
    assertKnexDialect(sql, bindings)
    const normalized = sql.replace(/\s+/g, " ").trim()
    this.statements.push(normalized)

    if (normalized.includes(`INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE}`)) {
      const [
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        from_status,
        to_status,
        error_code,
        attempt_count,
        occurred_at,
        provider_status_code,
        provider_message,
        provider_error_kind,
      ] = bindings
      this.audit.push({
        audit_id: this.audit.length + 1,
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        from_status,
        to_status,
        error_code,
        attempt_count,
        occurred_at,
        provider_status_code,
        provider_message,
        provider_error_kind,
      })
      return { rows: [] }
    }

    if (normalized.includes(`INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)) {
      const [
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        flow_id,
        locale,
        now,
      ] = bindings as string[]

      // Emulacja UNIQUE + ON CONFLICT DO NOTHING.
      const clash = this.find(entitlement_id, template_key, recipient_hash)
      if (clash) return { rows: [] }

      const row: Row = {
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        flow_id,
        locale,
        status: "queued",
        provider: null,
        provider_message_id: null,
        error_code: null,
        attempt_count: 1,
        queued_at: now,
        sent_at: null,
        failed_at: null,
      }
      this.dispatch.push(row)
      return { rows: [{ ...row }] }
    }

    if (normalized.startsWith(`SELECT`)) {
      const [entitlement_id, template_key, recipient_hash] = bindings as string[]
      const row = this.find(entitlement_id, template_key, recipient_hash)
      return { rows: row ? [{ ...row }] : [] }
    }

    if (normalized.includes(`UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)) {
      if (normalized.includes("SET status = 'sent'")) {
        // Bindingi są w kolejności WYSTĄPIEŃ `?` w SQL-u (tak widzi je Knex),
        // a numeracja `$N` w ledgerze jest rosnąca wzdłuż tekstu zapytania.
        // Liczymy od KOŃCA (jak w gałęzi `failed`): `dispatch_id` jest zawsze
        // ostatnim wystąpieniem, więc dołożenie kolejnej kolumny SET nie
        // przesuwa guardu i nie wywraca wszystkich testów naraz.
        const values = bindings as (string | null)[]
        const dispatch_id = values[values.length - 1] as string
        const now = values[values.length - 2] as string
        const [provider, provider_message_id, correlation_token] = values
        const row = this.byId(dispatch_id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "sent",
          provider,
          provider_message_id,
          // Zachowanie MUSI wynikać z SQL-a pod testem, nie z uprzejmości
          // atrapy: gdyby fake bezwarunkowo stosował COALESCE, test „null nie
          // kasuje wiązania" przechodziłby także po usunięciu COALESCE
          // z ledgera — czyli mierzyłby atrapę, nie kod.
          correlation_token: normalized.includes(
            "correlation_token = COALESCE(",
          )
            ? correlation_token ?? row.correlation_token ?? null
            : correlation_token ?? null,
          error_code: null,
          sent_at: now,
        })
        return { rows: [{ ...row }] }
      }

      if (normalized.includes("SET status = 'failed'")) {
        // `toKnexPositionalSql` rozwija bindingi w kolejnosci WYSTAPIEN `?`.
        // `dispatch_id` (guard WHERE) jest OSTATNIM wystapieniem, a odpowiedz
        // providera dwoma tuz przed nim — liczymy od konca, zeby dolozenie
        // kolejnej kolumny SET nie przesunelo znowu calej listy.
        const [provider, error_code, , now] = bindings as string[]
        const dispatch_id = bindings[bindings.length - 1] as string
        const provider_error_kind = bindings[bindings.length - 2] ?? null
        const provider_status_code = bindings[bindings.length - 4] ?? null
        const provider_message = bindings[bindings.length - 3] ?? null
        const row = this.byId(dispatch_id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "failed",
          provider: provider ?? row.provider,
          error_code,
          first_error_code: row.first_error_code ?? error_code,
          failed_at: now,
          provider_status_code,
          provider_message,
          provider_error_kind,
        })
        return { rows: [{ ...row }] }
      }

      // Przejęcie retry: guard `status IN (?, ?)` — lista stanów jest rozwinięta
      // na jawne placeholdery (tablica w bindingu byłaby błędem dialektu).
      const [now, , locale, market_id, flow_id, dispatch_id, ...allowed] =
        bindings as string[]
      const row = this.byId(dispatch_id)
      if (!row || !allowed.includes(row.status as string)) return { rows: [] }
      Object.assign(row, {
        status: "queued",
        attempt_count: Number(row.attempt_count ?? 0) + 1,
        error_code: null,
        failed_at: null,
        queued_at: now,
        locale,
        market_id,
        flow_id,
      })
      return { rows: [{ ...row }] }
    }

    throw new Error(`FakeDispatchSql: nieobsłużone zapytanie: ${normalized}`)
  }

  private find(
    entitlementId: string,
    templateKey: string,
    recipientHash: string,
  ): Row | undefined {
    return this.dispatch.find(
      (row) =>
        row.entitlement_id === entitlementId &&
        row.template_key === templateKey &&
        row.recipient_hash === recipientHash,
    )
  }

  private byId(dispatchId: string): Row | undefined {
    return this.dispatch.find((row) => row.dispatch_id === dispatchId)
  }
}

const TEMPLATE_KEY = "voucher_purchase_confirmation"
const EMAIL = "Kupujaca@Example.COM"

function makeLedger(sql: FakeDispatchSql) {
  let seq = 0
  return new PgDispatchLedger(sql, {
    uuid: () => `dispatch-${++seq}`,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
  })
}

function identity() {
  return {
    entitlement_id: "ent_1",
    template_key: TEMPLATE_KEY,
    recipient_hash: hashRecipientEmail(EMAIL),
    market_id: "bonbeauty",
    flow_id: "voucher_purchase_delivery",
    locale: "pl",
  }
}

describe("recipient-hash — normalizacja i zero PII (AC1)", () => {
  it("normalizuje trim + lowercase przed hashem", () => {
    expect(normalizeRecipientEmail("  Ala@Example.COM  ")).toBe("ala@example.com")
  })

  it("różne warianty zapisu tego samego adresu dają TEN SAM hash", () => {
    const a = hashRecipientEmail("kupujaca@example.com")
    const b = hashRecipientEmail("  KUPUJACA@Example.CoM  ")
    expect(b).toBe(a)
  })

  it("różne adresy dają różne hashe (brak kolizji tożsamości)", () => {
    expect(hashRecipientEmail("a@example.com")).not.toBe(
      hashRecipientEmail("b@example.com"),
    )
  })

  it("kształt hasha jest zgodny z `recipient_contact_hash` z kontraktu komunikacyjnego", () => {
    expect(hashRecipientEmail(EMAIL)).toMatch(RECIPIENT_HASH_PATTERN)
  })

  it("hash NIE zawiera żadnego fragmentu adresu (zero PII)", () => {
    const hash = hashRecipientEmail(EMAIL)
    expect(hash).not.toContain("Kupujaca")
    expect(hash.toLowerCase()).not.toContain("kupujaca")
    expect(hash).not.toContain("@")
    expect(hash).not.toContain("example")
  })

  it("pusty adres jest błędem, nie hashem pustego stringa", () => {
    expect(() => hashRecipientEmail("   ")).toThrow(RecipientHashError)
  })
})

describe("PgDispatchLedger — API nie przyjmuje surowego maila (AC1)", () => {
  it("rzuca fail-loud, gdy ktoś obejdzie typ i poda adres jako recipient_hash", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await expect(
      ledger.reserveDispatch({
        ...identity(),
        // Symulacja wywołania z JS-a / przez `as any` — brandowany typ chroni
        // tylko kompilację, więc runtime musi mieć własny backstop.
        recipient_hash: EMAIL as never,
      }),
    ).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_RECIPIENT_HASH_INVALID",
    })

    expect(sql.dispatch).toHaveLength(0)
    expect(sql.audit).toHaveLength(0)
  })

  it("żaden zapisany wiersz (ledger ani audit) nie zawiera adresu e-mail", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const reservation = await ledger.reserveDispatch(identity())
    await ledger.markSent({
      dispatch_id: reservation.dispatch_id!,
      provider: "brevo",
      provider_message_id: "brevo-123",
    })

    const serialized = JSON.stringify({ d: sql.dispatch, a: sql.audit })
    expect(serialized).not.toContain("Kupujaca")
    expect(serialized.toLowerCase()).not.toContain("kupujaca@example.com")
    expect(serialized).not.toContain("@example.com")
  })
})

describe("PgDispatchLedger — INSERT-first ON CONFLICT DO NOTHING (AC5)", () => {
  it("pierwsza rezerwacja tworzy wiersz `queued` + wpis audytowy", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const result = await ledger.reserveDispatch(identity())

    expect(result.outcome).toBe("reserved")
    expect(result.status).toBe("queued")
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.audit).toEqual([
      expect.objectContaining({ from_status: null, to_status: "queued" }),
    ])
  })

  it("mechanizmem jest INSERT-first, NIE „SELECT then INSERT”", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await ledger.reserveDispatch(identity())

    // Pierwsze zapytanie MUSI być INSERT-em z ON CONFLICT — gdyby ktoś zamienił
    // to na SELECT-then-INSERT, dwa równoległe workery przeszłyby przez okno
    // między odczytem a zapisem.
    expect(sql.statements[0]).toContain(
      `INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
    )
    expect(sql.statements[0]).toContain("ON CONFLICT")
    expect(sql.statements[0]).toContain("DO NOTHING")
    expect(sql.statements[0]).not.toContain("DO UPDATE")
  })

  it("drugi INSERT tych samych trzech kluczy NIE tworzy nowego wiersza", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await ledger.reserveDispatch(identity())
    const second = await ledger.reserveDispatch(identity())

    expect(sql.dispatch).toHaveLength(1)
    expect(second.outcome).toBe("in_flight")
  })

  it("współbieżne rezerwacje: dokładnie JEDNA dostaje `reserved`", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const results = await Promise.all([
      ledger.reserveDispatch(identity()),
      ledger.reserveDispatch(identity()),
      ledger.reserveDispatch(identity()),
    ])

    expect(results.filter((r) => r.outcome === "reserved")).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
  })

  it("inny template_key dla tego samego entitlementu to OSOBNY wiersz", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await ledger.reserveDispatch(identity())
    const other = await ledger.reserveDispatch({
      ...identity(),
      template_key: "voucher_handoff_link",
    })

    expect(other.outcome).toBe("reserved")
    expect(sql.dispatch).toHaveLength(2)
  })
})

// ── Story 4.4 / AC5 (AD-23): ponowienie ≠ duplikat ─────────────────────────

describe("AC5 — ponowienie legalne jest ODRÓŻNIALNE od duplikatu (z DANYCH)", () => {
  it("legalne ponowienie zostawia tranzycję `failed → queued` z podniesionym numerem", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_TRANSPORT_ERROR",
    })

    const retry = await ledger.reserveDispatch(identity())

    expect(retry.outcome).toBe("retry_reserved")
    // Numer nadał LEDGER — wywołujący podał to samo wejście co za pierwszym razem.
    expect(retry.attempt_count).toBe(first.attempt_count + 1)

    // Rozróżnienie czytelne z DANYCH, nie z logu: append-only audyt niesie
    // tranzycję z kopią numeru próby w momencie jej wykonania.
    const transitions = sql.audit.map(
      (row) => `${String(row.from_status)}→${String(row.to_status)}`,
    )
    expect(transitions).toEqual(["null→queued", "queued→failed", "failed→queued"])
  })

  it("duplikat kończy się `blocked`/`in_flight` — ZERO nowych tranzycji i zero prób", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markSent({
      dispatch_id: first.dispatch_id!,
      provider: "brevo",
      provider_message_id: "brevo-1",
    })

    const auditBefore = sql.audit.length
    const attemptsBefore = Number(sql.dispatch[0].attempt_count)

    const duplicate = await ledger.reserveDispatch(identity())

    expect(duplicate.outcome).toBe("blocked")
    expect(sql.audit).toHaveLength(auditBefore)
    expect(Number(sql.dispatch[0].attempt_count)).toBe(attemptsBefore)
  })

  it("dwa równoległe wejścia na TEN SAM wiersz dają dokładnie jedno `retry_reserved`", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_TRANSPORT_ERROR",
    })

    const results = await Promise.all([
      ledger.reserveDispatch(identity()),
      ledger.reserveDispatch(identity()),
    ])

    // Guard `status IN (...)` w `WHERE` czyni przejęcie retry ATOMOWYM — drugi
    // wołający widzi `in_flight`, a nie drugą próbę.
    expect(results.filter((r) => r.outcome === "retry_reserved")).toHaveLength(1)
    expect(results.filter((r) => r.outcome === "in_flight")).toHaveLength(1)
    // Jeden inkrement, nie dwa: budżet prób zużyty raz na jedno ponowienie.
    expect(Number(sql.dispatch[0].attempt_count)).toBe(2)
  })

  it("ponowienie SĄSIADA nie rusza wiersza zaparkowanego (jednostką jest wiersz)", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const buyer = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: buyer.dispatch_id!,
      error_code: "BREVO_TRANSPORT_ERROR",
    })
    const buyerAttempts = Number(sql.dispatch[0].attempt_count)

    const handoff = await ledger.reserveDispatch({
      ...identity(),
      template_key: "voucher_handoff_link",
    })

    expect(handoff.outcome).toBe("reserved")
    expect(sql.dispatch).toHaveLength(2)
    expect(Number(sql.dispatch[0].attempt_count)).toBe(buyerAttempts)
    expect(sql.dispatch[0].status).toBe("failed")
  })
})

describe("PgDispatchLedger — token korelacji dostarczonej wiadomości", () => {
  it("markSent ZAPISUJE token, żeby fallback pełnotekstowy smoke'a miał czego szukać", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const reservation = await ledger.reserveDispatch(identity())
    await ledger.markSent({
      dispatch_id: reservation.dispatch_id!,
      provider: "brevo",
      // Zakup 2026-08-01 dał `sent` z `provider_message_id: null`, przez co
      // strategia `rfc822msgid:` nie miała czym zadziałać.
      provider_message_id: null,
      correlation_token: "BO-KV7U-35KV",
    })

    const row = await ledger.findByIdentity(identity())
    expect(row?.status).toBe("sent")
    expect(row?.correlation_token).toBe("BO-KV7U-35KV")
  })

  it("brak tokenu w kolejnym markSent NIE kasuje wiązania ustalonego wcześniej", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const reservation = await ledger.reserveDispatch(identity())
    const dispatchId = reservation.dispatch_id!
    await ledger.markSent({
      dispatch_id: dispatchId,
      provider: "brevo",
      provider_message_id: null,
      correlation_token: "BO-KV7U-35KV",
    })

    // Ścieżka recovery/sweep potrafi wywołać markSent bez tokenu. Gdyby
    // nadpisywała kolumnę, wiązanie ginęłoby dokładnie w tym scenariuszu,
    // dla którego powstało (dispatch z `configuration_recovery_count > 0`).
    const parked = sql.dispatch.find((row) => row.dispatch_id === dispatchId)!
    parked.status = "queued"
    await ledger.markSent({
      dispatch_id: dispatchId,
      provider: "brevo",
      provider_message_id: "brevo-late",
    })

    const row = await ledger.findByIdentity(identity())
    expect(row?.provider_message_id).toBe("brevo-late")
    expect(row?.correlation_token).toBe("BO-KV7U-35KV")
  })

  it("token NIE jest e-mailem ani żadną formą adresu odbiorcy", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const reservation = await ledger.reserveDispatch(identity())
    await ledger.markSent({
      dispatch_id: reservation.dispatch_id!,
      provider: "brevo",
      provider_message_id: null,
      correlation_token: "BO-KV7U-35KV",
    })

    const serialized = JSON.stringify({ d: sql.dispatch, a: sql.audit })
    expect(serialized).not.toContain("@example.com")
    expect(serialized).not.toContain("Kupujaca")
  })
})

describe("PgDispatchLedger — tranzycje queued→sent|failed (AC2 / AC5)", () => {
  it("`sent` blokuje ponowną wysyłkę BEZWARUNKOWO", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markSent({
      dispatch_id: first.dispatch_id!,
      provider: "brevo",
      provider_message_id: "brevo-1",
    })

    const retry = await ledger.reserveDispatch(identity())
    expect(retry.outcome).toBe("blocked")
    expect(retry.status).toBe("sent")
  })

  it("`failed` z kodem błędu DOPUSZCZA legalny retry (attempt_count rośnie)", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
      provider: "brevo",
    })

    const retry = await ledger.reserveDispatch(identity())
    expect(retry.outcome).toBe("retry_reserved")
    expect(retry.status).toBe("queued")
    expect(retry.attempt_count).toBe(2)
    // Nadal JEDEN wiersz — retry przejmuje rezerwację, nie tworzy drugiej.
    expect(sql.dispatch).toHaveLength(1)
  })

  it("`failed` zapisuje KOD błędu, nigdy treści odpowiedzi providera", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
    })

    expect(sql.dispatch[0].error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    expect(sql.dispatch[0].first_error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    expect(sql.audit.at(-1)).toMatchObject({
      from_status: "queued",
      to_status: "failed",
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
    })
  })

  it("401 z autoryzacji IP zapisuje RODZAJ awarii obok zredagowanej tresci", async () => {
    // Redakcja usuwa adres IP i link autoryzacyjny — czyli OBA nosniki
    // informacji, ktorej operator potrzebuje. `provider_error_kind` niesie
    // ENUM, wiec przywraca diagnostycznosc niczego nie odslaniajac.
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_UNAUTHORIZED",
      provider: "brevo",
      provider_status_code: 401,
      provider_message:
        "We have detected you are using an unrecognised IP address " +
        "<redacted:ip>. If you performed this action make sure to add the new " +
        "IP address in this link: https://app.brevo.<redacted:token>",
    })

    expect(sql.dispatch[0].provider_error_kind).toBe("IP_NOT_AUTHORIZED")
    expect(sql.audit.at(-1)).toMatchObject({
      to_status: "failed",
      provider_error_kind: "IP_NOT_AUTHORIZED",
    })
    // Kanal diagnostyczny NIE moze byc furtka na PII: w calym zapisie nie ma
    // adresu ani tokenu — dokladnie dlatego rodzaj jest enumem, nie tekstem.
    const serialized = JSON.stringify({ d: sql.dispatch, a: sql.audit })
    expect(serialized).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
  })

  it("401 bez ksztaltu autoryzacji IP NIE dostaje rodzaju (zero zgadywania)", async () => {
    // Samo 401 niesie takze zly klucz API, ktory ma inne lekarstwo. Etykieta
    // postawiona na domysle byla by gorsza niz jej brak.
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_INVALID_API_KEY",
      provider: "brevo",
      provider_status_code: 401,
      provider_message: "Key not found",
    })

    expect(sql.dispatch[0].provider_error_kind).toBeNull()
  })

  it("porazka pre-flight (bez odpowiedzi HTTP) nie zmysla rodzaju", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
    })

    expect(sql.dispatch[0].provider_error_kind).toBeNull()
  })

  it("retry nie kasuje pierwotnej przyczyny ze summary ledgera", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)
    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_SENDER_NOT_CONFIGURED",
    })

    await ledger.reserveDispatch(identity())

    expect(sql.dispatch[0]).toMatchObject({
      status: "queued",
      error_code: null,
      first_error_code: "BREVO_SENDER_NOT_CONFIGURED",
    })
  })

  it("markSent/markFailed działa TYLKO z `queued` (single-writer tranzycji)", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    const dispatchId = first.dispatch_id!

    expect(
      await ledger.markSent({
        dispatch_id: dispatchId,
        provider: "brevo",
        provider_message_id: "brevo-1",
      }),
    ).toBe(true)

    // Drugi markSent (np. z równoległego workera) NIE przechodzi.
    expect(
      await ledger.markSent({
        dispatch_id: dispatchId,
        provider: "brevo",
        provider_message_id: "brevo-2",
      }),
    ).toBe(false)
    expect(
      await ledger.markFailed({ dispatch_id: dispatchId, error_code: "X" }),
    ).toBe(false)
    expect(sql.dispatch[0].provider_message_id).toBe("brevo-1")
  })

  it("audit jest APPEND-ONLY — każda tranzycja to nowy wiersz, żaden nie jest nadpisywany", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    const first = await ledger.reserveDispatch(identity())
    await ledger.markFailed({
      dispatch_id: first.dispatch_id!,
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
    })
    const retry = await ledger.reserveDispatch(identity())
    await ledger.markSent({
      dispatch_id: retry.dispatch_id!,
      provider: "brevo",
      provider_message_id: "brevo-9",
    })

    expect(sql.audit.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, "queued"],
      ["queued", "failed"],
      ["failed", "queued"],
      ["queued", "sent"],
    ])
    expect(
      sql.statements.filter((s) =>
        s.includes(`UPDATE ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE}`),
      ),
    ).toHaveLength(0)
  })

  it("`dead_lettered` blokuje automatyczny retry (wznowienie = decyzja operatora)", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await ledger.reserveDispatch(identity())
    sql.dispatch[0].status = "dead_lettered"

    const retry = await ledger.reserveDispatch(identity())
    expect(retry.outcome).toBe("blocked")
  })

  it("wiersz ze statusem spoza kontraktu jest fail-loud, nie cichym przepustem", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await ledger.reserveDispatch(identity())
    sql.dispatch[0].status = "wyslane_moze"

    await expect(ledger.findByIdentity(identity())).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_DISPATCH_STATUS_UNKNOWN",
    })
  })
})

describe("semantyka stanów — spójność stałych (AC1 / AC5)", () => {
  it("stany blokujące i retry-owalne są rozłączne i należą do enumu kontraktu", () => {
    for (const state of [
      ...DISPATCH_STATES_BLOCKING_RESEND,
      ...DISPATCH_STATES_ALLOWING_RETRY,
    ]) {
      expect(DELIVERY_DISPATCH_STATES).toContain(state)
    }
    expect(
      DISPATCH_STATES_BLOCKING_RESEND.filter((s) =>
        DISPATCH_STATES_ALLOWING_RETRY.includes(s),
      ),
    ).toEqual([])
  })

  it("`queued` NIE jest retry-owalny — dogonienie porzuconych należy do sweepa 2.5", () => {
    expect(DISPATCH_STATES_ALLOWING_RETRY).not.toContain("queued")
  })

  it("R-2.3-L7: `degraded` NIE jest ślepą uliczką — blokuje ponowną wysyłkę", () => {
    // W kontrakcie `degraded` znaczy „dostarczone w trybie zdegradowanym", czyli
    // mail POSZEDŁ. Wcześniej stan nie należał do żadnej listy i wypadał
    // w gałąź `in_flight` (ani blokada, ani retry — z mylącym logiem).
    expect(DISPATCH_STATES_BLOCKING_RESEND).toContain("degraded")
  })

  it("R-2.3-L7: każdy stan enumu ma zdefiniowaną decyzję rezerwacji", async () => {
    const undecided = DELIVERY_DISPATCH_STATES.filter(
      (state) =>
        state !== "queued" &&
        state !== "dead_lettered" &&
        !DISPATCH_STATES_BLOCKING_RESEND.includes(state) &&
        !DISPATCH_STATES_ALLOWING_RETRY.includes(state),
    )
    expect(undecided).toEqual([])
  })

  it("R-2.3-L7: wiersz `degraded` daje `blocked`, nie `in_flight`", async () => {
    const sql = new FakeDispatchSql()
    const ledger = makeLedger(sql)

    await ledger.reserveDispatch(identity())
    sql.dispatch[0].status = "degraded"

    const again = await ledger.reserveDispatch(identity())
    expect(again.outcome).toBe("blocked")
    expect(again.status).toBe("degraded")
  })
})

describe("extractRows — tolerancja kształtu sterownika", () => {
  it("obsługuje `{ rows }` (Knex/pg) i surową tablicę", () => {
    expect(extractRows({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }])
    expect(extractRows([{ a: 2 }])).toEqual([{ a: 2 }])
    expect(extractRows(null)).toEqual([])
  })
})
