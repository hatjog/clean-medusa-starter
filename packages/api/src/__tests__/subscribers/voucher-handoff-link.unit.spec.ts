/**
 * voucher-handoff-link.unit.spec.ts — Story 2.4 (AC1 / AC2 / AC3).
 *
 * Testy bez kontenera Medusy, bez DB i BEZ SIECI: `createNotifications` jest
 * atrapą, klient Brevo nigdy nie powstaje. ŻADEN test nie może wysłać maila —
 * a handoff idzie do osoby innej niż kupująca, więc to nie jest kosmetyka.
 */

import {
  handleVoucherPurchaseDelivery,
  type PurchaseDeliveryDeps,
  type PurchaseDeliverySource,
} from "../../subscribers/voucher-purchase-delivery"
import {
  evaluateGiftHandoff,
  GIFT_SEND_TIMING_HANDOVER,
  GIFT_SEND_TIMING_NOW,
  GIFT_SEND_TIMING_SCHEDULED,
} from "../../modules/voucher-delivery/gift-handoff"
import { buildHandoffLinkNotification } from "../../modules/voucher-delivery/handoff-link-intent"
import {
  PgDispatchLedger,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

const BUYER_EMAIL = "Kupujaca@Example.Test"
const RECIPIENT_EMAIL = "Obdarowana@Example.Test"
const ENTITLEMENT_ID = "entinst_2_4_001"
const VOUCHER_CODE = "BB-GIFT-0001"
const MARKET_ID = "bonbeauty"
const BUYER_TEMPLATE = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION
const HANDOFF_TEMPLATE = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK

// ── Atrapy (ten sam kontrakt co w spec-u 2.3) ───────────────────────────────

type Row = Record<string, unknown>

/** Emuluje UNIQUE `(entitlement_id, template_key, recipient_hash)` + guardy WHERE. */
class FakeSql implements DispatchLedgerSql {
  readonly dispatch: Row[] = []
  readonly audit: Row[] = []

  async raw(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
    const q = sql.replace(/\s+/g, " ").trim()

    if (q.includes("INSERT INTO voucher_delivery_dispatch_audit")) {
      const [
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        from_status,
        to_status,
        error_code,
      ] = bindings
      this.audit.push({
        dispatch_id,
        entitlement_id,
        template_key,
        recipient_hash,
        market_id,
        from_status,
        to_status,
        error_code,
      })
      return { rows: [] }
    }

    if (q.includes("INSERT INTO voucher_delivery_dispatch")) {
      const [d, e, t, h, m, f, l, now] = bindings as string[]
      if (this.find(e, t, h)) return { rows: [] }
      const row: Row = {
        dispatch_id: d,
        entitlement_id: e,
        template_key: t,
        recipient_hash: h,
        market_id: m,
        flow_id: f,
        locale: l,
        status: "queued",
        provider: null,
        provider_message_id: null,
        error_code: null,
        attempt_count: 1,
        queued_at: now,
      }
      this.dispatch.push(row)
      return { rows: [{ ...row }] }
    }

    if (q.startsWith("SELECT")) {
      const [e, t, h] = bindings as string[]
      const row = this.find(e, t, h)
      return { rows: row ? [{ ...row }] : [] }
    }

    if (q.includes("UPDATE voucher_delivery_dispatch")) {
      if (q.includes("SET status = 'sent'")) {
        // `markSent` wiąże SZESC placeholderow (provider, provider_message_id,
        // correlation_token, sent_at, updated_at, dispatch_id) — pozycyjne
        // `[, , , , id]` trafialo w znacznik czasu, wiec UPDATE NIGDY nie
        // znajdowal wiersza i status zostawal `queued`.
        const [provider, messageId, , , , id] = bindings as string[]
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "sent",
          provider,
          provider_message_id: messageId,
          error_code: null,
        })
        return { rows: [{ ...row }] }
      }
      if (q.includes("SET status = 'failed'")) {
        // Patrz voucher-purchase-delivery.unit.spec.ts: `markFailed` powtarza `$2`/`$3`,
        // więc po ekspansji Knexa bindingów jest 7, a `dispatch_id` jest ostatni.
        const [provider, errorCode] = bindings as string[]
        const id = bindings[bindings.length - 1] as string
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "failed",
          provider: provider ?? row.provider,
          error_code: errorCode,
        })
        return { rows: [{ ...row }] }
      }
      const [, , locale, market_id, flow_id, id, ...allowed] = bindings as string[]
      const row = this.byId(id)
      if (!row || !allowed.includes(row.status as string)) return { rows: [] }
      Object.assign(row, {
        status: "queued",
        attempt_count: Number(row.attempt_count ?? 0) + 1,
        error_code: null,
        locale,
        market_id,
        flow_id,
      })
      return { rows: [{ ...row }] }
    }

    throw new Error(`FakeSql: nieobsłużone zapytanie: ${q}`)
  }

  private find(e: string, t: string, h: string): Row | undefined {
    return this.dispatch.find(
      (r) => r.entitlement_id === e && r.template_key === t && r.recipient_hash === h,
    )
  }

  private byId(id: string): Row | undefined {
    return this.dispatch.find((r) => r.dispatch_id === id)
  }
}

