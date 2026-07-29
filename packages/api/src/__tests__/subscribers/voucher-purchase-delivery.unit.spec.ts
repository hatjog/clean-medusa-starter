/**
 * voucher-purchase-delivery.unit.spec.ts — Story 2.3 (AC2 / AC3 / AC4 / AC5).
 *
 * Testy bez kontenera Medusy, bez DB i BEZ SIECI: `createNotifications` jest
 * atrapą, a klient Brevo nigdy nie powstaje. Żaden test nie może wysłać maila.
 */

import {
  extractPurchaseDeliveryTrigger,
  handleVoucherPurchaseDelivery,
  MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
  STALE_QUEUED_THRESHOLD_MS,
  type PurchaseDeliveryDeps,
  type PurchaseDeliverySource,
} from "../../subscribers/voucher-purchase-delivery"
import {
  DispatchLedgerError,
  PgDispatchLedger,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"
import {
  buildClaimUrl,
  marketStorefrontUrlEnvKey,
  resolveStorefrontBaseUrl,
  StorefrontBaseUrlNotConfiguredError,
} from "../../modules/voucher-delivery/purchase-confirmation-intent"
import {
  formatErrorCodeMarker,
  NOTIFICATION_TEMPLATE_KEYS,
} from "@gp/messaging"

const BUYER_EMAIL = "Kupujaca@Example.Test"
const ENTITLEMENT_ID = "entinst_2_3_001"
const VOUCHER_CODE = "BB-ABCD-1234"
const MARKET_ID = "bonbeauty"
const TEMPLATE_KEY = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION

// ── Atrapy ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/** Ta sama atrapa co w teście ledgera: emuluje UNIQUE + guardy `WHERE status`. */
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
        attempt_count,
        occurred_at,
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
        attempt_count,
        occurred_at,
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
        // Bindingi w kolejności WYSTĄPIEŃ `?` (dialekt Knexa) — patrz R-2.3-H1.
        const [provider, messageId, , , id] = bindings as string[]
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
        const [provider, errorCode, , , id] = bindings as string[]
        const row = this.byId(id)
        if (!row || row.status !== "queued") return { rows: [] }
        Object.assign(row, {
          status: "failed",
          provider: provider ?? row.provider,
          error_code: errorCode,
        })
        return { rows: [{ ...row }] }
      }
      const [now, , locale, market_id, flow_id, id, ...allowed] = bindings as string[]
      const row = this.byId(id)
      if (!row || !allowed.includes(row.status as string)) return { rows: [] }
      void now
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

function makeDeps(overrides: {
  source?: PurchaseDeliverySource | null
  sourceError?: Error
  dispatchImpl?: (payload: Record<string, unknown>) => Promise<unknown>
  locales?: { default: string; supported: string[] }
  /** R-2.3-M6: konfiguracja locale rynku NIEZNANA (błąd odczytu / brak bloku). */
  localesDegraded?: boolean
  sql?: FakeSql
  env?: NodeJS.ProcessEnv
  ledgerOverride?: PurchaseDeliveryDeps["ledger"]
}) {
  const sql = overrides.sql ?? new FakeSql()
  const logger = makeLogger()
  const dispatchCalls: Array<Record<string, unknown>> = []
  let seq = 0

  const deps: PurchaseDeliveryDeps = {
    sourceReader: {
      async findBuyerClaimSource() {
        if (overrides.sourceError) throw overrides.sourceError
        return overrides.source === undefined
          ? {
              buyer_email: BUYER_EMAIL,
              voucher_code: VOUCHER_CODE,
              market_id: MARKET_ID,
              purchase_locale: "pl",
            }
          : overrides.source
      },
    },
    ledger:
      overrides.ledgerOverride ??
      new PgDispatchLedger(sql, {
        uuid: () => `dispatch-${++seq}`,
        now: () => new Date("2026-07-26T12:00:00.000Z"),
      }),
    dispatcher: {
      async dispatch(payload) {
        dispatchCalls.push(payload)
        if (overrides.dispatchImpl) return overrides.dispatchImpl(payload)
        return { id: "brevo-message-1" }
      },
    },
    marketLocales: {
      async read() {
        return {
          config:
            overrides.locales ?? { default: "pl", supported: ["pl", "en", "ua", "de"] },
          degraded: overrides.localesDegraded ?? false,
        }
      },
    },
    logger,
    env: overrides.env ?? { STOREFRONT_URL: "https://dev.bonbeauty.pl" },
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
    idempotency_key: `entitlement:${ENTITLEMENT_ID}:transition:${fromState}->${toState}`,
    payload: {
      entitlement_id: ENTITLEMENT_ID,
      from_state: fromState,
      to_state: toState,
      transitioned_at: "2026-07-26T12:00:00.000Z",
    },
  }
}

