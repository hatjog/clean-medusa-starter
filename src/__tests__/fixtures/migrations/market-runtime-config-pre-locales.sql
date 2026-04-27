-- STORY-MIG-A — pre-locales fixture for migration tests (R3-AI-06).
-- Represents the v1.3 shape of `market_runtime_config` (no `locales` column,
-- 5 markets matching the v1.4.0 fixture set under gp-ops/markets/).
--
-- Used by:
--   - locales-roundtrip.test.ts (up → down → up invariants)
--   - locales-concurrent-write.test.ts (parallel writers during backfill)
--   - locales-rollback-partial.test.ts (down() after partial backfill)
--
-- Notes:
--   - The shape mirrors what existed in production immediately before
--     STORY-MIG-A; only the columns the tests touch are present.
--   - Markets carry `supported_locales` (legacy BCP-47 array) but NOT yet
--     a structured `locales` block — that's exactly the migration gap.

DROP TABLE IF EXISTS market_runtime_config;

CREATE TABLE market_runtime_config (
  market_id           text PRIMARY KEY,
  status              text NOT NULL,
  version             text NOT NULL,
  currency            text NOT NULL,
  supported_locales   jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO market_runtime_config (market_id, status, version, currency, supported_locales)
VALUES
  ('bonbeauty',   'published', '1.3.2', 'PLN', '["pl-PL"]'::jsonb),
  ('bonevent',    'draft',     '1.0.0', 'PLN', '["pl-PL"]'::jsonb),
  ('bongarden',   'draft',     '1.0.0', 'PLN', '["pl-PL"]'::jsonb),
  ('mercur',      'draft',     '1.0.0', 'EUR', '["nl-BE","de-DE","da-DK","sv-SE"]'::jsonb),
  ('testmarketb', 'draft',     '1.0.0', 'PLN', '["pl-PL"]'::jsonb);
