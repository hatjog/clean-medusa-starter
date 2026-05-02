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
| **vendor** | `/vendor/*` | Mercur seller auth (`withVendorAuth`) | Native Mercur middleware | No | Native Mercur — no explicit GP middleware needed |
| **admin** | `/admin/*` | Medusa admin auth | Native Medusa middleware | No | Native Medusa — no explicit GP middleware needed |
| **operator** | `/api/v1/admin/*` | Medusa admin auth (`withOperatorAuth`) | `operatorAuthMiddleware` (Story 8.1) | No | GP operator API — `actor_type="user"` required; 401/403 fail-closed |

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

### Vendor Group
- Mercur native seller authentication (`withVendorAuth`)
- GP routes under `/vendor/*`: entitlement verify/redeem
- Spike-dependent: if Mercur seller auth works for gp_core → use native; otherwise custom auth (DD-25)
- No explicit middleware in GP `middlewares.ts` — handled by Mercur framework

### Admin Group (Medusa native)
- Medusa native admin authentication
- Admin panel routes: `/admin/*`
- No explicit middleware in GP `middlewares.ts` — handled by Medusa framework

### Operator Group (GP custom admin API)
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
