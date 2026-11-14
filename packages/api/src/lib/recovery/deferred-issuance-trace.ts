/**
 * deferred-issuance-trace.ts — v1.16.0 Story 4.4 (FR-12, AD-32, NFR-3, NFR-5).
 *
 * Ślad płatności bez zamówienia jako TRWAŁY REKORD (`deferred_issuance_trace`),
 * a nie populacja wyliczana na żądanie z połączenia `webhook_event_processed`
 * z `payment`. Trzy operacje:
 *
 *  1. ZAPIS przy wykryciu (route webhooka Path Y, `link_unresolved` w oknie
 *     wyścigu) — `recordDeferredIssuanceTrace`.
 *  2. DOMKNIĘCIE, gdy zamówienie się znalazło (`order.placed`) —
 *     `closeDeferredIssuanceTrace` → `issued_after_link` z zapisaną ścieżką
 *     i niepustym evidence; wiersz NIE jest kasowany.
 *  3. ODCZYT populacji — `listDeferredIssuanceTracePopulation`: jedna tabela,
 *     zero joinów; zmiana/usunięcie markera transportu nie zmienia wyniku.
 *
 * Właściciel: rola operatorska `ops-recovery` (D-35 p.9). Termin (`deadline`)
 * liczy się z SLA w config-as-code (`recovery-config.ts`) — progu wieku nie
 * ustala ta story (należy do 4.5), więc w tym pliku nie ma literału okresu.
 *
 * Tożsamość rekordu = klucz markera (`<event_id>#deferred-issuance`), ten sam,
 * którym posługuje się krok `dit-backfill` planu migracji. Zapis żywy
 * i backfill nie mogą więc dać dwóch rekordów jednego śladu.
 */
import {
  DEFERRED_ISSUANCE_EVENT_SUFFIX,
  DEFERRED_ISSUANCE_REASON,
} from "../payment/stripe-payment-intent-transport"
import {
  DEFERRED_ISSUANCE_AGE_SOURCE,
  DEFERRED_ISSUANCE_TRACE_TABLE,
  RECOVERY_MIGRATION_PLAN,
} from "./recovery-migration-plan"
import {
  assertDeferredIssuanceTraceSla,
  DEFERRED_ISSUANCE_TRACE_SLA,
  type DeferredIssuanceTraceSlaConfig,
} from "./recovery-config"

export type TraceQueryClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

/** Właściciel rekordu (D-35 p.9). */
export const DEFERRED_ISSUANCE_TRACE_OWNER = {
  owner_type: "operator_role",
  owner_id: "ops-recovery",
} as const

/** Źródło terminu SLA: config-as-code (`recovery-config.ts`, D-35 p.9). */
export { DEFERRED_ISSUANCE_TRACE_SLA, DEFERRED_ISSUANCE_TRACE_SLA_SECONDS } from "./recovery-config"

/** Proweniencja rekordu zapisanego przez runtime (odróżniona od backfillu). */
export const DEFERRED_ISSUANCE_TRACE_RUNTIME_PROVENANCE = {
  kind: "runtime_recorded",
  source: "path-y-webhook-link-race",
} as const

/** Ścieżka zamknięcia przy odzysku na `order.placed`. */
export const DEFERRED_ISSUANCE_TRACE_CLOSURE_ORDER_PLACED = "order_placed_retry" as const

/**
 * Ścieżka zamknięcia, gdy ponowienie Stripe (ta sama `event.id`) rozwiązało
 * link w route i wystawienie domknął subscriber `voucher-live-issue` (R-5).
 */
export const DEFERRED_ISSUANCE_TRACE_CLOSURE_WEBHOOK_LIVE_ISSUE = "webhook_live_issue" as const

/**
 * Kontrakt domknięcia (R-5): rekord domykają DOKŁADNIE te ścieżki, które
 * wystawiają uprawnienie dla śladu Path Y. Ścieżka natywna `payment.captured`
 * (`issue-entitlement.ts`, marker provider `stripe`) NIE ma rekordu 4.4
 * (rekord zapisuje wyłącznie route Path Y), więc nie ma czego domykać.
 */
export const DEFERRED_ISSUANCE_TRACE_CLOSING_PATHS = [
  DEFERRED_ISSUANCE_TRACE_CLOSURE_ORDER_PLACED,
  DEFERRED_ISSUANCE_TRACE_CLOSURE_WEBHOOK_LIVE_ISSUE,
] as const

export const OPEN_TRACE_STATES = ["awaiting_order", "escalated"] as const

