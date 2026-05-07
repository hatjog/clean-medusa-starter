/**
 * voucher-delivery/storage/hmac.ts — Shared HMAC token signing/verification
 * for the voucher PDF storage layer (cleanup-52 / TF-117).
 *
 * Both FilesystemVoucherPdfStorage and PgVoucherPdfStorage import this so the
 * signing format and secret resolution remain in lockstep (review fix M2).
 *
 * Secret resolution (review fix H1): VOUCHER_PDF_HMAC_SECRET if set;
 * otherwise an ephemeral process-scoped value (Date.now()-seeded sha256).
 * A console.warn is emitted exactly once per process when the env var is
 * missing so misconfigured prod environments are loud.
 *
 * Production KMS-backed signing deferred to v1.10.0.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

let _hmacSecret: string | undefined;
let _warnedMissingSecret = false;

/** Maximum upper bound on a token's TTL (review fix I1). */
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

function resolveHmacSecret(): string {
  const fromEnv = process.env["VOUCHER_PDF_HMAC_SECRET"];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (!_warnedMissingSecret) {
    _warnedMissingSecret = true;
    // Loud, one-shot. Test harness can suppress via NODE_ENV=test if desired.
    // eslint-disable-next-line no-console
    console.warn(
      "[voucher-pdf-storage] VOUCHER_PDF_HMAC_SECRET is not set; using " +
        "ephemeral process-scoped secret. All issued tokens will be invalidated " +
        "on process restart. Set the env var for production-grade signing.",
    );
  }
  return createHash("sha256")
    .update(`dev-ephemeral-${Date.now()}-${process.pid}`)
    .digest("hex");
}

export function getHmacSecret(): string {
  if (!_hmacSecret) {
    _hmacSecret = resolveHmacSecret();
  }
  return _hmacSecret;
}

/** Build a signed token for a (storage_key, expires_at_ms) tuple. */
export function buildSignedToken(
  storage_key: string,
  expires_at: number,
  secret: string,
): string {
  const payload = `${storage_key}|${expires_at}`;
  const sig = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const encodedKey = Buffer.from(storage_key).toString("base64url");
  return `${encodedKey}.${expires_at}.${sig}`;
}

/**
 * Verify a signed token. Returns the decoded {storage_key, expires_at} on
 * success, or null on any failure (malformed, expired, far-future, bad sig).
 *
 * Far-future bound (review fix I1): rejects tokens with expires_at beyond
 * Date.now() + MAX_TTL_MS so a leaked-once-then-forged token cannot live
 * longer than the legitimate TTL window.
 */
export function verifySignedToken(
  token: string,
  secret: string,
): { storage_key: string; expires_at: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedKey, expiresStr, sig] = parts as [string, string, string];
  const expires_at = parseInt(expiresStr, 10);
  if (!Number.isFinite(expires_at) || expires_at <= 0) return null;
  const now = Date.now();
  if (now > expires_at) return null;
  if (expires_at - now > MAX_TTL_MS) return null;
  const storage_key = Buffer.from(encodedKey, "base64url").toString("utf-8");
  const payload = `${storage_key}|${expires_at}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  return { storage_key, expires_at };
}
