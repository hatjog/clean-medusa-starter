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
    LOGGER: "logger",
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
  const originalRlsDebug = process.env.GP_RLS_DEBUG;

  beforeEach(() => {
    mockInstallRlsPoolHook.mockReset();
    mockEnsureLoaded.mockReset();
    mockEnsureLoaded.mockResolvedValue(undefined);
    mockGet.mockReset();
    delete process.env.GP_RLS_DEBUG;
  });

  afterAll(() => {
    if (originalRlsDebug === undefined) {
      delete process.env.GP_RLS_DEBUG;
      return;
    }

    process.env.GP_RLS_DEBUG = originalRlsDebug;
  });

  it("sets ALS from publishable key", async () => {
    mockGet.mockReturnValue("bonbeauty");

    const pgConnection = { client: {} };
    const logger = { info: jest.fn() };
    const req = {
      publishable_key_context: { key: "pk_123", sales_channel_ids: ["sc_bb"] },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "__pg_connection__") return pgConnection;
          if (key === "logger") return logger;
          return undefined;
        }),
      },
    } as any;

    await marketContextMiddleware(req, {} as any, () => {
      const ctx = marketContextStorage.getStore();
      expect(ctx).toEqual({ market_id: "bonbeauty", sales_channel_id: "sc_bb" });
    });

    expect(mockInstallRlsPoolHook).toHaveBeenCalledWith(pgConnection, logger);
    expect(mockEnsureLoaded).toHaveBeenCalledWith(req.scope);
    expect(mockGet).toHaveBeenCalledWith("sc_bb");
  });

  it("emits RLS debug log when context is resolved and GP_RLS_DEBUG=1", async () => {
    process.env.GP_RLS_DEBUG = "1";
    mockGet.mockReturnValue("bonbeauty");

    const logger = { info: jest.fn() };
    const req = {
      path: "/store/products",
      publishable_key_context: { key: "pk_123", sales_channel_ids: ["sc_bb"] },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "__pg_connection__") return { client: {} };
          if (key === "logger") return logger;
          return undefined;
        }),
      },
    } as any;

    await marketContextMiddleware(req, {} as any, jest.fn());

    expect(logger.info).toHaveBeenCalledWith(
      "[rls-debug] market-context-resolved",
      expect.objectContaining({
        path: "/store/products",
        market_id: "bonbeauty",
        sales_channel_id: "sc_bb",
      })
    );
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
    process.env.GP_RLS_DEBUG = "1";
    const logger = { info: jest.fn() };
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

    await marketGuardMiddleware(
      {
        path: "/store/products",
        scope: {
          resolve: jest.fn((key: string) => {
            if (key === "logger") return logger;
            return undefined;
          }),
        },
      } as any,
      res as any,
      next
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Market context required" });
    expect(next).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "[rls-debug] market-guard-blocked",
      expect.objectContaining({ path: "/store/products" })
    );
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