export function deferredIssuanceTraceId(stripeEventId: string): string {
  return `${stripeEventId}${DEFERRED_ISSUANCE_EVENT_SUFFIX}`
}

/**
 * SLA w sekundach z config-as-code. Niepoprawna konfiguracja = wyjątek
 * (fail-loud), nigdy `null` ani ciche pominięcie zapisu.
 */
export function readDeferredIssuanceTraceSlaSeconds(
  config: Partial<DeferredIssuanceTraceSlaConfig> | null | undefined = DEFERRED_ISSUANCE_TRACE_SLA
): number {
  return assertDeferredIssuanceTraceSla(config)
}

export const INSERT_DEFERRED_ISSUANCE_TRACE_SQL = `
  INSERT INTO ${DEFERRED_ISSUANCE_TRACE_TABLE}
    (trace_id, instance_id, market_id, state, owner_type, owner_id, deadline,
     retry_count, version, occurred_at, closure_path, resolution_evidence,
     provenance_kind, provenance_source, payment_intent_id, stripe_event_id,
     deferral_reason, psp_occurred_at, age_source)
  VALUES ($1, $2, $3, 'awaiting_order', $4, $5,
          now() + make_interval(secs => $6::double precision),
          0, 1, now(), 'not_closed', NULL,
          $7, $8, $9, $10, $11, $12::timestamptz, $13)
  ON CONFLICT (trace_id) DO NOTHING
`

export type DeferredIssuanceTraceInput = {
  stripe_event_id: string
  payment_intent_id: string
  instance_id: string
  market_id: string
  psp_occurred_at: string
  sla_seconds: number
}

/** `true` = rekord nowy; `false` = rekord tego śladu już istniał. */
export async function recordDeferredIssuanceTrace(
  client: TraceQueryClient,
  input: DeferredIssuanceTraceInput
): Promise<boolean> {
  if (input.stripe_event_id.endsWith(DEFERRED_ISSUANCE_EVENT_SUFFIX)) {
    throw new Error(
      `[deferred-issuance-trace] stripe_event_id "${input.stripe_event_id}" juz niesie sufiks sladu`
    )
  }
  if (!Number.isInteger(input.sla_seconds) || input.sla_seconds <= 0) {
    throw new Error("[deferred-issuance-trace] sla_seconds musi byc dodatnia liczba calkowita")
  }
  const result = await client.query(INSERT_DEFERRED_ISSUANCE_TRACE_SQL, [
    deferredIssuanceTraceId(input.stripe_event_id),
    input.instance_id,
    input.market_id,
    DEFERRED_ISSUANCE_TRACE_OWNER.owner_type,
    DEFERRED_ISSUANCE_TRACE_OWNER.owner_id,
    input.sla_seconds,
    DEFERRED_ISSUANCE_TRACE_RUNTIME_PROVENANCE.kind,
    DEFERRED_ISSUANCE_TRACE_RUNTIME_PROVENANCE.source,
    input.payment_intent_id,
    input.stripe_event_id,
    DEFERRED_ISSUANCE_REASON,
    input.psp_occurred_at,
    DEFERRED_ISSUANCE_AGE_SOURCE,
  ])
  return (result.rowCount ?? 0) === 1
}

/**
 * Rynek śladu z KOSZYKA płatności (zamówienia jeszcze nie ma). Ta sama mapa
 * kanał→rynek co `RESOLVE_ORDER_MARKET_CONTEXT_SQL` (`sales_channel.metadata
 * ->>'gp_market_id'`). Wiele różnych rynków albo brak = odmowa, nie zgadywanie.
 */
export const RESOLVE_DEFERRED_TRACE_MARKET_SQL = `
  SELECT DISTINCT sc.metadata->>'gp_market_id' AS market_id
    FROM payment_session ps
    JOIN cart_payment_collection cpc
      ON cpc.payment_collection_id = ps.payment_collection_id
     AND cpc.deleted_at IS NULL
    JOIN cart c
      ON c.id = cpc.cart_id
     AND c.deleted_at IS NULL
    LEFT JOIN sales_channel sc
      ON sc.id = c.sales_channel_id
     AND sc.deleted_at IS NULL
   WHERE ps.deleted_at IS NULL
     AND (
           ($1::text IS NOT NULL AND ps.id = $1)
        OR ($2::text IS NOT NULL AND ps.data->>'id' = $2)
        OR ($2::text IS NOT NULL AND ps.data->>'payment_intent' = $2)
     )
`

export type DeferredTraceMarketResolution =
  | { ok: true; market_id: string }
  | { ok: false; reason: "market_unresolved" | "market_ambiguous" }

