/**
 * STORY-D66 — Dry-run + operator confirmation test suite for the
 * MoR-snapshot 3-instance backfill script.
 *
 * Covers AC #1, #2, #3, #7 of STORY-D66-backfill-3-instances.md.
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/scripts/backfill-3-instances-dry-run.test.ts
 *
 * Why test doubles instead of a live Postgres: the unit-test gate runs without
 * a database. Concurrency + audit-flag preservation against real Postgres is
 * exercised by `backfill-3-instances-concurrent-write.test.ts` (R3-AI-06).
 */

import {
  ALLOWED_INSTANCES,
  parseFlags,
  helpText,
  runBackfill,
  type BackfillIO,
  type AllowedInstance,
} from "../../scripts/backfill-mor-snapshot"

type CapturedStream = { write: (chunk: string) => void; chunks: string[] }

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    write: (chunk: string) => {
      chunks.push(chunk)
    },
    chunks,
  }
}

function makeIO(opts: {
  rows?: number
  promptAnswer?: string | (() => Promise<string>)
  applyImpl?: (instance: AllowedInstance) => Promise<{ rowsUpdated: number }>
}): BackfillIO & {
  stdoutChunks: string[]
  stderrChunks: string[]
  applyCalls: AllowedInstance[]
} {
  const stdout = makeStream()
  const stderr = makeStream()
  const applyCalls: AllowedInstance[] = []

  const promptResolver = opts.promptAnswer
  const prompt = async (_q: string) => {
    if (typeof promptResolver === "function") return await promptResolver()
    if (typeof promptResolver === "string") return promptResolver
    return ""
  }

  return {
    stdout,
    stderr,
    prompt,
    countLegacyRows: async (_inst) => opts.rows ?? 0,
    applyBackfill: async (instance) => {
      applyCalls.push(instance)
      if (opts.applyImpl) return await opts.applyImpl(instance)
      return { rowsUpdated: opts.rows ?? 0 }
    },
    stdoutChunks: stdout.chunks,
    stderrChunks: stderr.chunks,
    applyCalls,
  }
}

describe("STORY-D66 — parseFlags (AC #1)", () => {
  it("accepts each allowed instance (bonbeauty, mercur, testmarketb)", () => {
    for (const instance of ALLOWED_INSTANCES) {
      const result = parseFlags(["--instance", instance])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.flags.instance).toBe(instance)
        expect(result.flags.apply).toBe(false)
      }
    }
  })

  it("rejects an unknown --instance value with explicit error", () => {
    const result = parseFlags(["--instance", "bongarden"])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("--instance must be one of")
      expect(result.error).toContain("bonbeauty")
      expect(result.error).toContain("mercur")
      expect(result.error).toContain("testmarketb")
      expect(result.error).toContain("got: bongarden")
    }
  })

  it("rejects missing --instance flag", () => {
    const result = parseFlags([])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("--instance is required")
    }
  })

  it("supports --instance=<value> syntax", () => {
    const result = parseFlags(["--instance=mercur"])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.flags.instance).toBe("mercur")
  })

  it("--apply flag is captured", () => {
    const result = parseFlags(["--instance", "bonbeauty", "--apply"])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.flags.apply).toBe(true)
  })

  it("--dry-run wins over --apply when both supplied (safety)", () => {
    const result = parseFlags(["--instance", "bonbeauty", "--apply", "--dry-run"])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.flags.apply).toBe(false)
  })

  it("--help short-circuits with the help marker", () => {
    const result = parseFlags(["--help"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("__HELP__")
  })
})

describe("STORY-D66 — helpText documents staging order", () => {
  it("documents per-instance staging order in --help output", () => {
    const text = helpText()
    expect(text).toContain("bonbeauty")
    expect(text).toContain("FIRST")
    expect(text).toContain("mercur")
    expect(text).toContain("testmarketb")
    expect(text).toContain("24h soak")
  })

  it("documents the rollback path reference", () => {
    expect(helpText()).toContain("v1.4.0-deploy.md")
  })
})

