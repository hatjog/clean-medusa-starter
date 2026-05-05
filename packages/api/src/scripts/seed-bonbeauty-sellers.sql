-- Seed BonBeauty sellers (city-beauty, kremidotyk) into Mercur DB.
-- Run: docker exec gp-postgres-1 psql -U postgres -d gp_mercur -f /path/to/seed-bonbeauty-sellers.sql
-- Or pipe: cat seed-bonbeauty-sellers.sql | docker exec -i gp-postgres-1 psql -U postgres -d gp_mercur
--
-- Upsert: ON CONFLICT updates all fields from config source of truth.
-- Source of truth: GP/config/gp-dev/markets/bonbeauty/market.yaml

INSERT INTO public.seller (id, name, handle, description, email, phone, currency_code, status)
VALUES
  ('sel_01CITYBEAUTY00000000000', 'City Beauty', 'city-beauty',
   'Kosmetologia estetyczna, pielęgnacja twarzy, brwi i rzęsy, makijaż okolicznościowy, manicure/pedicure.',
   'citybeauty@cityclinic.pl', '+48000000000', 'pln', 'open'),
  ('sel_01KREMIDOTYK000000000000', 'KREM i DOTYK', 'kremidotyk',
   'Masaże ciała, pielęgnacja i regeneracja skóry, rytuały SPA, drenaż limfatyczny, aromaterapia.',
   'kontakt@kremidotyk.pl', '+48000000000', 'pln', 'open')
ON CONFLICT (id) DO UPDATE SET
  name          = EXCLUDED.name,
  handle        = EXCLUDED.handle,
  description   = EXCLUDED.description,
  email         = EXCLUDED.email,
  phone         = EXCLUDED.phone,
  currency_code = EXCLUDED.currency_code,
  status        = EXCLUDED.status;
