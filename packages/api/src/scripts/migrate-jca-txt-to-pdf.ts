/**
 * Story 4.3 (v1.7.0): JCA Legacy .txt Artifact Migration and Retirement.
 *
 * Opcja B retirement from v160-cleanup-41: migrate `vendor_notification_log`
 * rows of type `jca_generated` where `metadata->>'format'` is NULL or not
 * "pdf" (legacy rows emitted before cleanup-41 shipped the real pdfkit renderer).
 *
 * v1.6.0 is STAGING-FREE (ADR-066) so zero rows are expected in any current
 * environment. The script is authorised for the first real production deployment.
 *
 * Safety model (mirrors backfill-mor-snapshot.ts):
 *   - Default mode: --dry-run (no DB writes)
 *   - --apply: requires explicit operator confirmation "yes" before any writes
 *   - Idempotent: WHERE clause excludes rows already corrected by this script
 *   - Append-only table: migration writes a NEW row with format=pdf rather than
 *     mutating the immutable original (which has an UPDATE/DELETE trigger guard)
 *
 * Manual invocation (Medusa exec):
 *   yarn medusa exec ./src/scripts/migrate-jca-txt-to-pdf.ts -- \
 *     --instance bonbeauty
 *   yarn medusa exec ./src/scripts/migrate-jca-txt-to-pdf.ts -- \
 *     --instance bonbeauty --apply
 *
 * Test invocation:
 *   cd GP/backend && pnpm test -- migrate-jca-txt-to-pdf
 */

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import * as readline from "node:readline"

export const ALLOWED_INSTANCES = ["bonbeauty", "mercur", "testmarketb"] as const
export type AllowedInstance = (typeof ALLOWED_INSTANCES)[number]

export type ParsedFlags = {
  instance: AllowedInstance
  apply: boolean
}

export type ParseFlagsResult =
  | { ok: true; flags: ParsedFlags }
  | { ok: false; error: string }

export function parseFlags(args: string[] | undefined): ParseFlagsResult {
  const argv = args ?? []
  let instance: string | undefined
  let apply = false
  let dryRunSeen = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === "--instance") {
      instance = argv[i + 1]
      i++
      continue
    }
    if (token.startsWith("--instance=")) {
      instance = token.slice("--instance=".length)
      continue
    }
    if (token === "--apply") {
      apply = true
      continue
    }
    if (token === "--dry-run") {
      dryRunSeen = true
      continue
    }
    if (token === "--help" || token === "-h") {
      return { ok: false, error: "__HELP__" }
    }
    // Review fix M-3: reject unknown tokens so typos like `--aplly` or
    // `--Apply` do not silently mode-switch the migration.
    return {
      ok: false,
      error:
        "Unknown argument: " +
        token +
        ". Run with --help for the list of supported flags.",
    }
  }

  if (!instance || instance.length === 0) {
    return {
      ok: false,
      error: "--instance is required. Allowed: " + ALLOWED_INSTANCES.join(", "),
    }
  }

  if (!ALLOWED_INSTANCES.includes(instance as AllowedInstance)) {
    return {
      ok: false,
      error:
        "--instance must be one of: " +
        ALLOWED_INSTANCES.join(", ") +
        " (got: " +
        instance +
        ")",
    }
  }

  if (apply && dryRunSeen) {
    apply = false
  }

  return {
    ok: true,
    flags: { instance: instance as AllowedInstance, apply },
  }
}

export function helpText(): string {
  return [
    "Usage: migrate-jca-txt-to-pdf.ts --instance <instance> [--apply]",
    "",
    "Story 4.3 (v1.7.0) — JCA legacy .txt artifact retirement.",
    "",
    "Scans vendor_notification_log for jca_generated rows where",
    "metadata->>'format' IS NULL or != 'pdf', excluding rows that already",
    "have a correction row linked by metadata.original_row_id. For each",
    "remaining legacy row, appends a new correction row with format='pdf'.",
    "",
    "Flags:",
    "  --instance <id>   Required. One of: " + ALLOWED_INSTANCES.join(", "),
    "                    Compared against env GP_INSTANCE (when set) to guard",
    "                    against cross-instance writes; mismatch aborts with",
    "                    exit code 2 before any DB read.",
    "  --apply           Opt-in. Performs DB writes after operator confirmation.",
    "                    Confirmation prompt requires the exact string 'yes'",
    "                    (lowercase); anything else aborts with no writes.",
    "                    Without this flag the script runs in dry-run mode.",
    "  --dry-run         Default. Wins over --apply if both supplied.",
    "  --help, -h        Show this message.",
    "",
    "Note: vendor_notification_log is append-only (immutable trigger on UPDATE/",
    "DELETE). Migration writes NEW correction rows; original rows are preserved",
    "with vendor_handle and other context fields copied forward.",
    "",
    "Expected outcome for v1.7.0: 0 legacy rows (STAGING-FREE v1.6.0 — ADR-066).",
  ].join("\n")
}

