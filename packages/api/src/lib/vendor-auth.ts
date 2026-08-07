/**
 * vendor-auth — the ONE authentication point for `/vendor/*` (DD-25).
 *
 * v1.15.0 Story 5.4 (FR-11 closure, D-5, AD-20, SM-6, ADR-194):
 *   - `withVendorAuth` (the per-route HOF) is DELETED. Authentication of
 *     `/vendor/*` now follows from the MIDDLEWARE MATCHER
 *     (`lib/vendor-auth-matcher.ts`, wired in `api/middlewares.ts`), so a NEW
 *     `/vendor/*` route is authenticated by default instead of being
 *     unauthenticated until someone remembers to wrap it.
 *   - Keeping BOTH would not be "belt and braces", it would be an outage: since
 *     Story 5.3 `resolveSellerFromRequest` CLAIMS the anti-replay key, so two
 *     entry points on one request means two claims of the same key ⇒
 *     `VENDOR_AUTH_REPLAY_DETECTED` on every LEGAL request. One point is not a
 *     stylistic preference here; it is the only correct number.
 *   - The shared `VENDOR_HMAC_SECRET` is gone from the codebase. Signing
 *     material is per seller (Story 5.2) and nothing falls back to a shared
 *     value — AD-20 forbids the fallback, it does not discourage it.
 *
 * Decision: Extend Mercur seller auth (token-based federation per ADR-034).
 * - Enforced mode (the only supported mode since cc-4 F-10): `x-vendor-signature`
 *   header — HMAC-SHA256 signed payload.
 * - Flow: verify signature -> seller_id -> resolveVendorId(seller_id) -> vendor_id -> inject
 * - Fallback: graceful HTTP 501 when resolveVendorId is stub (NotImplementedError)
 * - VENDOR_HMAC_ENFORCED=false: returns 503 (config error), never accepts
 *   `x-vendor-token` as a seller_id substitute.
 *
 * v1.6.0 HMAC design notes (story: cleanup-48) — SUPERSEDED, kept for provenance:
 *   - Single shared secret (one env var for every seller) — superseded by Story
 *     5.2 (per-seller resolution) and REMOVED FROM THE CODE by Story 5.4.
 *   - Replay protection via in-process LRU (size 10k) and the standing "v1.7.0
 *     follow-up: Redis-backed distributed nonce cache" — superseded by Story 5.3.
 *     That follow-up was deferred for four releases and is now CLOSED, on
 *     Postgres rather than Redis (see the v1.15.0 Story 5.3 note below).
 *   - VENDOR_HMAC_ENFORCED=false enables legacy x-vendor-token path — deleted in
 *     v1.9.0 (cc-4 F-10, below); the flag now fails closed.
 *
 * References:
 * - ADR-025: Term "vendor" used in gp_core; "seller" only in Mercur auth context
 * - ADR-034: Federated sessions; HMAC backend-to-backend for service-to-service
 * - DD-25: Vendor auth decision — extend Mercur seller auth
 * - cleanup-48: This story — full HMAC validation implementation (TF-111 P0)
 *
 * cc-4 finding F-10 (v1.9.0): legacy `x-vendor-token` branch DELETED.
 *   - The path previously accepted any string as `seller_id` with NO
 *     signature verification when `VENDOR_HMAC_ENFORCED=false`.
 *   - That allowed arbitrary vendor impersonation; the flag was marked
 *     for removal in v1.7.0 cleanup notes and is now overdue (v1.9.0+).
 *   - Setting `VENDOR_HMAC_ENFORCED=false` now FAILS CLOSED — the route
 *     returns a 503 telling operators the legacy path is gone.
 *   - (Story 5.4 note) `vendor-hmac-config.ts` used to ALSO throw on a missing
 *     shared secret, which made an unset env var an outage of `/vendor/*`
 *     even though the request path had stopped using that value. That coupling
 *     is gone: the module now resolves policy only.
 * v1.15.0 Story 5.2 (FR-11 resolver member, AD-20, ADR-182, ADR-156):
 *   - The request path does not verify against any shared secret.
 *     The secret is resolved PER SELLER by the backend crypto-core
 *     (`lib/vendor-secret/crypto-core.ts`) for the `seller_id` carried by the
 *     signature header. No fallback to the shared value exists — not even
 *     behind a flag (AD-20).
 *   - The dated dual-validity window opened here
 *     (`specs/contracts/security/vendor-secret-dual-window.v1.yaml`) is CLOSED
 *     by Story 5.4: the shared value is no longer read anywhere in production
 *     code, and the gate measures that independently of today's date.
 * v1.15.0 Story 5.3 (FR-11 replay-guard member, AD-20, AD-23, ADR-185):
 *   - The in-process `NonceLru` is GONE. The anti-replay barrier is ONE atomic
 *     statement against a shared table (`lib/vendor-replay-guard/`), so a replay
 *     aimed at a SECOND API instance is refused — the in-process map could not
 *     see it at all.
 *   - The anti-replay key is a function of PUBLIC MATERIAL ONLY: seller,
 *     timestamp, nonce and a server-side digest of the request body. Neither the
 *     secret nor `sig` enters it, so ROTATING A SELLER'S SECRET DOES NOT OPEN A
 *     REPLAY WINDOW.
 *   - TWO keys are claimed in ONE statement (ADR-185 D8): the AD-20 key (with the
 *     body digest) AND a narrower seller+ts+nonce key. The narrow one is what
 *     keeps the NONCE one-shot; without it, a captured header could be replayed
 *     with a different body forever inside `±drift`, because the 5.2 signature
 *     does not cover the body.
 *   - The validity window is enforced INSIDE the statement's predicate, so a
 *     stalled cleanup job cannot change the barrier's verdict. Cleanup is
 *     hygiene only (`purgeExpiredReplayGuardRows`).
 *   - Because the barrier is asynchronous, `resolveSellerFromRequest` is now
 *     `async` and the (single, since 5.4) entry point below awaits it.
 *
 * @module vendor-auth
 */
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { NotImplementedError } from "../modules/gp-core/service"
import {
  verifyVendorSignature,
  VENDOR_AUTH_SIGNATURE_MISSING,
  VENDOR_AUTH_SIGNATURE_INVALID,
  VENDOR_AUTH_TIMESTAMP_EXPIRED,
  VENDOR_AUTH_REPLAY_DETECTED,
  VENDOR_AUTH_SECRET_NOT_PROVISIONED,
} from "./vendor-hmac"
import { resolveVendorHmacConfig } from "./vendor-hmac-config"
import {
  getVendorSecretCryptoCore,
  VENDOR_AUTH_SECRET_STORE_UNAVAILABLE,
} from "./vendor-secret/crypto-core"
import {
  buildNonceScopeKey,
  buildReplayGuardKey,
  claimReplayGuardKey,
  computeBodyDigest,
  deriveReplayGuardWindowSec,
  type ReplayGuardDb,
} from "./vendor-replay-guard"

