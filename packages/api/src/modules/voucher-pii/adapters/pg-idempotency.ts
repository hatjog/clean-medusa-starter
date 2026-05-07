/**
 * pg-idempotency — In-process IdempotencyPort adapter (cleanup-44 / TF-105).
 *
 * OQ #3 resolution: Opcja A — in-memory idempotency for v1.6.0 staging-free.
 * The InMemoryIdempotencyAdapter from lib/idempotency.ts is reused;
 * it is safe for single-process staging deployment.
 *
 * v1.7.0+: swap for RedisIdempotencyAdapter using a real Redis connection.
 *
 * This file provides a factory function to maintain the loader/adapter boundary.
 */

import { InMemoryIdempotencyAdapter } from "../../../lib/idempotency";
import type { IdempotencyPort } from "../ports";

let _singleton: InMemoryIdempotencyAdapter | null = null;

export function createInProcessIdempotencyPort(): IdempotencyPort {
  if (!_singleton) {
    _singleton = new InMemoryIdempotencyAdapter();
  }
  return _singleton;
}

/**
 * Reset singleton — for tests only.
 * @internal
 */
export function _resetIdempotencySingleton(): void {
  _singleton = null;
}
