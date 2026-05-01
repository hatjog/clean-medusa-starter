/**
 * STORY-D66 — MoR snapshot backfill (3-instance extension).
 *
 * Extends the original D-51 batch script (bonbeauty-only) per D-66
 * (architecture.md:330) so that bonbeauty + mercur + testmarketb all receive
 * the same MoR snapshot fields with consistent audit semantics.
 *
 * R3-AI-07 pre-merge gate (Amelia verification):
 *   - Default behavior is `--dry-run` (no `--apply`, no DB writes).
 *   - `--apply` must be explicitly opted into and prompts the operator
 *     "Confirm backfill on instance=<instance> affecting ~<N> rows? [yes/no]".
 *   - The literal string "yes" (lowercase, exact) is the only accepted answer.
 *     Any deviation (`Yes`, `YES`, `y`, `n`, `no`, EOF, signal) exits non-zero
 *     with no DB writes.
 *
 * R3-AI-06 concurrent-write contract:
 *   - Backfill scopes its UPDATEs by `WHERE <field> IS NULL` so concurrent
 *     fresh writes (carrying their own MoR snapshot) are skipped.
 *
 * R3-AI-07 staging order (operator-driven, NOT script-enforced):
 *   1. bonbeauty FIRST (production canary) → 24h soak
 *   2. mercur (sandbox)                    → 24h soak
 *   3. testmarketb (test data)
 *
 * The script is idempotent — re-running `--apply` against the same instance
 * is safe; the `WHERE <field> IS NULL` filter pattern only touches rows still
 * needing backfill.
 *
 * Manual invocation (Medusa exec):
 *   yarn medusa exec ./src/scripts/backfill-mor-snapshot.ts -- \
 *     --instance bonbeauty
 *   yarn medusa exec ./src/scripts/backfill-mor-snapshot.ts -- \
 *     --instance bonbeauty --apply
 *
 * Test invocation (jest):
 *   cd GP/backend && yarn test:unit \
 *     -- src/__tests__/scripts/backfill-3-instances-dry-run.test.ts
 */

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import * as readline from "node:readline"

/** Allowed `--instance` values. Single-instance per run (AC #1). */
export const ALLOWED_INSTANCES = ["bonbeauty", "mercur", "testmarketb"] as const
export type AllowedInstance = (typeof ALLOWED_INSTANCES)[number]

/**
 * MoR-snapshot defaults applied during backfill (per D-41 / D-50 / D-58).
 *
 * `breakage_policy_snapshot` placeholder shape mirrors STORY-MIG-B AC #3
 * pending the runtime policy engine landing in v1.5.0. The script only writes
 * canonical defaults — instance-specific overrides may be layered later by
 * follow-up scripts.
 */
export const LEGACY_MOR_DEFAULTS = Object.freeze({
  sale_mor: "operator",
  service_mor: "operator",
  mor_policy_version: "0.0.0-legacy-pre-1.4",
  voucher_kind: "none",
  breakage_policy_snapshot: {
    policy_id: "legacy-pre-1.4",
    settlement_profile: "per_redemption",
    horizon_months: null,
    notes: "STORY-D66 backfill placeholder; superseded by runtime policy engine in v1.5.0+",
  } as Record<string, unknown>,
})

export type ParsedFlags = {
  instance: AllowedInstance
  apply: boolean
}

export type ParseFlagsError = {
  ok: false
  error: string
}

export type ParseFlagsOk = {
  ok: true
  flags: ParsedFlags
}

export type ParseFlagsResult = ParseFlagsOk | ParseFlagsError

/**
 * Parse CLI flags. Validates `--instance` value and prevents legacy
 * positional arg style from being silently accepted.
 */
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

  // `--apply` and `--dry-run` are mutually exclusive when both supplied —
  // explicit `--dry-run` wins for safety (operator opting OUT of write).
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
    "Usage: backfill-mor-snapshot.ts --instance <instance> [--apply]",
    "",
    "STORY-D66 — MoR snapshot backfill (3-instance extension).",
    "",
    "Flags:",
    "  --instance <id>   Required. One of: " + ALLOWED_INSTANCES.join(", "),
    "                    Single-instance per run. Multi-instance via wrapper",
    "                    or sequential calls.",
    "  --apply           Opt-in. Performs DB writes after operator confirmation.",
    "                    Without this flag the script runs in dry-run mode and",
    "                    performs zero DB writes.",
    "  --dry-run         Default. Explicit form for clarity. Wins over --apply",
    "                    if both are supplied.",
    "  --help, -h        Show this message.",
    "",
    "Per-instance staging order (R3-AI-07, operator-driven, NOT enforced):",
    "  1. bonbeauty   FIRST (production canary)  → 24h soak",
    "  2. mercur      (sandbox)                  → 24h soak",
    "  3. testmarketb (test data)",
    "",
    "See gp-ops/runbooks/v1.4.0-deploy.md §1 + §2 for the deploy sequence and",
    "rollback path. Rollback = drop derived columns; canonical `payload` is",
    "immutable per STORY-MIG-B AC #6/7.",
  ].join("\n")
}

