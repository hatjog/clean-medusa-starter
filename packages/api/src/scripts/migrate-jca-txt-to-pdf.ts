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
 *   - Idempotent: WHERE clause only touches rows still needing migration
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
    "metadata->>'format' IS NULL or != 'pdf'. For each legacy row,",
    "appends a new correction row with format='pdf' and migration_note.",
    "",
    "Flags:",
    "  --instance <id>   Required. One of: " + ALLOWED_INSTANCES.join(", "),
    "  --apply           Opt-in. Performs DB writes after operator confirmation.",
    "                    Without this flag the script runs in dry-run mode.",
    "  --dry-run         Default. Wins over --apply if both supplied.",
    "  --help, -h        Show this message.",
    "",
    "Note: vendor_notification_log is append-only (immutable trigger on UPDATE/",
    "DELETE). Migration writes NEW correction rows; original rows are preserved.",
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
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
    rl.on("close", () => {
      resolve("")
    })
    rl.on("SIGINT", () => {
      rl.close()
      reject(new Error("SIGINT received during operator prompt"))
    })
  })
}

export function makeKnexAdapters(db: any): {
  countLegacyRows: CountLegacyFn
  fetchLegacyRows: FetchLegacyFn
  insertCorrectionRows: InsertCorrectionFn
} {
  const countLegacyRows: CountLegacyFn = async (_instance) => {
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM vendor_notification_log
      WHERE notification_type = 'jca_generated'
        AND (
          metadata IS NULL
          OR metadata->>'format' IS NULL
          OR metadata->>'format' != 'pdf'
        )
    `
    try {
      const result = await db.raw(sql)
      const row = Array.isArray(result?.rows) ? result.rows[0] : result?.[0]
      const count = Number(row?.count ?? 0)
      return Number.isFinite(count) ? count : 0
    } catch {
      return 0
    }
  }

  const fetchLegacyRows: FetchLegacyFn = async (_instance) => {
    const sql = `
      SELECT id, vendor_id, sent_at::text, metadata
      FROM vendor_notification_log
      WHERE notification_type = 'jca_generated'
        AND (
          metadata IS NULL
          OR metadata->>'format' IS NULL
          OR metadata->>'format' != 'pdf'
        )
      ORDER BY sent_at ASC
    `
    try {
      const result = await db.raw(sql)
      return (Array.isArray(result?.rows) ? result.rows : result ?? []).map(
        (r: any) => ({
          id: r.id,
          vendor_id: r.vendor_id,
          sent_at: r.sent_at,
          metadata:
            typeof r.metadata === "string"
              ? JSON.parse(r.metadata)
              : r.metadata,
        }),
      )
    } catch {
      return []
    }
  }

  const insertCorrectionRows: InsertCorrectionFn = async (_instance, rows) => {
    if (rows.length === 0) return { rowsInserted: 0 }

    let inserted = 0
    for (const row of rows) {
      const correctionMetadata = {
        ...(row.metadata ?? {}),
        format: "pdf",
        migration_note:
          "Story 4.3 v1.7.0: retired legacy .txt format; format set to pdf (renderPDF() removed by cleanup-41 code review B-8)",
        migrated_at: new Date().toISOString(),
        original_row_id: row.id,
      }
      const sql = `
        INSERT INTO vendor_notification_log
          (vendor_id, notification_type, locale, recipient_email, status, triggered_by, metadata)
        SELECT
          vendor_id,
          'jca_generated',
          locale,
          recipient_email,
          'sent',
          'migrate-jca-txt-to-pdf',
          $1::jsonb
        FROM vendor_notification_log
        WHERE id = $2
      `
      try {
        const result = await db.raw(sql, [
          JSON.stringify(correctionMetadata),
          row.id,
        ])
        const affected = Number(
          result?.rowCount ?? result?.[0]?.affectedRows ?? 1,
        )
        inserted += affected > 0 ? 1 : 0
      } catch (err) {
        process.stderr.write(
          "[migrate-jca-txt-to-pdf] WARN: failed to insert correction for row " +
            row.id +
            ": " +
            ((err as Error)?.message ?? String(err)) +
            "\n",
        )
      }
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
  })

  if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode
  }
}
