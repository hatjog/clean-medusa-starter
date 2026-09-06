-- Fixture Story 11.1: legacy provenance unknown is intentionally never assigned.
INSERT INTO voucher_claim_audit (idempotency_key, code, ip, outcome, occurred_at)
VALUES ('story-11-1-unknown-audit', 'story-11-1-unknown-code', '127.0.0.1', 'invalid_code', NOW());

INSERT INTO voucher_claim_binding (idempotency_key, binding_hash, code, claimed_at, expires_at)
VALUES ('story-11-1-unknown-binding', 'story-11-1-unknown-hash', 'story-11-1-unknown-code', '2026-09-06T12:00:00Z', NOW() + interval '1 hour');

INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key)
VALUES ('story-11-1-unknown', 'issued', 1779015999999, 'story-11-1-unknown-purchase');
