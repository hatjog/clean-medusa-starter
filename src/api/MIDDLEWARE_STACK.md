# Store Middleware Stack

Ten dokument jest SSOT dla kolejności middleware używanych przez storefront API w [middlewares.ts](middlewares.ts).

Powiązane pliki:
- runtime chain: [middlewares.ts](middlewares.ts)
- RLS hook: [../lib/rls-pool-hook.ts](../lib/rls-pool-hook.ts)
- cache sales channel -> market: [../loaders/market-context-cache.ts](../loaders/market-context-cache.ts)
- debug runbook: [../../../../specs/ops/rls-debugging-runbook.md](../../../../specs/ops/rls-debugging-runbook.md)
- unit tests: [../__tests__/api/market-context-middleware.unit.spec.ts](../__tests__/api/market-context-middleware.unit.spec.ts)
- customer isolation tests: [../__tests__/api/customer-market-guard.unit.spec.ts](../__tests__/api/customer-market-guard.unit.spec.ts)

## Global chain dla `/store/*`

Aktualna deklaracja w [middlewares.ts](middlewares.ts) ustawia dla wszystkich tras `/store/*` następującą kolejność:

| Kolejność | Middleware | Odpowiedzialność | Zachowanie fail-closed |
|---|---|---|---|
| 1 | `marketContextMiddleware` | Rozpoznaje `publishable key -> sales_channel_id -> market_id`, lazy-loaduje [MarketContextCache](../loaders/market-context-cache.ts) i instaluje [RLS pool hook](../lib/rls-pool-hook.ts). | Jeśli contextu nie da się ustalić, request przechodzi dalej bez ALS i zostaje zablokowany przez kolejny krok. |
| 2 | `marketGuardMiddleware` | Wymaga `market_id` w `AsyncLocalStorage` dla każdego requestu `/store/*`. | Brak market contextu kończy się `403 { message: "Market context required" }`. |
| 3 | `customerMarketGuardMiddleware` | Dla zalogowanego customera sprawdza zgodność `customer.metadata.gp.market_id` z aktywnym marketem requestu. Goście przechodzą dalej. | Cross-market access kończy się `403 { message: "Customer not found in this market" }`. |

## Route-specific overlays

Po globalnym chainie dokładane są middleware specyficzne dla wybranych ścieżek:

| Matcher | Dodatkowe middleware | Po co istnieją |
|---|---|---|
| `/store/customers` `POST` | `customerRegistrationMarketGuardMiddleware` -> `customerScopedCustomerCreateMiddleware` -> `customerResponseSanitizerMiddleware` | Pilnuje zgodności auth identity z marketem, scopinguje email/metadata przy tworzeniu customera i usuwa prefix email z odpowiedzi. |
| `/store/customers/me*` `ALL` | `customerResponseSanitizerMiddleware` | Usuwa `{market_id}::` z pól email przed wysłaniem payloadu do klienta. |
| `/store/orders*` `ALL` | `customerResponseSanitizerMiddleware` | Ten sam cel co wyżej dla odpowiedzi order/customer. |
| `/store/carts*` `ALL` | `cartMarketGuardMiddleware` -> `customerResponseSanitizerMiddleware` | Domyka read-path cartów po `sales_channel_id` i dalej sanitizuje payload customer-related. |

## Powiązane auth routes

Poniższe trasy nie są pod `/store/*`, ale należą do tego samego modelu izolacji customerów:

| Matcher | Middleware | Cel |
|---|---|---|
| `/auth/customer/emailpass/register` `POST` | `customerScopedAuthMiddleware` | Prefixuje email przed registration flow. |
| `/auth/customer/emailpass` `POST` | `customerScopedAuthMiddleware` | Prefixuje email/identifier przed login flow. |
| `/auth/customer/emailpass/reset-password` `POST` | `customerScopedAuthMiddleware` | Zachowuje scoping także dla password reset. |

## Debug logging ALS / RLS

Do operacyjnej diagnostyki można włączyć niski-szum logging:

```bash
GP_RLS_DEBUG=1 yarn dev
```

Po włączeniu backend loguje zdarzenia:
- `[rls-debug] market-context-resolved`
- `[rls-debug] market-context-missing`
- `[rls-debug] market-guard-blocked`

Runbook użycia tych logów znajduje się w [../../../../specs/ops/rls-debugging-runbook.md](../../../../specs/ops/rls-debugging-runbook.md).

## Notes utrzymaniowe

- Jeśli dokładasz nowy publiczny route `/store/*`, najpierw sprawdź, czy wystarczy globalny chain, czy potrzebny jest dodatkowy guard route-specific.
- Jeśli nowy route czyta encję izolowaną przez RLS, nie omijaj [marketContextMiddleware](middlewares.ts) i [installRlsPoolHook](../lib/rls-pool-hook.ts).
- Jeśli zmienisz kolejność deklaracji w [middlewares.ts](middlewares.ts), zaktualizuj ten dokument w tym samym PR.