export async function resolveDeferredTraceMarket(
  client: TraceQueryClient,
  hints: { session_id: string | null; payment_intent_id: string; metadata_market_id: string | null }
): Promise<DeferredTraceMarketResolution> {
  const result = await client.query<{ market_id: string | null }>(
    RESOLVE_DEFERRED_TRACE_MARKET_SQL,
    [hints.session_id ?? null, hints.payment_intent_id]
  )
  const markets = new Set<string>()
  for (const row of result.rows) {
    if (typeof row.market_id === "string" && row.market_id.trim()) markets.add(row.market_id)
  }
  if (hints.metadata_market_id) markets.add(hints.metadata_market_id)
  if (markets.size === 0) return { ok: false, reason: "market_unresolved" }
  if (markets.size > 1) return { ok: false, reason: "market_ambiguous" }
  return { ok: true, market_id: [...markets][0] }
}

/**
 * Domknięcie do `issued_after_link`. Pierwsze zamówienie ustawia ścieżkę
 * i evidence; kolejne zamówienia tego samego PaymentIntenta (ADR-166) są
 * DOPISYWANE do `resolution_evidence.orders` — stan zostaje terminalny,
 * `version` rośnie przy każdej zmianie, wiersz nigdy nie jest kasowany.
 */
export const CLOSE_DEFERRED_ISSUANCE_TRACE_SQL = `
  UPDATE ${DEFERRED_ISSUANCE_TRACE_TABLE}
     SET closure_path = CASE WHEN state = 'issued_after_link' THEN closure_path ELSE $2 END,
         resolution_evidence = CASE
           WHEN state = 'issued_after_link'
             THEN resolution_evidence || jsonb_build_object(
                    'orders', COALESCE(resolution_evidence->'orders', '[]'::jsonb) || to_jsonb($4::text))
           ELSE $3::jsonb
         END,
         state = 'issued_after_link',
         version = version + 1
   WHERE trace_id = $1
     AND market_id = $5
     AND instance_id = $6
     AND (
           state IN ('awaiting_order', 'escalated')
        OR (state = 'issued_after_link'
            AND NOT jsonb_exists(COALESCE(resolution_evidence->'orders', '[]'::jsonb), $4))
     )
  RETURNING version
`

export type CloseDeferredIssuanceTraceInput = {
  stripe_event_id: string
  instance_id: string
  market_id: string
  order_id: string
  closure_path: string
  evidence: Record<string, unknown>
}

/**
 * Domyka rekord w transakcji wołającego. GUC rynku/instancji są ustawiane
 * LOKALNIE na czas UPDATE i przywracane, żeby polityka `market_isolation`
 * widziała wiersz, a pozostałe zapisy transakcji nie dziedziczyły scope'u.
 * Zwraca nową `version` albo `null`, gdy nie było czego domykać.
 */
export async function closeDeferredIssuanceTrace(
  client: TraceQueryClient,
  input: CloseDeferredIssuanceTraceInput
): Promise<number | null> {
  const evidence = { ...input.evidence, orders: [input.order_id] }
  const previous = await client.query<{ market_id: string | null; instance_id: string | null }>(
    "SELECT current_setting('app.gp_market_id', true) AS market_id, " +
      "current_setting('app.gp_instance_id', true) AS instance_id",
    []
  )
  const prior = previous.rows[0] ?? { market_id: null, instance_id: null }
  await client.query("SELECT set_config('app.gp_market_id', $1, true)", [input.market_id])
  await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [input.instance_id])
  try {
    const result = await client.query<{ version: number }>(CLOSE_DEFERRED_ISSUANCE_TRACE_SQL, [
      deferredIssuanceTraceId(input.stripe_event_id),
      input.closure_path,
      JSON.stringify(evidence),
      input.order_id,
      input.market_id,
      input.instance_id,
    ])
    return result.rows[0]?.version ?? null
  } finally {
    await client.query("SELECT set_config('app.gp_market_id', $1, true)", [prior.market_id ?? ""])
    await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [prior.instance_id ?? ""])
  }
}

/** Populacja otwarta — JEDNA tabela, bez joinu; zakres zawęża RLS. */
export const LIST_DEFERRED_ISSUANCE_TRACE_POPULATION_SQL = `
  SELECT trace_id, instance_id, market_id, state, owner_type, owner_id, deadline,
         occurred_at, closure_path, resolution_evidence, version,
         payment_intent_id, stripe_event_id
    FROM ${DEFERRED_ISSUANCE_TRACE_TABLE}
   WHERE state IN ('awaiting_order', 'escalated')
   ORDER BY occurred_at ASC, trace_id ASC
`

