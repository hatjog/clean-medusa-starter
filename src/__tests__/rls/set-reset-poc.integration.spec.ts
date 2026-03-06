/**
 * PoC Spike: SET/RESET mechanism for Multi-Market RLS isolation
 *
 * Story 10-1, Task 2 — validates feasibility of per-request SET LOCAL
 * in transaction context for market_id scoping.
 *
 * Tests 3 options:
 *   A (negative): afterCreate pool hook does NOT fire on pool acquire
 *   B: knex.transaction() + SET LOCAL — auto-reset on COMMIT/ROLLBACK
 *   C: MikroORM em.transactional() + SET LOCAL — if feasible in Medusa v2
 *
 * Also validates AsyncLocalStorage propagation and concurrent isolation.
 *
 * Requires: running PostgreSQL with DATABASE_URL env var.
 * Run: cd GP/backend && yarn jest --testPathPattern=set-reset-poc --runInBand
 */

import knex, { Knex } from "knex";
import { AsyncLocalStorage } from "node:async_hooks";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

const GP_MARKET_VAR = "app.gp_market_id";
const BACKEND_ROOT = `${__dirname}/../../..`;
const FRAMEWORK_DIST = `${BACKEND_ROOT}/node_modules/@medusajs/framework/dist`;

/**
 * After SET LOCAL expires (transaction end), PostgreSQL reverts to session-level
 * default which is empty string "" (not NULL) for runtime GUC variables.
 * Both are safe for RLS — empty string won't match any real market_id.
 */
function expectResetValue(value: string | null) {
  expect(value === null || value === "").toBe(true);
}

let db: Knex;

beforeAll(() => {
  db = knex({
    client: "pg",
    connection: {
      connectionString: DATABASE_URL,
      keepAlive: true,
    },
    pool: { min: 1, max: 5 },
  });
});

afterAll(async () => {
  await db.destroy();
});

