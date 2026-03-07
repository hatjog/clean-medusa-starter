jest.mock("@medusajs/framework/utils", () => ({
  Modules: {
    CUSTOMER: "customer",
  },
}));

import customerMarketTaggingHandler, {
  config,
} from "../../subscribers/customer-market-tagging";
import { marketContextStorage } from "../../lib/market-context";

describe("customer market tagging subscriber", () => {
  it("sets metadata.gp.market_id on customer.created when ALS is available", async () => {
    const retrieveCustomer = jest.fn().mockResolvedValue({ metadata: null });
    const updateCustomers = jest.fn().mockResolvedValue(undefined);
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
    const retrieveCustomer = jest.fn().mockResolvedValue({
      email: "bonbeauty::user@test.local",
      metadata: null,
    });
    const updateCustomers = jest.fn().mockResolvedValue(undefined);
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