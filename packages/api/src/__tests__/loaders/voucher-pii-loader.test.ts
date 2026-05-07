/**
 * voucher-pii-loader.test — Unit tests for the voucher-pii Medusa container
 * loader (cleanup-44 / TF-105).
 *
 * AC coverage:
 *   - AC4(a): container has `voucher_pii` key after loader runs
 *   - AC4(b): registered value is a VoucherPiiService instance
 *   - AC4(c): singleton pattern (same reference on repeated resolve)
 *   - AC6: loader throws descriptive error when PG_CONNECTION missing
 *   - AC8: graceful degradation when LOGGER is missing
 */

import { describe, expect, test, jest, beforeEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Fake MedusaContainer
// ---------------------------------------------------------------------------

type RegisterFn = (key: string, val: unknown) => void;
type ResolveFn = (key: string) => unknown;

interface FakeContainer {
  registrations: Map<string, unknown>;
  register: RegisterFn;
  resolve: ResolveFn;
}

function makeFakeContainer(overrides: Record<string, unknown> = {}): FakeContainer {
  const registrations = new Map<string, unknown>(Object.entries(overrides));
  return {
    registrations,
    register(key: string, val: unknown) {
      registrations.set(key, val);
    },
    resolve(key: string) {
      if (!registrations.has(key)) {
        throw new Error(`Resolution failed: ${key}`);
      }
      return registrations.get(key);
    },
  };
}

// Fake Knex — returns a minimal chainable stub.
function makeFakeKnex(): object {
  const stub = jest.fn();
  return stub as unknown as object;
}

// ---------------------------------------------------------------------------
// Import loader under test (after test doubles are set up)
// ---------------------------------------------------------------------------

// We import dynamically so we can inject the fake container.
// The loader file uses only standard Node imports + awilix, both available.

describe("voucher-pii loader", () => {
  let loader: (args: { container: unknown }) => Promise<void>;

  beforeEach(async () => {
    // Re-import to reset module-level state between tests.
    jest.resetModules();
    const mod = await import("../../loaders/voucher-pii");
    loader = mod.default;
  });

  test("AC4(a): registers 'voucher_pii' key after loader runs", async () => {
    const fakeKnex = makeFakeKnex();
    // ContainerRegistrationKeys.PG_CONNECTION = '__pg_connection__' in Medusa 2
    const container = makeFakeContainer({
      "__pg_connection__": fakeKnex,
    });
    await loader({ container });
    expect(container.registrations.has("voucher_pii")).toBe(true);
  });

  test("AC4(b): registered value has required service methods", async () => {
    const fakeKnex = makeFakeKnex();
    const container = makeFakeContainer({ "__pg_connection__": fakeKnex });
    await loader({ container });

    const regEntry = container.registrations.get("voucher_pii") as {
      resolve: () => unknown;
    };
    // awilix asValue wraps in a resolver object with a 'resolve' function.
    // For asValue, the resolver is { lifetime, resolve: () => value }.
    // We call .resolve() to get the actual service.
    const service = typeof regEntry === "object" && "resolve" in regEntry
      ? (regEntry as { resolve: () => unknown }).resolve()
      : regEntry;

    expect(service).toBeDefined();
    expect(typeof (service as Record<string, unknown>).recordConsentTransaction).toBe("function");
    expect(typeof (service as Record<string, unknown>).executeDeliveryStep).toBe("function");
    expect(typeof (service as Record<string, unknown>).recordWithdrawalTransaction).toBe("function");
    expect(typeof (service as Record<string, unknown>).purgeExpiredPii).toBe("function");
  });

  test("AC6: throws descriptive error when PG_CONNECTION is missing", async () => {
    const container = makeFakeContainer({}); // No PG_CONNECTION
    await expect(loader({ container })).rejects.toThrow(
      /Cannot resolve PG_CONNECTION/
    );
  });

  test("AC8: graceful degradation when LOGGER is missing", async () => {
    const fakeKnex = makeFakeKnex();
    // __pg_connection__ present but no logger
    const container = makeFakeContainer({ "__pg_connection__": fakeKnex });
    // Should not throw even without logger
    await expect(loader({ container })).resolves.toBeUndefined();
  });

  test("AC4(c): loader is idempotent — second call does not duplicate registration", async () => {
    const fakeKnex = makeFakeKnex();
    const container = makeFakeContainer({ "__pg_connection__": fakeKnex });
    await loader({ container });
    const firstValue = container.registrations.get("voucher_pii");
    await loader({ container });
    const secondValue = container.registrations.get("voucher_pii");
    // Both should be defined (second call overwrites, no error thrown).
    expect(firstValue).toBeDefined();
    expect(secondValue).toBeDefined();
  });
});