type LogEntry = { level: "info" | "warn" | "error"; message: string; meta?: unknown }

function makeLogger() {
  const entries: LogEntry[] = []
  return {
    entries,
    info: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: "info", message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: "warn", message, meta }),
    error: (message: string, meta?: unknown) =>
      entries.push({ level: "error", message, meta }),
  }
}

/** Projekcja zakupu prezentu — domyślnie „gift + od razu” (ścieżka wysyłkowa). */
function giftSource(
  overrides: Partial<PurchaseDeliverySource> = {},
): PurchaseDeliverySource {
  return {
    buyer_email: BUYER_EMAIL,
    voucher_code: VOUCHER_CODE,
    market_id: MARKET_ID,
    purchase_locale: "pl",
    // Story 5.7 — projekcja niesie komplet danych treści maila.
    customer_first_name: "Magda",
    seller_name: "Salon Bonbeauty",
    seller_handle: "salon-bonbeauty",
    order_id: "order_01KYSYPH78N80PE8YC85X6X3EK",
    order_display_id: "1042",
    purchase_date: "2026-07-30T09:15:00.000Z",
    voucher_expires_at: "2027-07-30T00:00:00.000Z",
    voucher_value_minor: 20000,
    voucher_currency: "PLN",
    salon_address_1: "ul. Handlowa 10",
    salon_address_2: null,
    salon_postal_code: "00-001",
    salon_city: "Warszawa",
    purchase_mode: "gift",
    gift_recipient_email: RECIPIENT_EMAIL,
    gift_recipient_send_timing: GIFT_SEND_TIMING_NOW,
    gift_recipient_bound_to_voucher_issue: true,
    ...overrides,
  }
}

function makeDeps(overrides: {
  source?: PurchaseDeliverySource | null
  dispatchImpl?: (payload: Record<string, unknown>) => Promise<unknown>
  locales?: { default: string; supported: string[] }
  sql?: FakeSql
  env?: NodeJS.ProcessEnv
}) {
  const sql = overrides.sql ?? new FakeSql()
  const logger = makeLogger()
  const dispatchCalls: Array<Record<string, unknown>> = []
  let seq = 0

  const deps: PurchaseDeliveryDeps = {
    sourceReader: {
      async findBuyerClaimSource() {
        return overrides.source === undefined ? giftSource() : overrides.source
      },
    },
    ledger: new PgDispatchLedger(sql, {
      uuid: () => `dispatch-${++seq}`,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    }),
    dispatcher: {
      async dispatch(payload) {
        dispatchCalls.push(payload)
        if (overrides.dispatchImpl) return overrides.dispatchImpl(payload)
        return { external_id: `brevo-${dispatchCalls.length}` }
      },
    },
    marketLocales: {
      async read() {
        return {
          config: overrides.locales ?? {
            default: "pl",
            supported: ["pl", "en", "ua", "de"],
          },
          degraded: false,
        }
      },
      // Story 5.7 (AC2) — `support_email` / `market_url` z ożywionej tabeli.
      async readRuntimeConfig() {
        return {
          row: {
            locales: { default: "pl", supported: ["pl", "en", "ua", "de"] },
            support_email: "kontakt@bonbeauty.pl",
            market_url: "https://dev.bonbeauty.pl",
          },
          degraded: false,
        }
      },
    },
    logger,
    env: overrides.env ?? {
      GP_STOREFRONT_URL_BONBEAUTY: "https://dev.bonbeauty.pl",
    },
  }

  return { deps, sql, logger, dispatchCalls }
}

