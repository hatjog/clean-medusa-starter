import { describe, it, expect, jest } from "@jest/globals";

import auditHashChainValidate, {
  SCHEDULE_NAME,
  SCHEDULE_CRON,
  AUDIT_TABLES_TO_VALIDATE,
  resolveQueryRunner,
  config,
} from "../../jobs/audit-hash-chain-validate";

/**
 * SB-2 (v1.9.1 Wave G1) regression — `__pg_connection__` in Medusa 2 resolves
 * to a Knex<any> instance which exposes `.raw()`, NOT `.query()`.
 *
 * Before the fix this scheduled job crashed every tick with
 * `query.query is not a function`. The fix mirrors the `resolveQueryRunner`
 * pattern from `canary-baseline-rolling.ts` (7563432 + 7435d1a) and the
 * `$N` → `?` rewrite that unblocked SB-4 (f78b59d).
 *
 * Unit-only; no DB connection required. Integration coverage runs via the
 * Medusa job scheduler at boot once the @v190-e2e-b harness is restored
 * (Phase 6).
 */

describe("audit-hash-chain-validate — schedule metadata", () => {
  it("exposes the canonical schedule name + cron", () => {
    expect(SCHEDULE_NAME).toBe("audit-hash-chain-validate");
    expect(SCHEDULE_CRON).toBe("0 4 * * *");
    expect(config).toEqual({
      name: SCHEDULE_NAME,
      schedule: SCHEDULE_CRON,
    });
  });

  it("targets at least the v1.5.0 voucher PII consent audit table", () => {
    expect(AUDIT_TABLES_TO_VALIDATE).toContain("voucher_pii_consent_audit");
  });
});

describe("audit-hash-chain-validate — resolveQueryRunner SB-2 fix", () => {
  it("returns null when no DB is wired (test/no-DB env)", () => {
    const fakeContainer = {
      resolve: () => {
        throw new Error("not registered");
      },
    } as unknown as Parameters<typeof auditHashChainValidate>[0];
    expect(resolveQueryRunner(fakeContainer)).toBeNull();
  });

  it("passes through a legacy QueryRunner shape (`.query` exists)", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const fakeRunner = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ ok: 1 }] };
      },
    };
    const fakeContainer = {
      resolve: (key: string) => {
        if (key !== "__pg_connection__") throw new Error("not registered");
        return fakeRunner;
      },
    } as unknown as Parameters<typeof auditHashChainValidate>[0];

    const runner = resolveQueryRunner(fakeContainer);
    expect(runner).not.toBeNull();
    await runner!.query("SELECT 1", []);
    expect(calls[0]?.sql).toBe("SELECT 1");
  });

  it("adapts a Knex raw runner and rewrites `$N` → `?` placeholders", async () => {
    const rawCalls: Array<{ sql: string; bindings?: unknown[] }> = [];
    const fakeContainer = {
      resolve: (key: string) => {
        if (key !== "__pg_connection__") throw new Error("not registered");
        return {
          raw: async (sql: string, bindings?: unknown[]) => {
            rawCalls.push({ sql, bindings });
            return { rows: [{ market_id: "bonbeauty", hour_bucket: "2026-05-24T00:00:00Z" }] };
          },
        };
      },
    } as unknown as Parameters<typeof auditHashChainValidate>[0];

    const runner = resolveQueryRunner(fakeContainer);
    expect(runner).not.toBeNull();

    const result = await runner!.query(
      "SELECT * FROM voucher_pii_consent_audit WHERE market_id = $1 AND hour_bucket = $2",
      ["bonbeauty", "2026-05-24T00:00:00Z"]
    );

    expect(result.rows).toEqual([
      { market_id: "bonbeauty", hour_bucket: "2026-05-24T00:00:00Z" },
    ]);
    expect(rawCalls[0]).toEqual({
      sql: "SELECT * FROM voucher_pii_consent_audit WHERE market_id = ? AND hour_bucket = ?",
      bindings: ["bonbeauty", "2026-05-24T00:00:00Z"],
    });
  });

  it("normalises a Knex raw runner that returns a bare array (no .rows wrapper)", async () => {
    const fakeContainer = {
      resolve: (key: string) => {
        if (key !== "__pg_connection__") throw new Error("not registered");
        return {
          raw: async () => [{ market_id: "bonbeauty" }],
        };
      },
    } as unknown as Parameters<typeof auditHashChainValidate>[0];

    const runner = resolveQueryRunner(fakeContainer);
    expect(runner).not.toBeNull();
    await expect(runner!.query("SELECT 1")).resolves.toEqual({
      rows: [{ market_id: "bonbeauty" }],
    });
  });
});

describe("audit-hash-chain-validate — entry point", () => {
  it("exits cleanly (no throw) when DB is not wired (logs warn)", async () => {
    const warn = jest.fn();
    const fakeContainer = {
      resolve: (key: string) => {
        if (key === "logger") {
          return { info: jest.fn(), warn, error: jest.fn() };
        }
        throw new Error("not registered");
      },
    } as unknown as Parameters<typeof auditHashChainValidate>[0];

    await expect(auditHashChainValidate(fakeContainer)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("does not crash with `query.query is not a function` when given a Knex-only runner (SB-2 regression)", async () => {
    // The Knex runner exposes `.raw()` only — pre-fix this caused the bug.
    const fakeContainer = {
      resolve: (key: string) => {
        if (key === "logger") {
          return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        }
        if (key === "__pg_connection__") {
          return {
            raw: async () => ({ rows: [] }), // no shards → clean exit
          };
        }
        throw new Error("not registered");
      },
    } as unknown as Parameters<typeof auditHashChainValidate>[0];

    await expect(auditHashChainValidate(fakeContainer)).resolves.toBeUndefined();
  });
});