// ---------------------------------------------------------------------------
// Option A — NEGATIVE TEST (AC-4)
// ---------------------------------------------------------------------------
describe("Option A negative: afterCreate does not fire on pool acquire", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    jest.unmock("@medusajs/utils");
  });

  it("Medusa pgConnectionLoader strips afterCreate from databaseDriverOptions.pool before createPgConnection", async () => {
    jest.resetModules();

    const createPgConnection = jest.fn().mockReturnValue({
      raw: jest.fn().mockResolvedValue(undefined),
    });

    jest.doMock("@medusajs/utils", () => {
      const actual = jest.requireActual("@medusajs/utils");

      return {
        ...actual,
        ModulesSdkUtils: {
          ...actual.ModulesSdkUtils,
          createPgConnection,
        },
        retryExecution: async (fn: () => Promise<unknown>) => fn(),
      };
    });

    const path = require("node:path");
    const { configManager } = require(path.join(FRAMEWORK_DIST, "config/index.js"));
    const { container } = require(path.join(FRAMEWORK_DIST, "container.js"));

    configManager.loadConfig({
      baseDir: BACKEND_ROOT,
      projectConfig: {
        projectConfig: {
          databaseUrl: DATABASE_URL,
          databaseDriverOptions: {
            connectionTimeoutMillis: 1234,
            pool: {
              min: 1,
              max: 1,
              idleTimeoutMillis: 99,
              afterCreate: jest.fn(),
            },
          },
        },
      },
    });

    jest.spyOn(container, "hasRegistration").mockReturnValue(false);
    jest.spyOn(container, "register").mockImplementation(() => container);

    const { pgConnectionLoader } = require(path.join(
      FRAMEWORK_DIST,
      "database/pg-connection-loader.js"
    ));

    await pgConnectionLoader();

    expect(createPgConnection).toHaveBeenCalledTimes(1);

    const call = createPgConnection.mock.calls[0][0];

    expect(call.pool).toEqual(
      expect.objectContaining({
        min: 1,
        max: 1,
        idleTimeoutMillis: 99,
      })
    );
    expect(call.pool.afterCreate).toBeUndefined();
    expect(call.driverOptions.pool).toBeUndefined();
  });

  it("afterCreate SET would leave stale value on connection reuse", async () => {
    const poolDb = knex({
      client: "pg",
      connection: { connectionString: DATABASE_URL },
      pool: {
        min: 1,
        max: 1,
        afterCreate: async (
          conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
          done: (err: Error | null, conn: unknown) => void
        ) => {
          // Simulates what Option A would do: SET on connection creation
          conn.query(`SET ${GP_MARKET_VAR} = 'initial_market'`, (err) => {
            done(err, conn);
          });
        },
      },
    });

    try {
      // First query — afterCreate sets 'initial_market'
      const r1 = await poolDb.raw(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );
      expect(r1.rows[0].market_id).toBe("initial_market");

      // Second query — reuses same connection, stale value persists!
      // In a real multi-market scenario, this request might belong to a DIFFERENT market
      // but would still see 'initial_market' — cross-contamination.
      const r2 = await poolDb.raw(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );
      expect(r2.rows[0].market_id).toBe("initial_market"); // STALE — proves Option A is unsafe
    } finally {
      await poolDb.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Option B — knex.transaction() + SET LOCAL (AC-2)
// ---------------------------------------------------------------------------
describe("Option B: knex.transaction() + SET LOCAL", () => {
  it("SET LOCAL within transaction returns correct value", async () => {
    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ${GP_MARKET_VAR} = 'bonbeauty'`);
      const result = await trx.raw(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );
      expect(result.rows[0].market_id).toBe("bonbeauty");
    });
  });

  it("SET LOCAL auto-resets after COMMIT", async () => {
    // Set inside transaction
    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ${GP_MARKET_VAR} = 'bonbeauty'`);
      const inside = await trx.raw(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );
      expect(inside.rows[0].market_id).toBe("bonbeauty");
    }); // COMMIT happens here

    // After transaction — value should be reset (NULL or empty string)
    const after = await db.raw(
      `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
    );
    expectResetValue(after.rows[0].market_id);
  });

  it("SET LOCAL auto-resets after ROLLBACK", async () => {
    try {
      await db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL ${GP_MARKET_VAR} = 'bonevent'`);
        const inside = await trx.raw(
          `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
        );
        expect(inside.rows[0].market_id).toBe("bonevent");
        throw new Error("Forced rollback");
      });
    } catch (e: unknown) {
      if (e instanceof Error && e.message !== "Forced rollback") throw e;
    }

    // After rollback — value should be reset
    const after = await db.raw(
      `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
    );
    expectResetValue(after.rows[0].market_id);
  });

  it("different markets in sequential transactions are isolated", async () => {
    // Transaction 1: bonbeauty
    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ${GP_MARKET_VAR} = 'bonbeauty'`);
      const r = await trx.raw(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );
      expect(r.rows[0].market_id).toBe("bonbeauty");
    });

    // Transaction 2: bonevent
    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ${GP_MARKET_VAR} = 'bonevent'`);
      const r = await trx.raw(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );
      expect(r.rows[0].market_id).toBe("bonevent");
    });

    // After both — reset
    const after = await db.raw(
      `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
    );
    expectResetValue(after.rows[0].market_id);
  });
});

// ---------------------------------------------------------------------------
// Option C — MikroORM em.transactional() + SET LOCAL (AC-2)
// ---------------------------------------------------------------------------
describe("Option C: MikroORM em.transactional() + raw SET LOCAL", () => {
  async function initTestOrm() {
    const { MikroORM } = require("@mikro-orm/postgresql");

    return MikroORM.init({
      clientUrl: DATABASE_URL,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      allowGlobalContext: true,
      connect: true,
    });
  }

  it("transactional EM can expose SET LOCAL value when raw execute uses MikroORM transaction context", async () => {
    const orm = await initTestOrm();

    try {
      await orm.em.transactional(async (em: any) => {
        const tx = em.getTransactionContext();

        expect(tx).toBeDefined();

        await em.getConnection().execute(
          `SET LOCAL ${GP_MARKET_VAR} = 'bonbeauty'`,
          [],
          "all",
          tx
        );

        const result = await em.getConnection().execute(
          `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`,
          [],
          "all",
          tx
        );

        expect(result[0].market_id).toBe("bonbeauty");
      });
    } finally {
      await orm.close(true);
    }
  });

  it("transactional EM auto-resets the value after COMMIT when using the same transaction context", async () => {
    const orm = await initTestOrm();

    try {
      await orm.em.transactional(async (em: any) => {
        const tx = em.getTransactionContext();

        await em.getConnection().execute(
          `SET LOCAL ${GP_MARKET_VAR} = 'bonevent'`,
          [],
          "all",
          tx
        );

        const inside = await em.getConnection().execute(
          `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`,
          [],
          "all",
          tx
        );

        expect(inside[0].market_id).toBe("bonevent");
      });

      const after = await orm.em.getConnection().execute(
        `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
      );

      expectResetValue(after[0].market_id ?? null);
    } finally {
      await orm.close(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AsyncLocalStorage propagation (AC-2)
// ---------------------------------------------------------------------------
describe("AsyncLocalStorage propagation", () => {
  const als = new AsyncLocalStorage<{ market_id: string; sc_id: string }>();

  it("ALS.run() propagates market_id to nested async calls", async () => {
    const ctx = { market_id: "bonbeauty", sc_id: "sc_001" };

    await als.run(ctx, async () => {
      // Nested async — should see the context
      const store = als.getStore();
      expect(store).toBeDefined();
      expect(store!.market_id).toBe("bonbeauty");
      expect(store!.sc_id).toBe("sc_001");

      // Simulate middleware: read ALS → SET LOCAL in transaction
      await db.transaction(async (trx) => {
        const alsCtx = als.getStore();
        expect(alsCtx).toBeDefined();
        await trx.raw(
          `SET LOCAL ${GP_MARKET_VAR} = '${alsCtx!.market_id}'`
        );
        const result = await trx.raw(
          `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
        );
        expect(result.rows[0].market_id).toBe("bonbeauty");
      });
    });
  });

  it("outside ALS context — getStore() returns undefined and variable resolves to reset value", async () => {
    // No ALS.run() wrapping — simulates admin request without market context
    const store = als.getStore();
    expect(store).toBeUndefined();

    // Without SET LOCAL — current_setting returns reset value (NULL or empty string)
    const result = await db.raw(
      `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
    );
    expectResetValue(result.rows[0].market_id);
  });

  it("concurrent ALS contexts — 2 markets in parallel, no cross-contamination", async () => {
    const results: { market: string; seen: string }[] = [];

    const runMarketRequest = async (marketId: string, scId: string) => {
      const ctx = { market_id: marketId, sc_id: scId };
      return als.run(ctx, async () => {
        // Simulate some async work before DB access
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

        const alsCtx = als.getStore()!;
        expect(alsCtx.market_id).toBe(marketId);

        await db.transaction(async (trx) => {
          await trx.raw(
            `SET LOCAL ${GP_MARKET_VAR} = '${alsCtx.market_id}'`
          );
          // Simulate some async work within transaction
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

          const result = await trx.raw(
            `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
          );
          results.push({
            market: marketId,
            seen: result.rows[0].market_id,
          });
        });
      });
    };

    // Run 2 markets in parallel
    await Promise.all([
      runMarketRequest("bonbeauty", "sc_bb"),
      runMarketRequest("bonevent", "sc_be"),
    ]);

    // Each market should have seen only its own market_id
    expect(results).toHaveLength(2);
    const bbResult = results.find((r) => r.market === "bonbeauty");
    const beResult = results.find((r) => r.market === "bonevent");
    expect(bbResult!.seen).toBe("bonbeauty");
    expect(beResult!.seen).toBe("bonevent");
  });

  it("concurrent ALS contexts — stress test with 10 parallel requests", async () => {
    const markets = [
      "market_1", "market_2", "market_3", "market_4", "market_5",
      "market_6", "market_7", "market_8", "market_9", "market_10",
    ];
    const results: { market: string; seen: string }[] = [];

    await Promise.all(
      markets.map((marketId) =>
        als.run({ market_id: marketId, sc_id: `sc_${marketId}` }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          const alsCtx = als.getStore()!;

          await db.transaction(async (trx) => {
            await trx.raw(
              `SET LOCAL ${GP_MARKET_VAR} = '${alsCtx.market_id}'`
            );
            await new Promise((r) => setTimeout(r, Math.random() * 20));
            const result = await trx.raw(
              `SELECT current_setting('${GP_MARKET_VAR}', true) as market_id`
            );
            results.push({
              market: marketId,
              seen: result.rows[0].market_id,
            });
          });
        })
      )
    );

    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.seen).toBe(r.market); // Each sees only its own
    }
  });
});

// ---------------------------------------------------------------------------
// Guard middleware simulation (AC-2)
// ---------------------------------------------------------------------------
describe("Guard middleware: store request without market context → 403", () => {
  it("simulated guard blocks request when ALS has no market context", () => {
    const als = new AsyncLocalStorage<{ market_id: string }>();

    // Simulate guard middleware logic
    const guardMiddleware = (): { status: number; body?: string } => {
      const ctx = als.getStore();
      if (!ctx) {
        return { status: 403, body: "Market context required" };
      }
      return { status: 200 };
    };

    // Without ALS context — guard blocks
    const blocked = guardMiddleware();
    expect(blocked.status).toBe(403);
    expect(blocked.body).toBe("Market context required");

    // With ALS context — guard passes
    const passed = als.run({ market_id: "bonbeauty" }, () => guardMiddleware());
    expect(passed.status).toBe(200);
  });
});
