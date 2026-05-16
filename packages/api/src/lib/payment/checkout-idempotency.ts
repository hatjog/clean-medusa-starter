import { createHash } from "node:crypto"

export type CheckoutCartFingerprintInput = {
  cart_id: string
  currency_code?: string | null
  total?: number | null
  item_total?: number | null
  shipping_total?: number | null
  tax_total?: number | null
}

export type PaymentIntentResolution<T> =
  | { reused: true; payment_intent: T }
  | { reused: false; payment_intent: T }

export type CheckoutPaymentSessionResolution<T> =
  | { reused: true; payment_session: T }
  | { reused: false; payment_session: T }

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
export type CheckoutIdempotencyClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => QueryResult<T>
}

export function extractCheckoutIdempotencyKey(
  headers: Record<string, string | string[] | undefined>
): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "idempotency-key") continue
    const raw = Array.isArray(value) ? value[0] : value
    const key = raw?.trim()
    return key || null
  }
  return null
}

export function computeCheckoutCartHash(input: CheckoutCartFingerprintInput): string {
  const canonical = {
    cart_id: input.cart_id,
    currency_code: input.currency_code ?? null,
    item_total: input.item_total ?? null,
    shipping_total: input.shipping_total ?? null,
    tax_total: input.tax_total ?? null,
    total: input.total ?? null,
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/**
 * Backend payment-module helper for F-NEW-B1.
 *
 * Call this from the PaymentIntent creation path while holding the
 * payment_session row lock. The helper is deliberately storage-only: the
 * caller owns provider-specific PaymentIntent creation.
 */
export async function resolvePaymentIntentForCheckoutIdempotency<T>(
  client: CheckoutIdempotencyClient,
  input: {
    payment_session_id: string
    idempotency_uuid: string
    cart_hash: string
    createIntent: () => Promise<T>
    serializeIntent: (intent: T) => unknown
    deserializeIntent: (data: unknown) => T
  }
): Promise<PaymentIntentResolution<T>> {
  const existing = await client.query<{
    data: Record<string, unknown> | null
    idempotency_uuid: string | null
    idempotency_cart_hash: string | null
  }>(
    `SELECT data, idempotency_uuid, idempotency_cart_hash
       FROM payment_session
      WHERE id = $1
      FOR UPDATE`,
    [input.payment_session_id]
  )

  const row = existing.rows[0]
  if (
    row?.idempotency_uuid === input.idempotency_uuid &&
    row.idempotency_cart_hash === input.cart_hash &&
    row.data &&
    Object.prototype.hasOwnProperty.call(row.data, "payment_intent")
  ) {
    return {
      reused: true,
      payment_intent: input.deserializeIntent(row.data.payment_intent),
    }
  }

  const intent = await input.createIntent()
  await client.query(
    `UPDATE payment_session
        SET idempotency_uuid = $2,
            idempotency_cart_hash = $3,
            data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('payment_intent', $4::jsonb)
      WHERE id = $1`,
    [
      input.payment_session_id,
      input.idempotency_uuid,
      input.cart_hash,
      JSON.stringify(input.serializeIntent(intent)),
    ]
  )
  return { reused: false, payment_intent: intent }
}

export async function resolvePaymentSessionForCheckoutIdempotency<T>(
  client: CheckoutIdempotencyClient,
  input: {
    payment_collection_id: string
    idempotency_uuid: string
    cart_hash: string
    createSession: () => Promise<T>
    getSessionId: (session: T) => string
  }
): Promise<CheckoutPaymentSessionResolution<T>> {
  await client.query("BEGIN")
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`checkout-payment-session:${input.idempotency_uuid}`]
    )

    const existing = await client.query<T>(
      `SELECT *
         FROM payment_session
        WHERE payment_collection_id = $1
          AND idempotency_uuid = $2
          AND idempotency_cart_hash = $3
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.payment_collection_id, input.idempotency_uuid, input.cart_hash]
    )

    if (existing.rows[0]) {
      await client.query("COMMIT")
      return { reused: true, payment_session: existing.rows[0] }
    }

    const session = await input.createSession()
    await client.query(
      `UPDATE payment_session
          SET idempotency_uuid = $2,
              idempotency_cart_hash = $3,
              context = COALESCE(context, '{}'::jsonb) ||
                jsonb_build_object(
                  'gp_checkout_idempotency_uuid', $2::text,
                  'gp_checkout_cart_hash', $3::text
                )
        WHERE id = $1`,
      [input.getSessionId(session), input.idempotency_uuid, input.cart_hash]
    )
    await client.query("COMMIT")
    return { reused: false, payment_session: session }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw err
  }
}
