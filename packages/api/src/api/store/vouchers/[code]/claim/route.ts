/**
 * POST /store/vouchers/:code/claim — Story v160-cleanup-25.
 *
 * Security contract (preserved from v160-cleanup-15c):
 *   - Public-key gated (publishable API key header, handled by Medusa middleware).
 *   - IP-based token-bucket rate limit: 10 burst / 5 per-minute sustained → 429.
 *   - Constant-time response for unknown vs known code (anti-enumeration oracle).
 *     Both branches pad to a minimum 200 ms floor via setTimeout.
 *   - HMAC-bound idempotency: binding = HMAC(JWT_SECRET, code|session|claimed_at).
 *     Replay with mismatched binding → 409 `replay_mismatch`.
 *   - Audit log row per attempt with outcome.
 *   - AR45 PII allowlist: no recipient PII in response body.
 *
 * v160-cleanup-25 changes:
 *   - Voucher lookup/mutation via VoucherService (PG-backed) instead of
 *     getFixtureByCode / upsertFixture from the deleted lib module.
 *   - Claim state transition delegated to voucherService.claim(code) for
 *     atomic DB transaction (status update + event append).
 *   - ALS market-scope isolation (cleanup-27) preserved.
 *
 * @see packages/api/src/lib/voucher-claim-rate-limit.ts
 * @see packages/api/src/lib/claim-idempotency-binding.ts
 * @see specs/constitution/AR45-pii.md
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { marketContextStorage } from "../../../../../lib/market-context"
import { consumeClaimToken } from "../../../../../lib/voucher-claim-rate-limit"
import {
  computeBinding,
  verifyBinding,
} from "../../../../../lib/claim-idempotency-binding"
import { VOUCHER_MODULE, type VoucherService } from "../../../../../modules/voucher"

// Disable Medusa's default admin auth — public store endpoint.
export const AUTHENTICATE = false

/** Minimum response latency floor in ms (anti-enumeration constant-time). */
const RESPONSE_FLOOR_MS = 200

/** In-memory idempotency binding store: idempotency_key → hex binding. */
const _bindingStore = new Map<string, string>()

/** In-memory audit log (appended in-process). */
export interface ClaimAuditRow {
  idempotency_key: string
  code: string
  ip: string
  outcome:
    | "ok"
    | "idempotent_replay"
    | "replay_tampered"
    | "rate_limited"
    | "invalid_code"
    | "expired"
    | "already_claimed"
  occurred_at: string
}

const _auditLog: ClaimAuditRow[] = []

/** Exposed for tests only. */
export function _getAuditLog(): ReadonlyArray<ClaimAuditRow> {
  return _auditLog
}
export function _clearAuditLog(): void {
  _auditLog.splice(0, _auditLog.length)
}
export function _clearBindingStore(): void {
  _bindingStore.clear()
}

/** Returns a Promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Clamp-pad: ensure at least RESPONSE_FLOOR_MS has elapsed since `startedAt`. */
async function padToFloor(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt
  if (elapsed < RESPONSE_FLOOR_MS) {
    await delay(RESPONSE_FLOOR_MS - elapsed)
  }
}

function resolveIp(req: MedusaRequest): string {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim()
  return (req.socket?.remoteAddress ?? "unknown")
}

interface ClaimBody {
  recipient_session?: unknown
  idempotency_key?: unknown
  claimed_at?: unknown
}

type EventBusLike = {
  emit?: (message: { name: string; data: Record<string, unknown> }) => Promise<unknown>
}

