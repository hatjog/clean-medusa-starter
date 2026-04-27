import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * STORY-MIG-B — OrderPlaced.v2 payload backfill (D-50 + D-58 + P-09).
 *
 * Adds a derived `payload_v2 jsonb` column to `event_store` and backfills it
 * from historical `gp.commerce.order_placed.v1` rows. The canonical `payload`
 * column is immutable history (per AC #6 of STORY-MIG-B); we never mutate it.
 *
 * Discriminator semantics (correction 2026-04-27):
 *   We key historical rows on `event_type = 'gp.commerce.order_placed.v1'`,
 *   NOT on a non-existent `event_version` column. The frozen schema's envelope
 *   discriminators are `event_type` (const `gp.commerce.order_placed.v2`) and
 *   `schema_version` (const `"2"`); historical rows carry the v1 event_type
 *   constant.
 *
 * Locales JOIN — graceful fallback (STORY-MIG-A coupling):
 *   STORY-MIG-A lands the `market_runtime_config.locales` JSONB column. This
 *   migration is written to land independent of MIG-A merge order:
 *     - If `market_runtime_config.locales` exists → JOIN populates
 *       `recipient_locale` from `mrc.locales->>'default'`.
 *     - If the column does not yet exist (MIG-A not merged) → the JOIN UPDATE
 *       is a no-op (zero rows touched). Column is still added; backfill can
 *       be re-run after MIG-A lands via a follow-up `payload_v2 IS NULL`
 *       sweep, or via the operator-driven backfill script.
 *   We probe `information_schema.columns` for `market_runtime_config.locales`
 *   before issuing the JOIN UPDATE so a missing column does not abort the
 *   migration transaction.
 *
 * Concurrent-write contract (R3-AI-06):
 *   Backfill UPDATE is scoped by `WHERE es.payload_v2 IS NULL`, so concurrent
 *   v1 emissions racing the migration land without interfering with derived
 *   `payload_v2` computation; the next backfill iteration picks them up
 *   idempotently. Post-flag-on v2 emissions write `payload_v2` directly via
 *   the publisher, so the migration never overwrites them either.
 *
 * Down semantics (AC #7):
 *   `down()` explicitly drops `payload_v2`. The original `payload` column is
 *   not touched — its checksum is stable across up/down/up cycles.
 */
export class Migration20260427120000BackfillOrderPlacedV2Payload extends Migration {
  async up(): Promise<void> {
    // 1. Add nullable derived column (idempotent — coexists with manual
    //    pre-create scripts in dev environments).
    this.addSql(
      "ALTER TABLE event_store ADD COLUMN IF NOT EXISTS payload_v2 jsonb NULL"
    )

    // 2. Backfill derived shape ONLY when `market_runtime_config.locales`
    //    column exists (STORY-MIG-A landed). The DO block is a transaction-safe
    //    no-op when the column is missing — graceful fallback.
    //
    //    Backfill JOIN groups historical rows on `event_type = '<v1-id>'` and
    //    populates the legacy MoR placeholder per D-45 (legacy-pre-1.4 marker).
    //    `recipient_locale` is derived from `mrc.locales->>'default'`.
    //    `message_locale` is null per P-09 (UX exposure deferred to v1.5.0).
    //    `is_gift` is false on backfill (no historical gift signal carried by
    //    v1 payloads — v1.5.0 will refine via voucher-personalization join).
    this.addSql(`
      DO $mig$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_name = 'market_runtime_config'
             AND column_name = 'locales'
        ) THEN
          UPDATE event_store es
             SET payload_v2 = jsonb_build_object(
               'order_id',           es.payload->>'order_id',
               'currency',           COALESCE(es.payload->>'currency', 'PLN'),
               'total_amount_minor', COALESCE((es.payload->>'total_amount_minor')::int, 0),
               'line_items',         COALESCE(es.payload->'line_items', '[]'::jsonb),
               'mor', jsonb_build_object(
                 'sale_mor',           'operator',
                 'service_mor',        'operator',
                 'mor_policy_version', '0.0.0-legacy-pre-1.4',
                 'voucher_kind',       COALESCE(es.payload->>'voucher_kind', 'none'),
                 'breakage_policy_snapshot', jsonb_build_object(
                   'policy_id',         null,
                   'policy_version',    null,
                   'recognition_mode',  null,
                   'expiry_grace_days', null
                 )
               ),
               'recipient_locale', mrc.locales->>'default',
               'message_locale',   null,
               'is_gift',          false
             )
            FROM market_runtime_config mrc
           WHERE es.event_type = 'gp.commerce.order_placed.v1'
             AND mrc.market_id = es.payload->>'market_id'
             AND es.payload_v2 IS NULL;
        END IF;
      END
      $mig$;
    `)
  }

  async down(): Promise<void> {
    // EXPLICIT — drop derived column. Original `payload` untouched (immutable
    // history per AC #7).
    this.addSql("ALTER TABLE event_store DROP COLUMN IF EXISTS payload_v2")
  }
}