// ── Normalizacja wejścia ───────────────────────────────────────────────────

describe("extractPurchaseDeliveryTrigger", () => {
  it("czyta kopertę envelope.v1 (payload + scope.market_id)", () => {
    expect(extractPurchaseDeliveryTrigger(envelope("ISSUED"))).toEqual({
      entitlement_id: ENTITLEMENT_ID,
      to_state: "ISSUED",
      from_state: "__genesis__",
      market_id: MARKET_ID,
    })
  })

  it("toleruje płaski payload (bez koperty)", () => {
    expect(
      extractPurchaseDeliveryTrigger({
        entitlement_id: ENTITLEMENT_ID,
        to_state: "ACTIVE",
        from_state: "ISSUED",
      }),
    ).toEqual({
      entitlement_id: ENTITLEMENT_ID,
      to_state: "ACTIVE",
      from_state: "ISSUED",
      market_id: null,
    })
  })

  it("nie wywraca się na śmieciowym wejściu", () => {
    expect(extractPurchaseDeliveryTrigger(null)).toEqual({
      entitlement_id: null,
      to_state: null,
      from_state: null,
      market_id: null,
    })
  })
})

// ── AC2: matryca AD-7 ──────────────────────────────────────────────────────

describe("AC2 — matryca normatywna AD-7 (stan → szablon)", () => {
  it("ISSUED → dokładnie jeden dispatch `voucher_purchase_confirmation` do buyera", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({})

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0].template).toBe(TEMPLATE_KEY)
    expect((dispatchCalls[0].data as Record<string, unknown>).template_key).toBe(
      TEMPLATE_KEY,
    )
    expect(dispatchCalls[0].to).toBe(BUYER_EMAIL)
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0].status).toBe("sent")
  })

  it("ACTIVE bez wcześniejszego ISSUED → dogonienie (JEDEN mail, ten sam template_key)", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({})

    const result = await handleVoucherPurchaseDelivery(
      envelope("ACTIVE", "ISSUED"),
      deps,
    )

    expect(result.outcome).toBe("sent")
    expect(dispatchCalls).toHaveLength(1)
    // ACTIVE nie wprowadza NOWEGO szablonu — dogania ten sam klucz.
    expect(dispatchCalls[0].template).toBe(TEMPLATE_KEY)
    expect(sql.dispatch.map((r) => r.template_key)).toEqual([TEMPLATE_KEY])
  })

  it.each([
    "REDEEMED_FULL",
    "EXPIRED",
    "VOIDED",
    "REFUNDED",
    "PENDING_VENDOR_DECISION",
  ])("stan %s spoza matrycy → no-op BEZ błędu i bez wiersza w ledgerze", async (state) => {
    const { deps, sql, dispatchCalls, logger } = makeDeps({})

    const result = await handleVoucherPurchaseDelivery(envelope(state, "ACTIVE"), deps)

    expect(result.outcome).toBe("skipped_state_out_of_matrix")
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
    expect(logger.entries.filter((e) => e.level === "error")).toEqual([])
  })

  it("NIE implementuje gift/handoff (`voucher_handoff_link` = Story 2.4)", async () => {
    const { deps, dispatchCalls } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(JSON.stringify(dispatchCalls)).not.toContain("voucher_handoff_link")
  })

  it("payload niesie market_id + flow_id + locale (bez nich provider nie rozwiąże nadawcy)", async () => {
    const { deps, dispatchCalls } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(dispatchCalls[0].data).toMatchObject({
      market_id: MARKET_ID,
      flow_id: "voucher_purchase_delivery",
      locale: "pl",
    })
  })
})

