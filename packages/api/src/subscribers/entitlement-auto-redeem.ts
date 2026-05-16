// AUTHORED Story 2.9 (BE-8); WIRED when booking-confirmation event surface available.
//
// T0 recon on pinned SHA 99c397987bbc: no booking.confirmed / appointment.confirmed
// event exists in GP/backend/packages/api/src/subscribers/ or any Mercur module.
// Event name `gp.booking.appointment_confirmed.v1` is authored per GP naming convention.
//
// Apply-path: replace config.event with the real event name once Mercur surfaces a
// booking-confirmation event. The payload shape (entitlement_id / order_id / booking_ref)
// must be aligned to the actual event schema at wiring time.
//
// named_retry_slot: v1.9.0+ when booking module event surface is confirmed available.

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import {
  shouldAutoRedeemOnBookingConfirm,
  EntitlementTransitionError,
} from "../modules/voucher/models/entitlement"
import {
  createRedeemEntitlementWorkflowFromScope,
  EntitlementNotFoundError,
} from "../modules/voucher/workflows/redeem-entitlement"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string, error?: unknown) => void
}

/**
 * Payload shape for the authored booking-confirmation event.
 * Align to actual schema when wiring to a real event surface.
 */
type BookingConfirmedPayload = {
  entitlement_id?: string
  order_id?: string
  booking_id?: string
  booking_ref?: string
}

function resolveLogger(
  container: Record<string, unknown> | undefined
): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined
  if (direct) return direct
  const resolver = container?.resolve as ((k: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console
    } catch {
      return console
    }
  }
  return console
}

async function onBookingConfirmed({
  event,
  container,
}: SubscriberArgs<BookingConfirmedPayload>): Promise<void> {
  const logger = resolveLogger(
    container as unknown as Record<string, unknown>
  )

  const entitlementId = event.data?.entitlement_id
  if (!entitlementId) {
    logger.warn?.(
      "[entitlement-auto-redeem] booking-confirmed payload missing entitlement_id — skipping"
    )
    return
  }

  // Determine booking reference for idempotency_key derivation.
  const bookingRef =
    event.data?.booking_ref ??
    event.data?.booking_id ??
    event.data?.order_id ??
    entitlementId

  const scope = container as unknown as { resolve: (k: string) => unknown }
  const workflow = createRedeemEntitlementWorkflowFromScope(scope)

  let entitlement: { policy_snapshot: Record<string, unknown> } | null = null
  try {
    // Resolve entitlement to read policy_snapshot for the auto_redeem gate.
    // In production, the entitlement row would be fetched from the DB here;
    // for the authored stub we rely on the workflow to surface EntitlementNotFoundError.
    const pool = scope.resolve("__pg_pool__") as {
      connect: () => Promise<{
        query: (sql: string, vals: unknown[]) => Promise<{ rows: unknown[] }>
        release: () => void
      }>
    }
    const client = await pool.connect()
    try {
      const result = await client.query(
        "SELECT policy_snapshot FROM entitlement_instance WHERE id = $1",
        [entitlementId]
      )
      entitlement = (result.rows[0] as { policy_snapshot: Record<string, unknown> } | undefined) ?? null
    } finally {
      client.release()
    }
  } catch (err) {
    logger.warn?.(
      `[entitlement-auto-redeem] could not fetch policy_snapshot for ` +
        `entitlement_id=${entitlementId} — skipping: ${(err as Error)?.message ?? String(err)}`
    )
    return
  }

  if (!entitlement) {
    logger.warn?.(
      `[entitlement-auto-redeem] entitlement_id=${entitlementId} not found — skipping`
    )
    return
  }

  // Gate: only auto-redeem if policy_snapshot says so (enabled=true + trigger=on_appointment_confirm).
  if (!shouldAutoRedeemOnBookingConfirm(entitlement.policy_snapshot)) {
    logger.info?.(
      `[entitlement-auto-redeem] auto_redeem gate false for entitlement_id=${entitlementId} — no-op`
    )
    return
  }

  try {
    const result = await workflow.redeem({
      entitlement_id: entitlementId,
      booking_ref: bookingRef,
    })

    if (result.idempotent) {
      logger.info?.(
        `[entitlement-auto-redeem] idempotent: entitlement_id=${entitlementId} ` +
          `already REDEEMED_FULL — no-op`
      )
    } else {
      logger.info?.(
        `[entitlement-auto-redeem] redeemed entitlement_id=${entitlementId} ` +
          `idempotency_key=${result.event.idempotency_key}`
      )
    }
  } catch (err) {
    if (err instanceof EntitlementTransitionError) {
      // State machine rejected the transition → idempotent no-op (AC4).
      logger.info?.(
        `[entitlement-auto-redeem] transition rejected (idempotent no-op) ` +
          `entitlement_id=${entitlementId}: ${err.message}`
      )
      return
    }
    if (err instanceof EntitlementNotFoundError) {
      logger.warn?.(
        `[entitlement-auto-redeem] entitlement_id=${entitlementId} not found during redeem — skipping`
      )
      return
    }
    // Unexpected error — fail loud so Medusa DLQ infrastructure can pick it up.
    logger.error?.(
      `[entitlement-auto-redeem] error redeeming entitlement_id=${entitlementId}: ` +
        `${(err as Error)?.message ?? String(err)}`,
      err
    )
    throw err
  }
}

export default onBookingConfirmed

// AUTHORED: replace with real booking-confirmation event name when available.
export const config: SubscriberConfig = {
  event: "gp.booking.appointment_confirmed.v1",
}