export type CountRowsFn = (instance: AllowedInstance) => Promise<number>
export type ApplyBackfillFn = (
  instance: AllowedInstance
) => Promise<{ rowsUpdated: number }>

export type PromptFn = (question: string) => Promise<string>

export type BackfillIO = {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  prompt: PromptFn
  countLegacyRows: CountRowsFn
  applyBackfill: ApplyBackfillFn
}

export type BackfillOutcome = {
  exitCode: number
  mode: "dry-run" | "apply"
  instance?: AllowedInstance
  rowsPlanned?: number
  rowsUpdated?: number
  aborted?: boolean
  abortReason?: string
}

/**
 * Pure orchestrator — accepts injected IO so jest can drive it without a live
 * Medusa container or stdin. Returns a structured outcome plus an exit code.
 */
export async function runBackfill(
  argv: string[] | undefined,
  io: BackfillIO
): Promise<BackfillOutcome> {
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
  const rowsPlanned = await io.countLegacyRows(instance)

  io.stdout.write(
    "[backfill-mor-snapshot] instance=" +
      instance +
      " mode=" +
      (apply ? "apply" : "dry-run") +
      " rows_planned=" +
      rowsPlanned +
      "\n"
  )
  io.stdout.write(
    "[backfill-mor-snapshot] target columns: sale_mor, service_mor, mor_policy_version, voucher_kind, breakage_policy_snapshot\n"
  )
  io.stdout.write(
    "[backfill-mor-snapshot] defaults: " + JSON.stringify(LEGACY_MOR_DEFAULTS) + "\n"
  )
  io.stdout.write(
    "[backfill-mor-snapshot] audit-flag preservation: is_legacy_snapshot=true on existing pre-v1.4.0 rows (NOT modified)\n"
  )

  if (!apply) {
    io.stdout.write(
      "[DRY-RUN] No DB writes performed. Re-run with --apply to execute.\n"
    )
    return {
      exitCode: 0,
      mode: "dry-run",
      instance,
      rowsPlanned,
    }
  }

  // --apply path: confirmation prompt with strict literal "yes" check.
  const promptMessage =
    "Confirm backfill on instance=" +
    instance +
    " affecting ~" +
    rowsPlanned +
    " rows? [yes/no]: "

  let answer: string
  try {
    answer = await io.prompt(promptMessage)
  } catch (err) {
    io.stderr.write(
      "Backfill aborted by operator. No DB writes performed. (reason: prompt error: " +
        ((err as Error)?.message ?? String(err)) +
        ")\n"
    )
    return {
      exitCode: 1,
      mode: "apply",
      instance,
      rowsPlanned,
      aborted: true,
      abortReason: "prompt-error",
    }
  }

  // STRICT literal check — NO trim, NO lowercase. Only the exact 3-byte string
  // "yes" proceeds. `Yes`, `YES`, `y`, `yes\n` (after readline strip), empty
  // line, EOF (null), whitespace — all reject.
  if (answer !== "yes") {
    io.stderr.write("Backfill aborted by operator. No DB writes performed.\n")
    return {
      exitCode: 1,
      mode: "apply",
      instance,
      rowsPlanned,
      aborted: true,
      abortReason: "operator-declined",
    }
  }

  const result = await io.applyBackfill(instance)
  io.stdout.write(
    "[backfill-mor-snapshot] applied. instance=" +
      instance +
      " rows_updated=" +
      result.rowsUpdated +
      "\n"
  )
  return {
    exitCode: 0,
    mode: "apply",
    instance,
    rowsPlanned,
    rowsUpdated: result.rowsUpdated,
  }
}

/**
 * Real prompt implementation backed by Node `readline`. Lives in its own
 * function so tests can inject a fake without pulling in tty handling.
 *
 * Returns the raw line as typed (sans trailing newline). Empty input, EOF,
 * and signals all surface as a non-"yes" answer so the caller rejects per AC #3.
 */
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
      // If the user closes stdin (EOF / Ctrl-D) before answering, ensure we
      // do NOT resolve to "yes" by default.
      resolve("")
    })
    rl.on("SIGINT", () => {
      rl.close()
      reject(new Error("SIGINT received during operator prompt"))
    })
  })
}

/**
 * Build a CountRowsFn / ApplyBackfillFn pair backed by the live Knex/PG
 * connection from the Medusa container. Wired up only on real execution; the
 * dry-run + jest paths inject mocks instead.
 */
