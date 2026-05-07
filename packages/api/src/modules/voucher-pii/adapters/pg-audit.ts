/**
 * pg-audit — Postgres adapter for AuditChainPort (cleanup-44 / TF-105).
 *
 * Writes D-67 tamper-evident audit rows to `voucher_pii_consent_audit`.
 * prev_row_hash is resolved from the same (market_id, hour_bucket) shard
 * before each INSERT — per D-67 sharding design so chain replay stays
 * tractable without full table scan.
 *
 * RLS enforced by pool hook: see pg-pii.ts note.
 * Table created by STORY-2-2 migration.
 */

import type { Knex } from "knex";
import { randomUUID } from "node:crypto";
import { computeRowHash } from "../../../lib/audit-hash-chain";
import type { ConsentStateSnapshot } from "../types";
import type { AuditChainPort } from "../ports";

/** Hour bucket key for shard resolution — ISO-8601 hour UTC. */
function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // "2026-05-07T14"
}

export class PgAuditAdapter implements AuditChainPort {
  constructor(private readonly db: Knex) {}

  async appendAuditRow(args: {
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<{ audit_id: string }> {
    const bucket = hourBucket();

    // Resolve previous row hash for this shard.
    const prevRow = await this.db("voucher_pii_consent_audit")
      .select("current_row_hash")
      .where({ market_id: args.market_id, hour_bucket: bucket })
      .orderBy("created_at", "desc")
      .first();

    const prevHash = prevRow?.current_row_hash
      ? Buffer.from(prevRow.current_row_hash, "hex")
      : null;

    const currentHash = computeRowHash(prevHash, args.payload);
    const id = randomUUID();

    await this.db("voucher_pii_consent_audit").insert({
      id,
      market_id: args.market_id,
      hour_bucket: bucket,
      payload: JSON.stringify(args.payload),
      prev_row_hash: prevHash?.toString("hex") ?? null,
      current_row_hash: currentHash.toString("hex"),
      created_at: new Date(),
    });

    return { audit_id: id };
  }

  async getLatestForOrder(args: {
    market_id: string;
    order_id: string;
  }): Promise<ConsentStateSnapshot | null> {
    const row = await this.db("voucher_pii_consent_audit")
      .where({ market_id: args.market_id })
      .whereRaw("payload->>'order_id' = ?", [args.order_id])
      .orderBy("created_at", "desc")
      .first();

    if (!row) return null;

    const payload =
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;

    return {
      consent_audit_id: row.id,
      market_id: row.market_id,
      order_id: args.order_id,
      audit_confirmed: payload?.action !== "WITHDRAWN",
      created_at: row.created_at,
    };
  }

  async readAfterWrite(args: {
    consent_audit_id: string;
  }): Promise<ConsentStateSnapshot | null> {
    const row = await this.db("voucher_pii_consent_audit")
      .where({ id: args.consent_audit_id })
      .first();

    if (!row) return null;

    const payload =
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;

    const withdrawn = payload?.action === "WITHDRAWN";
    if (withdrawn) return null;

    return {
      consent_audit_id: row.id,
      market_id: row.market_id,
      order_id: payload?.order_id ?? null,
      audit_confirmed: true,
      created_at: row.created_at,
    };
  }
}
