/**
 * Story v160-cleanup-36 — vendor decision endpoint idempotency helpers.
 *
 * Implements the Stripe-style Idempotency-Key pattern for POST
 * /admin/vendors/[id]/decision. All state is persisted in the
 * `vendor_decision_idempotency` table (DB-backed, survives restarts).
 *
 * OQ #1 (missing key): strict policy — 400 BAD_REQUEST.
 * OQ #2 (persistence): new `vendor_decision_idempotency` table (Option A).
 * OQ #4 (key format): UUIDv4 strict (regex validated).
 *
 * Semantics:
 *   - First request: executor() is called; result persisted; response returned.
 *   - Replay (same key + same hash): cached response returned; executor NOT called.
 *   - Key reuse with different body: 422 UNPROCESSABLE_ENTITY.
 *   - On conflict (concurrent insert race): DB UNIQUE constraint catches duplicate;
 *     caller receives cached row.
 */

import { createHash } from "crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

const TABLE = "vendor_decision_idempotency"

/** UUIDv4 regex — strict enforcement per OQ #4. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type IdempotencyRecord = {
  id: string
  idempotency_key: string
  vendor_id: string
  request_hash: string
  status_code: number
  response_body: Record<string, unknown>
  created_at: string
}

export type ExtractKeyResult =
  | { ok: true; key: string }
  | { ok: false; statusCode: 400; body: Record<string, unknown> }

/**
 * Extract and validate the Idempotency-Key header.
 *
 * Returns { ok: true, key } on success or { ok: false, statusCode, body } on
 * validation failure (missing / non-UUIDv4 value).
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): ExtractKeyResult {
  const raw = headers["idempotency-key"]
  const value = Array.isArray(raw) ? raw[0] : raw

  if (!value || value.trim().length === 0) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error_code: "MISSING_IDEMPOTENCY_KEY",
        hint: "include Idempotency-Key header (UUIDv4)",
      },
    }
  }

  const trimmed = value.trim()

  if (!UUID_V4_RE.test(trimmed)) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error_code: "INVALID_IDEMPOTENCY_KEY_FORMAT",
        hint: "Idempotency-Key must be a valid UUIDv4 (e.g. xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)",
      },
    }
  }

  return { ok: true, key: trimmed }
}

/**
 * Compute a stable SHA-256 hex hash of the request body.
 *
 * Keys are sorted before serialisation to ensure the same logical payload
 * always produces the same hash regardless of JSON key ordering.
 */
export function hashRequestBody(body: Record<string, unknown>): string {
  const sorted = sortedJson(body)
  return createHash("sha256").update(sorted, "utf8").digest("hex")
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(",")}]`
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`,
    )
    .join(",")
  return `{${sorted}}`
}

type Scope = { resolve: (key: string) => unknown }

function resolveDb(scope: Scope): Knex {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
}

export type FindOrCreateResult =
  | { cached: true; record: IdempotencyRecord }
  | { cached: false; record: null }
  | { conflict: true; body: Record<string, unknown> }

/**
 * Look up an existing idempotency record for (key, vendorId).
 *
 * Returns:
 *   - { cached: true, record } — record exists; check hash equality in caller.
 *   - { cached: false, record: null } — no record; caller should proceed with
 *     the real operation then call `persistIdempotencyRecord`.
 */
export async function findIdempotencyRecord(
  scope: Scope,
  idempotencyKey: string,
  vendorId: string,
): Promise<{ found: true; record: IdempotencyRecord } | { found: false }> {
  const db = resolveDb(scope)
  const row = await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: idempotencyKey, vendor_id: vendorId })
    .first()

  if (row) {
    return { found: true, record: row }
  }
  return { found: false }
}

/**
 * Persist the idempotency record after a successful operation.
 *
 * Uses INSERT … ON CONFLICT DO NOTHING so a concurrent first-writer wins;
 * the second call should re-read the row.  Returns the persisted (or
 * pre-existing) record.
 */
export async function persistIdempotencyRecord(
  scope: Scope,
  input: {
    idempotencyKey: string
    vendorId: string
    requestHash: string
    statusCode: number
    responseBody: Record<string, unknown>
  },
): Promise<IdempotencyRecord> {
  const db = resolveDb(scope)

  const [inserted] = await db<IdempotencyRecord>(TABLE)
    .insert({
      idempotency_key: input.idempotencyKey,
      vendor_id: input.vendorId,
      request_hash: input.requestHash,
      status_code: input.statusCode,
      response_body: input.responseBody,
    })
    .onConflict("idempotency_key")
    .ignore()
    .returning("*")

  if (inserted) {
    return inserted
  }

  // Race: another request won the INSERT; re-read the winner.
  const existing = await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: input.idempotencyKey })
    .first()

  if (!existing) {
    throw new Error(
      "vendor_decision_idempotency: insert-ignore returned no row and re-read also returned no row",
    )
  }

  return existing
}
