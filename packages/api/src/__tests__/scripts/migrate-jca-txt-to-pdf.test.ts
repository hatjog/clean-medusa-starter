/**
 * Story 4.3 (v1.7.0) — JCA legacy .txt artifact migration script tests.
 *
 * AC3: migration script is idempotent, dry-run by default, requires explicit
 * operator confirmation for --apply, and correctly handles 0 legacy rows
 * (expected baseline for STAGING-FREE v1.6.0 environments — ADR-066).
 *
 * Uses IO-injectable `runMigration()` — no live DB or Medusa container needed.
 *
 * Invocation:
 *   cd GP/backend && pnpm test -- migrate-jca-txt-to-pdf
 */

import { describe, expect, it } from "@jest/globals"
import {
  ALLOWED_INSTANCES,
  parseFlags,
  helpText,
  runMigration,
  makeKnexAdapters,
  type MigrationIO,
  type AllowedInstance,
  type LegacyRow,
} from "../../scripts/migrate-jca-txt-to-pdf"

function makeStream() {
  const chunks: string[] = []
  return {
    write: (chunk: string) => {
      chunks.push(chunk)
    },
    chunks,
    output: () => chunks.join(""),
  }
}

const SAMPLE_ROWS: LegacyRow[] = [
  {
    id: "row-1",
    vendor_id: "vendor-a",
    sent_at: "2026-05-07T10:00:00Z",
    metadata: { locale: "pl" },
  },
  {
    id: "row-2",
    vendor_id: "vendor-b",
    sent_at: "2026-05-07T11:00:00Z",
    metadata: null,
  },
]

function makeIO(opts: {
  legacyCount?: number
  rows?: LegacyRow[]
  promptAnswer?: string | Error
  insertShouldFail?: boolean
  /**
   * Optional env override for cross-instance guard tests. Defaults to
   * GP_INSTANCE=bonbeauty so default-path tests do not emit the "env unset"
   * warning. Use `null` to simulate unset env, or a different string to
   * simulate mismatch.
   */
  env?: { GP_INSTANCE: string | null }
}): MigrationIO & {
  stdoutOutput: () => string
  stderrOutput: () => string
  insertCalls: number
} {
  const stdout = makeStream()
  const stderr = makeStream()
  let insertCalls = 0

  const prompt = async (_q: string): Promise<string> => {
    if (opts.promptAnswer instanceof Error) throw opts.promptAnswer
    return opts.promptAnswer ?? ""
  }

  return {
    stdout,
    stderr,
    prompt,
    env:
      opts.env === undefined
        ? { GP_INSTANCE: "bonbeauty" }
        : { GP_INSTANCE: opts.env.GP_INSTANCE ?? undefined },
    countLegacyRows: async (_inst: AllowedInstance) => opts.legacyCount ?? 0,
    fetchLegacyRows: async (_inst: AllowedInstance) => opts.rows ?? [],
    insertCorrectionRows: async (
      _inst: AllowedInstance,
      rows: LegacyRow[],
    ) => {
      insertCalls++
      if (opts.insertShouldFail) throw new Error("DB insert error")
      return { rowsInserted: rows.length }
    },
    stdoutOutput: () => stdout.output(),
    stderrOutput: () => stderr.output(),
    get insertCalls() {
      return insertCalls
    },
  }
}

