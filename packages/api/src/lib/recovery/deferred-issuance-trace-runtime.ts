/**
 * deferred-issuance-trace-runtime.ts — v1.16.0 Story 4.4: zapis rekordu
 * `deferred_issuance_trace` z route'u webhooka pod granicą RLS (Story 11.1).
 *
 * Kolejność: (1) rynek śladu z koszyka płatności (bez zgadywania), (2) SLA
 * właściciela z konfiguracji runtime, (3) INSERT na połączeniu wziętym
 * WEWNĄTRZ kontekstu rynku (`queryUnderMarketContext` sprawdza, że sesja
 * niesie ten rynek i tę instancję). Każda odmowa ma nazwę.
 */
import { queryUnderMarketContext } from "../payment/stripe-payment-intent-transport"
import {
  deferredIssuanceTraceId,
  readDeferredIssuanceTraceSlaSeconds,
  recordDeferredIssuanceTrace,
  resolveDeferredTraceMarket,
  type TraceQueryClient,
} from "./deferred-issuance-trace"

export type PersistDeferredIssuanceTraceOutcome =
  | { ok: true; created: boolean; market_id: string; trace_id: string }
  | { ok: false; reason: "market_unresolved" | "market_ambiguous" | "trace_sla_unconfigured" }

export async function persistDeferredIssuanceTraceRecord(
  scope: { resolve: (key: string) => unknown },
  readClient: TraceQueryClient,
  input: {
    stripe_event_id: string
    payment_intent_id: string
    instance_id: string
    session_id: string | null
    metadata_market_id: string | null
    psp_occurred_at: string
  },
  env: Record<string, string | undefined> = process.env
): Promise<PersistDeferredIssuanceTraceOutcome> {
  const market = await resolveDeferredTraceMarket(readClient, {
    session_id: input.session_id,
    payment_intent_id: input.payment_intent_id,
    metadata_market_id: input.metadata_market_id,
  })
  if (!market.ok) return { ok: false, reason: market.reason }

  const slaSeconds = readDeferredIssuanceTraceSlaSeconds(env)
  if (slaSeconds === null) return { ok: false, reason: "trace_sla_unconfigured" }

  // `queryUnderMarketContext` zwraca wyłącznie wiersze; INSERT … RETURNING daje
  // jeden wiersz, gdy rekord jest nowy, i zero przy `ON CONFLICT DO NOTHING`.
  const scopedClient: TraceQueryClient = {
    query: async <T = Record<string, unknown>>(sql: string, values?: ReadonlyArray<unknown>) => {
      const result = await queryUnderMarketContext<T>(
        scope,
        { market_id: market.market_id, instance_id: input.instance_id },
        `${sql} RETURNING trace_id`,
        values ?? []
      )
      return { rows: result.rows, rowCount: result.rows.length }
    },
  }
  const created = await recordDeferredIssuanceTrace(scopedClient, {
    stripe_event_id: input.stripe_event_id,
    payment_intent_id: input.payment_intent_id,
    instance_id: input.instance_id,
    market_id: market.market_id,
    psp_occurred_at: input.psp_occurred_at,
    sla_seconds: slaSeconds,
  })
  return {
    ok: true,
    created,
    market_id: market.market_id,
    trace_id: deferredIssuanceTraceId(input.stripe_event_id),
  }
}

type WebhookTraceLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * Wejście z route'u webhooka Path Y. NIGDY nie rzuca: porażka rekordu, tak
 * jak porażka markera, nie zmienia klasy odpowiedzi (`503` zostaje), ale każdy
 * wynik — zapis, duplikat, nazwana odmowa, wyjątek — zostawia linię w logu.
 */
export async function recordWebhookDeferredIssuanceTrace(
  scope: { resolve: (key: string) => unknown },
  readClient: TraceQueryClient,
  logger: WebhookTraceLogger,
  input: {
    stripe_event_id: string
    payment_intent_id: string
    instance_id: string
    session_id: string | null
    metadata_market_id: string | null
    read_psp_occurred_at: () => string
  },
  env: Record<string, string | undefined> = process.env
): Promise<PersistDeferredIssuanceTraceOutcome | null> {
  try {
    const outcome = await persistDeferredIssuanceTraceRecord(
      scope,
      readClient,
      {
        stripe_event_id: input.stripe_event_id,
        payment_intent_id: input.payment_intent_id,
        instance_id: input.instance_id,
        session_id: input.session_id,
        metadata_market_id: input.metadata_market_id,
        psp_occurred_at: input.read_psp_occurred_at(),
      },
      env
    )
    if (outcome.ok) {
      logger.info?.(
        `[stripe/payment-intent] rekord deferred_issuance_trace ` +
          `${outcome.created ? "zapisany" : "juz istnial"} dla ${input.payment_intent_id} ` +
          `(market=${outcome.market_id}, owner=ops-recovery)`
      )
    } else {
      logger.warn?.(
        `[stripe/payment-intent] rekord deferred_issuance_trace NIE zapisany dla ` +
          `${input.payment_intent_id}: reason=${outcome.reason} — populacja recovery ` +
          "nie obejmie tego sladu bez interwencji operatora"
      )
    }
    return outcome
  } catch (err) {
    logger.warn?.(
      `[stripe/payment-intent] nie udalo sie zapisac rekordu deferred_issuance_trace dla ` +
        `${input.payment_intent_id}: ${(err as Error).message}`
    )
    return null
  }
}
