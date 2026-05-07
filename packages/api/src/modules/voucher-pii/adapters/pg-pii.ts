/**
 * pg-pii — Postgres adapter for VoucherPiiPort (cleanup-44 / TF-105).
 *
 * Manages the `voucher_recipient_pii` table. RLS is enforced by the
 * pool hook (lib/rls-pool-hook.ts): each connection receives
 * `SET app.market_id = '...'` before the query runs, so the RLS
 * policy on `voucher_recipient_pii` gates every SELECT/INSERT by
 * the current market. This adapter never sets GUC itself.
 *
 * Table was created by STORY-2-2 migration.
 */

import type { Knex } from "knex";
import { randomUUID } from "node:crypto";
import type { VoucherPiiPort } from "../ports";

export class PgVoucherPiiAdapter implements VoucherPiiPort {
  constructor(private readonly db: Knex) {}

  async insertRecipientPii(input: {
    market_id: string;
    entitlement_id: string;
    order_id: string;
    recipient_email: string | null;
    recipient_phone: string | null;
    locale: string;
    is_gift: boolean;
  }): Promise<{ recipient_pii_id: string }> {
    const [row] = await this.db("voucher_recipient_pii")
      .insert({
        id: randomUUID(),
        market_id: input.market_id,
        entitlement_id: input.entitlement_id,
        order_id: input.order_id,
        recipient_email: input.recipient_email,
        recipient_phone: input.recipient_phone,
        locale: input.locale,
        is_gift: input.is_gift,
        tombstoned: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning("id");

    return { recipient_pii_id: row.id ?? row };
  }

  async tombstoneByOrder(args: {
    market_id: string;
    order_id: string;
  }): Promise<{ rows_affected: number }> {
    const rows_affected = await this.db("voucher_recipient_pii")
      .where({ market_id: args.market_id, order_id: args.order_id })
      .update({ tombstoned: true, updated_at: new Date() });
    return { rows_affected };
  }

  async purgeByMarketBefore(args: {
    market_id: string;
    cutoff: Date;
    batch_size: number;
  }): Promise<{ rows_deleted: number }> {
    const rows_deleted = await this.db("voucher_recipient_pii")
      .where({ market_id: args.market_id, tombstoned: true })
      .where("created_at", "<", args.cutoff)
      .limit(args.batch_size)
      .delete();
    return { rows_deleted };
  }

  async cleanupOrphans(args: {
    batch_size: number;
  }): Promise<{ rows_deleted: number }> {
    const rows_deleted = await this.db("voucher_recipient_pii as p")
      .whereNotExists(
        this.db("voucher_pii_consent_audit as a")
          .select("a.id")
          .whereRaw("a.payload->>'recipient_pii_id' = p.id::text")
          .limit(1)
      )
      .where("p.tombstoned", true)
      .limit(args.batch_size)
      .delete();
    return { rows_deleted };
  }
}
