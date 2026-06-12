/**
 * live-issue-from-payment-intent.test.ts — Story 3.3 AC2/AC3/AC4 (rdzeń live-issue).
 *
 * Behawioralny test rdzenia Path Y na in-memory fake PgClient z WIERNĄ semantyką
 * `ON CONFLICT DO NOTHING` (event_processed event-level + entitlement_dedupe_key
 * per-entitlement). Dowodzi:
 *   - AC2: subscriber tworzy L4 ISSUED, order_id non-nullable, policy + VAT snapshot,
 *     market_id + sales_channel_id wypełnione (ontologia 3.2);
 *   - AC4: retry tego samego eventu ⇒ JEDEN entitlement (no-op na 2. przebiegu);
 *          jeden zakup z N recipientami ⇒ N entitlementów (FR10);
 *   - AC3 (snapshot): vat_classification snapshotowany z resolvera 2.2 przy ISSUED.
 *
 * Kontrakt: ADR-137 DEC-5 (dwupoziomowa idempotencja, atomicity), FR10/FR11/FR15/FR32.
 */
import { describe, it, expect } from "@jest/globals"

import {
  liveIssueEntitlementsWithinTx,
  assertReferencePriceInvariant,
  type LiveIssueInput,
  type LiveIssuePgClient,
} from "../live-issue-from-payment-intent"
import {
  EntitlementInstanceState,
  EntitlementType,
} from "../../../modules/voucher/models/entitlement"
import { buildEntitlementDedupeKey } from "../../../modules/voucher/models/entitlement-dedupe"
import { VoucherPostingInvariantError } from "../../../modules/voucher/posting-profile"

type EntitlementRow = {
  id: string
  entitlement_profile_id: string
  entitlement_type: string
  order_id: string
  line_item_id: string
  state: string
  policy_snapshot: string
  market_id: string | null
  sales_channel_id: string | null
  vat_classification: string
  reference_price_minor: number | null
  entitlement_dedupe_key: string
  recipient_index: number
  recipient_customer_id: string | null
}

type ChoiceSetRow = {
  id: string
  instance_id: string
  market_id: string
  label: string | null
  reference_amount_minor: number
  remaining_minor: number
  vat_classification: string
  status: string
  redemption_id: string | null
}

type OrderFixture = {
  sales_channel_id: string | null
  metadata: Record<string, unknown> | null
}
type LineFixture = { line_item_id: string; metadata: Record<string, unknown> | null }

/**
 * In-memory fake PgClient odwzorowujący DDL/ON CONFLICT Story 3.2/3.3:
 *   - event_processed: composite PK (external_id, event_type) ⇒ replay = 0 rows;
 *   - entitlement_instance: partial UNIQUE (entitlement_dedupe_key) ⇒ re-insert = 0 rows.
 */