// ── parseFlags ────────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("requires --instance", () => {
    const r = parseFlags([])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("--instance is required")
  })

  it("rejects unknown --instance value", () => {
    const r = parseFlags(["--instance", "unknown-market"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("must be one of")
  })

  it("accepts all valid instance values", () => {
    for (const inst of ALLOWED_INSTANCES) {
      const r = parseFlags(["--instance", inst])
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.flags.instance).toBe(inst)
    }
  })

  it("defaults apply=false (dry-run mode)", () => {
    const r = parseFlags(["--instance", "bonbeauty"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.flags.apply).toBe(false)
  })

  it("sets apply=true with --apply", () => {
    const r = parseFlags(["--instance", "bonbeauty", "--apply"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.flags.apply).toBe(true)
  })

  it("--dry-run wins over --apply when both supplied", () => {
    const r = parseFlags(["--instance", "bonbeauty", "--apply", "--dry-run"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.flags.apply).toBe(false)
  })

  it("returns __HELP__ for --help flag", () => {
    const r = parseFlags(["--help"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("__HELP__")
  })

  it("accepts --instance=<value> form", () => {
    const r = parseFlags(["--instance=mercur"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.flags.instance).toBe("mercur")
  })

  it("review fix M-3: rejects unknown flags (e.g. typo --aplly)", () => {
    const r = parseFlags(["--instance", "bonbeauty", "--aplly"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Unknown argument")
  })

  it("review fix M-3: rejects --Apply (case-sensitive)", () => {
    const r = parseFlags(["--instance", "bonbeauty", "--Apply"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Unknown argument")
  })
})

// ── helpText ──────────────────────────────────────────────────────────────────

describe("helpText", () => {
  it("mentions all allowed instances", () => {
    const text = helpText()
    for (const inst of ALLOWED_INSTANCES) {
      expect(text).toContain(inst)
    }
  })

  it("mentions STAGING-FREE v1.6.0 ADR-066 context", () => {
    expect(helpText()).toContain("STAGING-FREE")
    expect(helpText()).toContain("ADR-066")
  })
})

// ── runMigration — dry-run ────────────────────────────────────────────────────

describe("runMigration — dry-run", () => {
  it("T3a: dry-run with 0 legacy rows → reports 0, no writes, exit 0", async () => {
    const io = makeIO({ legacyCount: 0 })
    const outcome = await runMigration(["--instance", "bonbeauty"], io)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.mode).toBe("dry-run")
    expect(outcome.legacyRowsFound).toBe(0)
    expect(outcome.correctionRowsInserted).toBe(0)
    expect(io.insertCalls).toBe(0)
    expect(io.stdoutOutput()).toContain("0")
  })

  it("T3b: dry-run with 2 legacy rows → reports 2, no writes, exit 0", async () => {
    const io = makeIO({ legacyCount: 2 })
    const outcome = await runMigration(["--instance", "bonbeauty"], io)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.mode).toBe("dry-run")
    expect(outcome.legacyRowsFound).toBe(2)
    expect(outcome.correctionRowsInserted).toBeUndefined()
    expect(io.insertCalls).toBe(0)
    expect(io.stdoutOutput()).toContain("DRY-RUN")
    expect(io.stdoutOutput()).toContain("2")
  })

  it("--help prints help text, exit 0", async () => {
    const io = makeIO({})
    const outcome = await runMigration(["--help"], io)
    expect(outcome.exitCode).toBe(0)
    expect(io.stdoutOutput()).toContain("migrate-jca-txt-to-pdf.ts")
  })

  it("missing --instance → error on stderr, exit 2", async () => {
    const io = makeIO({})
    const outcome = await runMigration([], io)
    expect(outcome.exitCode).toBe(2)
    expect(io.stderrOutput()).toContain("--instance is required")
    expect(io.insertCalls).toBe(0)
  })
})

// ── runMigration — apply ──────────────────────────────────────────────────────

describe("runMigration — apply", () => {
  it("T3c: apply with 0 rows → skip confirmation, exit 0, 0 inserts", async () => {
    const io = makeIO({ legacyCount: 0, promptAnswer: "yes" })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.legacyRowsFound).toBe(0)
    expect(outcome.correctionRowsInserted).toBe(0)
    expect(io.insertCalls).toBe(0)
    // No prompt should have been shown (nothing to do)
    expect(io.stdoutOutput()).toContain("Nothing to migrate")
  })

  it("T3d: apply with 2 rows, operator confirms 'yes' → inserts 2 corrections", async () => {
    const io = makeIO({
      legacyCount: 2,
      rows: SAMPLE_ROWS,
      promptAnswer: "yes",
    })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.mode).toBe("apply")
    expect(outcome.legacyRowsFound).toBe(2)
    expect(outcome.correctionRowsInserted).toBe(2)
    expect(io.insertCalls).toBe(1)
  })

  it("T3e: apply with rows, operator declines → aborted, no writes, exit 1", async () => {
    const io = makeIO({
      legacyCount: 2,
      rows: SAMPLE_ROWS,
      promptAnswer: "no",
    })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(1)
    expect(outcome.aborted).toBe(true)
    expect(outcome.abortReason).toBe("operator-declined")
    expect(io.insertCalls).toBe(0)
    expect(io.stderrOutput()).toContain("aborted")
  })

  it("apply with rows, operator responds 'Yes' (wrong case) → aborted", async () => {
    const io = makeIO({
      legacyCount: 1,
      rows: SAMPLE_ROWS.slice(0, 1),
      promptAnswer: "Yes",
    })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(1)
    expect(outcome.aborted).toBe(true)
  })

  it("apply with rows, prompt throws → aborted with prompt-error, exit 1", async () => {
    const io = makeIO({
      legacyCount: 1,
      rows: SAMPLE_ROWS.slice(0, 1),
      promptAnswer: new Error("SIGINT"),
    })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(1)
    expect(outcome.aborted).toBe(true)
    expect(outcome.abortReason).toBe("prompt-error")
  })
})

// ── idempotency ───────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("T3f: second apply run with 0 legacy rows → 0 inserts (idempotent)", async () => {
    // After migration, countLegacyRows returns 0 (WHERE clause filters migrated rows)
    const io = makeIO({ legacyCount: 0, promptAnswer: "yes" })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.correctionRowsInserted).toBe(0)
    expect(io.insertCalls).toBe(0)
  })
})

// ── STAGING-FREE baseline expectation ─────────────────────────────────────────