function envelope(toState: string, fromState = "__genesis__") {
  return {
    schema_version: "1",
    event_type: "gp.entitlements.entitlement_state_changed.v1",
    occurred_at: "2026-07-26T12:00:00.000Z",
    actor: "system",
    scope: {
      instance_id: ENTITLEMENT_ID,
      market_id: MARKET_ID,
      vendor_id: null,
      location_id: null,
    },
    payload: {
      entitlement_id: ENTITLEMENT_ID,
      from_state: fromState,
      to_state: toState,
    },
  }
}

const templatesOf = (calls: Array<Record<string, unknown>>) =>
  calls.map((call) => call.template)

// ── AC2: predykat gift ∧ „od razu” — tabelarycznie ─────────────────────────

describe("AC2 — predykat handoffu: nigdy „prawie prezent”", () => {
  it.each([
    ["zakup dla siebie (`self`)", { purchase_mode: "self" }, "not_gift"],
    ["brak `purchase_mode`", { purchase_mode: null }, "not_gift"],
    [
      "„przekażę osobiście”",
      { gift_recipient_send_timing: GIFT_SEND_TIMING_HANDOVER },
      "handover_in_person",
    ],
    [
      "zastane `scheduled` (dane sprzed 2.4)",
      { gift_recipient_send_timing: GIFT_SEND_TIMING_SCHEDULED },
      "scheduled_deferred_v1150",
    ],
    [
      "send-timing spoza kontraktu",
      { gift_recipient_send_timing: "kiedys" },
      "send_timing_unknown",
    ],
    [
      "brak send-timing",
      { gift_recipient_send_timing: null },
      "send_timing_unknown",
    ],
    [
      "brak adresu odbiorczyni",
      { gift_recipient_email: null },
      "missing_recipient_email",
    ],
    [
      "niepoprawny adres odbiorczyni",
      { gift_recipient_email: "nie-jest-adresem" },
      "invalid_recipient_email",
    ],
    [
      "dane niepowiązane z wydaniem vouchera",
      { gift_recipient_bound_to_voucher_issue: false },
      "not_bound_to_voucher_issue",
    ],
    [
      "brak flagi powiązania (stary kształt metadanych)",
      { gift_recipient_bound_to_voucher_issue: null },
      "not_bound_to_voucher_issue",
    ],
  ])("%s → brak wysyłki, powód `%s`", async (_label, overrides, reason) => {
    const decision = evaluateGiftHandoff(giftSource(overrides))
    expect(decision).toEqual({ eligible: false, reason })

    // I to samo end-to-end: zero drugiego maila, zero drugiego wiersza ledgera.
    const { deps, sql, dispatchCalls } = makeDeps({ source: giftSource(overrides) })
    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.handoff).toMatchObject({
      outcome: "skipped_not_eligible",
      skip_reason: reason,
      dispatch_id: null,
    })
    expect(templatesOf(dispatchCalls)).toEqual([BUYER_TEMPLATE])
    expect(sql.dispatch.map((r) => r.template_key)).toEqual([BUYER_TEMPLATE])
  })

  it("`gift` + „od razu” + poprawny adres → decyzja pozytywna (jedyna ścieżka wysyłki)", () => {
    expect(evaluateGiftHandoff(giftSource())).toEqual({
      eligible: true,
      recipient_email: RECIPIENT_EMAIL,
    })
  })

  it("zastane `scheduled` NIE rzuca i NIE zostawia sierocego `queued`", async () => {
    const { deps, sql, logger } = makeDeps({
      source: giftSource({
        gift_recipient_send_timing: GIFT_SEND_TIMING_SCHEDULED,
      }),
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.handoff?.skip_reason).toBe("scheduled_deferred_v1150")
    // Wiersz ledgera istnieje TYLKO dla buyer-maila.
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0].template_key).toBe(BUYER_TEMPLATE)
    expect(sql.dispatch.some((r) => r.status === "queued")).toBe(false)
    expect(logger.entries.filter((e) => e.level === "error")).toEqual([])
    // Powód deferralu jest w logu — inaczej nikt nie zauważy niewysłanego prezentu.
    expect(
      logger.entries.some(
        (e) => (e.meta as Record<string, unknown>)?.reason === "scheduled_deferred_v1150",
      ),
    ).toBe(true)
  })

  it("`not_gift` NIE zaśmieca logu (to większość ruchu)", async () => {
    const { deps, logger } = makeDeps({ source: giftSource({ purchase_mode: "self" }) })
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(JSON.stringify(logger.entries)).not.toContain("not_gift")
  })
})

// ── AC1: matryca AD-7 — dwa dispatche, jeden ledger, jeden subscriber ──────

