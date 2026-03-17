/**
 * Unit tests for ErrorCode enum, public masking, and apiError/apiSuccess helpers.
 * Story 1.7 — DD-20 error code contract + IP-3 response helpers.
 */

import {
  ErrorCode,
  ERROR_CATEGORIES,
  maskForPublicEndpoint,
} from "../../lib/contracts/errors";
import type { ErrorCategory } from "../../lib/contracts/errors";
import { apiError, apiSuccess } from "../../lib/api/response";

// ---------- ErrorCode enum ----------

describe("ErrorCode enum", () => {
  it("has exactly 14 error codes", () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toHaveLength(14);
  });

  it("has 9 terminal codes", () => {
    const terminal = Object.entries(ERROR_CATEGORIES).filter(
      ([, cat]) => cat === "terminal",
    );
    expect(terminal).toHaveLength(9);
  });

  it("has 4 transient codes", () => {
    const transient = Object.entries(ERROR_CATEGORIES).filter(
      ([, cat]) => cat === "transient",
    );
    expect(transient).toHaveLength(4);
  });

  it("has 1 rate_limited code", () => {
    const rateLimited = Object.entries(ERROR_CATEGORIES).filter(
      ([, cat]) => cat === "rate_limited",
    );
    expect(rateLimited).toHaveLength(1);
  });

  it("every ErrorCode has a category in ERROR_CATEGORIES", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_CATEGORIES[code]).toBeDefined();
    }
  });

  it("category values are valid", () => {
    const validCategories: ErrorCategory[] = [
      "terminal",
      "transient",
      "rate_limited",
    ];
    for (const cat of Object.values(ERROR_CATEGORIES)) {
      expect(validCategories).toContain(cat);
    }
  });
});

// ---------- Public endpoint masking (SA-7) ----------

describe("maskForPublicEndpoint (SA-7)", () => {
  const maskedCodes: ErrorCode[] = [
    ErrorCode.VOUCHER_NOT_FOUND,
    ErrorCode.VOUCHER_EXPIRED,
    ErrorCode.VOUCHER_VOIDED,
    ErrorCode.VOUCHER_REFUNDED,
  ];

  it.each(maskedCodes)("masks %s to VOUCHER_INVALID", (code) => {
    expect(maskForPublicEndpoint(code)).toBe(ErrorCode.VOUCHER_INVALID);
  });

  const unmaskedCodes: ErrorCode[] = [
    ErrorCode.VOUCHER_FULLY_REDEEMED,
    ErrorCode.CLAIM_ALREADY_USED,
    ErrorCode.INSUFFICIENT_BALANCE,
    ErrorCode.INVALID_AMOUNT,
    ErrorCode.SERVICE_UNAVAILABLE,
    ErrorCode.TIMEOUT,
    ErrorCode.CONFLICT,
    ErrorCode.BALANCE_CHANGED,
    ErrorCode.RATE_LIMITED,
    ErrorCode.VOUCHER_INVALID,
  ];

  it.each(unmaskedCodes)("does NOT mask %s", (code) => {
    expect(maskForPublicEndpoint(code)).toBe(code);
  });
});

// ---------- apiError / apiSuccess helpers (IP-3) ----------

function createMockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("apiError", () => {
  it("returns DD-20 error shape with code and category", () => {
    const res = createMockRes();
    apiError(res, ErrorCode.VOUCHER_NOT_FOUND, 404);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "VOUCHER_NOT_FOUND",
        category: "terminal",
      },
    });
  });

  it("includes optional message", () => {
    const res = createMockRes();
    apiError(res, ErrorCode.VOUCHER_NOT_FOUND, 404, {
      message: "Entitlement not found",
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Entitlement not found" }),
      }),
    );
  });

  it("includes optional details", () => {
    const res = createMockRes();
    apiError(res, ErrorCode.INSUFFICIENT_BALANCE, 422, {
      details: { remaining_minor: 5000 },
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          details: { remaining_minor: 5000 },
        }),
      }),
    );
  });

  it("omits message and details when not provided", () => {
    const res = createMockRes();
    apiError(res, ErrorCode.TIMEOUT, 504);
    const body = res.json.mock.calls[0][0];
    expect(body.error).not.toHaveProperty("message");
    expect(body.error).not.toHaveProperty("details");
  });

  it("resolves category for transient codes", () => {
    const res = createMockRes();
    apiError(res, ErrorCode.CONFLICT, 409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ category: "transient" }),
      }),
    );
  });

  it("resolves category for rate_limited", () => {
    const res = createMockRes();
    apiError(res, ErrorCode.RATE_LIMITED, 429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ category: "rate_limited" }),
      }),
    );
  });
});

describe("apiSuccess", () => {
  it("returns { data } shape with 200 by default", () => {
    const res = createMockRes();
    apiSuccess(res, { id: "abc" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: { id: "abc" } });
  });

  it("accepts custom HTTP status", () => {
    const res = createMockRes();
    apiSuccess(res, { created: true }, 201);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ data: { created: true } });
  });
});