const VENDOR_SIGNATURE_HEADER = "x-vendor-signature"

/**
 * v1.15.0 Story 5.3 — the anti-replay barrier could not be consulted at all
 * (no `PG_CONNECTION` in the scope, or the statement itself failed).
 *
 * Deliberately FAIL-CLOSED with 503: an unavailable barrier that let requests
 * through would silently reinstate exactly the replay window this story closes,
 * and it would do so invisibly. Operator fault → 503, never "allow and log".
 */
export const VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE =
  "VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE" as const

function resolveReplayGuardDb(scope: MedusaRequest["scope"] | undefined): ReplayGuardDb | null {
  if (!scope) return null

  try {
    const db = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as ReplayGuardDb | null
    return db && typeof db.raw === "function" ? db : null
  } catch {
    return null
  }
}

export type VendorAuthContext = {
  vendor_id: string
  seller_id: string
}

type GpCoreServiceLike = {
  resolveVendorId: (mercurSellerId: string) => Promise<string>
}

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/**
 * A request that has already passed the `/vendor/*` matcher. `vendorAuth` is
 * optional in the TYPE (Express hands the handler a plain `MedusaRequest`) but
 * GUARANTEED at runtime for every non-exempt `/vendor/*` route: the gate either
 * populates it or ends the response before the handler is reached.
 */