describe("AC1 — `voucher_handoff_link` w matrycy AD-7", () => {
  it("ISSUED + gift „od razu” → DWA dispatche: buyer + recipient", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({})

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(result.handoff?.outcome).toBe("sent")
    expect(templatesOf(dispatchCalls)).toEqual([BUYER_TEMPLATE, HANDOFF_TEMPLATE])

    // Ten SAM ledger, dwa wiersze rozróżnione kluczem (template_key + hash).
    expect(sql.dispatch).toHaveLength(2)
    expect(sql.dispatch.map((r) => r.template_key)).toEqual([
      BUYER_TEMPLATE,
      HANDOFF_TEMPLATE,
    ])
    expect(sql.dispatch.map((r) => r.recipient_hash)).toEqual([
      hashRecipientEmail(BUYER_EMAIL),
      hashRecipientEmail(RECIPIENT_EMAIL),
    ])
    expect(sql.dispatch.every((r) => r.status === "sent")).toBe(true)
    // Ten sam flow governance-owy — jedna flaga, jeden KPI (ADR-161).
    expect(new Set(sql.dispatch.map((r) => r.flow_id))).toEqual(
      new Set(["voucher_purchase_delivery"]),
    )
  })

  it("handoff idzie na adres OBDAROWANEJ, buyer-mail na adres kupującej", async () => {
    const { deps, dispatchCalls } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(dispatchCalls[0].to).toBe(BUYER_EMAIL)
    expect(dispatchCalls[1].to).toBe(RECIPIENT_EMAIL)
  })

  it("zakup NIE-prezentowy → dokładnie JEDEN dispatch (bez regresji 2.3)", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({
      source: giftSource({
        purchase_mode: null,
        gift_recipient_email: null,
        gift_recipient_send_timing: null,
        gift_recipient_bound_to_voucher_issue: null,
      }),
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(templatesOf(dispatchCalls)).toEqual([BUYER_TEMPLATE])
    expect(sql.dispatch).toHaveLength(1)
  })

  it("ACTIVE po ISSUED → ZERO nowych maili (dogonienie tych samych kluczy)", async () => {
    const sql = new FakeSql()
    const { deps, dispatchCalls } = makeDeps({ sql })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)

    expect(dispatchCalls).toHaveLength(2)
    expect(sql.dispatch).toHaveLength(2)
  })

  it("ACTIVE bez wcześniejszego ISSUED dogania OBIE wysyłki (emit jest best-effort)", async () => {
    const { deps, dispatchCalls, sql } = makeDeps({})

    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)

    expect(templatesOf(dispatchCalls)).toEqual([BUYER_TEMPLATE, HANDOFF_TEMPLATE])
    expect(sql.dispatch).toHaveLength(2)
  })

  it("N konsumpcji (ISSUED ×2 + ACTIVE ×2) → handoff wysłany DOKŁADNIE RAZ (NFR3)", async () => {
    const sql = new FakeSql()
    const { deps, dispatchCalls } = makeDeps({ sql })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)

    expect(
      dispatchCalls.filter((call) => call.template === HANDOFF_TEMPLATE),
    ).toHaveLength(1)
    expect(
      sql.dispatch.filter((row) => row.template_key === HANDOFF_TEMPLATE),
    ).toHaveLength(1)
  })

  it("klucz idempotencji Medusy rozróżnia obie wysyłki (inaczej druga zostaje zdedupowana)", async () => {
    const { deps, dispatchCalls } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const keys = dispatchCalls.map((call) => call.idempotency_key)
    expect(new Set(keys).size).toBe(2)
    expect(keys[1]).toContain(HANDOFF_TEMPLATE)
  })

  it("`delivery_state_changed.v1` NIE jest emitowany także na ścieżce handoffu", async () => {
    const { deps, dispatchCalls, logger, sql } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const trace = JSON.stringify({ dispatchCalls, l: logger.entries, d: sql.dispatch })
    expect(trace).not.toContain("delivery_state_changed")
  })
})

// ── AC2: niezależność awarii ───────────────────────────────────────────────

