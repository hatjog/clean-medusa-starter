-- STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA — vendor_offer table (v1.5.0 schema-only)
--
-- @see ADR-070 — Multi-vendor-per-product foundation promotion + vendor selection policy.
-- @see _bmad-output/implementation-artifacts/v150/STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA.md
--
-- v1.5.0 scope (this migration):
--   - CREATE TABLE vendor_offer with (vendor_id, product_id, price, seat_capacity,
--     status, incumbent_marker, signature, version) per AC-MVF-4.1-01..06.
--   - All FKs are tightly bound; the cart_item.selected_vendor_offer_id FK is
--     created in a SEPARATE migration (1777504098_cart_item_selected_vendor_offer.sql)
--     and is INTENTIONALLY NULLABLE per ADR-070 schema-only enforcement.
--   - Optimistic locking: `version` column (integer, default 0) — every UPDATE
--     in vendor-offer.service.ts MUST bump this with a `WHERE version = $expected`
--     guard.
--   - Lifecycle states: 'active' | 'suspended' | 'archived' enforced via CHECK
--     (see vendor-offer/lifecycle.ts for the state machine). NIE soft-delete
--     per ADR-074 tri-state.
--   - incumbent_marker BOOLEAN: denormalized convenience column. Per Security
--     Audit elicitation #23, the column requires a separately documented
--     DB-role permission grant before any runtime path may toggle it. v1.5.0
--     write path is service-layer guarded; v1.6.0 introduces role-grant.
--
-- v1.6.0+ scope (NOT in this migration):
--   - Flag flip `multi_vendor_pricing_enabled=true`.
--   - cart_item.selected_vendor_offer_id NOT NULL constraint via STORY-MIG-C3
--     zero-violations gate (see _grow/tools/validate_mig_c3_orphan_vendor_offer_refs.py).
--
-- Rollback: down() drops vendor_offer table; cart_item FK migration must be
-- rolled back FIRST (separate migration boundary).
--
-- Refs: ADR-070 §"Konsekwencje", AC-MVF-4.1-01..06, D-78 (per-offer signature gate).

BEGIN;

CREATE TABLE IF NOT EXISTS vendor_offer (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id          UUID NOT NULL,
    product_id         UUID NOT NULL,
    price              NUMERIC(18, 4) NOT NULL CHECK (price >= 0),
    seat_capacity      INTEGER NOT NULL CHECK (seat_capacity >= 0),
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'archived')),
    incumbent_marker   BOOLEAN NOT NULL DEFAULT FALSE,
    signature          TEXT NOT NULL,
    version            INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at        TIMESTAMPTZ NULL
);

-- Per-product per-vendor uniqueness — prevents duplicate offers for the same
-- (vendor_id, product_id) tuple. v1.6.0 multi-vendor activation reads this
-- index for the selection mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_offer_vendor_product_unique_idx
    ON vendor_offer (vendor_id, product_id)
    WHERE status <> 'archived';

-- Selection policy lookup index (PDP / cart paths in v1.6.0 runtime).
CREATE INDEX IF NOT EXISTS vendor_offer_product_status_idx
    ON vendor_offer (product_id, status);

-- Incumbent fast-path: the flag-off behavior preserving query
-- (`SELECT * FROM vendor_offer WHERE product_id = $1 AND incumbent_marker = TRUE`).
CREATE INDEX IF NOT EXISTS vendor_offer_incumbent_idx
    ON vendor_offer (product_id)
    WHERE incumbent_marker = TRUE;

-- D-78 per-offer signature uniqueness within a vendor. Required for MoR
-- runtime per-offer signature gate (validate_mor_per_offer_capability.py).
CREATE UNIQUE INDEX IF NOT EXISTS vendor_offer_vendor_signature_unique_idx
    ON vendor_offer (vendor_id, signature)
    WHERE status <> 'archived';

COMMIT;
