/**
 * senders.ts — rozwiązanie mapy `market_id → sender` dla providera brevo.
 *
 * Story 2.2 (AC2): ZERO hardcodowanych adresów w kodzie i w `medusa-config.ts`.
 * Źródłem jest env (`BREVO_SENDERS`, JSON), bo adres nadawcy jest daną
 * operacyjną per market (właściciel: Robert jako PO BonBeauty) — tak samo jak
 * ID szablonów Brevo. Brak wpisu dla rynku = fail-loud
 * `BREVO_SENDER_NOT_CONFIGURED` po stronie `BrevoAdapter` (nie podstawiamy
 * „jakiegoś" nadawcy).
 *
 * Format:
 *   BREVO_SENDERS='{"bonbeauty":{"email":"no-reply@…","name":"BonBeauty"}}'
 *
 * Parsowanie jest tolerancyjne na błąd składni (zwraca pustą mapę + zwraca
 * powód do zalogowania) — konfiguracja nie może wywrócić bootu (AC1).
 */

import type { BrevoEmailAddress } from "@gp/messaging"

export const BREVO_SENDERS_ENV = "BREVO_SENDERS"

export interface ResolvedBrevoSenders {
  senders: Record<string, BrevoEmailAddress>
  /** Powód pustej/częściowej mapy — do logu, nigdy do wyjątku przy boocie. */
  warning?: string
}

export function resolveBrevoSenders(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrevoSenders {
  const raw = env[BREVO_SENDERS_ENV]?.trim()
  if (!raw) {
    return {
      senders: {},
      warning: `${BREVO_SENDERS_ENV} is not set — every Brevo dispatch will fail loud with BREVO_SENDER_NOT_CONFIGURED`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      senders: {},
      warning: `${BREVO_SENDERS_ENV} is not valid JSON (${(error as Error).message}) — dispatches will fail loud`,
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      senders: {},
      warning: `${BREVO_SENDERS_ENV} must be a JSON object keyed by market_id`,
    }
  }

  const senders: Record<string, BrevoEmailAddress> = {}
  const skipped: string[] = []

  for (const [marketId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<BrevoEmailAddress> | undefined
    const email = typeof entry?.email === "string" ? entry.email.trim() : ""
    if (!email) {
      skipped.push(marketId)
      continue
    }
    senders[marketId] = {
      email,
      ...(typeof entry?.name === "string" && entry.name.trim()
        ? { name: entry.name.trim() }
        : {}),
    }
  }

  return {
    senders,
    ...(skipped.length
      ? { warning: `${BREVO_SENDERS_ENV}: markets without a sender email skipped: ${skipped.join(", ")}` }
      : {}),
  }
}