describe("AC2 — buyer-mail i handoff są niezależne w awarii", () => {
  it("awaria handoffu NIE cofa i NIE blokuje buyer-maila", async () => {
    const sql = new FakeSql()
    const { deps, dispatchCalls } = makeDeps({
      sql,
      dispatchImpl: async (payload) => {
        if (payload.template === HANDOFF_TEMPLATE) {
          const error = new Error("provider down") as Error & { code: string }
          error.code = "BREVO_TEMPLATE_NOT_CONFIGURED"
          throw error
        }
        return { external_id: "brevo-buyer" }
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(result.handoff?.outcome).toBe("failed")
    expect(result.handoff?.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    expect(dispatchCalls).toHaveLength(2)

    const buyerRow = sql.dispatch.find((r) => r.template_key === BUYER_TEMPLATE)
    const handoffRow = sql.dispatch.find((r) => r.template_key === HANDOFF_TEMPLATE)
    expect(buyerRow?.status).toBe("sent")
    expect(handoffRow?.status).toBe("failed")
  })

  it("awaria buyer-maila NIE blokuje handoffu", async () => {
    const sql = new FakeSql()
    const { deps } = makeDeps({
      sql,
      dispatchImpl: async (payload) => {
        if (payload.template === BUYER_TEMPLATE) {
          const error = new Error("provider down") as Error & { code: string }
          error.code = "BREVO_TEMPLATE_NOT_CONFIGURED"
          throw error
        }
        return { external_id: "brevo-handoff" }
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(result.handoff?.outcome).toBe("sent")
    expect(
      sql.dispatch.find((r) => r.template_key === HANDOFF_TEMPLATE)?.status,
    ).toBe("sent")
  })

  it("brak adresu KUPUJĄCEJ nie zabiera handoffu obdarowanej", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({
      source: giftSource({ buyer_email: null }),
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("skipped_missing_recipient")
    expect(result.handoff?.outcome).toBe("sent")
    expect(templatesOf(dispatchCalls)).toEqual([HANDOFF_TEMPLATE])
    expect(sql.dispatch).toHaveLength(1)
  })

  it("adres odbiorczyni = adres kupującej → DWA maile o różnych template_key", async () => {
    // Zachowanie ZDEFINIOWANE (ADR-163): klucz ledgera rozróżnia wysyłki, więc
    // ta sama skrzynka dostaje potwierdzenie zakupu i link handoff. Świadomie
    // NIE scalamy ich w v1 — scalenie byłoby cichą utratą jednego z maili.
    const { deps, sql, dispatchCalls } = makeDeps({
      source: giftSource({ gift_recipient_email: BUYER_EMAIL }),
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(templatesOf(dispatchCalls)).toEqual([BUYER_TEMPLATE, HANDOFF_TEMPLATE])
    expect(sql.dispatch).toHaveLength(2)
    // Ten sam hash, różne klucze szablonu — UNIQUE ich nie skleja.
    expect(new Set(sql.dispatch.map((r) => r.recipient_hash)).size).toBe(1)
  })
})

// ── AC3: locale KUPUJĄCEJ + link claim z prefiksem ─────────────────────────

describe("AC3 — locale handoffu to `purchase_locale`, nigdy locale odbiorczyni", () => {
  it("handoff idzie w locale zakupu, a link claim ma prefiks tego samego locale", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: giftSource({ purchase_locale: "de" }),
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const handoff = dispatchCalls[1].data as Record<string, unknown>
    expect(handoff.locale).toBe("de")
    // Story 5.7: nazwą linku handoffu jest `handoff_url` — tę czyta szablon.
    expect(handoff.handoff_url).toBe(
      `https://dev.bonbeauty.pl/de/voucher/${VOUCHER_CODE}`,
    )
    expect(handoff.claim_url).toBeUndefined()
  })

  it("`recipient_locale` w metadanych NIE nadpisuje `purchase_locale` (ADR-163, v1)", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: {
        ...giftSource({ purchase_locale: "pl" }),
        // Pole opcjonalne bez UI — kod nie wymyśla dla niego semantyki.
        recipient_locale: "de",
      } as PurchaseDeliverySource,
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect((dispatchCalls[1].data as Record<string, unknown>).locale).toBe("pl")
  })

  it("locale spoza listy rynku → fallback `locales.default` + `warn`, dla OBU wysyłek", async () => {
    const { deps, dispatchCalls, logger } = makeDeps({
      source: giftSource({ purchase_locale: "fr" }),
      locales: { default: "pl", supported: ["pl", "en"] },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect((dispatchCalls[0].data as Record<string, unknown>).locale).toBe("pl")
    expect((dispatchCalls[1].data as Record<string, unknown>).locale).toBe("pl")
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true)
  })

  it("brak treści szablonu dla `ua` → `failed` z kodem, NIGDY downgrade do `pl`", async () => {
    const { deps, sql } = makeDeps({
      source: giftSource({ purchase_locale: "ua" }),
      dispatchImpl: async (payload) => {
        if (payload.template === HANDOFF_TEMPLATE) {
          const error = new Error("no template") as Error & { code: string }
          error.code = "BREVO_TEMPLATE_NOT_CONFIGURED"
          throw error
        }
        return { external_id: "brevo-buyer" }
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.handoff?.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    const handoffRow = sql.dispatch.find((r) => r.template_key === HANDOFF_TEMPLATE)
    expect(handoffRow?.status).toBe("failed")
    // Locale wiersza pozostaje `ua` — retry dogoni po uzupełnieniu szablonu.
    expect(handoffRow?.locale).toBe("ua")
  })

  it("brak base URL storefrontu → fail-loud, ZERO maili i JEDEN wiersz `failed` (żadnego localhost)", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({ env: {} })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe("VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED")
    expect(result.handoff).toBeNull()
    // Istota tego testu jest NIENARUSZONA: zero wysyłek, więc żaden link z
    // `localhost` nie ma jak wyciec do klientki.
    expect(dispatchCalls).toHaveLength(0)
    // Story 5.7 fix-round — ZMIANA OCZEKIWANIA, świadoma. Wcześniej ta ścieżka
    // kończyła się BEZ wiersza w ledgerze i to był defekt, nie cecha: sweep 2.5
    // czyta brak wiersza jako „wysyłki zabrakło" i ponawiał ją co 15 minut bez
    // licznika prób i bez drogi do `dead_lettered` — ten sam kształt co N-1.
    // Zapisany wiersz `failed` włącza istniejący licznik ledgera, więc awaria
    // konfiguracji jest OGRANICZONA i WIDOCZNA dla operatora.
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0]).toMatchObject({
      status: "failed",
      error_code: "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED",
      attempt_count: 1,
    })
  })
})

// ── AC2/AC3/AC5: PII odbiorczyni ───────────────────────────────────────────

describe("PII — adres obdarowanej nie opuszcza pola `to` (D-70)", () => {
  it("ledger, audyt i logi znają odbiorczynię WYŁĄCZNIE jako hash", async () => {
    const { deps, sql, logger } = makeDeps({})

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const trace = JSON.stringify({ d: sql.dispatch, a: sql.audit, l: logger.entries })
    expect(trace).not.toContain("Obdarowana")
    expect(trace.toLowerCase()).not.toContain("obdarowana@example.test")
    expect(trace).not.toContain("@example.test")
    expect(
      sql.dispatch.find((r) => r.template_key === HANDOFF_TEMPLATE)?.recipient_hash,
    ).toBe(hashRecipientEmail(RECIPIENT_EMAIL))
  })

  it("payload handoffu niesie adres tylko w `to`; `data`/`metadata` mają hash", () => {
    const notification = buildHandoffLinkNotification({
      recipient_email: RECIPIENT_EMAIL,
      recipient_hash: hashRecipientEmail(RECIPIENT_EMAIL),
      entitlement_id: ENTITLEMENT_ID,
      voucher_code: VOUCHER_CODE,
      market_id: MARKET_ID,
      locale: "pl",
      voucher_page_url: `https://dev.bonbeauty.pl/pl/voucher/${VOUCHER_CODE}`,
      dispatch_id: "dispatch-1",
      customer_first_name: "Magda",
      salon_name: "Salon Bonbeauty",
      salon_address: "ul. Handlowa 10, 00-001 Warszawa",
      support_email: "kontakt@bonbeauty.pl",
      market_url: "https://dev.bonbeauty.pl",
      voucher_expires_at: "2027-07-30T00:00:00.000Z",
    })

    const { to, ...rest } = notification
    expect(to).toBe(RECIPIENT_EMAIL)
    expect(JSON.stringify(rest)).not.toContain("Obdarowana")
    expect(JSON.stringify(rest)).not.toContain("@example.test")
    expect(notification.template).toBe(HANDOFF_TEMPLATE)
  })

  it("powód pominięcia jest ENUMEM, nigdy adresem", async () => {
    const { deps, logger } = makeDeps({
      source: giftSource({ gift_recipient_email: "smieci-bez-malpy" }),
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.handoff?.skip_reason).toBe("invalid_recipient_email")
    expect(JSON.stringify(logger.entries)).not.toContain("smieci-bez-malpy")
  })
})