export async function listDeferredIssuanceTracePopulation(client: TraceQueryClient) {
  const result = await client.query<Record<string, unknown>>(
    LIST_DEFERRED_ISSUANCE_TRACE_POPULATION_SQL,
    []
  )
  return result.rows
}

export type GuardedCloseOutcome =
  | { ok: true; version: number | null }
  | { ok: false; error: string }

/**
 * Domknięcie pod SAVEPOINT-em: porażka rekordu (np. środowisko bez migracji
 * 4.4) NIE wycofuje wystawienia w transakcji wołającego, ale jest zwracana
 * wołającemu jako nazwany wynik — nie znika.
 */
export async function closeDeferredIssuanceTraceGuarded(
  client: TraceQueryClient,
  input: CloseDeferredIssuanceTraceInput
): Promise<GuardedCloseOutcome> {
  await client.query("SAVEPOINT deferred_issuance_trace_close", [])
  try {
    const version = await closeDeferredIssuanceTrace(client, input)
    await client.query("RELEASE SAVEPOINT deferred_issuance_trace_close", [])
    return { ok: true, version }
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT deferred_issuance_trace_close", [])
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Krok `dit-backfill` planu migracji (T3, D-35 p.9) jako JEDNA instrukcja:
 * zastane markery `#deferred-issuance` z certyfikowanym scope'em, właścicielem
 * i terminem → rekordy `awaiting_order`; reszta → kwarantanna. Granice
 * transakcji (`BEGIN`/`COMMIT` w kształcie planu) należą do wołającego.
 *
 * Jedyna różnica wobec kształtu planu: markery, których rekord JUŻ istnieje
 * (zapisany przez runtime), są pomijane — bez tego ponowny przebieg albo
 * przebieg po wdrożeniu zapisu żywego kończyłby się naruszeniem klucza.
 */
export function deferredIssuanceTraceBackfillSql(): string {
  const carrier = RECOVERY_MIGRATION_PLAN.find((c) => c.population_type === "deferred_issuance_trace")
  const step = carrier?.up.find((s) => s.id === "dit-backfill")
  if (!step) throw new Error("[deferred-issuance-trace] plan migracji nie zawiera kroku dit-backfill")
  let sql = step.sql_shape.trim()
  if (!sql.startsWith("BEGIN; ")) throw new Error("[deferred-issuance-trace] nieoczekiwany poczatek dit-backfill")
  sql = sql.slice("BEGIN; ".length)
  const commitAt = sql.lastIndexOf("; COMMIT")
  if (commitAt < 0) throw new Error("[deferred-issuance-trace] nieoczekiwany koniec dit-backfill")
  sql = sql.slice(0, commitAt)
  // Kształt planu woła `pg_input_is_valid(text, regtype)` — takiej sygnatury
  // PostgreSQL nie ma (jest `(text, text)`; zmierzone na PG 17.6: "function
  // pg_input_is_valid(text, regtype) does not exist"). Wykonanie używa
  // poprawnej sygnatury; semantyka walidacji bez zmian.
  const badCast = "'timestamp with time zone'::regtype"
  if (!sql.includes(badCast)) throw new Error("[deferred-issuance-trace] nieoczekiwana walidacja psp_occurred_at w dit-backfill")
  sql = sql.split(badCast).join("'timestamp with time zone'")
  const anchor = "WHERE w.provider="
  if (sql.split(anchor).length !== 2) throw new Error("[deferred-issuance-trace] kotwica dit-backfill niejednoznaczna")
  return sql.replace(
    anchor,
    `WHERE NOT EXISTS (SELECT 1 FROM ${DEFERRED_ISSUANCE_TRACE_TABLE} t WHERE t.trace_id = w.event_id) ` +
      `AND NOT EXISTS (SELECT 1 FROM ${DEFERRED_ISSUANCE_TRACE_TABLE}_backfill_quarantine q WHERE q.source_event_id = w.event_id) ` +
      "AND w.provider="
  )
}

export async function runDeferredIssuanceTraceBackfill(
  client: TraceQueryClient,
  instanceMapping: ReadonlyArray<{ market_id: string; instance_id: string }>,
  certifiedProvenance: ReadonlyArray<{ event_id: string; owner_type: string; owner_id: string; deadline: string }>
): Promise<void> {
  await client.query(deferredIssuanceTraceBackfillSql(), [
    JSON.stringify(instanceMapping),
    JSON.stringify(certifiedProvenance),
  ])
}
