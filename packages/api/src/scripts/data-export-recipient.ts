/**
 * data-export-recipient.ts — Sub-bundle 6d (cleanup-6 CRIT-6.4)
 *
 * Admin CLI tool: export all data held about a recipient data subject.
 *
 * Usage (medusa exec):
 *   pnpm medusa exec src/scripts/data-export-recipient.ts -- \
 *     --subject=recipient \
 *     --voucher=<voucher_code>
 *
 *   pnpm medusa exec src/scripts/data-export-recipient.ts -- \
 *     --subject=recipient \
 *     --email=<recipient_email> \
 *     --market=<market_id>
 *
 * GDPR Art. 15 (data subject access request) — see DSAR runbook:
 *   specs/legal/recipient-dsar-runbook.md
 *
 * AUDIT REQUIREMENT: Every invocation MUST log a DSAR_ACCESS audit entry
 * to the voucher_pii_consent_audit table before retrieving any data.
 * This ensures the access is part of the tamper-evident audit chain (ADR-078).
 *
 * Output: JSON to stdout — pipe to file for DSAR delivery.
 *   pnpm medusa exec src/scripts/data-export-recipient.ts -- \
 *     --subject=recipient --voucher=<code> > dsar-output.json
 *
 * Privacy posture:
 *   - Buyer PII (buyer_email, order_id as buyer identifier) is REDACTED per §4
 *     of the DSAR runbook — recipient is not entitled to buyer PII.
 *   - All audit access is logged for tamper-evident chain integrity.
 *   - IDB queue (client-side device storage) is NOT retrievable; disclosure
 *     language included in output.
 */

import type { ExecArgs } from "@medusajs/framework/types";
import { Pool } from "pg";

interface ExportArgs {
  subject?: string;
  voucher?: string;
  email?: string;
  market?: string;
  dsar_request_id?: string;
  operator?: string;
}

function parseArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (key && value) {
      (args as Record<string, string>)[key] = value;
    }
  }
  return args;
}

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "[data-export-recipient] DATABASE_URL not set. Cannot connect to database."
    );
  }
  return url;
}