function makeFakeClient(order: OrderFixture, lines: LineFixture[]) {
  const eventProcessed = new Set<string>()
  const entitlements = new Map<string, EntitlementRow>()
  const choiceSetItems = new Map<string, ChoiceSetRow>()

  const client: LiveIssuePgClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async <T = Record<string, unknown>>(sql: string, values: ReadonlyArray<unknown> = []): Promise<{ rows: T[]; rowCount: number }> => {
      if (/INSERT INTO event_processed/i.test(sql)) {
        const key = `${values[0]}|${values[1]}`
        if (eventProcessed.has(key)) return { rows: [], rowCount: 0 }
        eventProcessed.add(key)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM "order"/i.test(sql)) {
        return { rows: [order] as unknown as T[], rowCount: order ? 1 : 0 }
      }
      if (/FROM order_item/i.test(sql)) {
        return { rows: lines as unknown as T[], rowCount: lines.length }
      }
      if (/INSERT INTO entitlement_instance/i.test(sql)) {
        const dedupeKey = values[11] as string
        if (entitlements.has(dedupeKey)) {
          // ON CONFLICT (entitlement_dedupe_key) DO NOTHING ⇒ brak RETURNING.
          return { rows: [], rowCount: 0 }
        }
        const row: EntitlementRow = {
          id: values[0] as string,
          entitlement_profile_id: values[1] as string,
          entitlement_type: values[2] as string,
          order_id: values[3] as string,
          line_item_id: values[4] as string,
          state: values[5] as string,
          policy_snapshot: values[6] as string,
          market_id: (values[7] as string | null) ?? null,
          sales_channel_id: (values[8] as string | null) ?? null,
          vat_classification: values[9] as string,
          reference_price_minor: (values[10] as number | null) ?? null,
          entitlement_dedupe_key: dedupeKey,
          recipient_index: values[12] as number,
          recipient_customer_id: (values[13] as string | null) ?? null,
        }
        entitlements.set(dedupeKey, row)
        return { rows: [{ id: row.id }] as unknown as T[], rowCount: 1 }
      }
      if (/INSERT INTO entitlement_choice_set_item/i.test(sql)) {
        const id = values[0] as string
        if (choiceSetItems.has(id)) return { rows: [], rowCount: 0 }
        choiceSetItems.set(id, {
          id,
          instance_id: values[1] as string,
          market_id: values[2] as string,
          label: (values[3] as string | null) ?? null,
          reference_amount_minor: values[4] as number,
          remaining_minor: values[4] as number,
          vat_classification: values[5] as string,
          status: "ACTIVE",
          redemption_id: null,
        })
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }

  return { client, entitlements, choiceSetItems, eventProcessed }
}

const NOW = new Date("2026-06-02T10:15:30.000Z")

function singleVoucherLine(overrides: Partial<Record<string, unknown>> = {}): LineFixture {
  return {
    line_item_id: "li_voucher_1",
    metadata: {
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      policy: { validity_months: 12, vat_rate_uniqueness: true, ...((overrides.policy as object) ?? {}) },
      ...overrides,
    },
  }
}

function baseInput(): LiveIssueInput {
  return {
    event_type: "gp.stripe.payment_intent_succeeded.v1",
    scope: { instance_id: "gp-dev", market_id: "bonbeauty" },
    payload: {
      payment_intent_id: "pi_3Pabc1234567890",
      order_id: "order_4421",
      currency: "PLN",
      amount_minor: 24900,
      psp_occurred_at: "2026-06-02T10:15:28Z",
    },
  }
}

describe("Story 3.3 AC2 — live-issue → L4 ISSUED ze snapshotem (policy + VAT, ontologia)", () => {
  it("tworzy wiersz ISSUED z order_id non-null, market_id + sales_channel_id, vat snapshot", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_bonbeauty", metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine()]
    )
    const result = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)

    expect(result.event_processed).toBe(true)
    expect(result.issued).toHaveLength(1)
    const row = [...entitlements.values()][0]
    expect(row.state).toBe(EntitlementInstanceState.ISSUED)
    expect(row.order_id).toBe("order_4421")
    expect(row.market_id).toBe("bonbeauty")
    expect(row.sales_channel_id).toBe("sc_bonbeauty")
    expect(row.vat_classification).toBe("SPV") // vat_rate_uniqueness:true ⇒ SPV
    expect(row.reference_price_minor).toBeNull()
    // policy snapshot zawiera zamrożone pola źródłowe
    const snap = JSON.parse(row.policy_snapshot)
    expect(snap.source_payment_intent_id).toBe("pi_3Pabc1234567890")
    expect(snap.line_item_id).toBe("li_voucher_1")
  })

  it("fail-loud gdy order_id pusty (order_id non-nullable na ścieżce live)", async () => {
    const { client } = makeFakeClient({ sales_channel_id: null, metadata: null }, [])
    const input = baseInput()
    input.payload.order_id = ""
    await expect(liveIssueEntitlementsWithinTx(client, input, NOW)).rejects.toThrow(
      /order_id wymagany/
    )
  })

  it("VAT fail-closed MPV gdy brak jednoznacznej stawki (resolver 2.2)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine({ policy: { validity_months: 12 } })] // brak vat_rate_uniqueness
    )
    await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    expect([...entitlements.values()][0].vat_classification).toBe("MPV")
  })
})

