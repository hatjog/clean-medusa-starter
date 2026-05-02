-- Seed BonBeauty sellers (city-beauty, kremidotyk) into Mercur DB.
-- Run: docker exec gp-postgres-1 psql -U postgres -d gp_mercur -f /path/to/seed-bonbeauty-sellers.sql
-- Or pipe: cat seed-bonbeauty-sellers.sql | docker exec -i gp-postgres-1 psql -U postgres -d gp_mercur
--
-- Upsert: ON CONFLICT updates all fields from config source of truth.
-- Source of truth: GP/config/gp-dev/markets/bonbeauty/market.yaml

INSERT INTO public.seller (id, name, handle, description, address_line, city, postal_code, country_code, tax_id, email, phone, store_status)
VALUES
  ('sel_01CITYBEAUTY00000000000', 'City Beauty', 'city-beauty',
   'Kosmetologia estetyczna, pielęgnacja twarzy, brwi i rzęsy, makijaż okolicznościowy, manicure/pedicure.',
   'ul. Popularna 62A', 'Warszawa', '02-473', 'PL', '5223202513', 'citybeauty@cityclinic.pl', '+48000000000', 'ACTIVE'),
  ('sel_01KREMIDOTYK000000000000', 'KREM i DOTYK', 'kremidotyk',
   'Masaże ciała, pielęgnacja i regeneracja skóry, rytuały SPA, drenaż limfatyczny, aromaterapia.',
   'ul. Kolorowa 19/155', 'Warszawa', '02-495', 'PL', '5223350857', 'kontakt@kremidotyk.pl', '+48000000000', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET
  name          = EXCLUDED.name,
  handle        = EXCLUDED.handle,
  description   = EXCLUDED.description,
  address_line  = EXCLUDED.address_line,
  city          = EXCLUDED.city,
  postal_code   = EXCLUDED.postal_code,
  country_code  = EXCLUDED.country_code,
  tax_id        = EXCLUDED.tax_id,
  email         = EXCLUDED.email,
  phone         = EXCLUDED.phone,
  store_status  = EXCLUDED.store_status;