export type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

function resolveLogger(scope: MedusaRequest["scope"] | undefined): LoggerLike {
  if (!scope) return console

  try {
    const logger = scope.resolve("logger") as LoggerLike | undefined
    return logger ?? console
  } catch {
    return console
  }
}

function resolveGpCore(scope: MedusaRequest["scope"] | undefined): GpCoreServiceLike | null {
  if (!scope) return null

  try {
    return scope.resolve("gp_core") as GpCoreServiceLike | null
  } catch {
    return null
  }
}

/**
 * Resolves the seller_id from a request, using HMAC verification or legacy fallback.
 *
 * Returns { ok: true, sellerId } or { ok: false, status, code, message }.
 */
async function resolveSellerFromRequest(
  req: MedusaRequest,
  logger: LoggerLike
): Promise<
  | { ok: true; sellerId: string }
  | { ok: false; status: 401 | 503; code: string; message: string }
> {
  let config: ReturnType<typeof resolveVendorHmacConfig>
  try {
    config = resolveVendorHmacConfig()
  } catch (err) {
    logger.error?.(`[vendor-auth] ${String(err)}`)
    return {
      ok: false,
      status: 503,
      code: "VENDOR_AUTH_CONFIG_ERROR",
      message: "Vendor authentication configuration error",
    }
  }

  // cc-4 F-10: `VENDOR_HMAC_ENFORCED=false` is no longer honoured. The
  // legacy `x-vendor-token` branch was deleted; the env var is left in
  // place so misconfigured environments get a readable 503 instead of
  // accepting unauthenticated seller_id impersonation.
  if (!config.enforced) {
    logger.error?.(
      "[vendor-auth] VENDOR_HMAC_ENFORCED=false is no longer supported (cc-4 F-10). " +
        "Remove the env var or set VENDOR_HMAC_ENFORCED=true; signing material is " +
        "per seller and comes from the secret store, not from the environment."
    )
    return {
      ok: false,
      status: 503,
      code: "VENDOR_AUTH_CONFIG_ERROR",
      message: "Vendor HMAC enforcement is required (legacy x-vendor-token path removed)",
    }
  }

  // --- Enforced HMAC mode ---
  const sigHeader = req.headers[VENDOR_SIGNATURE_HEADER]
  const sigValue = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader

  // review-fix L-3: an UNAUTHENTICATED caller must not be able to read the state
  // of the secret store. A request with no signature header at all is answered
  // with 401 BEFORE the crypto-core health check runs, so `503
  // VENDOR_AUTH_SECRET_STORE_UNAVAILABLE` is only ever visible to a caller that
  // at least presented a signature. AC3's 503-vs-401 distinguishability is
  // untouched: it concerns signed requests.
  if (!sigValue) {
    return {
      ok: false,
      status: 401,
      code: VENDOR_AUTH_SIGNATURE_MISSING,
      message: "Missing vendor signature header (x-vendor-signature)",
    }
  }

  // --- Per-vendor crypto-core (v1.15.0 Story 5.2 — AD-20, ADR-182, ADR-156 §4/§6a) ---
  // Decrypt health is checked HERE and is distinguishable from a per-vendor
  // resolve miss: a broken/absent age key or a failed decrypt is an operator
  // fault → 503 on `/vendor/*` only (the rest of the API is untouched, P6-5b).
  // "This seller has no secret" is an auth outcome → 401 below. The boot loader
  // (`loaders/vendor-secret-crypto-core.ts`) already ran this check at startup;
  // the call here is an idempotent read of the memoised verdict.
  const cryptoCore = getVendorSecretCryptoCore()
  if (!cryptoCore.ok) {
    logger.error?.(
      `[vendor-auth] ${VENDOR_AUTH_SECRET_STORE_UNAVAILABLE} reason=${cryptoCore.fault.reason}`
    )
    return {
      ok: false,
      status: 503,
      code: VENDOR_AUTH_SECRET_STORE_UNAVAILABLE,
      message: "Vendor secret store unavailable",
    }
  }

  // AD-20: the secret is resolved for the `sellerId` CARRIED BY THE HEADER.
  // There is no fallback branch and, since Story 5.4, no shared value to fall
  // back TO: `VendorHmacConfig` carries policy only (enforcement + drift), so a
  // fallback cannot be reintroduced by accident — there is nothing to reach for.
  // A seller without a per-vendor secret gets 401, never a shared-secret pass.
  const nowSec = Math.floor(Date.now() / 1000)
  const result = verifyVendorSignature(
    sigValue,
    (sellerId: string) => cryptoCore.core.resolveForSeller(sellerId),
    nowSec,
    config.driftSeconds
  )

  if (!result.ok) {
    const messages: Record<string, string> = {
      [VENDOR_AUTH_SIGNATURE_MISSING]: "Missing vendor signature header (x-vendor-signature)",
      [VENDOR_AUTH_SIGNATURE_INVALID]: "Invalid vendor signature",
      [VENDOR_AUTH_TIMESTAMP_EXPIRED]: "Vendor signature timestamp expired",
      [VENDOR_AUTH_REPLAY_DETECTED]: "Vendor signature replay detected",
    }

    // AC5 non-disclosure: "this seller has no secret" and "wrong signature" are
    // INDISTINGUISHABLE in the response body — otherwise the 401 becomes a
    // seller-enumeration oracle. The discriminator AC1 asks for lives in the
    // server-side log line below, not in the payload.
    if (result.code === VENDOR_AUTH_SECRET_NOT_PROVISIONED) {
      logger.warn?.(
        `[vendor-auth] ${VENDOR_AUTH_SECRET_NOT_PROVISIONED} — no per-vendor secret for the seller named in the signature header`
      )
      return {
        ok: false,
        status: 401,
        code: VENDOR_AUTH_SIGNATURE_INVALID,
        message: messages[VENDOR_AUTH_SIGNATURE_INVALID],
      }
    }

    return {
      ok: false,
      status: 401,
      code: result.code,
      message: messages[result.code] ?? "Vendor authentication failed",
    }
  }

  // --- Anti-replay barrier (v1.15.0 Story 5.3 — FR-11, AD-20, AD-23, ADR-185) ---
  //
  // ORDER IS LOAD-BEARING: we are past `result.ok === true`, so the signature is
  // already verified. Claiming the key any earlier would let any sender write
  // rows for a seller they cannot sign for — a DoS on that seller plus a timing
  // oracle. This is the same ordering v1.6.0 had inside `verifyVendorSignature`;
  // only the barrier's carrier moved.
  //
  // The key is built from PUBLIC MATERIAL ONLY (seller, timestamp, nonce, body
  // digest). `sig` is deliberately absent: it is a function of the secret, so a
  // sig-derived key would change on rotation and reopen the replay window —
  // which is the very defect this story exists to close.
  const guardDb = resolveReplayGuardDb(req.scope)
  if (!guardDb) {
    logger.error?.(
      `[vendor-auth] ${VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE} — no PG_CONNECTION in scope; ` +
        "failing closed rather than serving /vendor/* without replay protection"
    )
    return {
      ok: false,
      status: 503,
      code: VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE,
      message: "Vendor replay protection unavailable",
    }
  }

  // TWO keys, claimed in ONE statement (ADR-185 D8):
  //   - bodyKey  — AD-20's key: seller + ts + nonce + body digest.
  //   - nonceKey — seller + ts + nonce, WITHOUT the body.
  // The second one is load-bearing precisely because the 5.2 signature does NOT
  // cover the body: with `bodyKey` alone, one captured header could be replayed
  // unboundedly within `±drift` simply by varying the body (every variant would
  // hash to a different key and be seen as fresh). `nonceKey` restores the
  // one-shot nonce that `NonceLru` used to give, without dropping AD-20's key.
  const guardKeyParams = {
    sellerId: result.sellerId,
    ts: result.ts,
    nonce: result.nonce,
  }
  const guardKeys = [
    buildReplayGuardKey({
      ...guardKeyParams,
      bodyDigest: computeBodyDigest(req as { rawBody?: Buffer | string; body?: unknown }),
    }),
    buildNonceScopeKey(guardKeyParams),
  ]

  let fresh: boolean
  try {
    fresh = await claimReplayGuardKey(guardDb, {
      guardKeys,
      sellerId: result.sellerId,
      nowSec,
      windowSec: deriveReplayGuardWindowSec(config.driftSeconds),
    })
  } catch (err) {
    // Fail-closed, loudly. A barrier that errors is NOT a barrier that allows.
    logger.error?.(`[vendor-auth] ${VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE} ${String(err)}`)
    return {
      ok: false,
      status: 503,
      code: VENDOR_AUTH_REPLAY_GUARD_UNAVAILABLE,
      message: "Vendor replay protection unavailable",
    }
  }

  if (!fresh) {
    // NFR-2: the refusal is LOUD server-side. The response body carries the
    // same generic replay message it carried before — no new oracle about the
    // seller's existence (the 5.2 AC5 non-disclosure contract still holds).
    logger.warn?.(
      `[vendor-auth] ${VENDOR_AUTH_REPLAY_DETECTED} seller=${result.sellerId} — ` +
        "anti-replay key already claimed within the validity window"
    )
    return {
      ok: false,
      status: 401,
      code: VENDOR_AUTH_REPLAY_DETECTED,
      message: "Vendor signature replay detected",
    }
  }

  return { ok: true, sellerId: result.sellerId }
}

