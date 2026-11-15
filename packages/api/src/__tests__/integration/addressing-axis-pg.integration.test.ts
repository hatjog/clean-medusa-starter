/**
 * v1.16.0 Story 6.4 AC1/AC2 (FR-20, AD-36 oś (a), NFR-2) — oś (a) liczona na
 * wierszu ZAPISANYM PRZEZ SYSTEM, na realnym PostgreSQL, z OBOWIĄZKOWĄ
 * kontrolą dodatnią i nazwaną odmową dla brakującego wiersza badanego.
 *
 * Fix D-31 (runda 1): wcześniej suita sama wstawiała wiersz handoffu z hashem
 * z fixture, więc mutant „adresat = płatnik” w subskrybencie zostawał zielony.
 * Teraz wiersze handoffu zapisuje WYŁĄCZNIE prawdziwa ścieżka
 * `handleVoucherPurchaseDelivery` → `PgDispatchLedger.reserveDispatch`
 * (knex.raw) z projekcją źródłową gift ≠ buyer. Dwa przebiegi systemu:
 *   A — zdarzenie ISSUED, ścieżka wysyłkowa handoffu (`evaluateGiftHandoff`);
 *   B — dosyłka sweepu z celem `voucher_handoff_link` przy niekompletnej
 *       konfiguracji storefrontu: wiersz ograniczający handoffu, którego
 *       adresat pochodzi z `handoffRecipientEmail` subskrybenta.
 * Dyspozytor jest atrapą przechwytującą — bez wysyłki live (D-35 p.12, D-21).
 *
 * Profil: `pnpm run test:integration:addressing-axis-pg`
 * Baza: izolowana `gp_story_6_4_test` (stack gp-test, port 55432); suita odmawia
 * startu na bazie bez sufiksu `_test`. Pracuje we własnym schemacie
 * `story_6_4_axis`; tabele powstają jako `LIKE public.<tabela> INCLUDING ALL`
 * z bazy po migracjach aplikacji (bez przepisywania DDL, bez migracji schematu).
 *
 * Gdy ustawione `GP_6_4_EVIDENCE_OUT`, suita zapisuje artefakt dowodowy z
 * przebiegów A i B; wymaga wtedy `GP_6_4_SOURCE_COMMIT` (HEAD super-repo) i
 * zapisuje sha256 plików wejściowych, które bramka
 * `_grow/tools/validate_addressing_axis.py` przelicza — świadectwo jest
 * związane z kodem, który je wyprodukował. Oś (a) NIE jest dowodem dostarczenia.
 *
 * Bez DATABASE_URL suita jest POMIJANA (describe.skip, nazwa NEEDS-LIVE-RUN) —
 * nie „zielona”.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"
import { Pool, type PoolClient } from "pg"

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import {
  handleVoucherPurchaseDelivery,
  type PurchaseDeliveryDeps,
  type PurchaseDeliverySource,
} from "../../subscribers/voucher-purchase-delivery"
import {
  ADDRESSING_AXIS_PROOF_SQL,
  ADDRESSING_AXIS_TEMPLATE_KEY,
  runAddressingAxisProof,
  type AddressingAxisProof,
} from "../../modules/voucher-delivery/addressing-axis"
import {
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { GIFT_SEND_TIMING_NOW } from "../../modules/voucher-delivery/gift-handoff"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"

const DATABASE_URL = process.env.DATABASE_URL
const SCHEMA = "story_6_4_axis"
const PAYER = "platnik-6-4@example.test"
const GIFT_RECIPIENT = "ola-6-4@example.test"
const MARKET_ID = "bonbeauty"
const ENT_A = "ent_6_4_gift_issued"
const ENT_B = "ent_6_4_gift_sweep_limiting_row"
const ENT_CONTROL = "ent_6_4_positive_control"
const ENT_BAD = "ent_6_4_misaddressed"
const PRODUCED_BY = "handleVoucherPurchaseDelivery+PgDispatchLedger"

/** Pliki, których sha256 wiąże świadectwo z kodem (ścieżki względem super-repo). */
const INPUT_FILES: Record<string, string> = {
  "GP/backend/packages/api/src/subscribers/voucher-purchase-delivery.ts": resolve(
    __dirname,
    "../../subscribers/voucher-purchase-delivery.ts",
  ),
  "GP/backend/packages/api/src/modules/voucher-delivery/addressing-axis.ts": resolve(
    __dirname,
    "../../modules/voucher-delivery/addressing-axis.ts",
  ),
  "GP/backend/packages/api/src/modules/voucher-delivery/gift-handoff.ts": resolve(
    __dirname,
    "../../modules/voucher-delivery/gift-handoff.ts",
  ),
  "GP/backend/packages/api/src/__tests__/integration/addressing-axis-pg.integration.test.ts": __filename,
}

