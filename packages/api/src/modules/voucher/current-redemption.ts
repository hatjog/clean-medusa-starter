/**
 * v1.16.0 Story 8.7 (DW-15-369, retro E5-X-1) — JEDNO źródło „bieżącej
 * realizacji po ostatniej korekcie" dla koperty realizacji, odmowy
 * `already_redeemed` i projekcji korekty 5.7 (`restoreAfterCorrectionForSeller`).
 *
 * Korekta 5.7 przywraca kod do stanu realizowalnego, a kolejna realizacja
 * dopisuje NOWE zdarzenie `claimed`. Zdarzenia `claimed` sprzed korekty są
 * historią cofniętej realizacji — czas „najwcześniejszego" `claimed` po
 * sekwencji realizacja → korekta → realizacja wskazywał realizację cofniętą.
 * Bieżąca realizacja to NAJNOWSZE zdarzenie `claimed` (kod `claimed` nie może
 * zostać zrealizowany ponownie bez korekty, a replay nie dopisuje zdarzenia).
 */
import type { VoucherStatus } from "./models/types"

export type ClaimedEventLike = {
  event_type: string
  occurred_at: Date | string
  payload?: Record<string, unknown> | null
}

export type CurrentRedemption = {
  at: string
  prior_status: VoucherStatus | null
  /** Zdarzenie ścieżki vendor (niesie `payload.prior_status`). */
  by_vendor: boolean
}

export function currentRedemptionEvent(
  events: readonly ClaimedEventLike[] | undefined
): CurrentRedemption | null {
  let latest: { ev: ClaimedEventLike; t: number } | null = null
  for (const ev of events ?? []) {
    if (ev.event_type !== "claimed") continue
    const t = new Date(ev.occurred_at).getTime()
    if (!Number.isFinite(t)) continue
    if (!latest || t >= latest.t) latest = { ev, t }
  }
  if (!latest) return null
  const prior = latest.ev.payload?.prior_status
  return {
    at: new Date(latest.t).toISOString(),
    prior_status: typeof prior === "string" ? (prior as VoucherStatus) : null,
    by_vendor: typeof prior === "string",
  }
}