describe("Story 3.3 AC4 — dwupoziomowa idempotencja (DEC-5)", () => {
  it("retry tego samego eventu ⇒ JEDEN entitlement (event-level no-op na 2. przebiegu)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine()]
    )
    const first = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    const second = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)

    expect(first.event_processed).toBe(true)
    expect(first.issued).toHaveLength(1)
    expect(first.issued[0].created).toBe(true)
    // 2. dostawa: event-level dedupe ⇒ zero pracy issue
    expect(second.event_processed).toBe(false)
    expect(second.issued).toHaveLength(0)
    expect(entitlements.size).toBe(1) // NIE podwojono
  })

  it("per-entitlement bariera: nawet bez event-level (różny event_type) ⇒ dedupe_key chroni", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine()]
    )
    const a = baseInput()
    const b = baseInput()
    b.event_type = "gp.stripe.payment_intent_succeeded.v1.replay" // omija event-level
    const r1 = await liveIssueEntitlementsWithinTx(client, a, NOW)
    const r2 = await liveIssueEntitlementsWithinTx(client, b, NOW)
    expect(r1.issued[0].created).toBe(true)
    expect(r2.event_processed).toBe(true) // event-level wpuścił (inny event_type)
    expect(r2.issued[0].created).toBe(false) // ale per-entitlement ON CONFLICT = no-op
    expect(entitlements.size).toBe(1)
  })

  // FR10 happy-path: N recipientów na RÓŻNYCH liniach (1 recipient per line_item)
  // ⇒ N entitlementów. Każda linia = osobny (order_id, line_item_id), więc NIE
  // koliduje z partial UNIQUE `(order_id, line_item_id)` (v1.9.0 H-6).
  function voucherLine(lineId: string, recipientId: string): LineFixture {
    return {
      line_item_id: lineId,
      metadata: {
        entitlement_profile_id: "voucher-rezerwacja-otwarta",
        entitlement_type: "VOUCHER_SERVICE",
        policy: { validity_months: 12, vat_rate_uniqueness: true },
        recipients: [{ customer_id: recipientId }],
      },
    }
  }

  it("jeden zakup, N recipientów na RÓŻNYCH liniach ⇒ N entitlementów (FR10 happy), klucze deterministyczne", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [
        voucherLine("li_a", "cus_a"),
        voucherLine("li_b", "cus_b"),
        voucherLine("li_c", "cus_c"),
      ]
    )
    const result = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    expect(result.issued).toHaveLength(3)
    expect(entitlements.size).toBe(3)
    // każda linia ⇒ pojedynczy recipient_index = 0 (1 recipient/linia)
    expect(result.issued.every((e) => e.recipient_index === 0)).toBe(true)
    expect(result.issued.map((e) => e.line_item_id).sort()).toEqual(["li_a", "li_b", "li_c"])
    // klucze odpowiadają sha256(pi ‖ line ‖ 0) — różne, bo różny line_item_id
    for (const e of result.issued) {
      expect(e.entitlement_dedupe_key).toBe(
        buildEntitlementDedupeKey("pi_3Pabc1234567890", e.line_item_id, 0)
      )
    }
    // recipient_customer_id zmapowane per linia
    const byLine = new Map(result.issued.map((e) => [e.line_item_id, e.recipient_customer_id]))
    expect(byLine.get("li_a")).toBe("cus_a")
    expect(byLine.get("li_b")).toBe("cus_b")
    expect(byLine.get("li_c")).toBe("cus_c")
  })

  it("(C1 deferowany) multi-recipient na TEJ SAMEJ linii ⇒ FAIL-LOUD przed INSERT (NIE cicha kolizja/poison-retry)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [
        {
          line_item_id: "li_gift",
          metadata: {
            entitlement_profile_id: "voucher-rezerwacja-otwarta",
            entitlement_type: "VOUCHER_SERVICE",
            policy: { validity_months: 12, vat_rate_uniqueness: true },
            recipients: [{ customer_id: "cus_a" }, { customer_id: "cus_b" }, "cus_c"],
          },
        },
      ]
    )
    await expect(
      liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    ).rejects.toThrow(/multi-recipient-per-line NIEOBSŁUGIWANY|C1 deferowany/)
    // fail-closed: rzut PRZED pętlą INSERT ⇒ żaden wiersz nie powstał (tx rollback
    // u callera cofa też event_processed ⇒ retry/DLQ, NIE silent poison-retry).
    expect(entitlements.size).toBe(0)
  })

  it("retry N-recipientów-na-różnych-liniach ⇒ wciąż N (nie 2N) — każdy klucz no-op na 2. przebiegu", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [voucherLine("li_x", "cus_a"), voucherLine("li_y", "cus_b")]
    )
    await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    // wymuś 2. przebieg przez inny event_type (omija event-level), test per-entitlement
    const replay = baseInput()
    replay.event_type = "x.replay"
    const r2 = await liveIssueEntitlementsWithinTx(client, replay, NOW)
    expect(entitlements.size).toBe(2)
    expect(r2.issued.every((e) => !e.created)).toBe(true)
  })
})