describe("STAGING-FREE v1.6.0 baseline", () => {
  it("reports 0 legacy rows and exits cleanly (expected production baseline for v1.7.0)", async () => {
    // Simulates running the script against a fresh STAGING-FREE v1.6.0 environment.
    const io = makeIO({ legacyCount: 0 })
    const outcome = await runMigration(["--instance", "bonbeauty"], io)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.legacyRowsFound).toBe(0)
    expect(io.stdoutOutput()).toContain("Nothing to migrate")
  })
})

// ── runMigration — cross-instance env guard (review fix M-2) ─────────────────

describe("runMigration — cross-instance env guard", () => {
  it("aborts with exit 2 when GP_INSTANCE env disagrees with --instance flag", async () => {
    const io = makeIO({
      legacyCount: 5,
      env: { GP_INSTANCE: "testmarketb" },
    })
    const outcome = await runMigration(
      ["--instance", "bonbeauty", "--apply"],
      io,
    )
    expect(outcome.exitCode).toBe(2)
    expect(io.stderrOutput()).toContain("Instance mismatch")
    expect(io.insertCalls).toBe(0)
  })

  it("proceeds and warns to stderr when GP_INSTANCE is unset", async () => {
    const io = makeIO({ legacyCount: 0, env: { GP_INSTANCE: null } })
    const outcome = await runMigration(["--instance", "bonbeauty"], io)
    expect(outcome.exitCode).toBe(0)
    expect(io.stderrOutput()).toContain("GP_INSTANCE is not set")
  })

  it("proceeds silently when GP_INSTANCE matches --instance", async () => {
    const io = makeIO({
      legacyCount: 0,
      env: { GP_INSTANCE: "bonbeauty" },
    })
    const outcome = await runMigration(["--instance", "bonbeauty"], io)
    expect(outcome.exitCode).toBe(0)
    expect(io.stderrOutput()).not.toContain("GP_INSTANCE is not set")
    expect(io.stderrOutput()).not.toContain("Instance mismatch")
  })
})

// ── makeKnexAdapters — append-only idempotency ───────────────────────────────

describe("makeKnexAdapters", () => {
  it("counts only legacy rows without an existing correction row", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      raw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [{ count: "2" }] }
      },
    }

    const adapters = makeKnexAdapters(db)
    await expect(adapters.countLegacyRows("bonbeauty")).resolves.toBe(2)

    expect(calls[0].sql).toContain("NOT EXISTS")
    expect(calls[0].sql).toContain("metadata->>'original_row_id'")
    expect(calls[0].sql).toContain("legacy.id::text")
  })

  it("propagates DB errors instead of reporting false zero rows", async () => {
    const db = {
      raw: async () => {
        throw new Error("relation vendor_notification_log does not exist")
      },
    }

    const adapters = makeKnexAdapters(db)
    await expect(adapters.countLegacyRows("bonbeauty")).rejects.toThrow(
      "vendor_notification_log",
    )
    await expect(adapters.fetchLegacyRows("bonbeauty")).rejects.toThrow(
      "vendor_notification_log",
    )
  })

  it("inserts corrections with an original_row_id guard for rerun safety", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      raw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rowCount: 1 }
      },
    }

    const adapters = makeKnexAdapters(db)
    await expect(
      adapters.insertCorrectionRows("bonbeauty", SAMPLE_ROWS.slice(0, 1)),
    ).resolves.toEqual({ rowsInserted: 1 })

    expect(calls[0].sql).toContain("NOT EXISTS")
    expect(calls[0].sql).toContain("metadata->>'original_row_id'")
    expect(JSON.parse(String(calls[0].params?.[0]))).toMatchObject({
      format: "pdf",
      original_row_id: "row-1",
    })
  })

  it("review fix M-1: INSERT carries vendor_handle from the legacy row", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      raw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rowCount: 1 }
      },
    }
    const adapters = makeKnexAdapters(db)
    await adapters.insertCorrectionRows("bonbeauty", SAMPLE_ROWS.slice(0, 1))
    expect(calls[0].sql).toContain("vendor_handle")
    expect(calls[0].sql).toContain("legacy.vendor_handle")
  })

  it("review fix L-4: INSERT re-checks the legacy predicate inside its WHERE clause", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      raw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rowCount: 1 }
      },
    }
    const adapters = makeKnexAdapters(db)
    await adapters.insertCorrectionRows("bonbeauty", SAMPLE_ROWS.slice(0, 1))
    expect(calls[0].sql).toContain("legacy.notification_type = 'jca_generated'")
    expect(calls[0].sql).toContain("metadata->>'format'")
  })

  it("review fix I-2: triggered_by is the scoped 'script:' identifier", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      raw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rowCount: 1 }
      },
    }
    const adapters = makeKnexAdapters(db)
    await adapters.insertCorrectionRows("bonbeauty", SAMPLE_ROWS.slice(0, 1))
    expect(calls[0].sql).toContain("'script:migrate-jca-txt-to-pdf'")
  })
})
