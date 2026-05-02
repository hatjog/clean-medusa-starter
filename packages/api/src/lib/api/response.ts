/**
 * API response helpers (IP-3)
 *
 * All gp_core endpoints MUST use these helpers instead of raw res.json().
 * Error responses follow the DD-20 contract shape.
 *
 * Usage:
 *   return apiError(res, ErrorCode.VOUCHER_NOT_FOUND, 404);
 *   return apiSuccess(res, { entitlement });
 */

import type { MedusaResponse } from "@medusajs/framework/http";

import {
  type ApiError,
  type ErrorCategory,
  type ErrorCode,
  ERROR_CATEGORIES,
} from "../contracts/errors";

interface ApiErrorOptions {
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Send a JSON error response conforming to DD-20.
 *
 * Shape: { error: { code, category, message?, details? } }
 */
export function apiError(
  res: MedusaResponse,
  code: ErrorCode,
  httpStatus: number,
  options: ApiErrorOptions = {},
): void {
  const category: ErrorCategory = ERROR_CATEGORIES[code];

  const error: ApiError = {
    code,
    category,
    ...(options.message !== undefined && { message: options.message }),
    ...(options.details !== undefined && { details: options.details }),
  };

  res.status(httpStatus).json({ error });
}

/**
 * Send a JSON success response.
 *
 * Shape: { data: T }
 */
export function apiSuccess<T>(
  res: MedusaResponse,
  data: T,
  httpStatus = 200,
): void {
  res.status(httpStatus).json({ data });
}
