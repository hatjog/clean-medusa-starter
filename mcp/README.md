# MCP: Mercur backend (Medusa) — HTTP tools

Ten folder dodaje lokalny MCP server (Model Context Protocol), który udostępnia narzędzia do wykonywania requestów HTTP do backendu Medusa (Mercur) w 2 scope'ach:

- `admin` — tylko ścieżki `/admin/*` i `/auth/user/*`
- `seller` — tylko ścieżki `/vendor/*` i `/auth/seller/*`

Nie ma tu dostępu do DB/Redis/FS — wyłącznie HTTP do Medusy.

## Uruchomienie

Z katalogu [GP/backend](../):

```bash
yarn mcp
```

Domyślnie serwer odpytuje Medusę pod `http://localhost:9002`.
Możesz to zmienić zmienną środowiskową:

```bash
MCP_MEDUSA_BASE_URL=http://localhost:9002 yarn mcp
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
