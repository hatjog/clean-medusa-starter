const mockGetSellerIdByHandleForSalesChannel = jest.fn();
const mockGetStore = jest.fn();

jest.mock("@medusajs/framework/http", () => ({
  defineMiddlewares: (config: unknown) => config,
}));

jest.mock("@medusajs/framework/utils", () => {
  class MedusaError extends Error {
    type: string;
    constructor(type: string, message: string) {
      super(message);
      this.type = type;
    }
  }
  (MedusaError as unknown as Record<string, unknown>).Types = {
    NOT_FOUND: "NOT_FOUND",
  };
  return {
    ContainerRegistrationKeys: {
      PG_CONNECTION: "__pg_connection__",
      QUERY: "query",
    },
    MedusaError,
  };
});

jest.mock("../../../lib/market-context", () => ({
  marketContextStorage: {
    getStore: (...args: unknown[]) => mockGetStore(...args),
  },
}));

jest.mock("../../../lib/seller-market-scope", () => ({
  getSellerIdByHandleForSalesChannel: (...args: unknown[]) =>
    mockGetSellerIdByHandleForSalesChannel(...args),
}));

import { GET } from "../../../api/store/seller/[handle]/route";

function createResponse() {
  return {
    body: null as unknown,
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

function createRequest(
  handle: string,
  queryResolve: (key: string) => unknown
) {
  return {
    params: { handle },
    scope: {
      resolve: jest.fn((key: string) => queryResolve(key)),
    },
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /store/seller/[handle] — enriched profile", () => {
  beforeEach(() => {
    mockGetStore.mockReset();
    mockGetSellerIdByHandleForSalesChannel.mockReset();
  });

  it("3.2: returns all enriched fields when full metadata is present", async () => {
    mockGetStore.mockReturnValue({ sales_channel_id: "sc_bb" });
    mockGetSellerIdByHandleForSalesChannel.mockResolvedValue("seller_123");

    const fullSeller = {
      id: "seller_123",
      name: "Test Salon",
      handle: "test-salon",
      description: "A great salon",
      photo: "https://cdn.example.com/photo.jpg",
      metadata: {
        gp: {
          social_links: {
            instagram: "https://instagram.com/testsalon",
            facebook: null,
            website: "https://testsalon.pl",
            tiktok: null,
          },
          locations: [
            {
              city: "Warsaw",
              country_code: "PL",
              address: "ul. Testowa 1",
              postal_code: "00-001",
            },
          ],
          gallery: [
            { url: "https://cdn.example.com/g1.jpg", alt: "Gallery 1", is_primary: true },
            { url: "https://cdn.example.com/g2.jpg" },
          ],
          opening_hours: {
            monday: "09:00-18:00",
            tuesday: "09:00-18:00",
            sunday: null,
          },
        },
      },
    };

    const mockQuery = {
      graph: jest.fn().mockResolvedValue({ data: [fullSeller] }),
    };

    const req = createRequest("test-salon", (key: string) => {
      if (key === "__pg_connection__") return jest.fn();
      if (key === "query") return mockQuery;
      return undefined;
    });
    const res = createResponse();

    await GET(req, res as unknown as Parameters<typeof GET>[1]);

    const body = res.body as { seller: Record<string, unknown> };
    expect(body.seller.id).toBe("seller_123");
    expect(body.seller.name).toBe("Test Salon");
    expect(body.seller.handle).toBe("test-salon");
    expect(body.seller.description).toBe("A great salon");
    expect(body.seller.photo).toBe("https://cdn.example.com/photo.jpg");
    expect(body.seller.social_links).toEqual({
      instagram: "https://instagram.com/testsalon",
      facebook: null,
      website: "https://testsalon.pl",
      tiktok: null,
    });
    expect(body.seller.locations).toHaveLength(1);
    expect((body.seller.locations as unknown[])[0]).toMatchObject({ city: "Warsaw", country_code: "PL" });
    expect(body.seller.gallery).toHaveLength(2);
    expect((body.seller.gallery as unknown[])[0]).toMatchObject({ url: "https://cdn.example.com/g1.jpg", is_primary: true });
    expect(body.seller.opening_hours).toEqual({
      monday: "09:00-18:00",
      tuesday: "09:00-18:00",
      sunday: null,
    });
  });

  it("3.3: returns safe defaults when metadata is absent", async () => {
    mockGetStore.mockReturnValue({ sales_channel_id: "sc_bb" });
    mockGetSellerIdByHandleForSalesChannel.mockResolvedValue("seller_456");

    const spareSeller = {
      id: "seller_456",
      name: "Bare Seller",
      handle: "bare-seller",
      description: null,
      photo: null,
      metadata: null,
    };

    const mockQuery = {
      graph: jest.fn().mockResolvedValue({ data: [spareSeller] }),
    };

    const req = createRequest("bare-seller", (key: string) => {
      if (key === "__pg_connection__") return jest.fn();
      if (key === "query") return mockQuery;
      return undefined;
    });
    const res = createResponse();

    await GET(req, res as unknown as Parameters<typeof GET>[1]);

    const body = res.body as { seller: Record<string, unknown> };
    expect(body.seller.id).toBe("seller_456");
    expect(body.seller.description).toBeNull();
    expect(body.seller.photo).toBeNull();
    expect(body.seller.social_links).toBeNull();
    expect(body.seller.locations).toEqual([]);
    expect(body.seller.gallery).toEqual([]);
    expect(body.seller.opening_hours).toBeNull();
  });

  it("3.3b: returns safe defaults when metadata.gp is partially populated", async () => {
    mockGetStore.mockReturnValue({ sales_channel_id: "sc_bb" });
    mockGetSellerIdByHandleForSalesChannel.mockResolvedValue("seller_789");

    const partialSeller = {
      id: "seller_789",
      name: "Partial",
      handle: "partial",
      description: undefined,
      photo: undefined,
      metadata: { gp: { social_links: { instagram: "https://insta.com/partial" } } },
    };

    const mockQuery = {
      graph: jest.fn().mockResolvedValue({ data: [partialSeller] }),
    };

    const req = createRequest("partial", (key: string) => {
      if (key === "__pg_connection__") return jest.fn();
      if (key === "query") return mockQuery;
      return undefined;
    });
    const res = createResponse();

    await GET(req, res as unknown as Parameters<typeof GET>[1]);

    const body = res.body as { seller: Record<string, unknown> };
    expect(body.seller.social_links).toEqual({ instagram: "https://insta.com/partial" });
    expect(body.seller.locations).toEqual([]);
    expect(body.seller.gallery).toEqual([]);
    expect(body.seller.opening_hours).toBeNull();
  });

  it("3.4: throws NOT_FOUND when salesChannelId is missing", async () => {
    mockGetStore.mockReturnValue(null);

    const req = createRequest("any-handle", () => jest.fn());
    const res = createResponse();

    await expect(
      GET(req, res as unknown as Parameters<typeof GET>[1])
    ).rejects.toMatchObject({ type: "NOT_FOUND" });

    expect(mockGetSellerIdByHandleForSalesChannel).not.toHaveBeenCalled();
  });

  it("3.5: throws NOT_FOUND when handle not found in sales channel scope", async () => {
    mockGetStore.mockReturnValue({ sales_channel_id: "sc_bb" });
    mockGetSellerIdByHandleForSalesChannel.mockResolvedValue(null);

    const mockQuery = { graph: jest.fn() };

    const req = createRequest("nonexistent", (key: string) => {
      if (key === "__pg_connection__") return jest.fn();
      if (key === "query") return mockQuery;
      return undefined;
    });
    const res = createResponse();

    await expect(
      GET(req, res as unknown as Parameters<typeof GET>[1])
    ).rejects.toMatchObject({ type: "NOT_FOUND" });

    expect(mockQuery.graph).not.toHaveBeenCalled();
  });
});