// ── AC5: idempotencja end-to-end (NFR3) ────────────────────────────────────

describe("AC5 — idempotencja end-to-end (NFR3)", () => {
  it("N konsumpcji (ISSUED ×2 + ACTIVE ×2) → `createNotifications` wywołane DOKŁADNIE RAZ", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({})

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)

    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0].status).toBe("sent")
  })

  it("ACTIVE po ISSUED nie tworzy drugiego wiersza ani drugiego maila", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({})

    const first = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    const second = await handleVoucherPurchaseDelivery(
      envelope("ACTIVE", "ISSUED"),
      deps,
    )

    expect(first.outcome).toBe("sent")
    expect(second.outcome).toBe("skipped_already_sent")
    expect(dispatchCalls).toHaveLength(1)
    expect(sql.dispatch).toHaveLength(1)
  })

  it("redelivery webhooka: 5 konsumpcji tej samej tranzycji → jeden mail", async () => {
    const { deps, dispatchCalls } = makeDeps({})

    for (let i = 0; i < 5; i += 1) {
      await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    }

    expect(dispatchCalls).toHaveLength(1)
  })

  it("`sent` blokuje ponowną wysyłkę BEZWARUNKOWO", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({})

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    expect(sql.dispatch[0].status).toBe("sent")

    const again = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    expect(again.outcome).toBe("skipped_already_sent")
    expect(dispatchCalls).toHaveLength(1)
  })

  it("`failed` NIE blokuje legalnego retry — druga konsumpcja wysyła ponownie", async () => {
    const sql = new FakeSql()
    let attempt = 0
    const { deps, dispatchCalls } = makeDeps({
      sql,
      dispatchImpl: async () => {
        attempt += 1
        if (attempt === 1) {
          const error = new Error("provider odrzucił") as Error & { code: string }
          error.code = "BREVO_TEMPLATE_NOT_CONFIGURED"
          throw error
        }
        return { id: "brevo-retry-1" }
      },
    })

    const first = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    expect(first.outcome).toBe("failed")
    expect(first.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    expect(sql.dispatch[0].status).toBe("failed")

    const retry = await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)
    expect(retry.outcome).toBe("sent")
    expect(dispatchCalls).toHaveLength(2)
    // Nadal JEDEN wiersz — retry przejmuje rezerwację.
    expect(sql.dispatch).toHaveLength(1)
    expect(sql.dispatch[0].status).toBe("sent")
  })

  it("test-the-test: upsert nadpisujący stan (zamiast ON CONFLICT DO NOTHING) ŁAMIE ten test", async () => {
    // Atrapa ledgera zachowująca się jak `ON CONFLICT DO UPDATE` resetujący
    // status do `queued` — czyli dokładnie regresja, przed którą broni AC5.
    const rows = new Map<string, { dispatch_id: string; status: string }>()
    let seq = 0
    const brokenLedger: PurchaseDeliveryDeps["ledger"] = {
      async reserveDispatch(input) {
        const key = `${input.entitlement_id}|${input.template_key}|${input.recipient_hash}`
        const existing = rows.get(key)
        if (existing) {
          existing.status = "queued" // ← upsert nadpisujący stan
          return {
            outcome: "reserved",
            dispatch_id: existing.dispatch_id,
            status: "queued",
            attempt_count: 1,
            queued_at: null,
          }
        }
        const row = { dispatch_id: `broken-${++seq}`, status: "queued" }
        rows.set(key, row)
        return {
          outcome: "reserved",
          dispatch_id: row.dispatch_id,
          status: "queued",
          attempt_count: 1,
          queued_at: null,
        }
      },
      async markSent() {
        return true
      },
      async markFailed() {
        return true
      },
      async findByIdentity() {
        return null
      },
    }

    const { deps, dispatchCalls } = makeDeps({ ledgerOverride: brokenLedger })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    await handleVoucherPurchaseDelivery(envelope("ACTIVE", "ISSUED"), deps)

    // Regresja jest WIDOCZNA: dwa maile zamiast jednego.
    expect(dispatchCalls.length).toBeGreaterThan(1)
  })

  it("idempotency_key Medusy jest wyprowadzony z klucza ledgera (dwie warstwy, jedna tożsamość)", async () => {
    const { deps, dispatchCalls } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const hash = hashRecipientEmail(BUYER_EMAIL)
    expect(dispatchCalls[0].idempotency_key).toBe(
      `voucher-purchase-delivery:${ENTITLEMENT_ID}:${TEMPLATE_KEY}:${hash}`,
    )
  })
})

