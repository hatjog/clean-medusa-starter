/**
 * v1.16.0 Story 6.5 (FR-20, NFR-3, AD-49; ADR-248 `Proposed`) — odmowa zamiast
 * pustego zbioru na `voucher_recipient_pii`.
 *
 * Polityka RLS ukrywa wiersze obcego rynku (0 rows). Dla danych osobowych
 * obdarowanego „pusty wynik” jest nieodróżnialny od „nie ma danych”, więc granica
 * adaptera najpierw porównuje rynek żądania z rynkiem sesji (`app.gp_market_id`,
 * ustawiany przez `lib/rls-pool-hook.ts` albo jawny `set_config`) i przy braku
 * kontekstu albo rozjeździe kończy się NAZWANYM błędem (403 na granicy aplikacji).
 */
import type { Knex } from "knex"

import { GP_MARKET_SESSION_VAR } from "../../lib/rls-pool-hook"

export type RecipientPiiMarketDenialReason = "missing_market_context" | "market_mismatch"

export class RecipientPiiMarketAccessDeniedError extends Error {
  readonly error_code = "GP_RECIPIENT_PII_MARKET_ACCESS_DENIED"
  readonly http_status = 403
  readonly status = 403

  constructor(readonly reason: RecipientPiiMarketDenialReason) {
    super(`voucher_recipient_pii access denied: ${reason}`)
    this.name = "RecipientPiiMarketAccessDeniedError"
  }
}

/**
 * Czyta rynek sesji na TYM SAMYM połączeniu (transakcji), na którym pójdzie
 * zapytanie, i odmawia, gdy go brak albo gdy `requestedMarketId` jest inny.
 * Zwraca rynek sesji (dla operacji bez argumentu rynku).
 */
export async function assertRecipientPiiMarketAccess(
  trx: Knex | Knex.Transaction,
  requestedMarketId: string | null
): Promise<string> {
  const result = (await trx.raw(
    `SELECT NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), '') AS market_id`
  )) as { rows?: Array<{ market_id: string | null }> }
  const sessionMarket = result.rows?.[0]?.market_id ?? null
  if (!sessionMarket) {
    throw new RecipientPiiMarketAccessDeniedError("missing_market_context")
  }
  if (requestedMarketId !== null && requestedMarketId !== sessionMarket) {
    throw new RecipientPiiMarketAccessDeniedError("market_mismatch")
  }
  return sessionMarket
}
