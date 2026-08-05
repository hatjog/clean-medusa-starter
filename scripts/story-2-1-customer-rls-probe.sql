-- story-2-1-customer-rls-probe.sql — kontrola dodatnia i negatywna nosnika
-- kontekstu systemowego NA REALNEJ TABELI `customer` (v1.15.0 Story 2.1, AC1/AC2;
-- review-fix HIGH-1).
--
-- ── Czego NIE dowodzila poprzednia kontrola ─────────────────────────────────
-- Dowod AC2 leci na tabeli-fixturze `gp_system_ctx_probe*`, ktora sonda tworzy
-- sama, z polityka, ktora sama pisze, i wstawia wiersz Z JUZ POPRAWNYM
-- `market_id`. Nie dotyka wiec ani tabeli `customer`, ani sytuacji, w ktorej
-- wiersz market_id JESZCZE nie ma — a to jest DOKLADNIE stan, w ktorym pracuje
-- jedyny realny konsument nosnika (`subscribers/customer-market-tagging.ts`).
--
-- ── Co ta sonda mierzy ──────────────────────────────────────────────────────
--   1. ZAPIS USTANAWIAJACY (wiersz bez `metadata.gp.market_id`) wykonany POD
--      rola `medusa_store` w kontekscie rynku trafia w ZERO wierszy — polityka
--      `market_isolation` (`USING metadata->'gp'->>'market_id' = ...`) czyni ten
--      wiersz niewidocznym, zanim trigger z migracji 010 zdazy zadzialac.
--      To jest defekt HIGH-1: gdyby subscriber robil ten zapis w kontekscie,
--      klient NIGDY nie zostalby otagowany i bylby odtad niewidoczny dla
--      KAZDEGO zapytania pod RLS.
--   2. Ten sam zapis wykonany POZA kontekstem (rola aplikacyjna) tagujе wiersz.
--   3. Po otagowaniu wiersz JEST widoczny w kontekscie swojego rynku
--      (kontrola dodatnia) i NIE JEST widoczny w kontekscie innego rynku
--      (kontrola negatywna) — czyli izolacja dziala na realnej tabeli.
--
-- Sonda dziala w TRANSAKCJI zakonczonej ROLLBACK-iem: nie zostawia wierszy.
--
-- Uruchomienie (docker-compose stack tego repo):
--   docker exec -i gp-postgres-1 psql -U postgres -d gp_mercur -v ON_ERROR_STOP=1 \
--     -f - < GP/backend/scripts/story-2-1-customer-rls-probe.sql
--
-- Exit != 0 = kontrola czerwona (RAISE EXCEPTION na koncu).

\set ON_ERROR_STOP on

BEGIN;

DO $probe$
DECLARE
  probe_id     text := 'cus_gp_story_2_1_probe';
  market       text := 'bonbeauty';
  other_market text := 'bonevent';
  affected     integer;
  visible      integer;
  tagged       text;
  failures     integer := 0;

  PROCEDURE_NOTE text;