// ── AC3: locale zakupu ─────────────────────────────────────────────────────

describe("AC3 — purchase_locale: odczyt, walidacja, jawny fallback", () => {
  it("purchase_locale obecne i wspierane → mail w tym locale", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: "ua",
      },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect((dispatchCalls[0].data as Record<string, unknown>).locale).toBe("ua")
  })

  it("brak purchase_locale → fallback `locales.default` Z LOGIEM (nigdy cichy)", async () => {
    const { deps, dispatchCalls, logger } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: null,
      },
      locales: { default: "pl", supported: ["pl", "en"] },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect((dispatchCalls[0].data as Record<string, unknown>).locale).toBe("pl")
    const warn = logger.entries.find(
      (e) =>
        e.level === "warn" &&
        e.message.includes("[market-locale]") &&
        (e.meta as Record<string, unknown> | undefined)?.reason === "missing",
    )
    expect(warn).toBeDefined()
    expect((warn?.meta as Record<string, unknown>).market_id).toBe(MARKET_ID)
  })

  it("locale spoza listy rynku → fallback + `warn` (nie wysyłka w nieistniejącym locale)", async () => {
    const { deps, dispatchCalls, logger } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: "fr",
      },
      locales: { default: "pl", supported: ["pl", "en"] },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect((dispatchCalls[0].data as Record<string, unknown>).locale).toBe("pl")
    expect(
      logger.entries.some(
        (e) =>
          e.level === "warn" &&
          (e.meta as Record<string, unknown> | undefined)?.reason ===
            "not_supported_by_market",
      ),
    ).toBe(true)
  })

  it("`buyer_locale` ze snapshotu polityki jest wtórnym nośnikiem tej samej intencji", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: null,
        buyer_locale: "en",
      },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    expect((dispatchCalls[0].data as Record<string, unknown>).locale).toBe("en")
  })
})

// ── AC4: treść maila (kod + link claim) ────────────────────────────────────

describe("AC4 — kod vouchera + link claim z prefiksem locale", () => {
  it("payload zawiera kod vouchera i link claim z prefiksem locale ZAKUPU", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: "ua",
      },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const data = dispatchCalls[0].data as Record<string, unknown>
    expect(data.voucher_code).toBe(VOUCHER_CODE)
    expect(data.claim_url).toBe(
      `https://dev.bonbeauty.pl/ua/voucher/${VOUCHER_CODE}`,
    )
    // Twarde `pl` w linku to dokładnie regresja, której zakazuje AC4.
    expect(String(data.claim_url)).not.toContain("/pl/")
  })

  it("brak base URL storefrontu → FAIL-LOUD z kodem błędu, nigdy link do localhost", async () => {
    const { deps, sql, dispatchCalls, logger } = makeDeps({ env: {} })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe(
      "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED",
    )
    expect(dispatchCalls).toHaveLength(0)
    // Brak konfiguracji nie zostawia po sobie sierotnego wiersza `queued`.
    expect(sql.dispatch).toHaveLength(0)
    expect(JSON.stringify(logger.entries)).not.toContain("localhost")
  })

  it("per-market env ma pierwszeństwo nad globalnym STOREFRONT_URL", () => {
    expect(marketStorefrontUrlEnvKey("bonbeauty")).toBe(
      "GP_STOREFRONT_URL_BONBEAUTY",
    )
    expect(
      resolveStorefrontBaseUrl({
        marketId: "bonbeauty",
        env: {
          GP_STOREFRONT_URL_BONBEAUTY: "https://bonbeauty.pl/",
          STOREFRONT_URL: "https://fallback.example",
        },
      }),
    ).toBe("https://bonbeauty.pl")
  })

  it("brak jakiejkolwiek konfiguracji base URL rzuca, a nie zwraca localhost", () => {
    expect(() => resolveStorefrontBaseUrl({ marketId: "bonbeauty", env: {} })).toThrow(
      StorefrontBaseUrlNotConfiguredError,
    )
  })

  it("kod vouchera w linku jest URL-encoded", () => {
    expect(
      buildClaimUrl({
        baseUrl: "https://x.test/",
        locale: "pl",
        voucherCode: "A B/C",
      }),
    ).toBe("https://x.test/pl/voucher/A%20B%2FC")
  })

  it("brak voucher_code → graceful skip (mail bez kodu nie spełnia AC4)", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: null,
        market_id: MARKET_ID,
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("skipped_missing_voucher_code")
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
  })
})

