/**
 * Unit tests for MarketContextCache — Story 10-3, Task 5.1 (AC-5)
 *
 * Tests: loadFromDb, get hit, get miss, invalidation, TTL refresh.
 */

const mockRaw = jest.fn();
const mockResolve = jest.fn();
const mockInstallRlsPoolHook = jest.fn();

jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    PG_CONNECTION: "__pg_connection__",
    LOGGER: "logger",
  },
}));

jest.mock("../../lib/rls-pool-hook", () => ({
  installRlsPoolHook: (...args: unknown[]) => mockInstallRlsPoolHook(...args),
}));

function createMockContainer() {
  mockResolve.mockImplementation((key: string) => {
    if (key === "__pg_connection__") return { raw: mockRaw };
    if (key === "logger") return { error: jest.fn() };
    return undefined;
  });
  return { resolve: mockResolve } as any;
}

beforeEach(() => {
  jest.resetModules();
  mockRaw.mockReset();
  mockResolve.mockReset();
  mockInstallRlsPoolHook.mockReset();
});

describe("MarketContextCache", () => {
  it("loadFromDb populates map from sales_channel metadata", async () => {
    mockRaw.mockResolvedValue({
      rows: [
        { id: "sc_001", market_id: "bonbeauty" },
        { id: "sc_002", market_id: "bonevent" },
      ],
    });

    const { marketContextCache } = require("../../loaders/market-context-cache");

    await marketContextCache.init(createMockContainer());

    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockRaw).toHaveBeenCalledWith(
      expect.stringContaining("gp_market_id")
    );
    expect(marketContextCache.get("sc_001")).toBe("bonbeauty");
    expect(marketContextCache.get("sc_002")).toBe("bonevent");
    expect(marketContextCache.isLoaded()).toBe(true);

    marketContextCache.destroy();
  });

  it("get returns correct market_id for known SC (cache hit)", async () => {
    mockRaw.mockResolvedValue({
      rows: [{ id: "sc_abc", market_id: "bonbeauty" }],
    });

    const { marketContextCache } = require("../../loaders/market-context-cache");
    await marketContextCache.init(createMockContainer());

    expect(marketContextCache.get("sc_abc")).toBe("bonbeauty");

    marketContextCache.destroy();
  });

  it("get returns null for unknown SC (cache miss)", async () => {
    mockRaw.mockResolvedValue({
      rows: [{ id: "sc_abc", market_id: "bonbeauty" }],
    });

    const { marketContextCache } = require("../../loaders/market-context-cache");
    await marketContextCache.init(createMockContainer());

    expect(marketContextCache.get("sc_unknown")).toBeNull();

    marketContextCache.destroy();
  });

  it("invalidation clears cache and triggers reload", async () => {
    mockRaw
      .mockResolvedValueOnce({
        rows: [{ id: "sc_001", market_id: "bonbeauty" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "sc_001", market_id: "bonbeauty" },
          { id: "sc_002", market_id: "bonevent" },
        ],
      });

    const { marketContextCache } = require("../../loaders/market-context-cache");
    await marketContextCache.init(createMockContainer());

    expect(marketContextCache.get("sc_002")).toBeNull();

    marketContextCache.invalidate();

    // Flush the async reload triggered by invalidate()
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRaw).toHaveBeenCalledTimes(2);
    expect(marketContextCache.get("sc_002")).toBe("bonevent");

    marketContextCache.destroy();
  });

  it("TTL triggers periodic reload", async () => {
    jest.useFakeTimers();

    mockRaw.mockResolvedValue({
      rows: [{ id: "sc_001", market_id: "bonbeauty" }],
    });

    const { marketContextCache } = require("../../loaders/market-context-cache");
    await marketContextCache.init(createMockContainer());

    expect(mockRaw).toHaveBeenCalledTimes(1);

    // Advance timer by TTL (60s) and flush async
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockRaw).toHaveBeenCalledTimes(2);

    marketContextCache.destroy();
    jest.useRealTimers();
  });

  it("retries startup load after initial failure", async () => {
    mockRaw
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce({
        rows: [{ id: "sc_001", market_id: "bonbeauty" }],
      });

    const { marketContextCache } = require("../../loaders/market-context-cache");
    const container = createMockContainer();

    await expect(marketContextCache.ensureLoaded(container)).rejects.toThrow(
      "db unavailable"
    );
    await expect(marketContextCache.ensureLoaded(container)).resolves.toBeUndefined();

    expect(marketContextCache.get("sc_001")).toBe("bonbeauty");

    marketContextCache.destroy();
  });

  it("invalidate resets the refresh loop before reloading", async () => {
    jest.useFakeTimers();

    mockRaw.mockResolvedValue({
      rows: [{ id: "sc_001", market_id: "bonbeauty" }],
    });

    const { marketContextCache } = require("../../loaders/market-context-cache");
    await marketContextCache.init(createMockContainer());
    expect(mockRaw).toHaveBeenCalledTimes(1);

    marketContextCache.invalidate();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRaw).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockRaw).toHaveBeenCalledTimes(3);

    marketContextCache.destroy();
    jest.useRealTimers();
  });

  it("startup loader primes cache and installs the RLS pool hook", async () => {
    mockRaw.mockResolvedValue({
      rows: [{ id: "sc_001", market_id: "bonbeauty" }],
    });

    const {
      default: marketContextCacheLoader,
      marketContextCache,
    } = require("../../loaders/market-context-cache");
    const container = createMockContainer();

    await marketContextCacheLoader({ container });

    expect(mockInstallRlsPoolHook).toHaveBeenCalledWith({ raw: mockRaw });
    expect(marketContextCache.get("sc_001")).toBe("bonbeauty");

    marketContextCache.destroy();
  });
});
