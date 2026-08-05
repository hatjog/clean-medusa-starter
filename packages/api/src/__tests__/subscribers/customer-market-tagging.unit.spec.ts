jest.mock("@medusajs/framework/utils", () => ({
  Modules: {
    CUSTOMER: "customer",
  },
  ContainerRegistrationKeys: {
    LOGGER: "logger",
  },
}));

import customerMarketTaggingHandler, {
  config,
} from "../../subscribers/customer-market-tagging";
import { marketContextStorage } from "../../lib/market-context";

describe("customer market tagging subscriber", () => {
  it("sets metadata.gp.market_id on customer.created when ALS is available", async () => {
    // Mock STANOWY: kontrola widoczności po zapisie odczytuje wiersz ponownie,
    // więc atrapa musi odzwierciedlać skutek zapisu (review-fix HIGH-1).
    let stored: unknown = null;
    const retrieveCustomer = jest
      .fn()
      .mockImplementation(async () => ({ metadata: stored }));
    const updateCustomers = jest.fn().mockImplementation(async (_id, data) => {
      stored = data.metadata;
      return undefined;
    });
    const container = {
      resolve: jest.fn().mockReturnValue({ retrieveCustomer, updateCustomers }),
    };

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerMarketTaggingHandler({
          event: { data: { id: "cus_123" } },
          container,
        } as any);
      }
    );

    expect(updateCustomers).toHaveBeenCalledWith("cus_123", {
      metadata: { gp: { market_id: "bonbeauty" } },
    });
  });

  it("falls back to scoped email prefix when ALS is not available", async () => {
    let stored: unknown = null;
    const retrieveCustomer = jest.fn().mockImplementation(async () => ({
      email: "bonbeauty::user@test.local",
      metadata: stored,
    }));
    const updateCustomers = jest.fn().mockImplementation(async (_id, data) => {
      stored = data.metadata;
      return undefined;
    });
    const container = {
      resolve: jest.fn().mockReturnValue({ retrieveCustomer, updateCustomers }),
    };

    await customerMarketTaggingHandler({
      event: { data: { id: "cus_123" } },
      container,
    } as any);

    expect(updateCustomers).toHaveBeenCalledWith("cus_123", {
      metadata: { gp: { market_id: "bonbeauty" } },
    });
  });

  it("skips when no ALS and customer has no scoped email (admin-created)", async () => {
    const retrieveCustomer = jest.fn().mockResolvedValue({
      email: "admin@test.local",
      metadata: null,
    });
    const updateCustomers = jest.fn();
    const container = {
      resolve: jest.fn().mockReturnValue({ retrieveCustomer, updateCustomers }),
    };

    await customerMarketTaggingHandler({
      event: { data: { id: "cus_123" } },
      container,
    } as any);

    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it("skips update when no ALS but metadata already set by create middleware", async () => {
    const retrieveCustomer = jest.fn().mockResolvedValue({
      email: "bonbeauty::user@test.local",
      metadata: { gp: { market_id: "bonbeauty" } },
    });
    const updateCustomers = jest.fn();
    const container = {
      resolve: jest.fn().mockReturnValue({ retrieveCustomer, updateCustomers }),
    };

    await customerMarketTaggingHandler({
      event: { data: { id: "cus_123" } },
      container,
    } as any);

    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it("registers to customer.created", () => {
    expect(config).toEqual({ event: "customer.created" });
  });
});
/**
 * review-fix HIGH-1 — zapis USTANAWIAJĄCY rynek nie może iść pod RLS.
 *
 * Polityka `market_isolation` ukrywa wiersz bez `metadata.gp.market_id` przed
 * rolą `medusa_store`, więc `UPDATE` w kontekście rynku trafia w ZERO wierszy
 * (zmierzone: `GP/backend/scripts/story-2-1-customer-rls-probe.sql`). Te testy
 * pękają, gdy ktoś przeniesie zapis z powrotem do środka kontekstu albo usunie
 * kontrolę widoczności.
 */
describe("customer market tagging — granica kontekstu (HIGH-1)", () => {
  function makeContainer(overrides: Record<string, unknown> = {}) {
    const seen: { onUpdate?: unknown; onRetrieveVerify?: unknown } = {};
    const logger = { warn: jest.fn(), error: jest.fn() };
    const customer = {
      email: "bonbeauty::user@test.local",
      metadata: null as unknown,
    };
    const retrieveCustomer = jest.fn().mockImplementation(async () => {
      if (customer.metadata) {
        seen.onRetrieveVerify = marketContextStorage.getStore();
        return { ...customer, metadata: customer.metadata };
      }
      return { ...customer };
    });
    const updateCustomers = jest.fn().mockImplementation(async (_id, data) => {
      seen.onUpdate = marketContextStorage.getStore();
      customer.metadata = data.metadata;
      return undefined;
    });
    const service = { retrieveCustomer, updateCustomers, ...overrides };
    const container = {
      resolve: jest.fn().mockImplementation((key: string) =>
        key === "logger" ? logger : service
      ),
    };
    return { container, seen, logger, retrieveCustomer, updateCustomers };
  }

  it("zapis ustanawiający leci POZA kontekstem, a kontrola widoczności W kontekście", async () => {
    const { container, seen } = makeContainer();

    await customerMarketTaggingHandler({
      event: { data: { id: "cus_123" } },
      container,
    } as any);

    expect(seen.onUpdate).toBeUndefined();
    expect(seen.onRetrieveVerify).toMatchObject({
      market_id: "bonbeauty",
      system: { surface: "subscriber", name: "customer-market-tagging" },
    });
  });

  it("wiersz niewidoczny po zapisie = GŁOŚNY błąd, nie `warn` i sukces", async () => {
    const { container, logger } = makeContainer();
    const service = container.resolve("customer") as {
      retrieveCustomer: jest.Mock;
    };
    let call = 0;
    service.retrieveCustomer.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { email: "bonbeauty::user@test.local", metadata: null };
      }
      const error: Error & { type?: string } = new Error("Customer not found");
      error.type = "not_found";
      throw error;
    });

    await expect(
      customerMarketTaggingHandler({
        event: { data: { id: "cus_123" } },
        container,
      } as any)
    ).rejects.toMatchObject({ error_code: "GP_CUSTOMER_MARKET_TAGGING_FAILED" });

    expect(logger.error).toHaveBeenCalled();
  });

  it("kontrola NIEWYKONALNA (brak RLS w instancji) jest nazwana, nie przemilczana", async () => {
    const { container, logger } = makeContainer();
    const service = container.resolve("customer") as {
      retrieveCustomer: jest.Mock;
    };
    let call = 0;
    service.retrieveCustomer.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { email: "bonbeauty::user@test.local", metadata: null };
      }
      throw new Error('role "medusa_store" does not exist');
    });

    await customerMarketTaggingHandler({
      event: { data: { id: "cus_123" } },
      container,
    } as any);

    expect(logger.warn).toHaveBeenCalledWith(
      "customerMarketTaggingHandler: kontrola widoczności NIEWYKONANA",
      expect.objectContaining({ customer_id: "cus_123", market_id: "bonbeauty" })
    );
  });
});