export type LegacyRow = {
  id: string
  vendor_id: string
  sent_at: string
  metadata: Record<string, unknown> | null
}

export type CountLegacyFn = (instance: AllowedInstance) => Promise<number>
export type FetchLegacyFn = (instance: AllowedInstance) => Promise<LegacyRow[]>
export type InsertCorrectionFn = (
  instance: AllowedInstance,
  rows: LegacyRow[],
) => Promise<{ rowsInserted: number }>
export type PromptFn = (question: string) => Promise<string>

export type MigrationIO = {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  prompt: PromptFn
  countLegacyRows: CountLegacyFn
  fetchLegacyRows: FetchLegacyFn
  insertCorrectionRows: InsertCorrectionFn
  /**
   * Optional environment lookup for cross-instance write guards (review fix
   * M-2). Defaults to `process.env` in production. Tests inject a stub.
   */
  env?: { GP_INSTANCE?: string | null | undefined }
}

export type MigrationOutcome = {
  exitCode: number
  mode: "dry-run" | "apply"
  instance?: AllowedInstance
  legacyRowsFound?: number
  correctionRowsInserted?: number
  aborted?: boolean
  abortReason?: string
}

export async function runMigration(
  argv: string[] | undefined,
  io: MigrationIO,
): Promise<MigrationOutcome> {
  const parsed = parseFlags(argv)
  if (!parsed.ok) {
    if (parsed.error === "__HELP__") {
      io.stdout.write(helpText() + "\n")
      return { exitCode: 0, mode: "dry-run" }
    }
    io.stderr.write(parsed.error + "\n")
    return { exitCode: 2, mode: "dry-run" }
  }

  const { instance, apply } = parsed.flags

  // Review fix M-2: guard against cross-instance writes. If GP_INSTANCE is
  // set in the environment, it must match the --instance flag. When unset
  // the script proceeds (logging-only label) but emits a stderr warning.
  const envInstance = io.env?.GP_INSTANCE ?? null
  if (envInstance && envInstance.length > 0 && envInstance !== instance) {
    io.stderr.write(
      "Instance mismatch: --instance=" +
        instance +
        " but env GP_INSTANCE=" +
        envInstance +
        ". Refusing to run to prevent cross-instance writes.\n",
    )
    return { exitCode: 2, mode: apply ? "apply" : "dry-run", instance }
  }
  if (!envInstance) {
    io.stderr.write(
      "[migrate-jca-txt-to-pdf] warning: env GP_INSTANCE is not set; " +
        "--instance is recorded as a logging label only. Actual DB binding " +
        "is the active Medusa container.\n",
    )
  }

  const legacyCount = await io.countLegacyRows(instance)

  io.stdout.write(
    "[migrate-jca-txt-to-pdf] instance=" +
      instance +
      " mode=" +
      (apply ? "apply" : "dry-run") +
      " legacy_rows_found=" +
      legacyCount +
      "\n",
  )

  if (legacyCount === 0) {
    io.stdout.write(
      "[migrate-jca-txt-to-pdf] No legacy jca_generated rows found. Nothing to migrate.\n",
    )
    return {
      exitCode: 0,
      mode: apply ? "apply" : "dry-run",
      instance,
      legacyRowsFound: 0,
      correctionRowsInserted: 0,
    }
  }

  if (!apply) {
    io.stdout.write(
      "[DRY-RUN] Would insert " +
        legacyCount +
        " correction row(s) into vendor_notification_log.\n" +
        "[DRY-RUN] Re-run with --apply to execute.\n",
    )
    return {
      exitCode: 0,
      mode: "dry-run",
      instance,
      legacyRowsFound: legacyCount,
    }
  }

  const promptMessage =
    "Confirm migration on instance=" +
    instance +
    " inserting corrections for ~" +
    legacyCount +
    " legacy jca_generated row(s)? [yes/no]: "

  let answer: string
  try {
    answer = await io.prompt(promptMessage)
  } catch (err) {
    io.stderr.write(
      "Migration aborted by operator. No DB writes performed. (reason: prompt error: " +
        ((err as Error)?.message ?? String(err)) +
        ")\n",
    )
    return {
      exitCode: 1,
      mode: "apply",
      instance,
      legacyRowsFound: legacyCount,
      aborted: true,
      abortReason: "prompt-error",
    }
  }

  if (answer !== "yes") {
    io.stderr.write("Migration aborted by operator. No DB writes performed.\n")
    return {
      exitCode: 1,
      mode: "apply",
      instance,
      legacyRowsFound: legacyCount,
      aborted: true,
      abortReason: "operator-declined",
    }
  }

  const rows = await io.fetchLegacyRows(instance)
  const result = await io.insertCorrectionRows(instance, rows)

  io.stdout.write(
    "[migrate-jca-txt-to-pdf] applied. instance=" +
      instance +
      " correction_rows_inserted=" +
      result.rowsInserted +
      "\n",
  )

  return {
    exitCode: 0,
    mode: "apply",
    instance,
    legacyRowsFound: legacyCount,
    correctionRowsInserted: result.rowsInserted,
  }
}

