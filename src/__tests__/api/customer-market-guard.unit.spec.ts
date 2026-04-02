const mockInstallRlsPoolHook = jest.fn();
const mockEnsureLoaded = jest.fn();
const mockGet = jest.fn();

jest.mock("@medusajs/framework/http", () => ({
  defineMiddlewares: (config: unknown) => config,
  authenticate: () => jest.fn(),
}));

jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    LOGGER: "logger",
    PG_CONNECTION: "__pg_connection__",
    QUERY: "query",
  },
  Modules: {
    AUTH: "auth",
    CUSTOMER: "customer",
    NOTIFICATION: "notification",
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
  cartMarketGuardMiddleware,
  customerMarketGuardMiddleware,
  customerRegistrationMarketGuardMiddleware,
  customerResponseSanitizerMiddleware,
  customerScopedAuthMiddleware,
  customerScopedCustomerCreateMiddleware,
} from "../../api/middlewares";
import { scopeCustomerEmail } from "../../lib/customer-scoped-email";
import { marketContextStorage } from "../../lib/market-context";

function createResponse() {
  return {
    body: null as any,
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("customer isolation middlewares", () => {
  beforeEach(() => {
    mockInstallRlsPoolHook.mockReset();
    mockEnsureLoaded.mockReset();
    mockEnsureLoaded.mockResolvedValue(undefined);
    mockGet.mockReset();
    mockGet.mockReturnValue("bonbeauty");
  });

  it("prefixes customer auth email per market on auth routes", async () => {
    const next = jest.fn();
    const req = {
      body: { email: "User@Test.local" },
      publishable_key_context: { sales_channel_ids: ["sc_bb"] },
      scope: {
        resolve: jest.fn().mockReturnValue({}),
      },
    } as any;

    await customerScopedAuthMiddleware(req, createResponse() as any, next);

    expect(req.body.email).toBe(scopeCustomerEmail("User@Test.local", "bonbeauty"));
    expect(next).toHaveBeenCalled();
  });

  it("prefixes store customer create body and injects metadata.gp.market_id", async () => {
    const next = jest.fn();
    const req = {
      body: { email: "user@test.local" },
      validatedBody: { email: "user@test.local" },
      scope: {
        resolve: jest.fn(),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerScopedCustomerCreateMiddleware(
          req,
          createResponse() as any,
          next
        );
      }
    );

    expect(req.validatedBody.email).toBe("bonbeauty::user@test.local");
    expect(req.validatedBody.metadata).toEqual({ gp: { market_id: "bonbeauty" } });
    expect(next).toHaveBeenCalled();
  });

  it("allows store customer creation when registration token belongs to the same market", async () => {
    const next = jest.fn();
    const req = {
      auth_context: { auth_identity_id: "auth_123" },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "auth") {
            return {
              retrieveAuthIdentity: jest.fn().mockResolvedValue({
                provider_identities: [
                  {
                    provider: "emailpass",
                    entity_id: scopeCustomerEmail("user@test.local", "bonbeauty"),
                  },
                ],
              }),
            };
          }

          return {};
        }),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerRegistrationMarketGuardMiddleware(
          req,
          createResponse() as any,
          next
        );
      }
    );

    expect(next).toHaveBeenCalled();
  });

  it("blocks store customer creation when registration token belongs to another market", async () => {
    const res = createResponse();
    const req = {
      auth_context: { auth_identity_id: "auth_123" },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "auth") {
            return {
              retrieveAuthIdentity: jest.fn().mockResolvedValue({
                provider_identities: [
                  {
                    provider: "emailpass",
                    entity_id: scopeCustomerEmail("user@test.local", "bonevent"),
                  },
                ],
              }),
            };
          }

          return {};
        }),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerRegistrationMarketGuardMiddleware(
          req,
          res as any,
          jest.fn()
        );
      }
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Customer not found in this market" });
  });

  it("allows authenticated customer requests in the same market", async () => {
    const next = jest.fn();
    const req = {
      auth_context: { actor_id: "cus_123" },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "customer") {
            return {
              retrieveCustomer: jest.fn().mockResolvedValue({
                metadata: { gp: { market_id: "bonbeauty" } },
              }),
            };
          }

          if (key === "logger") {
            return { warn: jest.fn() };
          }

          return {};
        }),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerMarketGuardMiddleware(req, createResponse() as any, next);
      }
    );

    expect(next).toHaveBeenCalled();
  });

  it("blocks authenticated customer requests in another market", async () => {
    const res = createResponse();
    const req = {
      auth_context: { actor_id: "cus_123" },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "customer") {
            return {
              retrieveCustomer: jest.fn().mockResolvedValue({
                metadata: { gp: { market_id: "bonevent" } },
              }),
            };
          }

          if (key === "logger") {
            return { warn: jest.fn() };
          }

          return {};
        }),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerMarketGuardMiddleware(req, res as any, jest.fn());
      }
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Customer not found in this market" });
  });

  it("allows unauthenticated guest store requests", async () => {
    const next = jest.fn();

    await customerMarketGuardMiddleware(
      { scope: { resolve: jest.fn() } } as any,
      createResponse() as any,
      next
    );

    expect(next).toHaveBeenCalled();
  });

  it("allows legacy customers without metadata and logs a warning", async () => {
    const warn = jest.fn();
    const next = jest.fn();
    const req = {
      auth_context: { actor_id: "cus_legacy" },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "customer") {
            return {
              retrieveCustomer: jest.fn().mockResolvedValue({
                email: "legacy@test.local",
                metadata: null,
              }),
            };
          }

          if (key === "logger") {
            return { warn };
          }

          return {};
        }),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerMarketGuardMiddleware(req, createResponse() as any, next);
      }
    );

    expect(warn).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("allows cart access when cart belongs to the active sales channel", async () => {
    const next = jest.fn();
    const db = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue({
              id: "cart_123",
              sales_channel_id: "sc_bb",
            }),
          }),
        }),
      }),
    });
    const req = {
      path: "/store/carts/cart_123",
      scope: {
        resolve: jest.fn().mockReturnValue(db),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await cartMarketGuardMiddleware(req, createResponse() as any, next);
      }
    );

    expect(next).toHaveBeenCalled();
  });

  it("blocks cart access when cart belongs to another sales channel", async () => {
    const res = createResponse();
    const db = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue({
              id: "cart_123",
              sales_channel_id: "sc_evt",
            }),
          }),
        }),
      }),
    });
    const req = {
      path: "/store/carts/cart_123",
      scope: {
        resolve: jest.fn().mockReturnValue(db),
      },
    } as any;

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await cartMarketGuardMiddleware(req, res as any, jest.fn());
      }
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: "Cart not found" });
  });

  it("strips scoped customer email prefixes from customer responses", async () => {
    const next = jest.fn();
    const originalJson = jest.fn((payload: unknown) => payload);
    const res = {
      json: originalJson,
    };

    await customerResponseSanitizerMiddleware({} as any, res as any, next);
    res.json({
      customer: { email: scopeCustomerEmail("user@test.local", "bonbeauty") },
    });

    expect(originalJson).toHaveBeenCalledWith({
      customer: { email: "user@test.local" },
    });
    expect(next).toHaveBeenCalled();
  });
});