BEGIN
  -- Punkt startowy: klient utworzony przez sciezke asynchroniczna, jeszcze bez
  -- `metadata.gp.market_id` (scoped-email niesie rynek, metadanych brak).
  RESET ROLE;
  PERFORM set_config('app.gp_market_id', '', false);
  DELETE FROM customer WHERE id = probe_id;
  INSERT INTO customer (id, email, has_account, metadata)
  VALUES (probe_id, market || '::story-2-1-probe@test.local', false, '{}'::jsonb);

  SELECT metadata->'gp'->>'market_id' INTO tagged FROM customer WHERE id = probe_id;
  IF tagged IS NOT NULL THEN
    RAISE NOTICE 'FAIL  punkt startowy: wiersz jest juz otagowany (%), sonda nie mierzy tego, co ma', tagged;
    failures := failures + 1;
  ELSE
    RAISE NOTICE 'PASS  punkt startowy: wiersz bez metadata.gp.market_id';
  END IF;

  -- (1) DEFEKT HIGH-1: zapis ustanawiajacy POD RLS trafia w zero wierszy.
  SET LOCAL ROLE medusa_store;
  PERFORM set_config('app.gp_market_id', market, false);
  UPDATE customer
     SET metadata = jsonb_build_object('gp', jsonb_build_object('market_id', market))
   WHERE id = probe_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RESET ROLE;

  IF affected = 0 THEN
    RAISE NOTICE 'PASS  zapis ustanawiajacy W KONTEKSCIE trafia w 0 wierszy (polityka market_isolation ukrywa wiersz bez market_id)';
  ELSE
    RAISE NOTICE 'FAIL  zapis ustanawiajacy W KONTEKSCIE trafil w % wierszy — polityka sie zmienila, przejrzyj subscriber', affected;
    failures := failures + 1;
  END IF;

  -- (2) Zapis ustanawiajacy POZA kontekstem — tak robi to subscriber po fixie.
  PERFORM set_config('app.gp_market_id', '', false);
  UPDATE customer
     SET metadata = jsonb_build_object('gp', jsonb_build_object('market_id', market))
   WHERE id = probe_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  SELECT metadata->'gp'->>'market_id' INTO tagged FROM customer WHERE id = probe_id;

  IF affected = 1 AND tagged = market THEN
    RAISE NOTICE 'PASS  zapis ustanawiajacy POZA kontekstem tagujе wiersz (market_id=%)', tagged;
  ELSE
    RAISE NOTICE 'FAIL  zapis ustanawiajacy POZA kontekstem nie zadzialal (rows=%, market_id=%)', affected, tagged;
    failures := failures + 1;
  END IF;

  -- (3a) KONTROLA DODATNIA: otagowany wiersz widoczny w kontekscie swojego rynku.
  SET LOCAL ROLE medusa_store;
  PERFORM set_config('app.gp_market_id', market, false);
  SELECT count(*) INTO visible FROM customer WHERE id = probe_id;
  RESET ROLE;

  IF visible = 1 THEN
    RAISE NOTICE 'PASS  kontrola dodatnia: wiersz widoczny w kontekscie %', market;
  ELSE
    RAISE NOTICE 'FAIL  kontrola dodatnia: wiersz NIEwidoczny w kontekscie % (count=%)', market, visible;
    failures := failures + 1;
  END IF;

  -- (3b) KONTROLA NEGATYWNA: niewidoczny w kontekscie innego rynku.
  SET LOCAL ROLE medusa_store;
  PERFORM set_config('app.gp_market_id', other_market, false);
  SELECT count(*) INTO visible FROM customer WHERE id = probe_id;
  RESET ROLE;

  IF visible = 0 THEN
    RAISE NOTICE 'PASS  kontrola negatywna: wiersz niewidoczny w kontekscie % (izolacja dziala)', other_market;
  ELSE
    RAISE NOTICE 'FAIL  kontrola negatywna: wiersz WIDOCZNY w kontekscie % — brak izolacji', other_market;
    failures := failures + 1;
  END IF;

  -- (4) Bez zadeklarowanego rynku kontekst nie jest dostepem do wszystkiego.
  SET LOCAL ROLE medusa_store;
  PERFORM set_config('app.gp_market_id', '', false);
  SELECT count(*) INTO visible FROM customer WHERE id = probe_id;
  RESET ROLE;

  IF visible = 0 THEN
    RAISE NOTICE 'PASS  brak zadeklarowanego rynku => zero wierszy (odmowa, nie dostep do wszystkiego)';
  ELSE
    RAISE NOTICE 'FAIL  brak zadeklarowanego rynku pokazal % wierszy', visible;
    failures := failures + 1;
  END IF;

  IF failures > 0 THEN
    RAISE EXCEPTION 'story-2-1-customer-rls-probe: % kontrol(a) czerwonych', failures;
  END IF;
  RAISE NOTICE 'OK    6/6 kontrol zielonych (transakcja zostanie wycofana)';
END
$probe$;

ROLLBACK;
