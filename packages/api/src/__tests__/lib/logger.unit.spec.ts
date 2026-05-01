/**
 * Unit tests for structured JSON logger (DD-24, Story 1.9)
 */

import { logger } from "../../lib/logger";

let captured: string[] = [];
const originalWrite = process.stdout.write;

beforeEach(() => {
  captured = [];
  process.stdout.write = ((chunk: string) => {
    captured.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  delete process.env.GP_LOG_LEVEL;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  delete process.env.GP_LOG_LEVEL;
});

function lastEntry(): Record<string, unknown> {
  return JSON.parse(captured[captured.length - 1]);
}

describe("logger", () => {
  it("writes JSON to stdout with newline", () => {
    logger.info("test-action");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/\n$/);
  });

  it("includes required fields: ts, level, service, action", () => {
    logger.info("boot");
    const entry = lastEntry();
    expect(entry).toHaveProperty("ts");
    expect(entry.level).toBe("info");
    expect(entry.service).toBe("gp_core");
    expect(entry.action).toBe("boot");
  });

  it("ts is valid ISO8601", () => {
    logger.info("check-ts");
    const entry = lastEntry();
    expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
  });

  it("logger.debug writes level=debug", () => {
    process.env.GP_LOG_LEVEL = "debug";
    logger.debug("dbg");
    expect(lastEntry().level).toBe("debug");
  });

  it("logger.warn writes level=warn", () => {
    logger.warn("w");
    expect(lastEntry().level).toBe("warn");
  });

  it("logger.error writes level=error", () => {
    logger.error("e");
    expect(lastEntry().level).toBe("error");
  });

  it("merges context fields into log entry", () => {
    logger.info("order-placed", {
      correlation_id: "abc-123",
      market_id: "mkt-1",
      duration_ms: 42,
    });
    const entry = lastEntry();
    expect(entry.correlation_id).toBe("abc-123");
    expect(entry.market_id).toBe("mkt-1");
    expect(entry.duration_ms).toBe(42);
  });

  it("filters debug when default level is info", () => {
    // default GP_LOG_LEVEL is unset → info
    logger.debug("should-be-filtered");
    expect(captured).toHaveLength(0);
  });

  it("respects GP_LOG_LEVEL=error filter", () => {
    process.env.GP_LOG_LEVEL = "error";
    logger.info("filtered");
    logger.warn("filtered");
    logger.error("visible");
    expect(captured).toHaveLength(1);
    expect(lastEntry().level).toBe("error");
  });
});
