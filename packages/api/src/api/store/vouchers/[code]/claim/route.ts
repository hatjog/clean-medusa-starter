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
import { assertResourceMarket } from "../../../../../lib/assert-resource-market"
import { consumeClaimToken } from "../../../../../lib/voucher-claim-rate-limit"
import {
  computeBinding,
  verifyBinding,
} from "../../../../../lib/claim-idempotency-binding"
import { VOUCHER_MODULE, type VoucherService } from "../../../../../modules/voucher"
import {
  appendClaimAudit,
  appendClaimAuditWithFallback,
  auditLog,
  bindingStore,
  completeClaimBinding,
  reserveClaimBinding,
  withClaimTransaction,
  type ClaimAuditRow,
  type ClaimRouteResponse,
} from "./helpers"

// Disable Medusa's default admin auth — public store endpoint.
export const AUTHENTICATE = false

/** Minimum response latency floor in ms (anti-enumeration constant-time). */
const RESPONSE_FLOOR_MS = 200

/** Returns a Promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** v1.9.0 Wave F6 / Epic-2 LOW-04 — pad with ±25ms jitter to disrupt timing
 * analysis tuning. The constant 200ms floor was discoverable by bisection. */
const JITTER_MS = 25
async function padToFloor(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt
  const jitter = Math.floor((Math.random() * 2 - 1) * JITTER_MS)
  const target = RESPONSE_FLOOR_MS + jitter
  if (elapsed < target) {
    await delay(target - elapsed)
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

type DurableClaimResult = ClaimRouteResponse & {
  eventPayload?: { voucher_id: string; voucher_code: string; claimed_at: string }
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

function auditRow(input: Omit<ClaimAuditRow, "occurred_at"> & { occurred_at?: string }): ClaimAuditRow {
  return {
    ...input,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
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
    await appendClaimAuditWithFallback(req, auditRow({
      idempotency_key: "",
      code,
      ip,
      outcome: "rate_limited",
    }))
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

  // Cross-market isolation (DPIA R-12, cleanup-27 M2; cleanup-61 helper adoption
  // — review fix H1): delegate to the shared `assertResourceMarket` helper.
  // - Null voucher continues to constant-time anti-enumeration path below
  //   (helper default does NOT block on null resource).
  // - `allowMissingAls: true` preserves the prior public-store behaviour: a
  //   client without ALS market injection (pre-middleware) is permitted.
  // - 404 (NOT 403) on cross-market mismatch — existence must not leak.
  if (voucherForCheck) {
    const guard = assertResourceMarket(voucherForCheck, market_id, "Voucher", {
      allowMissingAls: true,
    })
    if (guard.blocked) {
      await padToFloor(startedAt)
      res.status(404).json(guard.body)
      return
    }
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
    await appendClaimAuditWithFallback(req, auditRow({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "replay_tampered",
    }))
    res.status(409).json({
      type: "replay_mismatch",
      message: "Idempotency binding mismatch — replay rejected.",
    })
    return
  }

  const durableResult = await withClaimTransaction<DurableClaimResult>(req, async (client) => {
    const reserved = await reserveClaimBinding(client, {
      idempotencyKey,
      bindingHash: expectedBinding,
      code,
      claimedAt,
    })

    if (!reserved.inserted) {
      // INFO-1 (defensive-only branch): the top-level verifyBinding check at
      // line ~201 already rejects every request whose idempotency_key ≠
      // expectedBinding before we enter the transaction. Inside the transaction
      // `reserved.bindingHash` always equals `expectedBinding`, so this branch
      // is unreachable on the normal prod path. It is kept as a defence-in-depth
      // guard in case the pre-tx check is bypassed (e.g. future code change).
      const bindingMatch = verifyBinding(reserved.bindingHash, expectedBinding)
      if (!bindingMatch) {
        await appendClaimAudit(client, auditRow({
          idempotency_key: idempotencyKey,
          code,
          ip,
          outcome: "replay_tampered",
        }))
        return {
          status: 409,
          body: {
            type: "replay_mismatch",
            message: "Idempotency binding mismatch — replay rejected.",
          },
        }
      }

      await appendClaimAudit(client, auditRow({
        idempotency_key: idempotencyKey,
        code,
        ip,
        outcome: "idempotent_replay",
      }))

      // LOW-3 fix: unify replay contract — durable path also signals idempotent:true
      // so callers get the same body shape regardless of whether PG is available.
      if (reserved.response) {
        return {
          ...reserved.response,
          body: { ...reserved.response.body, idempotent: true },
        }
      }
      return {
        status: 409,
        body: {
          type: "claim_replay_pending",
          message: "Claim replay is still pending. Please retry.",
        },
      }
    }

    let response: DurableClaimResult

    if (!voucherForCheck) {
      response = {
        status: 404,
        body: {
          type: "not_found",
          message: "Voucher not found.",
        },
      }
      await appendClaimAudit(client, auditRow({
        idempotency_key: idempotencyKey,
        code,
        ip,
        outcome: "invalid_code",
      }))
      await completeClaimBinding(client, idempotencyKey, response)
      return response
    }

    const claimedAtIso = new Date().toISOString()
    const claimResult = await voucherService.claim(code, {
      now: new Date(claimedAtIso),
      client,
    })

    if (claimResult.status !== "claimed") {
      const outcome =
        claimResult.status === "already_claimed"
          ? "already_claimed"
          : claimResult.status === "expired"
            ? "expired"
            : "invalid_code"
      response = claimResult.status === "already_claimed"
        ? {
            status: 409,
            body: {
              type: "already_claimed",
              message: "Voucher has already been claimed.",
              state: "claimed",
            },
          }
        : claimResult.status === "expired"
          ? { status: 410, body: { type: "expired", message: "Voucher has expired." } }
          : { status: 404, body: { type: "not_found", message: "Voucher not found." } }
      await appendClaimAudit(client, auditRow({
        idempotency_key: idempotencyKey,
        code,
        ip,
        outcome,
        occurred_at: claimedAtIso,
      }))
      await completeClaimBinding(client, idempotencyKey, response)
      return response
    }

    const updatedVoucher = claimResult.voucher
    response = {
      status: 200,
      body: {
        state: "claimed",
        claimed_at: claimedAtIso,
        seller_handle: updatedVoucher.seller_handle,
      },
      eventPayload: {
        voucher_id: updatedVoucher.code,
        voucher_code: updatedVoucher.code,
        claimed_at: claimedAtIso,
      },
    }
    await appendClaimAudit(client, auditRow({
      idempotency_key: idempotencyKey,
      code,
      ip,
      outcome: "ok",
      occurred_at: claimedAtIso,
    }))
    await completeClaimBinding(client, idempotencyKey, response)
    return response
  })

  if (durableResult !== null) {
    if (durableResult.eventPayload) {
      await emitVoucherClaimedEvent(req, durableResult.eventPayload)
    }
    await padToFloor(startedAt)
    res.status(durableResult.status).json(durableResult.body)
    return
  }

  // --- Idempotency binding check (single-instance fallback only) ---
  const existingBinding = bindingStore.get(idempotencyKey)

  if (existingBinding !== undefined) {
    // Idempotency key was seen before — verify binding matches.
    const bindingMatch = verifyBinding(existingBinding, expectedBinding)
    if (!bindingMatch) {
      await padToFloor(startedAt)
      auditLog.push({
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
    auditLog.push({
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
  bindingStore.set(idempotencyKey, expectedBinding)

  // --- Voucher existence check (constant-time: always runs this code path) ---
  if (!voucherForCheck) {
    await padToFloor(startedAt)
    auditLog.push({
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

  // v1.9.0 Wave F6 HIGH-09 — collapse the unlocked expiry/already-claimed
  // pre-checks into the locked `voucherService.claim` call. The unlocked
  // pre-checks here were a TOCTOU oracle: a concurrent claim could flip
  // `status='claimed'` between the unlocked check and the FOR UPDATE inside
  // claim(), causing this route to return "already_claimed" with the
  // pre-check's stale `voucherForCheck` snapshot. claim() now returns
  // structured `{status, voucher}` from inside the FOR UPDATE transaction;
  // the route branches on that single source of truth.
  const claimResult = await voucherService.claim(code)
  const claimedAtIso = new Date().toISOString()

  if (claimResult.status !== "claimed") {
    // Unexpected result after pre-checks passed — guard defensively.
    await padToFloor(startedAt)
    auditLog.push({
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

  auditLog.push({
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
