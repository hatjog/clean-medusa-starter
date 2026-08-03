/**
 * stripe-payment-intent-link.ts — Story 5.1 AC4 (v1.14.0) — rozwiązanie
 * listy `order_id` + `market_id` dla webhooka Path Y, gdy metadata
 * PaymentIntenta ich NIE niesie.
 *
 * ── Dlaczego to istnieje (zmierzony defekt, nie hipoteza) ───────────────────
 * Realny zakup 2026-07-28 (`order_01KYMN7XQX06FKHSWFT0QV2NNY`, PI
 * `pi_3TyCqiHG9Rf5NslT0vAfkVtW`, `succeeded`, 250 PLN) zakończył się
 * `webhook_event_processed = 0`, `event_processed = 0`, `entitlement_instance = 0`:
 * klientka zapłaciła, zobaczyła potwierdzenie i NIE dostała vouchera.
 *
 * Przyczyna: metadata PaymentIntenta niesie WYŁĄCZNIE
 * `{ session_id: "payses_..." }`, bo **sesja płatności powstaje zanim zamówienie
 * zaczyna istnieć**. `buildPaymentIntentSucceededEnvelope` wymagał `order_id`
 * i `market_id` wprost z metadata i rzucał `StripeEventMappingError` ⇒ HTTP 400
 * ⇒ zero emisji ⇒ urwany łańcuch issuance.
 *
 * Powiązanie JEST w bazie i to ono jest tu źródłem prawdy:
 *
 *   payment_session(payses_…)  →  payment_collection
 *                              →  order_payment_collection  →  order
 *
 * ── Kontrakt zdarzenia NIENARUSZONY ─────────────────────────────────────────
 * `gp.stripe.payment_intent_succeeded.v1` zachowuje skalarny `order_id`: dla
 * jednej kolekcji powiązanej z N zamówieniami route emituje N kopert, po jednej
 * na zamówienie (ADR-166). Schemat i walidacja NFR4 zostają bez zmian.
 *
 * ── Zasada twarda: NIE ZGADUJEMY RYNKU ──────────────────────────────────────
 * `market_id` pochodzi z danych domenowych zamówienia albo z mapy
 * `sales_channel.metadata->>'gp_market_id'` (ta sama mapa, którą trzyma
 * `loaders/market-context-cache.ts` i którą stosuje `gp-config-sync-*`).
 * Gdy oba źródła milczą — ODRZUCAMY zdarzenie z czytelnym powodem.
 * Gdy oba mówią co innego — ODRZUCAMY jako niejednoznaczne. Cicha podmiana
 * rynku jest gorsza niż 400: wystawiłaby voucher na cudzym rynku, z cudzym
 * nadawcą i cudzym audytem, wyglądając przy tym na sukces.
 *
 * Kolejność `order.metadata` → `sales_channel` jest CELOWO taka sama jak
 * w rdzeniu issuance (`live-issue-from-payment-intent.ts`), żeby `scope.market_id`
 * z koperty nigdy nie rozjechał się z tym, co rdzeń policzyłby samodzielnie.
 */

/** Minimalny kontrakt klienta PG (spójny z rdzeniem live-issue). */
export type PaymentLinkQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

/**
 * Klasy odrzucenia — ROZŁĄCZNE, bo operator ma z nich odczytać, czy patrzy na
 * defekt transportu, danych, czy konfiguracji (Story 5.1 AC4, wymaganie 3).
 *
 *  - `link_unresolved`  — brak `order_id` w metadata i brak linku w bazie
 *                         (sesja nieznana / nigdy nie doszło do zamówienia) → DANE
 *  - `link_ambiguous`   — wielozamówieniowy link przecina granicę rynku → DANE
 *  - `order_not_found`  — `order_id` znane, ale zamówienia nie ma → DANE
 *  - `market_unresolved`— zamówienie jest, ale rynku nie da się przypisać → KONFIG
 *  - `market_ambiguous` — `order.metadata` i `sales_channel` wskazują różne rynki → KONFIG
 */
export type PaymentIntentLinkRejectionReason =
  | "link_unresolved"
  | "link_ambiguous"
  | "order_not_found"
  | "market_unresolved"
  | "market_ambiguous"

/** Skąd faktycznie wzięliśmy każdy komponent — do logu i audytu operatora. */
export type PaymentIntentLinkSource = {
  order_id: "metadata" | "payment_session_link"
  market_id: "metadata" | "order_metadata" | "sales_channel"
}

export type ResolvedPaymentIntentOrder = {
  order_id: string
  market_id: string
  source: PaymentIntentLinkSource
}

export type PaymentIntentLinkResolution =
  | {
      ok: true
      orders: ResolvedPaymentIntentOrder[]
    }
  | {
      ok: false
      reason: PaymentIntentLinkRejectionReason
      detail: string
    }