/**
 * weryfikacja B5 / correctness 1.3 — cisza NIE została usunięta, tylko
 * przeniesiona na gałąź z ALS.
 *
 * Wszystkie testy z bloku HIGH-1 wchodzą wyłącznie w gałąź BEZ ALS. Gałąź
 * z ALS miała pierwszy `retrieveCustomer` W KONTEKŚCIE, więc przy propagującym
 * się ALS polityka `market_isolation` (klauzula `USING` obowiązuje także dla
 * `SELECT`) ukrywała nieotagowany wiersz: `not_found` -> ogólny `catch` ->
 * `logger.warn` -> handler kończył się „sukcesem", ZERO zapisu.
 *
 * Atrapa niżej odwzorowuje politykę: rzuca `not_found`, gdy odczyt leci
 * W kontekście, i zwraca wiersz, gdy leci poza nim. Przeniesienie odczytu
 * ustalającego z powrotem do kontekstu czerwieni oba testy.
 */
describe("customer market tagging — gałąź ALS pod RLS (weryfikacja B5)", () => {
  function makeRlsAwareContainer() {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const stored: { metadata: unknown } = { metadata: null };
    const retrieveCustomer = jest.fn().mockImplementation(async () => {
      const ctx = marketContextStorage.getStore();
      if (ctx && !stored.metadata) {
        // Wiersz bez `metadata.gp.market_id` jest w kontekście NIEWIDOCZNY.
        const error: Error & { type?: string } = new Error("Customer not found");
        error.type = "not_found";
        throw error;
      }
      return { email: "bonbeauty::user@test.local", metadata: stored.metadata };
    });
    const updateCustomers = jest.fn().mockImplementation(async (_id, data) => {
      stored.metadata = data.metadata;
      return undefined;
    });
    const service = { retrieveCustomer, updateCustomers };
    const container = {
      resolve: jest.fn().mockImplementation((key: string) =>
        key === "logger" ? logger : service
      ),
    };
    return { container, logger, retrieveCustomer, updateCustomers };
  }

  it("tagowanie DZIAŁA, gdy ALS propaguje się na szynę zdarzeń", async () => {
    const { container, logger, updateCustomers } = makeRlsAwareContainer();

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await customerMarketTaggingHandler({
          event: { data: { id: "cus_123" } },
          container,
        } as any);
      }
    );

    expect(updateCustomers).toHaveBeenCalledWith("cus_123", {
      metadata: { gp: { market_id: "bonbeauty" } },
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      "customerMarketTaggingHandler failed",
      expect.anything()
    );
  });

  it("niewidoczny klient na ścieżce tagowania = błąd z `error`, nie `warn` i sukces", async () => {
    const { container, logger, updateCustomers } = makeRlsAwareContainer();
    const service = container.resolve("customer") as {
      retrieveCustomer: jest.Mock;
    };
    // Wiersz niewidoczny NIEZALEŻNIE od kontekstu (np. skasowany między
    // zdarzeniem a obsługą): handler nie ma prawa zameldować sukcesu.
    service.retrieveCustomer.mockImplementation(async () => {
      const error: Error & { type?: string } = new Error("Customer not found");
      error.type = "not_found";
      throw error;
    });

    await expect(
      marketContextStorage.run(
        { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
        async () =>
          customerMarketTaggingHandler({
            event: { data: { id: "cus_123" } },
            container,
          } as any)
      )
    ).rejects.toMatchObject({ error_code: "GP_CUSTOMER_MARKET_TAGGING_FAILED" });

    expect(logger.error).toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });
});
