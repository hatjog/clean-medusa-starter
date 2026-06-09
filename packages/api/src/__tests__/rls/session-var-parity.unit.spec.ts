jest.mock("@mikro-orm/migrations", () => {
  class MigrationStub {
    public addSql(_sql: string, ..._args: unknown[]): void {
      /* overridden by RecordingMigration */
    }
  }
  return { Migration: MigrationStub };
});

import { GP_MARKET_SESSION_VAR } from "../../lib/rls-pool-hook";
import { Migration20260609090000VoucherRecipientPiiGpMarketSessionVar } from "../../migrations/Migration20260609090000VoucherRecipientPiiGpMarketSessionVar";
import marketContextCacheLoader, {
  marketContextCache,
} from "../../loaders/market-context-cache";
import fs from "node:fs";
import path from "node:path";

const mockRaw = jest.fn();
const mockResolve = jest.fn();
const mockInstallRlsPoolHook = jest.fn();
const RETIRED_SESSION_VAR = ["app", "market_id"].join(".");

jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    PG_CONNECTION: "__pg_connection__",
    LOGGER: "logger",
  },
}));

jest.mock("../../lib/rls-pool-hook", () => {
  const actual = jest.requireActual("../../lib/rls-pool-hook");
  return {
    ...actual,
    installRlsPoolHook: (...args: unknown[]) => mockInstallRlsPoolHook(...args),
  };
});

type RecordedSql = { sql: string; params: unknown[] };

class RecordingMigration extends Migration20260609090000VoucherRecipientPiiGpMarketSessionVar {
  public recorded: RecordedSql[] = [];

  public override addSql(sql: string, ...args: unknown[]): void {
    this.recorded.push({ sql, params: args });
  }
}

function createMockContainer() {
  const logger = { error: jest.fn() };

  mockResolve.mockImplementation((key: string) => {
    if (key === "__pg_connection__") return { raw: mockRaw };
    if (key === "logger") return logger;
    return undefined;
  });

  return { resolve: mockResolve, logger } as any;
}

// Extracts session-var key names from NULLIF(current_setting('key', true), '')::uuid pattern.
// Design note (I1): test treats GP_MARKET_SESSION_VAR (exported const from hook) as
// ground-truth for the producer key. The migration holds its own local copy of the literal
// to avoid circular imports; this parity test is the mechanical link that catches drift
// between the hook's exported constant and the migration DDL literal.
function extractCurrentSettingKeys(sql: string): string[] {
  return [
    ...[...sql.matchAll(/NULLIF\(current_setting\('([^']+)',\s*true\),\s*''\)::uuid/g)].map(
      (m) => m[1]
    ),
    ...[...sql.matchAll(/(?<!NULLIF\()current_setting\('([^']+)',\s*true\)::uuid/g)].map(
      (m) => m[1]
    ),
  ];
}

function listProductionSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        return [];
      }
      return listProductionSourceFiles(fullPath);
    }
    return entry.isFile() && /\.(ts|sql)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe("gp market session-var parity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    marketContextCache.destroy();
  });

  afterEach(() => {
    marketContextCache.destroy();
  });

  it("keeps voucher_recipient_pii policy DDL aligned with the producer session var", async () => {
    const migration = new (RecordingMigration as any)();

    await migration.up();

    const sql = migration.recorded.map((entry) => entry.sql).join("\n");
    const policyKeys = extractCurrentSettingKeys(sql);

    expect(policyKeys).toEqual([GP_MARKET_SESSION_VAR, GP_MARKET_SESSION_VAR]);
    expect(sql).toContain("DROP POLICY IF EXISTS rls_voucher_recipient_pii_market_isolation");
    expect(sql).toContain("CREATE POLICY rls_voucher_recipient_pii_market_isolation");
    expect(sql).toContain(
      "USING (market_id::uuid = NULLIF(current_setting('app.gp_market_id', true), '')::uuid)"
    );
    expect(sql).toContain(
      "WITH CHECK (market_id::uuid = NULLIF(current_setting('app.gp_market_id', true), '')::uuid)"
    );
    expect(sql).not.toContain(RETIRED_SESSION_VAR);
  });

  it("policy DDL uses NULLIF guard so empty GUC hides rows instead of throwing cast error", async () => {
    const migration = new (RecordingMigration as any)();

    await migration.up();

    const sql = migration.recorded.map((entry) => entry.sql).join("\n");
    // NULLIF('', '')→NULL → NULL::uuid comparison → row hidden (fail-closed), not
    // "invalid input syntax for type uuid: """ which a bare current_setting(...)::uuid would raise.
    expect(sql).toContain("NULLIF(current_setting('app.gp_market_id', true), '')::uuid");
    // Bare cast without NULLIF guard must not appear
    expect(sql).not.toMatch(/current_setting\('app\.gp_market_id',\s*true\)::uuid(?!\s*\))/);
  });

  it("keeps down() as a forward-fix and does not reintroduce the retired key", async () => {
    const migration = new (RecordingMigration as any)();

    await migration.down();

    const sql = migration.recorded.map((entry) => entry.sql).join("\n");
    expect(extractCurrentSettingKeys(sql)).toEqual([
      GP_MARKET_SESSION_VAR,
      GP_MARKET_SESSION_VAR,
    ]);
    expect(sql).not.toContain(RETIRED_SESSION_VAR);
  });

  it("keeps production gp_core/voucher-pii sources free of the retired session-var key", () => {
    const srcRoot = path.resolve(__dirname, "../..");
    const retiredKeyPattern = new RegExp(["app", "\\.market_id"].join(""));
    const offenders = listProductionSourceFiles(srcRoot)
      // Exclude historical (already-applied) migrations: their legacy DDL is
      // immutable history; the forward-fix migration Migration20260609090000 is the
      // canonical record of the rename for existing environments.
      .filter((file) => !path.basename(file).startsWith("Migration20260430090000"))
      .filter((file) => retiredKeyPattern.test(fs.readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });

  it("loads gp_market_id from sales_channel metadata and passes that source to the RLS hook", async () => {
    mockRaw.mockResolvedValue({
      rows: [{ id: "sc_001", market_id: "3f7a2ca6-b1be-41e8-bddd-9f0d00e7d5b1" }],
    });

    await marketContextCacheLoader({ container: createMockContainer() });

    expect(mockRaw).toHaveBeenCalledWith(
      expect.stringContaining("metadata->>'gp_market_id' AS market_id")
    );
    expect(mockRaw).toHaveBeenCalledWith(
      expect.stringContaining("WHERE metadata->>'gp_market_id' IS NOT NULL")
    );
    expect(marketContextCache.get("sc_001")).toBe(
      "3f7a2ca6-b1be-41e8-bddd-9f0d00e7d5b1"
    );
    expect(mockInstallRlsPoolHook).toHaveBeenCalledWith(
      { raw: mockRaw },
      expect.objectContaining({ error: expect.any(Function) })
    );
  });
});