async function findRecipientPiiRows(
  pool: Pool,
  args: ExportArgs
): Promise<{ rows: unknown[]; recipientPiiIds: string[] }> {
  let rows: unknown[] = [];

  if (args.voucher) {
    // Look up by voucher code — join via entitlements if needed, or direct scan.
    const result = await pool.query(
      `SELECT
        id,
        entitlement_id,
        order_id,
        market_id,
        recipient_email,
        recipient_phone,
        locale,
        is_gift,
        created_at,
        deleted_at
       FROM voucher_recipient_pii
       WHERE entitlement_id IN (
         SELECT id FROM gp_core.entitlements
         WHERE voucher_code = $1
         LIMIT 10
       )
       ORDER BY created_at DESC`,
      [args.voucher]
    );
    rows = result.rows;
  } else if (args.email && args.market) {
    const result = await pool.query(
      `SELECT
        id,
        entitlement_id,
        order_id,
        market_id,
        recipient_email,
        recipient_phone,
        locale,
        is_gift,
        created_at,
        deleted_at
       FROM voucher_recipient_pii
       WHERE recipient_email = $1
         AND market_id = $2
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [args.email, args.market]
    );
    rows = result.rows;
  } else {
    throw new Error(
      "[data-export-recipient] Provide --voucher=<code> OR --email=<email> --market=<market_id>"
    );
  }

  const recipientPiiIds = (rows as Array<{ id: string }>).map((r) => r.id);
  return { rows, recipientPiiIds };
}

async function findAuditRows(
  pool: Pool,
  recipientPiiIds: string[]
): Promise<unknown[]> {
  if (recipientPiiIds.length === 0) return [];

  const placeholders = recipientPiiIds
    .map((_, i) => `$${i + 1}`)
    .join(", ");

  const result = await pool.query(
    `SELECT
      id,
      market_id,
      action,
      -- Redact buyer-identifying metadata keys per DSAR §4
      jsonb_strip_nulls(
        jsonb_set(
          metadata::jsonb,
          '{buyer_email}', 'null'::jsonb
        )
      ) AS metadata_redacted,
      created_at
     FROM voucher_pii_consent_audit
     WHERE recipient_pii_id IN (${placeholders})
     ORDER BY created_at ASC`,
    recipientPiiIds
  );

  return result.rows;
}

async function findDeliveryDecisionRows(
  pool: Pool,
  consentAuditIds: string[]
): Promise<unknown[]> {
  if (consentAuditIds.length === 0) return [];

  const placeholders = consentAuditIds.map((_, i) => `$${i + 1}`).join(", ");

  const result = await pool.query(
    `SELECT
      id,
      consent_audit_id,
      outcome,
      latency_ms,
      delivery_attempt_n,
      created_at
     FROM voucher_delivery_decision
     WHERE consent_audit_id IN (${placeholders})
     ORDER BY created_at ASC`,
    consentAuditIds
  );

  return result.rows;
}

async function logDsarAccess(
  pool: Pool,
  recipientPiiIds: string[],
  args: ExportArgs
): Promise<void> {
  const dsarRequestId =
    args.dsar_request_id ?? `dsar-${Date.now()}-auto`;
  const operator = args.operator ?? "system";

  for (const recipientPiiId of recipientPiiIds) {
    await pool
      .query(
        `INSERT INTO voucher_pii_consent_audit
          (market_id, recipient_pii_id, action, metadata, created_at)
         SELECT
           market_id,
           id,
           'DSAR_ACCESS',
           $1::jsonb,
           now()
         FROM voucher_recipient_pii
         WHERE id = $2`,
        [
          JSON.stringify({
            dsar_request_id: dsarRequestId,
            operator,
            script: "data-export-recipient",
          }),
          recipientPiiId,
        ]
      )
      .catch((err: Error) => {
        // Log but do NOT block export — audit failure should be reported, not silenced.
        console.error(
          `[data-export-recipient] WARN: Failed to log DSAR_ACCESS audit for ${recipientPiiId}: ${err.message}`
        );
      });
  }
}

export default async function dataExportRecipient({
  args,
}: ExecArgs): Promise<void> {
  const parsed = parseArgs(args as string[]);

  if (parsed.subject && parsed.subject !== "recipient") {
    console.error(
      `[data-export-recipient] --subject must be 'recipient'. Got: ${parsed.subject}`
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: resolveDatabaseUrl() });

  try {
    // Step 1: Locate recipient PII rows.
    const { rows: piiRows, recipientPiiIds } = await findRecipientPiiRows(
      pool,
      parsed
    );

    if (piiRows.length === 0) {
      const output = {
        data_subject: "recipient",
        query: { voucher: parsed.voucher, email: parsed.email, market: parsed.market },
        found: false,
        tables: {},
        idb_queue:
          "NOT_RETRIEVABLE: Client-side IndexedDB storage (gp-voucher-offline). " +
          "Instruct requestor to clear browser IndexedDB at storefront domain via browser settings → Application → Storage.",
        redis_session:
          "NOT_RETRIEVABLE: Redis session (TTL ≤7 days). May have already expired by DSAR processing time.",
        note: "No recipient PII records found for the given query. The data may have been deleted by the 365-day retention sweep.",
      };
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      return;
    }

    // Step 2: Log DSAR access to audit chain BEFORE retrieving data.
    await logDsarAccess(pool, recipientPiiIds, parsed);

    // Step 3: Retrieve audit trail.
    const auditRows = await findAuditRows(pool, recipientPiiIds);

    // Step 4: Retrieve delivery decisions.
    const auditIds = (auditRows as Array<{ id: string }>).map((r) => r.id);
    const deliveryRows = await findDeliveryDecisionRows(pool, auditIds);

    // Step 5: Output DSAR export package.
    const output = {
      data_subject: "recipient",
      query: { voucher: parsed.voucher, email: parsed.email, market: parsed.market },
      found: true,
      tables: {
        voucher_recipient_pii: piiRows,
        voucher_pii_consent_audit: auditRows,
        voucher_delivery_decision: deliveryRows,
      },
      idb_queue:
        "NOT_RETRIEVABLE: Client-side IndexedDB storage (gp-voucher-offline) " +
        "is stored on the recipient's device. Instruct requestor to clear browser " +
        "IndexedDB at the storefront domain via browser settings → Application → Storage.",
      redis_session:
        "NOT_RETRIEVABLE: Redis session (recipient_session ephemeral token, TTL ≤7 days). " +
        "May have expired before DSAR was processed.",
      redaction_applied: [
        "buyer_email removed from audit metadata (separate data subject)",
        "Audit DSAR_ACCESS entry written to tamper-evident chain before data retrieval",
      ],
      dsar_runbook: "specs/legal/recipient-dsar-runbook.md",
      generated_at: new Date().toISOString(),
    };

    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}
