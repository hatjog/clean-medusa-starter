import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 6.1 (v1.12.0) — durable claim-route store.
 *
 * ADR-142 ustanawia PG-backed replay/audit store dla /store/vouchers/:code/claim.
 * `voucher_claim_binding` klonuje wzorzec `ledger_posting_applied`: PK po
 * idempotency_key i INSERT-first `ON CONFLICT DO NOTHING`. `response_*` trzyma
 * pierwotną odpowiedź route, żeby replay po restarcie/cross-instance zwracał ten
 * sam kontrakt bez drugiej mutacji. `voucher_claim_audit` jest append-only.
 *
 * `down()` jest non-destrukcyjny: historia claim/audit nie jest kasowana przez
 * rollback, forward-fix pozostaje jedyną bezpieczną korektą danych.
 */
export class Migration1778931000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_claim_binding (
        idempotency_key text PRIMARY KEY,
        binding_hash    text NOT NULL CHECK (char_length(binding_hash) > 0),
        code            text NOT NULL CHECK (char_length(code) > 0),
        claimed_at      text NOT NULL CHECK (char_length(claimed_at) > 0),
        response_status integer NULL,
        response_body   jsonb NULL,
        expires_at      timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        updated_at      timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT voucher_claim_binding_response_pair
          CHECK (
            (response_status IS NULL AND response_body IS NULL)
            OR (response_status IS NOT NULL AND response_body IS NOT NULL)
          )
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_claim_binding_expires_at_idx
        ON voucher_claim_binding (expires_at)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_claim_binding_code_idx
        ON voucher_claim_binding (code)
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_claim_audit (
        audit_id        bigserial PRIMARY KEY,
        idempotency_key text NOT NULL,
        code            text NOT NULL,
        ip              text NOT NULL,
        outcome         text NOT NULL CHECK (outcome IN (
                          'ok',
                          'idempotent_replay',
                          'replay_tampered',
                          'rate_limited',
                          'invalid_code',
                          'expired',
                          'already_claimed'
                        )),
        occurred_at     timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT NOW()
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_claim_audit_idempotency_key_idx
        ON voucher_claim_audit (idempotency_key, created_at)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_claim_audit_code_idx
        ON voucher_claim_audit (code, created_at)
    `)
  }

  async down(): Promise<void> {
    // Intencjonalnie puste — claim audit/binding jest trwałym śladem operacyjnym.
  }
}
