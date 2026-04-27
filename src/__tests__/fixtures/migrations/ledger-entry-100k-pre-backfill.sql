-- STORY-MIG-C — synthetic pre-v1.4.0 fixture for ledger_entry backfill.
--
-- HYBRID FIXTURE FORMAT:
--   - This file ships the SCHEMA + a small static row sample (10 rows)
--     so it stays diff-friendly under git (<3KB).
--   - The 100k-row volume is generated PROCEDURALLY via the SQL block at
--     the bottom of this file (generate_series). This keeps the git
--     working tree small while still producing a 100k-row table for the
--     batched-backfill performance + concurrent-write integration tests.
--
-- Loaded by the integration variant of the ledger-posting-trigger-*.test.ts
-- suite once the staging Postgres container is online. The unit-test gate
-- runs in-memory via generators in the test files themselves (no SQL load).
--
-- Schema dependency: `ledger_entry` table is itself created by another
-- v1.4.0 migration (out of scope for STORY-MIG-C — the column landed by
-- this migration). This fixture assumes the table exists with at least
-- (id text PK, market_id text, amount_minor integer, currency text,
--  created_at timestamptz). Adapt to the actual schema once the
-- ledger_entry table-creation migration lands.
--
-- Pattern reference: src/__tests__/fixtures/scripts/backfill-pre-v140-snapshot.sql
-- (D-66 / STORY-D66 — same hybrid static + procedural layout).

BEGIN;

-- Clean slate for synthetic ids.
DELETE FROM ledger_entry WHERE id LIKE 'mig-c-fixture-%';

-- =========================================================================
-- Static sample (10 rows) — kept inline so reviewers can eyeball the shape.
-- Multiple market_ids exercise the multi-tenant property of the backfill.
-- =========================================================================
INSERT INTO ledger_entry (id, market_id, amount_minor, currency, created_at, posting_trigger) VALUES
  ('mig-c-fixture-bonbeauty-01',  'bonbeauty',   1500, 'PLN', '2025-12-01 10:00:00+00', NULL),
  ('mig-c-fixture-bonbeauty-02',  'bonbeauty',   2500, 'PLN', '2025-12-01 10:05:00+00', NULL),
  ('mig-c-fixture-bonbeauty-03',  'bonbeauty',  10000, 'PLN', '2025-12-01 10:10:00+00', NULL),
  ('mig-c-fixture-mercur-01',     'mercur',      5000, 'PLN', '2025-12-02 09:00:00+00', NULL),
  ('mig-c-fixture-mercur-02',     'mercur',      7500, 'PLN', '2025-12-02 09:05:00+00', NULL),
  ('mig-c-fixture-mercur-03',     'mercur',     12000, 'PLN', '2025-12-02 09:10:00+00', NULL),
  ('mig-c-fixture-testmarketb-01','testmarketb', 3000, 'PLN', '2025-12-03 08:00:00+00', NULL),
  ('mig-c-fixture-testmarketb-02','testmarketb', 4500, 'PLN', '2025-12-03 08:05:00+00', NULL),
  -- 2 already-fresh rows: writers landing post-column-add carry their own
  -- domain trigger value. These MUST NOT be touched by the backfill UPDATE.
  ('mig-c-fixture-fresh-01',      'bonbeauty',   2000, 'PLN', '2026-04-26 12:00:00+00', 'order_placed'),
  ('mig-c-fixture-fresh-02',      'mercur',      1000, 'PLN', '2026-04-26 12:00:00+00', 'refund');

-- =========================================================================
-- Procedural 100k-row generator — produces 100,000 NULL-trigger rows
-- distributed across 3 instances. Total fixture size after this block
-- runs: 100,010 rows (10 static + 100,000 generated).
--
-- DECISION (story T5.3): 100k rows generated procedurally rather than
-- shipped as a static SQL file because:
--   - Static 100k INSERT VALUES would balloon to ~6MB in git.
--   - generate_series is deterministic + idempotent (id includes the row
--     index, so re-running the fixture is safe).
--   - Reviewers can eyeball the static sample above without scrolling
--     through 100k inserts.
-- =========================================================================
INSERT INTO ledger_entry (id, market_id, amount_minor, currency, created_at, posting_trigger)
SELECT
  'mig-c-fixture-gen-' || lpad(i::text, 6, '0')                                                   AS id,
  CASE (i % 3) WHEN 0 THEN 'bonbeauty' WHEN 1 THEN 'mercur' ELSE 'testmarketb' END                AS market_id,
  1000 + (i % 9000)                                                                               AS amount_minor,
  'PLN'                                                                                            AS currency,
  '2025-01-01 00:00:00+00'::timestamptz + (i || ' minute')::interval                              AS created_at,
  NULL                                                                                             AS posting_trigger
FROM generate_series(1, 100000) AS s(i);

COMMIT;

-- =========================================================================
-- Sanity-check queries (run after fixture load):
--
--   SELECT COUNT(*)         FROM ledger_entry WHERE id LIKE 'mig-c-fixture-%';
--   -- expected: 100010
--
--   SELECT COUNT(*)         FROM ledger_entry WHERE id LIKE 'mig-c-fixture-%' AND posting_trigger IS NULL;
--   -- expected: 100008  (10 static + 100000 generated, minus 2 fresh rows)
--
--   SELECT market_id, COUNT(*) FROM ledger_entry WHERE id LIKE 'mig-c-fixture-gen-%' GROUP BY market_id;
--   -- expected: 3 rows, each ~33333 (rounded by mod-3 distribution)
-- =========================================================================
