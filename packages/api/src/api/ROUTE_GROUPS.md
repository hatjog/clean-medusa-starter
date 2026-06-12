# Route Groups — GP Backend API

Formal SSOT for API route group definitions. Each group has distinct auth requirements, middleware stack, and rate-limiting policy.

Related files:
- middleware implementation: [middlewares.ts](middlewares.ts)
- middleware stack docs: [MIDDLEWARE_STACK.md](MIDDLEWARE_STACK.md)
- architecture reference: `_bmad-output/planning-artifacts/archive-v1.2.0/architecture-v1.2.0.md` (DD-25, PP-7)

## Route Groups

| Group | Routes | Auth | Middleware | Rate Limit | Status |
|-------|--------|------|-----------|------------|--------|
| **public** | `/v1/health`, `/status`, `/api/v1/entitlements/claim` | None | (future: rate-limit) | Yes (future) | Existing endpoints, no auth required |
| **storefront** | `/store/*` | Publishable API key | `marketContextMiddleware` → `marketGuardMiddleware` → `customerMarketGuardMiddleware` + route-specific overlays | Yes (future) | Fully implemented — see [MIDDLEWARE_STACK.md](MIDDLEWARE_STACK.md) |
| **vendor (GP browser JWT)** | `/vendor/auth/sessions`, `/vendor/magic-links/:jti/revoke`, `/vendor/competitive-insights` | `authenticate("seller", ["bearer"])` + handler seller-context guard | Wired in `middlewares.ts` / Mercur seller context | No | Browser-initiated vendor routes; session list, JTI-scoped revoke, and seller-context competitive insights |
| **vendor (GP-S2S-HMAC)** | `/vendor/training-cert/upload`, `/vendor/vouchers/:code/lookup`, `/vendor/vouchers/:code/redeem` | `withVendorAuth` (HMAC `x-vendor-signature` only; cc-4 F-10 removed the legacy `x-vendor-token` path) | Inline HOF in route handler | No | GP-owned S2S surface — machine-to-machine only; cross-vendor lookups return 404 |
| **vendor (Mercur-native)** | other `/vendor/*` routes shipped by upstream Mercur | Mercur seller cookie/session | Native Mercur middleware | No | Untouched — upstream contract preserved |
| **admin (Medusa-native)** | `/admin/*` non-GP routes | Medusa admin auth | Native Medusa middleware | No | Native Medusa — no explicit GP middleware needed |
| **admin (GP-custom UI)** | `/admin/operator/*`, `/admin/vendors/*` (POST/PATCH/PUT/DELETE), `/admin/entitlements/*` (POST), `/admin/magic-links/*` (POST), `/admin/sellers/:id/pause` | `authenticate("user", ["session","bearer"])` + `operatorAuthMiddleware` | Wired in `middlewares.ts` | No | GP custom operator surface — `actor_type="user"` enforced; cc-4 F-01 wired `operator/*` matcher |
| **admin (v1 legacy)** | `/api/v1/admin/*` | Medusa admin auth (`withOperatorAuth`) | `operatorAuthMiddleware` (Story 8.1) | No | GP operator API legacy prefix — `actor_type="user"` required; 401/403 fail-closed |

## Auth Details

### Public Group
- No authentication required
- Rate limiting planned (Story 9-1, Epic 3+)
- Health endpoint: `GET /v1/health` → 200

### Storefront Group
- Publishable API key in `x-publishable-api-key` header
- Market context resolved from key → sales_channel → market_id
- RLS pool hook installed for data isolation
- Fail-closed: missing market context → 403
- Full middleware chain documented in [MIDDLEWARE_STACK.md](MIDDLEWARE_STACK.md)

### Vendor Group (GP browser JWT)
- `authenticate("seller", ["bearer"])` wired in `middlewares.ts` (same pattern as `/vendor/magic-links/:jti/revoke`).
- Seller identity read from `req.auth_context.actor_id` (actor_type must be "seller").
- GP routes:
  - `GET  /vendor/auth/sessions` (ra-15 — active seller magic-link sessions; browser-initiated, uses bearer JWT)
  - `POST /vendor/magic-links/:jti/revoke`
  - `GET  /vendor/competitive-insights` (seller-context JWT, cc-4)

### Vendor Group (GP S2S HMAC)
- `withVendorAuth` HOF (HMAC `x-vendor-signature` only — cc-4 F-10 removed `x-vendor-token` legacy path).
- Machine-to-machine only; no browser-originated callers.
- GP routes under `/vendor/*`:
  - `POST /vendor/training-cert/upload`
  - `GET  /vendor/vouchers/:code/lookup` (cc-4 F-05 — Story 8.4 cross-actor handoff)
  - `POST /vendor/vouchers/:code/redeem` (cc-4 F-05 — Story 8.4 cross-actor handoff)
- Cross-vendor lookups return 404 (do NOT leak existence) — vendor scope enforced by `voucher.seller_id === req.vendorAuth.seller_id` check.
- No explicit middleware in GP `middlewares.ts`; the HOF wraps the handler.
- Audit verdict (ra-15 review fix): S2S HMAC inventory corrected — sessions moved to browser-JWT group;
  `assertAuthTransport` enforces the remaining 3 S2S HMAC routes in CI.

### Vendor Group (Mercur-native)
- Untouched upstream Mercur seller cookie flow.
- All other `/vendor/*` routes that ship with `@mercurjs/core` follow Mercur's native middleware contract.

### Admin Group (Medusa native)
- Medusa native admin authentication.
- Non-GP `/admin/*` routes.

### Admin Group (GP custom UI)
- GP-owned admin routes consumed by `admin-panel`:
  - `/admin/operator/*` — cc-4 F-01: now wired with `authenticate("user", ["session","bearer"])` + `operatorAuthMiddleware` + `requestLogMetricsMiddleware`. All operator routes call `extractActorIdOrThrow` (which now also asserts `actor_type === "user"`, cc-4 F-02).
  - `/admin/vendors/*` (POST/PATCH/PUT/DELETE)
  - `/admin/entitlements/*` (POST)
  - `/admin/magic-links/*` (POST)
  - `/admin/sellers/:id/pause`
- All bind market context via `resolveAdminMarketContext` (`lib/admin-market-context.ts`, cc-4 F-03) — `x-gp-market-id` is verified server-side against `admin_market_grants` (super-admins bypass via `__super_admin__` capability).

### Operator Group (GP v1 legacy admin API)
- GP custom admin routes: `/api/v1/admin/*`
- Middleware: `operatorAuthMiddleware` from `src/middlewares/with-operator-auth.ts`
- Verifies `req.auth_context.actor_type === "user"` (Medusa admin user)
- Vendor/seller tokens return 403; missing auth returns 401
- Auth auto-discovery CI gate: `__tests__/api/auth-coverage.spec.ts`

## Notes

- Route groups are de facto implemented by framework (Medusa/Mercur). This document formalizes the architecture.
- Vendor auth middleware implementation depends on architecture spikes (Epic 3+).
- Rate limiting is out of scope for Sprint 0 — planned in Story 9-1.
- When adding new routes, determine group membership and apply appropriate auth/middleware.