describe("Story 3.4 — reference_price snapshot + BUNDLE choice_set w issue-tx", () => {
  function creditPackLine(): LineFixture {
    return {
      line_item_id: "li_credit_pack",
      metadata: {
        entitlement_profile_id: "voucher-credit-pack",
        entitlement_type: EntitlementType.CREDIT_PACK,
        amount_minor: 15000,
        policy: { vat_rate_uniqueness: true, face_value_minor: 15000 },
      },
    }
  }

  function bundleLine(choiceSet: unknown[] = [
    { item_key: "massage", label: "Masaż", reference_amount_minor: 12000, vat_rates: [8] },
    { item_key: "spa", label: "SPA", reference_amount_minor: 8000, vat_rates: [23] },
  ]): LineFixture {
    return {
      line_item_id: "li_bundle",
      metadata: {
        entitlement_profile_id: "voucher-bundle",
        entitlement_type: EntitlementType.BUNDLE,
        policy: {
          vat_rates: [8, 23],
          choice_set: choiceSet,
        },
      },
    }
  }

  it("CREDIT_PACK zamraża reference_price_minor = face_value_minor i nie tworzy choice_set", async () => {
    const { client, entitlements, choiceSetItems } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [creditPackLine()]
    )

    const result = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)

    expect(result.issued).toHaveLength(1)
    const row = [...entitlements.values()][0]
    expect(row.entitlement_type).toBe(EntitlementType.CREDIT_PACK)
    expect(row.reference_price_minor).toBe(15000)
    expect(choiceSetItems.size).toBe(0)
  })

  it("BUNDLE zamraża reference_price_minor = SUM(choice_set) i persystuje komplet aktywnych pozycji", async () => {
    const { client, entitlements, choiceSetItems } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [bundleLine()]
    )

    const result = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)

    expect(result.issued).toHaveLength(1)
    const row = [...entitlements.values()][0]
    expect(row.entitlement_type).toBe(EntitlementType.BUNDLE)
    expect(row.reference_price_minor).toBe(20000)
    expect(choiceSetItems.size).toBe(2)
    for (const item of choiceSetItems.values()) {
      expect(item.instance_id).toBe(row.id)
      expect(item.market_id).toBe("bonbeauty")
      expect(item.remaining_minor).toBe(item.reference_amount_minor)
      expect(item.status).toBe("ACTIVE")
      expect(item.redemption_id).toBeNull()
      expect(["SPV", "MPV"]).toContain(item.vat_classification)
    }
  })

  it("per-entitlement replay nie duplikuje choice_set", async () => {
    const { client, choiceSetItems } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [bundleLine()]
    )
    await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    const replay = baseInput()
    replay.event_type = "gp.stripe.payment_intent_succeeded.v1.replay"

    const result = await liveIssueEntitlementsWithinTx(client, replay, NOW)

    expect(result.issued[0].created).toBe(false)
    expect(choiceSetItems.size).toBe(2)
  })

  it("BUNDLE bez choice_set rzuca fail-closed przed zapisem niespójnego snapshotu", async () => {
    const { client, entitlements, choiceSetItems } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [bundleLine([])]
    )

    await expect(liveIssueEntitlementsWithinTx(client, baseInput(), NOW)).rejects.toBeInstanceOf(
      VoucherPostingInvariantError
    )
    expect(entitlements.size).toBe(0)
    expect(choiceSetItems.size).toBe(0)
  })

  it("CREDIT_PACK bez jawnego face_value_minor w policy rzuca fail-closed (nie fallbackuje do kwoty Stripe)", async () => {
    // L1-fix: gdy policy nie niesie face_value_minor ani amount_minor, NIE wolno
    // fallbackować do payload.amount_minor (zapłacono ≠ face_value per ADR-140 §2).
    const { client } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [
        {
          line_item_id: "li_credit_pack_no_fv",
          metadata: {
            entitlement_profile_id: "voucher-credit-pack",
            entitlement_type: EntitlementType.CREDIT_PACK,
            // brak amount_minor na poziomie profilu
            policy: { vat_rate_uniqueness: true /* brak face_value_minor/amount_minor */ },
          },
        },
      ]
    )
    await expect(liveIssueEntitlementsWithinTx(client, baseInput(), NOW)).rejects.toBeInstanceOf(
      VoucherPostingInvariantError
    )
  })

  describe("AC3 golden-test — assertReferencePriceInvariant z rozbieżnymi oracle (M1-fix)", () => {
    it("CREDIT_PACK: rozbieżność snapshot vs face_value oracle ⇒ rzuca VoucherPostingInvariantError", () => {
      // Zmanipulowany snapshot (np. 10000) vs oracle (15000) — asercja musi złapać.
      expect(() =>
        assertReferencePriceInvariant(EntitlementType.CREDIT_PACK, 10000, "li_test", {
          faceValueMinor: 15000,
        })
      ).toThrow(VoucherPostingInvariantError)
    })

    it("CREDIT_PACK: snapshot zgodny z oracle ⇒ nie rzuca", () => {
      expect(() =>
        assertReferencePriceInvariant(EntitlementType.CREDIT_PACK, 15000, "li_test", {
          faceValueMinor: 15000,
        })
      ).not.toThrow()
    })

    it("BUNDLE: rozbieżność snapshot vs SUM(itemAmounts oracle) ⇒ rzuca VoucherPostingInvariantError", () => {
      // Snapshot zamrożony jako 20000, ale oracle wskazuje 19000 (rozbieżność).
      // Ten test byłby niemożliwy do napisania gdyby asercja była tautologiczna.
      expect(() =>
        assertReferencePriceInvariant(EntitlementType.BUNDLE, 20000, "li_test", {
          itemAmounts: [12000, 7000], // SUM = 19000 ≠ 20000
        })
      ).toThrow(VoucherPostingInvariantError)
    })

    it("BUNDLE: snapshot zgodny z SUM(itemAmounts oracle) ⇒ nie rzuca", () => {
      expect(() =>
        assertReferencePriceInvariant(EntitlementType.BUNDLE, 20000, "li_test", {
          itemAmounts: [12000, 8000], // SUM = 20000 = snapshot
        })
      ).not.toThrow()
    })

    it("VOUCHER_* (null snapshot): asercja nie rzuca (brak oracle)", () => {
      expect(() =>
        assertReferencePriceInvariant(EntitlementType.VOUCHER_AMOUNT, null, "li_test", {})
      ).not.toThrow()
    })
  })
})