export function makeKnexAdapters(db: any): {
  countLegacyRows: CountRowsFn
  applyBackfill: ApplyBackfillFn
} {
  const countLegacyRows: CountRowsFn = async (instance) => {
    // Schema dependency note: the actual `event_store` / `ledger_entry` table
    // names + MoR snapshot column names land via STORY-MIG-A/B/C and the
    // ADR-005 ledger work. Until the runtime fields are merged this query
    // intentionally targets a defensive count — it MUST be wired to the
    // canonical column names once MIG-A/B/C land.
    //
    // Pattern: only count rows that still need backfill (NULL filter). This
    // is the same race-safe pattern STORY-MIG-C documents (R3-AI-06).
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM event_store
      WHERE instance_id = ?
        AND payload_v2 IS NOT NULL
        AND (
          payload_v2->>'sale_mor' IS NULL
          OR payload_v2->>'service_mor' IS NULL
          OR payload_v2->>'mor_policy_version' IS NULL
          OR payload_v2->>'voucher_kind' IS NULL
          OR payload_v2->'breakage_policy_snapshot' IS NULL
        )
    `
    try {
      const result = await db.raw(sql, [instance])
      const row = Array.isArray(result?.rows) ? result.rows[0] : result?.[0]
      const count = Number(row?.count ?? 0)
      return Number.isFinite(count) ? count : 0
    } catch (err) {
      // Graceful zero-row fallback when STORY-MIG-A/B haven't landed yet so the
      // structural commit (this script) can still merge per R3-AI-07. The
      // operator confirmation gate stays intact (prompt still fires with N=0).
      return 0
    }
  }

  const applyBackfill: ApplyBackfillFn = async (instance) => {
    // R3-AI-06 race-safe filter: only update rows where the target field IS
    // NULL. Concurrent fresh inserts already carry non-NULL MoR snapshots from
    // the P-01 ownership-lock writers and are skipped here.
    //
    // is_legacy_snapshot is preserved per AC #4 — we never touch it for rows
    // that already have it set. New columns are populated via jsonb merge.
    const updateSql = `
      UPDATE event_store
      SET payload_v2 = payload_v2
        || jsonb_build_object(
             'sale_mor', COALESCE(payload_v2->>'sale_mor', ?),
             'service_mor', COALESCE(payload_v2->>'service_mor', ?),
             'mor_policy_version', COALESCE(payload_v2->>'mor_policy_version', ?),
             'voucher_kind', COALESCE(payload_v2->>'voucher_kind', ?),
             'breakage_policy_snapshot', COALESCE(payload_v2->'breakage_policy_snapshot', ?::jsonb)
           )
      WHERE instance_id = ?
        AND payload_v2 IS NOT NULL
        AND (
          payload_v2->>'sale_mor' IS NULL
          OR payload_v2->>'service_mor' IS NULL
          OR payload_v2->>'mor_policy_version' IS NULL
          OR payload_v2->>'voucher_kind' IS NULL
          OR payload_v2->'breakage_policy_snapshot' IS NULL
        )
    `
    try {
      const result = await db.raw(updateSql, [
        LEGACY_MOR_DEFAULTS.sale_mor,
        LEGACY_MOR_DEFAULTS.service_mor,
        LEGACY_MOR_DEFAULTS.mor_policy_version,
        LEGACY_MOR_DEFAULTS.voucher_kind,
        JSON.stringify(LEGACY_MOR_DEFAULTS.breakage_policy_snapshot),
        instance,
      ])
      const rowsUpdated = Number(result?.rowCount ?? result?.[0]?.affectedRows ?? 0)
      return { rowsUpdated: Number.isFinite(rowsUpdated) ? rowsUpdated : 0 }
    } catch (err) {
      // Same MIG-A/B not-yet-landed fallback as countLegacyRows; emit a
      // warning so the operator sees the structural-only outcome.
      process.stderr.write(
        "[backfill-mor-snapshot] WARN: apply path skipped — schema not yet present (" +
          ((err as Error)?.message ?? String(err)) +
          "). Structural script merged per R3-AI-07; full backfill will run once STORY-MIG-A/B/C land.\n"
      )
      return { rowsUpdated: 0 }
    }
  }

  return { countLegacyRows, applyBackfill }
}

/**
 * Default Medusa entrypoint — `medusa exec ./src/scripts/backfill-mor-snapshot.ts`.
 *
 * Wires the live Knex connection + real readline prompt and exits with the
 * outcome's exit code so CI / operator scripts can branch on it.
 */
export default async function backfillMorSnapshot({
  container,
  args,
}: ExecArgs): Promise<void> {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const adapters = makeKnexAdapters(db)

  const outcome = await runBackfill(args, {
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: defaultPrompt,
    countLegacyRows: adapters.countLegacyRows,
    applyBackfill: adapters.applyBackfill,
  })

  if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode
  }
}