export function defaultPrompt(question: string): Promise<string> {
  // Review fix L-1: track settlement so SIGINT rejects with a distinct
  // reason instead of being swallowed by the close event firing first.
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })
    let settled = false
    const settleResolve = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const settleReject = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    rl.question(question, (answer) => {
      rl.close()
      settleResolve(answer)
    })
    rl.on("close", () => {
      settleResolve("")
    })
    rl.on("SIGINT", () => {
      settleReject(new Error("SIGINT received during operator prompt"))
      rl.close()
    })
  })
}

export function makeKnexAdapters(db: any): {
  countLegacyRows: CountLegacyFn
  fetchLegacyRows: FetchLegacyFn
  insertCorrectionRows: InsertCorrectionFn
} {
  const unreconciledLegacyPredicate = `
        legacy.notification_type = 'jca_generated'
        AND (
          legacy.metadata IS NULL
          OR legacy.metadata->>'format' IS NULL
          OR legacy.metadata->>'format' != 'pdf'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM vendor_notification_log correction
          WHERE correction.notification_type = 'jca_generated'
            AND correction.metadata->>'format' = 'pdf'
            AND correction.metadata->>'original_row_id' = legacy.id::text
        )
  `

  const countLegacyRows: CountLegacyFn = async (_instance) => {
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM vendor_notification_log legacy
      WHERE ${unreconciledLegacyPredicate}
    `
    const result = await db.raw(sql)
    const row = Array.isArray(result?.rows) ? result.rows[0] : result?.[0]
    const count = Number(row?.count ?? 0)
    return Number.isFinite(count) ? count : 0
  }

  const fetchLegacyRows: FetchLegacyFn = async (_instance) => {
    const sql = `
      SELECT legacy.id, legacy.vendor_id, legacy.sent_at::text, legacy.metadata
      FROM vendor_notification_log legacy
      WHERE ${unreconciledLegacyPredicate}
      ORDER BY legacy.sent_at ASC
    `
    const result = await db.raw(sql)
    return (Array.isArray(result?.rows) ? result.rows : result ?? []).map(
      (r: any) => ({
        id: r.id,
        vendor_id: r.vendor_id,
        sent_at: r.sent_at,
        metadata:
          typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata,
      }),
    )
  }

  const insertCorrectionRows: InsertCorrectionFn = async (_instance, rows) => {
    if (rows.length === 0) return { rowsInserted: 0 }

    let inserted = 0
    for (const row of rows) {
      const correctionMetadata = {
        ...(row.metadata ?? {}),
        format: "pdf",
        // Review fix I-1: keep the migration note grep-friendly but short.
        migration_note: "story-4-3:jca-txt-retired",
        migrated_at: new Date().toISOString(),
        original_row_id: row.id,
      }
      // Review fix M-1: copy vendor_handle forward to keep the audit join
      // between the legacy and correction rows intact.
      // Review fix L-4: re-check the legacy predicate explicitly so a
      // partially-migrated dataset cannot insert a correction for a row
      // that no longer matches the legacy criteria.
      const sql = `
        INSERT INTO vendor_notification_log
          (vendor_id, vendor_handle, notification_type, locale, recipient_email, status, triggered_by, metadata)
        SELECT
          legacy.vendor_id,
          legacy.vendor_handle,
          'jca_generated',
          legacy.locale,
          legacy.recipient_email,
          'sent',
          'script:migrate-jca-txt-to-pdf',
          $1::jsonb
        FROM vendor_notification_log legacy
        WHERE legacy.id = $2
          AND legacy.notification_type = 'jca_generated'
          AND (
            legacy.metadata IS NULL
            OR legacy.metadata->>'format' IS NULL
            OR legacy.metadata->>'format' != 'pdf'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM vendor_notification_log correction
            WHERE correction.notification_type = 'jca_generated'
              AND correction.metadata->>'format' = 'pdf'
              AND correction.metadata->>'original_row_id' = legacy.id::text
          )
      `
      const result = await db.raw(sql, [JSON.stringify(correctionMetadata), row.id])
      const affected = Number(result?.rowCount ?? result?.[0]?.affectedRows ?? 1)
      inserted += affected > 0 ? 1 : 0
    }

    return { rowsInserted: inserted }
  }

  return { countLegacyRows, fetchLegacyRows, insertCorrectionRows }
}

export default async function migrateJcaTxtToPdf({
  container,
  args,
}: ExecArgs): Promise<void> {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const adapters = makeKnexAdapters(db)

  const outcome = await runMigration(args, {
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: defaultPrompt,
    countLegacyRows: adapters.countLegacyRows,
    fetchLegacyRows: adapters.fetchLegacyRows,
    insertCorrectionRows: adapters.insertCorrectionRows,
    env: { GP_INSTANCE: process.env.GP_INSTANCE ?? null },
  })

  if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode
  }
}