function giftSource(): PurchaseDeliverySource {
  return {
    buyer_email: PAYER,
    voucher_code: "BB-GIFT-6-4",
    market_id: MARKET_ID,
    purchase_locale: "pl",
    customer_first_name: "Magda",
    seller_name: "Salon Bonbeauty",
    seller_handle: "salon-bonbeauty",
    order_id: "order_6_4",
    order_display_id: "6004",
    purchase_date: "2026-11-14T09:15:00.000Z",
    voucher_expires_at: "2027-11-14T00:00:00.000Z",
    voucher_value_minor: 20000,
    voucher_currency: "PLN",
    salon_address_1: "ul. Handlowa 10",
    salon_address_2: null,
    salon_postal_code: "00-001",
    salon_city: "Warszawa",
    purchase_mode: "gift",
    gift_recipient_email: GIFT_RECIPIENT,
    gift_recipient_send_timing: GIFT_SEND_TIMING_NOW,
    gift_recipient_bound_to_voucher_issue: true,
  }
}

function makeDeps(db: Knex, env: NodeJS.ProcessEnv): PurchaseDeliveryDeps & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    sent,
    sourceReader: { findBuyerClaimSource: async () => giftSource() },
    ledger: new PgDispatchLedger(db),
    dispatcher: {
      async dispatch(payload) {
        sent.push(payload)
        return { external_id: `capture-${sent.length}` }
      },
    },
    marketLocales: {
      read: async () => ({ config: { default: "pl", supported: ["pl", "en"] }, degraded: false }),
      readRuntimeConfig: async () => ({
        row: {
          locales: { default: "pl", supported: ["pl", "en"] },
          support_email: "kontakt@bonbeauty.pl",
          market_url: "https://dev.bonbeauty.pl",
        },
        degraded: false,
      }),
    },
    env: { GP_INSTANCE_ID: "gp-test", GP_ENV: "test", ...env },
  }
}

function envelope(entitlementId: string, payloadExtra: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    event_type: "gp.entitlements.entitlement_state_changed.v1",
    occurred_at: "2026-11-14T12:00:00.000Z",
    actor: "system",
    scope: { instance_id: entitlementId, market_id: MARKET_ID, vendor_id: null, location_id: null },
    payload: { entitlement_id: entitlementId, from_state: "__genesis__", to_state: "ISSUED", ...payloadExtra },
  }
}

const runOrSkip = DATABASE_URL ? describe : describe.skip

if (!DATABASE_URL) {
  console.warn("[NEEDS-LIVE-RUN] Story 6.4: ustaw DATABASE_URL na gp_story_6_4_test (suita POMINIĘTA, nie zielona)")
}

