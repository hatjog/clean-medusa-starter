# MCP: Mercur backend (Medusa) — HTTP tools

Ten folder dodaje lokalny MCP server (Model Context Protocol), który udostępnia
narzędzia do wykonywania requestów HTTP do backendu Medusa (Mercur) w 2 scope'ach:

- `admin` — tylko ścieżki `/admin/*` i `/auth/user/*`
- `seller` — tylko ścieżki `/vendor/*` i `/auth/seller/*`

Nie ma tu dostępu do DB/Redis/FS — wyłącznie HTTP do Medusy.

## Uruchomienie

Z katalogu [GP/backend](../):

```bash
yarn mcp
```

### gp-config-mcp (Market Config Processor)

Nowe CLI do ładowania/eksportu konfiguracji marketu:

```bash
yarn gp-config-mcp \
  --instance-id gp-dev \
  --market-id mercur \
  --operation fill \
  --confirm
```

Obsługiwane operacje: `fill | overwrite | export | delete`.

- `overwrite` wymaga `--confirm` lub `--force`
- `delete` wymaga `--confirm` + potwierdzenia na stdin (lub `--force`)
- `--dry-run` wykonuje walidację i plan bez zapisu do DB
- `--db-url` nadpisuje `DATABASE_URL`
- domyślny `--config-root`: `GP/config`
- `export` zawiera dodatkowo `db_snapshot` z tabel market-scope wykrytych przez
  `metadata.gp_market_id` oraz powiązanych tabel przypisań kanałów
  (`product_sales_channel`, `publishable_api_key_sales_channel`,
  `sales_channel_stock_location`)
- `delete`/`overwrite` usuwają dane market-scope wykryte tym samym mechanizmem

Domyślny eksport zapisuje plik YAML do:

`GP/export/config/<instance_id>/markets/<market_id>/export-<timestamp>.yaml`

Domyślnie serwer odpytuje Medusę pod `http://localhost:9002`.
Możesz to zmienić zmienną środowiskową:

```bash
MCP_MEDUSA_BASE_URL=http://localhost:9002 yarn mcp
```

### gp-market-storefront-key (Option A helper)

CLI pomocnicze dla ADR-040 (Opcja A): zapewnia, że dany market ma **publishable API key**
przypięty do marketowego `sales_channel` (po `sales_channel.metadata.gp_market_id`).

Użycie (z katalogu `GP/backend`):

```bash
yarn gp-market-storefront-key \
  --market-id bonbeauty \
  --reveal-token
```

Uwagi:

- Domyślnie narzędzie nie wypisuje pełnego tokenu (tylko redacted). Użyj `--reveal-token`.
- Jeśli `sales_channel` dla marketu nie istnieje, narzędzie zwróci błąd (kanał musi być utworzony wcześniej, np. seed/reconcile środowiska).
- Źródło `DATABASE_URL`: `--db-url` albo env `DATABASE_URL`.

Szybki smoke-test bez zapisu do DB:

```bash
DATABASE_URL='postgres://postgres:postgres@localhost:5432/gp_mercur' \
  yarn -s gp-market-storefront-key --market-id bonbeauty --dry-run
```

Weryfikacja przypięcia klucza do kanału (lokalny docker-compose Postgres):

```bash
docker exec -i gp-postgres-1 psql -U postgres -d gp_mercur -c "\
SELECT sc.metadata->>'gp_market_id' AS market_id, ak.redacted\
FROM public.sales_channel sc\
JOIN public.publishable_api_key_sales_channel pasc\
  ON pasc.sales_channel_id = sc.id\
JOIN public.api_key ak\
  ON ak.id = pasc.publishable_key_id\
WHERE sc.deleted_at IS NULL\
  AND pasc.deleted_at IS NULL\
  AND ak.deleted_at IS NULL\
  AND ak.type = 'publishable'\
  AND sc.metadata->>'gp_market_id' = 'bonbeauty'\
ORDER BY ak.created_at DESC\
LIMIT 5\
";
```

## Narzędzie

### `medusa_request`

Wejście:

- `scope`: `admin` | `seller`
- `path`: ścieżka (np. `/admin/users/me` albo `/auth/seller/emailpass`)
- `method`: `GET|POST|PUT|PATCH|DELETE`
- `headers`: opcjonalne nagłówki
- `body`: opcjonalne body (obiekt będzie zakodowany jako JSON)

Odpowiedź zwraca JSON z podsumowaniem (url/status/content-type) + body (pretty JSON jeśli się da).
