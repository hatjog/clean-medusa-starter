-- STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA — cart_item.selected_vendor_offer_id FK (v1.5.0 schema-only)
--
-- @see ADR-070 — schema additive in v1.5.0; runtime activation in v1.6.0.
-- @see _bmad-output/implementation-artifacts/v150/STORY-MIG-C3-stabilization-window.md
--      — pre-req for v1.6.0 NOT NULL promotion.
--
-- HARD CONSTRAINT (per ADR-070 + AC-MVF-4.1-08):
--   selected_vendor_offer_id MUST be NULLABLE in v1.5.0. NOT NULL is DEFERRED
--   to v1.6.0 STORY-MIG-C3 zero-violations gate. ANY agent attempting to add
--   NOT NULL here MUST stop and re-read ADR-070 §Decyzja Opcja B.
--
-- v1.5.0 behavior (flag-off, multi_vendor_pricing_enabled=false):
--   - selected_vendor_offer_id IS NULL for every cart_item (single-vendor
--     preservation per AC-MV-FLAG-OFF-01/02).
--   - The MIG-C3 validator runs WARN daily, scans for orphan rows
--     (selected_vendor_offer_id IS NULL AND product is multi-vendor) and
--     persists reports in _grow/reports/mig-c3-WARN-*.json.
--
-- v1.6.0 follow-up (NOT in this migration):
--   - ALTER COLUMN ... SET NOT NULL once MIG-C3 reports zero violations across
--     ≥1 sprint stabilization window (per STORY-MIG-C3 AC-MIG-C3-02).
--
-- Refs: ADR-070, AC-MVF-4.1-04, AC-MVF-4.1-08.

BEGIN;

ALTER TABLE cart_item
    ADD COLUMN IF NOT EXISTS selected_vendor_offer_id UUID NULL;

ALTER TABLE cart_item
    ADD CONSTRAINT cart_item_selected_vendor_offer_fk
    FOREIGN KEY (selected_vendor_offer_id)
    REFERENCES vendor_offer (id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

-- Sparse index — only carts that opt into multi-vendor (post v1.6.0 flag flip)
-- pay the index maintenance cost. Flag-off rows have NULL FK and are excluded.
CREATE INDEX IF NOT EXISTS cart_item_selected_vendor_offer_id_idx
    ON cart_item (selected_vendor_offer_id)
    WHERE selected_vendor_offer_id IS NOT NULL;

COMMIT;