/** Wskazówki odczytane z faktu Stripe (metadata + id PaymentIntenta). */
export type PaymentIntentLinkHints = {
  payment_intent_id: string
  /** `metadata.order_id` / `gp_order_id`, gdy jest. */
  order_id?: string | null
  /** `metadata.market_id` / `gp_market_id`, gdy jest. */
  market_id?: string | null
  /** `metadata.session_id` — jedyne, co realnie niesie sesja checkoutu. */
  session_id?: string | null
}

/**
 * `order_id` po istniejącym linku płatności. Dopasowujemy sesję po jej ID
 * (`metadata.session_id`) ALBO po identyfikatorze PaymentIntenta zapisanym
 * w `payment_session.data` — Stripe provider Medusy trzyma tam surowy obiekt PI
 * (ten sam wzorzec czyta `subscribers/stripe-payment-audit.ts`), więc zdarzenie
 * bez `session_id` też jest rozwiązywalne.
 *
 * `DISTINCT` usuwa powtórzenia wynikające z retry sesji. Jedna kolekcja
 * płatności MOŻE wskazywać wiele zamówień — Mercur dzieli checkout per
 * seller. Każde `order_id` jest osobną jednostką issuance (ADR-166).
 */
export const RESOLVE_ORDER_BY_PAYMENT_LINK_SQL = `
  SELECT DISTINCT opc.order_id
    FROM payment_session ps
    JOIN order_payment_collection opc
      ON opc.payment_collection_id = ps.payment_collection_id
     AND opc.deleted_at IS NULL
    JOIN "order" o
      ON o.id = opc.order_id
     AND o.deleted_at IS NULL
   WHERE ps.deleted_at IS NULL
     AND (
           ($1::text IS NOT NULL AND ps.id = $1)
        OR ($2::text IS NOT NULL AND ps.data->>'id' = $2)
        OR ($2::text IS NOT NULL AND ps.data->>'payment_intent' = $2)
     )
   ORDER BY opc.order_id ASC
`

/**
 * Kontekst rynkowy zamówienia. `sales_channel.metadata->>'gp_market_id'` to ta
 * sama mapa kanał→rynek, którą ładuje `loaders/market-context-cache.ts`
 * (publishable key → sales_channel → market) — czyli SSOT przypisania rynku
 * w runtime, a nie wartość domyślna.
 */
export const RESOLVE_ORDER_MARKET_CONTEXT_SQL = `
  SELECT o.id                            AS order_id,
         o.metadata                      AS order_metadata,
         o.sales_channel_id              AS sales_channel_id,
         sc.metadata->>'gp_market_id'    AS sales_channel_market_id
    FROM "order" o
    LEFT JOIN sales_channel sc
      ON sc.id = o.sales_channel_id
     AND sc.deleted_at IS NULL
   WHERE o.id = $1
     AND o.deleted_at IS NULL
   LIMIT 1
`

type OrderMarketContextRow = {
  order_id: string | null
  order_metadata: Record<string, unknown> | null
  sales_channel_id: string | null
  sales_channel_market_id: string | null
}

/**
 * Rozwiązuje wszystkie pary `order_id` + `market_id` dla faktu
 * `payment_intent.succeeded`.
 *
 * Kolejność (decyzja PO 2026-07-28, wariant B):
 *   1. metadata PaymentIntenta (gdy checkout zdążył je ostemplować),
 *   2. link `payment_session → payment_collection → order_payment_collection → order`.
 *
 * `market_id` z metadata jest honorowany, ale i tak weryfikowany względem
 * zamówienia — metadata są mutowalne z zewnątrz (Stripe API), a rynek decyduje
 * o izolacji najemcy. Rozbieżność ⇒ `market_ambiguous`, nie „ufamy metadata".
 *
 * Rzuca WYŁĄCZNIE gdy zawiedzie sama baza — błąd I/O nie jest odrzuceniem
 * zdarzenia (to sytuacja do ponowienia przez Stripe, nie do 400); rozróżnienie
 * należy do wołającego.
 */
