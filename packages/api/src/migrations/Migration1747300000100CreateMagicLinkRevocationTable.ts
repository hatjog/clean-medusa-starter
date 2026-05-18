// AUTHORED in Epic 0 Story 0.18; APPLIED in Epic 1/2 per sprint plan
// Source: specs/releases/v1.8.0/architecture.md F-NEW-D3 + F-NEW-L1 (explicit DDL) + F-NEW-J2 (migration naming)
//
// Authored-not-applied staging location: specs/releases/v1.8.0/ddl/
// Apply target (Epic 2 — magic link revocation, security hardening):
//   GP/backend/packages/api/src/modules/auth/migrations/Migration<ts>.ts
//   (per architecture.md project-structure: modules/auth/migrations/ +
//    new model magic_link_revocation.ts in modules/auth/models/;
//    if Epic 2 lands it under the voucher module per F-NEW-Q4 module decision,
//    copy verbatim into that module's migrations/ dir instead — DDL unchanged).
// When the Epic 2 story applies this, copy verbatim into the GP/backend submodule.
// The submodule is NOT touched by Story 0.18 (Sprint 0).
//
// F-NEW-D3 rationale: 7d magic-link recovery token leak (email client compromise
// / device theft) = 7-day attack window. JWT_SECRET rotation breaks ALL active
// tokens (collateral damage). Mitigation: per-token revocation list keyed by JWT
// `jti` claim — checked before accepting a magic link in the landing handler.
// reason CHECK enumerates the 4 revocation triggers; revoked_by is the
// customer_id or admin_user_id (NULL for auto_expired / security_response).

import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration1747300000100 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS magic_link_revocation (
        token_jti    TEXT PRIMARY KEY,
        revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        reason       TEXT NOT NULL CHECK (reason IN ('user_revoke', 'admin_revoke', 'auto_expired', 'security_response')),
        revoked_by   TEXT NULL              -- customer_id or admin_user_id
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_revocation_revoked_at_idx
        ON magic_link_revocation (revoked_at DESC)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS magic_link_revocation_revoked_at_idx`)
    this.addSql(`DROP TABLE IF EXISTS magic_link_revocation`)
  }
}