runOrSkip(
  DATABASE_URL
    ? "Story 6.4 AC1/AC2 — oś (a) na wierszach zapisanych przez system (PostgreSQL)"
    : "NEEDS-LIVE-RUN: Story 6.4 oś (a) na PostgreSQL wymaga DATABASE_URL izolowanej bazy *_test",
  () => {
    let db: Knex
    let pool: Pool
    let client: PoolClient
    const scenarios: Array<AddressingAxisProof & { scenario: string; addressing_rows: unknown[] }> = []

    async function proofFor(entitlementId: string, payer = PAYER): Promise<AddressingAxisProof> {
      return runAddressingAxisProof(client, {
        entitlement_id: entitlementId,
        control_entitlement_id: ENT_CONTROL,
        payer_email: payer,
      })
    }

    function record(scenario: string, proof: AddressingAxisProof) {
      scenarios.push({
        scenario,
        ...proof,
        addressing_rows: proof.target.rows.map(({ dispatch_id, entitlement_id, recipient_hash }) => ({
          dispatch_id,
          entitlement_id,
          recipient_hash,
        })),
      })
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL })
      client = await pool.connect()
      const name = (await client.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name ?? ""
      if (!/_test$/.test(name)) {
        throw new Error(`Story 6.4 PG: odmowa startu na bazie ${name} (wymagana *_test)`)
      }
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      for (const table of [VOUCHER_DELIVERY_DISPATCH_TABLE, VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE]) {
        await client.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`)
      }
      await client.query(`SET search_path TO ${SCHEMA}`)
      db = knexFactory({ client: "pg", connection: DATABASE_URL as string, searchPath: [SCHEMA], pool: { min: 0, max: 2 } })

      // Wiersz kontrolny (recipient_hash == hash(płatnika)) — też przez ledger, nie INSERT-em testu.
      const control = await new PgDispatchLedger(db).reserveDispatch({
        entitlement_id: ENT_CONTROL,
        template_key: ADDRESSING_AXIS_TEMPLATE_KEY,
        recipient_hash: hashRecipientEmail(PAYER),
        env: "test",
        instance_id: "gp-test",
        market_id: MARKET_ID,
        flow_id: "voucher_purchase_delivery",
        locale: "pl",
      })
      expect(control.outcome).toBe("reserved")
    })

    afterAll(async () => {
      if (db) await db.destroy()
      if (client) {
        await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
        client.release()
      }
      if (pool) await pool.end()

      const out = process.env.GP_6_4_EVIDENCE_OUT
      if (out && scenarios.length === 2) {
        const sourceCommit = process.env.GP_6_4_SOURCE_COMMIT ?? ""
        if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
          throw new Error("GP_6_4_EVIDENCE_OUT wymaga GP_6_4_SOURCE_COMMIT (40-znakowy SHA HEAD super-repo)")
        }
        const inputs = Object.fromEntries(
          Object.entries(INPUT_FILES).map(([rel, abs]) => [
            rel,
            "sha256:" + createHash("sha256").update(readFileSync(abs)).digest("hex"),
          ]),
        )
        writeFileSync(
          out,
          JSON.stringify(
            {
              story: "6.4",
              ac: "AC1/AC2",
              database: "postgres://postgres@localhost:55432/gp_story_6_4_test",
              schema: SCHEMA,
              source_commit: sourceCommit,
              measured_at: new Date().toISOString(),
              produced_by: PRODUCED_BY,
              inputs,
              is_delivery_proof: false,
              note: "Oś (a) jest warunkiem koniecznym, NIE dowodem dostarczenia; oś (b) = bramka ludzka 6.7.",
              scenarios,
            },
            null,
            2,
          ) + "\n",
        )
      }
    })

    it("A: zdarzenie ISSUED, gift ≠ płatnik — wiersz handoffu zapisany przez system ⇒ PASS", async () => {
      const deps = makeDeps(db, { GP_STOREFRONT_URL_BONBEAUTY: "https://dev.bonbeauty.pl" })
      const result = await handleVoucherPurchaseDelivery(envelope(ENT_A), deps)
      expect(result.handoff?.dispatch_id).toEqual(expect.any(String))

      const proof = await proofFor(ENT_A, `  ${PAYER.toUpperCase()} `)
      expect(proof.positive_control.row_count).toBe(1)
      expect(proof.target.row_count).toBe(1)
      expect(proof.target.rows[0]?.dispatch_id).toBe(result.handoff?.dispatch_id)
      expect(proof.target.rows[0]?.recipient_hash).toBe(hashRecipientEmail(GIFT_RECIPIENT))
      expect(proof.proof).toEqual({ entitlement_id: ENT_A, row_count: 0, executed_seq: 3 })
      expect(proof.verdict).toBe("PASS")
      expect(proof.is_delivery_proof).toBe(false)
      record("A_issued_handoff_dispatch", proof)
    })

    it("B: dosyłka sweepu handoffu przy niekompletnym storefront URL — wiersz ograniczający ⇒ PASS", async () => {
      const deps = makeDeps(db, {})
      const result = await handleVoucherPurchaseDelivery(
        envelope(ENT_B, {
          dispatch_origin: "voucher_delivery_reconciliation_sweep",
          dispatch_target: { template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK, recipient_hash: null },
        }),
        deps,
      )
      expect(result.outcome).toBe("failed")
      expect(deps.sent).toEqual([])

      const proof = await proofFor(ENT_B)
      expect(proof.target.row_count).toBe(1)
      expect(proof.target.rows[0]?.dispatch_id).toBe(result.dispatch_id)
      expect(proof.target.rows[0]?.recipient_hash).toBe(hashRecipientEmail(GIFT_RECIPIENT))
      expect(proof.verdict).toBe("PASS")
      record("B_sweep_limiting_row", proof)
    })

    it("brak wiersza handoffu badanego entitlementu ⇒ TARGET_ROW_MISSING, nie PASS", async () => {
      const proof = await proofFor("literowka")
      expect(proof.positive_control.row_count).toBe(1)
      expect(proof.target.row_count).toBe(0)
      expect(proof.verdict).toBe("TARGET_ROW_MISSING")
      expect(proof.proof.executed_seq).toBeNull()
    })

    it("bez wiersza kontrolnego pusty wynik NIE jest uznany ⇒ CONTROL_FAILED", async () => {
      const proof = await runAddressingAxisProof(client, {
        entitlement_id: ENT_A,
        control_entitlement_id: "ent_6_4_no_such_control",
        payer_email: PAYER,
      })
      expect(proof.verdict).toBe("CONTROL_FAILED")
      expect(proof.proof.executed_seq).toBeNull()
    })

    it("handoff zaadresowany do płatnika (inna wielkość liter) ⇒ FAIL", async () => {
      await new PgDispatchLedger(db).reserveDispatch({
        entitlement_id: ENT_BAD,
        template_key: ADDRESSING_AXIS_TEMPLATE_KEY,
        recipient_hash: hashRecipientEmail(` ${PAYER.toUpperCase()}`),
        env: "test",
        instance_id: "gp-test",
        market_id: MARKET_ID,
        flow_id: "voucher_purchase_delivery",
        locale: "pl",
      })
      const proof = await proofFor(ENT_BAD)
      expect(proof.verdict).toBe("FAIL")
      expect(proof.proof.row_count).toBe(1)
      expect(proof.query_sql).toBe(ADDRESSING_AXIS_PROOF_SQL)
    })
  },
)