describe("Story 3.3 — non-voucher SKU pomijane (issue tylko dla linii voucherowych)", () => {
  it("linia bez profilu entitlement ⇒ zero entitlementów", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [{ line_item_id: "li_plain", metadata: { sku: "TOWAR" } }]
    )
    const result = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    expect(result.event_processed).toBe(true)
    expect(result.issued).toHaveLength(0)
    expect(entitlements.size).toBe(0)
  })
})

describe("Story 3.3 H1 — sales_channel_id fail-loud (deferred-from-3.2)", () => {
  it("rzuca gdy order nie niesie sales_channel_id (NIE cichy zapis z null)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: null, metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine()]
    )
    await expect(
      liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    ).rejects.toThrow(/sales_channel_id nierozwiązywalny/)
    expect(entitlements.size).toBe(0) // fail-closed: żaden wiersz nie powstał
  })

  it("przechodzi gdy sales_channel_id rozwiązany (issue z niepustym scope)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_bonbeauty", metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine()]
    )
    const r = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    expect(r.issued).toHaveLength(1)
    expect([...entitlements.values()][0].sales_channel_id).toBe("sc_bonbeauty")
  })
})

describe("Story 3.3 H2 — voucher-intent bez profilu = fail-loud (silent-loss guard)", () => {
  it("linia z markerem entitlement ale niekompletnym profilem ⇒ rzuca (NIE silent processed)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      // marker entitlement_type obecny, ale brak profile_id + policy ⇒ anomalia
      [{ line_item_id: "li_broken", metadata: { entitlement_type: "VOUCHER_SERVICE" } }]
    )
    await expect(
      liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    ).rejects.toThrow(/NIEKOMPLETNY|fail-loud/)
    expect(entitlements.size).toBe(0)
  })

  it("linia bez żadnego markera entitlement ⇒ legalne pominięcie (non-voucher)", async () => {
    const { client } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [{ line_item_id: "li_plain", metadata: { sku: "TOWAR", note: "x" } }]
    )
    const r = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    expect(r.event_processed).toBe(true)
    expect(r.issued).toHaveLength(0)
  })
})

