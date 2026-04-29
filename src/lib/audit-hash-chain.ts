import { createHash } from "node:crypto";

/**
 * audit-hash-chain — D-67 + ADR-078 tamper-evident audit log helper.
 *
 * Computes per-row chain hashes:
 *   current_row_hash = SHA256(prev_row_hash || canonical_json(payload))
 *
 * Per-shard scope: prev hash MUST come from the same `(market_id, hour_bucket)`
 * shard. Cross-shard chain reconstruction would defeat the sharding throughput
 * design (D-67 hash chain sharding pattern). The INSERT-path caller looks up
 * the prev hash via `SELECT current_row_hash FROM voucher_pii_consent_audit
 * WHERE market_id = $1 AND hour_bucket = $2 ORDER BY created_at DESC LIMIT 1`.
 *
 * Canonicalisation contract — DO NOT CHANGE without ADR review:
 *   - Sorted keys (lexicographic UTF-8 ordering).
 *   - No insignificant whitespace.
 *   - UTF-8 encoded bytes.
 *   - Mirrored by Python `_grow/tools/validate_audit_table_convention.py
 *     :: canonical_payload_bytes`.
 *
 * Risk #1 (FM-67-1) — canonicaliser drift breaks chain replay en-masse. The
 * pinned-hash unit test fixture (`hash-chain.test.ts :: pinned chain hash`)
 * is the canary — any change here that flips the pinned hash MUST be
 * accompanied by an ADR and a coordinated chain-restamp migration.
 *
 * Refs:
 *   - D-67 (architecture.md L424-434)
 *   - ADR-078 (specs/adr/2026-04-29-adr-078-tamper-evident-audit-log.md)
 *   - Pattern doc (_grow/patterns/tamper-evidence-audit.md §canonicaliser)
 */

/** Empty buffer used when prev_row_hash is NULL (first row in shard). */
const EMPTY_PREV_HASH = Buffer.alloc(0);

/** Stable JSON canonicalisation: sorted keys, no whitespace, UTF-8 bytes. */
export function canonicalPayloadBytes(payload: unknown): Buffer {
  return Buffer.from(canonicalJsonString(payload), "utf8");
}

/** Canonical JSON string — exposed for tests + cross-language equivalence. */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonString).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((key) => {
    const v = (value as Record<string, unknown>)[key];
    return JSON.stringify(key) + ":" + canonicalJsonString(v);
  });
  return "{" + parts.join(",") + "}";
}

/**
 * Compute the SHA-256 row hash for an audit row.
 *
 * @param prevHash - prev_row_hash from the same shard, or null for the first row.
 * @param payload  - the row's payload object (will be canonicalised before hashing).
 * @returns 32-byte SHA-256 digest (Buffer); persisted as `current_row_hash bytea`.
 */
export function computeRowHash(prevHash: Buffer | null, payload: unknown): Buffer {
  const hasher = createHash("sha256");
  hasher.update(prevHash ?? EMPTY_PREV_HASH);
  hasher.update(canonicalPayloadBytes(payload));
  return hasher.digest();
}

/**
 * Verify a single row's hash against (prev_hash, payload). Returns true iff
 * the recomputed hash matches the stored one.
 */
export function verifyRowHash(
  prevHash: Buffer | null,
  payload: unknown,
  storedHash: Buffer
): boolean {
  const expected = computeRowHash(prevHash, payload);
  return expected.equals(storedHash);
}

/**
 * Sequentially walk a shard's rows (already sorted by created_at ASC) and
 * verify the chain. Returns the first mismatch as `{ index, rowId, expected,
 * actual }` or null if the entire chain is valid.
 *
 * Used by the daily validation job (`audit-hash-chain-validate.ts`).
 */
export interface AuditRow {
  id: string;
  prev_row_hash: Buffer | null;
  current_row_hash: Buffer;
  payload: unknown;
}

export interface ChainBreakage {
  index: number;
  rowId: string;
  expected: Buffer;
  actual: Buffer;
}

export function validateShardChain(rows: readonly AuditRow[]): ChainBreakage | null {
  let prev: Buffer | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Cross-row link: prev_row_hash MUST equal the previous row's stored hash.
    if (i > 0 && (row.prev_row_hash === null || !row.prev_row_hash.equals(prev!))) {
      return {
        index: i,
        rowId: row.id,
        expected: prev ?? EMPTY_PREV_HASH,
        actual: row.prev_row_hash ?? EMPTY_PREV_HASH,
      };
    }
    if (i === 0 && row.prev_row_hash !== null && row.prev_row_hash.length > 0) {
      // First row in shard MUST have NULL prev_row_hash; non-null = drift.
      return {
        index: 0,
        rowId: row.id,
        expected: EMPTY_PREV_HASH,
        actual: row.prev_row_hash,
      };
    }

    const expected = computeRowHash(row.prev_row_hash, row.payload);
    if (!expected.equals(row.current_row_hash)) {
      return { index: i, rowId: row.id, expected, actual: row.current_row_hash };
    }
    prev = row.current_row_hash;
  }
  return null;
}
