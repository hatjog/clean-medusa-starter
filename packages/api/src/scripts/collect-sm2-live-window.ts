#!/usr/bin/env node

import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"

import {
  BrevoAdapter,
  BrevoHttpClient,
  DISPATCH_RESOLUTION_LOOKBACK_MS,
  buildBarrierKey,
  buildDispatchIdentityTag,
  type NotificationIntent,
} from "@gp/messaging"

import { hashRecipientEmail } from "../modules/voucher-delivery/recipient-hash"

const { Client } = require("pg") as typeof import("pg")

// Allow-lista adresatow jako digesty SHA-256 adresu (trim + lowercase). Adresy nie stoja
// w repo otwartym tekstem, ale digest jest deterministyczny, wiec autoryzacja jest
// sprawdzalna bez ujawniania listy.
//
// CYKL 3 (decyzja Robert/PO, 2026-08-09): cykl 2 lecial na JEDEN adres i domknal okno jako
// `address_count: 1`, histogram `{30: 1}`. To dowodzilo toru wysylki, nie dostarczalnosci.
// Cykl 3 rozklada wysylki na CZTERY adresy PO; pierwszy z nich jest tym samym adresem,
// ktorego uzyl cykl 2, wiec porownanie miedzy cyklami zostaje mozliwe.
const AUTHORIZED_RECIPIENT_DIGESTS = new Set([
  "a70e5795905f1bd5f0939d9b1066ccc0ab98d986cf3561b4abef179a2497b790", // adresat cyklu 2
  "dcccde91d98f31dbcf2dec600f3a70eb62f6d7844786121b79205dbb2f3ded78",
  "3b908123559f505b2b61e25d8c2228d3c3d8bf9a45cad889efbe7b4ebb462b5a",
  "bc210bb87e91ef2b864bf4184c406709586f4181e776867d1b749a96bea7bf47",
])
// Prefiks identyfikatorow wysylki. Cykl 2 uzywal `sm2c2_`; artefakt cyklu 2 jest write-once
// i zostaje nietkniety, wiec cykl 3 MUSI miec wlasny prefiks — inaczej zapytania rozliczeniowe
// (`dispatch_id LIKE ...`) zmieszalyby dwa okna w jedno.
const DISPATCH_PREFIX = "sm2c3"
const TEMPLATE_KEY = "voucher_purchase_confirmation"
const ENV = "dev"
const INSTANCE_ID = "gp-dev"
const MARKET_ID = "bonbeauty"
const TARGET_COUNT = 30
const PAGE_SIZE = 100
const INDEXING_BUDGET_MS = 90_000
const POLL_INTERVAL_MS = 6_000

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`missing_required_env:${name}`)
  }
  return value
}

function authorizedRecipients(): string[] {
  // `BREVO_LIVE_PROOF_RECIPIENTS` (lista po przecinku) z fallbackiem na jednoadresowe
  // `BREVO_LIVE_PROOF_RECIPIENT` z cyklu 2 — zeby stara komenda nie przestala dzialac.
  const raw =
    process.env.BREVO_LIVE_PROOF_RECIPIENTS?.trim() ||
    process.env.BREVO_LIVE_PROOF_RECIPIENT?.trim()
  if (!raw) {
    throw new Error("missing_required_env:BREVO_LIVE_PROOF_RECIPIENTS")
  }
  const seen = new Set<string>()
  const recipients: string[] = []
  for (const candidate of raw.split(",")) {
    const address = candidate.trim()
    if (!address) {
      continue
    }
    const normalized = address.toLowerCase()
    const digest = createHash("sha256").update(normalized, "utf8").digest("hex")
    if (!AUTHORIZED_RECIPIENT_DIGESTS.has(digest)) {
      // Nie logujemy adresu — komunikat niesie pozycje, nie tresc.
      throw new Error(`recipient_not_authorized_for_story_4_8:${recipients.length + 1}`)
    }
    // Deduplikacja PO NORMALIZACJI: ta sama skrzynka podana dwa razy zawyzalaby
    // `address_count`, czyli dokladnie ten agregat, ktory prog skladu ma egzekwowac.
    if (seen.has(normalized)) {
      throw new Error("duplicate_recipient_in_list")
    }
    seen.add(normalized)
    recipients.push(address)
  }
  if (recipients.length === 0) {
    throw new Error("empty_recipient_list")
  }
  return recipients
}