/**
 * vendorAuthMiddleware — the ONE authentication point for `/vendor/*`.
 *
 * Wired by the `/vendor/*` matcher (`lib/vendor-auth-matcher.ts` →
 * `api/middlewares.ts`), never per route. Do NOT also wrap a route handler in
 * an authentication HOF: `resolveSellerFromRequest` claims the anti-replay key
 * (Story 5.3), so a second pass over the same request claims the same key twice
 * and every legal request would answer `401 VENDOR_AUTH_REPLAY_DETECTED`.
 * That is not a hypothetical — it is covered by an execution test
 * (`__tests__/middlewares/vendor-auth-matcher.unit.spec.ts`).
 */
export async function vendorAuthMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  const logger = resolveLogger(req.scope)

  const sellerResult = await resolveSellerFromRequest(req, logger)
  if (!sellerResult.ok) {
    res.status(sellerResult.status).json({
      code: sellerResult.code,
      message: sellerResult.message,
    })
    return
  }

  const { sellerId } = sellerResult

  const gpCore = resolveGpCore(req.scope)
  if (!gpCore) {
    logger.warn?.("[vendor-auth] GpCoreService not available")
    res.status(503).json({
      message: "Vendor authentication service unavailable",
    })
    return
  }

  try {
    const vendorId = await gpCore.resolveVendorId(sellerId)
    const vendorReq = req as RequestWithVendorAuth
    vendorReq.vendorAuth = {
      vendor_id: vendorId,
      seller_id: sellerId,
    }

    logger.info?.(`[vendor-auth] authenticated vendor=${vendorId} seller=${sellerId}`)
    next()
  } catch (error) {
    if (error instanceof NotImplementedError) {
      logger.warn?.(`[vendor-auth] resolveVendorId stub: ${error.message}`)
      res.status(501).json({
        message: "Vendor ID resolution not yet implemented",
        stub: true,
        story: "1.3",
      })
      return
    }

    logger.error?.(`[vendor-auth] error resolving vendor: ${String(error)}`)
    res.status(500).json({
      message: "Vendor authentication failed",
    })
  }
}
