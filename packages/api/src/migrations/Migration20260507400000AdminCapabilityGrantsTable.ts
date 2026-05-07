import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-42 / TF-102 — Closes the TF-91/TF-92 capability pillar.
 *
 * Creates `admin_capability_grants` table and seeds a `__super_admin__`
 * capability for every existing admin user so that:
 *
 *   1. The DB-backed capability resolver in `capability-check.ts` grants
 *      all capabilities to existing admins without needing per-capability rows.
 *   2. The cleanup-37 override path (POST /admin/sellers/:id/pause with
 *      override=true requiring `vendor.lifecycle.override_training_cert`)
 *      continues to work for all existing admins — no regression.
 *   3. v1.7.0 admin UI can granularise by revoking `__super_admin__` and
 *      inserting targeted per-capability rows.
 *
 * Idempotent: `INSERT ... ON CONFLICT DO NOTHING` against the partial unique
 * index `(actor_id, capability) WHERE revoked_at IS NULL`.
 *
 * Reversible: `down()` drops the table.
 *
 * Decision notes:
 *   OQ #1 — new dedicated table (not extending Mercur 2 admin role table).
 *            Cleanest separation, smallest blast radius, easiest revocation audit.
 *            Mercur 2 does not expose a structured user.capabilities JSONB or
 *            analogous table — confirmed by codebase sweep (T1).
 *   OQ #2 — super-admin bypass via `__super_admin__` single row per admin.
 *            Simplifies v1.6.0 seed (one row vs N_admins × M_capabilities);
 *            semantically matches the outgoing "any admin → granted" stub.
 */
export class Migration20260507400000AdminCapabilityGrantsTable extends Migration {
  async up(): Promise<void> {
    // 1. Create the grants table.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS admin_capability_grants (
        id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        actor_id      text        NOT NULL,
        capability    text        NOT NULL,
        granted_at    timestamptz NOT NULL DEFAULT now(),
        granted_by    text        NULL,
        revoked_at    timestamptz NULL
      )
    `)

    // 2. Individual column indexes for range queries.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_admin_capability_grants_actor_id
        ON admin_capability_grants (actor_id)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_admin_capability_grants_capability
        ON admin_capability_grants (capability)
    `)

    // 3. Partial unique index: same actor cannot hold two active rows for the
    //    same capability, but CAN be re-granted after revocation (revoked_at IS NOT NULL
    //    rows are excluded from the uniqueness constraint).
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS admin_capability_grants_active_uq
        ON admin_capability_grants (actor_id, capability)
        WHERE revoked_at IS NULL
    `)

    // 4. Seed: every existing admin user gets the __super_admin__ capability.
    //    `granted_by = NULL` marks migration-seeded rows.
    //    Idempotent via ON CONFLICT DO NOTHING against the partial unique index.
    //    NOTE: The Medusa 2 / Mercur 2 admin user table is named "user".
    //    We select all non-deleted users from the Medusa auth identity table.
    //    Fallback: if the "user" table is empty (fresh DB), no rows are inserted —
    //    the runtime resolver falls back to the legacy behaviour until the first
    //    admin registers (at which point a follow-up seed script or v1.7.0 UI
    //    should grant `__super_admin__`).
    this.addSql(`
      INSERT INTO admin_capability_grants (actor_id, capability, granted_by)
      SELECT
        u.id          AS actor_id,
        '__super_admin__' AS capability,
        NULL          AS granted_by
      FROM "user" u
      WHERE u.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS admin_capability_grants`)
  }
}
