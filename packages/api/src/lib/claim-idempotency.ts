/**
 * claim-idempotency — Sub-bundle 6b (cleanup-6 CRIT-6.2)
 *
 * HMAC-bind idempotency key to `(code, recipient_session, claimed_at)` on
 * first POST. Subsequent POSTs with the same Idempotency-Key header but a
 * different (code, session, timestamp) binding MUST be rejected with 409.
 *
 * Design:
 *   1. On first POST: compute HMAC(`${code}|${session}|${claimedAt}`, secret)
 *      and store it as `idem:claim:binding:<key>`.
 *   2. On replay POST (key already exists): recompute HMAC and compare with
 *      stored binding using timingSafeEqual. Mismatch → 409 Conflict.
 *   3. `Math.random` MUST NOT be used as an idempotency key source anywhere
 *      in the claim path. If `crypto.randomUUID` is unavailable, fail closed
 *      (throw; never fall back to Math.random).
 *
 * ADR-NOTE: The HMAC secret MUST be provided via environment variable
 * `CLAIM_IDEM_HMAC_SECRET` (min 32 chars). Missing secret → fail closed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Fail-closed UUID generation (replaces Math.random fallback in SW)
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random UUID for idempotency keys.
 *
 * Fails closed: if `crypto.randomUUID` is unavailable (e.g. non-secure
 * context in a service worker), throws an error rather than falling back to
 * `Math.random`.
 *
 * ADR-NOTE: `Math.random` MUST NEVER be used for idempotency keys — it is
 * not cryptographically random and enables replay attacks.
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node.js path (server-side)
  try {
    const { randomUUID } = require("node:crypto") as { randomUUID: () => string };
    return randomUUID();
  } catch {
    throw new Error(
      "[claim-idempotency] crypto.randomUUID unavailable — fail closed. " +
      "Cannot generate idempotency key without a CSPRNG. " +
      "NEVER fall back to Math.random for security-sensitive keys."
    );
  }
}

// ---------------------------------------------------------------------------
// HMAC binding
// ---------------------------------------------------------------------------

export interface ClaimBindingPayload {
  code: string;
  recipient_session: string;
  claimed_at: string;
}

/**
 * Compute HMAC binding for `(code, recipient_session, claimed_at)`.
 *
 * The binding is stored server-side on first POST and verified on replays.
 */
export function computeClaimBinding(
  payload: ClaimBindingPayload,
  secret: string
): string {
  const data = `${payload.code}|${payload.recipient_session}|${payload.claimed_at}`;
  return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Verify that a stored binding matches the expected payload.
 *
 * Uses constant-time comparison to prevent timing attacks on the HMAC value.
 * Returns `true` if the binding matches, `false` otherwise.
 */
export function verifyClaimBinding(
  payload: ClaimBindingPayload,
  storedBinding: string,
  secret: string
): boolean {
  const expected = computeClaimBinding(payload, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const storedBuf = Buffer.from(storedBinding, "hex");
  if (expectedBuf.length !== storedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, storedBuf);
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function claimBindingStorageKey(idempotencyKey: string): string {
  return `idem:claim:binding:${idempotencyKey}`;
}

// ---------------------------------------------------------------------------
// In-memory binding store (for tests; production uses Redis)
// ---------------------------------------------------------------------------

export class InMemoryClaimBindingStore {
  private readonly store = new Map<string, string>();

  /** Store a binding. Returns false if key already exists. */
  setIfAbsent(key: string, binding: string): boolean {
    if (this.store.has(key)) return false;
    this.store.set(key, binding);
    return true;
  }

  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  reset(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Result types for claim idempotency check
// ---------------------------------------------------------------------------

export type ClaimIdempotencyResult =
  | { outcome: "first_post"; binding: string }
  | { outcome: "replay_ok" }
  | { outcome: "replay_mismatch" };

/**
 * Process an incoming idempotency check for a claim POST.
 *
 * On first POST: stores the HMAC binding and returns `{ outcome: 'first_post' }`.
 * On replay with matching binding: returns `{ outcome: 'replay_ok' }`.
 * On replay with mismatched binding: returns `{ outcome: 'replay_mismatch' }`.
 *   Callers MUST reject with HTTP 409.
 */
export function processClaimIdempotency(
  idempotencyKey: string,
  payload: ClaimBindingPayload,
  secret: string,
  store: InMemoryClaimBindingStore
): ClaimIdempotencyResult {
  const storageKey = claimBindingStorageKey(idempotencyKey);
  const existingBinding = store.get(storageKey);

  if (!existingBinding) {
    const binding = computeClaimBinding(payload, secret);
    store.setIfAbsent(storageKey, binding);
    return { outcome: "first_post", binding };
  }

  const matches = verifyClaimBinding(payload, existingBinding, secret);
  if (matches) {
    return { outcome: "replay_ok" };
  }
  return { outcome: "replay_mismatch" };
}
