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
 * Concurrency model (cleanup-36 review fix H1):
 *   - The handler RESERVES the idempotency slot via `reserveIdempotencySlot`
 *     BEFORE running side effects. This INSERT acts as a per-key lock — the
 *     DB UNIQUE constraint guarantees at most one writer.
 *   - On race-loss the loser receives the existing row (status="in_progress"
 *     or final). If still in progress, the loser returns 409 IN_FLIGHT so the
 *     client retries after the winner finalises.
 *   - On race-win the writer runs side effects then `finalizeIdempotencyRecord`
 *     UPDATES the row with the real status_code + response_body.
 *
 * Cross-vendor key collisions (review fix H2):
 *   - Keys are globally unique (UNIQUE on `idempotency_key` alone). When a
 *     reservation lookup returns a row whose vendor_id differs from the
 *     current request's path param, the caller MUST treat that as 422
 *     IDEMPOTENCY_KEY_REUSED_DIFFERENT_VENDOR rather than replaying.
 */

import { createHash } from "crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

const TABLE = "vendor_decision_idempotency"

/** UUIDv4 regex — strict enforcement per OQ #4. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Header value length cap (review fix L2). UUIDv4 is 36 chars. */
const MAX_KEY_LEN = 255

/** Sentinel hash used while a slot is reserved but not yet finalised. */
export const PENDING_HASH = "__pending__"

/** Sentinel status_code used while a slot is reserved but not yet finalised. */
export const PENDING_STATUS = 0

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
 * Header lookup is case-insensitive (review fix M4): Node normalises incoming
 * HTTP headers to lowercase, but middleware that exposes a `Headers`-like
 * object can preserve original case ("Idempotency-Key").
 *
 * Returns { ok: true, key } on success or { ok: false, statusCode, body } on
 * validation failure (missing / non-UUIDv4 value / over-length).
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): ExtractKeyResult {
  // Case-insensitive lookup (review fix M4).
  let raw: string | string[] | undefined = headers["idempotency-key"]
  if (raw === undefined) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "idempotency-key") {
        raw = headers[k]
        break
      }
    }
  }

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

  // Length cap before regex (review fix L2 — defence-in-depth).
  if (trimmed.length > MAX_KEY_LEN) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error_code: "INVALID_IDEMPOTENCY_KEY_FORMAT",
        hint: `Idempotency-Key must be ≤ ${MAX_KEY_LEN} characters`,
      },
    }
  }

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
 * always produces the same hash regardless of JSON key ordering. Object keys
 * whose values are `undefined` are skipped (review fix H3) — this matches
 * `JSON.stringify`'s own behaviour and prevents the canonicalisation drift
 * between `{a:1}` and `{a:1, b:undefined}`.
 */
export function hashRequestBody(body: Record<string, unknown>): string {
  const sorted = sortedJson(body)
  return createHash("sha256").update(sorted, "utf8").digest("hex")
}

