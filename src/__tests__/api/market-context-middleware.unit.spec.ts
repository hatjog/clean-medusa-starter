/**
 * Unit tests for Market Context + Guard middleware — Story 10-3, Task 5.3 (AC-5)
 */

const mockInstallRlsPoolHook = jest.fn();
const mockEnsureLoaded = jest.fn();
const mockGet = jest.fn();

jest.mock("@medusajs/framework/http", () => ({
  defineMiddlewares: (config: unknown) => config,
}));

jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    PG_CONNECTION: "__pg_connection__",
  },
}));

jest.mock("../../lib/rls-pool-hook", () => ({
  installRlsPoolHook: (...args: unknown[]) => mockInstallRlsPoolHook(...args),
}));

jest.mock("../../loaders/market-context-cache", () => ({
  marketContextCache: {
    ensureLoaded: (...args: unknown[]) => mockEnsureLoaded(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

import {
  marketContextMiddleware,
  marketGuardMiddleware,
} from "../../api/middlewares";
import { marketContextStorage } from "../../lib/market-context";

describe("Market Context Middleware", () => {
  beforeEach(() => {
    mockInstallRlsPoolHook.mockReset();
    mockEnsureLoaded.mockReset();
    mockEnsureLoaded.mockResolvedValue(undefined);
    mockGet.mockReset();
  });

  it("sets ALS from publishable key", async () => {
    mockGet.mockReturnValue("bonbeauty");

    const pgConnection = { client: {} };
    const req = {
      publishable_key_context: { key: "pk_123", sales_channel_ids: ["sc_bb"] },
      scope: {
        resolve: jest.fn().mockReturnValue(pgConnection),
      },
    } as any;

    await marketContextMiddleware(req, {} as any, () => {
      const ctx = marketContextStorage.getStore();
      expect(ctx).toEqual({ market_id: "bonbeauty", sales_channel_id: "sc_bb" });
    });

    expect(mockInstallRlsPoolHook).toHaveBeenCalledWith(pgConnection);
    expect(mockEnsureLoaded).toHaveBeenCalledWith(req.scope);
    expect(mockGet).toHaveBeenCalledWith("sc_bb");
  });

  it("skips bootstrap work for requests without publishable key", async () => {
    const next = jest.fn();
    const req = {
      scope: {
        resolve: jest.fn(),
      },
    } as any;

    await marketContextMiddleware(req, {} as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.scope.resolve).not.toHaveBeenCalled();
    expect(mockInstallRlsPoolHook).not.toHaveBeenCalled();
    expect(mockEnsureLoaded).not.toHaveBeenCalled();
  });

  it("skips ALS when cache has no mapping for sales channel", async () => {
    mockGet.mockReturnValue(null);

    const next = jest.fn(() => {
      expect(marketContextStorage.getStore()).toBeUndefined();
    });
    const req = {
      publishable_key_context: { key: "pk_unknown", sales_channel_ids: ["sc_unknown"] },
      scope: {
        resolve: jest.fn().mockReturnValue({ client: {} }),
      },
    } as any;

    await marketContextMiddleware(req, {} as any, next);

    expect(next).toHaveBeenCalled();
  });
});

describe("Market Guard Middleware", () => {
  it("blocks store request without ALS → 403", async () => {
    const res = {
      statusCode: 0,
      body: null as any,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.body = data;
      },
    };
    const next = jest.fn();

    await marketGuardMiddleware({} as any, res as any, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Market context required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes store request with ALS context", async () => {
    const next = jest.fn();
    const res = { status: jest.fn(), json: jest.fn() };

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await marketGuardMiddleware({} as any, res as any, next);
      }
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