function safeRunId(): string {
  const runId = required("BREVO_LIVE_PROOF_RUN_ID")
  if (!/^[a-z0-9-]{8,48}$/.test(runId)) {
    throw new Error("invalid_run_id")
  }
  return runId
}

function makeIntent(recipient: string, runId: string, ordinal: number): NotificationIntent {
  return {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: TEMPLATE_KEY,
    recipient: { email: recipient, market_id: MARKET_ID },
    variables: {},
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: `${runId}-${String(ordinal).padStart(2, "0")}`,
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "error_code" in error) {
    const value = String((error as { error_code: unknown }).error_code)
    return /^[A-Z0-9_:-]+$/.test(value) ? value : "PROVIDER_ERROR"
  }
  return "PROVIDER_ERROR"
}

async function main(): Promise<void> {
  const recipients = authorizedRecipients()
  const runId = safeRunId()
  const apiKey = required("BREVO_API_KEY")
  const senders = JSON.parse(required("BREVO_SENDERS")) as Record<
    string,
    { email: string; name?: string }
  >
  const templateId = Number(required("BREVO_LIVE_PROOF_TEMPLATE_ID"))
  const databaseUrl = required("DATABASE_URL")
  const evidencePath = required("SM2_LIVE_PROOF_OUT")
  if (!Number.isInteger(templateId) || templateId <= 0) {
    throw new Error("invalid_template_id")
  }
  if (!senders[MARKET_ID]?.email) {
    throw new Error("missing_sender_for_market")
  }

  const brevoClient = new BrevoHttpClient({ apiKey, timeoutMs: 20_000 })
  const adapter = new BrevoAdapter(brevoClient, {
    senders,
    templates: { [TEMPLATE_KEY]: templateId },
  })
  const databaseClient = new Client({ connectionString: databaseUrl })
  // Przydzial round-robin: ordinal 1..N po kolei na adresy z listy. Dla N=30 i czterech
  // adresow daje 8/8/7/7 — najrowniejszy mozliwy rozklad, wiec `max_dispatches_per_address`
  // jest minimalne, jakie da sie osiagnac przy tej liczbie adresatow.
  const recipientFor = (ordinal: number): string => recipients[(ordinal - 1) % recipients.length]
  const recipientHashes = new Map(recipients.map((address) => [address, hashRecipientEmail(address)]))
  const tagsByRecipient = new Map<string, string[]>(recipients.map((address) => [address, []]))
  const startedAt = new Date()
  let sent = 0
  let resumed = 0

  try {
    await databaseClient.connect()
    const schema = await databaseClient.query(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'voucher_delivery_dispatch'
          AND column_name = ANY($1::text[])`,
      [["env", "instance_id", "market_id", "provider_attempted_at"]],
    )
    if (schema.rowCount !== 4) {
      throw new Error("measurement_columns_missing")
    }

    for (let ordinal = 1; ordinal <= TARGET_COUNT; ordinal += 1) {
      const suffix = String(ordinal).padStart(2, "0")
      const dispatchId = `${DISPATCH_PREFIX}_${runId}_${suffix}`
      const entitlementId = `${DISPATCH_PREFIX}_ent_${runId}_${suffix}`
      const recipient = recipientFor(ordinal)
      const recipientHash = recipientHashes.get(recipient)!
      const intent = makeIntent(recipient, runId, ordinal)
      const tag = buildDispatchIdentityTag(buildBarrierKey(intent), recipient)
      tagsByRecipient.get(recipient)!.push(tag)

      const existing = await databaseClient.query(
        `SELECT status FROM voucher_delivery_dispatch WHERE dispatch_id = $1`,
        [dispatchId],
      )
      if (existing.rows[0]?.status === "sent") {
        resumed += 1
        continue
      }
      if (existing.rowCount) {
        throw new Error(`ambiguous_existing_dispatch:${suffix}`)
      }

      await databaseClient.query(
        `INSERT INTO voucher_delivery_dispatch (
           dispatch_id, entitlement_id, template_key, recipient_hash, market_id,
           flow_id, locale, status, attempt_count, queued_at, env, instance_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 1, now(), $8, $9)`,
        [
          dispatchId,
          entitlementId,
          TEMPLATE_KEY,
          recipientHash,
          MARKET_ID,
          intent.flow_id,
          intent.locale,
          ENV,
          INSTANCE_ID,
        ],
      )
      await databaseClient.query(
        `UPDATE voucher_delivery_dispatch
            SET provider = 'brevo', provider_attempted_at = now(), updated_at = now()
          WHERE dispatch_id = $1`,
        [dispatchId],
      )

      try {
        const response = await adapter.send(intent)
        await databaseClient.query(
          `UPDATE voucher_delivery_dispatch
              SET status = 'sent', provider_message_id = $2, sent_at = now(),
                  error_code = NULL, failed_at = NULL, updated_at = now()
            WHERE dispatch_id = $1`,
          [dispatchId, response.provider_message_id ?? response.dispatch_id],
        )
        sent += 1
        console.log(`dispatch=${suffix} status=sent`)
      } catch (error) {
        const code = errorCode(error)
        await databaseClient.query(
          `UPDATE voucher_delivery_dispatch
              SET status = 'failed', error_code = $2, failed_at = now(), updated_at = now()
            WHERE dispatch_id = $1`,
          [dispatchId, code],
        )
        console.log(`dispatch=${suffix} status=failed code=${code}`)
      }
    }

    const lookupEnd = new Date()
    const lookupStart = new Date(lookupEnd.getTime() - DISPATCH_RESOLUTION_LOOKBACK_MS)
    const deadline = Date.now() + INDEXING_BUDGET_MS
    // Brevo filtruje po JEDNYM adresie, wiec odczyt jest per adresat, a wyniki sumujemy.
    // Zliczanie zostaje ZAKOTWICZONE W ADRESIE: tag szukamy wylacznie wsrod wiadomosci tego
    // adresata, ktoremu ten tag przypisano. Zliczanie po zlanej liscie ukryloby przypadek,
    // w ktorym wiadomosc trafila do niewlasciwego adresata — a to jest defekt dostarczalnosci,
    // czyli dokladnie to, co SM-2 ma mierzyc.
    const fetchRows = async (address: string, endDate: Date) =>
      brevoClient.findTransactionalMessages({
        email: address.toLowerCase(),
        templateId,
        startDate: lookupStart,
        endDate,
        limit: PAGE_SIZE,
      })

    let rowsByRecipient = new Map<string, Awaited<ReturnType<typeof fetchRows>>>()
    for (const address of recipients) {
      rowsByRecipient.set(address, await fetchRows(address, lookupEnd))
    }
    const countTags = () =>
      recipients.flatMap((address) => {
        const rowsForAddress = rowsByRecipient.get(address) ?? []
        return (tagsByRecipient.get(address) ?? []).map(
          (tag) => rowsForAddress.filter((row) => (row.tags ?? []).includes(tag)).length,
        )
      })
    let counts = countTags()
    while (counts.some((count) => count < 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      const refreshed = new Map<string, Awaited<ReturnType<typeof fetchRows>>>()
      const now = new Date()
      for (const address of recipients) {
        refreshed.set(address, await fetchRows(address, now))
      }
      rowsByRecipient = refreshed
      counts = countTags()
    }
    const rows = recipients.flatMap((address) => rowsByRecipient.get(address) ?? [])

    const duplicateCount = counts.reduce((total, count) => total + Math.max(count - 1, 0), 0)
    const missingAtProvider = counts.filter((count) => count === 0).length
    if (missingAtProvider > 0) {
      throw new Error(`provider_measurement_incomplete:${missingAtProvider}`)
    }
    const ledger = await databaseClient.query(
      `SELECT status, count(*)::int AS count
         FROM voucher_delivery_dispatch
        WHERE dispatch_id LIKE $1
        GROUP BY status
        ORDER BY status`,
      [`${DISPATCH_PREFIX}_${runId}_%`],
    )
    const ledgerAttempted = await databaseClient.query(
      `SELECT count(*) FILTER (WHERE provider_attempted_at IS NOT NULL)::int AS count
         FROM voucher_delivery_dispatch
        WHERE dispatch_id LIKE $1`,
      [`${DISPATCH_PREFIX}_${runId}_%`],
    )
    const providerEvidenceRef =
      `_bmad-output/releases/v1.15.0/implementation-artifacts/evidence/4-8/` +
      `brevo-counter-${runId}.json`
    const evidence = {
      status: "measured",
      provider: "Brevo",
      source: "GET https://api.brevo.com/v3/smtp/emails",
      provider_evidence_ref: providerEvidenceRef,
      run_id: runId,
      scope: { env: ENV, instance_id: INSTANCE_ID, market_id: MARKET_ID },
      // SKLAD PROBY — mierzony, nie zadeklarowany. Cykl 2 mial tu zaszyte
      // `{ address_count: 1, alias: "sink_01" }`, czyli stala, ktora nie mogla sie nie zgadzac
      // z rzeczywistoscia, bo jej nie czytala. Ponizsze wartosci pochodza z faktycznego
      // przydzialu wysylek i sa tym, co prog skladu w `validate_sm2_delivery_window.py`
      // egzekwuje. Adresy nie ida do artefaktu — tylko ich liczba, rozklad i domeny.
      authorized_sink: {
        address_count: recipients.length,
        dispatches_per_address: Object.fromEntries(
          recipients.map((address, index) => [
            `addr_${String(index + 1).padStart(2, "0")}`,
            (tagsByRecipient.get(address) ?? []).length,
          ]),
        ),
        max_dispatches_per_address: Math.max(
          ...recipients.map((address) => (tagsByRecipient.get(address) ?? []).length),
        ),
        domain_count: new Set(
          recipients.map((address) => address.toLowerCase().split("@")[1] ?? ""),
        ).size,
        allocation: "round-robin",
      },
      requested_dispatches: TARGET_COUNT,
      current_process_new_sends: sent,
      resumed_existing_sent_rows: resumed,
      ledger_provider_attempted_rows: ledgerAttempted.rows[0]?.count ?? 0,
      ledger_status_distribution: Object.fromEntries(
        ledger.rows.map((row: { status: string; count: number }) => [row.status, row.count]),
      ),
      provider_lookup: {
        lookback_days: 8,
        start_date: lookupStart.toISOString().slice(0, 10),
        end_date: lookupEnd.toISOString().slice(0, 10),
        limit: PAGE_SIZE,
        offset: 0,
        rows_returned: rows.length,
        first_page_exhausted: rows.length < PAGE_SIZE,
        matched_unique_dispatches: counts.filter((count) => count >= 1).length,
        provider_messages_for_run: counts.reduce((total, count) => total + count, 0),
        missing_dispatches: missingAtProvider,
      },
      duplicate_count: duplicateCount,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      redaction: {
        api_key: "<REDACTED>",
        authorization_headers: "<REDACTED>",
        raw_recipient: "<REDACTED>",
      },
    }
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    })
    console.log(
      JSON.stringify({
        run_id: runId,
        ledger: evidence.ledger_status_distribution,
        provider_rows: rows.length,
        matched: evidence.provider_lookup.matched_unique_dispatches,
        duplicate_count: duplicateCount,
        evidence: providerEvidenceRef,
      }),
    )
    if (duplicateCount > 0) {
      process.exitCode = 1
    }
  } finally {
    await databaseClient.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown_error"
  console.error(`SM2_LIVE_PROOF_FAILED:${message}`)
  process.exitCode = 1
})
