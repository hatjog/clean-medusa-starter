-- STORY-MIG-B fixture — pre-v2 backfill snapshot of event_store.
--
-- Used by:
--   - src/__tests__/events/orderplaced-v2-roundtrip.test.ts
--   - src/__tests__/migrations/orderplaced-v2-concurrent-write.test.ts
--
-- Schema discriminator note (per STORY-MIG-B AC #6 + frozen schema):
--   Historical OrderPlaced rows carry `event_type = 'gp.commerce.order_placed.v1'`.
--   `event_version` is NOT a column in `event_store` — DO NOT add it.
--
-- Concurrent-write probe (R3-AI-06):
--   Rows tagged with idempotency_key starting `concurrent-probe-...` are the
--   N=20 parallel-publisher fixture. The migration's `WHERE payload_v2 IS NULL`
--   filter must skip rows that the concurrent publisher just wrote with
--   `payload_v2` already populated; this fixture exercises both paths.
--
-- Tenant matrix (compact — full 10k-row form lives in CI fixture if needed):
--   - bonbeauty-pl  (5 rows): mixed voucher_kind = MPV/SPV/none
--   - mercur-pl     (3 rows): voucher_kind = none
--   - testmarketb   (2 rows): voucher_kind = MPV
--   plus 5 concurrent-probe rows.
--
-- Test runner instantiates these via Jest's pg pool; SQL is plain ANSI +
-- PostgreSQL JSONB so it runs against any PG ≥ 14.

CREATE TABLE IF NOT EXISTS event_store (
  event_id              TEXT PRIMARY KEY,
  event_type            TEXT NOT NULL,
  schema_version        TEXT NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor                 TEXT NOT NULL,
  scope                 JSONB NOT NULL,
  idempotency_key       TEXT NOT NULL,
  payload               JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS market_runtime_config (
  market_id      TEXT PRIMARY KEY,
  locales        JSONB,
  feature_flags  JSONB
);

-- STORY-MIG-A simulated state (will be populated by MIG-A migration in real
-- deployments; the fixture seeds the JOIN target so MIG-B backfill can run).
INSERT INTO market_runtime_config (market_id, locales, feature_flags) VALUES
  ('bonbeauty-pl',  '{"default": "pl-PL", "supported": ["pl-PL", "en-GB"]}'::jsonb,
                    '{"orderplaced_v2_emission_enabled": false}'::jsonb),
  ('mercur-pl',     '{"default": "pl-PL", "supported": ["pl-PL"]}'::jsonb,
                    '{"orderplaced_v2_emission_enabled": false}'::jsonb),
  ('testmarketb',   '{"default": "en-GB", "supported": ["en-GB"]}'::jsonb,
                    '{"orderplaced_v2_emission_enabled": true}'::jsonb)
ON CONFLICT (market_id) DO NOTHING;

-- bonbeauty-pl historical v1 rows
INSERT INTO event_store (event_id, event_type, schema_version, actor, scope, idempotency_key, payload) VALUES
  ('01J_FIX_BB_001', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "bonbeauty-pl"}'::jsonb,
   'order:bb-001',
   '{"order_id": "bb-001", "market_id": "bonbeauty-pl", "currency": "PLN", "total_amount_minor": 19900, "voucher_kind": "MPV", "line_items": [{"line_item_id": "li_001", "offer_id": "offer_a", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 19900, "quantity": 1, "total_amount_minor": 19900}}]}'::jsonb),
  ('01J_FIX_BB_002', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "bonbeauty-pl"}'::jsonb,
   'order:bb-002',
   '{"order_id": "bb-002", "market_id": "bonbeauty-pl", "currency": "PLN", "total_amount_minor": 35000, "voucher_kind": "SPV", "line_items": [{"line_item_id": "li_001", "offer_id": "offer_b", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 35000, "quantity": 1, "total_amount_minor": 35000}}]}'::jsonb),
  ('01J_FIX_BB_003', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "bonbeauty-pl"}'::jsonb,
   'order:bb-003',
   '{"order_id": "bb-003", "market_id": "bonbeauty-pl", "currency": "PLN", "total_amount_minor": 12900, "voucher_kind": "none", "line_items": [{"line_item_id": "li_001", "offer_id": "offer_c", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 12900, "quantity": 1, "total_amount_minor": 12900}}]}'::jsonb);

-- mercur-pl historical v1 rows
INSERT INTO event_store (event_id, event_type, schema_version, actor, scope, idempotency_key, payload) VALUES
  ('01J_FIX_MR_001', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "mercur-pl"}'::jsonb,
   'order:mr-001',
   '{"order_id": "mr-001", "market_id": "mercur-pl", "currency": "PLN", "total_amount_minor": 24500, "line_items": [{"line_item_id": "li_001", "offer_id": "offer_d", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 24500, "quantity": 1, "total_amount_minor": 24500}}]}'::jsonb),
  ('01J_FIX_MR_002', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "mercur-pl"}'::jsonb,
   'order:mr-002',
   '{"order_id": "mr-002", "market_id": "mercur-pl", "currency": "PLN", "total_amount_minor": 9900, "line_items": [{"line_item_id": "li_001", "offer_id": "offer_e", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 9900, "quantity": 1, "total_amount_minor": 9900}}]}'::jsonb);

-- testmarketb historical v1 rows
INSERT INTO event_store (event_id, event_type, schema_version, actor, scope, idempotency_key, payload) VALUES
  ('01J_FIX_TM_001', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "testmarketb"}'::jsonb,
   'order:tm-001',
   '{"order_id": "tm-001", "market_id": "testmarketb", "currency": "GBP", "total_amount_minor": 5000, "voucher_kind": "MPV", "line_items": [{"line_item_id": "li_001", "offer_id": "offer_f", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "GBP", "unit_amount_minor": 5000, "quantity": 1, "total_amount_minor": 5000}}]}'::jsonb);

-- Concurrent-write probe rows (R3-AI-06): publishers race the migration. Each
-- probe row already has payload_v2 written by the publisher, so the migration
-- WHERE clause must skip them. The test asserts payload_v2 is NOT overwritten.
INSERT INTO event_store (event_id, event_type, schema_version, actor, scope, idempotency_key, payload) VALUES
  ('01J_FIX_CP_001', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "bonbeauty-pl"}'::jsonb,
   'concurrent-probe-001',
   '{"order_id": "cp-001", "market_id": "bonbeauty-pl", "currency": "PLN", "total_amount_minor": 1000, "line_items": [{"line_item_id": "li_001", "offer_id": "offer_x", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 1000, "quantity": 1, "total_amount_minor": 1000}}]}'::jsonb),
  ('01J_FIX_CP_002', 'gp.commerce.order_placed.v1', '1', 'end_customer',
   '{"instance_id": "gp-prod", "market_id": "bonbeauty-pl"}'::jsonb,
   'concurrent-probe-002',
   '{"order_id": "cp-002", "market_id": "bonbeauty-pl", "currency": "PLN", "total_amount_minor": 2000, "line_items": [{"line_item_id": "li_001", "offer_id": "offer_y", "offer_version": "1.0.0", "pricing_snapshot": {"currency": "PLN", "unit_amount_minor": 2000, "quantity": 1, "total_amount_minor": 2000}}]}'::jsonb);
