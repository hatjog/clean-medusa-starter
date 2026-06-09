import { describe, expect, it, jest } from "@jest/globals";

import { GP_MARKET_SESSION_VAR } from "../../../lib/rls-pool-hook";
import GpCoreService, { MarketContextRequiredError } from "../service";

jest.mock("pg", () => {
  const mockPool = jest.fn(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn(),
  }));
  return { Pool: mockPool };
});

describe("GpCoreService — gp_core market transaction context", () => {
  it("sets gp_core market context transaction-locally before work", async () => {
    const service = new GpCoreService({}, {});
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn(() => Promise.resolve(client)),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).corePool_ = pool;

    await expect(
      service.withMarketContext("3f7a2ca6-b1be-41e8-bddd-9f0d00e7d5b1", async () => "ok")
    ).resolves.toBe("ok");

    expect(queries.map((q) => q.sql)).toEqual([
      "BEGIN",
      `SELECT set_config('${GP_MARKET_SESSION_VAR}', $1, true)`,
      "COMMIT",
    ]);
    expect(queries[1]?.params).toEqual(["3f7a2ca6-b1be-41e8-bddd-9f0d00e7d5b1"]);
    expect(client.release).toHaveBeenCalled();
  });

  it("lets withTransaction set the same request-scoped market context when explicitly provided", async () => {
    const service = new GpCoreService({}, {});
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn(() => Promise.resolve(client)),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).corePool_ = pool;

    await service.withTransaction(async () => undefined, "3f7a2ca6-b1be-41e8-bddd-9f0d00e7d5b1");

    expect(queries.map((q) => q.sql)).toEqual([
      "BEGIN",
      `SELECT set_config('${GP_MARKET_SESSION_VAR}', $1, true)`,
      "COMMIT",
    ]);
  });

  it("fails closed before opening a transaction when marketId is missing", async () => {
    const service = new GpCoreService({}, {});
    const pool = {
      connect: jest.fn(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).corePool_ = pool;

    await expect(service.withMarketContext(null, async () => "unreachable")).rejects.toMatchObject({
      name: "MarketContextRequiredError",
      code: "MARKET_CONTEXT_REQUIRED",
      message: "MARKET_CONTEXT_REQUIRED",
    });
    await expect(service.withMarketContext("", async () => "unreachable")).rejects.toThrow(
      MarketContextRequiredError
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
