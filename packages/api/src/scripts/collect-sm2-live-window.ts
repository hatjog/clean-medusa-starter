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

const { Pool } = require("pg") as typeof import("pg")

const AUTHORIZED_RECIPIENT_DIGEST =
  "a70e5795905f1bd5f0939d9b1066ccc0ab98d986cf3561b4abef179a2497b790"
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

function authorizedRecipient(): string {
  const recipient = required("BREVO_LIVE_PROOF_RECIPIENT")
  const digest = createHash("sha256")
    .update(recipient.trim().toLowerCase(), "utf8")
    .digest("hex")
  if (digest !== AUTHORIZED_RECIPIENT_DIGEST) {
    throw new Error("recipient_not_authorized_for_story_4_8")
  }
  return recipient
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
  const recipient = authorizedRecipient()
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

  const client = new BrevoHttpClient({ apiKey, timeoutMs: 20_000 })
  const adapter = new BrevoAdapter(client, {
    senders,
    templates: { [TEMPLATE_KEY]: templateId },
  })
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const recipientHash = hashRecipientEmail(recipient)
  const tags: string[] = []
  const startedAt = new Date()
  let sent = 0
  let resumed = 0

  try {
    const schema = await pool.query(
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
      const dispatchId = `sm2c2_${runId}_${suffix}`
      const entitlementId = `sm2c2_ent_${runId}_${suffix}`
      const intent = makeIntent(recipient, runId, ordinal)
      const tag = buildDispatchIdentityTag(buildBarrierKey(intent), recipient)
      tags.push(tag)

      const existing = await pool.query(
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

      await pool.query(
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
      await pool.query(
        `UPDATE voucher_delivery_dispatch
            SET provider = 'brevo', provider_attempted_at = now(), updated_at = now()
          WHERE dispatch_id = $1`,
        [dispatchId],
      )

      try {
        const response = await adapter.send(intent)
        await pool.query(
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
        await pool.query(
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
    const lookupRecipient = recipient.toLowerCase()
    const deadline = Date.now() + INDEXING_BUDGET_MS
    let rows = await client.findTransactionalMessages({
      email: lookupRecipient,
      templateId,
      startDate: lookupStart,
      endDate: lookupEnd,
      limit: PAGE_SIZE,
    })
    let counts = tags.map((tag) => rows.filter((row) => (row.tags ?? []).includes(tag)).length)
    while (counts.some((count) => count < 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      rows = await client.findTransactionalMessages({
        email: lookupRecipient,
        templateId,
        startDate: lookupStart,
        endDate: new Date(),
        limit: PAGE_SIZE,
      })
      counts = tags.map((tag) => rows.filter((row) => (row.tags ?? []).includes(tag)).length)
    }

    const duplicateCount = counts.reduce((total, count) => total + Math.max(count - 1, 0), 0)
    const missingAtProvider = counts.filter((count) => count === 0).length
    if (missingAtProvider > 0) {
      throw new Error(`provider_measurement_incomplete:${missingAtProvider}`)
    }
    const ledger = await pool.query(
      `SELECT status, count(*)::int AS count
         FROM voucher_delivery_dispatch
        WHERE dispatch_id LIKE $1
        GROUP BY status
        ORDER BY status`,
      [`sm2c2_${runId}_%`],
    )
    const ledgerAttempted = await pool.query(
      `SELECT count(*) FILTER (WHERE provider_attempted_at IS NOT NULL)::int AS count
         FROM voucher_delivery_dispatch
        WHERE dispatch_id LIKE $1`,
      [`sm2c2_${runId}_%`],
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
      authorized_sink: { address_count: 1, alias: "sink_01" },
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
    await pool.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown_error"
  console.error(`SM2_LIVE_PROOF_FAILED:${message}`)
  process.exitCode = 1
})
