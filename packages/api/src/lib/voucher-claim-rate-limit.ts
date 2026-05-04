/**
 * voucher-claim-rate-limit — Story v160-cleanup-15c.
 *
 * In-process token-bucket rate limiter for `POST /store/vouchers/:code/claim`.
 * Keyed by IP address. Not shared across worker processes — Redis upgrade
 * deferred to v1.7.0 (per story scope note).
 *
 * Settings (per AC6 + story spec):
 *   - Bucket size: 10 tokens (burst ceiling)
 *   - Sustained refill: 5 tokens/minute
 *
 * After 10 requests within a rolling window the 11th returns
 * `{ allowed: false, retryAfterSec }` and the caller MUST respond 429.
 */

interface BucketState {
  tokens: number
  lastRefillAt: number
}

const BUCKET_SIZE = 10
const REFILL_PER_MIN = 5

const _buckets = new Map<string, BucketState>()

/** Exposed for test injection */
let _clock: () => number = Date.now

/** Test helper — override the clock source. */
export function _setClock(fn: () => number): void {
  _clock = fn
}

/** Test helper — reset all bucket state. */
export function _resetBuckets(): void {
  _buckets.clear()
}

/**
 * Consume one token from the bucket identified by `ip`.
 *
 * Returns `{ allowed: true }` if the request is permitted,
 * or `{ allowed: false, retryAfterSec: number }` if rate-limited.
 */
export function consumeClaimToken(ip: string): {
  allowed: boolean
  retryAfterSec: number
} {
  const now = _clock()
  const existing = _buckets.get(ip)
  let tokens = existing?.tokens ?? BUCKET_SIZE
  let lastRefillAt = existing?.lastRefillAt ?? now

  const elapsedMs = now - lastRefillAt
  const refillAmount = (elapsedMs / 60_000) * REFILL_PER_MIN
  tokens = Math.min(BUCKET_SIZE, tokens + refillAmount)
  lastRefillAt = now

  if (tokens >= 1) {
    tokens -= 1
    _buckets.set(ip, { tokens, lastRefillAt })
    return { allowed: true, retryAfterSec: 0 }
  }

  const needed = 1 - tokens
  const retryAfterMs = Math.ceil((needed / REFILL_PER_MIN) * 60_000)
  const retryAfterSec = Math.ceil(retryAfterMs / 1_000)
  _buckets.set(ip, { tokens, lastRefillAt })
  return { allowed: false, retryAfterSec }
}
