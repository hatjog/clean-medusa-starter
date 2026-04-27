-- STORY-D66 — synthetic pre-v1.4.0 fixture for the MoR-snapshot backfill.
--
-- Loaded by the integration variant of `backfill-3-instances-*.test.ts` to
-- exercise the audit-flag preservation contract (AC #4 + AC #8) and the
-- concurrent-write contract (AC #9 / R3-AI-06).
--
-- The unit test suite injects rows in-memory via the test doubles in
-- backfill-3-instances-dry-run.test.ts; this fixture is the canonical
-- on-DB shape for integration runs once a Postgres test container is
-- available locally. Keep both representations in sync — drift here
-- breaks the dry-run plan output assertion.
--
-- Schema dependency: `event_store.payload_v2` lands via STORY-MIG-B and
-- `is_legacy_snapshot` flag flows through the MoR backfill chain. Ahead
-- of that landing this fixture is structurally complete; it MUST NOT be
-- loaded against a database missing the columns.

BEGIN;

-- Ensure a known clean slate for the synthetic ids.
DELETE FROM event_store
WHERE id LIKE 'd66-fixture-%';

-- =========================================================================
-- bonbeauty (production canary) — 12 rows total: mixed pre-v1.4.0 states.
-- =========================================================================

INSERT INTO event_store (id, instance_id, payload, payload_v2, is_legacy_snapshot, created_at) VALUES
  ('d66-fixture-bonbeauty-01', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{}'::jsonb,
    true,  '2026-04-01 10:00:00+00'),
  ('d66-fixture-bonbeauty-02', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{"sale_mor":"operator"}'::jsonb,
    true,  '2026-04-01 10:05:00+00'),
  ('d66-fixture-bonbeauty-03', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{"voucher_kind":"none"}'::jsonb,
    true,  '2026-04-01 10:10:00+00'),
  ('d66-fixture-bonbeauty-04', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{"sale_mor":"operator","service_mor":"operator"}'::jsonb,
    true,  '2026-04-01 10:15:00+00'),
  ('d66-fixture-bonbeauty-05', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{"mor_policy_version":"0.0.0-legacy-pre-1.4"}'::jsonb,
    true,  '2026-04-01 10:20:00+00'),
  ('d66-fixture-bonbeauty-06', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{}'::jsonb,
    true,  '2026-04-01 10:25:00+00'),
  ('d66-fixture-bonbeauty-07', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{}'::jsonb,
    true,  '2026-04-01 10:30:00+00'),
  ('d66-fixture-bonbeauty-08', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{}'::jsonb,
    true,  '2026-04-01 10:35:00+00'),
  ('d66-fixture-bonbeauty-09', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{}'::jsonb,
    true,  '2026-04-01 10:40:00+00'),
  ('d66-fixture-bonbeauty-10', 'bonbeauty',
    '{"event":"order.placed","v":1}'::jsonb,
    '{}'::jsonb,
    true,  '2026-04-01 10:45:00+00'),
  -- Concurrent-write probes (NEW v1.4.0+ rows already carrying complete MoR
  -- snapshots from the P-01 ownership-lock writers — must NOT be modified).
  ('d66-fixture-bonbeauty-fresh-01', 'bonbeauty',
    '{"event":"order.placed","v":2}'::jsonb,
    '{"sale_mor":"vendor","service_mor":"vendor","mor_policy_version":"1.4.0","voucher_kind":"spv","breakage_policy_snapshot":{"policy_id":"v1.4.0-prod","settlement_profile":"per_redemption"}}'::jsonb,
    false, '2026-04-26 12:00:00+00'),
  ('d66-fixture-bonbeauty-fresh-02', 'bonbeauty',
    '{"event":"order.placed","v":2}'::jsonb,
    '{"sale_mor":"operator","service_mor":"vendor","mor_policy_version":"1.4.0","voucher_kind":"mpv","breakage_policy_snapshot":{"policy_id":"v1.4.0-prod","settlement_profile":"monthly"}}'::jsonb,
    false, '2026-04-26 12:01:00+00');

-- =========================================================================
-- mercur (sandbox) — 11 rows.
-- =========================================================================

INSERT INTO event_store (id, instance_id, payload, payload_v2, is_legacy_snapshot, created_at) VALUES
  ('d66-fixture-mercur-01', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:00:00+00'),
  ('d66-fixture-mercur-02', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{"sale_mor":"operator"}'::jsonb,
    true,  '2026-04-02 09:05:00+00'),
  ('d66-fixture-mercur-03', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:10:00+00'),
  ('d66-fixture-mercur-04', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:15:00+00'),
  ('d66-fixture-mercur-05', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:20:00+00'),
  ('d66-fixture-mercur-06', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:25:00+00'),
  ('d66-fixture-mercur-07', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:30:00+00'),
  ('d66-fixture-mercur-08', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:35:00+00'),
  ('d66-fixture-mercur-09', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:40:00+00'),
  ('d66-fixture-mercur-10', 'mercur', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-02 09:45:00+00'),
  ('d66-fixture-mercur-fresh-01', 'mercur', '{"event":"order.placed","v":2}'::jsonb,
    '{"sale_mor":"vendor","service_mor":"vendor","mor_policy_version":"1.4.0","voucher_kind":"spv","breakage_policy_snapshot":{"policy_id":"v1.4.0-sandbox","settlement_profile":"per_redemption"}}'::jsonb,
    false, '2026-04-26 13:00:00+00');

-- =========================================================================
-- testmarketb (test data) — 11 rows.
-- =========================================================================

INSERT INTO event_store (id, instance_id, payload, payload_v2, is_legacy_snapshot, created_at) VALUES
  ('d66-fixture-testmarketb-01', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:00:00+00'),
  ('d66-fixture-testmarketb-02', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{"voucher_kind":"none"}'::jsonb,
    true,  '2026-04-03 08:05:00+00'),
  ('d66-fixture-testmarketb-03', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:10:00+00'),
  ('d66-fixture-testmarketb-04', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:15:00+00'),
  ('d66-fixture-testmarketb-05', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:20:00+00'),
  ('d66-fixture-testmarketb-06', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:25:00+00'),
  ('d66-fixture-testmarketb-07', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:30:00+00'),
  ('d66-fixture-testmarketb-08', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:35:00+00'),
  ('d66-fixture-testmarketb-09', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:40:00+00'),
  ('d66-fixture-testmarketb-10', 'testmarketb', '{"event":"order.placed","v":1}'::jsonb, '{}'::jsonb,
    true,  '2026-04-03 08:45:00+00'),
  ('d66-fixture-testmarketb-fresh-01', 'testmarketb', '{"event":"order.placed","v":2}'::jsonb,
    '{"sale_mor":"operator","service_mor":"operator","mor_policy_version":"1.4.0","voucher_kind":"none","breakage_policy_snapshot":{"policy_id":"v1.4.0-test","settlement_profile":"per_redemption"}}'::jsonb,
    false, '2026-04-26 14:00:00+00');

COMMIT;
