-- Fixture Story 11.1: legacy provenance unknown is intentionally never assigned.
INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key)
VALUES ('story-11-1-unknown', 'issued', 1779015999999, 'story-11-1-unknown-purchase');