export async function resolvePaymentIntentLink(
  client: PaymentLinkQueryClient,
  hints: PaymentIntentLinkHints
): Promise<PaymentIntentLinkResolution> {
  const metadataOrderId = normalize(hints.order_id)
  const metadataMarketId = normalize(hints.market_id)
  const sessionId = normalize(hints.session_id)

  // Link jest źródłem prawdy dla kardynalności; metadata jest tylko fallbackiem
  // zanim powstanie link. Dzięki temu pojedyncze metadata.order_id nie ucina batcha.
  const linked = await client.query<{ order_id: string | null }>(
    RESOLVE_ORDER_BY_PAYMENT_LINK_SQL,
    [sessionId ?? null, hints.payment_intent_id]
  )
  const linkedOrderIds = unique(
    linked.rows.map((row) => normalize(row.order_id)).filter(isPresent)
  ).sort()
  const orderIds = linkedOrderIds.length > 0
    ? linkedOrderIds
    : metadataOrderId ? [metadataOrderId] : []
  const orderIdSource: PaymentIntentLinkSource["order_id"] =
    linkedOrderIds.length > 0 ? "payment_session_link" : "metadata"

  if (orderIds.length === 0) {
    return {
      ok: false,
      reason: "link_unresolved",
      detail:
        `payment_intent ${hints.payment_intent_id} nie niesie order_id w metadata ` +
        `(metadata.session_id=${sessionId ?? "brak"}) i nie ma powiązania ` +
        "payment_session → payment_collection → order_payment_collection → order " +
        "— zdarzenie nie da się przypisać do zamówienia",
    }
  }

  const orders: ResolvedPaymentIntentOrder[] = []
  for (const orderId of orderIds) {
    const resolved = await resolveOrderContext(client, {
      order_id: orderId,
      order_id_source: orderIdSource,
      metadata_market_id: metadataMarketId,
      payment_intent_id: hints.payment_intent_id,
    })
    if (!resolved.ok) return resolved
    orders.push(resolved.order)
  }

  const markets = unique(orders.map((order) => order.market_id))
  if (markets.length > 1) {
    return {
      ok: false,
      reason: "link_ambiguous",
      detail:
        `payment_intent ${hints.payment_intent_id} wskazuje ${orders.length} zamówień ` +
        `w wielu rynkach (${markets.join(", ")}) — jedna rezerwacja transportowa ` +
        "nie może bezpiecznie przekroczyć granicy izolacji rynku",
    }
  }

  return { ok: true, orders }
}

async function resolveOrderContext(
  client: PaymentLinkQueryClient,
  input: {
    order_id: string
    order_id_source: PaymentIntentLinkSource["order_id"]
    metadata_market_id: string | null
    payment_intent_id: string
  }
): Promise<
  | { ok: true; order: ResolvedPaymentIntentOrder }
  | Extract<PaymentIntentLinkResolution, { ok: false }>
> {
  const contextResult = await client.query<OrderMarketContextRow>(
    RESOLVE_ORDER_MARKET_CONTEXT_SQL,
    [input.order_id]
  )
  const context = contextResult.rows[0]
  if (!context || !normalize(context.order_id)) {
    return {
      ok: false,
      reason: "order_not_found",
      detail:
        `order ${input.order_id} (źródło: ${input.order_id_source}) nie istnieje albo jest usunięte ` +
        `— payment_intent ${input.payment_intent_id} bez zamówienia do obsłużenia`,
    }
  }

  const orderMarketId =
    readNestedString(context.order_metadata, ["gp", "market_id"]) ??
    readNestedString(context.order_metadata, ["market_id"])
  const salesChannelMarketId = normalize(context.sales_channel_market_id)
  const candidates: Array<{
    value: string
    source: PaymentIntentLinkSource["market_id"]
  }> = []
  if (input.metadata_market_id) {
    candidates.push({ value: input.metadata_market_id, source: "metadata" })
  }
  if (orderMarketId) candidates.push({ value: orderMarketId, source: "order_metadata" })
  if (salesChannelMarketId) {
    candidates.push({ value: salesChannelMarketId, source: "sales_channel" })
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "market_unresolved",
      detail:
        `order ${input.order_id} nie ma market_id ani w metadata (gp.market_id / market_id), ` +
        `ani przez sales_channel ${context.sales_channel_id ?? "brak"} ` +
        "(metadata->>'gp_market_id') — rynek jest nieprzypisywalny; odrzucamy " +
        "zamiast podstawiać wartość domyślną",
    }
  }

  const distinct = unique(candidates.map((candidate) => candidate.value))
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: "market_ambiguous",
      detail:
        `order ${input.order_id} ma sprzeczne przypisania rynku: ` +
        candidates.map((candidate) => `${candidate.source}=${candidate.value}`).join(", ") +
        " — cicha podmiana rynku byłaby groźniejsza niż odrzucenie",
    }
  }

  return {
    ok: true,
    order: {
      order_id: input.order_id,
      market_id: candidates[0].value,
      source: {
        order_id: input.order_id_source,
        market_id: candidates[0].source,
      },
    },
  }
}

function normalize(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function isPresent(value: string | null): value is string {
  return value !== null
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function readNestedString(
  source: Record<string, unknown> | null | undefined,
  path: readonly string[]
): string | null {
  let cursor: unknown = source
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return normalize(cursor)
}
