/**
 * STORY-MIG-B — OrderPlaced.v2 publisher (D-50 + D-58 + P-09).
 *
 * Composes a v2 envelope (`gp.commerce.order_placed.v2`) when the per-market
 * feature flag `orderplaced_v2_emission_enabled` is ON; otherwise falls back
 * to the v1 envelope for backward compatibility per D-50 deprecation path.
 *
 * The publisher is intentionally pure (no Medusa container coupling): callers
 * inject the order-placed snapshot, market-runtime-config, and MoR snapshot
 * (P-01 ownership lock writer). This makes it trivially unit-testable from
 * Jest without a live DB and keeps the cross-version regression matrix from
 * AC #5 deterministic.
 *
 * Schema reference: specs/contracts/events/schemas/order_placed.v2.schema.json
 * (frozen baseline per P-01 ownership lock — single PR / single reviewer).
 */

const ORDER_PLACED_V1_EVENT_TYPE = "gp.commerce.order_placed.v1" as const
const ORDER_PLACED_V2_EVENT_TYPE = "gp.commerce.order_placed.v2" as const

/** Event type literal of the v2 envelope (frozen). */
export const ORDER_PLACED_V2_EVENT_TYPE_CONST = ORDER_PLACED_V2_EVENT_TYPE

/** Event type literal of the v1 envelope (deprecated v1.4.0; removed v1.6.0). */
export const ORDER_PLACED_V1_EVENT_TYPE_CONST = ORDER_PLACED_V1_EVENT_TYPE

/** Schema version literal of v2 (matches frozen schema const). */
export const ORDER_PLACED_V2_SCHEMA_VERSION = "2" as const

export type SaleMor = "operator" | "vendor"
export type ServiceMor = "operator" | "vendor"
export type VoucherKind = "SPV" | "MPV" | "none"

export type BreakagePolicySnapshot = {
  policy_id: string | null
  policy_version: string | null
  recognition_mode:
    | "operator_full"
    | "operator_partial_vendor_share"
    | "vendor_full"
    | null
  expiry_grace_days: number | null
}

/**
 * P-01 ownership lock writer output. Producers populate every field at order
 * placement time; the snapshot is frozen and never re-derived later.
 */
export type MorSnapshot = {
  sale_mor: SaleMor
  service_mor: ServiceMor
  mor_policy_version: string
  voucher_kind: VoucherKind
  breakage_policy_snapshot: BreakagePolicySnapshot
}

export type LineItemPricingSnapshot = {
  currency: string
  unit_amount_minor: number
  quantity: number
  total_amount_minor: number
}

export type LineItem = {
  line_item_id: string
  offer_id: string
  offer_version: string
  voucher_kind?: VoucherKind
  pricing_snapshot: LineItemPricingSnapshot
}

export type OrderScope = {
  instance_id: string
  market_id: string
  vendor_id?: string | null
  location_id?: string | null
}

/**
 * Subset of `market_runtime_config` consumed by the publisher.
 *
 * `locales.default` is supplied by STORY-MIG-A. `feature_flags` is per-market
 * scoped (STORY-MIG-A schema lands `feature_flags.orderplaced_v2_emission_enabled`).
 */
export type MarketRuntimeConfig = {
  market_id: string
  locales?: {
    default?: string | null
    supported?: string[]
  } | null
  feature_flags?: {
    orderplaced_v2_emission_enabled?: boolean
  }
}

/**
 * Ingredients for composing an OrderPlaced envelope. The publisher is pure —
 * caller wires Order/MoR-snapshot/MarketRuntimeConfig from their own context.
 */
export type OrderPlacedComposeInput = {
  /** Idempotency key (ULID or order_id+envelope_hash). Per AC #1 envelope. */
  event_id: string
  /** ISO 8601 timestamp the envelope was produced. */
  occurred_at: string
  /** Per-event dedup key (consumers MUST treat duplicates as no-op). */
  idempotency_key: string
  /** Optional saga correlation across multiple events. */
  correlation_id?: string
  /** Optional causation reference (event id of the cause). */
  causation_id?: string
  /** Distributed-trace identifier for observability. */
  trace_id?: string
  actor: "market_operator" | "vendor_user" | "end_customer" | "system"
  scope: OrderScope
  order: {
    order_id: string
    currency: string
    total_amount_minor: number
    placed_at?: string
    line_items: LineItem[]
  }
  /** P-01 ownership-lock snapshot — full MoR block frozen at placement time. */
  mor: MorSnapshot
  /** Per-market runtime config. Drives flag + locale resolution. */
  market_runtime_config: MarketRuntimeConfig
  /** Gift flow signals. */
  gift?: {
    /** Explicit recipient locale (BCP47), if buyer specified one. */
    recipient_locale?: string | null
    /** True when the order is a gift (recipient ≠ buyer). */
    is_gift?: boolean
    /** Recipient PII — D-65 pull-forward, schema-only in v1.4.0. */
    recipient_email?: string | null
    recipient_phone?: string | null
  }
}

export type OrderPlacedV2Envelope = {
  schema_version: typeof ORDER_PLACED_V2_SCHEMA_VERSION
  event_type: typeof ORDER_PLACED_V2_EVENT_TYPE
  event_id: string
  occurred_at: string
  actor: OrderPlacedComposeInput["actor"]
  scope: OrderScope
  idempotency_key: string
  correlation_id?: string
  causation_id?: string
  trace_id?: string
  payload: {
    order_id: string
    currency: string
    total_amount_minor: number
    placed_at?: string
    line_items: LineItem[]
    mor: MorSnapshot
    recipient_locale: string | null
    message_locale: string | null
    is_gift: boolean
    recipient_email?: string | null
    recipient_phone?: string | null
  }
}

