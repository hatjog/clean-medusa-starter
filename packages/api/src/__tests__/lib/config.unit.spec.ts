/**
 * Unit tests for Zod-validated env config (IP-9).
 * Story 1.7 — centralized config, fail-fast at startup.
 */

import { z } from "zod";

// We re-define the schema here to test it in isolation,
// because importing config.ts triggers immediate validation (fail-fast).
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GP_CORE_DATABASE_URL: z.string().min(1),
  MEDUSA_BACKEND_URL: z.string().url().default("http://localhost:9002"),
  STORE_CORS: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MEDUSA_ADMIN_APIKEY: z.string().min(1),
});

const VALID_ENV = {
  DATABASE_URL: "postgres://localhost:5432/medusa",
  GP_CORE_DATABASE_URL: "postgres://localhost:5432/gp_core",
  MEDUSA_BACKEND_URL: "http://localhost:9002",
  STORE_CORS: "http://localhost:8000",
  REDIS_URL: "redis://localhost:6379",
  MEDUSA_ADMIN_APIKEY: "sk-test-key-123",
};

describe("env config schema", () => {
  it("accepts valid complete config", () => {
    const result = envSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
      expect(result.data.GP_CORE_DATABASE_URL).toBe(
        VALID_ENV.GP_CORE_DATABASE_URL,
      );
    }
  });

  it("applies default for MEDUSA_BACKEND_URL", () => {
    const { MEDUSA_BACKEND_URL: _, ...envWithoutBackendUrl } = VALID_ENV;
    const result = envSchema.safeParse(envWithoutBackendUrl);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MEDUSA_BACKEND_URL).toBe("http://localhost:9002");
    }
  });

  it("rejects missing DATABASE_URL", () => {
    const { DATABASE_URL: _, ...partial } = VALID_ENV;
    const result = envSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("rejects missing GP_CORE_DATABASE_URL", () => {
    const { GP_CORE_DATABASE_URL: _, ...partial } = VALID_ENV;
    const result = envSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("rejects missing STORE_CORS", () => {
    const { STORE_CORS: _, ...partial } = VALID_ENV;
    const result = envSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("rejects missing REDIS_URL", () => {
    const { REDIS_URL: _, ...partial } = VALID_ENV;
    const result = envSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("rejects missing MEDUSA_ADMIN_APIKEY", () => {
    const { MEDUSA_ADMIN_APIKEY: _, ...partial } = VALID_ENV;
    const result = envSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });
});