describe("Story 3.3 L4 — walidacja entitlement_type przed INSERT (fail-closed)", () => {
  it("nieznany entitlement_type ⇒ rzuca (poza taksonomią ADR-099)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [
        {
          line_item_id: "li_x",
          metadata: {
            entitlement_profile_id: "p",
            entitlement_type: "BOGUS_TYPE",
            policy: { vat_rate_uniqueness: true },
          },
        },
      ]
    )
    await expect(
      liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    ).rejects.toThrow(/nieznany entitlement_type/)
    expect(entitlements.size).toBe(0)
  })

  it("nieaktywny typ (SUBSCRIPTION_B2C hard-gate) ⇒ rzuca (NIEAKTYWNY)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [
        {
          line_item_id: "li_sub",
          metadata: {
            entitlement_profile_id: "p",
            entitlement_type: "SUBSCRIPTION_B2C",
            policy: { vat_rate_uniqueness: true },
          },
        },
      ]
    )
    await expect(
      liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    ).rejects.toThrow(/NIEAKTYWNY/)
    expect(entitlements.size).toBe(0)
  })
})

describe("Story 3.3 L1 — PK id = pełny digest (bez truncacji do 24 hex)", () => {
  it("entitlement_id = ent_<pełny 64-hex dedupe_key>", async () => {
    const { client } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } },
      [singleVoucherLine()]
    )
    const r = await liveIssueEntitlementsWithinTx(client, baseInput(), NOW)
    const { entitlement_id, entitlement_dedupe_key } = r.issued[0]
    expect(entitlement_dedupe_key).toHaveLength(64)
    expect(entitlement_id).toBe(`ent_${entitlement_dedupe_key}`)
    expect(entitlement_id).toHaveLength(68) // ent_ + 64 hex (brak truncacji)
  })
})

describe("Story 3.3 M2 — market_id fail-loud w writerze (defense-in-depth)", () => {
  it("brak market_id (scope + order.metadata) ⇒ rzuca przed INSERT (nie poison-retry)", async () => {
    const { client, entitlements } = makeFakeClient(
      { sales_channel_id: "sc_x", metadata: null },
      [singleVoucherLine()]
    )
    const input = baseInput()
    input.scope = { instance_id: "gp-dev" } // brak market_id w scope
    await expect(
      liveIssueEntitlementsWithinTx(client, input, NOW)
    ).rejects.toThrow(/market_id nierozwiązywalny/)
    expect(entitlements.size).toBe(0)
  })
})