async function emitVoucherClaimedEvent(
  req: MedusaRequest,
  payload: { voucher_id: string; voucher_code: string; claimed_at: string },
): Promise<void> {
  try {
    const eventBus = req.scope?.resolve?.(Modules.EVENT_BUS) as EventBusLike | undefined
    if (eventBus && typeof eventBus.emit === "function") {
      await eventBus.emit({ name: "voucher.claimed", data: payload })
    }
  } catch {
    // Claim success is not rolled back by notification fan-out issues.
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  // story v160-cleanup-27g: ALS extract for DPIA R-12 cross-market isolation (TF-46).
  // Cross-market voucher claim attempt → 404 (do NOT 403 — existence must not leak).
  const market_id = marketContextStorage.getStore()?.market_id ?? null

  const startedAt = Date.now()
  const code = (req.params as { code?: string })?.code ?? ""
  const ip = resolveIp(req)

  // --- Rate limit check ---
  const rl = consumeClaimToken(ip)
  if (!rl.allowed) {
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: "",
      code,
      ip,
      outcome: "rate_limited",
      occurred_at: new Date().toISOString(),
    })
    res.setHeader("Retry-After", String(rl.retryAfterSec))
    res.status(429).json({
      type: "rate_limited",
      message: "Too many claim attempts. Please retry after the indicated delay.",
      retry_after: rl.retryAfterSec,
    })
    return
  }

  // --- Input validation ---
  const body = (req.body ?? {}) as ClaimBody
  const recipientSession = typeof body.recipient_session === "string"
    ? body.recipient_session.trim()
    : ""
  const idempotencyKey = typeof body.idempotency_key === "string"
    ? body.idempotency_key.trim()
    : ""
  const claimedAt = typeof body.claimed_at === "string"
    ? body.claimed_at.trim()
    : ""

  if (!code || !recipientSession || !idempotencyKey || !claimedAt) {
    await padToFloor(startedAt)
    res.status(400).json({
      type: "invalid_request",
      message: "Required fields: code (path), recipient_session, idempotency_key, claimed_at",
    })
    return
  }

  // --- Resolve voucher service ---
  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService

  // --- Lookup voucher early for market isolation check (constant-time path) ---
  const voucherForCheck = await voucherService.getByCode(code)

  // Cross-market isolation (DPIA R-12): if ALS market context is set and voucher market
  // differs, return 404 — do NOT return 403 (existence must not leak across markets).
  if (voucherForCheck && market_id && voucherForCheck.market_id !== null && voucherForCheck.market_id !== market_id) {
    await padToFloor(startedAt)
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }

  // --- Compute expected HMAC binding ---
  let expectedBinding: string
  try {
    expectedBinding = computeBinding(code, recipientSession, claimedAt)
  } catch {
    await padToFloor(startedAt)
    res.status(500).json({
      type: "server_error",
      message: "Server configuration error (HMAC secret unavailable).",
    })
    return
  }

  if (!verifyBinding(idempotencyKey, expectedBinding)) {
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "replay_tampered",
      occurred_at: new Date().toISOString(),
    })
    res.status(409).json({
      type: "replay_mismatch",
      message: "Idempotency binding mismatch — replay rejected.",
    })
    return
  }

  // --- Idempotency binding check ---
  const existingBinding = _bindingStore.get(idempotencyKey)

  if (existingBinding !== undefined) {
    // Idempotency key was seen before — verify binding matches.
    const bindingMatch = verifyBinding(existingBinding, expectedBinding)
    if (!bindingMatch) {
      await padToFloor(startedAt)
      _auditLog.push({
        idempotency_key: idempotencyKey,
        code,
        ip,
        outcome: "replay_tampered",
        occurred_at: new Date().toISOString(),
      })
      res.status(409).json({
        type: "replay_mismatch",
        message: "Idempotency binding mismatch — replay rejected.",
      })
      return
    }
    // Idempotent replay — same binding, return success without mutation.
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "idempotent_replay",
      occurred_at: new Date().toISOString(),
    })
    res.status(200).json({
      state: "claimed",
      idempotent: true,
      seller_handle: voucherForCheck?.seller_handle ?? null,
    })
    return
  }

  // New idempotency key — register binding before any state change.
  _bindingStore.set(idempotencyKey, expectedBinding)

  // --- Voucher existence check (constant-time: always runs this code path) ---
  if (!voucherForCheck) {
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "invalid_code",
      occurred_at: new Date().toISOString(),
    })
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found.",
    })
    return
  }

  // --- Server-side expiry pre-check ---
  if (voucherForCheck.expires_at && voucherForCheck.expires_at < new Date()) {
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "expired",
      occurred_at: new Date().toISOString(),
    })
    res.status(410).json({
      type: "expired",
      message: "Voucher has expired.",
    })
    return
  }

  // --- Already claimed check ---
  if (voucherForCheck.status === "claimed") {
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "already_claimed",
      occurred_at: new Date().toISOString(),
    })
    res.status(409).json({
      type: "already_claimed",
      message: "Voucher has already been claimed.",
      state: "claimed",
    })
    return
  }

  // --- State transition: idle → claimed (atomic via voucherService.claim) ---
  const claimResult = await voucherService.claim(code)
  const claimedAtIso = new Date().toISOString()

  if (claimResult.status !== "claimed") {
    // Unexpected result after pre-checks passed — guard defensively.
    await padToFloor(startedAt)
    _auditLog.push({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: claimResult.status === "already_claimed" ? "already_claimed" : "invalid_code",
      occurred_at: claimedAtIso,
    })
    if (claimResult.status === "already_claimed") {
      res.status(409).json({
        type: "already_claimed",
        message: "Voucher has already been claimed.",
        state: "claimed",
      })
    } else if (claimResult.status === "expired") {
      res.status(410).json({ type: "expired", message: "Voucher has expired." })
    } else {
      res.status(404).json({ type: "not_found", message: "Voucher not found." })
    }
    return
  }

  const updatedVoucher = claimResult.voucher

  _auditLog.push({
    idempotency_key: idempotencyKey,
    code,
    ip,
    outcome: "ok",
    occurred_at: claimedAtIso,
  })

  await emitVoucherClaimedEvent(req, {
    voucher_id: updatedVoucher.code,
    voucher_code: updatedVoucher.code,
    claimed_at: claimedAtIso,
  })

  // AR45: response MUST NOT expose recipient PII.
  // Only seller_handle (public routing token) is returned.
  await padToFloor(startedAt)
  res.status(200).json({
    state: "claimed",
    claimed_at: claimedAtIso,
    seller_handle: updatedVoucher.seller_handle,
  })
}
