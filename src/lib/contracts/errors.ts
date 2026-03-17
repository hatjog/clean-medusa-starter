/**
 * GP Error Code Contract (DD-20)
 *
 * Canonical TypeScript location for the error code enum and related types.
 * See: specs/contracts/errors/error-codes.md for full specification.
 *
 * SemVer policy:
 *   - New code = MINOR bump
 *   - Change meaning/category of existing code = MAJOR bump
 *   - Remove code = MAJOR bump
 */

/** All error codes defined in v1.0.0 of the GP error contract. */
export const ErrorCode = {
  // Terminal — non-recoverable
  VOUCHER_NOT_FOUND: "VOUCHER_NOT_FOUND",
  VOUCHER_EXPIRED: "VOUCHER_EXPIRED",
  VOUCHER_VOIDED: "VOUCHER_VOIDED",
  VOUCHER_REFUNDED: "VOUCHER_REFUNDED",
  VOUCHER_FULLY_REDEEMED: "VOUCHER_FULLY_REDEEMED",
  CLAIM_ALREADY_USED: "CLAIM_ALREADY_USED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  /** Public masking code (SA-7) — replaces specific terminal codes on public endpoints. */
  VOUCHER_INVALID: "VOUCHER_INVALID",

  // Transient — retryable
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  CONFLICT: "CONFLICT",
  BALANCE_CHANGED: "BALANCE_CHANGED",

  // Rate limited
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type ErrorCategory = "terminal" | "transient" | "rate_limited";

export interface ApiError {
  code: ErrorCode;
  category: ErrorCategory;
  message?: string;
  details?: Record<string, unknown>;
}

/** Maps each ErrorCode to its category. */
export const ERROR_CATEGORIES: Record<ErrorCode, ErrorCategory> = {
  [ErrorCode.VOUCHER_NOT_FOUND]: "terminal",
  [ErrorCode.VOUCHER_EXPIRED]: "terminal",
  [ErrorCode.VOUCHER_VOIDED]: "terminal",
  [ErrorCode.VOUCHER_REFUNDED]: "terminal",
  [ErrorCode.VOUCHER_FULLY_REDEEMED]: "terminal",
  [ErrorCode.CLAIM_ALREADY_USED]: "terminal",
  [ErrorCode.INSUFFICIENT_BALANCE]: "terminal",
  [ErrorCode.INVALID_AMOUNT]: "terminal",
  [ErrorCode.VOUCHER_INVALID]: "terminal",
  [ErrorCode.SERVICE_UNAVAILABLE]: "transient",
  [ErrorCode.TIMEOUT]: "transient",
  [ErrorCode.CONFLICT]: "transient",
  [ErrorCode.BALANCE_CHANGED]: "transient",
  [ErrorCode.RATE_LIMITED]: "rate_limited",
};

/**
 * Codes that get masked to VOUCHER_INVALID on public endpoints (SA-7).
 * Vendor auth endpoints return full codes.
 */
const PUBLIC_MASKED_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.VOUCHER_NOT_FOUND,
  ErrorCode.VOUCHER_EXPIRED,
  ErrorCode.VOUCHER_VOIDED,
  ErrorCode.VOUCHER_REFUNDED,
]);

/**
 * Returns the public-safe error code per SA-7 masking rules.
 * Specific terminal codes are replaced with VOUCHER_INVALID on public endpoints.
 */
export function maskForPublicEndpoint(code: ErrorCode): ErrorCode {
  return PUBLIC_MASKED_CODES.has(code) ? ErrorCode.VOUCHER_INVALID : code;
}