describe("STORY-D66 — dry-run mode (AC #2, #7)", () => {
  it("default mode is dry-run — performs ZERO DB writes", async () => {
    const io = makeIO({ rows: 7 })
    const result = await runBackfill(["--instance", "bonbeauty"], io)

    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe("dry-run")
    expect(result.rowsPlanned).toBe(7)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("emits the [DRY-RUN] marker per AC #2", async () => {
    const io = makeIO({ rows: 3 })
    await runBackfill(["--instance", "mercur"], io)

    const stdout = io.stdoutChunks.join("")
    expect(stdout).toContain("[DRY-RUN] No DB writes performed.")
    expect(stdout).toContain("Re-run with --apply to execute.")
  })

  it("includes plan summary (instance, rows, target columns)", async () => {
    const io = makeIO({ rows: 42 })
    await runBackfill(["--instance", "testmarketb"], io)

    const stdout = io.stdoutChunks.join("")
    expect(stdout).toContain("instance=testmarketb")
    expect(stdout).toContain("mode=dry-run")
    expect(stdout).toContain("rows_planned=42")
    expect(stdout).toContain("sale_mor")
    expect(stdout).toContain("service_mor")
    expect(stdout).toContain("mor_policy_version")
    expect(stdout).toContain("voucher_kind")
    expect(stdout).toContain("breakage_policy_snapshot")
  })

  it("invalid --instance value exits non-zero with error to stderr", async () => {
    const io = makeIO({ rows: 0 })
    const result = await runBackfill(["--instance", "bongarden"], io)

    expect(result.exitCode).toBe(2)
    expect(io.applyCalls).toHaveLength(0)
    expect(io.stderrChunks.join("")).toContain("--instance must be one of")
  })
})

describe("STORY-D66 — --apply confirmation prompt (AC #3, #7)", () => {
  it("strict literal 'yes' proceeds with backfill", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "yes" })
    const result = await runBackfill(["--instance", "bonbeauty", "--apply"], io)

    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe("apply")
    expect(result.aborted).toBeUndefined()
    expect(io.applyCalls).toEqual(["bonbeauty"])
    expect(result.rowsUpdated).toBe(5)
  })

  it("'no' rejects + exits 1 + ZERO DB writes", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "no" })
    const result = await runBackfill(["--instance", "bonbeauty", "--apply"], io)

    expect(result.exitCode).toBe(1)
    expect(result.aborted).toBe(true)
    expect(io.applyCalls).toHaveLength(0)
    expect(io.stderrChunks.join("")).toContain("Backfill aborted by operator.")
  })

  it("'Yes' (case typo) rejects — strict literal check (R3-AI-07)", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "Yes" })
    const result = await runBackfill(["--instance", "mercur", "--apply"], io)

    expect(result.exitCode).toBe(1)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("'YES' (uppercase) rejects — strict literal check", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "YES" })
    const result = await runBackfill(["--instance", "mercur", "--apply"], io)
    expect(result.exitCode).toBe(1)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("'y' (shorthand) rejects — strict literal check", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "y" })
    const result = await runBackfill(["--instance", "testmarketb", "--apply"], io)
    expect(result.exitCode).toBe(1)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("empty input rejects (treated as decline)", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "" })
    const result = await runBackfill(["--instance", "mercur", "--apply"], io)
    expect(result.exitCode).toBe(1)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("'yes ' (trailing whitespace) rejects — no implicit trim", async () => {
    const io = makeIO({ rows: 5, promptAnswer: "yes " })
    const result = await runBackfill(["--instance", "bonbeauty", "--apply"], io)
    expect(result.exitCode).toBe(1)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("' yes' (leading whitespace) rejects — no implicit trim", async () => {
    const io = makeIO({ rows: 5, promptAnswer: " yes" })
    const result = await runBackfill(["--instance", "bonbeauty", "--apply"], io)
    expect(result.exitCode).toBe(1)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("prompt error (e.g. SIGINT) aborts with non-zero exit + zero writes", async () => {
    const io = makeIO({
      rows: 5,
      promptAnswer: () => Promise.reject(new Error("SIGINT received during operator prompt")),
    })
    const result = await runBackfill(["--instance", "bonbeauty", "--apply"], io)

    expect(result.exitCode).toBe(1)
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe("prompt-error")
    expect(io.applyCalls).toHaveLength(0)
  })

  it("confirmation prompt interpolates instance name AND row count (footgun mitigation)", async () => {
    let capturedQuestion = ""
    const io = makeIO({
      rows: 137,
      promptAnswer: () => {
        return Promise.resolve("no")
      },
    })
    const seenIo: BackfillIO = {
      ...io,
      prompt: async (q: string) => {
        capturedQuestion = q
        return "no"
      },
    }
    await runBackfill(["--instance", "testmarketb", "--apply"], seenIo)

    expect(capturedQuestion).toContain("instance=testmarketb")
    expect(capturedQuestion).toContain("~137 rows")
    expect(capturedQuestion).toContain("[yes/no]")
  })
})

describe("STORY-D66 — audit-flag preservation (AC #4)", () => {
  // The full preservation contract is exercised in
  // backfill-3-instances-audit-flag.test.ts (separate file), but the
  // structural guarantee — that the dry-run path never touches the writer —
  // is asserted here so a regression to "default = apply" is caught fast.
  it("dry-run never invokes applyBackfill (no writes possible)", async () => {
    const io = makeIO({ rows: 99 })
    await runBackfill(["--instance", "bonbeauty"], io)
    expect(io.applyCalls).toHaveLength(0)
  })

  it("--apply + 'no' answer never invokes applyBackfill", async () => {
    const io = makeIO({ rows: 99, promptAnswer: "no" })
    await runBackfill(["--instance", "bonbeauty", "--apply"], io)
    expect(io.applyCalls).toHaveLength(0)
  })
})