function sortedJson(value: unknown): string {
  if (value === undefined) {
    // Top-level undefined never appears in valid object payloads, but be
    // defensive: emit JSON's null literal so the output stays valid JSON.
    return "null"
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : sortedJson(v))).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const sorted = Object.keys(obj)
    .filter((k) => obj[k] !== undefined) // review fix H3
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedJson(obj[k])}`)
    .join(",")
  return `{${sorted}}`
}

type Scope = { resolve: (key: string) => unknown }

function resolveDb(scope: Scope): Knex {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
}

/**
 * Look up an existing idempotency record by key only.
 *
 * Cross-vendor collisions (review fix H2): keys are globally unique, so the
 * lookup is by key alone. Callers MUST verify `record.vendor_id === requestVendorId`
 * before treating the row as a replay candidate; mismatches indicate
 * IDEMPOTENCY_KEY_REUSED_DIFFERENT_VENDOR (422).
 */
export async function findIdempotencyRecord(
  scope: Scope,
  idempotencyKey: string,
  /**
   * @deprecated kept for back-compat with tests; the lookup ignores it.
   * The caller MUST check `record.vendor_id` against the request's vendor_id.
   */
  _vendorIdIgnored?: string,
): Promise<{ found: true; record: IdempotencyRecord } | { found: false }> {
  const db = resolveDb(scope)
  const row = await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: idempotencyKey })
    .first()

  if (row) {
    return { found: true, record: row }
  }
  return { found: false }
}

export type ReserveResult =
  | { reserved: true; record: IdempotencyRecord }
  | { reserved: false; existing: IdempotencyRecord }

/**
 * Reserve an idempotency slot BEFORE running side effects (review fix H1).
 *
 * Performs an INSERT … ON CONFLICT DO NOTHING with sentinel `request_hash` and
 * `status_code = 0`. The race-winner sees `{ reserved: true, record }` and
 * MUST proceed to run side effects then call `finalizeIdempotencyRecord`. The
 * race-loser sees `{ reserved: false, existing }` and MUST inspect
 * `existing.status_code`:
 *   - `PENDING_STATUS` (0): the winner is still working → return 409 IN_FLIGHT.
 *   - any other value: the winner finalised → replay the cached response (after
 *     vendor_id and hash equality checks).
 */
export async function reserveIdempotencySlot(
  scope: Scope,
  input: {
    idempotencyKey: string
    vendorId: string
    requestHash: string
  },
): Promise<ReserveResult> {
  const db = resolveDb(scope)

  const [inserted] = await db<IdempotencyRecord>(TABLE)
    .insert({
      idempotency_key: input.idempotencyKey,
      vendor_id: input.vendorId,
      request_hash: PENDING_HASH,
      status_code: PENDING_STATUS,
      response_body: { request_hash: input.requestHash },
    })
    .onConflict("idempotency_key")
    .ignore()
    .returning("*")

  if (inserted) {
    return { reserved: true, record: inserted }
  }

  // Lost the race — re-read the winner.
  const existing = await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: input.idempotencyKey })
    .first()

  if (!existing) {
    throw new Error(
      "vendor_decision_idempotency: reserve insert-ignore returned no row and re-read also returned no row",
    )
  }
  return { reserved: false, existing }
}

/**
 * Finalize a previously-reserved idempotency slot (review fix H1).
 *
 * UPDATE the row with the real request_hash, status_code and response_body
 * after the side effects ran. This is unconditional — the caller already won
 * the reservation race.
 */
export async function finalizeIdempotencyRecord(
  scope: Scope,
  input: {
    idempotencyKey: string
    requestHash: string
    statusCode: number
    responseBody: Record<string, unknown>
  },
): Promise<IdempotencyRecord> {
  const db = resolveDb(scope)

  const [updated] = await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: input.idempotencyKey })
    .update({
      request_hash: input.requestHash,
      status_code: input.statusCode,
      // JSONB serialisation (review fix L3): pass plain objects; pg/knex stringify.
      response_body: input.responseBody,
    })
    .returning("*")

  if (!updated) {
    throw new Error(
      `vendor_decision_idempotency: finalize update returned no row for key=${input.idempotencyKey}`,
    )
  }
  return updated
}

/**
 * Drop a reservation when the request can be neither finalised nor cleanly
 * replayed (e.g. body validation failed AFTER reservation). Used so transient
 * failures do not leave orphaned PENDING rows that would 409-block legitimate
 * retries with the same key.
 */
export async function releaseReservation(
  scope: Scope,
  idempotencyKey: string,
): Promise<void> {
  const db = resolveDb(scope)
  await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: idempotencyKey, status_code: PENDING_STATUS })
    .delete()
}

/**
 * Persist the idempotency record after a successful operation.
 *
 * @deprecated Use `reserveIdempotencySlot` + `finalizeIdempotencyRecord`
 * instead. Retained for back-compat with existing tests; behaves as an
 * upsert: INSERT new row or, on conflict, UPDATE the existing row in place.
 *
 * Cross-vendor safety (review fix H2): the existing row's vendor_id is NOT
 * silently overwritten — if it does not match `input.vendorId`, this throws.
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

  // Race / pre-existing row — re-read.
  const existing = await db<IdempotencyRecord>(TABLE)
    .where({ idempotency_key: input.idempotencyKey })
    .first()

  if (!existing) {
    throw new Error(
      "vendor_decision_idempotency: insert-ignore returned no row and re-read also returned no row",
    )
  }

  // Cross-vendor collision (review fix H2): never silently return another
  // vendor's row to this caller.
  if (existing.vendor_id !== input.vendorId) {
    throw new Error(
      `vendor_decision_idempotency: idempotency_key=${input.idempotencyKey} already bound to vendor_id=${existing.vendor_id} (request was for vendor_id=${input.vendorId})`,
    )
  }

  // If the pre-existing row is a stale PENDING reservation, finalize it now.
  if (existing.status_code === PENDING_STATUS) {
    return finalizeIdempotencyRecord(scope, {
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      statusCode: input.statusCode,
      responseBody: input.responseBody,
    })
  }

  return existing
}