// ── AC2: defensywność + zero PII ───────────────────────────────────────────

describe("AC2 — defensywność: graceful skip + log bez PII, nigdy rzucony wyjątek", () => {
  it("brak encji źródłowej → graceful skip + log z market_id i przyczyną", async () => {
    const { deps, logger, dispatchCalls } = makeDeps({ source: null })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("skipped_source_not_found")
    expect(dispatchCalls).toHaveLength(0)
    expect(
      logger.entries.some(
        (e) => e.level === "warn" && e.message.includes("brak encji źródłowej"),
      ),
    ).toBe(true)
  })

  it("brak adresu odbiorcy → graceful skip, ZERO wierszy w ledgerze", async () => {
    const { deps, sql, dispatchCalls } = makeDeps({
      source: { buyer_email: null, voucher_code: VOUCHER_CODE, market_id: MARKET_ID },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("skipped_missing_recipient")
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
  })

  it("LOW#6 (code-review 2.4): brak buyer-maila + brak konfiguracji base URL + NIE-prezent → skip cichy, NIE fałszywy `failed` konfiguracji", async () => {
    // Zamówienie importowe/admin: bez buyer_email, bez kontraktu prezentu, na
    // rynku bez skonfigurowanego GP_STOREFRONT_URL. Przed poprawką: subscriber
    // wchodził w bramkę base URL mimo braku odbiorcy i zwracał `failed` +
    // `VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED` — fałszywy sygnał awarii
    // konfiguracji dla przypadku, w którym nie było w ogóle komu nic wysłać.
    const { deps, sql, dispatchCalls } = makeDeps({
      source: { buyer_email: null, voucher_code: VOUCHER_CODE, market_id: MARKET_ID },
      env: {},
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("skipped_missing_recipient")
    expect(result.error_code).toBeNull()
    expect(result.handoff).toEqual({
      outcome: "skipped_not_eligible",
      dispatch_id: null,
      locale: null,
      error_code: null,
      skip_reason: "not_gift",
    })
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
  })

  it("event bez entitlement_id → graceful skip", async () => {
    const { deps } = makeDeps({})
    const result = await handleVoucherPurchaseDelivery(
      { payload: { to_state: "ISSUED" } },
      deps,
    )
    expect(result.outcome).toBe("skipped_missing_entitlement_id")
  })

  it("awaria projekcji źródłowej NIE rzuca (konsumpcja eventu nie może się wywrócić)", async () => {
    const { deps } = makeDeps({ sourceError: new Error("PG down") })

    await expect(
      handleVoucherPurchaseDelivery(envelope("ISSUED"), deps),
    ).resolves.toMatchObject({ outcome: "skipped_source_not_found" })
  })

  it("awaria ledgera → NIE wysyłamy (wysyłka bez rezerwacji łamie NFR3)", async () => {
    const brokenLedger: PurchaseDeliveryDeps["ledger"] = {
      async reserveDispatch() {
        throw new DispatchLedgerError("ledger down", "VOUCHER_DELIVERY_LEDGER_UNAVAILABLE")
      },
      async markSent() {
        return false
      },
      async markFailed() {
        return false
      },
      async findByIdentity() {
        return null
      },
    }
    const { deps, dispatchCalls } = makeDeps({ ledgerOverride: brokenLedger })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe("VOUCHER_DELIVERY_LEDGER_UNAVAILABLE")
    expect(dispatchCalls).toHaveLength(0)
  })

  it("awaria wysyłki NIE rzuca i zapisuje `failed` z KODEM błędu (nie treścią providera)", async () => {
    const sql = new FakeSql()
    const { deps, logger } = makeDeps({
      sql,
      dispatchImpl: async () => {
        const error = new Error(
          "Brevo 400: recipient Kupujaca@Example.Test rejected",
        ) as Error & { code: string }
        error.code = "BREVO_TEMPLATE_NOT_CONFIGURED"
        throw error
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(sql.dispatch[0].status).toBe("failed")
    expect(sql.dispatch[0].error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    // Treść odpowiedzi providera (z adresem!) NIE trafia do ledgera ani logów.
    const trace = JSON.stringify({ d: sql.dispatch, a: sql.audit, l: logger.entries })
    expect(trace).not.toContain("Kupujaca@Example.Test")
    expect(trace).not.toContain("rejected")
  })

  it("ŻADEN log ani wiersz nie zawiera adresu e-mail na ścieżce sukcesu (D-70)", async () => {
    const { deps, sql, logger } = makeDeps({})

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const trace = JSON.stringify({ d: sql.dispatch, a: sql.audit, l: logger.entries })
    expect(trace).not.toContain("Kupujaca")
    expect(trace.toLowerCase()).not.toContain("kupujaca@example.test")
    expect(trace).not.toContain("@example.test")
    // Do ledgera/audytu idzie wyłącznie hash.
    expect(sql.dispatch[0].recipient_hash).toBe(hashRecipientEmail(BUYER_EMAIL))
  })

  it("adres pojawia się WYŁĄCZNIE w polu `to` payloadu (wymóg kanału)", async () => {
    const { deps, dispatchCalls } = makeDeps({})
    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const { to, ...rest } = dispatchCalls[0]
    expect(to).toBe(BUYER_EMAIL)
    expect(JSON.stringify(rest)).not.toContain("Kupujaca")
    expect(JSON.stringify(rest)).not.toContain("@example.test")
  })
})

// ── AC6b: market_id z danych domenowych ────────────────────────────────────

describe("AC6b — market_id z danych domenowych, nie z GP_DEFAULT_MARKET_ID", () => {
  it("preferuje `scope.market_id` koperty", async () => {
    const { deps, dispatchCalls, logger } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: null,
        purchase_locale: "pl",
      },
      env: { STOREFRONT_URL: "https://dev.bonbeauty.pl", GP_DEFAULT_MARKET_ID: "zly-rynek" },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect((dispatchCalls[0].data as Record<string, unknown>).market_id).toBe(MARKET_ID)
    // Brak `warn` fallbacku na ścieżce produkcyjnej.
    expect(
      logger.entries.some((e) => e.message.includes("[notification-market-context]")),
    ).toBe(false)
  })

  it("gdy koperta nie niesie rynku, bierze go z projekcji źródłowej", async () => {
    const { deps, dispatchCalls, logger } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: "bongarden",
        purchase_locale: "pl",
      },
    })

    await handleVoucherPurchaseDelivery(
      { payload: { entitlement_id: ENTITLEMENT_ID, to_state: "ISSUED" } },
      deps,
    )

    expect((dispatchCalls[0].data as Record<string, unknown>).market_id).toBe("bongarden")
    expect(
      logger.entries.some((e) => e.message.includes("[notification-market-context]")),
    ).toBe(false)
  })

  it("dopiero brak rynku w danych domenowych daje GŁOŚNY fallback konfiguracyjny", async () => {
    const { deps, dispatchCalls, logger } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: null,
        purchase_locale: "pl",
      },
      env: {
        STOREFRONT_URL: "https://dev.bonbeauty.pl",
        GP_DEFAULT_MARKET_ID: "bonbeauty",
      },
    })

    await handleVoucherPurchaseDelivery(
      { payload: { entitlement_id: ENTITLEMENT_ID, to_state: "ISSUED" } },
      deps,
    )

    expect((dispatchCalls[0].data as Record<string, unknown>).market_id).toBe("bonbeauty")
    expect(
      logger.entries.some(
        (e) =>
          e.level === "warn" && e.message.includes("[notification-market-context]"),
      ),
    ).toBe(true)
  })
})

// ── Findingi review 2.3 (R-2.3-M3 / M4 / M6 / L9) ──────────────────────────

describe("R-2.3-M3 — kod błędu przeżywa przepakowanie przez moduł Notification Medusy", () => {
  /**
   * Kształt błędu wytwarzany PRODUKCYJNIE: moduł Notification Medusy robi
   * `new MedusaError(UNEXPECTED_STATE, "Failed to send notification with id …")`
   * BEZ trzeciego argumentu (czyli bez `code`), a `promiseAll({ aggregateErrors:
   * true })` opakowuje to w ZWYKŁY `Error`. Ani `error_code`, ani `code` nie
   * istnieją na obiekcie, który dociera do subscribera.
   */
  function medusaRewrapped(providerErrorCode: string): Error {
    const providerMessage =
      `[notification-brevo] dispatch failed for template 'voucher_purchase_confirmation': ` +
      `${formatErrorCodeMarker(providerErrorCode)} ${providerErrorCode}`
    return new Error(
      `Failed to send notification with id noti_01:\n${providerMessage}`,
    )
  }

  it("wyciąga kod z markera, gdy `code`/`error_code` NIE przeżyły opakowań", async () => {
    const { deps, sql } = makeDeps({
      dispatchImpl: async () => {
        throw medusaRewrapped("BREVO_TEMPLATE_NOT_CONFIGURED")
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
    expect(sql.dispatch[0].error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
  })

  it("wyciąga kod z markera zachowanego wyłącznie w zagnieżdżonym cause agregatu Medusy", async () => {
    const { deps, sql } = makeDeps({
      dispatchImpl: async () => {
        const providerError = new Error(
          `Brevo sender missing ${formatErrorCodeMarker("BREVO_SENDER_NOT_CONFIGURED")}`,
        )
        const aggregate = new Error("Failed to send notification with id noti_01") as Error & {
          cause?: Error
          errors?: Error[]
        }
        aggregate.cause = providerError
        aggregate.errors = [providerError]
        throw aggregate
      },
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.error_code).toBe("BREVO_SENDER_NOT_CONFIGURED")
    expect(sql.dispatch[0].error_code).toBe("BREVO_SENDER_NOT_CONFIGURED")
  })

  it("rozróżnia FLOW_DISABLED od awarii szablonu (sygnał kierunkowy dla triage'u)", async () => {
    const { deps, sql } = makeDeps({
      dispatchImpl: async () => {
        throw medusaRewrapped("FLOW_DISABLED")
      },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    expect(sql.dispatch[0].error_code).toBe("FLOW_DISABLED")
  })

  it("test-the-test: bez markera kod jest generyczny (to był stan przed poprawką)", async () => {
    const { deps, sql } = makeDeps({
      dispatchImpl: async () => {
        throw new Error("Failed to send notification with id noti_01:\nboom")
      },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)
    expect(sql.dispatch[0].error_code).toBe("VOUCHER_DELIVERY_DISPATCH_FAILED")
  })

  it("marker NIE przepuszcza treści komunikatu do ledgera ani do logów (D-70)", async () => {
    const { deps, sql, logger } = makeDeps({
      dispatchImpl: async () => {
        throw new Error(
          `Failed to send notification with id noti_01:\n` +
            `${formatErrorCodeMarker("BREVO_RECIPIENT_REJECTED")} rejected ${BUYER_EMAIL}`,
        )
      },
    })

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    const trace = JSON.stringify({ d: sql.dispatch, a: sql.audit, l: logger.entries })
    expect(sql.dispatch[0].error_code).toBe("BREVO_RECIPIENT_REJECTED")
    expect(trace).not.toContain("rejected")
    expect(trace).not.toContain("Kupujaca")
  })
})

describe("R-2.3-M4 — provider_message_id to identyfikator PROVIDERA, nie Medusy", () => {
  it("czyta `external_id` (tam Medusa zapisuje ID providera), nie `id`", async () => {
    const { deps, sql } = makeDeps({
      dispatchImpl: async () => [{ id: "noti_01JMEDUSA", external_id: "brevo-msg-77" }],
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(sql.dispatch[0].provider_message_id).toBe("brevo-msg-77")
  })

  it("dedup Medusy (pusta lista notyfikacji) → provider_message_id `null`, nie błąd", async () => {
    const { deps, sql } = makeDeps({ dispatchImpl: async () => [] })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(sql.dispatch[0].provider_message_id).toBeNull()
  })
})

describe("R-2.3-M6 — degradacja konfiguracji locale NIE degraduje maila do locale domyślnego", () => {
  it("konfiguracja locale nieznana + locale zakupu `ua` → `failed`, NIE mail po polsku", async () => {
    const { deps, sql, dispatchCalls, logger } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: "ua",
      },
      locales: { default: "pl", supported: ["pl"] },
      localesDegraded: true,
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("failed")
    expect(result.error_code).toBe(MARKET_LOCALES_UNAVAILABLE_ERROR_CODE)
    // Ani maila, ani rezerwacji — to błąd konfiguracji, nie nieudana wysyłka.
    expect(dispatchCalls).toHaveLength(0)
    expect(sql.dispatch).toHaveLength(0)
    expect(logger.entries.some((e) => e.level === "error")).toBe(true)
  })

  it("konfiguracja locale ZNANA + locale spoza listy rynku → legalny fallback (bez zmiany zachowania)", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: "ua",
      },
      locales: { default: "pl", supported: ["pl"] },
      localesDegraded: false,
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(result.locale).toBe("pl")
    expect(dispatchCalls).toHaveLength(1)
  })

  it("degradacja BEZ locale w danych domenowych → wysyłka w `locales.default` (AC3)", async () => {
    const { deps, dispatchCalls } = makeDeps({
      source: {
        buyer_email: BUYER_EMAIL,
        voucher_code: VOUCHER_CODE,
        market_id: MARKET_ID,
        purchase_locale: null,
      },
      localesDegraded: true,
    })

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("sent")
    expect(dispatchCalls).toHaveLength(1)
  })
})

describe("R-2.3-L9 — porzucone `queued` jest widoczne jako `warn`, nie `info`", () => {
  function ledgerInFlight(queuedAt: string | null): PurchaseDeliveryDeps["ledger"] {
    return {
      async reserveDispatch() {
        return {
          outcome: "in_flight",
          dispatch_id: "dispatch-stale",
          status: "queued",
          attempt_count: 1,
          queued_at: queuedAt,
        }
      },
      async markSent() {
        return true
      },
      async markFailed() {
        return true
      },
      async findByIdentity() {
        return null
      },
    }
  }

  const NOW = new Date("2026-07-26T12:00:00.000Z")

  it("`queued` starsze niż próg → `warn` z odesłaniem do sweepa 2.5", async () => {
    const { deps, logger } = makeDeps({
      ledgerOverride: ledgerInFlight(
        new Date(NOW.getTime() - STALE_QUEUED_THRESHOLD_MS - 1_000).toISOString(),
      ),
    })
    deps.now = () => NOW

    const result = await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(result.outcome).toBe("skipped_in_flight")
    const warned = logger.entries.find(
      (e) => e.level === "warn" && e.message.includes("porzucona"),
    )
    expect(warned).toBeDefined()
    expect(warned?.meta).toMatchObject({ stale_queued: true })
  })

  it("świeże `queued` (realnie w locie) zostaje `info` — bez fałszywego alarmu", async () => {
    const { deps, logger } = makeDeps({
      ledgerOverride: ledgerInFlight(new Date(NOW.getTime() - 1_000).toISOString()),
    })
    deps.now = () => NOW

    await handleVoucherPurchaseDelivery(envelope("ISSUED"), deps)

    expect(logger.entries.some((e) => e.level === "warn")).toBe(false)
    expect(
      logger.entries.some(
        (e) => e.level === "info" && e.message.includes("inny konsument"),
      ),
    ).toBe(true)
  })
})