export type OrderPlacedV1Envelope = {
  schema_version: "1"
  event_type: typeof ORDER_PLACED_V1_EVENT_TYPE
  event_id: string
  occurred_at: string
  actor: OrderPlacedComposeInput["actor"]
  scope: OrderScope
  idempotency_key: string
  correlation_id?: string
  causation_id?: string
  trace_id?: string
  payload: {
    order_id: string
    currency: string
    total_amount_minor: number
    placed_at?: string
    line_items: LineItem[]
  }
}

/** Read the per-market emission flag — defaults FALSE per AC #9. */
export function isOrderPlacedV2EmissionEnabled(
  config: MarketRuntimeConfig | null | undefined
): boolean {
  return Boolean(config?.feature_flags?.orderplaced_v2_emission_enabled)
}

/**
 * Compose `payload.recipient_locale` per AC #4.
 *   - Non-gift order  → null
 *   - Gift order with explicit recipient_locale → echo it
 *   - Gift order without explicit recipient_locale → market.locales.default
 *     (STORY-MIG-A shim). When MIG-A has not yet populated `locales.default`
 *     for the market we degrade to null rather than throwing.
 */
export function resolveRecipientLocale(
  gift: OrderPlacedComposeInput["gift"] | undefined,
  config: MarketRuntimeConfig | null | undefined
): string | null {
  const isGift = Boolean(gift?.is_gift)
  if (!isGift) {
    return null
  }
  const explicit = gift?.recipient_locale
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit
  }
  const fallback = config?.locales?.default
  return typeof fallback === "string" && fallback.length > 0 ? fallback : null
}

/**
 * Compose the v2 envelope. Pure function; never reads from a Medusa container.
 *
 * `is_gift` is derived from `recipient_locale != null` per the schema's
 * "Producer convention" note on the `is_gift` field.
 *
 * `message_locale` is null in v1.4.0 — UX exposure deferred to v1.5.0 (P-09).
 */
export function composeOrderPlacedV2(
  input: OrderPlacedComposeInput
): OrderPlacedV2Envelope {
  const recipientLocale = resolveRecipientLocale(
    input.gift,
    input.market_runtime_config
  )
  const isGift = recipientLocale !== null

  const envelope: OrderPlacedV2Envelope = {
    schema_version: ORDER_PLACED_V2_SCHEMA_VERSION,
    event_type: ORDER_PLACED_V2_EVENT_TYPE,
    event_id: input.event_id,
    occurred_at: input.occurred_at,
    actor: input.actor,
    scope: {
      instance_id: input.scope.instance_id,
      market_id: input.scope.market_id,
      vendor_id: input.scope.vendor_id ?? null,
      location_id: input.scope.location_id ?? null,
    },
    idempotency_key: input.idempotency_key,
    payload: {
      order_id: input.order.order_id,
      currency: input.order.currency,
      total_amount_minor: input.order.total_amount_minor,
      line_items: input.order.line_items,
      mor: input.mor,
      recipient_locale: recipientLocale,
      message_locale: null,
      is_gift: isGift,
    },
  }

  if (input.order.placed_at !== undefined) {
    envelope.payload.placed_at = input.order.placed_at
  }
  if (input.correlation_id !== undefined) {
    envelope.correlation_id = input.correlation_id
  }
  if (input.causation_id !== undefined) {
    envelope.causation_id = input.causation_id
  }
  if (input.trace_id !== undefined) {
    envelope.trace_id = input.trace_id
  }
  if (input.gift?.recipient_email !== undefined) {
    envelope.payload.recipient_email = input.gift.recipient_email
  }
  if (input.gift?.recipient_phone !== undefined) {
    envelope.payload.recipient_phone = input.gift.recipient_phone
  }

  return envelope
}

/**
 * Compose the v1 envelope (legacy emission path — flag OFF or rollback).
 * v1 carries only the order core + line items; v2-specific fields are dropped.
 */
export function composeOrderPlacedV1(
  input: OrderPlacedComposeInput
): OrderPlacedV1Envelope {
  const envelope: OrderPlacedV1Envelope = {
    schema_version: "1",
    event_type: ORDER_PLACED_V1_EVENT_TYPE,
    event_id: input.event_id,
    occurred_at: input.occurred_at,
    actor: input.actor,
    scope: {
      instance_id: input.scope.instance_id,
      market_id: input.scope.market_id,
      vendor_id: input.scope.vendor_id ?? null,
      location_id: input.scope.location_id ?? null,
    },
    idempotency_key: input.idempotency_key,
    payload: {
      order_id: input.order.order_id,
      currency: input.order.currency,
      total_amount_minor: input.order.total_amount_minor,
      line_items: input.order.line_items,
    },
  }
  if (input.order.placed_at !== undefined) {
    envelope.payload.placed_at = input.order.placed_at
  }
  if (input.correlation_id !== undefined) {
    envelope.correlation_id = input.correlation_id
  }
  if (input.causation_id !== undefined) {
    envelope.causation_id = input.causation_id
  }
  if (input.trace_id !== undefined) {
    envelope.trace_id = input.trace_id
  }
  return envelope
}

/**
 * Top-level publisher entry — chooses v1 vs v2 based on feature flag, then
 * composes the appropriate envelope. Returns a discriminated union so callers
 * can route by `event_type`.
 */
export function composeOrderPlacedEnvelope(
  input: OrderPlacedComposeInput
): OrderPlacedV1Envelope | OrderPlacedV2Envelope {
  if (isOrderPlacedV2EmissionEnabled(input.market_runtime_config)) {
    return composeOrderPlacedV2(input)
  }
  return composeOrderPlacedV1(input)
}
