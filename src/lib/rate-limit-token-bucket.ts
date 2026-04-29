/**
 * rate-limit-token-bucket — STORY-2-2 Redis token-bucket rate limiter.
 *
 * Per D-72 + scope #10. Implements the token-bucket algorithm against a Redis
 * client via a Lua script for atomicity. Bucket state stored as Redis hash
 * `{tokens, last_refill_at}`; refill is lazy (computed at consume time, not
 * via background timer).
 *
 * Risk #4 mitigation: clock-skew tolerance via Redis TIME command (NIE app
 * clock). Lua script uses `redis.call('TIME')` — server-side authoritative.
 *
 * Bucket keys (per story scope):
 *   - `rl:voucher:dispatch:{market_id}:{recipient_id}` — 10/min default
 *   - `rl:voucher:dispatch:{market_id}:{provider_id}`  — 100/min default
 *
 * v1.5.0 ships the JS shape + a stub in-memory implementation suitable for
 * unit tests. The Lua script is included as a string export so the live Redis
 * adapter can run it via the Redis EVAL primitive once cached. Production
 * adapter wiring happens at loader-time when the Redis client is available.
 */

import type { RateLimitPort } from "../modules/voucher-pii/ports";

/**
 * Lua script — atomic token-bucket consume.
 *
 * KEYS[1] — bucket key (e.g. `rl:voucher:dispatch:{market}:{recipient}`).
 * ARGV[1] — bucket_size (max tokens).
 * ARGV[2] — refill_per_min (rate).
 *
 * Returns: { allowed (1|0), retry_after_ms }.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local bucket_size = tonumber(ARGV[1])
local refill_per_min = tonumber(ARGV[2])

local time = redis.call('TIME')
local now_ms = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local hash = redis.call('HMGET', key, 'tokens', 'last_refill_at')
local tokens = tonumber(hash[1])
local last_refill_at = tonumber(hash[2])

if tokens == nil then
  tokens = bucket_size
  last_refill_at = now_ms
end

-- Lazy refill — proportional to elapsed time since last refill.
local elapsed_ms = now_ms - last_refill_at
local refill_amount = (elapsed_ms / 60000) * refill_per_min
tokens = math.min(bucket_size, tokens + refill_amount)
last_refill_at = now_ms

local allowed = 0
local retry_after_ms = 0

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  local needed = 1 - tokens
  retry_after_ms = math.ceil((needed * 60000) / refill_per_min)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill_at', last_refill_at)
redis.call('EXPIRE', key, 600)

return {allowed, retry_after_ms}
` as const;

/**
 * Minimal Redis client surface used by the adapter — invokes the Lua script
 * via the standard Redis script-execution primitive (one round-trip, atomic).
 */
export interface RedisScriptRunner {
  runLuaScript(
    script: string,
    numKeys: number,
    ...args: string[]
  ): Promise<[number, number]>;
}

export class RedisTokenBucketAdapter implements RateLimitPort {
  constructor(private readonly redis: RedisScriptRunner) {}

  async consume(args: {
    bucket_key: string;
    bucket_size: number;
    refill_per_min: number;
  }): Promise<{ allowed: boolean; retry_after_ms: number }> {
    const [allowed, retry_after_ms] = await this.redis.runLuaScript(
      TOKEN_BUCKET_LUA,
      1,
      args.bucket_key,
      String(args.bucket_size),
      String(args.refill_per_min)
    );
    return { allowed: allowed === 1, retry_after_ms };
  }
}

/**
 * In-memory adapter — for unit tests + dev environments without Redis.
 * NOT safe for multi-process production use (no cross-instance atomicity).
 */
export class InMemoryTokenBucketAdapter implements RateLimitPort {
  private readonly state = new Map<
    string,
    { tokens: number; last_refill_at: number }
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(args: {
    bucket_key: string;
    bucket_size: number;
    refill_per_min: number;
  }): Promise<{ allowed: boolean; retry_after_ms: number }> {
    const now = this.now();
    const existing = this.state.get(args.bucket_key);
    let tokens = existing?.tokens ?? args.bucket_size;
    let last_refill_at = existing?.last_refill_at ?? now;

    const elapsed_ms = now - last_refill_at;
    const refill_amount = (elapsed_ms / 60000) * args.refill_per_min;
    tokens = Math.min(args.bucket_size, tokens + refill_amount);
    last_refill_at = now;

    if (tokens >= 1) {
      tokens -= 1;
      this.state.set(args.bucket_key, { tokens, last_refill_at });
      return { allowed: true, retry_after_ms: 0 };
    }

    const needed = 1 - tokens;
    const retry_after_ms = Math.ceil((needed * 60000) / args.refill_per_min);
    this.state.set(args.bucket_key, { tokens, last_refill_at });
    return { allowed: false, retry_after_ms };
  }

  /** Test helper — reset bucket state. */
  reset(): void {
    this.state.clear();
  }
}
